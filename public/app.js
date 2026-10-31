if (window.location.pathname === '/index.php') {
  window.location.replace('/');
}

const $ = (s) => document.querySelector(s);
function clearLoadError() {
  $('#loadError').textContent = '';
  $('#loadError').classList.add('hidden');
}
function showLoadError(error) {
  $('#loadError').textContent = error instanceof Error ? error.message : 'Could not load data';
  $('#loadError').classList.remove('hidden');
}
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

let rememberMe = localStorage.getItem('rememberMe') === 'true';
if (!rememberMe) {
  localStorage.removeItem('token');
  localStorage.removeItem('role');
  localStorage.removeItem('username');
}
const authStorage = () => rememberMe ? localStorage : sessionStorage;
const otherAuthStorage = () => rememberMe ? sessionStorage : localStorage;
let token = authStorage().getItem('token') || '';
let role = authStorage().getItem('role') || '';
let username = authStorage().getItem('username') || '';
$('#rememberMe').checked = rememberMe;
let settings = {};
let classes = [];
let students = [];
let selectedStudentIds = new Set();
let studentMarkMode = false;
let timer = null;
let userTimer = null;
let userHideTimer = null;
let userHidScanTimer = null;
let userHidScanInProgress = false;
let userHidScanBuffer = '';
let studentHidScanTimer = null;
let studentHidScanBuffer = '';
let studentHidScanLastKeyAt = 0;
let studentHidScanCapturing = false;
let studentHidScanTarget = null;
let studentHidScanOriginalValue = '';
let studentHidScanSelectionStart = 0;
let studentHidScanSelectionEnd = 0;
let cardWatchTimer = null;
let cardWatchInProgress = false;
let lastUserScanId = 0;
let lastUserAttemptId = 0;
const validTabs = new Set(['overview', 'attendance', 'students', 'risk', 'notifications', 'settings']);
const studentRouteMatch = window.location.pathname.match(/^\/students\/(\d+)\/?$/);
const initialStudentId = studentRouteMatch && Number.isSafeInteger(Number(studentRouteMatch[1])) &&
  Number(studentRouteMatch[1]) > 0
  ? Number(studentRouteMatch[1])
  : null;
const urlTab = new URLSearchParams(window.location.search).get('tab');
let currentTab = validTabs.has(urlTab)
  ? urlTab
  : sessionStorage.getItem('currentTab') || 'overview';
if (studentRouteMatch) currentTab = 'students';
let recoveryChallenge = '';
let recoveryQuestionIds = [];
let userAddMode = false;
const readOnlyApiCache = new Map();

// ---------- API ----------
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const cacheKey = `${token}:${path}`;
  const cacheablePath = method === 'GET' && ['/settings', '/classes', '/students'].includes(path);
  const cached = cacheablePath ? readOnlyApiCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (method !== 'GET') readOnlyApiCache.clear();

  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    readOnlyApiCache.clear();
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
  if (cacheablePath) {
    readOnlyApiCache.set(cacheKey, { data, expiresAt: Date.now() + 30_000 });
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
  clearTimeout(timer);
  clearTimeout(userTimer);
  clearTimeout(userHideTimer);
  $('#app').classList.add('hidden');
  $('#userApp').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const submitButton = $('#loginForm').querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Signing in...';
  $('#loginErr').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('#email').value.trim(),
        password: $('#pw').value,
        remember_me: $('#rememberMe').checked,
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Login failed');
    readOnlyApiCache.clear();
    token = d.token;
    role = d.role;
    username = d.username;
    rememberMe = $('#rememberMe').checked;
    const storage = authStorage();
    const otherStorage = otherAuthStorage();
    storage.setItem('token', token);
    storage.setItem('role', role);
    storage.setItem('username', username);
    otherStorage.removeItem('token');
    otherStorage.removeItem('role');
    otherStorage.removeItem('username');
    if (rememberMe) localStorage.setItem('rememberMe', 'true');
    else localStorage.removeItem('rememberMe');
    $('#email').value = '';
    $('#pw').value = '';
    hidePasswordFields($('#loginForm'));
    $('#loginErr').textContent = '';
    $('#loginErr').className = 'err';
    $('#adminRecovery').classList.add('hidden');
    await boot();
  } catch (err) {
    $('#loginErr').className = 'err';
    $('#loginErr').textContent = err.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Sign in';
  }
};

$('#openForgotPassword').onclick = () => {
  recoveryChallenge = '';
  recoveryQuestionIds = [];
  $('#recoveryLookupForm').reset();
  $('#recoveryResetForm').reset();
  $('#recoveryResetForm').classList.add('hidden');
  $('#recoveryLookupForm').classList.remove('hidden');
  $('#recoveryEmail').value = $('#email').value;
  $('#recoveryMsg').textContent = '';
  $('#loginForm').classList.add('hidden');
  $('#adminRecovery').classList.remove('hidden');
  $('#recoveryEmail').focus();
};

$('#backToLogin').onclick = () => {
  recoveryChallenge = '';
  recoveryQuestionIds = [];
  $('#adminRecovery').classList.add('hidden');
  $('#loginForm').classList.remove('hidden');
  $('#recoveryLookupForm').classList.remove('hidden');
  $('#recoveryResetForm').classList.add('hidden');
  $('#recoveryMsg').textContent = '';
  $('#email').focus();
};

