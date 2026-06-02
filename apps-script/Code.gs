/**
 * Manarah — Khateeb booking automation
 * Google Apps Script Web App backend
 *
 * What it does, fully automatically:
 *  1. Receives a booking from the website form (doPost)
 *  2. Emails the requester  → "we received your request"
 *  3. Emails the khateeb    → full details + a one-click CONFIRM link
 *  4. Logs the booking to a Google Sheet (auto-created on first run)
 *  5. When the khateeb clicks CONFIRM (doGet):
 *       • creates a Google Calendar event
 *       • sends calendar invites to the requester AND the org email
 *       • emails the requester + org a confirmation
 *
 * Everything sends FROM the Gmail account that owns/deploys this script.
 *
 * ───────────────────────────────────────────────────────────────────
 * SETUP (one time): see SETUP.md. In short:
 *   1. script.google.com → New project → paste this file
 *   2. Edit the CONFIG block below (emails + secret)
 *   3. Deploy → New deployment → Web app
 *        - Execute as:   Me
 *        - Who has access: Anyone
 *   4. Copy the /exec URL, paste it into BOOKING_ENDPOINT in each
 *      khateeb HTML page.
 * ───────────────────────────────────────────────────────────────────
 */

// ============================ CONFIG ============================

// The organization inbox. Gets a copy of every CONFIRMED booking
// (email + calendar invite).
const ORG_EMAIL = 'salam@manarah.org';

// One entry per khateeb. The "key" must match KHATEEB_KEY in the HTML page.
// Put each khateeb's real email here.
const KHATEEBS = {
  zayaan: { name: 'Br. Zayaan Backus',  email: 'zayaan@example.com' },
  yusuf:  { name: 'Br. Yusuf Rahman',   email: 'yusuf@example.com'  },
  idris:  { name: 'Br. Idris Mohammed', email: 'idris@example.com'  },
};

// Calendar to add events to. 'primary' = the deploying account's main
// calendar. Or paste a specific calendar ID.
const CALENDAR_ID = 'primary';

// How long the khutbah event blocks on the calendar (minutes).
const EVENT_DURATION_MIN = 60;

// Used only if a booking somehow arrives without a time.
const DEFAULT_TIME = '13:15';

// Signs the confirm links so random people can't confirm bookings.
// CHANGE THIS to any long random string and never share it.
const SECRET = 'CHANGE-ME-to-a-long-random-secret-string-9f3a1c';

const SHEET_NAME = 'Bookings';

// ============================ ENTRY POINTS ============================

function doPost(e) {
  try {
    // Accept JSON body (the website) OR form-encoded params (fallback).
    var data;
    if (e && e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); }
      catch (_) { data = e.parameter || {}; }
    } else {
      data = (e && e.parameter) || {};
    }
    return handleBooking(data);
  } catch (err) {
    // Logged to the Apps Script "Executions" tab so failures are visible.
    console.error('doPost failed: ' + err);
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const action = ((e && e.parameter && e.parameter.action) || '').toLowerCase();
  if (action === 'confirm') return handleConfirm(e.parameter);
  if (action === 'test')    return handleSelfTest();
  return htmlPage('Manarah', 'Booking service is running. ✓<br><br>'
    + '<a href="?action=test" style="color:#5d537a;">Run a self-test &rarr;</a>');
}

