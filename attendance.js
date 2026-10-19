const { db, nowManila, getSetting, isAfterTime } = require('./db');
const { notifyParent } = require('./notify');

const epoch = (ts) => Date.parse(ts + 'Z'); // ts is local time; we only compare differences

function publicStudent(s) {
  return { id: s.id, name: s.name, grade: s.grade, section: s.section };
}

/**
 * Handle one card tap.
 *  - first tap of the day  -> IN  (status "present" or "late" vs. the late cutoff)
 *  - next taps alternate   -> OUT / IN (re-entry)
 *  - taps within debounce_sec of the previous one are ignored
 *  - unregistered cards are remembered so staff can assign them in the dashboard
 */
function processTap(rawUid, when) {
  const uid = String(rawUid || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!uid) return { ok: false, code: 'BAD_UID', http: 400 };

  const n = when || nowManila();
  const student = db.prepare('SELECT * FROM students WHERE rfid_uid=? AND active=1').get(uid);
  if (!student) {
    db.prepare(
      'INSERT INTO unknown_scans(uid,ts) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET ts=excluded.ts'
    ).run(uid, n.ts);
    return { ok: false, code: 'UNKNOWN_CARD', http: 404 };
  }

  const debounce = Number(getSetting('debounce_sec')) || 60;
  const lateTime = getSetting('late_time');

  const run = db.transaction(() => {
    const last = db
      .prepare('SELECT * FROM tap_state WHERE student_id=? AND date=?')
      .get(student.id, n.date);
    // epoch() is in milliseconds, debounce_sec is in seconds
    if (last && Math.abs(epoch(n.ts) - epoch(last.ts)) / 1000 < debounce) return { duplicate: true };

    const att = db
      .prepare('SELECT * FROM attendance WHERE student_id=? AND date=?')
      .get(student.id, n.date);

    let type;
    let status;
    if (!att) {
      type = 'IN';
      status = isAfterTime(n.time, lateTime) ? 'late' : 'present';
      db.prepare(
        'INSERT INTO attendance(student_id,date,time_in,time_out,status) VALUES(?,?,?,NULL,?)'
      ).run(student.id, n.date, n.time, status);
    } else {
      type = last && last.type === 'IN' ? 'OUT' : 'IN';
      status = 'present';
      db.prepare('UPDATE attendance SET time_out=? WHERE student_id=? AND date=?').run(
        type === 'OUT' ? n.time : null,
        student.id,
        n.date
      );
    }
    db.prepare('INSERT INTO scans(student_id,uid,ts,date,type) VALUES(?,?,?,?,?)').run(
      student.id,
      uid,
      n.ts,
      n.date,
      type
    );
    db.prepare(
      `INSERT INTO tap_state(student_id,date,ts,type) VALUES(?,?,?,?)
       ON CONFLICT(student_id,date) DO UPDATE SET ts=excluded.ts,type=excluded.type`
    ).run(student.id, n.date, n.ts, type);
    return { type, status };
  });

  const r = run();
  if (r.duplicate) return { ok: false, code: 'DUPLICATE', http: 409, student: publicStudent(student) };

  // Only text parents about live taps. Replayed taps (queued while the reader was offline)
  // and taps with a badly wrong reader clock (far in the past or future) are recorded silently.
  const ageSec = (epoch(nowManila().ts) - epoch(n.ts)) / 1000;
  if (Math.abs(ageSec) < 600) {
    notifyParent(student, r.type, r.status, n.time, n.date).catch((e) =>
      console.error('notify failed:', e.message)
    );
  }

  return {
    ok: true,
    http: 200,
    type: r.type,
    status: r.status,
    time: n.time,
    student: publicStudent(student),
  };
}

module.exports = { processTap };