$('#recoveryLookupForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('#recoveryLookupForm').querySelector('button[type="submit"]');
  button.disabled = true;
  $('#recoveryMsg').className = 'muted';
  $('#recoveryMsg').textContent = '';
  try {
    const response = await fetch('/api/admin/recovery/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#recoveryEmail').value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start password recovery');
    recoveryChallenge = result.challenge;
    recoveryQuestionIds = result.questions.map((item) => item.id);
    $('#recoveryQuestion1').textContent = result.questions[0].question;
    $('#recoveryQuestion2').textContent = result.questions[1].question;
    $('#recoveryLookupForm').classList.add('hidden');
    $('#recoveryResetForm').classList.remove('hidden');
    $('#recoveryMsg').textContent = '';
    $('#recoveryAnswer1').focus();
  } catch (error) {
    $('#recoveryMsg').className = 'err';
    $('#recoveryMsg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$('#recoveryResetForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('#recoveryResetForm').querySelector('button[type="submit"]');
  button.disabled = true;
  $('#recoveryMsg').className = 'muted';
  $('#recoveryMsg').textContent = '';
  try {
    const response = await fetch('/api/admin/recovery/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('#recoveryEmail').value.trim(),
        challenge: recoveryChallenge,
        question1: recoveryQuestionIds[0],
        answer1: $('#recoveryAnswer1').value,
        question2: recoveryQuestionIds[1],
        answer2: $('#recoveryAnswer2').value,
        new_password: $('#recoveryNewPassword').value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Password reset failed');
    const recoveredEmail = $('#recoveryEmail').value.trim();
    $('#backToLogin').click();
    $('#email').value = recoveredEmail;
    $('#loginErr').className = 'muted';
    $('#loginErr').textContent = 'Password reset. Sign in with your new password.';
  } catch (error) {
    $('#recoveryMsg').className = 'err';
    $('#recoveryMsg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

document.querySelectorAll('[data-password-toggle]').forEach((button) => {
  button.onclick = () => {
    const input = button.closest('.password-field').querySelector('input');
    const showingPassword = input.type === 'password';
    input.type = showingPassword ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(showingPassword));
    button.setAttribute('aria-label', showingPassword ? 'Hide password' : 'Show password');
  };
});

function hidePasswordFields(container) {
  container.querySelectorAll('[data-password-toggle]').forEach((button) => {
    const input = button.closest('.password-field').querySelector('input');
    input.type = 'password';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Show password');
  });
}

function logout() {
  readOnlyApiCache.clear();
  localStorage.removeItem('token');
  localStorage.removeItem('role');
  localStorage.removeItem('username');
  localStorage.removeItem('rememberMe');
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('role');
  sessionStorage.removeItem('username');
  $('#rememberMe').checked = false;
  rememberMe = false;
  token = '';
  role = '';
  username = '';
  clearTimeout(timer);
  clearTimeout(userTimer);
  clearTimeout(userHideTimer);
  showLogin();
}

$('#logout').onclick = logout;
$('#userLogout').onclick = logout;
$('#userAddStudentBtn').onclick = () => openUserStudentForm().catch((err) => {
  $('#userStatus').textContent = `Could not open the student form: ${err.message}`;
});
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

async function submitUserHidScan(rawUid) {
  const uid = rawUid.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{10}|[0-9A-F]{12}|[0-9A-F]{14}|[0-9A-F]{16}|[0-9A-F]{18}|[0-9A-F]{20})$/.test(uid)) {
    $('#userStatus').textContent = 'Could not read a valid card UID. Tap the card again.';
    return;
  }
  if (userHidScanInProgress) return;
  clearTimeout(userHidScanTimer);
  userHidScanInProgress = true;
  $('#userStatus').textContent = 'Submitting card scan...';
  try {
    await api('/user/tap', { method: 'POST', body: { uid } });
  } catch (error) {
    $('#userStatus').textContent = error.message;
  } finally {
    userHidScanInProgress = false;
  }
}

function finishUserHidScan() {
  clearTimeout(userHidScanTimer);
  const uid = userHidScanBuffer;
  userHidScanBuffer = '';
  if (uid) submitUserHidScan(uid);
}

function restoreStudentHidScanTarget() {
  const target = studentHidScanTarget;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  target.value = studentHidScanOriginalValue;
  if (studentHidScanTarget.selectionStart !== null) {
    target.setSelectionRange(studentHidScanSelectionStart, studentHidScanSelectionEnd);
  }
}

function finishStudentHidScan() {
  clearTimeout(studentHidScanTimer);
  if (studentHidScanCapturing) {
    const uid = studentHidScanBuffer.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (/^(?:[0-9A-F]{8}|[0-9A-F]{10}|[0-9A-F]{12}|[0-9A-F]{14}|[0-9A-F]{16}|[0-9A-F]{18}|[0-9A-F]{20})$/.test(uid)) {
      $('#sfUid').value = uid;
    } else {
      const target = studentHidScanTarget;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const start = studentHidScanSelectionStart;
        const end = studentHidScanSelectionEnd;
        target.value = studentHidScanOriginalValue.slice(0, start) +
          studentHidScanBuffer +
          studentHidScanOriginalValue.slice(end);
        const cursor = start + studentHidScanBuffer.length;
        if (target.selectionStart !== null) target.setSelectionRange(cursor, cursor);
      }
    }
  }
  studentHidScanBuffer = '';
  studentHidScanLastKeyAt = 0;
  studentHidScanCapturing = false;
  studentHidScanTarget = null;
}

function beginStudentHidScanCandidate(event, now) {
  studentHidScanBuffer = event.key;
  studentHidScanLastKeyAt = now;
  studentHidScanCapturing = false;
  studentHidScanTarget = event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ? event.target : null;
  studentHidScanOriginalValue = studentHidScanTarget ? studentHidScanTarget.value : '';
  studentHidScanSelectionStart = studentHidScanTarget?.selectionStart ?? 0;
  studentHidScanSelectionEnd = studentHidScanTarget?.selectionEnd ?? 0;
  clearTimeout(studentHidScanTimer);
  studentHidScanTimer = setTimeout(finishStudentHidScan, 150);
}

function captureStudentHidScanKey(event) {
  const now = Date.now();
  if (event.ctrlKey || event.altKey || event.metaKey) {
    finishStudentHidScan();
    return;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    if (studentHidScanCapturing) {
      event.preventDefault();
      finishStudentHidScan();
    } else {
      finishStudentHidScan();
    }
    return;
  }
  if (!/^[0-9a-f]$/i.test(event.key)) {
    finishStudentHidScan();
    return;
  }

  if (studentHidScanBuffer && now - studentHidScanLastKeyAt > 80) {
    finishStudentHidScan();
  }
  if (!studentHidScanBuffer) {
    beginStudentHidScanCandidate(event, now);
    return;
  }

  if (!studentHidScanCapturing) {
    studentHidScanCapturing = true;
    restoreStudentHidScanTarget();
  }
  event.preventDefault();
  studentHidScanBuffer += event.key;
  studentHidScanLastKeyAt = now;
  clearTimeout(studentHidScanTimer);
  studentHidScanTimer = setTimeout(finishStudentHidScan, 150);
}

document.addEventListener('keydown', (event) => {
  if (role !== 'user' || $('#userApp').classList.contains('hidden')) return;
  if (!$('#stuFormPanel').classList.contains('hidden') && userAddMode) {
    captureStudentHidScanKey(event);
    return;
  }
  if (!$('#stuFormPanel').classList.contains('hidden') ||
      event.ctrlKey || event.altKey || event.metaKey) return;

  const target = event.target;
  if (target instanceof HTMLElement &&
      (target.matches('input, textarea, select') || target.isContentEditable)) {
    clearTimeout(userHidScanTimer);
    userHidScanBuffer = '';
    return;
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    if (userHidScanBuffer) {
      event.preventDefault();
      finishUserHidScan();
    }
    return;
  }
  if (/^[0-9a-f]$/i.test(event.key)) {
    userHidScanBuffer += event.key;
    clearTimeout(userHidScanTimer);
    userHidScanTimer = setTimeout(finishUserHidScan, 250);
  } else if (!['Shift', 'CapsLock', 'Control', 'Alt', 'Meta'].includes(event.key) &&
      !/^[\s:-]$/.test(event.key)) {
    clearTimeout(userHidScanTimer);
    userHidScanBuffer = '';
  }
});

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
    scheduleUserPoll();
    return;
  }
  try {
    [settings] = await Promise.all([
      api('/settings'),
      refreshLookups(),
    ]);
  } catch (err) {
    if (err.status === 403) logout();
    return;
  }
  $('#schoolName').textContent = settings.school_name;
  document.title = settings.school_name + ' - RFID Attendance';
  showTab(currentTab);
  $('#login').classList.add('hidden');
  $('#userApp').classList.add('hidden');
  $('#app').classList.remove('hidden');
  if (initialStudentId) {
    await showStudentDetails(initialStudentId).catch((error) => {
      $('#studentDetailsMsg').textContent = error.message;
    });
  }
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
    if (student.code === 'UNKNOWN_CARD' && !userAddMode && $('#stuFormPanel').classList.contains('hidden')) {
      $('#userStatus').textContent = 'Unregistered card detected. Opening student enrollment...';
      openUserStudentForm(student.uid).catch((error) => {
        $('#userStatus').textContent = `Could not open student enrollment: ${error.message}`;
      });
      return;
    }
    clearTimeout(userHideTimer);
    userHideTimer = setTimeout(hideUserStudent, 10000);
    return;
  }
  $('#userStatus').textContent = 'Student scan detected';
  $('#userStudentDetails').classList.remove('hidden');
  $('#userStudentName').textContent = student.display_name || student.name;
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
  $('#userStatus').textContent = 'Waiting for a card tap...';
}

