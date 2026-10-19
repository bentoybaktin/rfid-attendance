const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clsLabel = (c) => `Grade ${c.grade} - ${c.section}`;
const hhmm = (t) => (t ? t.slice(0, 5) : '');

function setTheme(theme) {
  const selectedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selectedTheme;
  localStorage.setItem('theme', selectedTheme);
  updateThemeControl(selectedTheme === 'dark');
}

setTheme(localStorage.getItem('theme'));

let token = localStorage.getItem('token') || '';
let role = localStorage.getItem('role') || '';
let username = localStorage.getItem('username') || '';
let settings = {};
let classes = [];
let students = [];
let selectedStudentIds = new Set();
let studentMarkMode = false;
let timer = null;
let userTimer = null;
let userHideTimer = null;
let lastUserScanId = 0;
let lastUserAttemptId = 0;
let currentTab = 'overview';

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Please sign in again');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.blob();
  if (!res.ok) {
    const error = new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function download(path, filename) {
  const blob = await api(path);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- login / boot ----------
function showLogin() {
  clearInterval(timer);
  clearInterval(userTimer);
  clearTimeout(userHideTimer);
  $('#app').classList.add('hidden');
  $('#userApp').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value, password: $('#pw').value }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Login failed');
    token = d.token;
    role = d.role;
    username = d.username;
    localStorage.setItem('token', token);
    localStorage.setItem('role', role);
    localStorage.setItem('username', username);
    $('#username').value = '';
    $('#pw').value = '';
    $('#loginErr').textContent = '';
    await boot();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
};

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('role');
  localStorage.removeItem('username');
  token = '';
  role = '';
  username = '';
  clearInterval(timer);
  clearInterval(userTimer);
  clearTimeout(userHideTimer);
  showLogin();
}

