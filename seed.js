// Fills the database with a demo school: 30 students in 3 sections and ~45 days of
// attendance history, including a few students whose patterns should trigger the
// early-warning list. Run with: npm run seed   (WARNING: wipes existing data)
const { db, ready, nowManila, addDays, isSchoolDay, usePostgres } = require('./db');

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

async function seedDemo() {
  await ready;
  await db.exec(`
    DELETE FROM scans; DELETE FROM attendance; DELETE FROM students; DELETE FROM unknown_scans;
    DELETE FROM scan_attempts;
    DELETE FROM notifications; DELETE FROM holidays; DELETE FROM tap_state; DELETE FROM absence_notices;
    DELETE FROM sections;
  `);
  if (!usePostgres) await db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('students','scans','notifications')").run();

  const today = nowManila().date;
  let holiday = addDays(today, -20);
  while (!(await isSchoolDay(holiday, new Set()))) holiday = addDays(holiday, 1);
  await db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)').run(holiday, 'Class suspension (demo)');

  const hex = () => Array.from({ length: 8 }, () => '0123456789ABCDEF'[Math.floor(rand() * 16)]).join('');
  const usedNames = new Set();
  const students = [];
  const insertStudent = db.prepare(
    `INSERT INTO students(lrn,name,grade,section,rfid_uid,parent_name,parent_phone,consent)
     VALUES(?,?,?,?,?,?,?,?) RETURNING id`
  );
  let index = 0;
  for (const [grade, section] of CLASSES) {
    await db.prepare('INSERT INTO sections(grade,section) VALUES(?,?) ON CONFLICT DO NOTHING').run(grade, section);
    for (let k = 0; k < 10; k++, index++) {
      let name;
      do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(name));
      usedNames.add(name);
      const lrn = '10' + String(1000000 + index).padStart(10, '0');
      const phone = '0917000' + String(1000 + index);
      const consent = index % 11 === 5 ? 0 : 1;
      const parent = `Parent of ${name.split(' ')[0]}`;
      const uid = hex();
      const row = await insertStudent.get(lrn, name, grade, section, uid, parent, phone, consent);
      students.push({ id: Number(row.id), uid, profile: PROFILES[index] || 'normal' });
    }
  }

  const from = addDays(today, -45);
  const days = [];
  for (let date = from; date < today; date = addDays(date, 1)) {
    if (await isSchoolDay(date)) days.push(date);
  }
  const fmt = (mins, secs) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const insertAttendance = db.prepare(
    `INSERT INTO attendance(student_id,date,time_in,time_out,status,morning_in,morning_out,afternoon_in,afternoon_out)
     VALUES(?,?,?,?,?,?,?,?,?)`
  );
  const insertScan = db.prepare('INSERT INTO scans(student_id,uid,ts,date,type) VALUES(?,?,?,?,?)');
  const pAbsent = (profile, fromEnd) => {
    switch (profile) {
      case 'medium': return 0.2;
      case 'rising': return fromEnd <= 10 ? 0.5 : 0.04;
      case 'streak': return fromEnd <= 4 ? 1 : 0.03;
      default: return 0.03;
    }
  };
  const pLate = (profile) => (profile === 'late' ? 0.6 : 0.08);

  await db.transaction(async () => {
    for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
      const date = days[dayIndex];
      const fromEnd = days.length - dayIndex;
      for (const student of students) {
        if (rand() < pAbsent(student.profile, fromEnd)) continue;
        const late = rand() < pLate(student.profile);
        const inMin = late ? 7 * 60 + 31 + Math.floor(rand() * 45) : 6 * 60 + 30 + Math.floor(rand() * 59);
        const outMin = 16 * 60 + Math.floor(rand() * 45);
        const timeIn = fmt(inMin, Math.floor(rand() * 60));
        const morningOut = '12:00:00';
        const afternoonIn = '13:00:00';
        const timeOut = fmt(outMin, Math.floor(rand() * 60));
        await insertAttendance.run(
          student.id,
          date,
          timeIn,
          morningOut,
          late ? 'late' : 'present',
          timeIn,
          morningOut,
          afternoonIn,
          timeOut
        );
        await insertScan.run(student.id, student.uid, `${date}T${timeIn}`, date, 'MORNING_IN');
        await insertScan.run(student.id, student.uid, `${date}T${morningOut}`, date, 'MORNING_OUT');
        await insertScan.run(student.id, student.uid, `${date}T${afternoonIn}`, date, 'AFTERNOON_IN');
        await insertScan.run(student.id, student.uid, `${date}T${timeOut}`, date, 'AFTERNOON_OUT');
      }
    }
  });

  console.log(`Seeded ${students.length} students and ${days.length} school days of history.`);
  console.log('Demo students flagged on purpose: 1 streak, 2 rising absences, 1 chronic late, 1 medium.');
}

seedDemo().catch((error) => {
  console.error('Failed to seed demo data:', error);
  process.exitCode = 1;
}).finally(() => db.close().catch((error) => {
  console.error('Failed to close the database connection:', error);
  process.exitCode = 1;
}));
