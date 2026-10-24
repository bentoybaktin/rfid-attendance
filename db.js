const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('@neondatabase/serverless');

const transactionContext = new AsyncLocalStorage();
const usePostgres = Boolean(process.env.DATABASE_URL);
if (process.env.VERCEL && !usePostgres) {
  throw new Error('DATABASE_URL must be configured for Vercel deployments; SQLite storage is temporary there');
}
let sqlite;
let pool;
let queue = Promise.resolve();

function acquireLocalLock() {
  const previous = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  return previous.then(() => release);
}

function postgresQuery(query, args) {
  if (args.length === 1 && args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object') {
    const values = [];
    const indexes = new Map();
    query = query.replace(/@([A-Za-z_]\w*)/g, (_match, name) => {
      if (!indexes.has(name)) {
        values.push(args[0][name]);
        indexes.set(name, values.length - 1);
      }
      const index = indexes.get(name);
      return `$${index + 1}`;
    });
    args = [values];
  } else {
    let index = 0;
    query = query.replace(/\?/g, () => `$${++index}`);
  }
  const ignoreConflict = /^\s*INSERT OR IGNORE INTO/i.test(query);
  query = query.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
  if (ignoreConflict && !/\bON CONFLICT\b/i.test(query)) {
    query += ' ON CONFLICT DO NOTHING';
  }
  return { query, args: args.length === 1 && Array.isArray(args[0]) ? args[0] : args };
}

function getClient() {
  return transactionContext.getStore() || pool;
}