$('#logout').onclick = logout;
$('#userLogout').onclick = logout;
$('#userNavToggle').onclick = () => {
  const open = $('#userApp').classList.toggle('nav-open');
  $('#userNavToggle').setAttribute('aria-expanded', String(open));
  $('#userNavToggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
};
$('#userNavBackdrop').onclick = () => {
  $('#userApp').classList.remove('nav-open');
  $('#userNavToggle').setAttribute('aria-expanded', 'false');
  $('#userNavToggle').setAttribute('aria-label', 'Open navigation');
};

async function boot() {
  if (!token) return showLogin();
  if (role === 'user') {
    $('#login').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#userApp').classList.remove('hidden');
    $('#userAccountName').textContent = `Signed in as ${username}`;
    const baseline = await api('/user/latest?after=0');
    $('#userSchoolName').textContent = baseline.school_name;
    document.title = baseline.school_name + ' - Student Scan';
    lastUserScanId = Number(baseline.scan_cursor) || 0;
    lastUserAttemptId = Number(baseline.attempt_cursor) || 0;
    hideUserStudent();
    userTimer = setInterval(() => pollUserScreen().catch((err) => {
      $('#userStatus').textContent = err.message;
    }), 750);
    return;
  }
  try {
    settings = await api('/settings');
  } catch (err) {
    if (err.status === 403) logout();
    return;
  }
  $('#login').classList.add('hidden');
  $('#userApp').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#schoolName').textContent = settings.school_name;
  document.title = settings.school_name + ' - RFID Attendance';
  await refreshLookups();
  showTab(currentTab);
}

async function pollUserScreen() {
  const result = await api(`/user/latest?after=${lastUserScanId}&attempt_after=${lastUserAttemptId}`);
  $('#userSchoolName').textContent = result.school_name;
  lastUserScanId = Number(result.scan_cursor) || lastUserScanId;
  lastUserAttemptId = Number(result.attempt_cursor) || lastUserAttemptId;
  const student = result.latest;
  if (!student) {
    return;
  }
  if (student.code) {
    $('#userStudentDetails').classList.add('hidden');
    $('#userStatus').textContent = student.message;
    clearTimeout(userHideTimer);
    userHideTimer = setTimeout(hideUserStudent, 10000);
    return;
  }
  $('#userStatus').textContent = 'Student scan detected';
  $('#userStudentDetails').classList.remove('hidden');
  $('#userStudentName').textContent = student.display_name || student.name;
  $('#userLrn').textContent = student.lrn || 'Not recorded';
  $('#userGradeSection').textContent = clsLabel(student);
  const eventLabels = {
    MORNING_IN: 'Morning IN',
    MORNING_OUT: 'Morning OUT',
    AFTERNOON_IN: 'Afternoon IN',
    AFTERNOON_OUT: 'Afternoon OUT',
  };
  $('#userTapResult').textContent = `${eventLabels[student.type] || student.type}${student.status === 'late' ? ' (late)' : ''}`;
  $('#userTapResultBox').classList.toggle('event-in', student.type === 'MORNING_IN' || student.type === 'AFTERNOON_IN');
  $('#userTapResultBox').classList.toggle('event-out', student.type === 'MORNING_OUT' || student.type === 'AFTERNOON_OUT');
  $('#userTapTime').textContent = `${student.date} ${student.ts.slice(11, 19)}`;
  clearTimeout(userHideTimer);
  userHideTimer = setTimeout(hideUserStudent, 10000);
}

function hideUserStudent() {
  $('#userStudentDetails').classList.add('hidden');
  $('#userStatus').textContent = 'Waiting for an NFC card tap...';
}

async function refreshLookups() {
  [classes, students] = await Promise.all([api('/classes'), api('/students')]);
  const classOptions = classes
    .map((c) => `<option value="${c.grade}::${esc(c.section)}">${esc(clsLabel(c))}</option>`)
    .join('');
  const attValue = $('#attClass').value;
  $('#attClass').innerHTML = '<option value="">All sections</option>' + classOptions;
  if (classes.some((c) => `${c.grade}::${c.section}` === attValue)) $('#attClass').value = attValue;

  const filterValue = $('#stuClassFilter').value;
  $('#stuClassFilter').innerHTML = '<option value="">All sections</option>' + classOptions;
  if (classes.some((c) => `${c.grade}::${c.section}` === filterValue)) {
    $('#stuClassFilter').value = filterValue;
  }

  const studentClassValue = $('#sfClass').value;
  $('#sfClass').innerHTML = '<option value="">Choose a grade and section</option>' + classOptions;
  if (classes.some((c) => `${c.grade}::${c.section}` === studentClassValue)) {
    $('#sfClass').value = studentClassValue;
  }
  $('#simStudent').innerHTML = students
    .filter((s) => s.rfid_uid)
    .map((s) => `<option value="${s.id}">${esc(s.display_name || s.name)} (${esc(clsLabel(s))})</option>`)
    .join('');
}

// ---------- tabs ----------
const loaders = {
  overview: loadOverview,
  attendance: loadAttendance,
  students: loadStudents,
  risk: loadRisk,
  notifications: loadNotifications,
  settings: loadSettings,
};

function showTab(name) {
  currentTab = name;
  $('#app').classList.remove('nav-open');
  $('#navToggle').setAttribute('aria-expanded', 'false');
  $('#navToggle').setAttribute('aria-label', 'Open navigation');
  clearInterval(timer);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  loaders[name]().catch(() => {});
  if (name === 'overview') timer = setInterval(() => loadOverview().catch(() => {}), 3000);
}
document.querySelectorAll('#tabs [data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$('#navToggle').onclick = () => {
  const open = $('#app').classList.toggle('nav-open');
  $('#navToggle').setAttribute('aria-expanded', String(open));
  $('#navToggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
};
$('#navBackdrop').onclick = () => {
  $('#app').classList.remove('nav-open');
  $('#navToggle').setAttribute('aria-expanded', 'false');
  $('#navToggle').setAttribute('aria-label', 'Open navigation');
};

const badge = (cls, text) => `<span class="badge ${esc(cls)}">${esc(text ?? cls)}</span>`;

// ---------- overview ----------
async function loadOverview() {
  const [today, feed, attempts] = await Promise.all([
    api('/today'),
    api('/feed?limit=25'),
    api('/scan-attempts?limit=25'),
  ]);
  const t = today.total;
  $('#todayLine').textContent =
    today.date + (today.schoolDay ? '' : ' - not a school day (weekend or holiday)');
  $('#cards').innerHTML = [
    ['', t.enrolled, 'Enrolled'],
    ['ok', t.present, 'On time'],
    ['warn', t.late, 'Late'],
    ['bad', t.notIn, 'Not yet in / absent'],
    ['', t.inCampus, 'On campus now'],
  ]
    .map(([c, n, l]) => `<div class="card ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`)
    .join('');

  $('#byClass').innerHTML =
    '<tr><th>Section</th><th class="num">On time</th><th class="num">Late</th><th class="num">Not in</th><th class="num">Total</th></tr>' +
    (today.classes
      .map(
        (c) =>
          `<tr><td>${esc(clsLabel(c))}</td><td class="num">${c.present}</td><td class="num">${c.late}</td><td class="num">${c.notIn}</td><td class="num">${c.enrolled}</td></tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">No student data yet.</td></tr>');

  $('#feed').innerHTML =
    feed
      .map(
        (f) =>
          `<li><span class="t">${esc(f.ts.slice(5, 10))} ${esc(hhmm(f.ts.slice(11)))}</span>
           <span class="who">${esc(f.name)}<small>${esc(clsLabel(f))}</small></span>
           ${badge(f.type.toLowerCase(), f.type.replace('_', ' '))}
           ${f.status === 'late' ? badge('late', 'late') : ''}</li>`
      )
      .join('') || '<li class="muted">No taps yet.</li>';
  $('#scanAttemptsTable').innerHTML =
    '<tr><th>Time</th><th>Student / card</th><th>Result</th></tr>' +
    (attempts
      .map((attempt) =>
        `<tr><td>${esc(attempt.ts.replace('T', ' '))}</td>
         <td>${esc(attempt.name || 'Unknown card')}${attempt.name ? `<br><small class="muted">${esc(clsLabel(attempt))}</small>` : ''}</td>
         <td>${esc(attempt.message)}${attempt.expected_type ? `<br><small class="muted">Expected ${esc(attempt.expected_type.replace('_', ' '))}</small>` : ''}</td></tr>`
      )
      .join('') || '<tr><td colspan="3" class="muted">No scans need review.</td></tr>');
}

$('#clearFeed').onclick = async () => {
  if (!confirm('Permanently delete all live tap and scan-review entries? Attendance records will be kept.')) return;
  const button = $('#clearFeed');
  button.disabled = true;
  $('#feedMsg').textContent = '';
  try {
    await api('/feed', { method: 'DELETE' });
    $('#feedMsg').textContent = 'All live taps and scan-review entries deleted. Attendance records were kept.';
    await loadOverview();
  } catch (err) {
    $('#feedMsg').textContent = err.status === 404
      ? 'This server does not support clearing scan logs yet. Restart the server with npm start, then reload this page.'
      : `Could not clear the feed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
};

$('#simBtn').onclick = async () => {
  const id = Number($('#simStudent').value);
  if (!id) return;
  try {
    const r = await api('/simulate', { method: 'POST', body: { student_id: id } });
    const eventName = r.type ? r.type.replace('_', ' ') : '';
    $('#simMsg').textContent = r.ok
      ? `${r.student.name}: ${eventName}${r.status === 'late' ? ' LATE' : ''} at ${hhmm(r.time)}`
      : r.code === 'DUPLICATE'
      ? 'Already recorded'
      : r.code === 'ALREADY_RECORDED'
      ? 'Already recorded'
      : r.message || 'Tap rejected: ' + r.code;
    loadOverview();
  } catch (e) {
    $('#simMsg').textContent = e.message;
  }
};

$('#absentBtn').onclick = async () => {
  if (!confirm('Send an absence SMS to the parents of every student with no tap today?')) return;
  try {
    const r = await api('/notify-absent', { method: 'POST' });
    alert(`${r.checked} absent student(s) checked, ${r.sent} SMS sent (only parents with consent are texted).`);
  } catch (e) {
    alert(e.message);
  }
};

// ---------- attendance ----------
async function loadAttendance() {
  if (!$('#attDate').value) $('#attDate').value = (await api('/today')).date;
  const q = new URLSearchParams({ date: $('#attDate').value });
  if ($('#attClass').value) q.set('cls', $('#attClass').value);
  const r = await api('/attendance?' + q);
  $('#attTable').innerHTML =
    '<tr><th>LRN</th><th>Name</th><th>Section</th><th>Morning in</th><th>Morning out</th><th>Afternoon in</th><th>Afternoon out</th><th>Morning</th><th>Afternoon</th></tr>' +
    (r.rows
      .map(
        (s) =>
          `<tr><td>${esc(s.lrn)}</td><td><button type="button" class="student-attendance-link" data-monthly-attendance="${s.id}">${esc(s.full_name || s.name)}</button></td><td>${esc(clsLabel(s))}</td>
           <td>${esc(hhmm(s.morning_in))}</td><td>${esc(hhmm(s.morning_out))}</td>
           <td>${esc(hhmm(s.afternoon_in))}</td><td>${esc(hhmm(s.afternoon_out))}</td>
           <td>${badge(s.morning_status, !r.schoolDay && s.morning_status === 'absent' ? 'no class' : s.morning_status)}</td>
           <td>${badge(s.afternoon_status, s.afternoon_status)}</td></tr>`
      )
      .join('') || '<tr><td colspan="9" class="muted">No active students found for this section.</td></tr>');
  $('#attTable').querySelectorAll('[data-monthly-attendance]').forEach((button) => {
    button.onclick = () => showStudentMonthlyAttendance(Number(button.dataset.monthlyAttendance));
  });
}

async function showStudentMonthlyAttendance(studentId) {
  const modal = $('#studentAttendanceModal');
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#studentAttendanceTitle').textContent = 'Student monthly attendance';
  $('#studentAttendanceInfo').textContent = 'Loading attendance...';
  $('#studentAttendanceFullName').textContent = '';
  $('#studentAttendanceError').textContent = '';
  $('#studentAttendanceSummary').innerHTML = '';
  $('#studentAttendanceTable').innerHTML = '';
  try {
    const month = ($('#attDate').value || '').slice(0, 7);
    const report = await api(`/students/${studentId}/attendance?month=${encodeURIComponent(month)}`);
    $('#studentAttendanceTitle').textContent = report.student.display_name || report.student.name;
    $('#studentAttendanceInfo').textContent =
      `${report.student.lrn || 'No LRN'} - ${clsLabel(report.student)} - ${report.month}`;
    $('#studentAttendanceFullName').textContent = `Full name: ${report.student.full_name || report.student.name}`;
    $('#studentAttendanceSummary').innerHTML = [
      ['present', 'Present'],
      ['late', 'Late'],
      ['absent', 'Absent'],
    ]
      .map(([key, label]) => `<div class="card ${key === 'late' ? 'warn' : key === 'absent' ? 'bad' : 'ok'}"><div class="n">${report.totals[key]}</div><div class="l">${label}</div></div>`)
      .join('');
    $('#studentAttendanceTable').innerHTML =
      '<tr><th>Date</th><th>Day</th><th>Morning in</th><th>Morning out</th><th>Afternoon in</th><th>Afternoon out</th><th>Status</th></tr>' +
      report.days
        .map((day) =>
          `<tr><td>${esc(day.date)}</td><td>${esc(day.weekday)}</td>
           <td>${esc(hhmm(day.morning_in))}</td><td>${esc(hhmm(day.morning_out))}</td>
           <td>${esc(hhmm(day.afternoon_in))}</td><td>${esc(hhmm(day.afternoon_out))}</td>
           <td>${badge(day.status === 'present' ? 'present' : day.status === 'late' ? 'late' : day.status === 'absent' ? 'absent' : '', day.status)}</td></tr>`
        )
        .join('');
  } catch (err) {
    $('#studentAttendanceError').textContent = err.message;
    $('#studentAttendanceInfo').textContent = '';
  }
}

function closeStudentMonthlyAttendance() {
  $('#studentAttendanceModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

$('#closeStudentAttendance').onclick = closeStudentMonthlyAttendance;
$('#studentAttendanceModal').onclick = (event) => {
  if (event.target === $('#studentAttendanceModal')) closeStudentMonthlyAttendance();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeStudentMonthlyAttendance();
  }
});
$('#attDate').onchange = () => loadAttendance().catch(() => {});
$('#attClass').onchange = () => loadAttendance().catch(() => {});
$('#attExport').onclick = () => {
  const month = ($('#attDate').value || '').slice(0, 7);
  const q = new URLSearchParams({ month });
  if ($('#attClass').value) q.set('cls', $('#attClass').value);
  download('/export/sf2.csv?' + q, `sf2-${month}.csv`).catch((e) => alert(e.message));
};

// ---------- students ----------
async function loadStudents() {
  await refreshLookups();
  const activeIds = new Set(students.map((s) => s.id));
  selectedStudentIds = new Set([...selectedStudentIds].filter((id) => activeIds.has(id)));
  const classFilter = $('#stuClassFilter').value;
  const visibleStudents = classFilter
    ? students.filter((s) => `${s.grade}::${s.section}` === classFilter)
    : students;
  $('#stuTable').innerHTML =
    `<tr>${studentMarkMode ? '<th></th>' : ''}<th>Name</th><th>Section</th><th>Card</th><th>Parent SMS</th><th></th></tr>` +
    (visibleStudents
      .map(
        (s) =>
          `<tr>${studentMarkMode ? `<td><input type="checkbox" aria-label="Mark ${esc(s.display_name || s.name)} for removal" data-select-student="${s.id}" ${selectedStudentIds.has(s.id) ? 'checked' : ''}></td>` : ''}
           <td>${esc(s.display_name || s.name)}<br><small class="muted">${esc(s.lrn)}</small></td>
           <td>${esc(clsLabel(s))}</td>
           <td>${s.rfid_uid ? esc(s.rfid_uid) : '<span class="muted">none</span>'}</td>
           <td>${s.consent && s.parent_phone ? badge('present', 'consented') : badge('absent', 'no consent')}</td>
           <td><button class="small ghost" data-edit="${s.id}">Edit</button>
               <button class="small ghost" data-del="${s.id}">Remove</button></td></tr>`
      )
      .join('') || `<tr><td colspan="${studentMarkMode ? 6 : 5}" class="muted">No students saved yet.</td></tr>`);
  $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
    checkbox.onchange = () => {
      const id = Number(checkbox.dataset.selectStudent);
      if (checkbox.checked) selectedStudentIds.add(id);
      else selectedStudentIds.delete(id);
      updateStudentSelection(visibleStudents);
    };
  });
  $('#stuTable').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editStudent(Number(b.dataset.edit))));
  $('#stuTable').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => removeStudent(Number(b.dataset.del))));
  $('#markAllStudents').onclick = () => {
    for (const student of visibleStudents) selectedStudentIds.add(student.id);
    $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
      checkbox.checked = true;
    });
    updateStudentSelection(visibleStudents);
  };
  $('#unmarkAllStudents').onclick = () => {
    selectedStudentIds.clear();
    $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateStudentSelection(visibleStudents);
  };
  updateStudentSelection(visibleStudents);
  $('#toggleStudentMark').textContent = studentMarkMode ? 'Done marking' : 'Mark students';
  $('#studentMarkControls').classList.toggle('hidden', !studentMarkMode);
  loadUnknown();
}