// ============================ SELF-TEST (open in a browser) ============================
// Visit  <your /exec URL>?action=test  while signed into the owning Google account.
// It checks email + calendar permissions and sends a real test email to ORG_EMAIL.
function handleSelfTest() {
  var lines = [];
  var owner = '';
  try { owner = Session.getEffectiveUser().getEmail(); } catch (e) {}
  lines.push('Running as: <b>' + esc(owner || 'unknown') + '</b>');

  // 1. Email permission + send
  try {
    var quota = MailApp.getRemainingDailyQuota();
    MailApp.sendEmail({
      to: ORG_EMAIL,
      subject: 'Manarah self-test ✓',
      htmlBody: emailShell('<p>This is a self-test from your booking backend. '
        + 'If you can read this, <b>email sending works.</b></p>')
    });
    lines.push('✅ Email OK — test message sent to ORG_EMAIL: <b>' + esc(ORG_EMAIL)
      + '</b> (remaining daily quota: ' + quota + ')');
  } catch (err) {
    lines.push('❌ EMAIL FAILED: ' + esc(String(err))
      + '<br><span style="color:#8a8398">Usually means authorization wasn’t granted. '
      + 'Run <b>runTest</b> once from the editor and click Allow.</span>');
  }

  // 2. Calendar permission
  try {
    var cal = (CALENDAR_ID === 'primary')
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CALENDAR_ID);
    lines.push('✅ Calendar OK — using: <b>' + esc(cal.getName()) + '</b>');
  } catch (err) {
    lines.push('❌ CALENDAR FAILED: ' + esc(String(err)));
  }

  // 3. Placeholder-email check
  var ph = Object.keys(KHATEEBS).filter(function (k) {
    return /example\.com/.test(KHATEEBS[k].email);
  });
  if (ph.length) {
    lines.push('⚠️ These khateebs still have placeholder emails (their '
      + 'notifications go nowhere): <b>' + ph.join(', ') + '</b>. '
      + 'Edit the KHATEEBS block and redeploy a NEW version.');
  } else {
    lines.push('✅ All khateeb emails are set.');
  }

  // 4. Secret check
  if (/CHANGE-ME/.test(SECRET)) {
    lines.push('⚠️ SECRET is still the default — change it to a random string.');
  }

  return htmlPage('Self-test results', lines.join('<br><br>'));
}

// ============================ BOOKING (on submit) ============================

function handleBooking(d) {
  const ref      = String(d.ref || newRef());
  const khateeb  = KHATEEBS[d.khateebKey] || { name: d.khateebName || 'the khateeb', email: ORG_EMAIL };
  const time     = d.time || DEFAULT_TIME;
  const token    = makeToken(ref);

  // 1. Log to sheet (status: Pending)
  const sheet = getSheet();
  sheet.appendRow([
    new Date(), ref, 'Pending', khateeb.name,
    d.school || '', d.contact || '', d.email || '', d.phone || '',
    d.date || '', time, d.attendance || '', d.location || '',
    d.topic || '', d.notes || '', '', token
  ]);

  const prettyDate = formatDate(d.date, time);

  // 2. Confirmation to the requester
  if (d.email) {
    MailApp.sendEmail({
      to: d.email,
      subject: `We received your khutbah request — ${ref}`,
      htmlBody: emailShell(`
        <p>As-salāmu ʿalaykum ${esc(d.contact || '')},</p>
        <p>JazākAllāhu khayran for your request to book <strong>${esc(khateeb.name)}</strong>
        for a Jumu'ah khutbah. We've received the details below and ${esc(khateeb.name)}
        will respond shortly, in shā' Allāh.</p>
        ${detailsTable(d, prettyDate, khateeb.name)}
        <p style="margin-top:22px;">Your reference number is
        <strong style="color:#5d537a;">${ref}</strong>. You'll receive a calendar
        invitation once the booking is confirmed.</p>
        <p style="color:#8a8398;">— Manarah</p>
      `)
    });
  }

  // 3. Notification to the khateeb, with a one-click confirm link
  const confirmUrl = webAppUrl() + '?action=confirm&id=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(token);
  MailApp.sendEmail({
    to: khateeb.email,
    subject: `New khutbah request — ${esc(d.school || 'MSA')} (${ref})`,
    htmlBody: emailShell(`
      <p>As-salāmu ʿalaykum ${esc(khateeb.name)},</p>
      <p>You have a new Jumu'ah khutbah request:</p>
      ${detailsTable(d, prettyDate, khateeb.name)}
      <p style="margin:26px 0;">
        <a href="${confirmUrl}"
           style="background:#5d537a;color:#fff;text-decoration:none;
                  padding:13px 26px;border-radius:8px;font-weight:600;
                  display:inline-block;">
           Confirm this booking &rarr;
        </a>
      </p>
      <p style="color:#8a8398;font-size:13px;">Confirming will create the calendar
      event and send an invitation with the date &amp; time to you,
      ${esc(d.contact || 'the requester')}, and the organization inbox — automatically.</p>
    `)
  });

  return jsonOut({ ok: true, ref: ref });
}

// ============================ CONFIRM (khateeb clicks link) ============================

