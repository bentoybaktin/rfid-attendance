if (window.location.pathname === '/index.php') {
  window.location.replace('/');
}

const $ = (s) => document.querySelector(s);
const userClockFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});
const userDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const scanDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeZone: 'UTC',
});
function clearLoadError() {
  $('#loadErrorMessage').textContent = '';
  $('#loadErrorCause').textContent = '';
  $('#loadError').classList.add('hidden');
  if ($('#userNoticeTitle').textContent === 'Could not load data') {
    clearTimeout(userNoticeTimer);
    $('#userNotice').classList.add('hidden');
  }
}
function showLoadError(error) {
  const tabName = document.querySelector(`#tabs [data-tab="${currentTab}"]`)?.textContent.trim() || 'page';
  const detail = error instanceof Error ? error.message : 'The request did not complete.';
  let cause = 'The server rejected this request. Check the selected date or filters, or ask an administrator to confirm your access.';
  if (error instanceof TypeError) {
    cause = 'Connection issue: your browser could not reach the attendance server. Check your connection and confirm the server is running.';
  } else if (error && error.status >= 500) {
    cause = 'Server issue: the attendance service failed while preparing this data. This is not caused by your form entry; contact the school administrator if it continues.';
  } else if (error && (error.status === 401 || error.status === 403)) {
    cause = 'Account or permission issue: this account cannot access the requested data. Sign in again or ask an administrator to confirm your access.';
  } else if (error && error.status === 404) {
    cause = 'The attendance server does not have this endpoint available. Restart it with the current app version and reload this page.';
  }
  $('#loadErrorTitle').textContent = `We couldn't load ${tabName.toLowerCase()}`;
  $('#loadErrorMessage').textContent = detail;
  $('#loadErrorCause').textContent = cause;
  $('#retryTabLoad').textContent = `Retry ${tabName.toLowerCase()}`;
  $('#loadError').classList.remove('hidden');
  showUserNotice('error', 'Could not load data', operationError(error, `load ${tabName.toLowerCase()}`, 'check your filters and retry'));
}
function emptyState(title, reason, action = '') {
  const actionMarkup = action
    ? `<button type="button" class="ghost" data-empty-action="${esc(action)}">${action === 'add-section' ? 'Add a section' : action === 'add-student' ? 'Add a student' : action === 'show-all-students' ? 'Show all sections' : action === 'review-all-risk' ? 'Review everyone' : 'Continue'}</button>`
    : '';
  return `<div class="empty-state"><strong>${esc(title)}</strong><p>${esc(reason)}</p>${actionMarkup}</div>`;
}
function emptyTableRow(columns, title, reason, action = '') {
  return `<tr><td colspan="${columns}">${emptyState(title, reason, action)}</td></tr>`;
}
function getSectionDropdown(select) {
  const wrapper = select.closest('.section-dropdown');
  return wrapper ? {
    wrapper,
    trigger: wrapper.querySelector('.section-dropdown-trigger'),
    menu: document.getElementById(select.dataset.dropdownMenuId),
  } : null;
}
function closeSectionDropdown(select, returnFocus = false) {
  const dropdown = getSectionDropdown(select);
  if (!dropdown) return;
  dropdown.menu.classList.add('hidden');
  dropdown.trigger.setAttribute('aria-expanded', 'false');
  dropdown.wrapper.classList.remove('is-open');
  if (returnFocus) dropdown.trigger.focus();
}
function moveFocusFromSectionDropdown(select, backwards) {
  const dropdown = getSectionDropdown(select);
  if (!dropdown) return;
  closeSectionDropdown(select);
  const focusable = Array.from(document.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) =>
    element.getClientRects().length &&
    !element.closest('.hidden') &&
    !dropdown.menu.contains(element)
  );
  const currentIndex = focusable.indexOf(dropdown.trigger);
  focusable[currentIndex + (backwards ? -1 : 1)]?.focus();
}
let sectionDropdownSearch = '';
let sectionDropdownSearchTimer;
function searchSectionDropdown(select, key, currentIndex = -1) {
  clearTimeout(sectionDropdownSearchTimer);
  sectionDropdownSearch += key.toLocaleLowerCase();
  sectionDropdownSearchTimer = setTimeout(() => { sectionDropdownSearch = ''; }, 700);
  const options = Array.from(getSectionDropdown(select).menu.querySelectorAll('[role="option"]'));
  const start = Math.max(0, currentIndex + 1);
  const match = options.slice(start).concat(options.slice(0, start))
    .find((option) => option.textContent.trim().toLocaleLowerCase().startsWith(sectionDropdownSearch));
  match?.focus();
  match?.scrollIntoView({ block: 'nearest' });
}
function updateSectionDropdown(select) {
  const dropdown = getSectionDropdown(select);
  if (!dropdown) return;
  const selected = select.selectedOptions[0];
  dropdown.trigger.textContent = selected?.textContent || 'Choose a section';
  dropdown.trigger.title = dropdown.trigger.textContent;
  dropdown.trigger.disabled = select.disabled;
  dropdown.menu.replaceChildren();
  Array.from(select.options).forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'section-dropdown-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.textContent = option.textContent;
    item.title = option.textContent;
    item.dataset.optionIndex = String(index);
    item.addEventListener('click', () => {
      select.selectedIndex = index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      updateSectionDropdown(select);
      if (select.form?.dataset.validationSequence) {
        const nextField = firstInvalidField(select.form);
        if (nextField) {
          showFieldValidation(nextField);
          focusValidationField(nextField);
        } else {
          delete select.form.dataset.validationSequence;
          closeSectionDropdown(select, true);
        }
      } else {
        closeSectionDropdown(select, true);
      }
    });
    dropdown.menu.appendChild(item);
  });
  if (dropdown.trigger.getAttribute('aria-expanded') === 'true') positionSectionDropdown(select);
}
function positionSectionDropdown(select) {
  const dropdown = getSectionDropdown(select);
  if (!dropdown) return;
  const rect = dropdown.trigger.getBoundingClientRect();
  const menu = dropdown.menu;
  const desiredHeight = Math.min(menu.scrollHeight, 200);
  const spaceBelow = window.innerHeight - rect.bottom;
  const openAbove = spaceBelow < desiredHeight && rect.top > spaceBelow;
  const availableSpace = openAbove ? rect.top : spaceBelow;
  menu.style.maxHeight = `${Math.max(80, Math.min(200, availableSpace - 8))}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${openAbove ? Math.max(8, rect.top - Math.min(desiredHeight, availableSpace - 8)) : rect.bottom + 4}px`;
  menu.style.width = `${rect.width}px`;
}
function openSectionDropdown(select, focusIndex = -1) {
  const dropdown = getSectionDropdown(select);
  if (!dropdown || select.disabled) return;
  document.querySelectorAll('.section-dropdown-trigger[aria-expanded="true"]').forEach((trigger) => {
    if (trigger !== dropdown.trigger) {
      const other = document.getElementById(trigger.dataset.selectId);
      if (other) closeSectionDropdown(other);
    }
  });
  updateSectionDropdown(select);
  dropdown.menu.classList.remove('hidden');
  dropdown.trigger.setAttribute('aria-expanded', 'true');
  dropdown.wrapper.classList.add('is-open');
  positionSectionDropdown(select);
  if (focusIndex >= 0) dropdown.menu.querySelectorAll('[role="option"]')[focusIndex]?.focus();
  else dropdown.menu.querySelectorAll('[role="option"]')[select.selectedIndex]?.scrollIntoView({ block: 'nearest' });
}
function enhanceSectionDropdown(select) {
  if (getSectionDropdown(select)) {
    updateSectionDropdown(select);
    return;
  }
  const wrapper = document.createElement('span');
  wrapper.className = 'section-dropdown';
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add('section-dropdown-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const label = select.labels?.[0];
  const labelText = label
    ? Array.from(label.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ').trim()
    : 'Section';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'section-dropdown-trigger';
  trigger.id = `${select.id}Control`;
  trigger.dataset.selectId = select.id;
  const menu = document.createElement('div');
  menu.id = `${select.id}Options`;
  menu.className = 'section-dropdown-menu hidden';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', labelText || 'Section');
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-required', String(select.required));
  trigger.setAttribute('aria-label', labelText || 'Section');
  select.dataset.dropdownMenuId = menu.id;
  wrapper.appendChild(trigger);
  document.body.appendChild(menu);

  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') closeSectionDropdown(select);
    else openSectionDropdown(select);
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSectionDropdown(select, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openSectionDropdown(select, select.options.length - 1);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      openSectionDropdown(select);
      searchSectionDropdown(select, event.key);
    }
  });
  menu.addEventListener('keydown', (event) => {
    const options = Array.from(menu.querySelectorAll('[role="option"]'));
    const currentIndex = options.indexOf(document.activeElement);
    let targetIndex = currentIndex;
    if (event.key === 'ArrowDown') targetIndex = Math.min(options.length - 1, currentIndex + 1);
    else if (event.key === 'ArrowUp') targetIndex = Math.max(0, currentIndex - 1);
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = options.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      closeSectionDropdown(select, true);
      return;
    } else if (event.key === 'Tab') {
      event.preventDefault();
      moveFocusFromSectionDropdown(select, event.shiftKey);
      return;
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      searchSectionDropdown(select, event.key, currentIndex);
      return;
    } else {
      return;
    }
    event.preventDefault();
    options[targetIndex]?.focus();
    options[targetIndex]?.scrollIntoView({ block: 'nearest' });
  });
  label?.addEventListener('click', (event) => {
    if (event.target === label) {
      event.preventDefault();
      trigger.focus();
    }
  });
  updateSectionDropdown(select);
}
function focusValidationField(field) {
  const dropdown = field instanceof HTMLSelectElement ? getSectionDropdown(field) : null;
  (dropdown?.trigger || field).focus();
}
document.addEventListener('pointerdown', (event) => {
  document.querySelectorAll('.section-dropdown-trigger[aria-expanded="true"]').forEach((trigger) => {
    const select = document.getElementById(trigger.dataset.selectId);
    const dropdown = select && getSectionDropdown(select);
    if (dropdown && !dropdown.wrapper.contains(event.target) && !dropdown.menu.contains(event.target)) {
      closeSectionDropdown(select);
    }
  });
});
window.addEventListener('resize', () => {
  document.querySelectorAll('.section-dropdown-trigger[aria-expanded="true"]').forEach((trigger) => {
    const select = document.getElementById(trigger.dataset.selectId);
    if (select) positionSectionDropdown(select);
  });
});
window.addEventListener('scroll', () => {
  document.querySelectorAll('.section-dropdown-trigger[aria-expanded="true"]').forEach((trigger) => {
    const select = document.getElementById(trigger.dataset.selectId);
    if (select) positionSectionDropdown(select);
  });
}, true);
function validationMessage(field) {
  const labelElement = field.labels?.[0];
  const labelCopy = labelElement?.cloneNode(true);
  labelCopy?.querySelectorAll('input, select, textarea, button, .section-dropdown, .field-error')
    .forEach((control) => control.remove());
  const labelText = labelCopy?.textContent.replace(/\s+/g, ' ').trim() || '';
  const label = labelText ||
    field.getAttribute('aria-label') || 'This field';
  if (field.validity.valueMissing) return `${label} is required.`;
  if (field.validity.customError) return field.validationMessage;
  if (field.validity.typeMismatch && field.type === 'email') return `${label} is invalid.`;
  if (field.validity.typeMismatch) return `Enter a valid value for ${label}.`;
  if (field.validity.patternMismatch) return field.dataset.validationHelp || `Use the required format for ${label}.`;
  if (field.validity.tooShort) return `${label} must be at least ${field.minLength} characters. Add more characters and try again.`;
  if (field.validity.tooLong) return `${label} must be no more than ${field.maxLength} characters. Shorten this value and try again.`;
  if (field.validity.rangeUnderflow) return `${label} must be at least ${field.min}. Increase the value and try again.`;
  if (field.validity.rangeOverflow) return `${label} must be no more than ${field.max}. Reduce the value and try again.`;
  if (field.validity.badInput) return `Enter a valid value for ${label}.`;
  return field.validationMessage || `Check ${label} and try again.`;
}
function showFieldValidation(field, messageOverride = '') {
  if (!field.id) return;
  const errorId = `${field.id}-validation`;
  let message = document.getElementById(errorId);
  if (!message) {
    message = document.createElement('span');
    message.id = errorId;
    message.className = 'field-error';
    const control = getSectionDropdown(field)?.wrapper || field.closest('.password-field') || field;
    control.insertAdjacentElement('afterend', message);
  }
  message.textContent = messageOverride || validationMessage(field);
  field.setAttribute('aria-invalid', 'true');
  const dropdown = field instanceof HTMLSelectElement ? getSectionDropdown(field) : null;
  if (dropdown) {
    dropdown.trigger.setAttribute('aria-invalid', 'true');
    dropdown.trigger.setAttribute('aria-describedby', errorId);
  }
  const describedBy = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (!describedBy.includes(errorId)) describedBy.push(errorId);
  field.setAttribute('aria-describedby', describedBy.join(' '));
  field.classList.remove('field-invalid-shake');
  void field.offsetWidth;
  field.classList.add('field-invalid-shake');
  dropdown?.trigger.classList.add('field-invalid-shake');
}
function clearFieldValidation(field) {
  if (!field.id) return;
  document.getElementById(`${field.id}-validation`)?.remove();
  const describedBy = (field.getAttribute('aria-describedby') || '').split(/\s+/)
    .filter((id) => id && id !== `${field.id}-validation`);
  if (describedBy.length) field.setAttribute('aria-describedby', describedBy.join(' '));
  else field.removeAttribute('aria-describedby');
  field.removeAttribute('aria-invalid');
  const dropdown = field instanceof HTMLSelectElement ? getSectionDropdown(field) : null;
  if (dropdown) {
    dropdown.trigger.removeAttribute('aria-invalid');
    dropdown.trigger.removeAttribute('aria-describedby');
    dropdown.trigger.classList.remove('field-invalid-shake');
  }
}
function clearFormValidation(form) {
  delete form.dataset.validationSequence;
  form.querySelectorAll('input, select, textarea').forEach((field) => {
    field.setCustomValidity('');
    clearFieldValidation(field);
  });
}
function firstInvalidField(form) {
  return Array.from(form.elements).find((field) =>
    (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) &&
    field.willValidate && !field.validity.valid
  );
}
const validationFormsInProgress = new WeakSet();
document.addEventListener('invalid', (event) => {
  if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)) return;
  event.preventDefault();
  const form = event.target.form;
  if (!form || validationFormsInProgress.has(form)) return;
  validationFormsInProgress.add(form);
  setTimeout(() => validationFormsInProgress.delete(form), 0);
  const field = firstInvalidField(form);
  if (!field) return;
  form.dataset.validationSequence = 'true';
  showFieldValidation(field);
  focusValidationField(field);
}, true);
document.addEventListener('input', (event) => {
  const field = event.target;
  if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) &&
      field.validity.valid) clearFieldValidation(field);
});
document.addEventListener('change', (event) => {
  const field = event.target;
  if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) &&
      field.validity.valid) clearFieldValidation(field);
});
document.addEventListener('blur', (event) => {
  const field = event.target instanceof HTMLButtonElement && event.target.dataset.selectId
    ? document.getElementById(event.target.dataset.selectId)
    : event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) ||
      !field.form?.dataset.validationSequence) return;
  setTimeout(() => {
    if (!field.validity.valid) return;
    const nextField = firstInvalidField(field.form);
    if (nextField) {
      showFieldValidation(nextField);
      nextField.focus();
    } else {
      delete field.form.dataset.validationSequence;
    }
  }, 0);
}, true);
document.addEventListener('submit', (event) => {
  if (event.target instanceof HTMLFormElement) delete event.target.dataset.validationSequence;
}, true);
document.addEventListener('reset', (event) => {
  if (!(event.target instanceof HTMLFormElement)) return;
  setTimeout(() => {
    event.target.querySelectorAll('.section-dropdown-native').forEach(updateSectionDropdown);
  }, 0);
});
function operationError(error, operation, resolution) {
  if (error instanceof TypeError) {
    return 'Cannot reach the server. Check your connection.';
  }
  if (error && error.code === 'SCHEDULE_NOT_CONFIGURED') {
    return 'Attendance is paused because the school schedule is incomplete. This is an administrator setup issue; ask them to set all four class times in Settings, then scan again.';
  }
  if (error && error.status >= 500) {
    return 'The server encountered an error. Try again or contact the administrator.';
  }
  if (error && error.status === 401 && operation === 'sign in') {
    return 'Email or password is incorrect.';
  }
  if (error && error.status === 401) {
    return 'Your session has expired. Sign in again.';
  }
  if (error && error.status === 403) {
    return 'You do not have permission to do this.';
  }
  if (error && error.status === 404) {
    return 'This feature is unavailable on the current server version.';
  }
  if (error && error.status === 429) {
    return 'Too many attempts. Wait before trying again.';
  }
  if (error && error.status === 409) {
    return 'This record already exists. Check for duplicates.';
  }
  if (error && error.status === 400) {
    return 'Some details are invalid. Check the highlighted fields.';
  }
  return `Could not ${operation}. ${resolution}`;
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clsLabel = (c) => `Grade ${c.grade} - ${c.section}`;
const hhmm = (t) => (t ? t.slice(0, 5) : '');
const userStudentName = (student) => {
  if (!student.first_name || !student.surname) return student.display_name || student.name;
  const middleInitial = student.middle_name ? ` ${student.middle_name.trim().charAt(0).toUpperCase()}.` : '';
  return `${student.first_name}${middleInitial} ${student.surname}${student.name_extension ? ` ${student.name_extension}` : ''}`;
};
const formatScanTime = (timestamp) => {
  const match = timestamp?.slice(11, 16).match(/^(\d{2}):(\d{2})$/);
  if (!match) return timestamp?.slice(11, 19) || '';
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
};
const formatUserLrn = (lrn) => String(lrn || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();

function setTheme(theme, animate = false) {
  const selectedTheme = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  const shouldAnimate = animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (shouldAnimate) root.classList.add('theme-transition-enabled');
  root.dataset.theme = selectedTheme;
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
let enrollmentRequests = [];
let selectedStudentRefs = new Set();
let studentMarkMode = false;
let timer = null;
let userTimer = null;
let userClockTimer = null;
let userHideTimer = null;
let userHidScanInProgress = false;
let lastUnknownUserUid = '';
let studentHidScanTimer = null;
let studentHidScanBuffer = '';
let studentHidScanLastKeyAt = 0;
let studentHidScanCapturing = false;
let studentHidScanTarget = null;
let studentHidScanOriginalValue = '';
let studentHidScanSelectionStart = 0;
let studentHidScanSelectionEnd = 0;
let studentRfidScanned = false;
let cardWatchTimer = null;
let cardWatchInProgress = false;
let lastUserScanId = 0;
let lastUserAttemptId = 0;
const validTabs = new Set(['overview', 'attendance', 'students', 'risk', 'notifications', 'settings']);
const studentRouteMatch = window.location.pathname.match(/^\/students\/([A-Za-z0-9_-]+)\/?$/);
const initialStudentRef = studentRouteMatch ? studentRouteMatch[1] : null;
const urlTab = new URLSearchParams(window.location.search).get('tab');
let currentTab = validTabs.has(urlTab)
  ? urlTab
  : sessionStorage.getItem('currentTab') || 'overview';
if (studentRouteMatch) currentTab = 'students';
let recoveryChallenge = '';
let recoveryQuestionIds = [];
let userAddMode = false;
let dashboardBootstrapFailed = false;
let pendingDeleteConfirmation = null;
const readOnlyApiCache = new Map();
const scanReviewPageSize = 100;
let scanReviewOffset = 0;

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
    const error = new Error((data && (data.error || data.message)) || `Request failed (HTTP ${res.status})`);
    error.status = res.status;
    if (data && typeof data === 'object' && typeof data.code === 'string') error.code = data.code;
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
  clearTimeout(userNoticeTimer);
  $('#userNotice').classList.add('hidden');
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
    $('#loginErr').textContent = operationError(err, 'sign in', 'check your email and password, then try again.');
    showOperationNotice(err, 'sign in', 'check your email and password, then try again.');
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
    showOperationNotice(error, 'start password recovery', 'check the admin email address or contact the school administrator.');
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
    showAccountToast('Your admin password has been reset. Sign in with the new password.');
  } catch (error) {
    $('#recoveryMsg').className = 'err';
    $('#recoveryMsg').textContent = error.message;
    showOperationNotice(error, 'reset the admin password', 'check the recovery answers and choose a password with at least 12 characters.');
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
  clearInterval(userClockTimer);
  userClockTimer = null;
  clearTimeout(userHideTimer);
  showLogin();
}

$('#logout').onclick = logout;
$('#userLogout').onclick = logout;
$('#userAddStudentBtn').onclick = () => openUserStudentForm().catch((err) => {
  $('#userStatus').textContent = `Could not open the student form: ${err.message}`;
  showOperationNotice(err, 'open student enrollment', 'check your connection and account permissions, then retry.');
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

function focusUserScanInput() {
  if (role !== 'user' || $('#userApp').classList.contains('hidden') ||
      !$('#stuFormPanel').classList.contains('hidden')) return;
  const input = $('#userScanInput');
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}

async function submitUserHidScan(rawUid) {
  const uid = rawUid.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{10}|[0-9A-F]{12}|[0-9A-F]{14}|[0-9A-F]{16}|[0-9A-F]{18}|[0-9A-F]{20})$/.test(uid)) {
    showUserNotice('error', 'Card could not be read', 'No valid card number received. Tap again or check the reader.');
    focusUserScanInput();
    return;
  }
  if (userHidScanInProgress) return;
  userHidScanInProgress = true;
  try {
    await api('/user/tap', { method: 'POST', body: { uid } });
  } catch (error) {
    showOperationNotice(error, 'record this card scan', 'check that the reader and attendance service are connected, then tap again.');
  } finally {
    userHidScanInProgress = false;
    focusUserScanInput();
  }
}

function finishUserHidScan() {
  const uid = $('#userScanInput').value;
  $('#userScanInput').value = '';
  if (uid) submitUserHidScan(uid);
}

$('#userScanInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== 'Tab') return;
  event.preventDefault();
  finishUserHidScan();
});

$('#enrollUnknownCard').addEventListener('click', () => {
  clearTimeout(userHideTimer);
  openUserStudentForm(lastUnknownUserUid).catch((error) => {
    showOperationNotice(error, 'open student enrollment', 'ask the administrator to confirm this account can add students.');
  });
});

document.querySelectorAll('[data-user-demo]').forEach((button) => {
  button.addEventListener('click', () => {
    showUserDemoResult(button.dataset.userDemo);
    focusUserScanInput();
  });
});

$('#userApp').addEventListener('pointerdown', (event) => {
  if (event.target instanceof Element &&
      !event.target.closest('button, a, input, select, textarea, #userNav')) {
    focusUserScanInput();
  }
});
window.addEventListener('focus', focusUserScanInput);
document.addEventListener('click', (event) => {
  if (event.detail > 0 && role === 'user' && $('#userApp').contains(event.target)) {
    setTimeout(focusUserScanInput, 0);
  }
});

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
      setStudentRfidScanned(true);
      $('#sfUid').dispatchEvent(new Event('input', { bubbles: true }));
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
  const studentFormOpen = !$('#stuFormPanel').classList.contains('hidden');
  const canCaptureStudentCard = role === 'admin' ||
    (role === 'user' && !$('#userApp').classList.contains('hidden') && userAddMode);
  if (studentFormOpen && canCaptureStudentCard) {
    captureStudentHidScanKey(event);
  }
});