function updateStudentSelection(visibleStudents = students) {
  const selectedCount = selectedStudentIds.size;
  $('#stuSelectionCount').textContent = `${selectedCount} marked`;
  $('#stuRemoveSelected').textContent = `Remove marked (${selectedCount})`;
  $('#stuRemoveSelected').disabled = selectedCount === 0;
}

$('#toggleStudentMark').onclick = async () => {
  studentMarkMode = !studentMarkMode;
  if (!studentMarkMode) selectedStudentIds.clear();
  await loadStudents();
};

$('#stuClassFilter').onchange = () => loadStudents().catch((err) => {
  $('#stuRemoveMsg').textContent = err.message;
});

$('#stuRemoveSelected').onclick = async () => {
  const selected = students.filter((s) => selectedStudentIds.has(s.id));
  if (!selected.length) return;
  const names = selected.map((s) => s.display_name || s.name).join(', ');
  if (!confirm(`Remove ${selected.length} marked student(s)${selected.length <= 5 ? `: ${names}` : ''}? Their attendance history will be kept and their cards freed.`)) return;
  try {
    let removed;
    try {
      const result = await api('/students', {
        method: 'DELETE',
        body: { ids: selected.map((s) => s.id) },
      });
      removed = result.removed;
    } catch (err) {
      if (err.status !== 404 && err.status !== 405) throw err;
      removed = 0;
      for (const student of selected) {
        await api('/students/' + student.id, { method: 'DELETE' });
        removed++;
      }
    }
    selectedStudentIds.clear();
    studentMarkMode = false;
    $('#stuRemoveMsg').className = 'muted';
    $('#stuRemoveMsg').textContent = `${removed} student(s) removed. Attendance history was kept.`;
    await loadStudents();
  } catch (err) {
    $('#stuRemoveMsg').className = 'err';
    $('#stuRemoveMsg').textContent = `${err.message}. Reload the student list and try again if the students are still active.`;
    await loadStudents().catch(() => {});
  }
};

