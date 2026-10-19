const { db, nowManila, getSetting } = require('./db');

function fmt12(time) {
  let [h, m] = time.split(':');
  h = Number(h);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function normalizePhone(phone) {
  const value = String(phone).replace(/[\s()-]/g, '');
  if (/^09\d{9}$/.test(value)) return `+63${value.slice(1)}`;
  if (/^9\d{9}$/.test(value)) return `+63${value}`;
  if (/^639\d{9}$/.test(value)) return `+${value}`;
  if (/^\+639\d{9}$/.test(value)) return value;
  throw new Error('Invalid Philippine mobile number; expected 09XXXXXXXXX or +639XXXXXXXXX');
}

// "console" only prints (safe default for development); "phone-gateway" sends JSON to the configured gateway.
async function sendSMS(phone, message) {
  const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();
  if (provider === 'phone-gateway') {
    const { PHONE_GATEWAY_URL, PHONE_GATEWAY_USER, PHONE_GATEWAY_PASSWORD } = process.env;
    if (!PHONE_GATEWAY_URL || !PHONE_GATEWAY_USER || !PHONE_GATEWAY_PASSWORD) {
      throw new Error('PHONE_GATEWAY_URL, PHONE_GATEWAY_USER, and PHONE_GATEWAY_PASSWORD must be set');
    }
    const recipient = normalizePhone(process.env.PHONE_GATEWAY_TEST_RECIPIENT || phone);
    const authorization = Buffer.from(`${PHONE_GATEWAY_USER}:${PHONE_GATEWAY_PASSWORD}`).toString('base64');
    const res = await fetch(PHONE_GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone: recipient, message }),
    });
    if (!res.ok) throw new Error(`Phone gateway HTTP ${res.status}`);
    return { provider, phone: recipient };
  }
  if (provider === 'console') {
    console.log(`[SMS:console] to ${phone}: ${message}`);
    return { provider, phone };
  }
  throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
}

async function logAndSend(student, kind, date, message) {
  if (await getSetting('notify_enabled') !== '1') return false;
  // Data Privacy Act: only message parents who gave consent.
  if (!student.consent || !student.parent_phone) return false;
  let status = 'sent';
  let provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();
  let phone = student.parent_phone;
  try {
    const result = await sendSMS(phone, message);
    provider = result.provider;
    phone = result.phone;
  } catch (e) {
    status = 'failed: ' + e.message;
  }
  await db.prepare(
    'INSERT INTO notifications(student_id,kind,date,phone,message,status,provider,ts) VALUES(?,?,?,?,?,?,?,?)'
  ).run(student.id, kind, date, phone, message, status, provider, nowManila().ts);
  return status === 'sent';
}

function notifyParent(student, type, status, time, date) {
  return getSetting('school_name').then((school) => {
    const messages = {
      MORNING_IN: `arrived for morning class${status === 'late' ? ' (late)' : ''}`,
      MORNING_OUT: 'left after morning class',
      AFTERNOON_IN: `arrived for afternoon class${status === 'late' ? ' (late)' : ''}`,
      AFTERNOON_OUT: 'left after afternoon class',
    };
    const message = `${school}: ${student.name} ${messages[type]} at ${fmt12(time)}.`;
    return logAndSend(student, type, date, message);
  });
}

// Sends one "absent" SMS per student per day. Safe to press more than once.
async function sendAbsentNotices(date) {
  const school = await getSetting('school_name');
  const absentees = await db
    .prepare(
      `SELECT s.* FROM students s
       WHERE s.active=1
         AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.student_id=s.id AND a.date=?)
         AND NOT EXISTS (SELECT 1 FROM absence_notices n WHERE n.student_id=s.id AND n.date=?)`
    )
    .all(date, date);
  let sent = 0;
  for (const s of absentees) {
    const msg = `${school}: ${s.name} was marked ABSENT today (${date}). If this is unexpected, please contact the class adviser.`;
    const delivered = await logAndSend(s, 'ABSENT', date, msg);
    if ((await getSetting('notify_enabled')) === '1' && s.consent && s.parent_phone) {
      await db.prepare('INSERT INTO absence_notices(student_id,date) VALUES(?,?) ON CONFLICT DO NOTHING').run(s.id, date);
    }
    if (delivered) sent++;
  }
  return { checked: absentees.length, sent };
}

module.exports = { notifyParent, sendAbsentNotices, fmt12, normalizePhone };
