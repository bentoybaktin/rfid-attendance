const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {
  db,
  ready,
  usePostgres,
  nowManila,
  allSettings,
  getSetting,
  setSetting,
  isAfterTime,
  isValidTime,
  DEFAULTS,
  isSchoolDay,
  schoolDaysBetween,
} = require('./db');
const { processTap } = require('./attendance');
const { computeRisk } = require('./risk');
const { sendAbsentNotices } = require('./notify');

const PORT = process.env.PORT || 3000;
const DEVICE_KEY = process.env.DEVICE_KEY || 'change-me-device-key';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const USER_USERNAME = process.env.USER_USERNAME || 'user';
const USER_PASSWORD = process.env.USER_PASSWORD || 'user1234';

if (process.env.VERCEL) {
  for (const name of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'USER_USERNAME', 'USER_PASSWORD', 'DEVICE_KEY', 'AUTH_SECRET']) {
    if (!process.env[name]) throw new Error(`${name} must be configured for Vercel deployments`);
  }
}
if (!process.env.ADMIN_PASSWORD || !process.env.DEVICE_KEY) {
  console.warn('WARNING: using default ADMIN_PASSWORD / DEVICE_KEY. Set them before real use.');
}
if (!process.env.USER_PASSWORD) {
  console.warn('WARNING: using default USER_PASSWORD. Set it before real use.');
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function initializeAccount(role, username, password) {
  if (await db.prepare('SELECT id FROM auth_users WHERE role=?').get(role)) return;
  const salt = crypto.randomBytes(16).toString('hex');
  await db.prepare('INSERT INTO auth_users(username,role,salt,password_hash) VALUES(?,?,?,?) ON CONFLICT(role) DO NOTHING')
    .run(username, role, salt, passwordHash(password, salt));
}

const appReady = ready.then(async () => {
  await initializeAccount('admin', ADMIN_USERNAME, ADMIN_PASSWORD);
  await initializeAccount('user', USER_USERNAME, USER_PASSWORD);
});

const app = express();
app.use(express.json());

// ---------- auth ----------
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.VERCEL && !process.env.AUTH_SECRET) {
  throw new Error('AUTH_SECRET must be configured for Vercel deployments');
}
const signToken = (account) => {
  const payload = Buffer.from(JSON.stringify({
    userId: account.id,
    role: account.role,
    username: account.username,
    version: crypto.createHash('sha256').update(account.password_hash).digest('hex'),
    expiresAt: Date.now() + 12 * 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};
function readToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest();
  let given;
  try { given = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const auth = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return auth.expiresAt > Date.now() ? auth : null;
  } catch {
    return null;
  }
}
app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const account = await db.prepare('SELECT id,username,role,salt,password_hash FROM auth_users WHERE lower(username)=lower(?)').get(username);
  const given = passwordHash(String(req.body.password || ''), account ? account.salt : 'invalid-account-salt');
  const ok = account && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(account.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  const token = signToken(account);
  res.json({ token, role: account.role, username: account.username });
});

// RFID readers authenticate with a device key instead of the admin login.
app.post('/api/tap', async (req, res) => {
  if (req.get('x-device-key') !== DEVICE_KEY) return res.status(401).json({ error: 'bad device key' });
  let when = null;
  const ts = req.body.ts; // optional: readers replaying taps queued while offline
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ts)) {
    when = { date: ts.slice(0, 10), time: ts.slice(11, 19), ts };
  }
  const r = await processTap(req.body.uid, when);
  res.status(r.http || 200).json(r);
});

