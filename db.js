// Uses Node's built-in SQLite (node:sqlite, Node 22.13+), so there is nothing native to
// install or compile. This small wrapper gives it a better-sqlite3-style API.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

class Database {
  constructor(file) {
    this.d = new DatabaseSync(file);
  }
  pragma(s) {
    this.d.exec('PRAGMA ' + s);
  }
  exec(sql) {
    this.d.exec(sql);
  }
  prepare(sql) {
    const st = this.d.prepare(sql);
    return {
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
      run: (...a) => st.run(...a),
    };
  }
  transaction(fn) {
    return (...args) => {
      this.d.exec('BEGIN');
      try {
        const r = fn(...args);
        this.d.exec('COMMIT');
        return r;
      } catch (e) {
        this.d.exec('ROLLBACK');
        throw e;
      }
    };
  }
}

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lrn TEXT UNIQUE,
  name TEXT NOT NULL,
  surname TEXT,
  first_name TEXT,
  middle_name TEXT,
  name_extension TEXT,
  grade INTEGER NOT NULL,
  section TEXT NOT NULL,
  rfid_uid TEXT UNIQUE,
  parent_name TEXT,
  parent_phone TEXT,
  consent INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS scans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  uid TEXT,
  ts TEXT NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tap_state(
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  PRIMARY KEY(student_id, date)
);
CREATE TABLE IF NOT EXISTS attendance(
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time_in TEXT,
  time_out TEXT,
  status TEXT NOT NULL,
  PRIMARY KEY(student_id, date)
);
CREATE TABLE IF NOT EXISTS unknown_scans(
  uid TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  kind TEXT,
  date TEXT,
  phone TEXT,
  message TEXT,
  status TEXT,
  provider TEXT,
  ts TEXT
);
CREATE TABLE IF NOT EXISTS absence_notices(
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY(student_id, date)
);
CREATE TABLE IF NOT EXISTS holidays(
  date TEXT PRIMARY KEY,
  name TEXT
);
CREATE TABLE IF NOT EXISTS sections(
  grade INTEGER NOT NULL,
  section TEXT NOT NULL,
  PRIMARY KEY(grade, section)
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS auth_users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL UNIQUE CHECK(role IN ('admin','user')),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scans_student ON scans(student_id, ts);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
`);

const studentColumns = new Set(db.prepare('PRAGMA table_info(students)').all().map((column) => column.name));
for (const [name, type] of [
  ['surname', 'TEXT'],
  ['first_name', 'TEXT'],
  ['middle_name', 'TEXT'],
  ['name_extension', 'TEXT'],
]) {
  if (!studentColumns.has(name)) db.exec(`ALTER TABLE students ADD COLUMN ${name} ${type}`);
}

db.prepare(
  'INSERT OR IGNORE INTO sections(grade,section) SELECT DISTINCT grade,section FROM students'
).run();

db.prepare(
  `INSERT OR IGNORE INTO tap_state(student_id,date,ts,type)
   SELECT sc.student_id,sc.date,sc.ts,sc.type
   FROM scans sc
   WHERE sc.id=(
     SELECT latest.id FROM scans latest
     WHERE latest.student_id=sc.student_id AND latest.date=sc.date
     ORDER BY latest.ts DESC,latest.id DESC LIMIT 1
   )`
).run();
db.prepare(
   `INSERT OR IGNORE INTO absence_notices(student_id,date)
    SELECT student_id,date FROM notifications
    WHERE kind='ABSENT' AND student_id IS NOT NULL`
).run();

const DEFAULTS = {
  school_name: 'Sample National High School',
  late_time: '07:30',
  notify_enabled: '1',
  debounce_sec: '60',
};

// All timestamps are stored as Philippine local time (UTC+8), "YYYY-MM-DDTHH:MM:SS".
function nowManila() {
  const iso = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), ts: iso.slice(0, 19) };
}

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : DEFAULTS[key];
}

function allSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, String(value));
}

function timeToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isAfterTime(time, cutoff) {
  const timeMinutes = timeToMinutes(time);
  const cutoffMinutes = timeToMinutes(cutoff);
  if (timeMinutes === null || cutoffMinutes === null) {
    throw new Error('Invalid time or late cutoff; expected HH:MM');
  }
  return timeMinutes > cutoffMinutes;
}

function isValidTime(value) {
  return timeToMinutes(value) !== null;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function holidaySet() {
  return new Set(db.prepare('SELECT date FROM holidays').all().map((r) => r.date));
}

function isSchoolDay(dateStr, holidays) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !(holidays || holidaySet()).has(dateStr);
}

function schoolDaysBetween(from, to) {
  const hol = holidaySet();
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isSchoolDay(d, hol)) out.push(d);
  return out;
}

module.exports = {
  db,
  DEFAULTS,
  nowManila,
  getSetting,
  allSettings,
  setSetting,
  isAfterTime,
  isValidTime,
  addDays,
  holidaySet,
  isSchoolDay,
  schoolDaysBetween,
};
