# RFID Attendance, Parent SMS and Early-Warning Dashboard

A small web system for Philippine high schools:

1. **Attendance**: students tap an RFID ID card at the gate; the web dashboard shows live taps, daily attendance per section, and exports an SF2-style monthly CSV.
2. **Parent notification**: parents get an SMS when their child arrives (with a "late" note if applicable) or leaves, plus an optional "absent today" text.
3. **Early warning**: every student is scored from the selected calendar month (absences, lateness, consecutive absences, rising trend). Admins can review previous months. Guidance counselors get a High / Medium list with reasons and a suggested action, exportable as CSV.

Stack: Node.js + Express + SQLite locally or Neon Postgres on Vercel, plain HTML/JavaScript dashboard, and ESP32 + RC522 reader.

## Quick start (no hardware needed)

```bash
npm install
npm run seed        # demo school: 30 students, ~45 days of history
npm start           # http://localhost:3000
```

Sign in as admin (default username `admin`, password `admin123`) or as user (default username `user`, password `user1234`). Change the default credentials before real use. Admins can add, edit, and remove students and manage settings. Set the four class times in **Settings** before scanning or using **Test without hardware**. Users see the latest recognized card tap or scan feedback, along with student details when the card is registered. Open "Early warning" to see the demo students who were seeded with worrying patterns.

Run with your own secrets:

```bash
ADMIN_USERNAME=principal ADMIN_PASSWORD=mypassword USER_USERNAME=staff USER_PASSWORD=anotherpassword DEVICE_KEY=longrandomkey npm start
```

New databases get admin and user accounts from these environment variables. Admins can later change their own username and password in **Settings**; those changes are stored as salted password hashes in the database and are not reset from environment variables on restart. The user account credentials are set through `USER_USERNAME` and `USER_PASSWORD`.

Requires Node 22.13 or newer (check with `node -v`). Local development uses Node's built-in SQLite. If you see an "ExperimentalWarning: SQLite" message when the server starts, it is harmless.

## Deploying to Vercel

Vercel runs the Node.js app as a serverless function. Use Neon Postgres for persistent data because Vercel's function filesystem is temporary.

1. Create a Neon Postgres database and copy its pooled connection string.
2. Push the project to a private GitHub repository. Do not commit `.env`, `data.db`, or database backups.
3. In Vercel, choose **Add New → Project** and import the repository.
4. Add these environment variables in Vercel's project settings (Production and Preview as needed):
   - `DATABASE_URL`: the Neon pooled connection string.
   - `AUTH_SECRET`: a long random secret, generated locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it stable between deployments.
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `USER_USERNAME`, `USER_PASSWORD`, and `DEVICE_KEY`: use strong, unique values.
   - SMS gateway variables only if using a real phone gateway.
5. Deploy. On its first request, the app creates the Neon schema and configured accounts. The dashboard is served from `public/`, and `/api/*` is routed to the Express function.
6. Open the deployed URL and sign in. In `firmware/esp32_rc522/esp32_rc522.ino`, set `SERVER_URL` to `https://YOUR-VERCEL-DOMAIN/api/tap` and `DEVICE_KEY` to match Vercel, then upload the sketch.

Keep Neon credentials and all secrets in Vercel's environment-variable settings, never in source control. A new Neon database starts empty; data in local `data.db` is not imported automatically. Migrate and verify real records separately before relying on them. Never run the demo seeder against real attendance data.

## Using it for real

1. Remove the demo data by starting from a fresh database (delete `data.db`) instead of running the seed.
2. In the **Students** tab, add grade/section groups with **+ Add section**, then choose a group in the section filter to view its students. Add students by entering surname, first name, optional middle name and name extension, then selecting an existing grade/section. Names show the middle initial in lists; clicking a student in **Attendance** shows the full middle name in the monthly detail. To register a card: tap it on the reader, then open the Students tab; the unregistered UID shows up as a chip you can click to fill in the form.
3. Record each parent's mobile number and tick the **consent** box only when the parent has signed a consent form. No consent, no SMS.
4. In **Settings** set the school name and configure both class late cutoffs and finish times in chronological order. Add holidays/suspensions so they aren't counted as absences.
5. Pick an SMS provider (below).

## Tap rules

- Each student can record four events per school day: morning **IN**, morning **OUT**, afternoon **IN**, and afternoon **OUT**.
- Morning check-ins after the configured morning late cutoff are marked late; morning check-outs are accepted at or after morning class finishes. Afternoon check-ins follow the same rule using the afternoon cutoff and finish time.
- Scans must occur in the expected class period and sequence. Wrong-period scans are rejected and listed under **Scans to review**; repeats within the configured debounce window and already-recorded events are ignored.
- Unknown or inactive cards show **Try again** on the student scan screen and are remembered so staff can register them.
- No tap on a school day = **absent**. Weekends and listed holidays are skipped.