app.use('/api', (req, res, next) => {
  (async () => {
    const auth = readToken((req.get('authorization') || '').replace('Bearer ', ''));
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    const account = await db.prepare('SELECT id,username,role,password_hash FROM auth_users WHERE id=? AND role=?').get(auth.userId, auth.role);
    if (!account || account.username !== auth.username ||
        crypto.createHash('sha256').update(account.password_hash).digest('hex') !== auth.version) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.auth = auth;
    if (auth.role !== 'admin' && !(auth.role === 'user' && req.method === 'GET' && req.path === '/user/latest')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  })().catch(next);
});

// ---------- helpers ----------
const csvCell = (c) => {
  c = c == null ? '' : String(c);
  return /[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
};
const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
const sendCsv = (res, name, rows) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(toCsv(rows));
};
const normUid = (u) => String(u || '').replace(/[^0-9a-f]/gi, '').toUpperCase() || null;
const fullStudentName = (student) =>
  student.surname && student.first_name
    ? `${student.surname}, ${student.first_name}${student.middle_name ? ` ${student.middle_name}` : ''}${student.name_extension ? ` ${student.name_extension}` : ''}`
    : student.name;
const displayStudentName = (student) =>
  student.surname && student.first_name
    ? `${student.surname}, ${student.first_name}${student.middle_name ? ` ${student.middle_name.trim().charAt(0).toUpperCase()}.` : ''}${student.name_extension ? ` ${student.name_extension}` : ''}`
    : student.name;

app.get('/api/user/latest', async (req, res) => {
  const afterId = Number(req.query.after) || 0;
  const attemptAfterId = Number(req.query.attempt_after) || 0;
  const afternoonLateTime = await getSetting('afternoon_late_time');
  const [latestScan, latestAttempt, scanCursor, attemptCursor] = await Promise.all([
    db.prepare(
      `SELECT sc.id AS scan_id,s.name,s.lrn,s.grade,s.section,s.surname,s.first_name,
              s.middle_name,s.name_extension,sc.date,sc.ts,sc.type,
              CASE
                WHEN sc.type='MORNING_IN' THEN
                  CASE WHEN sc.ts=(a.date || 'T' || a.morning_in) THEN a.status ELSE 'present' END
                WHEN sc.type='AFTERNOON_IN' AND ?<>'' AND
                  CAST(substr(sc.ts,12,5) AS TEXT)>? THEN 'late'
                ELSE 'present'
              END AS status,
              NULL AS code,NULL AS message
       FROM scans sc
       JOIN students s ON s.id=sc.student_id AND s.active=1
       LEFT JOIN attendance a ON a.student_id=sc.student_id AND a.date=sc.date
       WHERE sc.id>?
       ORDER BY sc.id DESC
       LIMIT 1`
    ).get(afternoonLateTime, afternoonLateTime, afterId),
    db.prepare(
      `SELECT a.id AS attempt_id,a.date,a.ts,a.code,a.message,a.expected_type,a.student_id,
              s.name,s.lrn,s.grade,s.section,s.surname,s.first_name,s.middle_name,s.name_extension
       FROM scan_attempts a
       LEFT JOIN students s ON s.id=a.student_id
       WHERE a.id>?
       ORDER BY a.id DESC
       LIMIT 1`
    ).get(attemptAfterId),
    db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM scans').get(),
    db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM scan_attempts').get(),
  ]);
  let latest = latestScan;
  if (latestAttempt && (!latest || latestAttempt.ts >= latest.ts)) {
    latest = { ...latestAttempt, scan_id: null, type: null };
  }
  if (latest && latest.name) {
    latest.display_name = displayStudentName(latest);
    latest.full_name = fullStudentName(latest);
  }
  res.json({
    school_name: (await allSettings()).school_name,
    latest,
    scan_cursor: Number(scanCursor.id),
    attempt_cursor: Number(attemptCursor.id),
  });
});

app.put('/api/account', async (req, res) => {
  const account = await db.prepare('SELECT * FROM auth_users WHERE id=? AND role=?').get(req.auth.userId, 'admin');
  if (!account) return res.status(404).json({ error: 'Admin account not found' });

  const currentPassword = String(req.body.current_password || '');
  const currentHash = passwordHash(currentPassword, account.salt);
  if (!crypto.timingSafeEqual(Buffer.from(currentHash), Buffer.from(account.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const username = String(req.body.username || '').trim();
  const newPassword = String(req.body.new_password || '');
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters using letters, numbers, dot, underscore or hyphen' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const existing = await db.prepare('SELECT id FROM auth_users WHERE lower(username)=lower(?) AND id<>?').get(username, account.id);
  if (existing) return res.status(409).json({ error: 'That username is already in use' });

  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = passwordHash(newPassword, salt);
  await db.prepare('UPDATE auth_users SET username=?,salt=?,password_hash=? WHERE id=?')
    .run(username, salt, password_hash, account.id);

  const token = signToken({ id: account.id, role: 'admin', username, password_hash });
  res.json({ token, username });
});

app.put('/api/account/user-password', async (req, res) => {
  const admin = await db.prepare('SELECT id,salt,password_hash FROM auth_users WHERE id=? AND role=?')
    .get(req.auth.userId, 'admin');
  if (!admin) return res.status(404).json({ error: 'Admin account not found' });

  const currentPassword = String(req.body.current_password || '');
  const currentHash = passwordHash(currentPassword, admin.salt);
  if (!crypto.timingSafeEqual(Buffer.from(currentHash), Buffer.from(admin.password_hash))) {
    return res.status(400).json({ error: 'Current admin password is incorrect' });
  }

  const newPassword = String(req.body.new_password || '');
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = await db.prepare('SELECT id FROM auth_users WHERE role=?').get('user');
  if (!user) return res.status(404).json({ error: 'User account not found' });

  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = passwordHash(newPassword, salt);
  await db.prepare('UPDATE auth_users SET salt=?,password_hash=? WHERE id=?')
    .run(salt, password_hash, user.id);

  res.json({ ok: true });
});

app.get('/api/accounts', async (req, res) => {
  const accounts = await db.prepare('SELECT role,username FROM auth_users WHERE role IN (?,?)')
    .all('admin', 'user');
  const usernames = Object.fromEntries(accounts.map((account) => [`${account.role}_username`, account.username]));
  if (!usernames.admin_username || !usernames.user_username) {
    return res.status(404).json({ error: 'Admin or user account not found' });
  }
  res.json(usernames);
});

app.put('/api/accounts', async (req, res) => {
  const admin = await db.prepare('SELECT id,username,salt,password_hash FROM auth_users WHERE id=? AND role=?')
    .get(req.auth.userId, 'admin');
  if (!admin) return res.status(404).json({ error: 'Admin account not found' });

  const currentPassword = String(req.body.current_admin_password || '');
  const currentHash = passwordHash(currentPassword, admin.salt);
  if (!crypto.timingSafeEqual(Buffer.from(currentHash), Buffer.from(admin.password_hash))) {
    return res.status(400).json({ error: 'Current admin password is incorrect' });
  }

  const adminUsername = String(req.body.admin_username || '').trim();
  const userUsername = String(req.body.user_username || '').trim();
  const adminNewPassword = String(req.body.admin_new_password || '');
  const userNewPassword = String(req.body.user_new_password || '');
  for (const username of [adminUsername, userUsername]) {
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Usernames must be 3-32 characters using letters, numbers, dot, underscore or hyphen' });
    }
  }
  if (adminUsername.toLowerCase() === userUsername.toLowerCase()) {
    return res.status(400).json({ error: 'Admin and user usernames must be different' });
  }
  for (const password of [adminNewPassword, userNewPassword]) {
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'New passwords must be at least 8 characters' });
    }
  }

  const user = await db.prepare('SELECT id,salt,password_hash FROM auth_users WHERE role=?').get('user');
  if (!user) return res.status(404).json({ error: 'User account not found' });

  const adminSalt = adminNewPassword ? crypto.randomBytes(16).toString('hex') : admin.salt;
  const adminPasswordHash = adminNewPassword ? passwordHash(adminNewPassword, adminSalt) : admin.password_hash;
  const userSalt = userNewPassword ? crypto.randomBytes(16).toString('hex') : user.salt;
  const userPasswordHash = userNewPassword ? passwordHash(userNewPassword, userSalt) : user.password_hash;
  const temporaryAdminUsername = `tmpadmin_${crypto.randomBytes(12).toString('hex')}`;
  const temporaryUserUsername = `tmpuser_${crypto.randomBytes(12).toString('hex')}`;
  await db.transaction(async () => {
    await db.prepare('UPDATE auth_users SET username=? WHERE id=?').run(temporaryAdminUsername, admin.id);
    await db.prepare('UPDATE auth_users SET username=? WHERE id=?').run(temporaryUserUsername, user.id);
    await db.prepare('UPDATE auth_users SET username=?,salt=?,password_hash=? WHERE id=?')
      .run(adminUsername, adminSalt, adminPasswordHash, admin.id);
    await db.prepare('UPDATE auth_users SET username=?,salt=?,password_hash=? WHERE id=?')
      .run(userUsername, userSalt, userPasswordHash, user.id);
  });

  const token = signToken({ id: admin.id, role: 'admin', username: adminUsername, password_hash: adminPasswordHash });
  res.json({ token, admin_username: adminUsername, user_username: userUsername });
});

