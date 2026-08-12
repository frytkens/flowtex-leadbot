// api/scrape-przetargi.js
//
// Serverless Function (Vercel) — moduł 1: monitoring przetargów / zapytań ofertowych.
// Odpalany cyklicznie (przez GitHub Actions -> GET na ten endpoint).
//
// Co robi:
// 1. Pobiera listę ogłoszeń ze źródła (tu: przykładowy fetch do API/HTML źródła — DO PODMIANY na realne)
// 2. Filtruje po słowach kluczowych związanych z posadzkami żywicznymi
// 3. Odrzuca duplikaty (na podstawie ExternalId zapisanego w bazie — UNIQUE constraint w Supabase)
// 4. Zapisuje nowe leady do Supabase i wysyła powiadomienie (Slack webhook)
//
// Wymagane zmienne środowiskowe (ustawiane w Vercel -> Project -> Settings -> Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_TABLE_NAME (domyślnie "leady")
//   GMAIL_USER, GMAIL_APP_PASSWORD, NOTIFY_EMAIL_TO
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   CRON_SECRET  (prosty token, żeby nikt obcy nie odpalał Twojego endpointu)
//
// Wymaga paczki "nodemailer" w package.json (npm install nodemailer).
//
// Uwaga: użyj klucza SERVICE_ROLE (nie anon/public) — funkcja pisze po stronie serwera,
// więc RLS jej nie ograniczy, ale klucz service_role NIGDY nie może trafić do
// kodu frontendowego/klienckiego, tylko do zmiennych środowiskowych na Vercelu.

import nodemailer from 'nodemailer';

const KEYWORDS = [
  'posadzka żywiczna',
  'posadzki żywiczne',
  'posadzka epoksydowa',
  'posadzka przemysłowa',
  'wylewka epoksydowa',
  'posadzka poliuretanowa',
];

function containsKeyword(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw));
}

async function fetchOgloszenia() {
  // TODO: podmień na realne źródło.
  // Przykład: publiczne API e-Zamówienia albo endpoint z Oferteo/Fixly (jeśli dostępny).
  // Poniżej placeholder pokazujący oczekiwany kształt danych.
  const res = await fetch('https://ezamowienia.gov.pl/mo-client-board/api/v1/notices?query=posadzka');
  if (!res.ok) {
    throw new Error(`Błąd pobierania ogłoszeń: ${res.status}`);
  }
  const data = await res.json();

  // Zakładamy, że API zwraca tablicę obiektów { id, title, url, publishDate, organization }
  // Dostosuj mapowanie do realnej struktury odpowiedzi.
  return (data.items || []).map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    date: item.publishDate,
    organization: item.organization,
  }));
}

const SUPABASE_TABLE = process.env.SUPABASE_TABLE_NAME || 'leady';

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function isAlreadySaved(id) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?external_id=eq.${encodeURIComponent(
    id
  )}&select=id`;

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function saveToSupabase(lead) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      zrodlo: 'Przetargi',
      firma: lead.organization || 'brak danych',
      tytul: lead.title,
      link: lead.url,
      data_ogloszenia: lead.date || null,
      external_id: lead.id,
      status: 'Nowy',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Błąd zapisu do Supabase: ${res.status} ${body}`);
  }
}

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,           // np. "leady@flowtex.pl" (jeśli Google Workspace) lub zwykły Gmail
      pass: process.env.GMAIL_APP_PASSWORD,   // hasło aplikacji, NIE zwykłe hasło do konta
    },
  });
  return cachedTransporter;
}

async function notifyEmail(lead) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.NOTIFY_EMAIL_TO) {
    return;
  }

  const transporter = getTransporter();

  try {
    await transporter.sendMail({
      from: `"Leady Flowtex" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL_TO, // można podać kilka adresów oddzielonych przecinkiem
      subject: `🎯 Nowy lead (przetarg): ${lead.title}`,
      html: `
        <p><strong>Nowe zapytanie/przetarg pasujące do słów kluczowych:</strong></p>
        <ul>
          <li><strong>Tytuł:</strong> ${lead.title}</li>
          <li><strong>Organizacja:</strong> ${lead.organization || 'brak danych'}</li>
          <li><strong>Data:</strong> ${lead.date || 'brak danych'}</li>
          <li><strong>Link:</strong> <a href="${lead.url}">${lead.url}</a></li>
        </ul>
      `,
    });
  } catch (err) {
    console.error(`Błąd wysyłki e-mail (Nodemailer/Gmail): ${err.message}`);
  }
}

async function notifyTelegram(lead) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  const text =
    `🎯 *Nowy lead (przetarg)*\n` +
    `${lead.title}\n` +
    `Organizacja: ${lead.organization || 'brak danych'}\n` +
    `${lead.url}`;

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Błąd wysyłki Telegram: ${res.status} ${body}`);
  }
}

export default async function handler(req, res) {
  // Prosta ochrona endpointu — tylko odpytania z ważnym sekretem przechodzą.
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const ogloszenia = await fetchOgloszenia();
    const trafienia = ogloszenia.filter((o) => containsKeyword(o.title));

    const nowe = [];
    for (const lead of trafienia) {
      const juzZapisane = await isAlreadySaved(lead.id);
      if (!juzZapisane) {
        await saveToSupabase(lead);
        await notifyEmail(lead);
        await notifyTelegram(lead);
        nowe.push(lead);
      }
    }

    return res.status(200).json({
      sprawdzone: ogloszenia.length,
      dopasowane: trafienia.length,
      nowe: nowe.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
