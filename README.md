# Leadbot — moduł 1 (przetargi/zapytania ofertowe)

## Co tu jest
- `api/scrape-przetargi.js` — Vercel Serverless Function. Pobiera ogłoszenia, filtruje
  po słowach kluczowych ("posadzka żywiczna" itd.), zapisuje nowe leady do Supabase
  i wysyła powiadomienie **e-mailem (Nodemailer + Gmail) oraz na Telegram**.
- `.github/workflows/scrape-leady.yml` — GitHub Actions, darmowy harmonogram co 4h,
  wywołuje endpoint na Vercelu (omija limit "1x/dzień" z planu Hobby Vercela).
- `vercel.json` — pusty (celowo, bez sekcji `crons`). Plan Hobby na Vercelu
  odrzuca deploy, jeśli cron w `vercel.json` jest częstszy niż raz dziennie —
  a nam zależy na częstszym odpytywaniu (co 4h), więc cały harmonogram
  realizuje GitHub Actions, nie natywny cron Vercela. Jeśli kiedyś przejdziesz
  na plan Pro, możesz dopisać tu `crons` z dowolną częstotliwością.

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

### 6. Źródło danych: API BZP Platformy e-Zamówienia
Kod korzysta z realnego, publicznego i bezpłatnego API BZP:
`https://ezamowienia.gov.pl/mo-board/api/v1/notice` (nie wymaga klucza/rejestracji
dla odczytu ogłoszeń). Funkcja szuka **dwiema strategiami naraz**:

- **A) słowa kluczowe w nazwie zamówienia** (`KEYWORDS`, parametr `OrderObject`) —
  precyzyjne, ale rzadkie: tytuły ogłoszeń rzadko dosłownie zawierają frazy typu
  "posadzka żywiczna".
- **B) kody CPV robót posadzkarskich** (`CPV_CODES`, parametr `CpvCode`) — znacznie
  pewniejszy sygnał, bo łapie ogłoszenie po oficjalnej klasyfikacji zamówienia,
  niezależnie jak brzmi tytuł. Domyślne kody: `45262321-7` (wyrównywanie podłóg /
  masy samopoziomujące), `45432111-5` (wykładziny obiektowe), `45431100-8`
  (okładziny posadzkowe).

Obie strategie odpytywane są dla dwóch typów ogłoszeń (`NOTICE_TYPES`):
`ContractNotice` (pełna procedura) i `SmallContractNotice` (zamówienia poniżej
progu ustawowego, częste przy mniejszych realizacjach). Wyniki są łączone
i odduplikowane po `objectId`, z okna **ostatnich 7 dni** (domyślnie).

**Dlaczego okno jest szersze niż harmonogram (7 dni vs co 4h):** to celowe
i bezpieczne. Deduplikacja po `external_id` (patrz `isAlreadySaved` w kodzie) i tak
gwarantuje, że ogłoszenie już zapisane w Supabase nie wygeneruje powtórnego wpisu
ani powiadomienia — nawet jeśli codziennie pobierasz te same ogłoszenia z całego
tygodnia, do bazy/powiadomień trafiają tylko naprawdę nowe pozycje. Szersze okno
dodatkowo chroni przed "przegapieniem" ogłoszenia, gdyby jakiś przebieg harmonogramu
się nie powiódł (np. chwilowa niedostępność API).

Chcesz zmienić okno? Ustaw zmienną środowiskową `SEARCH_WINDOW_DAYS` w Vercelu
(np. `14` dla dwóch tygodni) — bez zmian w kodzie. Chcesz dodać kolejne kody CPV
albo słowa kluczowe? Edytuj listy `CPV_CODES`/`KEYWORDS` na początku pliku.

Link w powiadomieniach prowadzi do wyszukiwarki BZP po numerze ogłoszenia — API nie
zwraca gotowego linku bezpośredniego do strony ogłoszenia.

**Podgląd wyników per zapytanie:** każdy przebieg loguje w konsoli Vercela
(Deployments -> Functions -> logi) szczegółowe statystyki — ile ogłoszeń znalazło
każde słowo kluczowe i każdy kod CPV z osobna, dla każdego typu ogłoszenia —
przydatne do oceny, które kryterium faktycznie coś łapie. Odpowiedź endpointu
zawiera też listę nowo dodanych leadów (`nowLeady`), widoczną w logach GitHub Actions
po każdym ręcznym lub automatycznym uruchomieniu.