app.delete('/api/data', async (req, res) => {
  if (!usePostgres) await db.pragma('secure_delete = ON');
  const deleted = await db.transaction(async () => {
    const deleted = {};
    for (const table of [
      'students',
      'attendance',
      'scans',
      'scan_attempts',
      'tap_state',
      'unknown_scans',
      'notifications',
      'absence_notices',
      'holidays',
      'sections',
      'settings',
      'auth_users',
    ]) {
      deleted[table] = Number((await db.prepare(`DELETE FROM ${table}`).run()).changes);
    }
    if (!usePostgres) await db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('students','scans','scan_attempts','notifications','auth_users')").run();
    await initializeAccount('admin', ADMIN_USERNAME, ADMIN_PASSWORD);
    await initializeAccount('user', USER_USERNAME, USER_PASSWORD);
    return deleted;
  });

  let vacuumed = false;
  let walTruncated = false;
  if (!usePostgres) {
    await db.exec('VACUUM');
    const checkpoint = await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw new Error('Database was cleared, but its write-ahead log could not be truncated');
    vacuumed = true;
    walTruncated = true;
  }
  const admin = await db.prepare('SELECT id,username,role,password_hash FROM auth_users WHERE role=?').get('admin');
  const token = signToken(admin);
  res.json({ ok: true, deleted, token, username: admin.username, vacuumed, wal_truncated: walTruncated });
});