function handleConfirm(p) {
  const ref = String(p.id || '');
  const token = String(p.t || '');

  if (!ref || token !== makeToken(ref)) {
    return htmlPage('Invalid link', 'This confirmation link is not valid.');
  }

  const sheet = getSheet();
  const row = findRow(sheet, ref);
  if (!row) return htmlPage('Not found', `No booking found for ${esc(ref)}.`);

  const v = row.values;
  if (v[2] === 'Confirmed') {
    return htmlPage('Already confirmed', `Booking <b>${esc(ref)}</b> was already confirmed.`);
  }

  const khateebName = v[3], school = v[4], contact = v[5],
        reqEmail = v[6], dateStr = v[8], time = v[9],
        location = v[11], topic = v[12];

  // Create the calendar event + send invites to requester and org
  const cal = (CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const start = parseDateTime(dateStr, time);
  const end = new Date(start.getTime() + EVENT_DURATION_MIN * 60000);

  // Everyone goes on the invite: the requester, the khateeb, and the org inbox.
  // Each receives a Google Calendar invitation email with the date & time.
  const khateebEmail = khateebEmailByName(khateebName);
  const guests = [reqEmail, khateebEmail, ORG_EMAIL].filter(Boolean).join(',');
  const event = cal.createEvent(
    `Jumu'ah Khutbah — ${school} (${khateebName})`,
    start, end,
    {
      description: `Khateeb: ${khateebName}\nContact: ${contact}\nTopic: ${topic || 'TBD'}\nRef: ${ref}`,
      location: location,
      guests: guests,
      sendInvites: true
    }
  );

  // Update sheet → Confirmed + event id
  sheet.getRange(row.index, 3).setValue('Confirmed');
  sheet.getRange(row.index, 15).setValue(event.getId());

  const prettyDate = formatDate(dateStr, time);

  // Confirmation email to requester
  if (reqEmail) {
    MailApp.sendEmail({
      to: reqEmail,
      subject: `Confirmed: ${khateebName} for your Jumu'ah — ${ref}`,
      htmlBody: emailShell(`
        <p>As-salāmu ʿalaykum ${esc(contact)},</p>
        <p><strong>${esc(khateebName)}</strong> has confirmed your booking, al-ḥamdu lillāh.
        A calendar invitation has been sent to this email address.</p>
        <table style="margin:18px 0;font-size:15px;">
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">When</td><td>${esc(prettyDate)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Where</td><td>${esc(location)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Khateeb</td><td>${esc(khateebName)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Reference</td><td>${esc(ref)}</td></tr>
        </table>
        <p style="color:#8a8398;">— Manarah</p>
      `)
    });
  }

  // Confirmation email to the khateeb (he confirmed — send his copy + invite)
  if (khateebEmail) {
    MailApp.sendEmail({
      to: khateebEmail,
      subject: `You're confirmed: Jumu'ah at ${school} — ${ref}`,
      htmlBody: emailShell(`
        <p>As-salāmu ʿalaykum ${esc(khateebName)},</p>
        <p>JazākAllāhu khayran — you've confirmed this khutbah. A calendar
        invitation has been sent to you, the organizer, and the organization inbox.</p>
        <table style="margin:18px 0;font-size:15px;">
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">When</td><td>${esc(prettyDate)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Where</td><td>${esc(location)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">School / MSA</td><td>${esc(school)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Organizer</td><td>${esc(contact)} · ${esc(reqEmail)}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Topic</td><td>${esc(topic || 'Khateeb’s choice')}</td></tr>
          <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Reference</td><td>${esc(ref)}</td></tr>
        </table>
        <p style="color:#8a8398;">— Manarah</p>
      `)
    });
  }

  // Confirmation email to the org inbox
  MailApp.sendEmail({
    to: ORG_EMAIL,
    subject: `Booking confirmed — ${school} / ${khateebName} (${ref})`,
    htmlBody: emailShell(`
      <p>A booking has been confirmed and added to the calendar.</p>
      <table style="margin:18px 0;font-size:15px;">
        <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Khateeb</td><td>${esc(khateebName)}</td></tr>
        <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">School / MSA</td><td>${esc(school)}</td></tr>
        <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">When</td><td>${esc(prettyDate)}</td></tr>
        <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Where</td><td>${esc(location)}</td></tr>
        <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Contact</td><td>${esc(contact)} · ${esc(reqEmail)}</td></tr>
        <tr><td style="color:#8a8398;padding:4px 16px 4px 0;">Reference</td><td>${esc(ref)}</td></tr>
      </table>
    `)
  });

  return htmlPage('Booking confirmed ✓',
    `<b>${esc(ref)}</b> is confirmed. Calendar invites with the date & time have
     been sent to ${esc(contact)}, ${esc(khateebName)}, and the organization inbox.`);
}

// ============================ HELPERS ============================

function getSheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { id = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Manarah Bookings');
    props.setProperty('SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Timestamp','Ref','Status','Khateeb','School','Contact','Email',
      'Phone','Date','Time','Attendance','Location','Topic','Notes','EventId','Token']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function khateebEmailByName(name) {
  for (var k in KHATEEBS) {
    if (KHATEEBS[k].name === name) return KHATEEBS[k].email;
  }
  return '';
}

function findRow(sheet, ref) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === ref) return { index: i + 1, values: data[i] };
  }
  return null;
}

