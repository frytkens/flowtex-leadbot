// api/scrape-inwestycje.js
//
// Serverless Function (Vercel) — moduł 2: monitoring nowych inwestycji przemysłowych
// (hale produkcyjne, magazynowe, fabryki) jako wczesny sygnał przyszłego
// zapotrzebowania na wykonawcę posadzki — długo zanim inwestor ogłosi przetarg.
//
// Źródło: darmowe, publiczne kanały RSS portalu branżowego propertynews.pl
// (nieruchomości komercyjne/przemysłowe). Nie wymaga klucza/rejestracji.
//
// Co robi:
// 1. Pobiera kilka kanałów RSS (Magazyny, Inwestycje, Tereny inwestycyjne)
// 2. Filtruje wpisy po słowach kluczowych wskazujących na NOWĄ budowę
//    (odrzuca np. newsy o wynajmie istniejącej powierzchni, wyniki finansowe)
// 3. Odrzuca duplikaty (na podstawie linku artykułu — UNIQUE constraint w Supabase)
// 4. Zapisuje nowe leady do tej samej tabeli `leady` co moduł 1, z zrodlo='Inwestycje'
// 5. Wysyła jedno zbiorcze powiadomienie (e-mail + Telegram) na przebieg
//
// Wymagane zmienne środowiskowe — te same co w moduleu 1 (scrape-przetargi.js):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_TABLE_NAME (domyślnie "leady")
//   GMAIL_USER, GMAIL_APP_PASSWORD, NOTIFY_EMAIL_TO
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   CRON_SECRET
//
// Wymaga paczek "nodemailer" i "fast-xml-parser" w package.json.

import nodemailer from 'nodemailer';
import { XMLParser } from 'fast-xml-parser';

// Kanały RSS propertynews.pl najbardziej trafne dla sygnałów "nowa budowa
// hali/fabryki/zakładu". Pomijamy np. dział "Wykonawstwo i usługi", bo tam
// trafiają głównie newsy o samych firmach budowlanych, nie o inwestorach.
const RSS_FEEDS = [
  'https://www.propertynews.pl/rss/magazyny.xml',
  'https://www.propertynews.pl/rss/inwestycje.xml',
  'https://www.propertynews.pl/rss/tereny-inwestycyjne.xml',
];

// Słowa kluczowe wskazujące na NOWĄ inwestycję budowlaną (nie np. wynajem
// istniejącej powierzchni, wyniki finansowe, zmiany kadrowe).
const KEYWORDS_BUDOWA = [
  'buduje',
  'budowa',
  'wybuduje',
  'budowę',
  'powstaje',
  'powstanie',
  'powstał',
  'rozbudow',
  'nowa fabryk',
  'nowy zakład',
  'nowej hali',
  'nową halę',
  'inwestuje w',
  'ruszyła budowa',
  'ruszy budowa',
];

function zawieraSlowoKluczowe(text) {
  const lower = (text || '').toLowerCase();
  return KEYWORDS_BUDOWA.some((kw) => lower.includes(kw));
}

async function fetchRss(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
  });
  if (!res.ok) {
    throw new Error(`Błąd pobierania RSS (${url}): ${res.status}`);
  }
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: '__cdata',
  });
  const parsed = parser.parse(xml);

  const items = parsed?.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function extractText(field) {
  // fast-xml-parser z CDATA zwraca obiekt { __cdata: "..." } albo zwykły string
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object' && '__cdata' in field) return field.__cdata;
  return '';
}

