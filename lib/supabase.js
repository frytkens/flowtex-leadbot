// lib/supabase.js
//
// Wspólne funkcje zapisu/odczytu Supabase, używane przez moduł 1 i moduł 2.

const SUPABASE_TABLE = process.env.SUPABASE_TABLE_NAME || 'leady';

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function isAlreadySaved(externalId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?external_id=eq.${encodeURIComponent(
    externalId
  )}&select=id`;

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

// lead: { source, company, title, url, date, externalId }
export async function saveLead(lead) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      zrodlo: lead.source,
      firma: lead.company || 'brak danych',
      tytul: lead.title,
      link: lead.url || null,
      data_ogloszenia: lead.date || null,
      external_id: lead.externalId,
      status: 'Nowy',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Błąd zapisu do Supabase: ${res.status} ${body}`);
  }
}