## SMS

`SMS_PROVIDER=console` (default) only prints messages to the terminal. Messages are also recorded in the **SMS log** tab.

For automatic arrival/departure texts through the phone gateway, set `SMS_PROVIDER=phone-gateway` and configure `PHONE_GATEWAY_URL`, `PHONE_GATEWAY_USER`, and `PHONE_GATEWAY_PASSWORD` locally in `.env` or as Vercel environment variables. The app sends a JSON `POST` with Basic authentication. Phone numbers are normalized to `+63`.

To test without messaging parents, set `PHONE_GATEWAY_TEST_RECIPIENT` locally or in Vercel to your own mobile number. Texts are triggered by recent RFID taps when **Send parent SMS on tap** is enabled. Only students with a parent phone number and recorded consent are messaged. The **SMS log** tab shows provider failures.

SMS costs real money per message and per student per day, so estimate your volume first. You can switch tap texts off in Settings and keep only the manual "absent" notice.

Press **Notify parents of absentees** on the Overview tab after your late cutoff to manually text each absent student's parent once per day.

The Overview tab can permanently delete live tap feed entries, and the SMS log tab can permanently delete SMS history entries. These actions keep attendance records, tap-processing state, and daily absence-notification safeguards intact. Deleting an SMS log does not recall messages already sent.

Admins can permanently clear all saved data from **Settings**. The action requires typing `DELETE ALL`; it deletes students, attendance, tap history, SMS logs, unknown cards, absence-notification history, holidays, saved settings, and saved account credentials. Admin and user accounts are recreated from configured credentials, settings return to defaults, and other sessions are signed out. This cannot erase copies outside the live database (for example, backups or filesystem snapshots).

## Early-warning scoring

Scores only the selected calendar month (`risk.js`). The current month is selected by default and includes school days through yesterday; today is excluded while attendance is still in progress. Admins can select any past month to review its record. The rising-absence signal compares the second half of the month with the first half:

| Signal | Points |
|---|---|
| each absence | 4 |
| each late arrival | 1.5 |
| each consecutive absence at the end (1-2 days / 3+ days) | 2 / 4 |
| each extra absence in the second half vs the first half | 2 |

**High** is 28 or more, **Medium** is 14 or more. Adjust the corresponding scoring code in `risk.js` with your guidance office. This is a screening aid to prompt a human conversation, not a judgement on a student. Validate it against real cases at your school before relying on it.

## Hardware

Per gate: ESP32 dev board, RC522 module, two LEDs, buzzer (roughly a few hundred pesos). Wiring and the sketch are in `firmware/esp32_rc522/esp32_rc522.ino`. Set the Wi-Fi name, the server URL (local address for local development, or your Vercel URL after deployment) and `DEVICE_KEY`.

- The reader sends the card UID to `POST /api/tap` with header `x-device-key`.
- If the server is unreachable, taps are queued in RAM with a timestamp and replayed later. Old replayed taps do not trigger SMS.
- Cards: RC522 reads 13.56 MHz MIFARE cards. Check that your school's existing IDs use this type before buying hardware; many low-cost ID cards do.

## Data Privacy Act (RA 10173) checklist

This stores personal data of minors. Before going live:

- Get written parental consent for the data collected and for SMS (the consent checkbox records the decision; keep the signed forms).
- Have the school's Data Protection Officer review it, and add the system to your privacy notice.
- Change `ADMIN_PASSWORD`, `USER_PASSWORD`, and `DEVICE_KEY`. Vercel provides HTTPS for deployed sites.
- Change the default admin and user credentials before use. Admins can manage students and settings; user accounts are restricted to the live student-tap display.
- Back up the active database regularly and restrict access to the server.
- Decide how long attendance data is kept and delete it afterwards.

## Project layout

```
server.js       local and Vercel Node.js REST API
attendance.js   Node tap processing (IN/OUT, late, debounce)
notify.js       Node SMS sending and logging
risk.js         early-warning scoring
db.js           local SQLite / Neon database helpers
api/index.js    Vercel serverless entry point for Express
vercel.json     Vercel routing and deployment configuration
public/         dashboard (index.html, app.js, style.css)
firmware/       ESP32 + RC522 sketch
```

## Notes and limits

- The SF2 export is **SF2-style**, laid out like DepEd School Form 2. Compare it with the current official form before using it for submission.
- Signed authentication tokens work across serverless instances; changing account credentials invalidates existing tokens.
- Times are Philippine time (UTC+8) regardless of the server's timezone.