async function boot() {
  if (!token) return showLogin();
  if (role === 'user') {
    $('#login').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#userApp').classList.remove('hidden');
    $('#userSignedInName').textContent = username;
    $('#userSignedInAs').classList.toggle('hidden', !username);
    updateUserClock();
    clearInterval(userClockTimer);
    userClockTimer = setInterval(updateUserClock, 1000);
    focusUserScanInput();
    const baseline = await api('/user/latest?after=0');
    $('#userSchoolName').textContent = baseline.school_name;
    updateUserHolidayOverlay(baseline.holiday);
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
    dashboardBootstrapFailed = false;
  } catch (err) {
    if (err.status === 403) {
      logout();
      return;
    }
    dashboardBootstrapFailed = true;
    $('#login').classList.add('hidden');
    $('#userApp').classList.add('hidden');
    $('#app').classList.remove('hidden');
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('hidden', tab.id !== `tab-${currentTab}`));
    document.querySelectorAll('#tabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === currentTab));
    $('#tabLoading').classList.add('hidden');
    $('#app > main').setAttribute('aria-busy', 'false');
    showLoadError(err);
    return;
  }
  $('#schoolName').textContent = settings.school_name;
  document.title = settings.school_name + ' - RFID Attendance';
  showTab(currentTab);
  $('#login').classList.add('hidden');
  $('#userApp').classList.add('hidden');
  $('#app').classList.remove('hidden');
  if (initialStudentRef) {
    await showStudentDetails(initialStudentRef).catch((error) => {
      $('#studentDetailsMsg').textContent = error.message;
      showOperationNotice(error, 'open this student record', 'return to the Students list and open the record again.');
    });
  }
}

