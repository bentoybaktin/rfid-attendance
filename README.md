# RFID Attendance, Parent Notifications and Early-Warning Dashboard

A small web system for Philippine high schools:

1. **Attendance**: students tap an RFID ID card at the gate; the web dashboard shows live taps, daily attendance per section, and exports an SF2-style monthly CSV.
2. **Parent notification**: opted-in parents can get SMS and/or email when their child arrives (with a "late" note if applicable) or leaves, plus an optional "absent today" notice.
3. **Early warning**: every student is scored from the selected calendar month (absences, lateness, consecutive absences, rising trend). Admins can review previous months. Guidance counselors get a High / Medium list with reasons and a suggested action, exportable as CSV.

Stack: Node.js + Express + SQLite locally or Neon Postgres on Vercel, plain HTML/JavaScript dashboard, and ESP32 + RC522 reader.

## Quick start (no hardware needed)

```bash
npm install
npm run seed        # demo school: 30 students, ~45 days of history
npm start           # http://localhost:3000
```

Sign in as admin (default username `admin`, password `admin123`) or as user (default username `user`, password `user1234`). Change the default credentials before real use. Admins can add, edit, and remove students and manage settings. The user account can add students to sections created by the admin, but cannot view, edit, or remove student records; duplicate names, LRN values, or RFID cards must be resolved by the admin. Users also see the latest recognized card tap or scan feedback, along with student details when the card is registered. Set the four class times in **Settings** before scanning or using **Test without hardware**. Open "Early warning" to see the demo students who were seeded with worrying patterns.

Admins can open a student's shareable detail URL by selecting their name in **Students**. These `/students/<id>` links require an authenticated admin account.

For compatibility with PHP-style links, `/index.php?url=%2Fadmin%2Fdashboard` redirects to the existing dashboard at `/`. It does not add a PHP runtime or bypass the normal sign-in and role checks.

When an admin selects a dashboard tab, a loading screen stays visible until that tab's data has loaded, then the completed tab is shown. This makes the transition clearer but does not replace server/database performance improvements.

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
   - `RESEND_API_KEY` and `EMAIL_FROM` to enable parent email notifications. Create a Resend account, verify a sending domain, create an API key, and set `EMAIL_FROM` to an address on that verified domain (for example, `Attendance <attendance@school.example>`).
5. Deploy. On its first request, the app creates the Neon schema and configured accounts. The dashboard is served from `public/`, and `/api/*` is routed to the Express function.
6. Open the deployed URL and sign in. In `firmware/esp32_rc522/esp32_rc522.ino`, set `SERVER_URL` to `https://YOUR-VERCEL-DOMAIN/api/tap` and `DEVICE_KEY` to match Vercel, then upload the sketch.

Keep Neon credentials and all secrets in Vercel's environment-variable settings, never in source control. A new Neon database starts empty; data in local `data.db` is not imported automatically. Migrate and verify real records separately before relying on them. Never run the demo seeder against real attendance data.

### Enabling parent email notifications

1. Verify a sending domain with Resend and create an API key with permission to send email. Keep the key secret.
2. In Vercel, add `RESEND_API_KEY` and `EMAIL_FROM` under **Project → Settings → Environment Variables** for the environments you use, then redeploy so the running app receives them. For local development, put them in your untracked `.env` file.
3. In the dashboard's **Settings**, choose whether to send SMS, email, or both, then save.
4. Edit each student and enter the parent's email address. Record the parent's email consent before checking the consent box. Email is sent only when email is enabled, an address is saved, and consent is recorded. SMS has its own contact and consent fields.
5. Trigger an attendance scan or the absence-notification action and check the **Notifications** log for delivery status. Test with an address you control before enabling messages for families.

The app sends email through Resend's API; it does not store provider credentials in the database. Failed sends appear in the notification log. The provider's delivery, bounce, and spam handling still apply.

## API security

