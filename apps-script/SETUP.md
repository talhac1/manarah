# Booking automation — setup (about 10 minutes)

This connects your khateeb booking forms to Gmail + Google Calendar.
No backend server, no monthly cost. Everything runs on your Google account.

## What happens on each booking

1. Someone submits a booking form on a khateeb's page.
2. **Requester** instantly gets a "we received your request" email.
3. The **khateeb** gets an email with all the details + a **Confirm** button.
4. The booking is logged to a Google Sheet (created automatically).
5. When the khateeb clicks **Confirm**:
   - A Google Calendar event is created.
   - Calendar **invites** are sent to the requester **and** the org email.
   - The requester and the org both get a confirmation email.

All emails send **from the Gmail account** you set this up with.

---

## Step 1 — Create the script

1. Go to **https://script.google.com** → **New project**.
2. Delete the placeholder `myFunction` code.
3. Open `Code.gs` from this folder, copy **everything**, paste it in.
4. Rename the project (top left) to `Manarah Bookings`.

## Step 2 — Fill in the CONFIG block

At the top of the file, edit:

```js
const ORG_EMAIL = 'salam@manarah.org';   // your org inbox

const KHATEEBS = {
  zayaan: { name: 'Br. Zayaan Backus',  email: 'REAL-EMAIL@gmail.com' },
  yusuf:  { name: 'Br. Yusuf Rahman',   email: 'REAL-EMAIL@gmail.com' },
  idris:  { name: 'Br. Idris Mohammed', email: 'REAL-EMAIL@gmail.com' },
};

const SECRET = 'CHANGE-ME-to-a-long-random-secret-string-9f3a1c'; // any long random string
```

The **keys** (`zayaan`, `yusuf`, `idris`) must match `KHATEEB_KEY` in each HTML page —
they already do, so just fill in the real emails.

## Step 3 — Grant permissions (one-time)

1. In the editor, pick the function **`runTest`** from the dropdown → click **Run**.
2. Google will ask you to authorize → choose your account → **Advanced** →
   **Go to Manarah Bookings (unsafe)** → **Allow**. (It says "unsafe" for every
   personal script; it's your own code.)
3. Check your inbox — you should get the test emails. A **Manarah Bookings**
   spreadsheet now exists in your Google Drive.

## Step 4 — Deploy as a Web App

1. Top right → **Deploy** → **New deployment**.
2. Gear icon → **Web app**.
3. Set:
   - **Execute as:** Me
   - **Who has access:** **Anyone**
4. **Deploy** → copy the **Web app URL** (ends in `/exec`).

## Step 5 — Paste the URL into the site

In each of these files, find this line near the bottom and paste your URL:

```js
const BOOKING_ENDPOINT = "PASTE_YOUR_WEB_APP_URL_HERE";
```

Files:
- `khateebs/zayaan.html`
- `khateebs/yusuf.html`
- `khateebs/idris.html`

Same URL in all three. Save, re-upload to the site. Done.

---

## Notes

- **Re-deploying after code edits:** Deploy → **Manage deployments** → edit (pencil)
  → **Version: New version** → **Deploy**. The URL stays the same.
- **Calendar choice:** `CALENDAR_ID = 'primary'` uses your main calendar. To use a
  shared one, paste its Calendar ID (Calendar settings → Integrate calendar).
- **Time:** the form now collects a Jumu'ah time so the calendar event is accurate.
- **Before going live**, set each khateeb's real email and test with your own address.