function updateUserClock() {
  const currentTime = new Date();
  const clock = $('#userClock');
  clock.dateTime = currentTime.toISOString();
  clock.textContent = `${userDateFormatter.format(currentTime)} · ${userClockFormatter.format(currentTime)}`;
}

function formatScanDate(dateValue, timestamp) {
  const date = dateValue || timestamp?.slice(0, 10);
  if (!date) return '';
  const parsedDate = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsedDate.getTime()) ? date : scanDateFormatter.format(parsedDate);
}

function showUserScanResult(student) {
  const screen = $('#userApp .user-screen');
  const checkIn = student.type === 'MORNING_IN' || student.type === 'AFTERNOON_IN';
  const name = userStudentName(student) || student.name || 'Student';
  const badge = $('#userTapResult');
  const initials = name.trim().split(/\s+/).filter(Boolean);

  screen.classList.add('has-scan');
  screen.classList.remove('has-error');
  $('#userIdleState').classList.add('hidden');
  $('#userUnknownCard').classList.add('hidden');
  $('#userStudentDetails').classList.remove('hidden');
  $('#userStudentName').textContent = name;
  $('#userStudentInitials').textContent = initials.length > 1
    ? `${initials[0][0]}${initials[initials.length - 1][0]}`.toUpperCase()
    : name.slice(0, 2).toUpperCase();
  $('#userGradeSection').textContent = `Grade ${student.grade} · Section ${student.section}`;
  $('#userStudentLrn').textContent = student.lrn ? `LRN ${formatUserLrn(student.lrn)}` : '';
  $('#userStudentLrn').classList.toggle('hidden', !student.lrn);
  $('#userTapDate').textContent = formatScanDate(student.date, student.ts);
  $('#userTapTime').textContent = formatScanTime(student.ts);
  badge.textContent = checkIn ? '✓ TIME IN' : '✓ TIME OUT';
  badge.classList.remove('event-in', 'event-out');
  badge.classList.add(checkIn ? 'event-in' : 'event-out');

  clearTimeout(userHideTimer);
  userHideTimer = setTimeout(hideUserStudent, 5000);
}

function showUnknownUserCard(uid = '') {
  const screen = $('#userApp .user-screen');
  lastUnknownUserUid = uid;
  screen.classList.remove('has-scan');
  screen.classList.add('has-error');
  $('#userIdleState').classList.add('hidden');
  $('#userStudentDetails').classList.add('hidden');
  $('#userUnknownCard').classList.remove('hidden');
  $('#enrollUnknownCard').classList.toggle('hidden', !uid);

  clearTimeout(userHideTimer);
  userHideTimer = setTimeout(hideUserStudent, 5000);
}

function showUserDemoResult(demo) {
  if (demo === 'unknown') {
    showUnknownUserCard();
    return;
  }
  const now = new Date();
  showUserScanResult({
    first_name: 'Alex',
    surname: 'Santos',
    grade: '10',
    section: 'A',
    lrn: '123456789012',
    date: now.toISOString().slice(0, 10),
    ts: now.toISOString(),
    type: demo === 'time-out' ? 'MORNING_OUT' : 'MORNING_IN',
    status: 'present',
  });
}

async function pollUserScreen() {
  const result = await api(`/user/latest?after=${lastUserScanId}&attempt_after=${lastUserAttemptId}`);
  $('#userSchoolName').textContent = result.school_name;
  updateUserHolidayOverlay(result.holiday);
  if (result.holiday) {
    hideUserStudent();
    return;
  }
  lastUserScanId = Number(result.scan_cursor) || lastUserScanId;
  lastUserAttemptId = Number(result.attempt_cursor) || lastUserAttemptId;
  const student = result.latest;
  if (!student) {
    return;
  }
  if (student.code) {
    if (student.code === 'UNKNOWN_CARD') {
      showUnknownUserCard(student.uid);
      return;
    }
    hideUserStudent();
    showUserNotice('warning', 'Scan could not be recorded', student.message || 'Try scanning the card again.');
    return;
  }
  showUserScanResult(student);
}