function scheduleUserPoll() {
  userTimer = setTimeout(async () => {
    try {
      await pollUserScreen();
    } catch (error) {
      $('#userStatus').textContent = error.message;
    } finally {
      if (role === 'user' && !$('#userApp').classList.contains('hidden')) scheduleUserPoll();
    }
  }, 2000);
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
    .filter((s) => s.has_rfid_uid)
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
const skeletonRows = (count = 6) => Array.from(
  { length: count },
  () => '<span class="skeleton-block skeleton-row"></span>'
).join('');
const skeletonHeading = '<span class="skeleton-block skeleton-heading"></span>';
const skeletonLayouts = {
  overview: `
    <div class="skeleton-cards">${Array.from({ length: 4 }, () => `
      <div class="skeleton-card">
        <span class="skeleton-block skeleton-label"></span>
        <span class="skeleton-block skeleton-value"></span>
      </div>`).join('')}
    </div>
    <div class="skeleton-content-grid">
      <div class="skeleton-panel skeleton-panel-large">${skeletonHeading}${skeletonRows(5)}</div>
      <div class="skeleton-sidebar">
        <div class="skeleton-panel">${skeletonHeading}${skeletonRows(3)}</div>
        <div class="skeleton-panel skeleton-panel-short">${skeletonHeading}${skeletonRows(1)}</div>
      </div>
    </div>`,
  attendance: `
    <div class="skeleton-toolbar">
      <span class="skeleton-block skeleton-heading"></span>
      <span class="skeleton-block skeleton-control"></span>
    </div>
    <div class="skeleton-panel skeleton-table">${skeletonRows(9)}</div>`,
  students: `
    <div class="skeleton-toolbar">
      <span class="skeleton-block skeleton-heading"></span>
      <span class="skeleton-block skeleton-control"></span>
      <span class="skeleton-block skeleton-control"></span>
    </div>
    <div class="skeleton-panel skeleton-table">${skeletonRows(8)}</div>`,
  risk: `
    <div class="skeleton-toolbar">
      <span class="skeleton-block skeleton-heading"></span>
      <span class="skeleton-block skeleton-control"></span>
    </div>
    <div class="skeleton-cards">${Array.from({ length: 3 }, () => `
      <div class="skeleton-card">
        <span class="skeleton-block skeleton-label"></span>
        <span class="skeleton-block skeleton-value"></span>
      </div>`).join('')}
    </div>
    <div class="skeleton-panel skeleton-table">${skeletonRows(7)}</div>`,
  notifications: `
    <div class="skeleton-toolbar">
      <span class="skeleton-block skeleton-heading"></span>
      <span class="skeleton-block skeleton-control"></span>
    </div>
    <div class="skeleton-panel skeleton-table">${skeletonRows(8)}</div>`,
  settings: `
    <div class="skeleton-toolbar">
      <span class="skeleton-block skeleton-heading"></span>
    </div>
    <div class="skeleton-settings-grid">
      <div class="skeleton-panel">${skeletonHeading}${skeletonRows(5)}</div>
      <div class="skeleton-panel">${skeletonHeading}${skeletonRows(5)}</div>
      <div class="skeleton-panel">${skeletonHeading}${skeletonRows(4)}</div>
      <div class="skeleton-panel">${skeletonHeading}${skeletonRows(4)}</div>
    </div>`,
};
function showTabSkeleton(name) {
  const skeleton = $('#loadingSkeleton');
  skeleton.dataset.tab = name;
  skeleton.innerHTML = skeletonLayouts[name];
}
let tabLoadId = 0;

function scheduleOverviewRefresh() {
  timer = setTimeout(async () => {
    if (currentTab !== 'overview') return;
    try {
      await loadOverview();
      clearLoadError();
    } catch (error) {
      showLoadError(error);
    } finally {
      if (currentTab === 'overview') scheduleOverviewRefresh();
    }
  }, 15000);
}

function showTab(name, updateUrl = false) {
  if (!validTabs.has(name)) name = 'overview';
  currentTab = name;
  sessionStorage.setItem('currentTab', name);
  if (updateUrl) {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('tab', name);
    window.history.pushState({ tab: name }, '', url);
  }
  closeStudentDetails(false);
  $('#app').classList.remove('nav-open');
  $('#navToggle').setAttribute('aria-expanded', 'false');
  $('#navToggle').setAttribute('aria-label', 'Open navigation');
  clearTimeout(timer);
  clearLoadError();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const loadId = ++tabLoadId;
  const tabName = document.querySelector(`#tabs [data-tab="${name}"]`)?.textContent.trim() || 'page';
  showTabSkeleton(name);
  $('#tabLoadingMessage').textContent = `Loading ${tabName}...`;
  $('#tabLoading').classList.remove('hidden');
  $('#app > main').setAttribute('aria-busy', 'true');
  loaders[name]().then(() => {
    if (loadId !== tabLoadId) return;
    clearLoadError();
  }).catch((error) => {
    if (loadId === tabLoadId) showLoadError(error);
  }).finally(() => {
    if (loadId !== tabLoadId) return;
    $('#tabLoading').classList.add('hidden');
    $('#app > main').setAttribute('aria-busy', 'false');
    if (name === 'overview') scheduleOverviewRefresh();
  });
}
document.querySelectorAll('#tabs [data-tab]').forEach((button) => {
  button.onclick = (event) => {
    event.preventDefault();
    showTab(button.dataset.tab, true);
  };
});
window.addEventListener('popstate', () => {
  const studentMatch = window.location.pathname.match(/^\/students\/(\d+)\/?$/);
  if (studentMatch) {
    showTab('students');
    showStudentDetails(Number(studentMatch[1])).catch((error) => {
      $('#studentDetailsMsg').textContent = error.message;
    });
    return;
  }
  closeStudentDetails(false);
  const name = new URLSearchParams(window.location.search).get('tab');
  showTab(validTabs.has(name) ? name : 'overview');
});
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
    ['warn', t.halfDay, 'Half day'],
    ['bad', t.notIn, 'Not yet in / absent'],
    ['', t.inCampus, 'On campus now'],
  ]
    .map(([c, n, l]) => `<div class="card ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`)
    .join('');

  $('#byClass').innerHTML =
    '<tr><th>Section</th><th class="num">On time</th><th class="num">Late</th><th class="num">Half day</th><th class="num">Not in</th><th class="num">Total</th></tr>' +
    (today.classes
      .map(
        (c) =>
          `<tr><td>${esc(clsLabel(c))}</td><td class="num">${c.present}</td><td class="num">${c.late}</td><td class="num">${c.halfDay}</td><td class="num">${c.notIn}</td><td class="num">${c.enrolled}</td></tr>`
      )
      .join('') || '<tr><td colspan="6" class="muted">No student data yet.</td></tr>');

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
  if (!confirm('Send configured absence notifications to opted-in parents of students with no tap today?')) return;
  try {
    const r = await api('/notify-absent', { method: 'POST' });
    alert(`${r.checked} absent student(s) checked, ${r.sent} notification(s) sent to opted-in parents.`);
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
      ['half_day', 'Half day'],
      ['absent', 'Absent'],
    ]
      .map(([key, label]) => `<div class="card ${key === 'late' || key === 'half_day' ? 'warn' : key === 'absent' ? 'bad' : 'ok'}"><div class="n">${report.totals[key]}</div><div class="l">${label}</div></div>`)
      .join('');
    $('#studentAttendanceTable').innerHTML =
      '<tr><th>Date</th><th>Day</th><th>Morning in</th><th>Morning out</th><th>Afternoon in</th><th>Afternoon out</th><th>Status</th></tr>' +
      report.days
        .map((day) =>
          `<tr><td>${esc(day.date)}</td><td>${esc(day.weekday)}</td>
           <td>${esc(hhmm(day.morning_in))}</td><td>${esc(hhmm(day.morning_out))}</td>
           <td>${esc(hhmm(day.afternoon_in))}</td><td>${esc(hhmm(day.afternoon_out))}</td>
           <td>${badge(day.status === 'present' ? 'present' : day.status === 'late' ? 'late' : day.status === 'half day' ? 'half-day' : day.status === 'absent' ? 'absent' : '', day.status)}</td></tr>`
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
$('#attDate').onchange = () => loadAttendance().then(clearLoadError).catch(showLoadError);
$('#attClass').onchange = () => loadAttendance().then(clearLoadError).catch(showLoadError);
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
    `<tr>${studentMarkMode ? '<th></th>' : ''}<th>Name</th><th>Section</th><th>Card</th><th>SMS</th><th>Email</th><th></th></tr>` +
    (visibleStudents
      .map(
        (s) =>
          `<tr>${studentMarkMode ? `<td><input type="checkbox" aria-label="Mark ${esc(s.display_name || s.name)} for removal" data-select-student="${s.id}" ${selectedStudentIds.has(s.id) ? 'checked' : ''}></td>` : ''}
           <td><a class="student-attendance-link" data-student-detail="${s.id}" href="/students/${s.id}">${esc(s.display_name || s.name)}</a></td>
           <td>${esc(clsLabel(s))}</td>
           <td>${s.has_rfid_uid ? '<span class="muted">RFID protected</span>' : '<span class="muted">none</span>'}</td>
           <td>${s.has_sms_contact ? badge('present', 'consented') : badge('absent', 'no consent')}</td>
           <td>${s.has_email_contact ? badge('present', 'consented') : badge('absent', 'no consent')}</td>
           <td><button class="small ghost" data-edit="${s.id}">Edit</button>
               <button class="small ghost" data-del="${s.id}">Remove</button></td></tr>`
      )
      .join('') || `<tr><td colspan="${studentMarkMode ? 7 : 6}" class="muted">No students saved yet.</td></tr>`);
  $('#stuTable').querySelectorAll('[data-student-detail]').forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      showStudentDetails(Number(link.dataset.studentDetail), true).catch((error) => {
        $('#studentDetailsMsg').textContent = error.message;
      });
    };
  });
  $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
    checkbox.onchange = () => {
      const id = Number(checkbox.dataset.selectStudent);
      if (checkbox.checked) selectedStudentIds.add(id);
      else selectedStudentIds.delete(id);
      updateStudentSelection(visibleStudents);
    };
  });
  $('#stuTable').querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => editStudent(Number(button.dataset.edit)).catch((error) => {
      $('#stuRemoveMsg').textContent = `Could not open student details: ${error.message}`;
    });
  });
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

