// lib/notify.js
//
// Wspólne funkcje powiadomień (e-mail przez Nodemailer/Gmail + Telegram),
// używane zarówno przez moduł 1 (api/scrape-przetargi.js, Vercel Function)
// jak i moduł 2 (scripts/scrape-inwestycje.js, skrypt Node w GitHub Actions).
//
// Oczekiwany kształt obiektu "lead" (pola opcjonalne oznaczone ?):
//   title        - tytuł/nazwa zamierzenia
//   organization - nazwa organizacji/inwestora
//   date         - data (string, opcjonalna)
//   url?         - link do ogłoszenia/sprawy (opcjonalny — moduł 2 często go nie ma)
//   noticeNumber?- numer ogłoszenia/wniosku (opcjonalny)
//   extra?       - dodatkowa linia tekstu (np. adres inwestycji), opcjonalna

import nodemailer from 'nodemailer';

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

export async function notifyEmailBatch(leady, { subjectPrefix = '🎯', subjectLabel = 'nowych leadów' } = {}) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.NOTIFY_EMAIL_TO) return;
  if (leady.length === 0) return;

  const transporter = getTransporter();

  const listaHtml = leady
    .map(
      (lead) => `
        <li style="margin-bottom: 12px;">
          <strong>${lead.title}</strong><br/>
          Organizacja/Inwestor: ${lead.organization || 'brak danych'}<br/>
          Data: ${lead.date || 'brak danych'}<br/>
          ${lead.noticeNumber ? `Nr: ${lead.noticeNumber}<br/>` : ''}
          ${lead.extra ? `${lead.extra}<br/>` : ''}
          ${lead.url ? `<a href="${lead.url}">${lead.url}</a>` : ''}
        </li>`
    )
    .join('');

  try {
    await transporter.sendMail({
      from: `"Leady Flowtex" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL_TO,
      subject:
        leady.length === 1
          ? `${subjectPrefix} Nowy lead: ${leady[0].title}`
          : `${subjectPrefix} ${leady.length} ${subjectLabel}`,
      html: `
        <p><strong>Nowe pozycje pasujące do kryteriów wyszukiwania (${leady.length}):</strong></p>
        <ul>${listaHtml}</ul>
      `,
    });
  } catch (err) {
    console.error(`Błąd wysyłki e-mail (Nodemailer/Gmail): ${err.message}`);
  }
}

export async function notifyTelegramBatch(leady, { header = null } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  if (leady.length === 0) return;

  const naglowek = header || (leady.length === 1 ? `🎯 *Nowy lead*` : `🎯 *${leady.length} nowych leadów*`);

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const MAX_DLUGOSC = 3500;
  const wiadomosci = [];
  let biezaca = naglowek;
  for (const lead of leady) {
    const fragment = `\n\n${lead.title}\nOrganizacja/Inwestor: ${lead.organization || 'brak danych'}${
      lead.noticeNumber ? `\nNr: ${lead.noticeNumber}` : ''
    }${lead.extra ? `\n${lead.extra}` : ''}${lead.url ? `\n${lead.url}` : ''}`;
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