function updateUserHolidayOverlay(holiday) {
  const overlay = $('#userHolidayOverlay');
  overlay.classList.toggle('hidden', !holiday);
  if (!holiday) return;
  const dateRange = holiday.end_date && holiday.end_date !== holiday.date
    ? `${holiday.date} – ${holiday.end_date}`
    : holiday.date;
  const notice = {
    userHolidayTitle: holiday.name,
    userHolidayDate: dateRange,
    userHolidayReason: holiday.reason || 'No suspension reason was recorded for this date.',
  };
  Object.entries(notice).forEach(([id, value]) => {
    const element = $(`#${id}`);
    if (element.textContent !== value) element.textContent = value;
  });
}

function hideUserStudent() {
  $('#userApp .user-screen').classList.remove('has-scan', 'has-error');
  $('#userIdleState').classList.remove('hidden');
  $('#userStudentDetails').classList.add('hidden');
  $('#userUnknownCard').classList.add('hidden');
  lastUnknownUserUid = '';
  focusUserScanInput();
}

function scheduleUserPoll() {
  userTimer = setTimeout(async () => {
    try {
      await pollUserScreen();
    } catch (error) {
      $('#userStatus').textContent = error.message;
      showOperationNotice(error, 'check the latest scan status', 'check the reader connection; the screen will retry automatically.');
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
  [$('#attClass'), $('#stuClassFilter'), $('#sfClass')].forEach(enhanceSectionDropdown);
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
const tabLoadingDescriptions = {
  overview: 'The overview is preparing today’s attendance cards, live tap feed, section totals, and scans to review.',
  attendance: 'The attendance view is preparing the date and section filters, student rows, scan times, and attendance statuses.',
  students: 'The student roster is preparing student names, sections, card status, contact consent, and record actions.',
  risk: 'The early-warning view is preparing the month and risk filters, summary counts, and counselor review rows.',
  notifications: 'The notification log is preparing delivery times, recipients, messages, and send statuses.',
  settings: 'Settings are preparing the class schedule, holiday list, notification options, and account controls.',
};
function showTabSkeleton(name) {
  const skeleton = $('#loadingSkeleton');
  skeleton.dataset.tab = name;
  skeleton.innerHTML = skeletonLayouts[name];
  $('#tabLoadingMessage').textContent = `Loading ${name}. ${tabLoadingDescriptions[name]}`;
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
  showTabSkeleton(name);
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
$('#retryTabLoad').onclick = () => {
  if (dashboardBootstrapFailed) {
    boot();
    return;
  }
  showTab(currentTab);
};
$('#app').addEventListener('click', (event) => {
  const action = event.target.closest('[data-empty-action]')?.dataset.emptyAction;
  if (!action) return;
  if (action === 'add-section') {
    showTab('students', true);
    $('#addSectionBtn').click();
  } else if (action === 'add-student') {
    showTab('students', true);
    $('#addStudentBtn').click();
  } else if (action === 'show-all-students') {
    $('#stuClassFilter').value = '';
    loadStudents().catch(showLoadError);
  } else if (action === 'review-all-risk') {
    $('#riskFilter').value = 'all';
    loadRisk().catch(showLoadError);
  }
});
document.querySelectorAll('#tabs [data-tab]').forEach((button) => {
  button.onclick = (event) => {
    event.preventDefault();
    showTab(button.dataset.tab, true);
  };
});
window.addEventListener('popstate', () => {
  const studentMatch = window.location.pathname.match(/^\/students\/([A-Za-z0-9_-]+)\/?$/);
  if (studentMatch) {
    showTab('students');
    showStudentDetails(studentMatch[1]).catch((error) => {
      $('#studentDetailsMsg').textContent = error.message;
      showOperationNotice(error, 'open this student record', 'return to the Students list and open the record again.');
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
    api('/feed?limit=4'),
    api('/scan-attempts?limit=4'),
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
      .join('') || emptyTableRow(
      6,
      'There are no active students to summarize.',
      'The section totals are empty because no students are currently enrolled.',
      'add-section'
    ));

  $('#feed').innerHTML =
    feed
      .map(
        (f) =>
          `<li><span class="t">${esc(f.ts.slice(5, 10))} ${esc(hhmm(f.ts.slice(11)))}</span>
           <span class="who">${esc(f.name)}<small>${esc(clsLabel(f))}</small></span>
           ${badge(f.type.toLowerCase(), f.type.replace('_', ' '))}
           ${f.status === 'late' ? badge('late', 'late') : ''}</li>`
      )
      .join('') || `<li>${emptyState(
      'No taps recorded for this school day.',
      'No RFID scans have been recorded in the live feed yet.'
    )}</li>`;
  $('#scanAttemptsTable').innerHTML =
    '<tr><th>Time</th><th>Student / card</th><th>Result</th></tr>' +
    (scanAttemptRows(attempts) || emptyTableRow(
      3,
      'No scans need review.',
      feed.length ? 'Recent scans have not produced any rejected attempts.' : 'No card scans have been recorded yet, so there is nothing to review.'
    ));
}

function scanAttemptRows(attempts) {
  return attempts.map((attempt) =>
    `<tr><td>${esc(attempt.ts.replace('T', ' '))}</td>
     <td>${esc(attempt.name || 'Unknown card')}${attempt.name ? `<br><small class="muted">${esc(clsLabel(attempt))}</small>` : ''}</td>
     <td>${esc(attempt.message)}${attempt.expected_type ? `<br><small class="muted">Expected ${esc(attempt.expected_type.replace('_', ' '))}</small>` : ''}</td></tr>`
  ).join('');
}

async function loadScanReview(reset = true) {
  const table = $('#scanReviewTable');
  const message = $('#scanReviewMsg');
  const loadMore = $('#loadMoreScanReviews');
  if (reset) {
    scanReviewOffset = 0;
    table.innerHTML = '<tr><th>Time</th><th>Student / card</th><th>Result</th></tr>';
    loadMore.classList.add('hidden');
  }
  message.textContent = 'Loading scans...';
  loadMore.disabled = true;
  try {
    const attempts = await api(`/scan-attempts?limit=${scanReviewPageSize}&offset=${scanReviewOffset}`);
    if (attempts.length) {
      table.insertAdjacentHTML('beforeend', scanAttemptRows(attempts));
      scanReviewOffset += attempts.length;
      message.textContent = `${scanReviewOffset} scan${scanReviewOffset === 1 ? '' : 's'} shown. Scans are cleared at midnight.`;
      loadMore.classList.toggle('hidden', attempts.length < scanReviewPageSize);
    } else if (scanReviewOffset === 0) {
      table.innerHTML += emptyTableRow(3, 'No scans need review.', 'Rejected and unrecognized card scans appear here.');
      message.textContent = 'Scans are cleared at midnight.';
      loadMore.classList.add('hidden');
    } else {
      message.textContent = `All ${scanReviewOffset} scans are shown. Scans are cleared at midnight.`;
      loadMore.classList.add('hidden');
    }
  } finally {
    loadMore.disabled = false;
  }
}

function closeScanReview() {
  $('#scanReviewModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  $('#viewAllScans').focus();
}

$('#viewAllScans').onclick = () => {
  $('#scanReviewModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  loadScanReview().catch((error) => {
    $('#scanReviewMsg').textContent = operationError(error, 'load scan reviews', 'try again.');
    showOperationNotice(error, 'load scan reviews', 'try again.');
  });
  $('#closeScanReview').focus();
};
$('#closeScanReview').onclick = closeScanReview;
$('#scanReviewModal').onclick = (event) => {
  if (event.target === $('#scanReviewModal')) closeScanReview();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#scanReviewModal').classList.contains('hidden')) {
    closeScanReview();
  }
});
$('#loadMoreScanReviews').onclick = () => loadScanReview(false).catch((error) => {
  showOperationNotice(error, 'load more scan reviews', 'retry in a moment.');
});

$('#clearFeed').onclick = async () => {
  const confirmed = await confirmDeletion({
    title: 'Delete live scan feed?',
    message: 'This permanently deletes all live taps and scan-review entries. Attendance records will be kept.',
    confirmText: 'Delete feed',
  });
  if (!confirmed) return;
  const button = $('#clearFeed');
  button.disabled = true;
  $('#feedMsg').textContent = '';
  try {
    await api('/feed', { method: 'DELETE' });
    $('#feedMsg').textContent = 'All live taps and scan-review entries deleted. Attendance records were kept.';
    showAccountToast('Live taps and scan-review entries were deleted. Attendance records were kept.');
    await loadOverview();
  } catch (err) {
    $('#feedMsg').textContent = err.status === 404
      ? 'This server does not support clearing scan logs yet. Restart the server with npm start, then reload this page.'
      : `Could not clear the feed: ${err.message}`;
    showOperationNotice(err, 'clear the live scan feed', 'restart the server if the action is unsupported, or retry.');
  } finally {
    button.disabled = false;
  }
};

$('#absentBtn').onclick = async () => {
  if (!confirm('Send configured absence notifications to opted-in parents of students with no tap today?')) return;
  try {
    const r = await api('/notify-absent', { method: 'POST' });
    showAccountToast(`${r.checked} absent students checked; ${r.sent} notifications sent to opted-in parents.`);
  } catch (e) {
    showOperationNotice(e, 'send absence notifications', 'check the notification settings and server configuration, then retry.');
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
          `<tr><td>${esc(s.lrn)}</td><td><button type="button" class="student-attendance-link" data-monthly-attendance="${s.student_key}">${esc(s.full_name || s.name)}</button></td><td>${esc(clsLabel(s))}</td>
           <td>${esc(hhmm(s.morning_in))}</td><td>${esc(hhmm(s.morning_out))}</td>
           <td>${esc(hhmm(s.afternoon_in))}</td><td>${esc(hhmm(s.afternoon_out))}</td>
           <td>${badge(s.morning_status, !r.schoolDay && s.morning_status === 'absent' ? 'no class' : s.morning_status)}</td>
           <td>${badge(s.afternoon_status, s.afternoon_status)}</td></tr>`
      )
      .join('') || emptyTableRow(
      9,
      'No active students are included in this attendance view.',
      $('#attClass').value
        ? 'The selected section has no active student records to show.'
        : 'No active students are enrolled, so there are no attendance rows for this date.',
      'add-student'
    ));
  $('#attTable').querySelectorAll('[data-monthly-attendance]').forEach((button) => {
    button.onclick = () => showStudentMonthlyAttendance(button.dataset.monthlyAttendance);
  });
}

async function showStudentMonthlyAttendance(studentRef) {
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
    const report = await api(`/students/${studentRef}/attendance?month=${encodeURIComponent(month)}`);
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
      (report.days.length ? report.days
        .map((day) =>
          `<tr><td>${esc(day.date)}</td><td>${esc(day.weekday)}</td>
           <td>${esc(hhmm(day.morning_in))}</td><td>${esc(hhmm(day.morning_out))}</td>
           <td>${esc(hhmm(day.afternoon_in))}</td><td>${esc(hhmm(day.afternoon_out))}</td>
           <td>${badge(day.status === 'present' ? 'present' : day.status === 'late' ? 'late' : day.status === 'half day' ? 'half-day' : day.status === 'absent' ? 'absent' : '', day.status)}</td></tr>`
        )
        .join('') : emptyTableRow(
          7,
          'No attendance days are available for this month.',
          'This report only includes school days in the selected month.'
        ));
  } catch (err) {
    $('#studentAttendanceError').textContent = operationError(err, 'load this monthly attendance report', 'retry the report or choose another month.');
    $('#studentAttendanceInfo').textContent = '';
    showOperationNotice(err, 'load this monthly attendance report', 'retry the report or choose another month.');
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
  download('/export/sf2.csv?' + q, `sf2-${month}.csv`)
    .then(() => showAccountToast(`Attendance export for ${month} downloaded.`))
    .catch((e) => showOperationNotice(e, 'download the attendance export', 'check your connection and retry.'));
};

// ---------- students ----------
async function loadStudents() {
  await refreshLookups();
  enrollmentRequests = await api('/enrollment-requests');
  renderStudents();
  renderEnrollmentRequests();
  await loadUnknown();
}

function renderEnrollmentRequests() {
  const panel = $('#enrollmentRequestsPanel');
  const list = $('#enrollmentRequestsList');
  panel.classList.toggle('hidden', enrollmentRequests.length === 0);
  list.innerHTML = enrollmentRequests.map((request) => {
    const submittedAt = request.submitted_at
      ? new Date(`${request.submitted_at}Z`).toLocaleString()
      : 'Submission time unavailable';
    const contacts = [
      request.parent_name ? `Parent: ${esc(request.parent_name)}` : '',
      request.parent_phone ? `Phone: ${esc(request.parent_phone)}` : '',
      request.parent_email ? `Email: ${esc(request.parent_email)}` : '',
    ].filter(Boolean).join(' · ');
    return `<article class="enrollment-request">
      <div class="enrollment-request-info">
        <strong>${esc(request.display_name || request.name)}</strong>
        <span>${esc(clsLabel(request))} · LRN ${esc(request.lrn)}</span>
        <span>RFID ${esc(request.rfid_uid)} · Submitted ${esc(submittedAt)}</span>
        ${contacts ? `<span>${contacts}</span>` : ''}
      </div>
      <div class="enrollment-request-actions">
        <button type="button" class="small" data-enrollment-approve="${request.id}">Approve</button>
        <button type="button" class="small danger" data-enrollment-reject="${request.id}">Reject</button>
      </div>
    </article>`;
  }).join('');

  list.querySelectorAll('[data-enrollment-approve]').forEach((button) => {
    button.onclick = () => reviewEnrollmentRequest(button.dataset.enrollmentApprove, 'approve')
      .catch((error) => showOperationNotice(error, 'approve this enrollment request', 'review the request and retry.'));
  });
  list.querySelectorAll('[data-enrollment-reject]').forEach((button) => {
    button.onclick = () => reviewEnrollmentRequest(button.dataset.enrollmentReject, 'reject')
      .catch((error) => showOperationNotice(error, 'reject this enrollment request', 'review the request and retry.'));
  });
}

async function reviewEnrollmentRequest(requestId, action) {
  const request = enrollmentRequests.find((item) => String(item.id) === String(requestId));
  if (!request) return;
  const actionLabel = action === 'approve' ? 'approve and enroll' : 'reject';
  if (!confirm(`Are you sure you want to ${actionLabel} ${request.display_name || request.name}?`)) return;
  await api(`/enrollment-requests/${requestId}`, { method: 'POST', body: { action } });
  showUserNotice('success', action === 'approve' ? 'Enrollment approved' : 'Enrollment rejected',
    action === 'approve' ? 'The student has been added to the roster.' : 'The request was rejected and was not enrolled.');
  await loadStudents();
}

function renderStudents() {
  const activeIds = new Set(students.map((s) => s.student_key));
  selectedStudentRefs = new Set([...selectedStudentRefs].filter((ref) => activeIds.has(ref)));
  const classFilter = $('#stuClassFilter').value;
  const visibleStudents = classFilter
    ? students.filter((s) => `${s.grade}::${s.section}` === classFilter)
    : students;
  $('#stuTable').innerHTML =
    `<tr>${studentMarkMode ? '<th></th>' : ''}<th>Name</th><th>Section</th><th>Card</th><th>SMS</th><th>Email</th><th></th></tr>` +
    (visibleStudents
      .map(
        (s) =>
        `<tr${studentMarkMode ? ` data-select-row="${s.student_key}" class="${selectedStudentRefs.has(s.student_key) ? 'student-row-selected' : ''}"` : ''}>${studentMarkMode ? `<td><input type="checkbox" aria-label="Mark ${esc(s.display_name || s.name)} for removal" data-select-student="${s.student_key}" ${selectedStudentRefs.has(s.student_key) ? 'checked' : ''}></td>` : ''}
           <td><a class="student-attendance-link" data-student-detail="${s.student_key}" href="/students/${s.student_key}">${esc(s.display_name || s.name)}</a></td>
           <td>${esc(clsLabel(s))}</td>
           <td>${s.has_rfid_uid ? '<span class="muted">RFID protected</span>' : '<span class="muted">none</span>'}</td>
           <td>${s.has_sms_contact ? badge('present', 'consented') : badge('absent', 'no consent')}</td>
           <td>${s.has_email_contact ? badge('present', 'consented') : badge('absent', 'no consent')}</td>
           <td><button class="small ghost" data-edit="${s.student_key}">Edit</button>
               <button class="small ghost" data-del="${s.student_key}">Remove</button></td></tr>`
      )
      .join('') || `<tr><td colspan="${studentMarkMode ? 7 : 6}" class="muted">No students saved yet.</td></tr>`);
  $('#stuTable').querySelectorAll('[data-student-detail]').forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      if (studentMarkMode) return;
      showStudentDetails(link.dataset.studentDetail, true).catch((error) => {
        $('#studentDetailsMsg').textContent = error.message;
        showOperationNotice(error, 'open this student record', 'return to the Students list and open the record again.');
      });
    };
  });
  $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
    checkbox.onchange = () => {
      const studentRef = checkbox.dataset.selectStudent;
      if (checkbox.checked) selectedStudentRefs.add(studentRef);
      else selectedStudentRefs.delete(studentRef);
      checkbox.closest('tr').classList.toggle('student-row-selected', checkbox.checked);
      updateStudentSelection(visibleStudents);
    };
  });
  $('#stuTable').querySelectorAll('[data-select-row]').forEach((row) => {
    row.onclick = (event) => {
      if (event.target.closest('button, input, select, textarea')) return;
      const checkbox = row.querySelector('[data-select-student]');
      if (!checkbox) return;
      if (event.target.closest('a')) event.preventDefault();
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    };
  });
  $('#stuTable').querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => editStudent(button.dataset.edit).catch((error) => {
      $('#stuRemoveMsg').textContent = `Could not open student details: ${error.message}`;
      showOperationNotice(error, 'open this student for editing', 'reload the student list and retry.');
    });
  });
  $('#stuTable').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => removeStudent(b.dataset.del).catch((error) => {
    showOperationNotice(error, 'remove this student', 'reload the student list and retry.');
  })));
  $('#markAllStudents').onclick = () => {
    for (const student of visibleStudents) selectedStudentRefs.add(student.student_key);
    $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
      checkbox.checked = true;
    });
    updateStudentSelection(visibleStudents);
  };
  $('#unmarkAllStudents').onclick = () => {
    selectedStudentRefs.clear();
    $('#stuTable').querySelectorAll('[data-select-student]').forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateStudentSelection(visibleStudents);
  };
  updateStudentSelection(visibleStudents);
  $('#toggleStudentMark').textContent = studentMarkMode ? 'Done marking' : 'Mark students';
  $('#studentMarkControls').classList.toggle('hidden', !studentMarkMode);
}