async function loadUnknown() {
  const list = await api('/unknown');
  $('#unknownBox').innerHTML = list.length
    ? '<span class="muted">Unregistered cards just tapped:</span> ' +
      list.map((u) => `<button type="button" class="chip" data-uid="${esc(u.uid)}">${esc(u.uid)}</button>`).join('')
    : '';
  $('#unknownBox').querySelectorAll('[data-uid]').forEach((b) => (b.onclick = () => ($('#sfUid').value = b.dataset.uid)));
}

function showStudentForm() {
  $('#stuFormPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#sfSurname').focus();
}

function closeSectionForm() {
  $('#sectionFormPanel').classList.add('hidden');
  $('#sectionForm').reset();
  $('#sectionMsg').textContent = '';
  if ($('#stuFormPanel').classList.contains('hidden')) document.body.classList.remove('modal-open');
}

$('#addSectionBtn').onclick = () => {
  $('#sectionFormPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#sectionGrade').focus();
};

$('#closeSectionForm').onclick = closeSectionForm;
$('#cancelSectionForm').onclick = closeSectionForm;
$('#sectionFormPanel').onclick = (event) => {
  if (event.target === $('#sectionFormPanel')) closeSectionForm();
};
$('#sectionForm').onsubmit = async (event) => {
  event.preventDefault();
  $('#sectionMsg').textContent = '';
  try {
    const grade = $('#sectionGrade').value;
    const section = $('#sectionName').value.trim();
    await api('/classes', { method: 'POST', body: { grade, section } });
    await refreshLookups();
    $('#stuClassFilter').value = `${grade}::${section}`;
    closeSectionForm();
    await loadStudents();
  } catch (err) {
    $('#sectionMsg').textContent = err.message;
  }
};

