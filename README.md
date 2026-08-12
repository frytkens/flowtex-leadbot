# Leadbot — moduł 1 (przetargi/zapytania ofertowe)

## Co tu jest
- `api/scrape-przetargi.js` — Vercel Serverless Function. Pobiera ogłoszenia, filtruje
  po słowach kluczowych ("posadzka żywiczna" itd.), zapisuje nowe leady do Supabase
  i wysyła powiadomienie **e-mailem (Nodemailer + Gmail) oraz na Telegram**.
- `.github/workflows/scrape-leady.yml` — GitHub Actions, darmowy harmonogram co 30 min,
  wywołuje endpoint na Vercelu (omija limit "1x/dzień" z planu Hobby Vercela).
- `vercel.json` — opcjonalny natywny cron Vercela (przydatny dopiero na planie Pro;
  na Hobby zignoruje `0 * * * *` i tak odpali max raz dziennie, więc na start
  polegaj na GitHub Actions).

## Krok po kroku

### 1. Supabase (baza, tam gdzie już pracujesz)
1. W SQL Editorze swojego projektu Supabase odpal `supabase-schema.sql` — stworzy
   tabelę `leady` z unikalnym `external_id` (chroni przed duplikatami).
2. W Project Settings -> API znajdziesz:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` — **klucz service_role, nie anon/public!**
     Ten klucz omija RLS, więc musi zostać wyłącznie w zmiennych środowiskowych
     na Vercelu, nigdy w kodzie frontendowym/klienckim.
3. Jeśli chcesz inną nazwę tabeli niż `leady`, ustaw `SUPABASE_TABLE_NAME`.

### 2. E-mail (Nodemailer + Gmail, darmowy, bez SPF/DNS)
1. Włącz **weryfikację dwuetapową (2FA)** na koncie Gmail/Google Workspace, którego
   chcesz użyć do wysyłki (np. `leady@flowtex.pl`, jeśli macie Google Workspace) —
   bez 2FA nie da się wygenerować hasła aplikacji.
2. Wygeneruj **hasło aplikacji**: myaccount.google.com -> Bezpieczeństwo ->
   Hasła aplikacji -> wybierz "Poczta" -> skopiuj wygenerowane 16-znakowe hasło.
   To NIE jest zwykłe hasło do konta.
3. Ustaw `GMAIL_USER` (pełny adres, np. `leady@flowtex.pl`) i `GMAIL_APP_PASSWORD`
   (hasło aplikacji z kroku 2).
4. Ustaw `NOTIFY_EMAIL_TO` (adres/adresy, na które mają spływać powiadomienia,
   np. `biuro@flowtex.pl`).

Zaleta tego podejścia: żadnej weryfikacji domeny, żadnego SPF/DKIM do ruszania —
wysyłasz przez istniejącą, zaufaną infrastrukturę Google. Limit to ok. 500 maili/dzień
(standardowy limit Gmaila), więc praktycznie bez ograniczeń dla monitoringu przetargów.

### 3. Telegram Bot (całkowicie darmowy, bez limitu)
1. W Telegramie znajdź **@BotFather**, wyślij `/newbot`, nadaj nazwę -> dostaniesz token
   -> `TELEGRAM_BOT_TOKEN`.
2. Napisz cokolwiek do swojego nowego bota (żeby "otworzyć" rozmowę), albo dodaj go
   do grupy, gdzie mają spływać leady.
3. Pobierz `chat_id`: wejdź na
   `https://api.telegram.org/bot<TWÓJ_TOKEN>/getUpdates` w przeglądarce po wysłaniu
   wiadomości do bota — w odpowiedzi JSON znajdziesz `"chat":{"id": ...}` -> to jest
   `TELEGRAM_CHAT_ID`.

### 4. Zmienne środowiskowe w Vercelu
Project Settings -> Environment Variables, dodaj:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_TABLE_NAME` (opcjonalnie, domyślnie `leady`)
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`
- `NOTIFY_EMAIL_TO`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `CRON_SECRET` (dowolny losowy string, np. wygenerowany `openssl rand -hex 16`)

### 5. Sekrety w GitHub Actions
W repo: Settings -> Secrets and variables -> Actions, dodaj:
- `SCRAPE_ENDPOINT_URL` -> np. `https://twoja-domena.vercel.app/api/scrape-przetargi`
- `CRON_SECRET` -> ta sama wartość co w Vercelu

### 6. Podmień źródło danych
W `fetchOgloszenia()` w `api/scrape-przetargi.js` jest placeholder URL do e-Zamówienia —
**trzeba go zweryfikować i dopasować do realnej struktury API/HTML** tego czy innego
portalu (Oferteo, Fixly itp.). To jedyna część wymagająca ręcznej pracy przy starcie,
bo każdy portal ma inny format danych.

### 7. Test
- Zainstaluj zależności lokalnie: `npm install` (paczka `nodemailer` jest w `package.json`).
- Push do repo -> deploy na Vercelu (Vercel automatycznie zainstaluje zależności
  z `package.json` przy buildzie).
- W zakładce GitHub Actions -> wybierz workflow -> "Run workflow" (ręczne odpalenie).
- Sprawdź czy w tabeli `leady` w Supabase pojawił się rekord, czy przyszedł mail
  i czy przyszła wiadomość na Telegramie.