async function showStudentDetails(studentRef, updateUrl = false) {
  if (typeof studentRef !== 'string' || !studentRef) throw new Error('Invalid student reference');
  if (updateUrl) {
    window.history.pushState({ studentRef }, '', `/students/${studentRef}`);
  }
  const student = students.find((item) => item.student_key === studentRef);
  $('#studentDetailsTitle').textContent = student?.display_name || student?.name || 'Student details';
  $('#studentDetailsMsg').textContent = 'Loading student details...';
  $('#studentDetailsPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#studentDetailsEdit').dataset.studentRef = studentRef;
  const details = await api(`/students/${studentRef}`);
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
  if (updateUrl && window.location.pathname.match(/^\/students\/[A-Za-z0-9_-]+\/?$/)) {
    window.history.pushState({ tab: 'students' }, '', '/?tab=students');
  }
}

$('#studentDetailsClose').onclick = () => closeStudentDetails(true);
$('#studentDetailsPanel').onclick = (event) => {
  if (event.target === $('#studentDetailsPanel')) closeStudentDetails(true);
};
$('#studentDetailsEdit').onclick = () => {
  const studentRef = $('#studentDetailsEdit').dataset.studentRef;
  closeStudentDetails(false);
  editStudent(studentRef).catch((error) => {
    $('#stuRemoveMsg').textContent = `Could not open student details: ${error.message}`;
    showOperationNotice(error, 'open this student for editing', 'reload the student list and retry.');
  });
};

