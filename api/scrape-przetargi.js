// api/scrape-przetargi.js
//
// Serverless Function (Vercel) — moduł 1: monitoring przetargów / zapytań ofertowych.
// Odpalany cyklicznie (przez GitHub Actions -> GET na ten endpoint).
//
// Co robi:
// 1. Pobiera ogłoszenia z publicznego, bezpłatnego API BZP Platformy e-Zamówienia
//    (https://ezamowienia.gov.pl/mo-board/api/v1/notice), osobno dla każdego słowa
//    kluczowego (parametr OrderObject), z okna ostatnich 24h.
// 2. Dodatkowo filtruje wynik lokalnie (bezpiecznik) po słowach kluczowych związanych
//    z posadzkami żywicznymi.
// 3. Odrzuca duplikaty (na podstawie ExternalId zapisanego w bazie — UNIQUE constraint w Supabase)
// 4. Zapisuje nowe leady do Supabase i wysyła powiadomienie (e-mail + Telegram)
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

function formatDateForApi(date) {
  // API wymaga formatu YYYY-MM-DDThh:mm:ss BEZ strefy czasowej/Z na końcu.
  return date.toISOString().slice(0, 19);
}

async function fetchOgloszeniaDlaSlowa(keyword, dateFrom, dateTo) {
  const params = new URLSearchParams({
    NoticeType: 'ContractNotice', // ogłoszenie o zamówieniu — główny typ nas interesujący
    OrderObject: keyword,          // wyszukiwanie po nazwie zamówienia (fraza)
    PublicationDateFrom: formatDateForApi(dateFrom),
    PublicationDateTo: formatDateForApi(dateTo),
    PageSize: '100',
  });

  const url = `https://ezamowienia.gov.pl/mo-board/api/v1/notice?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Błąd API e-Zamówienia (${keyword}): ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  // API zwraca płaską tablicę obiektów NoticeDto (patrz bzp.external.API.yaml)
  return Array.isArray(data) ? data : [];
}

async function fetchOgloszenia() {
  // TRYB TESTOWY — zwraca sztuczne dane, żeby sprawdzić czy cały pipeline
  // (Supabase, e-mail, Telegram, deduplikacja) działa poprawnie, niezależnie
  // od tego, czy realne API akurat coś zwraca.
  if (process.env.TEST_MODE === 'true') {
    return [
      {
        id: `test-${Date.now()}`,
        title: 'TEST: Wykonanie posadzki żywicznej w hali produkcyjnej',
        url: 'https://example.com/testowe-ogloszenie',
        date: new Date().toISOString().slice(0, 10),
        organization: 'Firma Testowa Sp. z o.o.',
      },
    ];
  }

  // Realne źródło: publiczne, bezpłatne API BZP Platformy e-Zamówienia.
  // Dokumentacja: "Instrukcja integracji z API BZP Platformy e-Zamówienia".
  // Endpoint zwraca ogłoszenia pasujące do OrderObject (fraza w nazwie zamówienia),
  // więc odpytujemy osobno dla każdego słowa kluczowego i łączymy wyniki.
  //
  // Okno czasowe jest celowo szersze niż częstotliwość harmonogramu (domyślnie
  // 7 dni, harmonogram co 30 min) — to bezpieczne i zamierzone: deduplikacja
  // po external_id (patrz isAlreadySaved) gwarantuje, że ogłoszenie już zapisane
  // nie trafi drugi raz do bazy ani nie wygeneruje powtórnego powiadomienia.
  // Szersze okno chroni przed "przegapieniem" ogłoszenia, gdyby jakiś przebieg
  // harmonogramu się nie powiódł (np. chwilowa niedostępność API).
  const SEARCH_WINDOW_DAYS = Number(process.env.SEARCH_WINDOW_DAYS || 7);
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const wszystkieWyniki = [];
  const widzianeObjectId = new Set();
  const statystykiPerSlowo = {};

  for (const keyword of KEYWORDS) {
    const wyniki = await fetchOgloszeniaDlaSlowa(keyword, dateFrom, dateTo);
    statystykiPerSlowo[keyword] = wyniki.length;

    for (const item of wyniki) {
      // Deduplikacja w ramach jednego przebiegu — to samo ogłoszenie może
      // pasować do kilku słów kluczowych naraz.
      if (widzianeObjectId.has(item.objectId)) continue;
      widzianeObjectId.add(item.objectId);

      wszystkieWyniki.push({
        id: item.objectId,
        title: item.orderObject || '(brak nazwy zamówienia)',
        // API nie zwraca gotowego linku do ogłoszenia — budujemy link do
        // wyszukiwarki BZP po numerze ogłoszenia, co pozwala łatwo je odnaleźć.
        url: item.noticeNumber
          ? `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/${item.noticeNumber}`
          : `https://ezamowienia.gov.pl/mo-client-board/bzp/list`,
        date: item.publicationDate ? item.publicationDate.slice(0, 10) : null,
        organization: item.organizationName,
      });
    }
  }

  console.log(`Wyniki per słowo kluczowe (okno ${SEARCH_WINDOW_DAYS} dni):`, statystykiPerSlowo);

  return wszystkieWyniki;
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
      nowLeady: nowe.map((l) => ({ tytul: l.title, organizacja: l.organization, link: l.url })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
