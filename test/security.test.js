const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'production';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.USER_USERNAME = 'test-user';
process.env.USER_PASSWORD = 'test-user-password';
process.env.DEVICE_KEY = 'test-device-key';
process.env.AUTH_SECRET = 'test-auth-secret-with-enough-entropy-for-tests';

const { app, appReady } = require('../server');

test('security headers, role-based access, and login rate limit', async () => {
  await appReady;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(new URL(path, baseUrl), options);
  const login = async (username, password, rememberMe = false) => {
    const response = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember_me: rememberMe }),
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

    const admin = await login('test-admin', 'test-admin-password');
    assert.equal(admin.response.status, 200);
    assert.equal(admin.response.headers.get('cache-control'), 'no-store');
    const adminClaims = JSON.parse(Buffer.from(admin.body.token.split('.')[0], 'base64url').toString());
    assert.equal(adminClaims.rememberMe, false);
    assert.ok(adminClaims.expiresAt - Date.now() > 11 * 3600 * 1000);
    assert.ok(adminClaims.expiresAt - Date.now() <= 12 * 3600 * 1000);

    const user = await login('test-user', 'test-user-password', true);
    assert.equal(user.response.status, 200);
    const userClaims = JSON.parse(Buffer.from(user.body.token.split('.')[0], 'base64url').toString());
    assert.equal(userClaims.rememberMe, true);
    assert.ok(userClaims.expiresAt - Date.now() > 29 * 24 * 3600 * 1000);
    assert.ok(userClaims.expiresAt - Date.now() <= 30 * 24 * 3600 * 1000);

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

    const malformedJson = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"username":',
    });
    assert.equal(malformedJson.status, 400);
    assert.deepEqual(await malformedJson.json(), { error: 'Invalid JSON request' });

    for (let attempt = 0; attempt < 8; attempt++) {
      const invalid = await login('test-admin', 'incorrect-password');
      assert.equal(invalid.response.status, 401);
    }
    const limited = await login('test-admin', 'incorrect-password');
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get('ratelimit-limit'), '10');
    assert.equal(limited.response.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