const db = {
  prepare(sql) {
    if (!usePostgres) {
      const statement = sqlite.prepare(sql);
      return {
        get: async (...args) => {
          if (transactionContext.getStore() === sqlite) return statement.get(...args);
          const release = await acquireLocalLock();
          try { return statement.get(...args); } finally { release(); }
        },
        all: async (...args) => {
          if (transactionContext.getStore() === sqlite) return statement.all(...args);
          const release = await acquireLocalLock();
          try { return statement.all(...args); } finally { release(); }
        },
        run: async (...args) => {
          if (transactionContext.getStore() === sqlite) return statement.run(...args);
          const release = await acquireLocalLock();
          try { return statement.run(...args); } finally { release(); }
        },
      };
    }
    return {
      get: async (...args) => {
        const { query, args: values } = postgresQuery(sql, args);
        const result = await getClient().query(query, values);
        return result.rows[0];
      },
      all: async (...args) => {
        const { query, args: values } = postgresQuery(sql, args);
        const result = await getClient().query(query, values);
        return result.rows;
      },
      run: async (...args) => {
        const { query, args: values } = postgresQuery(sql, args);
        const result = await getClient().query(query, values);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
      },
    };
  },
  async transaction(fn) {
    if (!usePostgres) {
      const release = await acquireLocalLock();
      try {
        sqlite.exec('BEGIN');
        try {
          const result = await transactionContext.run(sqlite, fn);
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      } finally {
        release();
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionContext.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  async exec(sql) {
    if (!usePostgres) return sqlite.exec(sql);
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await getClient().query(statement);
    }
  },
  pragma(sql) {
    if (usePostgres) return Promise.resolve();
    return sqlite.exec('PRAGMA ' + sql);
  },
  async close() {
    if (usePostgres) await pool.end();
    else sqlite.close();
  },
};

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS students(
  id SERIAL PRIMARY KEY, lrn TEXT UNIQUE, name TEXT NOT NULL, surname TEXT,
  first_name TEXT, middle_name TEXT, name_extension TEXT, grade INTEGER NOT NULL,
  section TEXT NOT NULL, rfid_uid TEXT UNIQUE, parent_name TEXT, parent_phone TEXT,
  consent INTEGER DEFAULT 0, parent_email TEXT, email_consent INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_email TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS email_consent INTEGER DEFAULT 0;
CREATE TABLE IF NOT EXISTS scans(
  id SERIAL PRIMARY KEY, student_id INTEGER NOT NULL, uid TEXT, ts TEXT NOT NULL,
  date TEXT NOT NULL, type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tap_state(
  student_id INTEGER NOT NULL, date TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL,
  PRIMARY KEY(student_id, date)
);
CREATE TABLE IF NOT EXISTS attendance(
  student_id INTEGER NOT NULL, date TEXT NOT NULL, time_in TEXT, time_out TEXT,
  status TEXT NOT NULL, morning_in TEXT, morning_out TEXT, afternoon_in TEXT, afternoon_out TEXT,
  PRIMARY KEY(student_id, date)
);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS morning_in TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS morning_out TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS afternoon_in TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS afternoon_out TEXT;
UPDATE attendance SET morning_in=time_in WHERE morning_in IS NULL AND time_in IS NOT NULL;
UPDATE attendance SET morning_out=time_out WHERE morning_out IS NULL AND time_out IS NOT NULL;
CREATE TABLE IF NOT EXISTS unknown_scans(uid TEXT PRIMARY KEY, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scan_attempts(
  id SERIAL PRIMARY KEY, student_id INTEGER, uid TEXT, ts TEXT NOT NULL, date TEXT NOT NULL,
  code TEXT NOT NULL, message TEXT NOT NULL, expected_type TEXT
);
ALTER TABLE scan_attempts ADD COLUMN IF NOT EXISTS expected_type TEXT;
CREATE TABLE IF NOT EXISTS notifications(
  id SERIAL PRIMARY KEY, student_id INTEGER, kind TEXT, date TEXT, phone TEXT,
  message TEXT, status TEXT, provider TEXT, ts TEXT, channel TEXT DEFAULT 'sms', recipient TEXT
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'sms';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient TEXT;
CREATE TABLE IF NOT EXISTS absence_notices(
  student_id INTEGER NOT NULL, date TEXT NOT NULL, PRIMARY KEY(student_id, date)
);
CREATE TABLE IF NOT EXISTS holidays(date TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS sections(grade INTEGER NOT NULL, section TEXT NOT NULL, PRIMARY KEY(grade, section));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS auth_users(
  id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL UNIQUE
    CHECK(role IN ('admin','user')), salt TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_recovery(
  id INTEGER PRIMARY KEY CHECK(id=1),
  question1 TEXT NOT NULL, salt1 TEXT NOT NULL, answer_hash1 TEXT NOT NULL,
  question2 TEXT NOT NULL, salt2 TEXT NOT NULL, answer_hash2 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_challenges(
  token_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_rate_limits(
  ip_hash TEXT PRIMARY KEY, window_start BIGINT NOT NULL, request_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_rate_limits(
  ip_hash TEXT PRIMARY KEY, window_start BIGINT NOT NULL, request_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scans_student ON scans(student_id, ts);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
INSERT INTO sections(grade,section) SELECT DISTINCT grade,section FROM students ON CONFLICT DO NOTHING;
INSERT INTO tap_state(student_id,date,ts,type)
 SELECT DISTINCT ON (student_id,date) student_id,date,ts,type FROM scans
 ORDER BY student_id,date,ts DESC,id DESC ON CONFLICT DO NOTHING;
INSERT INTO absence_notices(student_id,date)
 SELECT student_id,date FROM notifications WHERE kind='ABSENT' AND student_id IS NOT NULL
 ON CONFLICT DO NOTHING;
`;

let ready;
if (usePostgres) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  ready = db.exec(POSTGRES_SCHEMA);
} else {
  sqlite = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'data.db'));
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS students(
      id INTEGER PRIMARY KEY AUTOINCREMENT, lrn TEXT UNIQUE, name TEXT NOT NULL,
      surname TEXT, first_name TEXT, middle_name TEXT, name_extension TEXT,
      grade INTEGER NOT NULL, section TEXT NOT NULL, rfid_uid TEXT UNIQUE,
      parent_name TEXT, parent_phone TEXT, consent INTEGER DEFAULT 0,
      parent_email TEXT, email_consent INTEGER DEFAULT 0, active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL,uid TEXT,ts TEXT NOT NULL,date TEXT NOT NULL,type TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tap_state(student_id INTEGER NOT NULL,date TEXT NOT NULL,ts TEXT NOT NULL,type TEXT NOT NULL,PRIMARY KEY(student_id,date));
    CREATE TABLE IF NOT EXISTS attendance(student_id INTEGER NOT NULL,date TEXT NOT NULL,time_in TEXT,time_out TEXT,status TEXT NOT NULL,morning_in TEXT,morning_out TEXT,afternoon_in TEXT,afternoon_out TEXT,PRIMARY KEY(student_id,date));
    CREATE TABLE IF NOT EXISTS unknown_scans(uid TEXT PRIMARY KEY,ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scan_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER,uid TEXT,ts TEXT NOT NULL,date TEXT NOT NULL,code TEXT NOT NULL,message TEXT NOT NULL,expected_type TEXT);
    CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER,kind TEXT,date TEXT,phone TEXT,message TEXT,status TEXT,provider TEXT,ts TEXT,channel TEXT DEFAULT 'sms',recipient TEXT);
    CREATE TABLE IF NOT EXISTS absence_notices(student_id INTEGER NOT NULL,date TEXT NOT NULL,PRIMARY KEY(student_id,date));
    CREATE TABLE IF NOT EXISTS holidays(date TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE IF NOT EXISTS sections(grade INTEGER NOT NULL,section TEXT NOT NULL,PRIMARY KEY(grade,section));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS auth_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE COLLATE NOCASE,role TEXT NOT NULL UNIQUE CHECK(role IN ('admin','user')),salt TEXT NOT NULL,password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_recovery(id INTEGER PRIMARY KEY CHECK(id=1),question1 TEXT NOT NULL,salt1 TEXT NOT NULL,answer_hash1 TEXT NOT NULL,question2 TEXT NOT NULL,salt2 TEXT NOT NULL,answer_hash2 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recovery_challenges(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recovery_rate_limits(ip_hash TEXT PRIMARY KEY,window_start INTEGER NOT NULL,request_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_rate_limits(ip_hash TEXT PRIMARY KEY,window_start INTEGER NOT NULL,request_count INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_scans_student ON scans(student_id,ts);
    CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
  `);
  const columns = new Set(sqlite.prepare('PRAGMA table_info(students)').all().map((column) => column.name));
  for (const [name, type] of [['parent_email', 'TEXT'], ['email_consent', 'INTEGER DEFAULT 0']]) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE students ADD COLUMN ${name} ${type}`);
  }
  for (const [name, type] of [['surname', 'TEXT'], ['first_name', 'TEXT'], ['middle_name', 'TEXT'], ['name_extension', 'TEXT']]) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE students ADD COLUMN ${name} ${type}`);
  }
  const attendanceColumns = new Set(sqlite.prepare('PRAGMA table_info(attendance)').all().map((column) => column.name));
  for (const name of ['morning_in', 'morning_out', 'afternoon_in', 'afternoon_out']) {
    if (!attendanceColumns.has(name)) sqlite.exec(`ALTER TABLE attendance ADD COLUMN ${name} TEXT`);
  }
  const attemptColumns = new Set(sqlite.prepare('PRAGMA table_info(scan_attempts)').all().map((column) => column.name));
  if (!attemptColumns.has('expected_type')) sqlite.exec('ALTER TABLE scan_attempts ADD COLUMN expected_type TEXT');
  const notificationColumns = new Set(sqlite.prepare('PRAGMA table_info(notifications)').all().map((column) => column.name));
  for (const [name, type] of [['channel', "TEXT DEFAULT 'sms'"], ['recipient', 'TEXT']]) {
    if (!notificationColumns.has(name)) sqlite.exec(`ALTER TABLE notifications ADD COLUMN ${name} ${type}`);
  }
  sqlite.exec('UPDATE attendance SET morning_in=time_in WHERE morning_in IS NULL AND time_in IS NOT NULL');
  sqlite.exec('UPDATE attendance SET morning_out=time_out WHERE morning_out IS NULL AND time_out IS NOT NULL');
  sqlite.prepare('INSERT OR IGNORE INTO sections(grade,section) SELECT DISTINCT grade,section FROM students').run();
  sqlite.prepare(`INSERT OR IGNORE INTO tap_state(student_id,date,ts,type)
    SELECT sc.student_id,sc.date,sc.ts,sc.type FROM scans sc WHERE sc.id=(
      SELECT latest.id FROM scans latest WHERE latest.student_id=sc.student_id AND latest.date=sc.date
      ORDER BY latest.ts DESC,latest.id DESC LIMIT 1)`).run();
  sqlite.prepare(`INSERT OR IGNORE INTO absence_notices(student_id,date)
    SELECT student_id,date FROM notifications WHERE kind='ABSENT' AND student_id IS NOT NULL`).run();
  ready = Promise.resolve();
}

const DEFAULTS = {
  school_name: 'Sample National High School',
  late_time: '07:30',
  morning_late_time: '',
  morning_end_time: '',
  afternoon_late_time: '',
  afternoon_end_time: '',
  notify_enabled: '1',
  email_notify_enabled: '0',
  debounce_sec: '60',
};

function nowManila() {
  const iso = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), ts: iso.slice(0, 19) };
}
async function getSetting(key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : DEFAULTS[key];
}
async function allSettings() {
  const settings = await db.prepare('SELECT key,value FROM settings').all();
  return { ...DEFAULTS, ...Object.fromEntries(settings.map(({ key, value }) => [key, value])) };
}
async function setSetting(key, value) {
  await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
function timeToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
function isAfterTime(time, cutoff) {
  const timeMinutes = timeToMinutes(time);
  const cutoffMinutes = timeToMinutes(cutoff);
  if (timeMinutes === null || cutoffMinutes === null) throw new Error('Invalid time or late cutoff; expected HH:MM');
  return timeMinutes > cutoffMinutes;
}
function isValidTime(value) { return timeToMinutes(value) !== null; }
function addDays(date, count) {
  const result = new Date(date + 'T00:00:00Z');
  result.setUTCDate(result.getUTCDate() + count);
  return result.toISOString().slice(0, 10);
}
async function holidaySet() {
  return new Set((await db.prepare('SELECT date FROM holidays').all()).map((row) => row.date));
}
async function isSchoolDay(date, holidays) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  if (day === 0 || day === 6) return false;
  const closedDays = holidays || await holidaySet();
  return !closedDays.has(date);
}
async function schoolDaysBetween(from, to) {
  const holidays = await holidaySet();
  const days = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (await isSchoolDay(date, holidays)) days.push(date);
  }
  return days;
}

module.exports = { db, ready, usePostgres, DEFAULTS, nowManila, getSetting, allSettings, setSetting, isAfterTime, isValidTime, addDays, holidaySet, isSchoolDay, schoolDaysBetween };