// ---------- settings & holidays ----------
app.get('/api/settings', async (req, res) => res.json(await allSettings()));
app.put('/api/settings', async (req, res) => {
  if (req.body.late_time !== undefined && !isValidTime(req.body.late_time)) {
    return res.status(400).json({ error: 'Late cutoff must be a valid 24-hour time (HH:MM)' });
  }
  const scheduleKeys = [
    'morning_late_time',
    'morning_end_time',
    'afternoon_late_time',
    'afternoon_end_time',
  ];
  if (scheduleKeys.some((key) => req.body[key] !== undefined)) {
    const current = await allSettings();
    const schedule = Object.fromEntries(scheduleKeys.map((key) => [key, req.body[key] ?? current[key]]));
    if (Object.values(schedule).some((time) => !isValidTime(time))) {
      return res.status(400).json({ error: 'Set all four class times before saving the attendance schedule' });
    }
    const orderedTimes = scheduleKeys.map((key) => schedule[key].slice(0, 5));
    if (!(orderedTimes[0] < orderedTimes[1] &&
          orderedTimes[1] < orderedTimes[2] &&
          orderedTimes[2] < orderedTimes[3])) {
      return res.status(400).json({
        error: 'Times must be ordered: morning late cutoff, morning finish, afternoon late cutoff, afternoon finish',
      });
    }
  }
  await db.transaction(async () => {
    for (const k of Object.keys(DEFAULTS)) {
      if (req.body[k] !== undefined) await setSetting(k, req.body[k]);
    }
  });
  res.json(await allSettings());
});
app.get('/api/holidays', async (req, res) =>
  res.json(await db.prepare('SELECT * FROM holidays ORDER BY date DESC').all())
);
app.post('/api/holidays', async (req, res) => {
  const { date, name } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Invalid date' });
  await db.prepare('INSERT INTO holidays(date,name) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET name=excluded.name').run(date, name || 'Holiday');
  res.json({ ok: true });
});
app.delete('/api/holidays/:date', async (req, res) => {
  await db.prepare('DELETE FROM holidays WHERE date=?').run(req.params.date);
  res.json({ ok: true });
});

