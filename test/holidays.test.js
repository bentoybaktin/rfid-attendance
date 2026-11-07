const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DB_FILE = ':memory:';
process.env.ADMIN_EMAIL = 'holiday-admin@example.com';
process.env.ADMIN_PASSWORD = 'test-holiday-admin-password';
process.env.USER_EMAIL = 'holiday-user@example.com';
process.env.USER_PASSWORD = 'test-holiday-user-password';
process.env.DEVICE_KEY = 'test-holiday-device-key';
process.env.AUTH_SECRET = 'test-holiday-auth-secret-with-enough-entropy';

const { app, appReady } = require('../server');
const { db } = require('../db');

test('holiday reason and date ranges are saved, listed, and included in the student display feed', async () => {
  await appReady;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(new URL(path, baseUrl), options);

  try {
    const loginResponse = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const end = new Date(`${date}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    const endDate = end.toISOString().slice(0, 10);

    const addSection = async (section) => request('/api/classes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ grade: 7, section }),
    });
    assert.equal((await addSection('Original Section')).status, 200);
    assert.equal((await addSection('Existing Section')).status, 200);
    const sectionsResponse = await request('/api/classes', { headers });
    const sections = await sectionsResponse.json();
    assert.equal(sections.find((section) => section.section === 'Original Section').student_count, 0);

    await db.prepare(
      'INSERT INTO students(lrn,name,surname,first_name,middle_name,name_extension,grade,section) VALUES(?,?,?,?,?,?,?,?)'
    ).run('987654321012', 'Clear, Student', 'Clear', 'Student', 'CSV', 'Jr.', 7, 'Existing Section');
    const month = date.slice(0, 7);
    const exportQuery = new URLSearchParams({ month, cls: '7::Existing Section' });
    const csvResponse = await request(`/api/export/sf2.csv?${exportQuery}`, { headers });
    assert.equal(csvResponse.status, 200);
    const csv = (await csvResponse.text()).replace(/^\uFEFF/, '');
    assert.match(csv, new RegExp(`Monthly student attendance - ${month}`));
    assert.match(csv, /Section,Grade 7 - Existing Section/);
    assert.match(csv, /"Student name \(surname, first, middle, extension\)"/);
    assert.match(csv, /\d{2} \([A-Z][a-z]{2}\)/);
    assert.match(csv, /1,987654321012,"Clear, Student CSV Jr\.",7,Existing Section/);

    await db.prepare('INSERT INTO students(lrn,name,grade,section) VALUES(?,?,?,?)')
      .run('987654321013', 'Section Test Student', 7, 'Original Section');
    const renamedSection = await request('/api/classes', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ grade: 7, old_section: 'Original Section', section: 'Renamed Section' }),
    });
    assert.equal(renamedSection.status, 200);
    assert.equal(await db.prepare('SELECT section FROM students WHERE lrn=?').get('987654321013')
      .then((student) => student.section), 'Renamed Section');

    const duplicateRename = await request('/api/classes', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ grade: 7, old_section: 'Renamed Section', section: 'Existing Section' }),
    });
    assert.equal(duplicateRename.status, 409);

    const blockedDelete = await request('/api/classes', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ grade: 7, section: 'Renamed Section' }),
    });
    assert.equal(blockedDelete.status, 409);
    assert.match((await blockedDelete.json()).error, /1 active student is assigned.*move the student first/);
    await db.prepare('UPDATE students SET active=0 WHERE lrn=?').run('987654321013');
    const deletedSection = await request('/api/classes', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ grade: 7, section: 'Renamed Section' }),
    });
    assert.equal(deletedSection.status, 200);

    const invalidDate = await request('/api/holidays', {
      method: 'POST',
      headers,
      body: JSON.stringify({ date: '2026-02-31', name: 'Weather suspension', reason: 'Severe flooding' }),
    });
    assert.equal(invalidDate.status, 400);

    const missingReason = await request('/api/holidays', {
      method: 'POST',
      headers,
      body: JSON.stringify({ date, name: 'Weather suspension' }),
    });
    assert.equal(missingReason.status, 400);

    const reversedRange = await request('/api/holidays', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        date: endDate,
        end_date: date,
        name: 'Weather suspension',
        reason: 'Severe flooding',
      }),
    });
    assert.equal(reversedRange.status, 400);

    const oversizedReason = await request('/api/holidays', {
      method: 'POST',
      headers,
      body: JSON.stringify({ date, name: 'Weather suspension', reason: 'x'.repeat(2001) }),
    });
    assert.equal(oversizedReason.status, 400);

    const saved = await request('/api/holidays', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        date,
        end_date: endDate,
        name: ' Weather suspension ',
        reason: '  Severe flooding in the area  ',
      }),
    });
    assert.equal(saved.status, 200);

    const holidaysResponse = await request('/api/holidays', { headers });
    assert.equal(holidaysResponse.status, 200);
    assert.deepEqual((await holidaysResponse.json())[0], {
      date,
      end_date: endDate,
      name: 'Weather suspension',
      reason: 'Severe flooding in the area',
    });
    const { holidaySet } = require('../db');
    const closedDates = await holidaySet();
    assert.ok(closedDates.has(date));
    assert.ok(closedDates.has(endDate));

    const userLoginResponse = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.USER_EMAIL, password: process.env.USER_PASSWORD }),
    });
    assert.equal(userLoginResponse.status, 200);
    const userToken = (await userLoginResponse.json()).token;
    const userLatestResponse = await request('/api/user/latest?after=0', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(userLatestResponse.status, 200);
    assert.deepEqual((await userLatestResponse.json()).holiday, {
      date,
      end_date: endDate,
      name: 'Weather suspension',
      reason: 'Severe flooding in the area',
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await db.close();
  }
});