function parseDateTime(dateStr, time) {
  // Sheet may return a Date object instead of a string — normalise it first.
  if (dateStr instanceof Date) {
    dateStr = Utilities.formatDate(dateStr, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const d = (String(dateStr || '')).split('-').map(Number);
  const t = (String(time || DEFAULT_TIME)).split(':').map(Number);
  if (d.length < 3 || isNaN(d[0])) {
    const fallback = new Date(); fallback.setHours(t[0] || 13, t[1] || 15, 0, 0);
    return fallback;
  }
  return new Date(d[0], d[1] - 1, d[2], t[0] || 13, t[1] || 15, 0, 0);
}

function formatDate(dateStr, time) {
  try {
    const dt = parseDateTime(dateStr, time);
    const tz = Session.getScriptTimeZone();
    return Utilities.formatDate(dt, tz, "EEEE, MMMM d, yyyy 'at' h:mm a");
  } catch (e) { return (dateStr || '') + ' ' + (time || ''); }
}

function detailsTable(d, prettyDate, khateebName) {
  const row = (k, val) => val
    ? `<tr><td style="color:#8a8398;padding:5px 18px 5px 0;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:5px 0;">${esc(val)}</td></tr>`
    : '';
  return `<table style="margin:16px 0;font-size:15px;line-height:1.5;border-collapse:collapse;">
    ${row('Khateeb', khateebName)}
    ${row('School / MSA', d.school)}
    ${row('When', prettyDate)}
    ${row('Location', d.location)}
    ${row('Est. attendance', d.attendance)}
    ${row('Topic', d.topic)}
    ${row('Contact', d.contact)}
    ${row('Email', d.email)}
    ${row('Phone', d.phone)}
    ${row('Notes', d.notes)}
  </table>`;
}

function emailShell(inner) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
    max-width:560px;margin:0 auto;color:#2a2738;font-size:15px;line-height:1.6;">
    <div style="background:linear-gradient(180deg,#6b6184,#5d537a);padding:26px 28px;
      border-radius:12px 12px 0 0;">
      <div style="color:#f4ede0;font-size:22px;font-family:Georgia,serif;letter-spacing:.5px;">Manarah</div>
    </div>
    <div style="background:#fbf8f3;padding:28px;border:1px solid #ece4d6;border-top:none;
      border-radius:0 0 12px 12px;">${inner}</div>
  </div>`;
}

function htmlPage(title, body) {
  return HtmlService.createHtmlOutput(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
     <style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4ede0;
     margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#2a2738;}
     .card{background:#fbf8f3;border:1px solid #ece4d6;border-radius:16px;padding:40px 44px;
     max-width:440px;text-align:center;box-shadow:0 10px 40px rgba(93,83,122,.12);}
     h1{font-family:Georgia,serif;color:#5d537a;font-weight:500;margin:0 0 12px;}
     p{color:#5a546b;line-height:1.6;margin:0;}</style></head>
     <body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`
  );
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function makeToken(ref) {
  const sig = Utilities.computeHmacSha256Signature(ref, SECRET);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

function webAppUrl() {
  return ScriptApp.getService().getUrl();
}

function newRef() {
  return 'MR-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================ TEST ============================
// Run this once from the editor to grant permissions and verify wiring.
// It sends real emails to the addresses in CONFIG, so use your own first.
function runTest() {
  handleBooking({
    ref: 'TEST-0001',
    khateebKey: 'zayaan',
    school: 'Test MSA',
    contact: 'Test Organizer',
    email: ORG_EMAIL,        // sends the requester copy to yourself
    phone: '(000) 000-0000',
    date: Utilities.formatDate(new Date(Date.now() + 7 * 864e5), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    time: '13:15',
    attendance: '75–150',
    location: 'Test Hall, 123 Main St',
    topic: 'Patience in trials',
    notes: 'This is a test booking.'
  });
}