async function fetchInwestycje() {
  // TRYB TESTOWY — spójny z modułem 1, do weryfikacji pipeline'u bez zależności
  // od tego, czy akurat są nowe artykuły w RSS.
  if (process.env.TEST_MODE === 'true') {
    return [
      {
        id: `test-inwestycja-${Date.now()}`,
        title: 'TEST: Firma buduje nową halę produkcyjną pod Szczecinem',
        url: 'https://example.com/testowa-inwestycja',
        date: new Date().toISOString().slice(0, 10),
        organization: null,
      },
    ];
  }

  const wszystkieWyniki = [];
  const widzianeLinki = new Set();

  for (const feedUrl of RSS_FEEDS) {
    let items;
    try {
      items = await fetchRss(feedUrl);
    } catch (err) {
      console.error(`Nie udało się pobrać kanału RSS ${feedUrl}: ${err.message}`);
      continue; // jeden zepsuty kanał nie przerywa całego przebiegu
    }

    for (const item of items) {
      const title = extractText(item.title);
      const description = extractText(item.description);
      const link = extractText(item.link) || item.link;

      if (!link || widzianeLinki.has(link)) continue;
      if (!zawieraSlowoKluczowe(title) && !zawieraSlowoKluczowe(description)) continue;

      widzianeLinki.add(link);

      let dataPublikacji = null;
      const pubDate = extractText(item.pubDate) || item.pubDate;
      if (pubDate) {
        const parsedDate = new Date(pubDate);
        if (!isNaN(parsedDate.getTime())) {
          dataPublikacji = parsedDate.toISOString().slice(0, 10);
        }
      }

      wszystkieWyniki.push({
        id: link, // link artykułu jako unikalny identyfikator (external_id)
        title: title || '(brak tytułu)',
        url: link,
        date: dataPublikacji,
        organization: null, // RSS nie podaje nazwy inwestora w ustrukturyzowanej formie
      });
    }
  }

  console.log(
    `Moduł 2 (inwestycje): sprawdzono ${RSS_FEEDS.length} kanałów RSS, znaleziono ${wszystkieWyniki.length} pasujących wpisów.`
  );

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
      zrodlo: 'Inwestycje',
      firma: lead.organization || null,
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
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return cachedTransporter;
}

async function notifyEmailBatch(leady) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.NOTIFY_EMAIL_TO) {
    return;
  }
  if (leady.length === 0) return;

  const transporter = getTransporter();

  const listaHtml = leady
    .map(
      (lead) => `
        <li style="margin-bottom: 12px;">
          <strong>${lead.title}</strong><br/>
          Data: ${lead.date || 'brak danych'}<br/>
          <a href="${lead.url}">${lead.url}</a>
        </li>`
    )
    .join('');

  try {
    await transporter.sendMail({
      from: `"Leady Flowtex" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL_TO,
      subject:
        leady.length === 1
          ? `🏗️ Nowa inwestycja: ${leady[0].title}`
          : `🏗️ ${leady.length} nowych inwestycji przemysłowych`,
      html: `
        <p><strong>Nowe newsy o inwestycjach przemysłowych (${leady.length}) — potencjalne przyszłe zapotrzebowanie na posadzkę:</strong></p>
        <ul>${listaHtml}</ul>
      `,
    });
  } catch (err) {
    console.error(`Błąd wysyłki e-mail (Nodemailer/Gmail): ${err.message}`);
  }
}

async function notifyTelegramBatch(leady) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  if (leady.length === 0) return;

  const naglowek =
    leady.length === 1 ? `🏗️ *Nowa inwestycja*` : `🏗️ *${leady.length} nowych inwestycji przemysłowych*`;

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const MAX_DLUGOSC = 3500;
  const wiadomosci = [];
  let biezaca = naglowek;
  for (const lead of leady) {
    const fragment = `\n\n${lead.title}\n${lead.date || ''}\n${lead.url}`;
    if ((biezaca + fragment).length > MAX_DLUGOSC) {
      wiadomosci.push(biezaca);
      biezaca = fragment;
    } else {
      biezaca += fragment;
    }
  }
  wiadomosci.push(biezaca);

  for (const wiadomosc of wiadomosci) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: wiadomosc,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Błąd wysyłki Telegram: ${res.status} ${body}`);
    }
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const inwestycje = await fetchInwestycje();

    const nowe = [];
    for (const lead of inwestycje) {
      const juzZapisane = await isAlreadySaved(lead.id);
      if (!juzZapisane) {
        await saveToSupabase(lead);
        nowe.push(lead);
      }
    }

    await notifyEmailBatch(nowe);
    await notifyTelegramBatch(nowe);

    return res.status(200).json({
      sprawdzone: inwestycje.length,
      nowe: nowe.length,
      nowLeady: nowe.map((l) => ({ tytul: l.title, link: l.url })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
