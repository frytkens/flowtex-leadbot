// scripts/scrape-inwestycje.js
//
// Moduł 2 — monitoring nowych inwestycji (wnioski o pozwolenie na budowę hal
// produkcyjnych/magazynowych/przemysłowych), źródło: RWDZ GUNB.
//
// WAŻNE: to jest zwykły skrypt Node uruchamiany przez GitHub Actions,
// NIE Vercel Function. Pliki źródłowe (ZIP per województwo) mają do ~45 MB
// skompresowane i zawierają całą historię wniosków od 2016 roku — nie da się
// tego przetworzyć w limicie 10s Vercel Hobby. GitHub Actions ma dużo więcej
// czasu i może też commitować z powrotem plik stanu do repo.
//
// Jak działa "diff":
// GUNB nie oferuje API "pokaż mi tylko nowe wpisy od X" — trzeba pobrać cały
// plik każdego województwa i samemu wyłuskać co jest nowe. Zamiast odpytywać
// Supabase o każdy z (potencjalnie) setek tysięcy wierszy, filtrujemy NAJPIERW
// lokalnie po rodzaju zamierzenia budowlanego (interesują nas tylko
// hale/magazyny/zakłady produkcyjne), a dopasowane ID porównujemy z plikiem
// stanu zapisanym w repo (data/gunb-seen-ids.json). Do Supabase i powiadomień
// trafiają tylko te ID, których nie ma jeszcze w pliku stanu.
//
// Plik stanu jest po przebiegu aktualizowany i zapisywany na dysku —
// zacommitowanie go z powrotem do repo robi krok w
// .github/workflows/scrape-inwestycje.yml (git commit + push), nie ten skrypt.
//
// TRYB SEED: jeśli dla danego województwa plik stanu jeszcze nie istnieje
// (pierwsze uruchomienie), wszystkie dopasowane ID zostają zapisane do stanu,
// ale NIE trafiają do Supabase/powiadomień — inaczej pierwszy przebieg
// zasypałby Cię tysiącami historycznych wyników z ostatnich ~10 lat. Realne
// leady zaczną spływać od drugiego przebiegu (czyli od pierwszej faktycznej
// zmiany w rejestrze).
//
// Wymagane zmienne środowiskowe (GitHub Actions -> Settings -> Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_TABLE_NAME (opcjonalnie)
//   GMAIL_USER, GMAIL_APP_PASSWORD, NOTIFY_EMAIL_TO
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// Opcjonalne zmienne:
//   GUNB_WOJEWODZTWA - lista województw oddzielona przecinkami, nadpisuje
//                       domyślną listę w stałej WOJEWODZTWA (obecnie:
//                       mazowieckie + graniczące, 7 województw)
//   GUNB_DEBUG_HEADERS=true - loguje wykryte nagłówki kolumn i pierwsze 3 wiersze
//                              każdego województwa, NIC nie zapisuje/wysyła.
//                              Użyj tego przy pierwszym uruchomieniu (workflow_dispatch),
//                              żeby ręcznie zweryfikować, że parser dobrze rozpoznał kolumny.

import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAlreadySaved, saveLead } from '../lib/supabase.js';
import { notifyEmailBatch, notifyTelegramBatch } from '../lib/notify.js';

const STATE_PATH = path.join(process.cwd(), 'data', 'gunb-seen-ids.json');

// Nazwy plików ZIP na serwerze GUNB — wzorzec potwierdzony (m.in. wynik_opolskie.zip,
// wynik_mazowieckie.zip, wynik_kujawsko-pomorskie.zip w indeksie rwdz.xml).
// Pełna lista 16 województw zakomentowana niżej — zamiast całej Polski
// zawężone na razie do mazowieckiego + województw z nim graniczących (można
// łatwo zmienić przez zmienną środowiskową GUNB_WOJEWODZTWA, patrz README).
const WOJEWODZTWA = [
  'mazowieckie',
  'lodzkie',
  'kujawsko-pomorskie',
  'warminsko-mazurskie',
  'podlaskie',
  'lubelskie',
  'swietokrzyskie',
];

// const WOJEWODZTWA = [
//   'dolnoslaskie',
//   'kujawsko-pomorskie',
//   'lubelskie',
//   'lubuskie',
//   'lodzkie',
//   'malopolskie',
//   'mazowieckie',
//   'opolskie',
//   'podkarpackie',
//   'podlaskie',
//   'pomorskie',
//   'slaskie',
//   'swietokrzyskie',
//   'warminsko-mazurskie',
//   'wielkopolskie',
//   'zachodniopomorskie',
// ];

function gunbZipUrl(woj) {
  return `https://wyszukiwarka.gunb.gov.pl/pliki_pobranie/wynik_${woj}.zip`;
}

// Frazy szukane w "rodzaju zamierzenia budowlanego" / "nazwie zamierzenia" —
// potencjalny klient na posadzkę żywiczną/przemysłową. DOSTROJ pod realne dane
// po pierwszym przebiegu z GUNB_DEBUG_HEADERS=true.
const KEYWORDS_INWESTYCJE = [
  'hala produkcyjn',
  'hala magazynow',
  'hala przemysłow',
  'hala widowiskowo', // czasem hale wielofunkcyjne też mają posadzki przemysłowe — do oceny, łatwo usunąć
  'zakład produkcyjn',
  'centrum logistyczn',
  'budynek produkcyjn',
  'budynek magazynow',
  'magazynowo-produkcyjn',
  'produkcyjno-magazynow',
  'chłodnia',
  'centrum dystrybucyjn',
];

// --- Wykrywanie kolumn po fragmentach nazw (odporne na wielkość liter/ogonki) ---

