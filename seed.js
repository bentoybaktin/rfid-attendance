// Fills the database with a demo school: 30 students in 3 sections and ~45 days of
// attendance history, including a few students whose patterns should trigger the
// early-warning list. Run with: npm run seed   (WARNING: wipes existing data)
const { db, nowManila, addDays, isSchoolDay } = require('./db');

function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261018);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Juan', 'Maria', 'Jose', 'Ana', 'Mark', 'Angel', 'John', 'Kyle', 'Jasmine', 'Carlo', 'Princess', 'Miguel', 'Hazel', 'Rommel', 'Bea', 'Paolo', 'Shiela', 'Ramon', 'Trisha', 'Dennis'];
const LAST = ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Garcia', 'Mendoza', 'Torres', 'Flores', 'Villanueva', 'Ramos', 'Aquino', 'Castillo', 'Navarro', 'Dizon', 'Pascual'];
const CLASSES = [[9, 'Rizal'], [9, 'Bonifacio'], [10, 'Mabini']];

// index -> pattern. Everyone else is "normal".
const PROFILES = { 3: 'rising', 7: 'streak', 12: 'late', 18: 'medium', 24: 'rising' };

db.exec(`
  DELETE FROM scans; DELETE FROM attendance; DELETE FROM students; DELETE FROM unknown_scans;
  DELETE FROM notifications; DELETE FROM holidays; DELETE FROM tap_state; DELETE FROM absence_notices;
  DELETE FROM sqlite_sequence WHERE name IN ('students','scans','notifications');
`);

const today = nowManila().date;

// One mid-period holiday so the "no class" logic is visible.
let hol = addDays(today, -20);
while (!isSchoolDay(hol, new Set())) hol = addDays(hol, 1);
db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)').run(hol, 'Class suspension (demo)');

const hex = () => Array.from({ length: 8 }, () => '0123456789ABCDEF'[Math.floor(rand() * 16)]).join('');
const usedNames = new Set();
const insStudent = db.prepare(
  `INSERT INTO students(lrn,name,grade,section,rfid_uid,parent_name,parent_phone,consent)
   VALUES(?,?,?,?,?,?,?,?)`
);

const students = [];
let i = 0;
for (const [grade, section] of CLASSES) {
  for (let k = 0; k < 10; k++, i++) {
    let name;
    do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(name));
    usedNames.add(name);
    const lrn = '10' + String(1000000 + i).padStart(10, '0');
    // Obviously fake numbers so the demo can never text a real person.
    const phone = '0917000' + String(1000 + i);
    const consent = i % 11 === 5 ? 0 : 1;
    const parent = `Parent of ${name.split(' ')[0]}`;
    const r = insStudent.run(lrn, name, grade, section, hex(), parent, phone, consent);
    students.push({ id: Number(r.lastInsertRowid), profile: PROFILES[i] || 'normal' });
  }
}

// ---- attendance history ----
const from = addDays(today, -45);
const days = [];
for (let d = from; d < today; d = addDays(d, 1)) if (isSchoolDay(d)) days.push(d);

const fmt = (mins, secs) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
const insAtt = db.prepare('INSERT INTO attendance(student_id,date,time_in,time_out,status) VALUES(?,?,?,?,?)');
const insScan = db.prepare('INSERT INTO scans(student_id,uid,ts,date,type) VALUES(?,?,?,?,?)');
const uidOf = db.prepare('SELECT rfid_uid FROM students WHERE id=?');

const pAbsent = (profile, fromEnd) => {
  switch (profile) {
    case 'medium': return 0.2;
    case 'rising': return fromEnd <= 10 ? 0.5 : 0.04;
    case 'streak': return fromEnd <= 4 ? 1 : 0.03;
    default: return 0.03;
  }
};
const pLate = (profile) => (profile === 'late' ? 0.6 : 0.08);

const seed = db.transaction(() => {
  days.forEach((date, idx) => {
    const fromEnd = days.length - idx;
    for (const s of students) {
      if (rand() < pAbsent(s.profile, fromEnd)) continue;
      const late = rand() < pLate(s.profile);
      const inMin = late ? 7 * 60 + 31 + Math.floor(rand() * 45) : 6 * 60 + 30 + Math.floor(rand() * 59);
      const outMin = 16 * 60 + Math.floor(rand() * 45);
      const tIn = fmt(inMin, Math.floor(rand() * 60));
      const tOut = fmt(outMin, Math.floor(rand() * 60));
      const uid = uidOf.get(s.id).rfid_uid;
      insAtt.run(s.id, date, tIn, tOut, late ? 'late' : 'present');
      insScan.run(s.id, uid, `${date}T${tIn}`, date, 'IN');
      insScan.run(s.id, uid, `${date}T${tOut}`, date, 'OUT');
    }
  });
});
seed();

console.log(`Seeded ${students.length} students and ${days.length} school days of history.`);
console.log('Demo students flagged on purpose: 1 streak, 2 rising absences, 1 chronic late, 1 medium.');