// ---------- students ----------
app.get('/api/classes', async (req, res) =>
  res.json(
    await db
      .prepare('SELECT grade, section FROM sections ORDER BY grade, section')
      .all()
  )
);
app.post('/api/classes', async (req, res) => {
  const grade = Number(req.body.grade);
  const section = String(req.body.section || '').trim();
  if (!Number.isInteger(grade) || grade < 7 || grade > 12) {
    return res.status(400).json({ error: 'Grade must be between 7 and 12' });
  }
  if (!section || section.length > 100 || section.includes('::')) {
    return res.status(400).json({ error: 'Enter a section name up to 100 characters' });
  }
  try {
    await db.prepare('INSERT INTO sections(grade,section) VALUES(?,?)').run(grade, section);
    res.json({ ok: true });
  } catch (error) {
    if (error.errcode === 1555 || error.errcode === 2067 || error.code === '23505') {
      return res.status(409).json({ error: 'That grade and section already exists' });
    }
    throw error;
  }
});
app.get('/api/students', async (req, res) =>
  res.json((await db.prepare('SELECT * FROM students WHERE active=1 ORDER BY grade, section, surname, first_name, name').all())
    .map((student) => ({
      ...student,
      display_name: displayStudentName(student),
      full_name: fullStudentName(student),
    }))
  )
);

async function readStudent(body) {
  const surname = String(body.surname || '').trim();
  const first_name = String(body.first_name || '').trim();
  const middle_name = String(body.middle_name || '').trim() || null;
  const name_extension = String(body.name_extension || '').trim() || null;
  const name = `${surname}, ${first_name}${middle_name ? ` ${middle_name.charAt(0).toUpperCase()}.` : ''}${name_extension ? ` ${name_extension}` : ''}`;
  const s = {
    lrn: (body.lrn || '').trim() || null,
    name,
    surname,
    first_name,
    middle_name,
    name_extension,
    grade: parseInt(body.grade, 10),
    section: (body.section || '').trim(),
    rfid_uid: normUid(body.rfid_uid),
    parent_name: (body.parent_name || '').trim() || null,
    parent_phone: (body.parent_phone || '').replace(/[^0-9+]/g, '') || null,
    consent: body.consent ? 1 : 0,
  };
  if (!surname || !first_name || !s.grade || !s.section) return { error: 'Surname, first name, grade and section are required' };
  if (surname.length > 100 || first_name.length > 100 || (middle_name && middle_name.length > 100) || (name_extension && name_extension.length > 30)) {
    return { error: 'Name fields are too long' };
  }
  if (s.grade < 7 || s.grade > 12) return { error: 'Grade must be between 7 and 12' };
  if (!await db.prepare('SELECT 1 FROM sections WHERE grade=? AND section=?').get(s.grade, s.section)) {
    return { error: 'Choose an existing grade and section' };
  }
  return { s };
}

app.post('/api/students', async (req, res) => {
  const { s, error } = await readStudent(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const r = await db
      .prepare(
        `INSERT INTO students(lrn,name,surname,first_name,middle_name,name_extension,grade,section,rfid_uid,parent_name,parent_phone,consent)
         VALUES(@lrn,@name,@surname,@first_name,@middle_name,@name_extension,@grade,@section,@rfid_uid,@parent_name,@parent_phone,@consent)
         RETURNING id`
      )
      .get(s);
    if (s.rfid_uid) await db.prepare('DELETE FROM unknown_scans WHERE uid=?').run(s.rfid_uid);
    res.json({ id: Number(r.id) });
  } catch (e) {
    if (e.code !== '23505' && e.errcode !== 1555 && e.errcode !== 2067) throw e;
    res.status(400).json({ error: 'LRN or RFID card is already assigned to another student' });
  }
});

app.delete('/api/students', async (req, res) => {
  const { ids } = req.body;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1)
  ) {
    return res.status(400).json({ error: 'Select at least one valid student' });
  }

  const uniqueIds = [...new Set(ids)];
  const removeSelected = await db.transaction(async () => {
    let removed = 0;
    for (const id of uniqueIds) {
      removed += Number((await db.prepare('UPDATE students SET active=0, rfid_uid=NULL WHERE id=? AND active=1').run(id)).changes);
    }
    return removed;
  });

  res.json({ removed });
});

