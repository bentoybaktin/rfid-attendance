# RFID Attendance, Parent SMS and Early-Warning Dashboard

A small web system for Philippine high schools:

1. **Attendance**: students tap an RFID ID card at the gate; the web dashboard shows live taps, daily attendance per section, and exports an SF2-style monthly CSV.
2. **Parent notification**: parents get an SMS when their child arrives (with a "late" note if applicable) or leaves, plus an optional "absent today" text.
3. **Early warning**: every student is scored from the selected calendar month (absences, lateness, consecutive absences, rising trend). Admins can review previous months. Guidance counselors get a High / Medium list with reasons and a suggested action, exportable as CSV.

Stack: Node.js + Express + SQLite (single file, no database server), plain HTML/JS dashboard, ESP32 + RC522 reader.

## Quick start (no hardware needed)

```bash
npm install
npm run seed        # demo school: 30 students, ~45 days of history
npm start           # http://localhost:3000
```

Sign in as admin (default username `admin`, password `admin123`) or as user (default username `user`, password `user1234`). Change the default credentials before real use. Admins can add, edit, and remove students and manage settings. Users see only the latest recognized card tap: student name, LRN, grade/section, tap result, and time. On the Overview tab use "Test without hardware" to simulate taps. Open "Early warning" to see the demo students who were seeded with worrying patterns.

Run with your own secrets:

```bash
ADMIN_USERNAME=principal ADMIN_PASSWORD=mypassword USER_USERNAME=staff USER_PASSWORD=anotherpassword DEVICE_KEY=longrandomkey npm start
```

New databases get admin and user accounts from these environment variables. Admins can later change their own username and password in **Settings**; those changes are stored as salted password hashes in the database and are not reset from environment variables on restart. The user account credentials are set through `USER_USERNAME` and `USER_PASSWORD`.

Requires Node 22.13 or newer (check with `node -v`). It uses Node's built-in SQLite, so the only package `npm install` downloads is Express. If you see an "ExperimentalWarning: SQLite" message when the server starts, it is harmless.

## Using it for real

1. Remove the demo data by starting from a fresh database (delete `data.db`) instead of running the seed.
2. In the **Students** tab, add grade/section groups with **+ Add section**, then choose a group in the section filter to view its students. Add students by entering surname, first name, optional middle name and name extension, then selecting an existing grade/section. Names show the middle initial in lists; clicking a student in **Attendance** shows the full middle name in the monthly detail. To register a card: tap it on the reader, then open the Students tab; the unregistered UID shows up as a chip you can click to fill in the form.
3. Record each parent's mobile number and tick the **consent** box only when the parent has signed a consent form. No consent, no SMS.
4. In **Settings** set the school name, the late cutoff (default 07:30) and add holidays/suspensions so they aren't counted as absences.
5. Pick an SMS provider (below).

## Tap rules

- First tap of the day = **IN** (on time, or **late** if after the cutoff).
- Later taps alternate **OUT / IN**.
- Repeat taps within 60 seconds (adjustable) are ignored.
- Unknown cards are remembered so staff can register them.
- No tap on a school day = **absent**. Weekends and listed holidays are skipped.

## SMS

`SMS_PROVIDER=console` (default) only prints messages to the terminal and logs them in the **SMS log** tab, which is what you want while testing.

For automatic arrival/departure texts through the phone gateway, copy `.env.example` to `.env`, set `SMS_PROVIDER=phone-gateway`, and configure `PHONE_GATEWAY_URL`, `PHONE_GATEWAY_USER`, and `PHONE_GATEWAY_PASSWORD`. The app sends a JSON `POST` with Basic authentication to the configured route. Phone numbers are normalized to `+63` format before sending. The `npm start` command loads `.env` automatically. Do not commit or share `.env`; it is ignored by Git.