function updateStudentSelection(visibleStudents = students) {
  const selectedCount = selectedStudentRefs.size;
  $('#stuSelectionCount').textContent = `${selectedCount} marked`;
  $('#stuRemoveSelected').textContent = `Remove marked (${selectedCount})`;
  $('#stuRemoveSelected').disabled = selectedCount === 0;
}

$('#toggleStudentMark').onclick = async () => {
  studentMarkMode = !studentMarkMode;
  if (!studentMarkMode) selectedStudentRefs.clear();
  try {
    await loadStudents();
  } catch (error) {
    showOperationNotice(error, 'update the student selection', 'reload the Students tab and retry.');
  }
};

$('#stuClassFilter').onchange = () => loadStudents().catch((err) => {
  $('#stuRemoveMsg').textContent = err.message;
showOperationNotice(err, 'load the student list', 'check your connection and retry.');
});

$('#stuRemoveSelected').onclick = async () => {
  const selected = students.filter((s) => selectedStudentRefs.has(s.student_key));
  if (!selected.length) return;
  const names = selected.map((s) => s.display_name || s.name).join(', ');
  const confirmed = await confirmDeletion({
    title: `Remove ${selected.length} marked student${selected.length === 1 ? '' : 's'}?`,
    message: `Selected: ${selected.length <= 5 ? names : `${names.slice(0, 180)}${names.length > 180 ? '…' : ''}`}. Attendance history will be kept and the students' cards will be freed.`,
    confirmText: 'Remove students',
  });
  if (!confirmed) return;
  try {
    let removed;
    try {
      const result = await api('/students', {
        method: 'DELETE',
        body: { refs: selected.map((s) => s.student_key) },
      });
      removed = result.removed;
    } catch (err) {
      if (err.status !== 404 && err.status !== 405) throw err;
      removed = 0;
      for (const student of selected) {
        await api('/students/' + student.student_key, { method: 'DELETE' });
        removed++;
      }
    }
    selectedStudentRefs.clear();
    studentMarkMode = false;
    const removedRefs = new Set(selected.map((student) => student.student_key));
    students = students.filter((student) => !removedRefs.has(student.student_key));
    $('#stuRemoveMsg').className = 'muted';
    $('#stuRemoveMsg').textContent = `${removed} student(s) removed. Attendance history was kept.`;
    showAccountToast(`${removed} student${removed === 1 ? '' : 's'} removed. Attendance history was kept.`);
    renderStudents();
  } catch (err) {
    $('#stuRemoveMsg').className = 'err';
    $('#stuRemoveMsg').textContent = `${err.message}. Reload the student list and try again if the students are still active.`;
    showOperationNotice(err, 'remove the selected students', 'reload the student list and try again.');
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
  $('#unknownBox').querySelectorAll('[data-uid]').forEach((button) => {
    button.onclick = () => {
      $('#sfUid').value = button.dataset.uid;
      setStudentRfidScanned(true);
      $('#sfUid').dispatchEvent(new Event('input', { bubbles: true }));
    };
  });
}

function setStudentRfidScanned(scanned) {
  studentRfidScanned = scanned;
  if (scanned) clearFieldValidation($('#sfUid'));
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
          setStudentRfidScanned(true);
          $('#sfUid').dispatchEvent(new Event('input', { bubbles: true }));
          $('#sfMsg').className = 'muted';
          $('#sfMsg').textContent = `Card ${scan.uid} detected and added to the form.`;
        }
      } else if (scan.uid && scan.code !== 'UNKNOWN_CARD') {
        $('#sfMsg').className = 'err';
        $('#sfMsg').textContent = 'This RFID card is already registered. Contact the admin to update the RFID.';
        showUserNotice('error', 'RFID card already registered', 'This card is assigned to another student. Ask an administrator to update the record.');
      }
    } catch (error) {
      $('#sfMsg').className = 'err';
      $('#sfMsg').textContent = `Could not check for a scanned RFID card: ${error.message}`;
      showOperationNotice(error, 'check for a scanned RFID card', 'check your connection and retry card detection.');
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
  enhanceSectionDropdown($('#sfClass'));
  $('#formTitle').textContent = 'Add student';
  $('#sfHelp').textContent = 'Choose a section already created by the admin. Existing student names and RFID cards cannot be changed here; contact the admin for updates.';
  $('#sfHelp').classList.remove('hidden');
  $('#unknownBox').classList.add('hidden');
  $('#sfUid').value = rfidUid;
  setStudentRfidScanned(Boolean(rfidUid));
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
  clearFormValidation($('#sectionForm'));
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
  $('#sectionMsg').className = 'muted';
  $('#sectionMsg').textContent = '';
  const grade = $('#sectionGrade').value;
  const section = $('#sectionName').value.trim();
  try {
    await api('/classes', { method: 'POST', body: { grade, section } });
  } catch (err) {
    $('#sectionMsg').className = 'err';
    $('#sectionMsg').textContent = operationError(err, 'save this section', 'check the section details and retry.');
    showOperationNotice(err, 'save this section', 'check the section details and retry.');
    if (err.status === 409) {
      showFieldValidation($('#sectionName'), 'This grade and section already exists. Choose a different section name or grade.');
    }
    return;
  }
  closeSectionForm();
  showUserNotice('success', 'Section saved', 'The section is available for enrollment.');
  try {
    await refreshLookups();
    $('#stuClassFilter').value = `${grade}::${section}`;
    updateSectionDropdown($('#stuClassFilter'));
    await loadStudents();
  } catch (error) {
    showOperationNotice(error, 'refresh the section list', 'retry by reopening the Students tab.');
  }
};

function closeSectionManager() {
  $('#sectionManagerPanel').classList.add('hidden');
  $('#sectionManagerMsg').textContent = '';
  if ($('#stuFormPanel').classList.contains('hidden') &&
      $('#sectionFormPanel').classList.contains('hidden')) {
    document.body.classList.remove('modal-open');
  }
}

async function loadSectionManager() {
  const message = $('#sectionManagerMsg');
  message.className = 'muted';
  message.textContent = 'Loading sections...';
  try {
    const managedSections = await api('/classes');
    const table = $('#sectionManagerTable');
    table.innerHTML = `<thead><tr><th>Grade</th><th>Section name</th><th>Active students</th><th>Actions</th></tr></thead><tbody></tbody>`;
    const body = table.querySelector('tbody');
    if (!managedSections.length) {
      body.innerHTML = '<tr><td colspan="4">No sections have been added.</td></tr>';
    }
    managedSections.forEach((section) => {
      const row = document.createElement('tr');
      const activeStudentCount = Number(section.student_count) || 0;
      row.innerHTML = `
        <td>Grade ${esc(section.grade)}</td>
        <td><input class="section-manager-name" maxlength="100" aria-label="Grade ${esc(section.grade)} section name" value="${esc(section.section)}"></td>
        <td>${activeStudentCount}</td>
        <td class="section-manager-actions">
          <button type="button" class="small" data-section-save>Save</button>
          <button type="button" class="small danger" data-section-delete ${activeStudentCount ? 'disabled' : ''}>Delete</button>
          ${activeStudentCount ? '<span class="section-delete-help">Move active students first</span>' : ''}
        </td>`;
      const nameInput = row.querySelector('.section-manager-name');
      row.querySelector('[data-section-save]').onclick = async (event) => {
        const saveButton = event.currentTarget;
        const newName = nameInput.value.trim();
        if (!newName) {
          nameInput.focus();
          message.className = 'err';
          message.textContent = 'Section name cannot be empty.';
          return;
        }
        saveButton.disabled = true;
        message.className = 'muted';
        message.textContent = '';
        try {
          await api('/classes', {
            method: 'PUT',
            body: { grade: section.grade, old_section: section.section, section: newName },
          });
          closeSectionManager();
          await refreshLookups();
          await loadStudents();
          showUserNotice('success', 'Section updated', `Grade ${section.grade} students are now in ${newName}.`);
        } catch (error) {
          message.className = 'err';
          message.textContent = operationError(error, 'rename this section', 'check the name and retry.');
          showOperationNotice(error, 'rename this section', 'check the name and retry.');
          saveButton.disabled = false;
        }
      };
      row.querySelector('[data-section-delete]').onclick = async (event) => {
        const deleteButton = event.currentTarget;
        const confirmed = await confirmDeletion({
          title: `Delete Grade ${section.grade} - ${section.section}?`,
          message: Number(section.student_count) > 0
            ? `${section.student_count} active students are assigned to this section. Move them to another section before deleting it.`
            : 'This removes the section from enrollment and filters. This action cannot be undone.',
          confirmText: 'Delete section',
        });
        if (!$('#sectionManagerPanel').classList.contains('hidden')) {
          document.body.classList.add('modal-open');
        }
        if (!confirmed) return;
        deleteButton.disabled = true;
        message.className = 'muted';
        message.textContent = '';
        try {
          await api('/classes', {
            method: 'DELETE',
            body: { grade: section.grade, section: section.section },
          });
          closeSectionManager();
          await refreshLookups();
          await loadStudents();
          showUserNotice('success', 'Section deleted', `Grade ${section.grade} - ${section.section} was deleted.`);
        } catch (error) {
          if (error.status === 409) {
            message.className = 'err';
            message.textContent = error.message;
            showUserNotice('error', 'Section cannot be deleted', error.message);
          } else {
            message.className = 'err';
            message.textContent = operationError(error, 'delete this section', 'move any assigned students and retry.');
            showOperationNotice(error, 'delete this section', 'move any assigned students and retry.');
          }
          deleteButton.disabled = false;
        }
      };
      body.appendChild(row);
    });
    message.textContent = '';
  } catch (error) {
    message.className = 'err';
    message.textContent = operationError(error, 'load sections', 'check your connection and retry.');
    showOperationNotice(error, 'load sections', 'check your connection and retry.');
  }
}

