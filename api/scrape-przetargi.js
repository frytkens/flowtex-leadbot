// api/scrape-przetargi.js
//
// Serverless Function (Vercel) — moduł 1: monitoring przetargów / zapytań ofertowych.
// Odpalany cyklicznie (przez GitHub Actions -> GET na ten endpoint).
//
// Co robi:
// 1. Pobiera ogłoszenia z publicznego, bezpłatnego API BZP Platformy e-Zamówienia
//    (https://ezamowienia.gov.pl/mo-board/api/v1/notice), dwiema strategiami:
//    a) po słowach kluczowych w nazwie zamówienia (OrderObject)
//    b) po kodach CPV robót posadzkarskich (CpvCode) — szerszy, pewniejszy zasięg
//    Odpytuje dla dwóch typów ogłoszeń (ContractNotice, SmallContractNotice)
//    i łączy wyniki z okna ostatnich N dni (domyślnie 7).
// 2. Odrzuca duplikaty (na podstawie ExternalId zapisanego w bazie — UNIQUE constraint w Supabase)
// 3. Zapisuje nowe leady do Supabase i wysyła powiadomienie (e-mail + Telegram)
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

// Frazy w nazwie zamówienia — trafienia 1:1, ale rzadkie (tytuły ogłoszeń
// rzadko dosłownie zawierają te sformułowania).
const KEYWORDS = [
  'posadzka żywiczna',
  'posadzki żywiczne',
  'posadzka epoksydowa',
  'posadzka przemysłowa',
  'wylewka epoksydowa',
  'posadzka poliuretanowa',
];

// Kody CPV (Wspólny Słownik Zamówień) dla robót posadzkarskich/podłogowych —
// znacznie pewniejszy sygnał niż dopasowanie tekstu, bo łapie ogłoszenie po
// oficjalnej klasyfikacji zamówienia, niezależnie jak brzmi jego tytuł.
const CPV_CODES = [
  '45262321-7', // Wyrównywanie podłóg / masy samopoziomujące (typowe dla posadzek żywicznych)
  '45432111-5', // Wykładziny obiektowe / posadzki przemysłowe
  '45431100-8', // Okładziny posadzkowe
];

// Rodzaje ogłoszeń, które nas interesują jako "aktywne, otwarte na oferty":
// ContractNotice — standardowe ogłoszenie o zamówieniu (pełna procedura PZP)
// SmallContractNotice — zamówienie poniżej progu ustawowego (częste przy
//   mniejszych realizacjach, np. posadzki w pojedynczym budynku)
const NOTICE_TYPES = ['ContractNotice', 'SmallContractNotice'];

function formatDateForApi(date) {
  // API wymaga formatu YYYY-MM-DDThh:mm:ss BEZ strefy czasowej/Z na końcu.
  return date.toISOString().slice(0, 19);
}

async function fetchZApi(extraParams, dateFrom, dateTo, noticeType) {
  const params = new URLSearchParams({
    NoticeType: noticeType,
    PublicationDateFrom: formatDateForApi(dateFrom),
    PublicationDateTo: formatDateForApi(dateTo),
    PageSize: '100',
    ...extraParams,
  });

  const url = `https://ezamowienia.gov.pl/mo-board/api/v1/notice?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Błąd API e-Zamówienia (${JSON.stringify(extraParams)}): ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  // API zwraca płaską tablicę obiektów NoticeDto (patrz bzp.external.API.yaml)
  return Array.isArray(data) ? data : [];
}

function mapNotice(item) {
  return {
    id: item.objectId,
    title: item.orderObject || '(brak nazwy zamówienia)',
    // API nie zwraca gotowego linku do ogłoszenia — budujemy link do
    // wyszukiwarki BZP po numerze ogłoszenia, co pozwala łatwo je odnaleźć.
    url: item.noticeNumber
      ? `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/${item.noticeNumber}`
      : `https://ezamowienia.gov.pl/mo-client-board/bzp/list`,
    date: item.publicationDate ? item.publicationDate.slice(0, 10) : null,
    organization: item.organizationName,
  };
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
  // Dwie strategie wyszukiwania łączone razem:
  //  A) po słowach kluczowych w nazwie zamówienia (OrderObject) — precyzyjne,
  //     ale rzadkie trafienia, bo tytuły rzadko dosłownie zawierają te frazy.
  //  B) po kodach CPV (klasyfikacja robót posadzkarskich) — szerszy, bardziej
  //     niezawodny zasięg, łapie ogłoszenie niezależnie od brzmienia tytułu.
  // Wyniki z obu strategii są łączone i odduplikowane po objectId.
  const SEARCH_WINDOW_DAYS = Number(process.env.SEARCH_WINDOW_DAYS || 7);
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const wszystkieWyniki = [];
  const widzianeObjectId = new Set();
  const statystyki = { poSlowieKluczowym: {}, poCpv: {} };

  function dodajWyniki(rawItems) {
    let dodanych = 0;
    for (const item of rawItems) {
      if (widzianeObjectId.has(item.objectId)) continue;
      widzianeObjectId.add(item.objectId);
      wszystkieWyniki.push(mapNotice(item));
      dodanych++;
    }
    return dodanych;
  }

  for (const noticeType of NOTICE_TYPES) {
    // Strategia A: dopasowanie po nazwie zamówienia
    for (const keyword of KEYWORDS) {
      const wyniki = await fetchZApi({ OrderObject: keyword }, dateFrom, dateTo, noticeType);
      statystyki.poSlowieKluczowym[`${noticeType}:${keyword}`] = wyniki.length;
      dodajWyniki(wyniki);
    }

    // Strategia B: dopasowanie po kodzie CPV
    for (const cpv of CPV_CODES) {
      const wyniki = await fetchZApi({ CpvCode: cpv }, dateFrom, dateTo, noticeType);
      statystyki.poCpv[`${noticeType}:${cpv}`] = wyniki.length;
      dodajWyniki(wyniki);
    }
  }

  console.log(`Statystyki wyszukiwania (okno ${SEARCH_WINDOW_DAYS} dni):`, JSON.stringify(statystyki));

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
    // Uwaga: fetchOgloszenia() zwraca już tylko trafne wyniki (dopasowane przez
    // słowo kluczowe w tytule LUB przez kod CPV), więc nie stosujemy tu
    // dodatkowego filtra po tytule — odrzuciłby to poprawnie trafione ogłoszenia
    // znalezione przez CPV, których tytuł nie zawiera dosłownie żadnej frazy.
    const nowe = [];
    for (const lead of ogloszenia) {
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
      nowe: nowe.length,
      nowLeady: nowe.map((l) => ({ tytul: l.title, organizacja: l.organization, link: l.url })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