app.put('/api/students/:id', async (req, res) => {
  const { s, error } = await readStudent(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await db.prepare(
      `UPDATE students SET lrn=@lrn,name=@name,surname=@surname,first_name=@first_name,middle_name=@middle_name,name_extension=@name_extension,
       grade=@grade,section=@section,rfid_uid=@rfid_uid,
       parent_name=@parent_name,parent_phone=@parent_phone,consent=@consent WHERE id=@id`
    ).run({ ...s, id: req.params.id });
    if (s.rfid_uid) await db.prepare('DELETE FROM unknown_scans WHERE uid=?').run(s.rfid_uid);
    res.json({ ok: true });
  } catch (e) {
    if (e.code !== '23505' && e.errcode !== 1555 && e.errcode !== 2067) throw e;
    res.status(400).json({ error: 'LRN or RFID card is already assigned to another student' });
  }
});

// Deactivate (keeps attendance history) and free the card for reuse.
app.delete('/api/students/:id', async (req, res) => {
  await db.prepare('UPDATE students SET active=0, rfid_uid=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/unknown', async (req, res) =>
  res.json(await db.prepare('SELECT * FROM unknown_scans ORDER BY ts DESC LIMIT 5').all())
);

// ---------- live data ----------
app.get('/api/feed', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const afternoonLateTime = await getSetting('afternoon_late_time');
  res.json(
    await db
      .prepare(
        `SELECT sc.id, sc.ts, sc.type, s.name, s.grade, s.section,
                CASE
                  WHEN sc.type='MORNING_IN' AND sc.ts=(a.date || 'T' || a.morning_in) THEN a.status
                  WHEN sc.type='AFTERNOON_IN' AND ?<>'' AND
                    CAST(substr(sc.ts,12,5) AS TEXT)>? THEN 'late'
                  ELSE 'present'
                END AS status
         FROM scans sc
         JOIN students s ON s.id=sc.student_id
         LEFT JOIN attendance a ON a.student_id=sc.student_id AND a.date=sc.date
         ORDER BY sc.ts DESC, sc.id DESC LIMIT ?`
      )
      .all(afternoonLateTime, afternoonLateTime, limit)
  );
});

app.get('/api/scan-attempts', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  res.json(await db.prepare(
    `SELECT a.id,a.ts,a.date,a.code,a.message,a.expected_type,s.name,s.grade,s.section
     FROM scan_attempts a
     LEFT JOIN students s ON s.id=a.student_id
     ORDER BY a.ts DESC,a.id DESC LIMIT ?`
  ).all(limit));
});

app.delete('/api/feed', async (req, res) => {
  const [scans, attempts] = await Promise.all([
    db.prepare('DELETE FROM scans').run(),
    db.prepare('DELETE FROM scan_attempts').run(),
  ]);
  res.json({ ok: true, deleted: Number(scans.changes) + Number(attempts.changes) });
});

app.get('/api/today', async (req, res) => {
  const { date } = nowManila();
  const students = await db.prepare('SELECT id, grade, section FROM students WHERE active=1').all();
  const attendanceRows = await db.prepare('SELECT * FROM attendance WHERE date=?').all(date);
  const att = new Map(attendanceRows.map((a) => [a.student_id, a]));
  const blank = () => ({ enrolled: 0, present: 0, late: 0, notIn: 0, inCampus: 0 });
  const total = blank();
  const byClass = {};
  const current = nowManila();
  const morningEnd = await getSetting('morning_end_time');
  const afternoonEnd = await getSetting('afternoon_end_time');
  const afternoonLate = await getSetting('afternoon_late_time');
  for (const s of students) {
    const key = `${s.grade}::${s.section}`;
    const c = (byClass[key] = byClass[key] || { grade: s.grade, section: s.section, ...blank() });
    const a = att.get(s.id);
    for (const t of [total, c]) {
      t.enrolled++;
      if (!a) t.notIn++;
      else {
        const late = a.status === 'late' ||
          (a.afternoon_in && afternoonLate && isAfterTime(a.afternoon_in, afternoonLate));
        if (late) t.late++;
        else t.present++;
        const inMorning = morningEnd && current.time < morningEnd;
        const inAfternoon = morningEnd && afternoonEnd && current.time >= morningEnd && current.time < afternoonEnd;
        if ((inMorning && a.morning_in && !a.morning_out) ||
            (inAfternoon && a.afternoon_in && !a.afternoon_out)) t.inCampus++;
      }
    }
  }
  res.json({
    date,
    schoolDay: await isSchoolDay(date),
    total,
    classes: Object.values(byClass).sort((a, b) => a.grade - b.grade || a.section.localeCompare(b.section)),
  });
});