$('#manageSectionsBtn').onclick = async () => {
  $('#sectionManagerPanel').classList.remove('hidden');
  document.body.classList.add('modal-open');
  await loadSectionManager();
  $('#closeSectionManager').focus();
};
$('#closeSectionManager').onclick = closeSectionManager;
$('#sectionManagerPanel').onclick = (event) => {
  if (event.target === $('#sectionManagerPanel')) closeSectionManager();
};

$('#addStudentBtn').onclick = () => {
  clearForm();
  startCardWatch().then(showStudentForm).catch((error) => {
    $('#sfMsg').className = 'err';
    $('#sfMsg').textContent = operationError(error, 'start RFID card detection', 'check the reader connection and retry card detection.');
    showOperationNotice(error, 'start RFID card detection', 'check the reader connection and retry card detection.');
    showStudentForm();
  });
};

async function editStudent(studentRef) {
  const s = students.find((x) => x.student_key === studentRef);
  if (!s) return;
  const details = await api(`/students/${studentRef}`);
  if ($('#app').classList.contains('hidden')) return;
  clearInterval(cardWatchTimer);
  cardWatchTimer = null;
  showStudentForm();
  $('#formTitle').textContent = 'Edit student';
  $('#sfId').value = s.student_key;
  $('#sfLrn').value = details.lrn || '';
  $('#sfSurname').value = details.surname || '';
  $('#sfFirstName').value = details.first_name || (details.surname ? '' : details.name);
  $('#sfMiddleName').value = details.middle_name || '';
  $('#sfNameExtension').value = details.name_extension || '';
  $('#sfClass').value = `${s.grade}::${s.section}`;
  updateSectionDropdown($('#sfClass'));
  $('#sfUid').value = details.rfid_uid || '';
  setStudentRfidScanned(false);
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
  clearFormValidation($('#stuForm'));
  $('#stuForm').reset();
  $('#sfId').value = '';
  studentRfidScanned = false;
  $('#sfMsg').className = 'err';
  $('#sfMsg').textContent = '';
  $('#stuFormPanel').classList.add('hidden');
  document.body.classList.remove('modal-open');
  focusUserScanInput();
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

async function removeStudent(studentRef) {
  const s = students.find((x) => x.student_key === studentRef);
  const confirmed = await confirmDeletion({
    title: `Remove ${s ? s.name : 'this student'}?`,
    message: 'Their attendance history will be kept and their card will be freed.',
    confirmText: 'Remove student',
  });
  if (!confirmed) return;
  await api('/students/' + studentRef, { method: 'DELETE' });
  students = students.filter((student) => student.student_key !== studentRef);
  selectedStudentRefs.delete(studentRef);
  clearForm();
  showAccountToast(`${s ? s.name : 'Student'} removed. Attendance history was kept.`);
  renderStudents();
}

$('#stuForm').onsubmit = async (e) => {
  e.preventDefault();
  const id = $('#sfId').value;
  if (!id && !studentRfidScanned) {
    showFieldValidation($('#sfUid'), 'Scan an RFID card with the reader before adding this student.');
    $('#sfUid').focus();
    return;
  }
  const body = {
    lrn: $('#sfLrn').value,
    surname: $('#sfSurname').value,
    first_name: $('#sfFirstName').value,
    middle_name: $('#sfMiddleName').value,
    name_extension: $('#sfNameExtension').value,
    grade: $('#sfClass').value.split('::')[0],
    section: $('#sfClass').value.split('::').slice(1).join('::'),
    rfid_uid: $('#sfUid').value,
    rfid_scanned: !id && studentRfidScanned,
    parent_name: $('#sfParent').value,
    parent_phone: $('#sfPhone').value,
    consent: $('#sfConsent').checked,
    parent_email: $('#sfEmail').value,
    email_consent: $('#sfEmailConsent').checked,
  };
  try {
    if (userAddMode) {
      await api('/user/students', { method: 'POST', body });
      clearForm();
      showUserNotice('success', 'Enrollment request submitted', 'The student will be enrolled only after an administrator approves the request.');
      return;
    }
    await api(id ? '/students/' + id : '/students', { method: id ? 'PUT' : 'POST', body });
    clearForm();
    showUserNotice('success', id ? 'Student updated' : 'Student enrolled', id
      ? 'The roster is up to date.'
      : 'The student record is ready.');
    loadStudents().catch(showLoadError);
  } catch (err) {
    $('#sfMsg').className = 'err';
    $('#sfMsg').textContent = operationError(err, 'save this student', 'review the highlighted fields and submit again.');
    showOperationNotice(err, 'save this student', 'review the highlighted fields and submit again.');
    if (/LRN is required|LRN already exists|LRN or RFID/i.test(err.message)) {
      showFieldValidation($('#sfLrn'), `${err.message}. Check the learner reference number and correct it, or ask the admin to review the existing record.`);
    } else if (/RFID/i.test(err.message)) {
      showFieldValidation($('#sfUid'), `${err.message}. Scan the correct card or ask the admin to release the existing card.`);
    } else if (/parent email/i.test(err.message)) {
      showFieldValidation($('#sfEmail'), `${err.message}. Enter a valid address or leave this optional field blank.`);
    } else if (/section/i.test(err.message)) {
      showFieldValidation($('#sfClass'), `${err.message}. Choose a section created by the admin.`);
    }
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
      .join('') || emptyTableRow(
      8,
      all.length ? 'No students match this risk filter.' : 'There are no student records to assess.',
      all.length
        ? 'No students in the selected month meet the chosen risk level.'
        : 'The report is empty because no attendance records are available for this month.',
      all.length ? 'review-all-risk' : 'add-student'
    ));
}
$('#riskFilter').onchange = () => loadRisk().then(clearLoadError).catch(showLoadError);
$('#riskMonth').onchange = () => loadRisk().then(clearLoadError).catch(showLoadError);
$('#riskExport').onclick = () => {
  const month = encodeURIComponent($('#riskMonth').value);
  download(`/export/risk.csv?month=${month}`, `early-warning-${$('#riskMonth').value}.csv`)
    .then(() => showAccountToast('Early-warning report downloaded.'))
    .catch((e) => showOperationNotice(e, 'download the early-warning report', 'check your connection and retry.'));
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
      .join('') || emptyTableRow(
      6,
      'No parent notifications have been logged.',
      'The log stays empty until a notification is attempted.'
    ));
}

$('#deleteAllSms').onclick = async () => {
  const confirmed = await confirmDeletion({
    title: 'Delete all notification logs?',
    message: 'This permanently deletes every notification log entry. It does not recall messages that have already been sent.',
    confirmText: 'Delete logs',
  });
  if (!confirmed) return;
  const button = $('#deleteAllSms');
  button.disabled = true;
  $('#smsDeleteMsg').textContent = '';
  try {
    const result = await api('/notifications', { method: 'DELETE' });
    $('#smsDeleteMsg').textContent = `${result.deleted} notification log entr${result.deleted === 1 ? 'y' : 'ies'} deleted.`;
    showAccountToast(`${result.deleted} notification log entr${result.deleted === 1 ? 'y was' : 'ies were'} deleted.`);
    await loadNotifications();
  } catch (err) {
    $('#smsDeleteMsg').textContent = err.status === 404
      ? 'This server does not support deleting notification logs yet. Restart the server with npm start, then reload this page.'
      : `Could not delete notification logs: ${err.message}`;
    showOperationNotice(err, 'delete notification logs', 'restart the server if this action is unsupported, or retry.');
  } finally {
    button.disabled = false;
  }
};

// ---------- settings ----------
function changeThemeFromControl(event) {
  const darkModeEnabled = event.currentTarget.checked;
  setTheme(darkModeEnabled ? 'dark' : 'light', true);
}

$('#darkModeToggle').onchange = changeThemeFromControl;
$('#userDarkModeToggle').onchange = changeThemeFromControl;

function updateThemeControl(darkModeEnabled) {
  for (const prefix of ['', 'user']) {
    const toggle = $(`#${prefix ? 'userDarkModeToggle' : 'darkModeToggle'}`);
    const label = $(`#${prefix ? 'userThemeModeLabel' : 'themeModeLabel'}`);
    toggle.checked = darkModeEnabled;
    toggle.setAttribute('aria-label', darkModeEnabled ? 'Switch to light mode' : 'Switch to dark mode');
    label.textContent = darkModeEnabled ? 'Dark mode' : 'Light mode';
  }
  $('#themeMsg').textContent = `${darkModeEnabled ? 'Dark' : 'Light'} mode is on. Theme choice is saved in this browser.`;
  $('#userThemeMsg').textContent = `${darkModeEnabled ? 'Dark' : 'Light'} mode is on. Theme choice is saved in this browser.`;
}

updateThemeControl(document.documentElement.dataset.theme === 'dark');