$('#addStudentBtn').onclick = () => {
  clearForm();
  showStudentForm();
};

function editStudent(id) {
  const s = students.find((x) => x.id === id);
  if (!s) return;
  showStudentForm();
  $('#formTitle').textContent = 'Edit student';
  $('#sfId').value = s.id;
  $('#sfLrn').value = s.lrn || '';
  $('#sfSurname').value = s.surname || '';
  $('#sfFirstName').value = s.first_name || (s.surname ? '' : s.name);
  $('#sfMiddleName').value = s.middle_name || '';
  $('#sfNameExtension').value = s.name_extension || '';
  $('#sfClass').value = `${s.grade}::${s.section}`;
  $('#sfUid').value = s.rfid_uid || '';
  $('#sfParent').value = s.parent_name || '';
  $('#sfPhone').value = s.parent_phone || '';
  $('#sfConsent').checked = !!s.consent;
  $('#sfMsg').textContent = '';
}

function clearForm() {
  $('#formTitle').textContent = 'Add student';
  $('#stuForm').reset();
  $('#sfId').value = '';
  $('#sfMsg').textContent = '';
  $('#stuFormPanel').classList.add('hidden');
  document.body.classList.remove('modal-open');
}
$('#sfClear').onclick = clearForm;
$('#sfClose').onclick = clearForm;
$('#stuFormPanel').onclick = (e) => {
  if (e.target === $('#stuFormPanel')) clearForm();
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#sectionFormPanel').classList.contains('hidden')) closeSectionForm();
  else if (!$('#stuFormPanel').classList.contains('hidden')) clearForm();
});