function parseClass(cls) {
  if (!cls) return null;
  const [grade, section] = String(cls).split('::');
  return { grade: parseInt(grade, 10), section };
}

app.get('/api/attendance', async (req, res) => {
  const date = req.query.date || nowManila().date;
  const c = parseClass(req.query.cls);
  const rows = await db
    .prepare(
      `SELECT s.id, s.lrn, s.name, s.surname, s.first_name, s.middle_name, s.name_extension,
              s.grade, s.section, a.time_in, a.time_out,
              a.morning_in,a.morning_out,a.afternoon_in,a.afternoon_out
       FROM students s
       LEFT JOIN attendance a ON a.student_id=s.id AND a.date=?
       WHERE s.active=1 ${c ? 'AND s.grade=? AND s.section=?' : ''}
       ORDER BY s.grade, s.section, s.name`
    )
    .all(...(c ? [date, c.grade, c.section] : [date]));
  const legacyLateTime = await getSetting('late_time');
  const morningLateTime = await getSetting('morning_late_time') || legacyLateTime;
  const afternoonLateTime = await getSetting('afternoon_late_time');
  const attendanceRows = rows.map((row) => ({
    ...row,
    display_name: displayStudentName(row),
    full_name: fullStudentName(row),
    status: row.time_in ? (isAfterTime(row.time_in, morningLateTime) ? 'late' : 'present') : 'absent',
    morning_status: row.morning_in
      ? (isAfterTime(row.morning_in, morningLateTime) ? 'late' : 'present')
      : 'absent',
    afternoon_status: row.afternoon_in
      ? (afternoonLateTime && isAfterTime(row.afternoon_in, afternoonLateTime) ? 'late' : 'present')
      : 'not recorded',
  }));
  res.json({ date, schoolDay: await isSchoolDay(date), rows: attendanceRows });
});

app.get('/api/students/:id/attendance', async (req, res) => {
  const id = Number(req.params.id);
  const month = String(req.query.month || '');
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid student id' });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Month must use YYYY-MM format' });

  const student = await db.prepare(
    'SELECT id,lrn,name,surname,first_name,middle_name,name_extension,grade,section FROM students WHERE id=? AND active=1'
  ).get(id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  student.full_name = fullStudentName(student);
  student.display_name = displayStudentName(student);

  const [year, monthNumber] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const today = nowManila().date;
  const attendanceRows = await db.prepare(
    'SELECT date,time_in,time_out,morning_in,morning_out,afternoon_in,afternoon_out FROM attendance WHERE student_id=? AND date BETWEEN ? AND ?'
  )
    .all(id, monthStart, monthEnd);
  const attendance = new Map(attendanceRows.map((row) => [row.date, row]));
  const holidayRows = await db.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?')
    .all(monthStart, monthEnd);
  const holidays = new Set(holidayRows.map((row) => row.date));
  const cutoff = await getSetting('morning_late_time') || await getSetting('late_time');
  const totals = { present: 0, late: 0, absent: 0 };
  const days = [];

  for (let day = 1; day <= Number(monthEnd.slice(-2)); day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    let status;
    if (!await isSchoolDay(date, holidays)) status = 'no class';
    else if (date > today) status = 'upcoming';
    else {
      const dayAttendance = attendance.get(date);
      const timeIn = dayAttendance && (dayAttendance.morning_in || dayAttendance.time_in);
      if (!timeIn) status = 'absent';
      else status = isAfterTime(timeIn, cutoff) ? 'late' : 'present';
      totals[status]++;
    }
    const dayAttendance = attendance.get(date) || {};
    days.push({
      date,
      weekday: new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
      status,
      morning_in: dayAttendance.morning_in || dayAttendance.time_in || null,
      morning_out: dayAttendance.morning_out || dayAttendance.time_out || null,
      afternoon_in: dayAttendance.afternoon_in || null,
      afternoon_out: dayAttendance.afternoon_out || null,
    });
  }

  res.json({ student, month, totals, days });
});