## Koszt
Wszystko w darmowych tierach: Vercel Hobby, GitHub Actions (2000 min/mies za darmo),
Supabase Free (500 MB bazy), Gmail (własne konto, limit ~500 maili/dzień),
Telegram Bot (bez limitu). **0 zł/miesiąc.**

## Moduł 2 — nowe inwestycje (GUNB / RWDZ)

Źródło: publiczny, darmowy rejestr wniosków o pozwolenie na budowę (GUNB),
osobny plik CSV per województwo (cała historia od 2016, separator `#`,
aktualizacja co noc). Szczegóły działania — patrz komentarz na górze
`scripts/scrape-inwestycje.js`.

**Zasięg geograficzny:** domyślnie tylko mazowieckie + województwa z nim
graniczące (łódzkie, kujawsko-pomorskie, warmińsko-mazurskie, podlaskie,
lubelskie, świętokrzyskie) — 7 z 16 województw, ustawione w stałej
`WOJEWODZTWA` w `scripts/scrape-inwestycje.js`. Pełną listę 16 województw
(cała Polska) masz zakomentowaną tuż pod nią — wystarczy odkomentować i
zamienić. Można też nadpisać zasięg bez zmiany kodu, przez sekret/zmienną
`GUNB_WOJEWODZTWA` w workflow (lista nazw oddzielona przecinkami, np.
`mazowieckie,lodzkie`).

**Ważna różnica względem modułu 1:** to NIE jest Vercel Function. Pliki GUNB są
za duże (do ~45 MB ZIP/województwo, cała historia), więc skrypt uruchamia się
bezpośrednio jako proces Node w GitHub Actions
(`.github/workflows/scrape-inwestycje.yml`), które ma dużo więcej czasu niż
limit 10s Vercel Hobby. Żeby nie przetwarzać całej historii od nowa za każdym
razem i nie odpytywać Supabase o każdy z setek tysięcy wierszy, trzymamy
lokalny "diff" — plik `data/gunb-seen-ids.json` z ID już zobaczonych,
dopasowanych wniosków. Workflow commituje ten plik z powrotem do repo po
każdym przebiegu.

### Krok po kroku

1. **Sekrety w GitHub Actions** (Settings -> Secrets and variables -> Actions)
   — to są te same wartości co w Vercelu, tylko trzeba je dodać drugi raz
   (Actions nie widzi zmiennych środowiskowych Vercela):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_TABLE_NAME` (opcjonalnie)
   - `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `NOTIFY_EMAIL_TO`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

2. **Uprawnienia workflow do push'a.** W repo: Settings -> Actions -> General ->
   "Workflow permissions" -> ustaw **"Read and write permissions"**. Bez tego
   commit pliku stanu z powrotem do repo się nie uda.

3. **WERYFIKACJA KOLUMN — zrób to jako pierwsze, zanim cokolwiek innego.**
   Nie miałem dostępu do realnego pliku GUNB przy pisaniu tego kodu (domena
   `gunb.gov.pl` jest poza whitelistą mojego środowiska), więc parser sam
   wykrywa kolumny CSV po fragmentach nazw nagłówków — to powinno działać, ale
   **trzeba to potwierdzić ręcznie**:
   - Zakładka Actions -> "Scrape leady - inwestycje (GUNB)" -> "Run workflow" ->
     zaznacz `debug_headers` -> Run workflow.
   - W logu zobaczysz dla każdego województwa wykryte kolumny (`Wykryte kolumny: {...}`)
     oraz 3 przykładowe wiersze. Sprawdź czy `id`, `rodzajZamierzenia`,
     `nazwaZamierzenia`, `inwestor` faktycznie wskazują na sensowne dane
     (nie `-1` i nie pomieszane kolumny).
   - Jeśli coś jest źle wykryte, daj znać dokładnie co widzisz w logu, dopasuję
     `HEADER_ALIASES` w `scripts/scrape-inwestycje.js`.

4. **Pierwsze prawdziwe uruchomienie (tryb seed).** Odpal workflow bez
   `debug_headers` (albo poczekaj na najbliższy cron o 4:30 UTC). Ten przebieg
   NIE wyśle żadnych powiadomień — tylko zbuduje bazę ID już istniejących
   dopasowań w `data/gunb-seen-ids.json` i zacommituje ją do repo. To
   celowe: inaczej dostałbyś naraz maila z tysiącami wyników z ostatnich 10 lat.

5. **Od drugiego przebiegu** zaczną przychodzić prawdziwe leady — tylko nowe
   wnioski, które pojawiły się w rejestrze od ostatniego uruchomienia.

6. **Dostrojenie słów kluczowych.** Lista `KEYWORDS_INWESTYCJE` w
   `scripts/scrape-inwestycje.js` to punkt startowy (hale produkcyjne/magazynowe/
   przemysłowe, centra logistyczne, chłodnie itd.) — po pierwszych wynikach
   pewnie zechcesz coś dodać/usunąć.

## Następne kroki
- Moduł 4 (chatbot na stronie) — osobny endpoint real-time (nie cron), podłączony
  do tego samego Supabase/Gmail/Telegrama. Skoro Twoja strona Flowtex już jest na
  React/Vite + Vercel, to naturalnie dokłada się jako kolejny `/api/...` endpoint
  w tym samym projekcie.

