const { db, nowManila, addDays, schoolDaysBetween } = require('./db');

// Early-warning model: simple, transparent, and explainable to a guidance counselor.
// Scores school days in the selected calendar month; today is excluded for the current month.
const WEIGHTS = {
  absence: 4, // per absent day in the selected month
  late: 1.5, // per late arrival in the selected month
  streakShort: 2, // per consecutive absent day (streak 1-2)
  streakLong: 4, // per consecutive absent day (streak 3+)
  rising: 2, // per extra absence in the second half vs. first half of the month
};
const HIGH = 28;
const MEDIUM = 14;

const ACTIONS = {
  high: 'Refer to guidance counselor; adviser to contact parent/guardian or arrange a home visit.',
  medium: 'Adviser to talk with the student and inform the parent/guardian.',
  low: 'No action needed. Keep monitoring.',
};

async function computeRisk(month) {
  const today = nowManila().date;
  const currentMonth = today.slice(0, 7);
  const selectedMonth = month || currentMonth;
  const [year, monthNumber] = selectedMonth.split('-').map(Number);
  const monthStart = `${selectedMonth}-01`;
  const monthEnd = `${selectedMonth}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
  const periodEnd = selectedMonth === currentMonth ? addDays(today, -1) : monthEnd;
  const days = periodEnd < monthStart ? [] : await schoolDaysBetween(monthStart, periodEnd);
  const midpoint = Math.floor(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() / 2);
  const firstHalf = days.filter((day) => Number(day.slice(8)) <= midpoint);
  const secondHalf = days.filter((day) => Number(day.slice(8)) > midpoint);

  const rows = days.length
    ? await db
        .prepare('SELECT student_id, date, status FROM attendance WHERE date BETWEEN ? AND ?')
        .all(days[0], days[days.length - 1])
    : [];
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, new Map());
    byStudent.get(r.student_id).set(r.date, r.status);
  }

  const out = [];
  for (const s of await db.prepare('SELECT * FROM students WHERE active=1').all()) {
    const m = byStudent.get(s.id) || new Map();
    const absences = days.filter((d) => !m.has(d)).length;
    const lates = days.filter((d) => m.get(d) === 'late').length;
    let streak = 0;
    for (let i = days.length - 1; i >= 0 && !m.has(days[i]); i--) streak++;
    const recentAbs = secondHalf.filter((d) => !m.has(d)).length;
    const priorAbs = firstHalf.filter((d) => !m.has(d)).length;

    const score =
      absences * WEIGHTS.absence +
      lates * WEIGHTS.late +
      streak * (streak >= 3 ? WEIGHTS.streakLong : WEIGHTS.streakShort) +
      Math.max(0, recentAbs - priorAbs) * WEIGHTS.rising;

    const reasons = [];
    if (absences >= 3) reasons.push(`${absences} absences in ${selectedMonth}`);
    if (streak >= 2) reasons.push(`${streak} consecutive absences`);
    if (recentAbs - priorAbs >= 2)
      reasons.push(`Absences rising: ${recentAbs} in the second half vs ${priorAbs} in the first half`);
    if (lates >= 4) reasons.push(`Late ${lates} times`);

    const level = score >= HIGH ? 'high' : score >= MEDIUM ? 'medium' : 'low';
    out.push({
      student_id: s.id,
      lrn: s.lrn,
      name: s.name,
      grade: s.grade,
      section: s.section,
      parent_name: s.parent_name,
      parent_phone: s.parent_phone,
      days: days.length,
      absences,
      lates,
      streak,
      attendance_rate: days.length ? Math.round(((days.length - absences) / days.length) * 100) : 0,
      score: Math.round(score * 10) / 10,
      level,
      reasons,
      action: ACTIONS[level],
    });
  }
  return {
    month: selectedMonth,
    currentMonth,
    days: days.length,
    rows: out.sort((a, b) => b.score - a.score),
  };
}

module.exports = { computeRisk };