// ---------- actions ----------
app.post('/api/simulate', async (req, res) => {
  const s = await db.prepare('SELECT rfid_uid FROM students WHERE id=? AND active=1').get(req.body.student_id);
  if (!s || !s.rfid_uid) return res.status(400).json({ error: 'Student has no RFID card assigned' });
  const r = await processTap(s.rfid_uid);
  res.status(200).json(r);
});

app.post('/api/notify-absent', async (req, res) => {
  const { date } = nowManila();
  if (!await isSchoolDay(date)) return res.status(400).json({ error: 'Today is not a school day' });
  res.json(await sendAbsentNotices(date));
});

app.get('/api/notifications', async (req, res) =>
  res.json(
    await db
      .prepare(
        `SELECT n.*, s.name FROM notifications n LEFT JOIN students s ON s.id=n.student_id
         ORDER BY n.id DESC LIMIT 200`
      )
      .all()
  )
);

app.delete('/api/notifications', async (req, res) => {
  const result = await db.prepare('DELETE FROM notifications').run();
  res.json({ ok: true, deleted: Number(result.changes) });
});

// ---------- early warning ----------
function requestedRiskMonth(req, res) {
  const currentMonth = nowManila().date.slice(0, 7);
  const month = String(req.query.month || currentMonth);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > currentMonth) {
    res.status(400).json({ error: 'Month must be a valid YYYY-MM not later than the current month' });
    return null;
  }
  return month;
}

app.get('/api/risk', async (req, res) => {
  const month = requestedRiskMonth(req, res);
  if (month) res.json(await computeRisk(month));
});
app.get('/api/export/risk.csv', async (req, res) => {
  const month = requestedRiskMonth(req, res);
  if (!month) return;
  const report = await computeRisk(month);
  const rows = [
    [`Early warning - ${month} (${report.days} school days)`],
    ['Level', 'Score', 'LRN', 'Name', 'Grade', 'Section', 'Absences', 'Lates', 'Consecutive absences', 'Attendance %', 'Why flagged', 'Suggested action', 'Parent', 'Phone'],
  ];
  for (const r of report.rows.filter((x) => x.level !== 'low'))
    rows.push([r.level.toUpperCase(), r.score, r.lrn, r.name, r.grade, r.section, r.absences, r.lates, r.streak, r.attendance_rate, r.reasons.join('; '), r.action, r.parent_name, r.parent_phone]);
  sendCsv(res, `early-warning-${month}.csv`, rows);
});

// ---------- SF2-style monthly export ----------
// Layout inspired by DepEd School Form 2 (daily attendance). Review before official use.
app.get('/api/export/sf2.csv', async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : nowManila().date.slice(0, 7);
  const c = parseClass(req.query.cls);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = await schoolDaysBetween(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
  const students = await db
    .prepare(
      `SELECT * FROM students WHERE active=1 ${c ? 'AND grade=? AND section=?' : ''} ORDER BY grade, section, name`
    )
    .all(...(c ? [c.grade, c.section] : []));
  const att = new Map();
  for (const a of await db
    .prepare('SELECT student_id, date, status FROM attendance WHERE date LIKE ?')
    .all(month + '-%'))
    att.set(a.student_id + '|' + a.date, a.status);

  const today = nowManila().date;
  const rows = [
    [`School Form 2 (style) - Daily attendance - ${month}`],
    ['Legend: blank = present, L = late (counted present), x = absent'],
    ['LRN', 'Name', 'Grade', 'Section', ...days.map((d) => Number(d.slice(8))), 'Days present', 'Days late', 'Days absent'],
  ];
  for (const s of students) {
    let present = 0, late = 0, absent = 0;
    const cells = days.map((d) => {
      if (d > today) return '';
      const st = att.get(s.id + '|' + d);
      if (!st) { absent++; return 'x'; }
      present++;
      if (st === 'late') { late++; return 'L'; }
      return '';
    });
    rows.push([s.lrn, s.name, s.grade, s.section, ...cells, present, late, absent]);
  }
  sendCsv(res, `sf2-${month}.csv`, rows);
});

// ---------- static dashboard ----------
app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  appReady.then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`RFID attendance running on http://localhost:${PORT}`);
    });
  }).catch((error) => {
    console.error('Failed to initialize the database:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, appReady };
