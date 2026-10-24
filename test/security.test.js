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
  const login = async (username, password) => {
    const response = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
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

    const admin = await login('test-admin', 'test-admin-password');
    assert.equal(admin.response.status, 200);
    const user = await login('test-user', 'test-user-password');
    assert.equal(user.response.status, 200);

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
