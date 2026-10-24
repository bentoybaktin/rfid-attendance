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
    return { provider, recipient };
  }
  if (provider === 'console') {
    console.log(`[SMS:console] to ${phone}: ${message}`);
    return { provider, recipient: phone };
  }
  throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
}

async function sendEmail(email, subject, message) {
  const { RESEND_API_KEY, EMAIL_FROM } = process.env;
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM must be set to send email');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: [email], subject, text: message }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Resend email API HTTP ${response.status}`);
  return { provider: 'resend', recipient: email };
}

async function logAndSend(student, kind, date, subject, message, channel) {
  const isEmail = channel === 'email';
  const enabled = await getSetting(isEmail ? 'email_notify_enabled' : 'notify_enabled');
  const contact = isEmail ? student.parent_email : student.parent_phone;
  const consent = isEmail ? student.email_consent : student.consent;
  if (enabled !== '1' || !consent || !contact) return { attempted: false, sent: false };

  let status = 'sent';
  const provider = isEmail ? 'resend' : (process.env.SMS_PROVIDER || 'console').toLowerCase();
  let recipient = contact;
  try {
    const result = isEmail
      ? await sendEmail(contact, subject, message)
      : await sendSMS(contact, message);
    recipient = result.recipient;
  } catch (error) {
    status = `failed: ${error.message}`;
  }
  await db.prepare(
    `INSERT INTO notifications(student_id,kind,date,phone,message,status,provider,ts,channel,recipient)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(student.id, kind, date, isEmail ? null : recipient, message, status, provider,
    nowManila().ts, channel, recipient);
  return { attempted: true, sent: status === 'sent' };
}

async function notifyParent(student, type, status, time, date) {
  const school = await getSetting('school_name');
  const events = {
    MORNING_IN: `arrived for morning class${status === 'late' ? ' (late)' : ''}`,
    MORNING_OUT: 'left after morning class',
    AFTERNOON_IN: `arrived for afternoon class${status === 'late' ? ' (late)' : ''}`,
    AFTERNOON_OUT: 'left after afternoon class',
  };
  const message = `${school}: ${student.name} ${events[type]} at ${fmt12(time)}.`;
  const subject = `${student.name} attendance update - ${school}`;
  const results = await Promise.all(['sms', 'email'].map((channel) =>
    logAndSend(student, type, date, subject, message, channel)
  ));
  return results.some((result) => result.sent);
}

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
  for (const student of absentees) {
    const message = `${school}: ${student.name} was marked ABSENT today (${date}). If this is unexpected, please contact the class adviser.`;
    const subject = `${student.name} absence notice - ${school}`;
    const results = await Promise.all(['sms', 'email'].map((channel) =>
      logAndSend(student, 'ABSENT', date, subject, message, channel)
    ));
    const attempted = results.some((result) => result.attempted);
    if (attempted) {
      await db.prepare('INSERT INTO absence_notices(student_id,date) VALUES(?,?) ON CONFLICT DO NOTHING')
        .run(student.id, date);
    }
    sent += results.filter((result) => result.sent).length;
  }
  return { checked: absentees.length, sent };
}

module.exports = { notifyParent, sendAbsentNotices, fmt12, normalizePhone, sendEmail };