let userNoticeTimer;
function showUserNotice(type, title, message) {
  const notice = $('#userNotice');
  if (!$('#login').classList.contains('hidden') || !$('#adminRecovery').classList.contains('hidden')) {
    clearTimeout(userNoticeTimer);
    notice.classList.add('hidden');
    return;
  }
  if (!notice.classList.contains('hidden') &&
      notice.dataset.type === type &&
      $('#userNoticeTitle').textContent === title &&
      $('#userNoticeMessage').textContent === message) return;
  clearTimeout(userNoticeTimer);
  notice.dataset.type = type;
  notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
  notice.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  notice.style.setProperty('--notice-duration', '3s');
  $('#userNoticeIcon').textContent = type === 'success' ? '✓' : type === 'warning' ? '!' : type === 'error' ? '×' : 'i';
  $('#userNoticeTitle').textContent = title;
  $('#userNoticeMessage').textContent = message;
  notice.classList.remove('hidden');
  const progress = $('#userNoticeProgress');
  progress.classList.remove('user-notice-progress-running');
  void progress.offsetWidth;
  progress.classList.add('user-notice-progress-running');
  userNoticeTimer = setTimeout(() => notice.classList.add('hidden'), 3000);
}
function showAccountToast(message) {
  showUserNotice('success', 'Success', message);
}
function showOperationNotice(error, operation, resolution) {
  const title = error instanceof TypeError
    ? 'Connection problem'
    : error && error.status >= 500
      ? 'Service problem'
      : error && error.status === 403
        ? 'Permission problem'
        : error && error.status === 404
          ? 'App version problem'
          : 'Action could not be completed';
  showUserNotice('error', title, operationError(error, operation, resolution));
}

function closeDeleteConfirmation(confirmed = false) {
  const modal = $('#deleteConfirmModal');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  $('#deleteConfirmPhrase').value = '';
  $('#deleteConfirmError').textContent = '';
  $('#deleteConfirmPhraseLabel').classList.add('hidden');
  document.body.classList.remove('modal-open');
  const resolve = pendingDeleteConfirmation;
  pendingDeleteConfirmation = null;
  resolve?.(confirmed);
}

function confirmDeletion({ title, message, confirmText = 'Delete', requiredPhrase = '' }) {
  if (pendingDeleteConfirmation) closeDeleteConfirmation(false);
  $('#deleteConfirmTitle').textContent = title;
  $('#deleteConfirmMessage').textContent = message;
  $('#confirmDeleteAction').textContent = confirmText;
  $('#deleteConfirmPhraseLabel').classList.toggle('hidden', !requiredPhrase);
  $('#deleteConfirmPhrase').value = '';
  $('#deleteConfirmError').textContent = '';
  $('#deleteConfirmModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  if (requiredPhrase) $('#deleteConfirmPhrase').focus();
  else $('#confirmDeleteAction').focus();
  return new Promise((resolve) => {
    pendingDeleteConfirmation = resolve;
  });
}

$('#confirmDeleteAction').onclick = () => {
  const expected = $('#deleteConfirmPhraseLabel').classList.contains('hidden') ? '' : 'DELETE ALL';
  if (expected && $('#deleteConfirmPhrase').value !== expected) {
    $('#deleteConfirmError').textContent = 'Type DELETE ALL exactly to confirm. Nothing has been deleted yet.';
    $('#deleteConfirmPhrase').focus();
    return;
  }
  closeDeleteConfirmation(true);
};
$('#cancelDeleteAction').onclick = () => closeDeleteConfirmation(false);
$('#deleteConfirmModal').onclick = (event) => {
  if (event.target === $('#deleteConfirmModal')) closeDeleteConfirmation(false);
};
$('#deleteConfirmPhrase').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('#confirmDeleteAction').click();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#deleteConfirmModal').classList.contains('hidden')) {
    closeDeleteConfirmation(false);
  }
});

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
    showOperationNotice(err, 'load account and recovery settings', 'check your connection and try opening account settings again.');
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
    showOperationNotice(error, 'save password recovery settings', 'check the selected questions, answers, and current admin password.');
  } finally {
    button.disabled = false;
  }
}

$('#recoverySettingsForm').onsubmit = async (event) => {
  event.preventDefault();
  await saveRecoverySettings();
};
$('#clearRecoverySettings').onclick = async () => {
  const confirmed = await confirmDeletion({
    title: 'Remove password recovery questions?',
    message: 'Admin password recovery will be disabled until new recovery questions are configured.',
    confirmText: 'Remove questions',
  });
  if (!confirmed) return;
  await saveRecoverySettings(true);
};

$('#closeAccountModal').onclick = closeAccountModal;
$('#accountModal').onclick = (event) => {
  if (event.target === $('#accountModal')) closeAccountModal();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#accountModal').classList.contains('hidden')) closeAccountModal();
});

const scheduleTimeFields = [
  $('#morningLateTime'),
  $('#morningEndTime'),
  $('#afternoonLateTime'),
  $('#afternoonEndTime'),
];
function updateScheduleOrderValidation() {
  scheduleTimeFields.forEach((field) => field.setCustomValidity(''));
  if (scheduleTimeFields.some((field) => !field.value || !field.validity.valid)) return;
  const fieldNames = ['Morning late cutoff', 'Morning class finish', 'Afternoon late cutoff', 'Afternoon class finish'];
  for (let index = 0; index < scheduleTimeFields.length - 1; index++) {
    if (scheduleTimeFields[index].value >= scheduleTimeFields[index + 1].value) {
      const field = scheduleTimeFields[index + 1];
      field.setCustomValidity(`${fieldNames[index + 1]} must be later than ${fieldNames[index]}. Choose a later time.`);
      if (field.getAttribute('aria-invalid') === 'true') showFieldValidation(field);
      return;
    }
  }
  scheduleTimeFields.forEach(clearFieldValidation);
}
scheduleTimeFields.forEach((field) => field.addEventListener('input', updateScheduleOrderValidation));
scheduleTimeFields.forEach((field) => field.addEventListener('change', updateScheduleOrderValidation));

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
  updateScheduleOrderValidation();
  const hols = await api('/holidays');
  $('#holTable').innerHTML = `<thead><tr><th>Date</th><th>Holiday / suspension</th><th>Reason</th><th></th></tr></thead><tbody>${
    hols
      .map(
        (h) =>
          `<tr><td>${esc(h.date === (h.end_date || h.date) ? h.date : `${h.date} – ${h.end_date}`)}</td><td>${esc(h.name)}</td><td class="holiday-reason-cell">${esc(h.reason || 'No reason recorded')}</td><td><button class="small ghost" data-hol="${esc(h.date)}">Remove</button></td></tr>`
      )
      .join('') || `<tr><td colspan="4">${emptyState(
        'No holidays or suspensions are listed.',
        'Weekends are skipped automatically; dates not listed may be treated as school days.'
      )}</td></tr>`
  }</tbody>`;
  $('#holTable').querySelectorAll('[data-hol]').forEach((b) => {
    b.onclick = async () => {
      const confirmed = await confirmDeletion({
        title: `Remove no-class day ${b.dataset.hol}?`,
        message: 'This date will be treated as a school day again and may count toward attendance.',
        confirmText: 'Remove date',
      });
      if (!confirmed) return;
      try {
        await api('/holidays/' + b.dataset.hol, { method: 'DELETE' });
        showAccountToast('No-class day removed. Attendance will count that date as a school day again.');
        await loadSettings();
      } catch (error) {
        showOperationNotice(error, 'remove this no-class day', 'reload Settings and retry.');
      }
    };
  });
}

$('#setForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#setMsg').className = 'muted';
  $('#setMsg').textContent = '';
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
    $('#setMsg').textContent = 'Settings saved. Your schedule and notification preferences are updated.';
    showAccountToast('Settings saved. Your schedule and notification preferences are updated.');
  } catch (err) {
    $('#setMsg').className = 'err';
    $('#setMsg').textContent = operationError(err, 'save settings', 'check the highlighted schedule times and retry.');
    showOperationNotice(err, 'save settings', 'check the highlighted schedule times and retry.');
    if (/Times must be ordered/.test(err.message)) {
      updateScheduleOrderValidation();
      const field = scheduleTimeFields.find((control) => control.validity.customError);
      if (field) {
        showFieldValidation(field, field.validationMessage);
        field.focus();
      }
    }
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
    showAccountToast('Account changes saved. Your new sign-in details are active.');
  } catch (err) {
    message.className = 'err';
    message.textContent = operationError(err, 'save account changes', 'check the account details and try again.');
    showOperationNotice(err, 'save account changes', 'check the account details and try again.');
  }
};

$('#clearAllData').onclick = async () => {
  const confirmed = await confirmDeletion({
    title: 'Permanently delete all saved data?',
    message: 'This erases all students, attendance, taps, notification logs, unknown cards, holidays, settings, and saved account credentials. Configured accounts will be recreated and settings will return to defaults. This cannot be undone.',
    confirmText: 'Delete all data',
    requiredPhrase: 'DELETE ALL',
  });
  if (!confirmed) return;

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
    selectedStudentRefs.clear();
    const notificationCount = Number(result.deleted.notifications) || 0;
    $('#clearAllDataMsg').textContent = `All saved data erased (${total} records), including ${notificationCount} notification log entr${notificationCount === 1 ? 'y' : 'ies'}. Accounts were reset to configured credentials and settings returned to defaults.`;
    showAccountToast(`All saved data erased (${total} records). Accounts and settings were reset to configured defaults.`);
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
    showOperationNotice(err, 'clear saved data', 'check the server connection and retry only if you still intend to erase all records.');
  } finally {
    button.disabled = false;
  }
};

$('#holForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#holMsg').className = 'muted';
  $('#holMsg').textContent = '';
  try {
    const date = $('#holDate').value;
    const endDate = $('#holUntil').value || date;
    await api('/holidays', {
      method: 'POST',
      body: { date, end_date: endDate, name: $('#holName').value, reason: $('#holReason').value },
    });
    $('#holForm').reset();
    $('#holMsg').textContent = 'No-class period and suspension reason saved. The notice will appear on the student scan display throughout the date range.';
    showAccountToast('No-class period and suspension reason saved.');
    loadSettings().catch(showLoadError);
  } catch (err) {
    $('#holMsg').className = 'err';
    $('#holMsg').textContent = operationError(err, 'save this no-class day', 'check the date and retry.');
    showOperationNotice(err, 'save this no-class day', 'check the date and retry.');
  }
};

$('#holDate').addEventListener('change', () => {
  const until = $('#holUntil');
  until.min = $('#holDate').value;
  if (until.value && until.value < until.min) until.value = '';
});

boot();