async function showStudentDetails(id, updateUrl = false) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid student id');
  if (updateUrl) {
    window.history.pushState({ studentId: id }, '', `/students/${id}`);
  }
  const student = students.find((item) => item.id === id);
  $('#studentDetailsTitle').textContent = student?.display_name || student?.name || 'Student details';
  $('#studentDetailsMsg').textContent = 'Loading student details...';
  $('#studentDetailsPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#studentDetailsEdit').dataset.studentId = String(id);
  const details = await api(`/students/${id}`);
  $('#studentDetailsTitle').textContent = details.display_name || details.name;
  $('#studentDetailsLrn').textContent = details.lrn || '-';
  $('#studentDetailsSection').textContent = clsLabel(details);
  $('#studentDetailsCard').textContent = details.rfid_uid || 'No card assigned';
  $('#studentDetailsParent').textContent = details.parent_name || '-';
  $('#studentDetailsPhone').textContent = details.parent_phone || '-';
  $('#studentDetailsConsent').textContent = details.consent ? 'Yes' : 'No';
  $('#studentDetailsEmail').textContent = details.parent_email || '-';
  $('#studentDetailsEmailConsent').textContent = details.email_consent ? 'Yes' : 'No';
  $('#studentDetailsMsg').textContent = '';
}

function closeStudentDetails(updateUrl = false) {
  $('#studentDetailsPanel').classList.add('hidden');
  document.body.classList.remove('modal-open');
  if (updateUrl && window.location.pathname.match(/^\/students\/\d+\/?$/)) {
    window.history.pushState({ tab: 'students' }, '', '/?tab=students');
  }
}