async function removeStudent(id) {
  const s = students.find((x) => x.id === id);
  if (!confirm(`Remove ${s ? s.name : 'this student'}? Their attendance history is kept and the card is freed.`)) return;
  await api('/students/' + id, { method: 'DELETE' });
  clearForm();
  loadStudents();
}

$('#stuForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    lrn: $('#sfLrn').value,
    surname: $('#sfSurname').value,
    first_name: $('#sfFirstName').value,
    middle_name: $('#sfMiddleName').value,
    name_extension: $('#sfNameExtension').value,
    grade: $('#sfClass').value.split('::')[0],
    section: $('#sfClass').value.split('::').slice(1).join('::'),
    rfid_uid: $('#sfUid').value,
    parent_name: $('#sfParent').value,
    parent_phone: $('#sfPhone').value,
    consent: $('#sfConsent').checked,
  };
  const id = $('#sfId').value;
  try {
    await api(id ? '/students/' + id : '/students', { method: id ? 'PUT' : 'POST', body });
    clearForm();
    loadStudents();
  } catch (err) {
    $('#sfMsg').textContent = err.message;
  }
};

// ---------- early warning ----------
async function loadRisk() {
  const monthInput = $('#riskMonth');
  const query = monthInput.value ? `?month=${encodeURIComponent(monthInput.value)}` : '';
  const report = await api('/risk' + query);
  monthInput.value = report.month;
  monthInput.max = report.currentMonth;
  const all = report.rows;
  const f = $('#riskFilter').value;
  const rows = all.filter((r) => (f === 'all' ? true : f === 'high' ? r.level === 'high' : r.level !== 'low'));
  const high = all.filter((r) => r.level === 'high').length;
  const med = all.filter((r) => r.level === 'medium').length;
  const period = report.month === report.currentMonth ? 'through yesterday' : 'for the full month';
  $('#riskNote').textContent = `${high} high, ${med} medium. Based on ${report.days} school days in ${report.month} (${period}). Rising absences compare the month’s two halves. Scores are a screening aid for counselors, not a verdict on any student.`;
  $('#riskTable').innerHTML =
    '<tr><th>Level</th><th>Student</th><th class="num">Score</th><th class="num">Attend.</th><th class="num">Absent</th><th class="num">Late</th><th>Why flagged</th><th>Suggested action</th></tr>' +
    (rows
      .map(
        (r) =>
          `<tr><td>${badge(r.level)}</td>
           <td>${esc(r.name)}<br><small class="muted">${esc(clsLabel(r))}</small></td>
           <td class="num">${r.score}</td><td class="num">${r.attendance_rate}%</td>
           <td class="num">${r.absences}</td><td class="num">${r.lates}</td>
           <td>${r.reasons.length ? '<ul class="reasons">' + r.reasons.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<span class="muted">-</span>'}</td>
           <td>${esc(r.action)}</td></tr>`
      )
      .join('') || '<tr><td colspan="8" class="muted">Nobody flagged right now.</td></tr>');
}
$('#riskFilter').onchange = () => loadRisk().catch(() => {});
$('#riskMonth').onchange = () => loadRisk().catch((e) => alert(e.message));
$('#riskExport').onclick = () => {
  const month = encodeURIComponent($('#riskMonth').value);
  download(`/export/risk.csv?month=${month}`, `early-warning-${$('#riskMonth').value}.csv`).catch((e) => alert(e.message));
};

