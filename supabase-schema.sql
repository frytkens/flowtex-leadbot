-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query
--
-- UWAGA: poniższy DROP TABLE nieodwracalnie kasuje tabelę "leady" wraz z jej
-- danymi (jeśli istnieje). Używaj świadomie — dobre przy pierwszej konfiguracji
-- albo gdy chcesz zacząć od czystej bazy; NIE odpalaj tego, jeśli masz już
-- zapisane leady, które chcesz zachować.

drop table if exists leady cascade;

create table leady (
  id bigint generated always as identity primary key,
  zrodlo text not null,                -- np. "Przetargi", "Inwestycje", "Chatbot"
  firma text,
  tytul text not null,
  link text,
  data_ogloszenia date,
  external_id text not null,           -- unikalny identyfikator z systemu źródłowego
  status text not null default 'Nowy', -- Nowy / Kontakt nawiązany / Oferta wysłana / Zamknięty
  created_at timestamptz not null default now(),

  constraint leady_external_id_unique unique (external_id)
);

-- indeks przyspieszający sprawdzanie duplikatów (isAlreadySaved w kodzie)
create index leady_external_id_idx on leady (external_id);

-- RLS: włączone, ale bez policy dla anon/authenticated —
-- pisze tylko service_role z Vercela, co i tak omija RLS.
alter table leady enable row level security;