- The API requires a signed bearer token for dashboard requests. Without **Remember me**, sign-in data is kept only for the browser tab and tokens expire after 12 hours; closing the tab signs out. With **Remember me**, the browser keeps the sign-in for up to 30 days. Changing account credentials invalidates tokens signed with the old password hash.
- Admins have full access. User accounts are limited to the live scan view, reading section names, and submitting new student registrations; they cannot read the existing student roster or attendance reports.
- The API is same-origin by default. Set `CORS_ORIGINS` to a comma-separated list of exact trusted HTTP(S) origins only when separate web clients need cross-origin access. Do not use wildcard origins.
- Security headers (including a restrictive Content Security Policy and HSTS) are sent by Express and configured for Vercel-served static pages. Client-rendered record values are HTML-escaped, and CSV exports neutralize formula-leading values.
- Only files inside `public/` are served as static assets; dotfiles are denied. API responses are marked `no-store`, unknown routes return generic 404 responses, and request failures return safe client messages while server errors are logged without exposing stack traces to clients.
- The bulk `GET /api/students` roster omits LRN, RFID UID, guardian name, and phone; it returns only boolean indicators for assigned cards and SMS eligibility. User accounts cannot read the roster or reports. Admin-only student detail/edit, attendance, and explicit CSV export features can still return LRN or other information needed for those tasks. Any information delivered to an authorized browser is visible in its Network tools; authorization and minimizing returned fields limit exposure, but do not make client-received data secret.
- Admins can configure two password-recovery questions in **Settings → Account**. Answers are normalized and stored as independently salted password hashes. Recovery requires both answers, uses a single-use 10-minute challenge, resets the admin password to a minimum of 12 characters, and is limited to five combined challenge/reset attempts per IP per 15 minutes using the database. Security-question answers may be guessable or discoverable; choose private answers and use a strong, unique password.
- API requests are limited to 3,000 per IP per 15 minutes and RFID device requests to 120 per IP per minute using `express-rate-limit`. Sign-in requests are limited to 10 per IP per 15 minutes using database-backed counters, shared across server instances, with standard `RateLimit-*` response headers. General API/device limits use the default in-memory store; configure a shared store for those limits when deploying multiple instances. Password-recovery attempts are limited separately using the database.
- JSON request bodies are limited to 64 KB. Production deployments must provide `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `USER_USERNAME`, `USER_PASSWORD`, `DEVICE_KEY`, and a stable random `AUTH_SECRET`.
- Vercel provides managed HTTPS for deployed domains; the app sends HSTS and Vercel redirects/serves deployments over HTTPS. Certificate grade and hostname coverage must still be verified against the actual deployed domain with an external TLS scanner; they cannot be established from the source code alone.

## Using it for real

1. Remove the demo data by starting from a fresh database (delete `data.db`) instead of running the seed.
2. In the **Students** tab, add grade/section groups with **+ Add section**, then choose a group in the section filter to view its students. Add students by entering surname, first name, optional middle name and name extension, then selecting an existing grade/section. Names show the middle initial in lists; clicking a student in **Attendance** shows the full middle name in the monthly detail. To register a card: tap it on the reader, then open the Students tab; the unregistered UID shows up as a chip you can click to fill in the form.
3. Record each parent's mobile number and tick the **consent** box only when the parent has signed a consent form. No consent, no SMS.
4. In **Settings** set the school name and configure both class late cutoffs and finish times in chronological order. Add holidays/suspensions so they aren't counted as absences.
5. Pick an SMS provider (below).

## Tap rules

- Each student can record four events per school day: morning **IN**, morning **OUT**, afternoon **IN**, and afternoon **OUT**.
- Morning check-ins after the configured morning late cutoff are marked late; morning check-outs are accepted at or after morning class finishes. Afternoon check-ins follow the same rule using the afternoon cutoff and finish time.
- After a student's morning **OUT**, that student must wait five minutes before recording afternoon **IN**. If no morning **OUT** was recorded, the same five-minute wait starts at the configured morning class finish. Earlier scans are rejected with a retry message.
- A student's first scan after morning class has ended can count as afternoon **IN** even if the student missed the morning scans. The morning is marked absent, the afternoon is marked present (or late by its cutoff), and the day is reported as a half day.
- Afternoon-only attendance counts as half an absence in monthly risk scoring and as half a day in the SF2-style export.
- Scans must occur in the expected class period and sequence. Wrong-period scans are rejected and listed under **Scans to review**; repeats within the configured debounce window and already-recorded events are ignored.
- Unknown or inactive cards show **Try again** on the student scan screen and are remembered so staff can register them.
- No tap on a school day = **absent**. Weekends and listed holidays are skipped.

## Parent notifications

SMS and email can be enabled independently in **Settings**, so the school can use either channel or both. Notifications are sent only when the corresponding parent contact and consent are saved. All attempts and provider failures appear in the **Notifications** tab.

SMS defaults to `SMS_PROVIDER=console`, which prints messages to the terminal without sending them. For automatic texts through the phone gateway, set `SMS_PROVIDER=phone-gateway` and configure `PHONE_GATEWAY_URL`, `PHONE_GATEWAY_USER`, and `PHONE_GATEWAY_PASSWORD` locally in `.env` or as Vercel environment variables. The app sends a JSON `POST` with Basic authentication. Phone numbers are normalized to `+63`.

To test texts without messaging parents, set `PHONE_GATEWAY_TEST_RECIPIENT` locally or in Vercel to your own mobile number. SMS is triggered by attendance scans when **Send parent SMS on tap** is enabled. Email setup steps are in [Enabling parent email notifications](#enabling-parent-email-notifications).

SMS and email are triggered by attendance scans when their respective settings are enabled. The manual **Notify parents of absentees** action uses the same channel settings and per-student consent. Email delivery is subject to Resend's delivery and rate limits; SMS may incur charges per message.

Press **Notify parents of absentees** on the Overview tab after your late cutoff to send the configured notice to each opted-in absent student's parent once per day.

The Overview tab can permanently delete live tap feed entries, and the Notifications tab can permanently delete notification history. These actions keep attendance records, tap-processing state, and daily absence-notification safeguards intact. Deleting a log does not recall messages already sent.

Admins can permanently clear all saved data from **Settings**. The action requires typing `DELETE ALL`; it deletes students, attendance, tap history, notification logs, unknown cards, absence-notification history, holidays, saved settings, and saved account credentials. Admin and user accounts are recreated from configured credentials, settings return to defaults, and other sessions are signed out. This cannot erase copies outside the live database (for example, backups or filesystem snapshots).

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
- Change the default admin and user credentials before use. Admins can manage students and settings; user accounts can use the live student-tap display and submit new student registrations.
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