To test without messaging parents, set `PHONE_GATEWAY_TEST_RECIPIENT` in your local `.env` to your own `+63` mobile number. All phone-gateway messages will go to that number until you remove the setting. Texts are triggered by recent RFID taps when **Send parent SMS on tap** is enabled in Settings. Only students with a parent phone number and recorded consent are messaged. The **SMS log** tab shows provider failures, including a missing or invalid configuration.

SMS costs real money per message and per student per day, so estimate your volume first. You can switch tap texts off in Settings and keep only the manual "absent" notice.

Press **Notify parents of absentees** on the Overview tab after your late cutoff to manually text each absent student's parent once per day.

The Overview tab can permanently delete live tap feed entries, and the SMS log tab can permanently delete SMS history entries. These actions keep attendance records, tap-processing state, and daily absence-notification safeguards intact. Deleting an SMS log does not recall messages already sent.

Admins can permanently clear all saved data from **Settings**. The action requires typing `DELETE ALL`; it securely deletes students, attendance, tap history, SMS logs, unknown cards, absence-notification history, holidays, saved settings, and saved account credentials, then vacuums the database and truncates its write-ahead log. Admin and user accounts are recreated from configured credentials; settings return to defaults, and other active sessions are signed out. This cannot erase copies outside the live database (for example, backups or filesystem snapshots).

## Early-warning scoring

Scores only the selected calendar month (`risk.js`). The current month is selected by default and includes school days through yesterday; today is excluded while attendance is still in progress. Admins can select any past month to review its record. The rising-absence signal compares the second half of the month with the first half:

| Signal | Points |
|---|---|
| each absence | 4 |
| each late arrival | 1.5 |
| each consecutive absence at the end (1-2 days / 3+ days) | 2 / 4 |
| each extra absence in the second half vs the first half | 2 |

**High** is 28 or more, **Medium** is 14 or more. The numbers are plain constants at the top of `risk.js`; adjust them with your guidance office. This is a screening aid to prompt a human conversation, not a judgement on a student. Validate it against real cases at your school before relying on it.

## Hardware

Per gate: ESP32 dev board, RC522 module, two LEDs, buzzer (roughly a few hundred pesos). Wiring and the sketch are in `firmware/esp32_rc522/esp32_rc522.ino`. Set the Wi-Fi name, the server URL (the computer running this app, on the same network) and `DEVICE_KEY`.

- The reader sends the card UID to `POST /api/tap` with header `x-device-key`.
- If the server is unreachable, taps are queued in RAM with a timestamp and replayed later. Old replayed taps do not trigger SMS.
- Cards: RC522 reads 13.56 MHz MIFARE cards. Check that your school's existing IDs use this type before buying hardware; many low-cost ID cards do.

## Data Privacy Act (RA 10173) checklist

This stores personal data of minors. Before going live:

- Get written parental consent for the data collected and for SMS (the consent checkbox records the decision; keep the signed forms).
- Have the school's Data Protection Officer review it, and add the system to your privacy notice.
- Change `ADMIN_PASSWORD` and `DEVICE_KEY`. Serve the dashboard over HTTPS (e.g. behind Caddy or nginx) if it is reachable beyond the school LAN.
- Change the default admin and user credentials before use. Admins can manage students and settings; user accounts are restricted to the live student-tap display. Use HTTPS if the dashboard is reachable beyond the school LAN.
- Back up `data.db` regularly and limit physical access to the server.
- Decide how long attendance data is kept and delete it afterwards.

## Project layout

```
server.js       REST API, login, CSV exports, serves the dashboard
attendance.js   tap processing (IN/OUT, late, debounce)
notify.js       SMS sending and logging
risk.js         early-warning scoring
db.js           SQLite schema, settings, school-day helpers
seed.js         demo data
public/         dashboard (index.html, app.js, style.css)
firmware/       ESP32 + RC522 sketch
```

## Notes and limits

- The SF2 export is **SF2-style**, laid out like DepEd School Form 2. Compare it with the current official form before using it for submission.
- One shared admin login and an in-memory session list: restarting the server signs everyone out.
- Times are Philippine time (UTC+8) regardless of the server's timezone.