### 7. Test modułu 1
- Zainstaluj zależności lokalnie: `npm install` (paczki `nodemailer` i `fast-xml-parser`
  są w `package.json`).
- Push do repo -> deploy na Vercelu (Vercel automatycznie zainstaluje zależności
  z `package.json` przy buildzie).
- W zakładce GitHub Actions -> wybierz workflow "Scrape leady - przetargi" ->
  "Run workflow" (ręczne odpalenie).
- Sprawdź czy w tabeli `leady` w Supabase pojawił się rekord, czy przyszedł mail
  i czy przyszła wiadomość na Telegramie.

## Moduł 2: nowe inwestycje przemysłowe (RSS)

- `api/scrape-inwestycje.js` — Vercel Serverless Function. Monitoruje newsy
  o nowych inwestycjach (hale produkcyjne, magazynowe, fabryki) jako wczesny
  sygnał przyszłego zapotrzebowania na wykonawcę posadzki — długo zanim inwestor
  ogłosi przetarg.
- `.github/workflows/scrape-inwestycje.yml` — osobny harmonogram GitHub Actions,
  co 4h (przesunięty 15 min względem modułu 1, żeby oba nie odpalały się
  jednocześnie).

**Źródło danych:** trzy darmowe, publiczne kanały RSS portalu branżowego
propertynews.pl (Magazyny, Inwestycje, Tereny inwestycyjne) — bez klucza/rejestracji.
Wpisy filtrowane są lokalnie po słowach kluczowych wskazujących na **nową budowę**
(np. "buduje", "powstaje", "rozbudowa"), żeby odrzucić newsy niezwiązane
z budową (np. wynajem istniejącej powierzchni, wyniki finansowe).

**Uwaga — jakość leadów:** to sygnał pośredni i wcześniejszy niż w module 1.
RSS nie podaje nazwy inwestora w ustrukturyzowanej formie (pole `firma` zostaje
puste) — trzeba ją odczytać z treści newsa pod linkiem. Zaletą jest wyprzedzenie:
często to pierwszy publiczny sygnał o inwestycji, zanim jeszcze powstanie
jakikolwiek przetarg na wykonawcę.

Dane zapisywane są do tej samej tabeli `leady` w Supabase co moduł 1,
z `zrodlo = 'Inwestycje'` — więc oba moduły współdzielą bazę, deduplikację
(po linku artykułu jako `external_id`) i powiadomienia mailowe/Telegram
(osobne, zbiorcze na przebieg, tak jak w module 1).

Chcesz dodać więcej kanałów RSS albo zmienić słowa kluczowe? Edytuj listy
`RSS_FEEDS` / `KEYWORDS_BUDOWA` na początku pliku `api/scrape-inwestycje.js`.

### Konfiguracja modułu 2
Używa dokładnie tych samych zmiennych środowiskowych w Vercelu co moduł 1
(Supabase, Gmail, Telegram, `CRON_SECRET`) — nic dodatkowego nie trzeba ustawiać
tam. Jedyna nowa rzecz to sekret w GitHub Actions:
- `SCRAPE_INWESTYCJE_ENDPOINT_URL` -> np. `https://twoja-domena.vercel.app/api/scrape-inwestycje`
  (analogicznie do `SCRAPE_ENDPOINT_URL` z modułu 1, ale wskazujący na nowy endpoint)

### Test modułu 2
Identycznie jak w module 1: GitHub Actions -> workflow "Scrape leady - inwestycje"
-> "Run workflow" -> sprawdź Supabase/mail/Telegram.

## Koszt
Wszystko w darmowych tierach: Vercel Hobby, GitHub Actions (2000 min/mies za darmo,
oba moduły razem to wciąż niewielki ułamek limitu), Supabase Free (500 MB bazy),
Gmail (własne konto, limit ~500 maili/dzień), Telegram Bot (bez limitu),
propertynews.pl RSS (publiczne, bez limitu). **0 zł/miesiąc.**

## Następne kroki
- Moduł 4 (chatbot na stronie) — osobny endpoint real-time (nie cron), podłączony
  do tego samego Supabase/Gmail/Telegrama. Skoro Twoja strona Flowtex już jest na
  React/Vite + Vercel, to naturalnie dokłada się jako kolejny `/api/...` endpoint
  w tym samym projekcie.

