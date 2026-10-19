const { db, nowManila, getSetting, isAfterTime, usePostgres } = require('./db');
const { notifyParent } = require('./notify');

const epoch = (ts) => Date.parse(ts + 'Z');

function publicStudent(s) {
  return { id: s.id, name: s.name, grade: s.grade, section: s.section };
}

async function recordAttempt(student, uid, n, code, message, expectedType = null) {
  await db.prepare(
    'INSERT INTO scan_attempts(student_id,uid,ts,date,code,message,expected_type) VALUES(?,?,?,?,?,?,?)'
  ).run(student ? student.id : null, uid, n.ts, n.date, code, message, expectedType);
}

async function processTap(rawUid, when) {
  const uid = String(rawUid || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!uid) return { ok: false, code: 'BAD_UID', message: 'Try again', http: 400 };

  const n = when || nowManila();
  const student = await db.prepare('SELECT * FROM students WHERE rfid_uid=? AND active=1').get(uid);
  if (!student) {
    await db.prepare(
      'INSERT INTO unknown_scans(uid,ts) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET ts=excluded.ts'
    ).run(uid, n.ts);
    await recordAttempt(null, uid, n, 'UNKNOWN_CARD', 'Try again - card not recognized');
    return {
      ok: false,
      code: 'UNKNOWN_CARD',
      message: 'Try again - card not recognized',
      http: 404,
    };
  }

  const schedule = {
    morningLate: await getSetting('morning_late_time'),
    morningEnd: await getSetting('morning_end_time'),
    afternoonLate: await getSetting('afternoon_late_time'),
    afternoonEnd: await getSetting('afternoon_end_time'),
  };
  if (Object.values(schedule).some((time) => !time)) {
    return {
      ok: false,
      code: 'SCHEDULE_NOT_CONFIGURED',
      message: 'Attendance schedule is not configured',
      http: 503,
      student: publicStudent(student),
    };
  }
  for (const key of Object.keys(schedule)) schedule[key] = schedule[key].slice(0, 5);

  const debounce = Number(await getSetting('debounce_sec')) || 0;
  const tapTime = n.time.slice(0, 5);
  const r = await db.transaction(async () => {
    if (usePostgres) {
      await db.prepare('SELECT pg_advisory_xact_lock(?, hashtext(?))').get(student.id, n.date);
    }
    const last = await db
      .prepare('SELECT * FROM tap_state WHERE student_id=? AND date=?')
      .get(student.id, n.date);
    const attendance = await db
      .prepare('SELECT * FROM attendance WHERE student_id=? AND date=?')
      .get(student.id, n.date);
    const values = attendance || {};
    const inMorningPeriod = tapTime < schedule.morningEnd;
    const beforeAfternoonEnd = tapTime < schedule.afternoonEnd;
    const arrivedForAfternoonOnly =
      !values.morning_in &&
      !values.morning_out &&
      !values.afternoon_in &&
      !inMorningPeriod &&
      beforeAfternoonEnd;
    const lunchEndsAt = values.morning_out
      ? epoch(`${n.date}T${values.morning_out}`)
      : arrivedForAfternoonOnly
        ? epoch(`${n.date}T${schedule.morningEnd}:00`)
        : null;
    if (lunchEndsAt !== null && !values.afternoon_in) {
      const secondsSinceLunchStarted = epoch(n.ts) - lunchEndsAt;
      const secondsUntilAfternoonIn = 300 - secondsSinceLunchStarted / 1000;
      if (secondsUntilAfternoonIn > 0) {
        const remainingSeconds = Math.ceil(secondsUntilAfternoonIn);
        return {
          code: 'LUNCH_BREAK',
          message: `Please wait 5 minutes after ${values.morning_out ? 'morning OUT' : 'morning class ends'} before scanning for afternoon IN`,
          retry_after_seconds: remainingSeconds,
        };
      }
    }
    if (last && Math.abs(epoch(n.ts) - epoch(last.ts)) / 1000 < debounce) {
      return { code: 'ALREADY_RECORDED', message: 'Already recorded' };
    }

    if ((tapTime < schedule.morningEnd && values.morning_in) ||
        (tapTime >= schedule.morningEnd && tapTime < schedule.afternoonEnd &&
          values.afternoon_in && !values.afternoon_out) ||
        (tapTime >= schedule.afternoonEnd && values.afternoon_out)) {
      return { code: 'ALREADY_RECORDED', message: 'Already recorded' };
    }
    const events = [
      { field: 'morning_in', type: 'MORNING_IN' },
      { field: 'morning_out', type: 'MORNING_OUT' },
      { field: 'afternoon_in', type: 'AFTERNOON_IN' },
      { field: 'afternoon_out', type: 'AFTERNOON_OUT' },
    ];
    const expected = arrivedForAfternoonOnly
      ? events.find((event) => event.type === 'AFTERNOON_IN')
      : values.status === 'half_day' && !values.afternoon_out
        ? events.find((event) => event.type === 'AFTERNOON_OUT')
      : events.find((event) => !values[event.field]);
    if (!expected) return { code: 'ALREADY_RECORDED', message: 'Already recorded' };

    const inExpectedPeriod =
      (expected.type === 'MORNING_IN' && inMorningPeriod) ||
      (expected.type === 'MORNING_OUT' && !inMorningPeriod && beforeAfternoonEnd) ||
      (expected.type === 'AFTERNOON_IN' && !inMorningPeriod && beforeAfternoonEnd) ||
      (expected.type === 'AFTERNOON_OUT' && !beforeAfternoonEnd);

    if (!inExpectedPeriod) {
      return {
        code: 'SCAN_NOT_EXPECTED',
        message: 'Scan not expected now',
        expected: expected.type,
      };
    }

    const isMorningIn = expected.type === 'MORNING_IN';
    const isAfternoonIn = expected.type === 'AFTERNOON_IN';
    const status = isMorningIn
      ? (isAfterTime(tapTime, schedule.morningLate) ? 'late' : 'present')
      : isAfternoonIn
        ? (isAfterTime(tapTime, schedule.afternoonLate) ? 'late' : 'present')
        : 'present';

    if (isMorningIn) {
      await db.prepare(
        `INSERT INTO attendance(student_id,date,time_in,time_out,status,morning_in)
         VALUES(?,?,?,NULL,?,?)
         ON CONFLICT(student_id,date) DO UPDATE SET
           time_in=excluded.time_in,status=excluded.status,morning_in=excluded.morning_in`
      ).run(student.id, n.date, n.time, status, n.time);
    } else if (arrivedForAfternoonOnly && isAfternoonIn) {
      await db.prepare(
        `INSERT INTO attendance(student_id,date,time_in,time_out,status,afternoon_in)
         VALUES(?,?,NULL,NULL,'half_day',?)
         ON CONFLICT(student_id,date) DO UPDATE SET
           status='half_day',afternoon_in=excluded.afternoon_in`
      ).run(student.id, n.date, n.time);
    } else {
      const column = expected.field;
      await db.prepare(`UPDATE attendance SET ${column}=? WHERE student_id=? AND date=?`)
        .run(n.time, student.id, n.date);
      if (expected.type === 'MORNING_OUT') {
        await db.prepare('UPDATE attendance SET time_out=? WHERE student_id=? AND date=?')
          .run(n.time, student.id, n.date);
      }
    }

    await db.prepare('INSERT INTO scans(student_id,uid,ts,date,type) VALUES(?,?,?,?,?)').run(
      student.id,
      uid,
      n.ts,
      n.date,
      expected.type
    );
    await db.prepare(
      `INSERT INTO tap_state(student_id,date,ts,type) VALUES(?,?,?,?)
       ON CONFLICT(student_id,date) DO UPDATE SET ts=excluded.ts,type=excluded.type`
    ).run(student.id, n.date, n.ts, expected.type);
    return { type: expected.type, status };
  });

  if (r.code === 'ALREADY_RECORDED') {
    return {
      ok: false,
      code: r.code,
      message: r.message,
      http: 409,
      student: publicStudent(student),
    };
  }
  if (r.code === 'LUNCH_BREAK') {
    await recordAttempt(student, uid, n, r.code, r.message, 'AFTERNOON_IN');
    return {
      ok: false,
      code: r.code,
      message: r.message,
      retry_after_seconds: r.retry_after_seconds,
      http: 409,
      student: publicStudent(student),
    };
  }
  if (r.code === 'SCAN_NOT_EXPECTED') {
    await recordAttempt(student, uid, n, r.code, r.message, r.expected);
    return {
      ok: false,
      code: r.code,
      message: r.message,
      expected: r.expected,
      http: 409,
      student: publicStudent(student),
    };
  }

  const ageSec = (epoch(nowManila().ts) - epoch(n.ts)) / 1000;
  if (Math.abs(ageSec) < 600) {
    try {
      await notifyParent(student, r.type, r.status, n.time, n.date);
    } catch (error) {
      console.error('notify failed:', error.message);
    }
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