$('#studentDetailsClose').onclick = () => closeStudentDetails(true);
$('#studentDetailsPanel').onclick = (event) => {
  if (event.target === $('#studentDetailsPanel')) closeStudentDetails(true);
};
$('#studentDetailsEdit').onclick = () => {
  const id = Number($('#studentDetailsEdit').dataset.studentId);
  closeStudentDetails(false);
  editStudent(id).catch((error) => {
    $('#stuRemoveMsg').textContent = `Could not open student details: ${error.message}`;
  });
};

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
    await loadStudents().catch((refreshError) => {
      $('#stuRemoveMsg').textContent += ` The student list could not be refreshed: ${refreshError.message}`;
    });
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

async function startCardWatch() {
  clearInterval(cardWatchTimer);
  cardWatchTimer = null;
  const baseline = await api('/user/latest?after=0');
  let scanCursor = Number(baseline.scan_cursor) || 0;
  let attemptCursor = Number(baseline.attempt_cursor) || 0;
  cardWatchTimer = setInterval(async () => {
    if (cardWatchInProgress || $('#stuFormPanel').classList.contains('hidden')) return;
    cardWatchInProgress = true;
    try {
      const result = await api(`/user/latest?after=${scanCursor}&attempt_after=${attemptCursor}`);
      scanCursor = Number(result.scan_cursor) || scanCursor;
      attemptCursor = Number(result.attempt_cursor) || attemptCursor;
      const scan = result.latest;
      if (!scan || !scan.uid) return;
      if (scan.code === 'UNKNOWN_CARD') {
        if (!$('#sfUid').value) {
          $('#sfUid').value = scan.uid;
          $('#sfMsg').className = 'muted';
          $('#sfMsg').textContent = `Card ${scan.uid} detected and added to the form.`;
        }
      } else if (scan.uid && scan.code !== 'UNKNOWN_CARD') {
        $('#sfMsg').className = 'err';
        $('#sfMsg').textContent = 'This RFID card is already registered. Contact the admin to update the RFID.';
      }
    } catch (error) {
      $('#sfMsg').className = 'err';
      $('#sfMsg').textContent = `Could not check for a scanned RFID card: ${error.message}`;
    } finally {
      cardWatchInProgress = false;
    }
  }, 500);
}

