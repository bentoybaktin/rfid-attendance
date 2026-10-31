const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'production';
process.env.ADMIN_EMAIL = 'test-admin@example.com';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.USER_EMAIL = 'test-user@example.com';
process.env.USER_PASSWORD = 'test-user-password';
process.env.DEVICE_KEY = 'test-device-key';
process.env.AUTH_SECRET = 'test-auth-secret-with-enough-entropy-for-tests';

const { app, appReady } = require('../server');
const { db } = require('../db');

test('security headers, role-based access, and login rate limit', async () => {
  await appReady;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(new URL(path, baseUrl), options);
  const login = async (email, password, rememberMe = false) => {
    const response = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember_me: rememberMe }),
    });
    return { response, body: await response.json() };
  };

  try {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('strict-transport-security'), /max-age=31536000/);

    for (const privateFile of ['/server.js', '/db.js', '/.env', '/data.db']) {
      assert.equal((await request(privateFile)).status, 404, `${privateFile} must not be served`);
    }
    assert.equal((await request('/missing-page')).status, 404);

    const admin = await login('TEST-ADMIN@example.com', 'test-admin-password');
    assert.equal(admin.response.status, 200);
    assert.equal(admin.response.headers.get('cache-control'), 'no-store');
    const adminClaims = JSON.parse(Buffer.from(admin.body.token.split('.')[0], 'base64url').toString());
    assert.equal(adminClaims.rememberMe, false);
    assert.ok(adminClaims.expiresAt - Date.now() > 11 * 3600 * 1000);
    assert.ok(adminClaims.expiresAt - Date.now() <= 12 * 3600 * 1000);

    const user = await login('test-user@example.com', 'test-user-password', true);
    assert.equal(user.response.status, 200);
    const userClaims = JSON.parse(Buffer.from(user.body.token.split('.')[0], 'base64url').toString());
    assert.equal(userClaims.rememberMe, true);
    assert.ok(userClaims.expiresAt - Date.now() > 29 * 24 * 3600 * 1000);
    assert.ok(userClaims.expiresAt - Date.now() <= 30 * 24 * 3600 * 1000);
    const userHeaders = {
      Authorization: `Bearer ${user.body.token}`,
      'Content-Type': 'application/json',
    };

    const adminHeaders = {
      Authorization: `Bearer ${admin.body.token}`,
      'Content-Type': 'application/json',
    };
    const sectionResponse = await request('/api/classes', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ grade: 7, section: 'Email Test' }),
    });
    assert.equal(sectionResponse.status, 200);
    const studentResponse = await request('/api/students', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        lrn: '123456789012',
        surname: 'Test',
        first_name: 'Email',
        grade: 7,
        section: 'Email Test',
        parent_email: 'guardian@example.com',
        email_consent: true,
      }),
    });
    assert.equal(studentResponse.status, 200);
    const student = await studentResponse.json();
    const studentDetailsResponse = await request(`/api/students/${student.id}`, {
      headers: adminHeaders,
    });
    const studentDetails = await studentDetailsResponse.json();
    assert.equal(studentDetails.parent_email, 'guardian@example.com');
    assert.equal(studentDetails.email_consent, 1);

    const unknownUid = 'A1B2C3D4';
    const unknownTap = await request('/api/tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': 'test-device-key' },
      body: JSON.stringify({ uid: unknownUid }),
    });
    assert.equal(unknownTap.status, 404);
    const latestUserEvent = await request('/api/user/latest?after=0&attempt_after=0', {
      headers: userHeaders,
    });
    const latestUserData = await latestUserEvent.json();
    assert.equal(latestUserEvent.status, 200, JSON.stringify(latestUserData));
    assert.equal(latestUserData.latest.code, 'UNKNOWN_CARD');
    assert.equal(latestUserData.latest.uid, unknownUid);

    const hidTap = await request('/api/user/tap', {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ uid: 'B1C2D3E4' }),
    });
    assert.equal(hidTap.status, 404);
    assert.equal((await hidTap.json()).code, 'UNKNOWN_CARD');
    assert.equal((await request('/api/user/tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'B1C2D3E4' }),
    })).status, 401);

    const duplicateStudent = await request('/api/user/students', {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({
        lrn: '123456789014',
        surname: 'Test',
        first_name: 'Email',
        grade: 7,
        section: 'Email Test',
        rfid_uid: unknownUid,
        parent_name: 'Guardian',
      }),
    });
    assert.equal(duplicateStudent.status, 409);
    assert.equal(
      (await duplicateStudent.json()).error,
      "This student is already enrolled. Please contact the admin to update the student's information."
    );

    const invalidEmailResponse = await request('/api/students', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        lrn: '123456789013',
        surname: 'Test',
        first_name: 'Invalid',
        grade: 7,
        section: 'Email Test',
        parent_email: 'not-an-email',
      }),
    });
    assert.equal(invalidEmailResponse.status, 400);
    assert.match((await invalidEmailResponse.json()).error, /valid parent email/i);

    const settingsResponse = await request('/api/settings', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ email_notify_enabled: '1' }),
    });
    assert.equal(settingsResponse.status, 200);
    assert.equal((await settingsResponse.json()).email_notify_enabled, '1');

    assert.equal((await request('/api/students')).status, 401);
    assert.equal((await request('/api/students', {
      headers: { Authorization: `Bearer ${user.body.token}` },
    })).status, 403);
    assert.equal((await request('/api/students/1', {
      headers: { Authorization: `Bearer ${user.body.token}` },
    })).status, 403);
    assert.equal((await request('/api/students/1/attendance?month=2026-10', {
      headers: { Authorization: `Bearer ${user.body.token}` },
    })).status, 403);
    assert.equal((await request('/api/students', {
      headers: { Authorization: `Bearer ${admin.body.token}` },
    })).status, 200);
    const unknownApi = await request('/api/not-a-route', {
      headers: { Authorization: `Bearer ${admin.body.token}` },
    });
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(await unknownApi.json(), { error: 'API endpoint not found' });

    const invalidAccountEmails = await request('/api/accounts', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        current_admin_password: 'test-admin-password',
        admin_email: 'not-an-email',
        user_email: 'staff@example.com',
      }),
    });
    assert.equal(invalidAccountEmails.status, 400);

    const accountEmails = await request('/api/accounts', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        current_admin_password: 'test-admin-password',
        admin_email: 'principal@school.example',
        user_email: 'staff@school.example',
      }),
    });
    assert.equal(accountEmails.status, 200);
    const updatedEmails = await accountEmails.json();
    assert.equal(updatedEmails.admin_email, 'principal@school.example');
    assert.equal(updatedEmails.user_email, 'staff@school.example');
    assert.equal((await login('principal@school.example', 'test-admin-password')).response.status, 200);
    assert.equal((await login('staff@school.example', 'test-user-password')).response.status, 200);

    const malformedJson = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"username":',
    });
    assert.equal(malformedJson.status, 400);
    assert.deepEqual(await malformedJson.json(), { error: 'Invalid JSON request' });

    for (let attempt = 0; attempt < 6; attempt++) {
      const invalid = await login('principal@school.example', 'incorrect-password');
      assert.equal(invalid.response.status, 401);
    }
    const limited = await login('principal@school.example', 'incorrect-password');
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get('ratelimit-limit'), '10');
    assert.equal(limited.response.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);

    await db.prepare(
      'INSERT INTO notifications(kind,date,message,status,provider,ts,channel) VALUES(?,?,?,?,?,?,?)'
    ).run('ARRIVAL', '2026-10-31', 'Test notification', 'sent', 'test', '2026-10-31T08:00:00', 'sms');
    await db.prepare('DELETE FROM login_rate_limits').run();
    const resetAdmin = await login('principal@school.example', 'test-admin-password');
    assert.equal(resetAdmin.response.status, 200);
    const reset = await request('/api/data', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${resetAdmin.body.token}` },
    });
    assert.equal(reset.status, 200);
    const resetResult = await reset.json();
    assert.equal(resetResult.deleted.notifications, 1);
    const notifications = await request('/api/notifications', {
      headers: { Authorization: `Bearer ${resetResult.token}` },
    });
    assert.equal(notifications.status, 200);
    assert.deepEqual(await notifications.json(), []);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
