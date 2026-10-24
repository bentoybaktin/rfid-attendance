const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DB_FILE = ':memory:';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.EMAIL_FROM = 'Attendance <attendance@example.com>';

const { db, ready, setSetting } = require('../db');
const { notifyParent } = require('../notify');

test.after(async () => {
  await db.close();
});

test('sends and logs consented parent email notifications', async (t) => {
  await ready;
  await setSetting('email_notify_enabled', '1');
  let sentRequest;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sentRequest = { url, options };
    return new Response(JSON.stringify({ id: 'email-test-id' }), { status: 200 });
  });

  const sent = await notifyParent({
    id: 15,
    name: 'Example Student',
    parent_email: 'guardian@example.com',
    email_consent: 1,
    parent_phone: null,
    consent: 0,
  }, 'MORNING_IN', 'late', '08:15', '2026-10-24');

  assert.equal(sent, true);
  assert.equal(sentRequest.url, 'https://api.resend.com/emails');
  assert.equal(sentRequest.options.headers.Authorization, 'Bearer test-resend-key');
  const email = JSON.parse(sentRequest.options.body);
  assert.deepEqual(email.to, ['guardian@example.com']);
  assert.equal(email.from, 'Attendance <attendance@example.com>');
  assert.match(email.subject, /Example Student attendance update/);
  assert.match(email.text, /arrived for morning class \(late\) at 8:15 AM/);

  const log = await db.prepare(
    'SELECT channel,recipient,provider,status FROM notifications WHERE student_id=?'
  ).get(15);
  assert.deepEqual({ ...log }, {
    channel: 'email',
    recipient: 'guardian@example.com',
    provider: 'resend',
    status: 'sent',
  });
});

test('records email provider failures without reporting a successful send', async (t) => {
  await ready;
  await setSetting('email_notify_enabled', '1');
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })
  );

  const sent = await notifyParent({
    id: 16,
    name: 'Another Student',
    parent_email: 'guardian@example.com',
    email_consent: 1,
    parent_phone: null,
    consent: 0,
  }, 'AFTERNOON_OUT', 'present', '15:00', '2026-10-24');

  assert.equal(sent, false);
  const log = await db.prepare(
    'SELECT channel,recipient,provider,status FROM notifications WHERE student_id=?'
  ).get(16);
  assert.deepEqual({ ...log }, {
    channel: 'email',
    recipient: 'guardian@example.com',
    provider: 'resend',
    status: 'failed: Resend email API HTTP 401',
  });
});

test('does not send or log email without parent consent', async (t) => {
  await ready;
  await setSetting('email_notify_enabled', '1');
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Email must not be sent without consent');
  });

  const sent = await notifyParent({
    id: 17,
    name: 'No Consent Student',
    parent_email: 'guardian@example.com',
    email_consent: 0,
    parent_phone: null,
    consent: 0,
  }, 'MORNING_IN', 'present', '08:00', '2026-10-24');

  assert.equal(sent, false);
  const log = await db.prepare('SELECT id FROM notifications WHERE student_id=?').get(17);
  assert.equal(log, undefined);
});