// ---------- notifications ----------
async function loadNotifications() {
  const rows = await api('/notifications');
  $('#notifTable').innerHTML =
    '<tr><th>Time</th><th>Student</th><th>To</th><th>Message</th><th>Status</th></tr>' +
    (rows
      .map(
        (n) =>
          `<tr><td>${esc((n.ts || '').replace('T', ' '))}</td><td>${esc(n.name)}</td><td>${esc(n.phone)}</td>
           <td>${esc(n.message)}</td>
           <td>${badge(String(n.status).startsWith('failed') ? 'failed' : 'sent', n.status)}<br><small class="muted">${esc(n.provider)}</small></td></tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">No messages yet.</td></tr>');
}

$('#deleteAllSms').onclick = async () => {
  if (!confirm('Permanently delete all SMS log entries? This does not recall messages already sent.')) return;
  const button = $('#deleteAllSms');
  button.disabled = true;
  $('#smsDeleteMsg').textContent = '';
  try {
    const result = await api('/notifications', { method: 'DELETE' });
    $('#smsDeleteMsg').textContent = `${result.deleted} SMS log entr${result.deleted === 1 ? 'y' : 'ies'} deleted.`;
    await loadNotifications();
  } catch (err) {
    $('#smsDeleteMsg').textContent = err.status === 404
      ? 'This server does not support deleting SMS logs yet. Restart the server with npm start, then reload this page.'
      : `Could not delete SMS logs: ${err.message}`;
  } finally {
    button.disabled = false;
  }
};

// ---------- settings ----------
function changeThemeFromControl(event) {
  const darkModeEnabled = event.currentTarget.checked;
  setTheme(darkModeEnabled ? 'dark' : 'light');
}

$('#darkModeToggle').onchange = changeThemeFromControl;
$('#userDarkModeToggle').onchange = changeThemeFromControl;

function updateThemeControl(darkModeEnabled) {
  for (const prefix of ['', 'user']) {
    const toggle = $(`#${prefix ? 'userDarkModeToggle' : 'darkModeToggle'}`);
    const label = $(`#${prefix ? 'userThemeModeLabel' : 'themeModeLabel'}`);
    const lightIcon = $(`#${prefix ? 'userLightModeIcon' : 'lightModeIcon'}`);
    const darkIcon = $(`#${prefix ? 'userDarkModeIcon' : 'darkModeIcon'}`);
    toggle.checked = darkModeEnabled;
    label.textContent = darkModeEnabled ? 'Dark mode' : 'Light mode';
    lightIcon.classList.toggle('active', !darkModeEnabled);
    darkIcon.classList.toggle('active', darkModeEnabled);
  }
  $('#themeMsg').textContent = `${darkModeEnabled ? 'Dark' : 'Light'} mode is on. Theme choice is saved in this browser.`;
  $('#userThemeMsg').textContent = `${darkModeEnabled ? 'Dark' : 'Light'} mode is on. Theme choice is saved in this browser.`;
}

updateThemeControl(document.documentElement.dataset.theme === 'dark');

function closeAccountModal() {
  $('#accountModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  $('#openAccountModal').focus();
}

$('#openAccountModal').onclick = async () => {
  const message = $('#accountMsg');
  message.className = 'muted';
  message.textContent = '';
  try {
    const accounts = await api('/accounts');
    $('#adminUsername').value = accounts.admin_username;
    $('#userUsername').value = accounts.user_username;
    $('#currentAdminPassword').value = '';
    $('#adminNewPassword').value = '';
    $('#userNewPassword').value = '';
    $('#accountModal').classList.remove('hidden');
    document.body.classList.add('modal-open');
    $('#currentAdminPassword').focus();
  } catch (err) {
    message.className = 'err';
    message.textContent = `Could not load account names: ${err.message}`;
  }
};

$('#closeAccountModal').onclick = closeAccountModal;
$('#accountModal').onclick = (event) => {
  if (event.target === $('#accountModal')) closeAccountModal();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#accountModal').classList.contains('hidden')) closeAccountModal();
});

async function loadSettings() {
  settings = await api('/settings');
  $('#setName').value = settings.school_name;
  $('#morningLateTime').value = settings.morning_late_time;
  $('#morningEndTime').value = settings.morning_end_time;
  $('#afternoonLateTime').value = settings.afternoon_late_time;
  $('#afternoonEndTime').value = settings.afternoon_end_time;
  $('#setDebounce').value = settings.debounce_sec;
  $('#setNotify').checked = settings.notify_enabled === '1';
  const hols = await api('/holidays');
  $('#holTable').innerHTML =
    hols
      .map(
        (h) =>
          `<tr><td>${esc(h.date)}</td><td>${esc(h.name)}</td><td><button class="small ghost" data-hol="${esc(h.date)}">Remove</button></td></tr>`
      )
      .join('') || '<tr><td class="muted">None yet.</td></tr>';
  $('#holTable').querySelectorAll('[data-hol]').forEach((b) => {
    b.onclick = async () => {
      await api('/holidays/' + b.dataset.hol, { method: 'DELETE' });
      loadSettings();
    };
  });
}

$('#setForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    settings = await api('/settings', {
      method: 'PUT',
      body: {
        school_name: $('#setName').value,
        morning_late_time: $('#morningLateTime').value,
        morning_end_time: $('#morningEndTime').value,
        afternoon_late_time: $('#afternoonLateTime').value,
        afternoon_end_time: $('#afternoonEndTime').value,
        debounce_sec: $('#setDebounce').value,
        notify_enabled: $('#setNotify').checked ? '1' : '0',
      },
    });
    $('#schoolName').textContent = settings.school_name;
    $('#setMsg').textContent = 'Saved.';
  } catch (err) {
    $('#setMsg').textContent = err.message;
  }
};