function showStudentForm() {
  $('#stuFormPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#sfSurname').focus();
}

async function openUserStudentForm(rfidUid = '') {
  userAddMode = true;
  clearForm();
  userAddMode = true;
  const userClasses = await api('/classes');
  await startCardWatch();
  $('#sfClass').innerHTML = '<option value="">Choose a grade and section</option>' +
    userClasses.map((section) => `<option value="${section.grade}::${esc(section.section)}">${esc(clsLabel(section))}</option>`).join('');
  $('#formTitle').textContent = 'Add student';
  $('#sfHelp').textContent = 'Choose a section already created by the admin. Existing student names and RFID cards cannot be changed here; contact the admin for updates.';
  $('#sfHelp').classList.remove('hidden');
  $('#unknownBox').classList.add('hidden');
  $('#sfUid').value = rfidUid;
  if (rfidUid) {
    $('#sfMsg').className = 'muted';
    $('#sfMsg').textContent = `Unregistered RFID card ${rfidUid} detected. Complete the form to enroll this student.`;
  }
  $('#stuFormPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#sfSurname').focus();
  $('#userApp').classList.remove('nav-open');
  $('#userNavToggle').setAttribute('aria-expanded', 'false');
  $('#userNavToggle').setAttribute('aria-label', 'Open navigation');
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
  startCardWatch().then(showStudentForm).catch((error) => {
    $('#sfMsg').className = 'err';
    $('#sfMsg').textContent = `Could not start RFID card detection: ${error.message}`;
    showStudentForm();
  });
};