const HEADER_ALIASES = {
  id: ['nrewid', 'numerewid', 'identyfikator'],
  wojewodztwo: ['wojewodztwo'],
  dataWplywu: ['datawplywu', 'datazlozenia'],
  rodzajZamierzenia: ['rodzajzamierzenia'],
  nazwaZamierzenia: ['nazwazamierzenia'],
  organ: ['nazwaorganu'],
  inwestor: ['inwestor'],
  miejscowosc: ['miejscowosc'],
  ulica: ['ulica'],
  kategoria: ['kategoria'],
};

function normalizeHeader(h) {
  return (h || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function detectColumns(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    map[field] = normalized.findIndex((h) => aliases.some((a) => h.includes(a)));
  }
  return map;
}

async function fetchAndParseCsv(woj) {
  const res = await fetch(gunbZipUrl(woj));
  if (!res.ok) {
    throw new Error(`Nie udało się pobrać pliku dla woj. ${woj}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => e.entryName.toLowerCase().endsWith('.csv'));
  if (entries.length === 0) {
    throw new Error(`Brak pliku CSV w ZIP dla woj. ${woj}`);
  }
  const csvText = zip.readAsText(entries[0], 'utf8');

  const rows = parse(csvText, {
    delimiter: '#',
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
  });

  if (rows.length === 0) return { columns: {}, rows: [] };

  const headerRow = rows[0];
  const columns = detectColumns(headerRow);
  return { columns, rows: rows.slice(1) };
}

function rowMatchesKeywords(row, columns) {
  const parts = [];
  if (columns.rodzajZamierzenia >= 0) parts.push(row[columns.rodzajZamierzenia]);
  if (columns.nazwaZamierzenia >= 0) parts.push(row[columns.nazwaZamierzenia]);
  const text = parts.join(' ').toLowerCase();
  return KEYWORDS_INWESTYCJE.some((kw) => text.includes(kw));
}

function rowToLead(row, columns, woj) {
  const get = (field) => (columns[field] >= 0 ? row[columns[field]] : null);

  const id = get('id') || `${woj}:${row.join('|').slice(0, 120)}`; // fallback, nie powinno się zdarzyć
  const nazwa = get('nazwaZamierzenia') || get('rodzajZamierzenia') || '(brak nazwy zamierzenia)';
  const miejscowosc = get('miejscowosc');
  const ulica = get('ulica');
  const adres = [ulica, miejscowosc].filter(Boolean).join(', ');

  return {
    externalId: `gunb:${id}`,
    title: nazwa,
    organization: get('inwestor'),
    date: get('dataWplywu'),
    extra: adres ? `Adres: ${adres}, woj. ${woj}` : `Woj. ${woj}`,
    url: null, // GUNB nie daje bezpośredniego linku bez captchy
    noticeNumber: null,
  };
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
  const debugHeaders = process.env.GUNB_DEBUG_HEADERS === 'true';
  const wojFilter = process.env.GUNB_WOJEWODZTWA
    ? process.env.GUNB_WOJEWODZTWA.split(',').map((w) => w.trim())
    : WOJEWODZTWA;

  const state = await loadState();
  const nowe = [];
  const podsumowanie = {};

  for (const woj of wojFilter) {
    console.log(`--- Województwo: ${woj} ---`);
    let parsed;
    try {
      parsed = await fetchAndParseCsv(woj);
    } catch (err) {
      console.error(`Błąd przetwarzania woj. ${woj}: ${err.message}`);
      continue;
    }

    if (debugHeaders) {
      console.log('Wykryte kolumny:', JSON.stringify(parsed.columns));
      console.log('Przykładowe wiersze:', JSON.stringify(parsed.rows.slice(0, 3)));
      continue; // tryb debug: nic nie zapisujemy/wysyłamy
    }

    const isSeedRun = !state[woj];
    const seenIds = new Set(state[woj] || []);
    const matched = parsed.rows.filter((row) => rowMatchesKeywords(row, parsed.columns));

    let dodanychDoStanu = 0;
    let nowychLeadow = 0;

    for (const row of matched) {
      const lead = rowToLead(row, parsed.columns, woj);
      if (seenIds.has(lead.externalId)) continue;

      seenIds.add(lead.externalId);
      dodanychDoStanu++;

      if (isSeedRun) continue; // tryb seed: tylko budujemy bazę, bez powiadomień

      const jużZapisany = await isAlreadySaved(lead.externalId);
      if (jużZapisany) continue;

      await saveLead({
        source: 'Inwestycje',
        company: lead.organization,
        title: lead.title,
        url: lead.url,
        date: lead.date,
        externalId: lead.externalId,
      });
      nowe.push(lead);
      nowychLeadow++;
    }

    state[woj] = Array.from(seenIds);
    podsumowanie[woj] = {
      sprawdzone: parsed.rows.length,
      dopasowane: matched.length,
      nowychWStanie: dodanychDoStanu,
      nowychLeadow,
      trybSeed: isSeedRun,
    };
  }

  console.log('Podsumowanie:', JSON.stringify(podsumowanie, null, 2));

  if (debugHeaders) {
    console.log('GUNB_DEBUG_HEADERS=true — zakończono bez zapisu stanu i bez powiadomień.');
    return;
  }

  await saveState(state);

  await notifyEmailBatch(nowe, { subjectLabel: 'nowych inwestycji (GUNB)' });
  await notifyTelegramBatch(nowe, {
    header: nowe.length === 1 ? '🏗️ *Nowa inwestycja (GUNB)*' : `🏗️ *${nowe.length} nowych inwestycji (GUNB)*`,
  });

  console.log(`Zakończono. Nowych leadów: ${nowe.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