$('#accountForm').onsubmit = async (e) => {
  e.preventDefault();
  const message = $('#accountMsg');
  message.className = 'muted';
  try {
    const result = await api('/accounts', {
      method: 'PUT',
      body: {
        current_admin_password: $('#currentAdminPassword').value,
        admin_username: $('#adminUsername').value,
        admin_new_password: $('#adminNewPassword').value,
        user_username: $('#userUsername').value,
        user_new_password: $('#userNewPassword').value,
      },
    });
    token = result.token;
    username = result.admin_username;
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
    $('#adminUsername').value = result.admin_username;
    $('#userUsername').value = result.user_username;
    $('#currentAdminPassword').value = '';
    $('#adminNewPassword').value = '';
    $('#userNewPassword').value = '';
    message.textContent = 'Account changes saved.';
  } catch (err) {
    message.className = 'err';
    message.textContent = err.message;
  }
};

$('#clearAllData').onclick = async () => {
  if (!confirm('This permanently erases all saved records, previous account credentials, and settings from the database. Admin/user accounts will be recreated using configured credentials and settings will return to defaults. This cannot be undone. Continue?')) return;
  if (prompt('Type DELETE ALL to confirm permanently erasing all saved data.') !== 'DELETE ALL') {
    $('#clearAllDataMsg').textContent = 'Data clearing cancelled.';
    return;
  }

  const button = $('#clearAllData');
  button.disabled = true;
  $('#clearAllDataMsg').className = 'muted';
  $('#clearAllDataMsg').textContent = '';
  try {
    const result = await api('/data', { method: 'DELETE' });
    const total = Object.values(result.deleted).reduce((sum, count) => sum + count, 0);
    token = result.token;
    username = result.username;
    role = 'admin';
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
    localStorage.setItem('role', role);
    settings = await api('/settings');
    $('#schoolName').textContent = settings.school_name;
    $('#setName').value = settings.school_name;
    $('#morningLateTime').value = settings.morning_late_time;
    $('#morningEndTime').value = settings.morning_end_time;
    $('#afternoonLateTime').value = settings.afternoon_late_time;
    $('#afternoonEndTime').value = settings.afternoon_end_time;
    $('#setDebounce').value = settings.debounce_sec;
    $('#setNotify').checked = settings.notify_enabled === '1';
    selectedStudentIds.clear();
    $('#clearAllDataMsg').textContent = `All saved data erased (${total} records). Accounts were reset to configured credentials and settings returned to defaults.`;
    await Promise.all([
      loadOverview(),
      loadAttendance(),
      loadStudents(),
      loadRisk(),
      loadNotifications(),
      loadSettings(),
    ]);
  } catch (err) {
    $('#clearAllDataMsg').className = 'err';
    $('#clearAllDataMsg').textContent = `Could not clear saved data: ${err.message}`;
  } finally {
    button.disabled = false;
  }
};

$('#holForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/holidays', { method: 'POST', body: { date: $('#holDate').value, name: $('#holName').value } });
    $('#holForm').reset();
    loadSettings();
  } catch (err) {
    alert(err.message);
  }
};

boot();