async function editStudent(id) {
  const s = students.find((x) => x.id === id);
  if (!s) return;
  const details = await api(`/students/${id}`);
  if ($('#app').classList.contains('hidden')) return;
  clearInterval(cardWatchTimer);
  cardWatchTimer = null;
  showStudentForm();
  $('#formTitle').textContent = 'Edit student';
  $('#sfId').value = s.id;
  $('#sfLrn').value = details.lrn || '';
  $('#sfSurname').value = s.surname || '';
  $('#sfFirstName').value = s.first_name || (s.surname ? '' : s.name);
  $('#sfMiddleName').value = s.middle_name || '';
  $('#sfNameExtension').value = s.name_extension || '';
  $('#sfClass').value = `${s.grade}::${s.section}`;
  $('#sfUid').value = details.rfid_uid || '';
  $('#sfParent').value = details.parent_name || '';
  $('#sfPhone').value = details.parent_phone || '';
  $('#sfConsent').checked = !!details.consent;
  $('#sfEmail').value = details.parent_email || '';
  $('#sfEmailConsent').checked = !!details.email_consent;
  $('#sfMsg').className = 'err';
  $('#sfMsg').textContent = '';
}

function clearForm() {
  clearInterval(cardWatchTimer);
  cardWatchTimer = null;
  cardWatchInProgress = false;
  userAddMode = false;
  $('#formTitle').textContent = 'Add student';
  $('#sfHelp').classList.add('hidden');
  $('#unknownBox').classList.remove('hidden');
  $('#stuForm').reset();
  $('#sfId').value = '';
  $('#sfMsg').className = 'err';
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
  else if (!$('#studentDetailsPanel').classList.contains('hidden')) closeStudentDetails(true);
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
    parent_email: $('#sfEmail').value,
    email_consent: $('#sfEmailConsent').checked,
  };
  const id = $('#sfId').value;
  try {
    if (userAddMode) {
      await api('/user/students', { method: 'POST', body });
      clearForm();
      $('#userStatus').textContent = 'Student added successfully. The student is now available to the admin.';
      return;
    }
    await api(id ? '/students/' + id : '/students', { method: id ? 'PUT' : 'POST', body });
    clearForm();
    loadStudents();
  } catch (err) {
    $('#sfMsg').className = 'err';
    $('#sfMsg').textContent = err.message;
    $('#sfMsg').classList.toggle(
      'student-enrollment-error',
      userAddMode && err.status === 409 && /already enrolled/i.test(err.message)
    );
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
$('#riskFilter').onchange = () => loadRisk().then(clearLoadError).catch(showLoadError);
$('#riskMonth').onchange = () => loadRisk().then(clearLoadError).catch(showLoadError);
$('#riskExport').onclick = () => {
  const month = encodeURIComponent($('#riskMonth').value);
  download(`/export/risk.csv?month=${month}`, `early-warning-${$('#riskMonth').value}.csv`).catch((e) => alert(e.message));
};

// ---------- notifications ----------
async function loadNotifications() {
  const rows = await api('/notifications');
  $('#notifTable').innerHTML =
    '<tr><th>Time</th><th>Student</th><th>Channel</th><th>To</th><th>Message</th><th>Status</th></tr>' +
    (rows
      .map(
        (n) =>
          `<tr><td>${esc((n.ts || '').replace('T', ' '))}</td><td>${esc(n.name)}</td><td>${esc(n.channel || 'sms')}</td><td>${esc(n.recipient || n.phone || '')}</td>
           <td>${esc(n.message)}</td>
           <td>${badge(String(n.status).startsWith('failed') ? 'failed' : 'sent', n.status)}<br><small class="muted">${esc(n.provider)}</small></td></tr>`
      )
      .join('') || '<tr><td colspan="6" class="muted">No messages yet.</td></tr>');
}

$('#deleteAllSms').onclick = async () => {
  if (!confirm('Permanently delete all notification log entries? This does not recall messages already sent.')) return;
  const button = $('#deleteAllSms');
  button.disabled = true;
  $('#smsDeleteMsg').textContent = '';
  try {
    const result = await api('/notifications', { method: 'DELETE' });
    $('#smsDeleteMsg').textContent = `${result.deleted} notification log entr${result.deleted === 1 ? 'y' : 'ies'} deleted.`;
    await loadNotifications();
  } catch (err) {
    $('#smsDeleteMsg').textContent = err.status === 404
      ? 'This server does not support deleting notification logs yet. Restart the server with npm start, then reload this page.'
      : `Could not delete notification logs: ${err.message}`;
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

let accountToastTimer;
function showAccountToast(message) {
  const toast = $('#accountToast');
  clearTimeout(accountToastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  accountToastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function closeAccountModal() {
  hidePasswordFields($('#accountModal'));
  $('#recoverySettingsAnswer1').value = '';
  $('#recoverySettingsAnswer2').value = '';
  $('#recoverySettingsCurrentPassword').value = '';
  $('#accountModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  $('#openAccountModal').focus();
}

$('#openAccountModal').onclick = async () => {
  const message = $('#accountMsg');
  message.className = 'muted';
  message.textContent = '';
  try {
    const [accounts, recovery] = await Promise.all([
      api('/accounts'),
      api('/admin/recovery'),
    ]);
    $('#adminEmail').value = accounts.admin_email;
    $('#userEmail').value = accounts.user_email;
    $('#currentAdminPassword').value = '';
    $('#adminNewPassword').value = '';
    $('#userNewPassword').value = '';
    $('#recoveryQuestionSelect1').value = recovery.questions[0]?.id || '';
    $('#recoveryQuestionSelect2').value = recovery.questions[1]?.id || '';
    $('#recoverySettingsAnswer1').value = '';
    $('#recoverySettingsAnswer2').value = '';
    $('#recoverySettingsCurrentPassword').value = '';
    $('#recoverySettingsMsg').className = 'muted';
    $('#recoverySettingsMsg').textContent = recovery.configured
      ? 'Recovery questions are configured. Save new answers to replace them.'
      : 'Recovery questions are not configured. Set them up to enable password recovery.';
    hidePasswordFields($('#accountModal'));
    $('#accountModal').classList.remove('hidden');
    document.body.classList.add('modal-open');
    $('#currentAdminPassword').focus();
  } catch (err) {
    message.className = 'err';
    message.textContent = `Could not load account names: ${err.message}`;
  }
};

async function saveRecoverySettings(remove = false) {
  const button = remove ? $('#clearRecoverySettings') : $('#recoverySettingsForm').querySelector('button[type="submit"]');
  const message = $('#recoverySettingsMsg');
  button.disabled = true;
  message.className = 'muted';
  message.textContent = '';
  try {
    const result = await api('/admin/recovery', {
      method: 'PUT',
      body: {
        current_password: $('#recoverySettingsCurrentPassword').value,
        question1: remove ? '' : $('#recoveryQuestionSelect1').value,
        answer1: remove ? '' : $('#recoverySettingsAnswer1').value,
        question2: remove ? '' : $('#recoveryQuestionSelect2').value,
        answer2: remove ? '' : $('#recoverySettingsAnswer2').value,
      },
    });
    $('#recoverySettingsAnswer1').value = '';
    $('#recoverySettingsAnswer2').value = '';
    $('#recoverySettingsCurrentPassword').value = '';
    if (remove) {
      $('#recoveryQuestionSelect1').value = '';
      $('#recoveryQuestionSelect2').value = '';
    }
    message.textContent = result.configured
      ? 'Password recovery questions saved.'
      : 'Password recovery questions removed.';
    closeAccountModal();
    showAccountToast(message.textContent);
  } catch (error) {
    message.className = 'err';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$('#recoverySettingsForm').onsubmit = async (event) => {
  event.preventDefault();
  await saveRecoverySettings();
};
$('#clearRecoverySettings').onclick = async () => {
  await saveRecoverySettings(true);
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
  $('#setEmailNotify').checked = settings.email_notify_enabled === '1';
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
        email_notify_enabled: $('#setEmailNotify').checked ? '1' : '0',
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
        admin_email: $('#adminEmail').value,
        admin_new_password: $('#adminNewPassword').value,
        user_email: $('#userEmail').value,
        user_new_password: $('#userNewPassword').value,
      },
    });
    token = result.token;
    username = result.admin_email;
    const storage = authStorage();
    storage.setItem('token', token);
    storage.setItem('username', username);
    $('#adminEmail').value = result.admin_email;
    $('#userEmail').value = result.user_email;
    $('#currentAdminPassword').value = '';
    $('#adminNewPassword').value = '';
    $('#userNewPassword').value = '';
    closeAccountModal();
    showAccountToast('Account changes saved.');
  } catch (err) {
    message.className = 'err';
    message.textContent = err.message;
  }
};

$('#clearAllData').onclick = async () => {
  if (!confirm('This permanently erases all saved records, including notification logs, previous account credentials, and settings from the database. Admin/user accounts will be recreated using configured credentials and settings will return to defaults. This cannot be undone. Continue?')) return;
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
    const storage = authStorage();
    storage.setItem('token', token);
    storage.setItem('username', username);
    storage.setItem('role', role);
    settings = await api('/settings');
    $('#schoolName').textContent = settings.school_name;
    $('#setName').value = settings.school_name;
    $('#morningLateTime').value = settings.morning_late_time;
    $('#morningEndTime').value = settings.morning_end_time;
    $('#afternoonLateTime').value = settings.afternoon_late_time;
    $('#afternoonEndTime').value = settings.afternoon_end_time;
    $('#setDebounce').value = settings.debounce_sec;
    $('#setNotify').checked = settings.notify_enabled === '1';
    $('#setEmailNotify').checked = settings.email_notify_enabled === '1';
    selectedStudentIds.clear();
    const notificationCount = Number(result.deleted.notifications) || 0;
    $('#clearAllDataMsg').textContent = `All saved data erased (${total} records), including ${notificationCount} notification log entr${notificationCount === 1 ? 'y' : 'ies'}. Accounts were reset to configured credentials and settings returned to defaults.`;
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
