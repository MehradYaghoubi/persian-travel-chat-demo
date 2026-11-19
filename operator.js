const API = window.location.origin;
let currentChatType = 'ground';
let currentScope = 'all';
let currentSessionId = null;
let currentSessionData = null;
['op_token', 'op_username', 'op_fullname', 'op_role', 'op_password_change_required'].forEach(key => localStorage.removeItem(key));
let currentUserToken = sessionStorage.getItem('operator_token_v2');
let currentUsername = null;
let currentFullName = null;
let currentUserRole = 'operator';
const pendingOperatorTurns = new Set();
let operatorHistoryRevision = 0;
let renderedOperatorHistoryKey = null;
let adminOperatorRows = [];
let editingOperatorUsername = null;
let jalaliPickerMonth = null;
let jalaliPickerTarget = null;
let passwordChangeRequired = false;
let operatorLunchInfo = null;

function clearOperatorSession() {
    renderedOperatorHistoryKey = null;
    ['operator_token_v2'].forEach(key => sessionStorage.removeItem(key));
    currentUserToken = currentUsername = currentFullName = null;
    currentUserRole = 'operator';
    passwordChangeRequired = false;
}

function expireOperatorSession() {
    clearOperatorSession();
    currentSessionId = null;
    currentSessionData = null;
    document.getElementById('sessionList').replaceChildren();
    document.getElementById('chatHistory').replaceChildren();
    document.getElementById('activeChatView').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('operatorMessageInput').value = '';
    const app = document.querySelector('.app-container');
    app.classList.remove('authenticated');
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
    document.getElementById('loginOverlay').style.display = 'flex';
}

async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (currentUserToken) headers.set('Authorization', `Bearer ${currentUserToken}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 && currentUserToken) expireOperatorSession();
    return response;
}

function gregorianToJalali(gy, gm, gd) {
    var g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    var gy2 = (gm > 2) ? (gy + 1) : gy;
    var days = (365 * gy) + (Math.floor((gy2 + 3) / 4)) - (Math.floor((gy2 + 99) / 100)) + (Math.floor((gy2 + 399) / 400)) - 80 + gd + g_d_m[gm - 1];
    jy += 33 * (Math.floor(days / 12053));
    days %= 12053;
    jy += 4 * (Math.floor(days / 1461));
    days %= 1461;
    jy += Math.floor((days - 1) / 365);
    if (days > 0) days = (days - 1) % 365;
    var jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
    var jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
    return [jy, jm, jd];
}

function formatJalaliDateTime(isoStr) {
    if (!isoStr) return '';
    try {
        var d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        var j = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
        var jy = j[0], jm = String(j[1]).padStart(2, '0'), jd = String(j[2]).padStart(2, '0');
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return `${jy}/${jm}/${jd} ${hh}:${mm}`;
    } catch(e) {
        return isoStr;
    }
}

async function checkAuth() {
    const overlay = document.getElementById('loginOverlay');
    overlay.style.display = 'flex';
    if (!currentUserToken) { expireOperatorSession(); return; }
    try {
        const res = await fetch(`${API}/api/operator/auth/session`, { headers: { Authorization: `Bearer ${currentUserToken}` } });
        if (!res.ok) throw new Error('نشست نامعتبر است');
        const data = await res.json();
        currentUsername = data.username;
        currentFullName = data.full_name;
        currentUserRole = data.role || 'operator';
        passwordChangeRequired = !!data.password_change_required;
        renderOperatorLunch(data);
        overlay.style.display = 'none';
        const app = document.querySelector('.app-container');
        app.inert = false;
        app.removeAttribute('aria-hidden');
        app.classList.add('authenticated');
        document.getElementById('operatorWelcome').textContent = `کاربر: ${currentFullName || currentUsername} (${currentUserRole === 'admin' ? 'مدیر' : 'اپراتور'})`;
        document.getElementById('btnAdminOperators').style.display = currentUserRole === 'admin' ? 'inline-block' : 'none';
        const isAdmin = currentUserRole === 'admin';
        document.querySelectorAll('.chat-actions button').forEach(button => button.hidden = isAdmin);
        document.querySelector('.new-chat-btn').style.display = isAdmin ? 'none' : '';
        updateOperatorComposer();
        document.getElementById('adminReadonlyNotice').style.display = isAdmin ? 'inline-block' : 'none';
        document.getElementById('operatorAdminFilterRow').style.display = isAdmin ? 'block' : 'none';
        if (passwordChangeRequired) { openProfileModal(); return; }
        if (isAdmin) populateAdminFilterSelect();
        loadSessions();
    } catch (_) {
        expireOperatorSession();
    }
}

async function populateAdminFilterSelect() {
    if (currentUserRole !== 'admin') return;
    try {
        const res = await apiFetch(`${API}/api/operator/admin/operators`);
        if (!res.ok) throw new Error('فهرست اپراتورها بارگذاری نشد');
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('پاسخ فهرست اپراتورها معتبر نیست');
        const sel = document.getElementById('adminOperatorSelectFilter');
        const currVal = sel.value;
        sel.innerHTML = '<option value="">همه اپراتورها (کل چت‌ها)</option>' +
            list.map(o => `<option value="${escapeHtml(o.username)}">${escapeHtml(o.full_name)} (${escapeHtml(o.username)})</option>`).join('');
        sel.value = currVal;
    } catch(e) { console.error(e); }
}

async function submitLogin() {
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;
    if (!u || !p) return alert('نام کاربری و رمز عبور را وارد کنید');

    try {
        const res = await fetch(`${API}/api/operator/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            currentUserToken = data.token;
            currentUsername = data.username;
            currentFullName = data.full_name;
            currentUserRole = data.role || 'operator';
            sessionStorage.setItem('operator_token_v2', currentUserToken);
            passwordChangeRequired = !!data.password_change_required;
            await checkAuth();
        } else {
            alert(data.detail || 'ورود ناموفق بود');
        }
    } catch (e) {
        alert('خطا در ارتباط با سرور');
    }
}

async function logoutOperator() {
    if (!currentUserToken) return;
    try {
        const res = await apiFetch(`${API}/api/operator/auth/logout`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            alert(data.detail || 'امکان خروج وجود ندارد');
            return;
        }
        clearOperatorSession();
        checkAuth();
    } catch (e) {
        alert('خطا در خروج');
    }
}

// Profile Modal
function openProfileModal() {
    document.getElementById('profileFullName').value = currentFullName || '';
    document.getElementById('profilePassword').value = '';
    document.getElementById('profileCancel').style.display = passwordChangeRequired ? 'none' : 'inline-block';
    document.getElementById('profileModal').classList.add('show');
}
function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('show');
}

async function submitProfileUpdate() {
    const fn = document.getElementById('profileFullName').value.trim();
    const pw = document.getElementById('profilePassword').value;
    if (passwordChangeRequired && pw.length < 12) return alert('رمز جدید باید حداقل ۱۲ نویسه باشد');

    try {
        const res = await apiFetch(`${API}/api/operator/auth/profile`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full_name: fn || null, password: pw || null })
        });
        if (res.ok) {
            if (fn) {
                currentFullName = fn;
            }
            alert('پروفایل بروزرسانی شد');
            closeProfileModal();
            if (pw) {
                clearOperatorSession();
                checkAuth();
                alert('رمز تغییر کرد؛ لطفاً دوباره وارد شوید.');
                return;
            }
            checkAuth();
        } else {
            alert('خطا در بروزرسانی پروفایل');
        }
    } catch (e) {
        alert('خطا در ارتباط با سرور');
    }
}

// Admin Modal
async function openAdminModal() {
    if (currentUserRole !== 'admin') return;
    document.getElementById('adminModal').classList.add('show');
    resetAdminAccountForm();
    loadAdminOperatorsList();
}

function renderOperatorLunch(data = operatorLunchInfo || {}) {
    operatorLunchInfo = data;
    const button = document.getElementById('operatorLunchButton');
    const status = document.getElementById('operatorLunchStatus');
    if (!button || !status) return;
    const visible = currentUserRole === 'operator';
    button.hidden = !visible;
    status.hidden = !visible;
    if (!visible) return;
    if (data.lunch_active && data.lunch_until) {
        const time = new Date(data.lunch_until).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });
        button.disabled = true;
        button.textContent = 'ناهار فعال';
        status.textContent = `نشست تا ${time} تمدید شد؛ در این مدت همچنان چت می‌گیرید و پاسخ می‌دهید.`;
        return;
    }
    if (data.lunch_available_today) {
        button.disabled = false;
        button.textContent = 'تمدید ناهار';
        status.textContent = 'در صورت نیاز، نشست برای یک ساعت تمدید می‌شود؛ چت‌ها همچنان به شما ارجاع می‌شوند.';
    } else {
        button.disabled = true;
        button.textContent = 'ناهار استفاده شد';
        status.textContent = 'سهم یک‌ساعته امروز استفاده شده است.';
    }
}

async function activateLunch() {
    if (!currentUserToken || !confirm('نشست شما برای یک ساعت تمدید می‌شود و سهم امروز مصرف خواهد شد. ادامه می‌دهید؟')) return;
    const button = document.getElementById('operatorLunchButton');
    button.disabled = true;
    try {
        const res = await apiFetch(`${API}/api/operator/auth/lunch`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'تمدید نشست انجام نشد');
        renderOperatorLunch(data);
    } catch (error) {
        button.disabled = false;
        alert(error.message || 'خطا در تمدید نشست');
    }
}
function jalaliToGregorian(jy, jm, jd) {
    jy += 1595;
    let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
    let gy = 400 * Math.floor(days / 146097); days %= 146097;
    if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
    gy += 4 * Math.floor(days / 1461); days %= 1461;
    if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
    let gd = days + 1;
    const monthDays = [0,31,((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
    let gm = 1;
    while (gm <= 12 && gd > monthDays[gm]) gd -= monthDays[gm++];
    return [gy, gm, gd];
}

const jalaliMonthNames = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
const faDigits = value => String(value).replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[digit]);
function jalaliMonthLength(year, month) {
    const next = month === 12 ? jalaliToGregorian(year + 1, 1, 1) : jalaliToGregorian(year, month + 1, 1);
    const first = jalaliToGregorian(year, month, 1);
    return Math.round((Date.UTC(next[0], next[1] - 1, next[2]) - Date.UTC(first[0], first[1] - 1, first[2])) / 86400000);
}
function hideJalaliPicker() {
    const picker = document.getElementById('jalaliPicker');
    if (picker) picker.hidden = true;
    jalaliPickerTarget = null;
}
function openJalaliPicker(inputId, button) {
    const input = document.getElementById(inputId);
    const picker = document.getElementById('jalaliPicker');
    const today = new Date();
    const parsed = (input.value || '').split(/[/-]/).map(Number);
    const current = parsed.length === 3 && parsed.every(Boolean) ? parsed : gregorianToJalali(today.getFullYear(), today.getMonth() + 1, today.getDate());
    jalaliPickerMonth = { year: current[0], month: current[1] };
    jalaliPickerTarget = inputId;
    renderJalaliPicker();
    const rect = (button || input).getBoundingClientRect();
    picker.hidden = false;
    picker.style.top = `${Math.max(8, Math.min(window.innerHeight - 300, rect.bottom + 6))}px`;
    picker.style.left = `${Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288))}px`;
}
function renderJalaliPicker() {
    if (!jalaliPickerMonth) return;
    const { year, month } = jalaliPickerMonth;
    const picker = document.getElementById('jalaliPicker');
    const first = jalaliToGregorian(year, month, 1);
    const weekday = (new Date(first[0], first[1] - 1, first[2]).getDay() + 1) % 7;
    const days = jalaliMonthLength(year, month);
    const inputValue = document.getElementById(jalaliPickerTarget)?.value || '';
    const today = gregorianToJalali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    const cells = ['ش','ی','د','س','چ','پ','ج'].map(day => `<span>${day}</span>`).join('')
        + Array.from({length: weekday}, () => '<span></span>').join('')
        + Array.from({length: days}, (_, index) => {
            const day = index + 1, value = `${year}/${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}`;
            const cls = [value === inputValue ? 'selected' : '', year === today[0] && month === today[1] && day === today[2] ? 'today' : ''].filter(Boolean).join(' ');
            return `<button type="button" class="${cls}" onclick="selectJalaliDate(${year},${month},${day})">${faDigits(day)}</button>`;
        }).join('');
    picker.innerHTML = `<div class="jalali-picker-head"><button type="button" onclick="shiftJalaliMonth(-1)" aria-label="ماه قبل">›</button><strong class="jalali-picker-title">${jalaliMonthNames[month - 1]} ${faDigits(year)}</strong><button type="button" onclick="shiftJalaliMonth(1)" aria-label="ماه بعد">‹</button></div><div class="jalali-calendar">${cells}</div>`;
}
function shiftJalaliMonth(delta) {
    jalaliPickerMonth.month += delta;
    if (jalaliPickerMonth.month < 1) { jalaliPickerMonth.month = 12; jalaliPickerMonth.year--; }
    if (jalaliPickerMonth.month > 12) { jalaliPickerMonth.month = 1; jalaliPickerMonth.year++; }
    renderJalaliPicker();
}
function selectJalaliDate(year, month, day) {
    document.getElementById(jalaliPickerTarget).value = `${year}/${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}`;
    hideJalaliPicker();
    applyFilters();
}
document.addEventListener('click', event => {
    const picker = document.getElementById('jalaliPicker');
    if (picker && !picker.hidden && !picker.contains(event.target) && !event.target.closest('.date-open-btn')) hideJalaliPicker();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideJalaliPicker(); });
function closeAdminModal() {
    document.getElementById('adminModal').classList.remove('show');
    resetAdminAccountForm();
}

async function loadAdminOperatorsList() {
    try {
        const [accountsResponse, activeResponse] = await Promise.all([
            apiFetch(`${API}/api/operator/admin/operators`),
            apiFetch(`${API}/api/operator/auth/active`).catch(() => null)
        ]);
        if (!accountsResponse.ok) throw new Error('حساب‌ها بارگذاری نشدند');
        const accounts = await accountsResponse.json();
        const online = activeResponse?.ok ? new Set((await activeResponse.json()).map(op => op.username)) : new Set();
        adminOperatorRows = accounts.map(account => ({ ...account, is_online: online.has(account.username) }));
        renderAdminOperators();
    } catch (e) {
        document.getElementById('adminAccountStatus').textContent = e.message || 'خطا در دریافت حساب‌ها';
    }
}

function renderAdminOperators() {
    const query = document.getElementById('adminOperatorSearch').value.trim().toLowerCase();
    const role = document.getElementById('adminAccountRoleFilter').value;
    const state = document.getElementById('adminAccountStateFilter').value;
    const list = adminOperatorRows.filter(op => {
        const matchesText = !query || `${op.username} ${op.full_name || ''}`.toLowerCase().includes(query);
        return matchesText && (!role || op.role === role) && (!state || (state === 'active') === op.is_active);
    });
    const tbody = document.getElementById('adminOperatorsTable');
    tbody.innerHTML = list.map(op => `<tr>
        <td>${escapeHtml(op.username)}</td><td>${escapeHtml(op.full_name || '-')}</td>
        <td>${op.role === 'admin' ? 'مدیر' : 'اپراتور'}</td>
        <td>${op.is_active ? 'فعال' : 'غیرفعال'}</td>
        <td class="operator-state" style="color:${op.is_online ? '#087f8c' : '#8b9ba5'}">${op.is_online ? 'آنلاین' : 'آفلاین'}</td>
        <td><div class="operator-row-actions"><button class="operator-row-action" data-action="edit" data-username="${escapeHtml(op.username)}">ویرایش</button>${op.username !== 'admin' ? `<button class="operator-row-action" data-action="toggle" data-username="${escapeHtml(op.username)}">${op.is_active ? 'غیرفعال‌کردن' : 'فعال‌کردن'}</button><button class="operator-row-action danger" data-action="delete" data-username="${escapeHtml(op.username)}">حذف</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="6">حسابی پیدا نشد.</td></tr>';
    tbody.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
        const { action, username } = button.dataset;
        if (action === 'edit') adminEditOperator(username);
        else if (action === 'toggle') adminToggleOperator(username);
        else if (action === 'delete') adminDeleteOperator(username);
    }));
}

function resetAdminAccountForm() {
    editingOperatorUsername = null;
    document.getElementById('adminNewUser').disabled = false;
    document.getElementById('adminNewUser').value = '';
    document.getElementById('adminNewPass').value = '';
    document.getElementById('adminNewPass').placeholder = 'حداقل ۱۲ نویسه';
    document.getElementById('adminNewName').value = '';
    document.getElementById('adminNewRole').value = 'operator';
    document.getElementById('adminAccountActiveWrap').hidden = true;
    document.getElementById('adminAccountActive').disabled = false;
    document.getElementById('adminAccountFormTitle').textContent = 'ثبت حساب اپراتور';
    document.getElementById('adminAccountSubmit').textContent = 'ثبت حساب';
    document.getElementById('adminAccountCancel').hidden = true;
    document.getElementById('adminAccountStatus').textContent = '';
}

function adminEditOperator(username) {
    const op = adminOperatorRows.find(item => item.username === username);
    if (!op) return;
    editingOperatorUsername = username;
    document.getElementById('adminNewUser').value = op.username;
    document.getElementById('adminNewUser').disabled = true;
    document.getElementById('adminNewPass').value = '';
    document.getElementById('adminNewPass').placeholder = 'خالی بماند تا رمز تغییر نکند';
    document.getElementById('adminNewName').value = op.full_name || '';
    document.getElementById('adminNewRole').value = op.role;
    document.getElementById('adminAccountActive').checked = op.is_active;
    document.getElementById('adminAccountActive').disabled = username === 'admin';
    document.getElementById('adminAccountActiveWrap').hidden = false;
    document.getElementById('adminAccountFormTitle').textContent = `ویرایش حساب ${op.full_name || username}`;
    document.getElementById('adminAccountSubmit').textContent = 'ذخیره تغییرات';
    document.getElementById('adminAccountCancel').hidden = false;
    document.getElementById('adminAccountStatus').textContent = 'برای حفظ رمز فعلی، فیلد رمز را خالی بگذارید.';
    document.getElementById('adminAccountFormTitle').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function adminCreateOperator() {
    const u = document.getElementById('adminNewUser').value.trim();
    const p = document.getElementById('adminNewPass').value;
    const n = document.getElementById('adminNewName').value.trim();
    const r = document.getElementById('adminNewRole').value;
    const status = document.getElementById('adminAccountStatus');
    if (!u || !n || (!editingOperatorUsername && p.length < 12)) {
        status.textContent = !u || !n ? 'نام کاربری و نام نمایشی را وارد کنید.' : 'رمز عبور باید دست‌کم ۱۲ نویسه باشد.';
        return;
    }

    try {
        const editing = !!editingOperatorUsername;
        const url = editing ? `${API}/api/operator/admin/operators/${encodeURIComponent(editingOperatorUsername)}` : `${API}/api/operator/admin/operators`;
        const payload = editing
            ? { full_name: n, role: r, is_active: document.getElementById('adminAccountActive').checked, password: p || null }
            : { username: u, password: p, full_name: n, role: r };
        const res = await apiFetch(url, {
            method: editing ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'تغییر حساب ذخیره نشد');
        const successMessage = editing ? 'تغییرات حساب ذخیره شد.' : 'حساب جدید ساخته شد.';
        resetAdminAccountForm();
        await loadAdminOperatorsList();
        status.textContent = successMessage;
    } catch (e) {
        status.textContent = e.message || 'خطا در ارتباط با سرور';
    }
}

async function adminToggleOperator(username) {
    const op = adminOperatorRows.find(item => item.username === username);
    if (!op) return;
    try {
        const res = await apiFetch(`${API}/api/operator/admin/operators/${encodeURIComponent(username)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !op.is_active })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'وضعیت حساب تغییر نکرد');
        await loadAdminOperatorsList();
    } catch (e) { document.getElementById('adminAccountStatus').textContent = e.message || 'خطا در تغییر وضعیت حساب'; }
}

async function adminDeleteOperator(username) {
    if (!confirm(`آیا از حذف حساب ${username} اطمینان دارید؟`)) return;
    try {
        const res = await apiFetch(`${API}/api/operator/admin/operators/${encodeURIComponent(username)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'حذف حساب انجام نشد');
        await loadAdminOperatorsList();
    } catch (e) {
        document.getElementById('adminAccountStatus').textContent = e.message || 'خطا در حذف اپراتور';
    }
}

// Tab Switch
function switchTab(type) {
    currentChatType = type;
    document.getElementById('tabGround').classList.toggle('active', type === 'ground');
    document.getElementById('tabPackage').classList.toggle('active', type === 'package');
    document.getElementById('tabFlight').classList.toggle('active', type === 'flight');
    loadSessions();
}

function switchScope(scope) {
    currentScope = scope;
    document.getElementById('filterScopeAll').classList.toggle('active', scope === 'all');
    document.getElementById('filterScopeMine').classList.toggle('active', scope === 'mine');
    loadSessions();
}

function applyFilters() {
    loadSessions();
}

function resetFilters() {
    ['searchInput','startDateInput','endDateInput'].forEach(id => document.getElementById(id).value = '');
    ['statusFilter','transferFilter','adminOperatorSelectFilter'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('includeArchivedCheck').checked = false;
    hideJalaliPicker();
    loadSessions();
}

function handleSearchKey(e) {
    if (e.key === 'Enter') loadSessions();
}

async function loadSessions() {
    if (!currentUserToken) return;
    const q = document.getElementById('searchInput').value.trim();
    const startDate = document.getElementById('startDateInput').value.trim();
    const endDate = document.getElementById('endDateInput').value.trim();
    const includeArchived = document.getElementById('includeArchivedCheck').checked;
    const adminOpFilter = document.getElementById('adminOperatorSelectFilter').value;
    const params = new URLSearchParams({ chat_type: currentChatType, include_archived: String(includeArchived) });
    if (startDate) params.set('start_date', jalaliToGregorian(...startDate.split('/').map(Number)).map(n => String(n).padStart(2, '0')).join('-'));
    if (endDate) params.set('end_date', jalaliToGregorian(...endDate.split('/').map(Number)).map(n => String(n).padStart(2, '0')).join('-'));
    const status = document.getElementById('statusFilter').value;
    const transferState = document.getElementById('transferFilter').value;
    if (status) params.set('status', status);
    if (transferState) params.set('transfer_state', transferState);
    if (currentUserRole === 'admin' && adminOpFilter) params.set('operator_username', adminOpFilter);
    const endpoint = q ? '/api/operator/chats/search' : '/api/operator/chats';
    if (q) params.set('q', q);
    const url = `${API}${endpoint}?${params}`;

    try {
        const res = await apiFetch(url);
        let data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'فیلتر چت‌ها اجرا نشد');

        if (currentScope === 'mine') {
            data = data.filter(s => s.metadata && s.metadata.assigned_operator === currentUsername);
        }

        renderSessionList(data);
    } catch (e) {
        document.getElementById('sessionList').innerHTML = `<div style="padding: 20px; text-align: center; color: #ef4444; font-size: 12px;">خطا در دریافت لیست چت‌ها</div>`;
    }
}

function renderSessionList(sessions) {
    const container = document.getElementById('sessionList');
    if (!sessions || !sessions.length) {
        container.innerHTML = `<div style="padding: 20px; text-align: center; color: #64748b; font-size: 12px;">هیچ چتی یافت نشد</div>`;
        return;
    }

    container.innerHTML = sessions.map(s => {
        let badgeClass = s.is_active ? 'badge-active' : 'badge-closed';
        let badgeText = s.is_active ? 'فعال' : 'بسته';

        if (s.metadata && s.metadata.status === 'completed') {
            badgeClass = 'badge-completed';
            badgeText = 'تکمیل شده ✅';
        } else if (s.metadata && ['pending_operator_action','pending_operator_assignment'].includes(s.metadata.status)) {
            badgeClass = 'badge-pending';
            badgeText = s.metadata.status === 'pending_operator_assignment' ? 'در انتظار اپراتور' : 'اقدام جدید 🔔';
        }

        if (s.is_archived) {
            badgeClass = 'badge-archived';
            badgeText = 'آرشیو';
        }

        const activeClass = (s.session_id === currentSessionId) ? 'active' : '';
        const archivedClass = s.is_archived ? 'archived' : '';
        const dateStr = s.created_at ? formatJalaliDateTime(s.created_at) : '';
        const assignedName = (s.metadata && s.metadata.assigned_operator_name) ? s.metadata.assigned_operator_name : 'نامشخص';
        const transferred = (s.metadata && (s.metadata.operator_segments || []).length > 1) || (s.metadata && s.metadata.transferred_to);

        return `
            <div class="session-item ${activeClass} ${archivedClass}" onclick="selectSession('${s.session_id}')">
                <div class="session-title">
                    <span>${escapeHtml(s.title || 'چت بدون عنوان')}</span>
                    <span class="session-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="session-meta">
                    <span>تلفن: ${escapeHtml(s.customer_phone || s.customer_name || 'ناشناس')}</span>
                    <span>${dateStr}</span>
                </div>
                <div class="session-meta" style="color:#526a7b;font-weight:600;">
                    <span>اپراتور: ${escapeHtml(assignedName)}</span><span>${transferred ? 'انتقال‌یافته ↗' : ''}</span>
                </div>
                <div class="session-lastmsg">${escapeHtml(s.last_message || 'بدون پیام')}</div>
            </div>
        `;
    }).join('');
}

async function selectSession(sessionId) {
    renderedOperatorHistoryKey = null;
    currentSessionId = sessionId;
    operatorHistoryRevision++;
    document.getElementById('chatHistory').replaceChildren();
    updateOperatorComposer();
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('activeChatView').style.display = 'flex';

    try {
        const res = await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        if (!res.ok) { currentSessionId = null; currentSessionData = null; document.getElementById('activeChatView').style.display = 'none'; document.getElementById('emptyState').style.display = 'flex'; loadSessions(); return; }
        if (sessionId !== currentSessionId) return;
        currentSessionData = data;

        document.getElementById('currentChatTitle').textContent = data.title || 'چت بدون عنوان';
        const assignedName = (data.metadata && data.metadata.assigned_operator_name) ? data.metadata.assigned_operator_name : 'نامشخص';
        const jalaliCreated = data.created_at ? formatJalaliDateTime(data.created_at) : '-';
        const segments = (data.metadata && data.metadata.operator_segments || []).map(s => `${s.full_name || s.username}: ${s.message_count || 0} پیام`).join('، ');
        const purpose = 'گفتگوی مشتری';
        document.getElementById('currentChatMeta').textContent = `${purpose} | کد: ${data.session_id} | مشتری: ${data.customer_name || 'مشتری'} | تلفن: ${data.customer_phone || '-'} | تاریخ: ${jalaliCreated} | ارجاع: ${assignedName}${segments ? ' | سهم: ' + segments : ''}`;
            data.metadata?.purpose === 'operator_assistant' && ['ground','flight'].includes(data.metadata?.bot_type) ? 'flex' : 'none';

        document.getElementById('btnCloseToggle').textContent = data.is_active ? 'بستن چت' : 'بازکردن مجدد';
        document.getElementById('btnArchiveToggle').textContent = data.is_archived ? 'خروج از آرشیو' : 'آرشیو';

        loadMessages(sessionId);
        loadSessions();
    } catch (e) {
        alert('خطا در دریافت جزئیات چت');
    }
}

async function loadMessages(sessionId) {
    const revision = operatorHistoryRevision;
    try {
        const res = await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(sessionId)}/messages`);
        const data = await res.json();
        const historyKey=sessionId+'\n'+JSON.stringify(data.messages||[]);
        if(historyKey===renderedOperatorHistoryKey)return;
        const historyContainer = document.getElementById('chatHistory');
        const wasAtBottom = historyContainer.scrollHeight - historyContainer.scrollTop - historyContainer.clientHeight < 48;

        historyContainer.innerHTML = (data.messages || []).map(m => {
            let roleClass = 'user';
            let roleName = 'پیام مشتری';

            if (m.role === 'bot') {
                roleClass = 'bot';
                roleName = 'دستیار محلی';
            } else if (m.role === 'user') {
                roleName = `مشتری: ${m.sender_name || (currentSessionData && currentSessionData.customer_name) || 'مشتری'}`;
            } else if (m.role === 'system' || (m.metadata && m.metadata.type === 'transfer')) {
                roleClass = 'system_transfer';
                roleName = 'سیستم انتقال';
            } else if (m.role === 'operator_note') {
                roleClass = 'operator_note';
                roleName = m.sender_name ? `اپراتور: ${m.sender_name}` : 'پیام / یادداشت اپراتور';
            }

            const timeStr = m.timestamp ? formatJalaliDateTime(m.timestamp) : '';

            return `
                <div class="message-bubble ${roleClass}">
                    <div class="message-role">${escapeHtml(roleName)}</div>
                    <div>${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>
                    <div class="message-time">${timeStr}</div>
                </div>
            `;
        }).join('');

        updateOperatorComposer();
        if (wasAtBottom) historyContainer.scrollTop = historyContainer.scrollHeight;
        renderedOperatorHistoryKey=historyKey;
    } catch (e) {
        console.error(e);
    }
}

function appendOperatorMessageToDom(text) {
    const historyContainer = document.getElementById('chatHistory');
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble operator_note';
    const now = formatJalaliDateTime(new Date().toISOString());
    bubble.innerHTML = `<div class="message-role">اپراتور: ${escapeHtml(currentFullName || currentUsername || '')}</div><div>${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="message-time">${now}</div>`;
    historyContainer.appendChild(bubble);
    historyContainer.scrollTop = historyContainer.scrollHeight;
}

function updateOperatorComposer() {
    const disabled = Boolean(currentSessionData && (!currentSessionData.is_active || currentSessionData.is_archived)) || currentUserRole === 'admin' || pendingOperatorTurns.has(currentSessionId);
    document.querySelectorAll('#chatHistory .offer-picker').forEach(picker=>picker.setPending?.(disabled));
}

async function sendOperatorMessage(extra = {}) {
    if (pendingOperatorTurns.has(currentSessionId)) return;
    renderedOperatorHistoryKey = null;
    if (currentUserRole === 'admin') {
        alert('مدیر سیستم (ادمین) دسترسی فقط خواندنی دارد.');
        return;
    }
    const input = document.getElementById('operatorMessageInput');
    const msg = extra.message || input.value.trim();
    if (!msg || !currentSessionId) return;
    const sessionId = currentSessionId;
    pendingOperatorTurns.add(sessionId);
    operatorHistoryRevision++;
    updateOperatorComposer();

    if (!extra.message) input.value = '';
    // اول پیام اپراتور به DOM اضافه می‌شود
    appendOperatorMessageToDom(msg);
    try {
        const res = await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                message: msg,
                is_operator: true
            })
        });
        if (sessionId !== currentSessionId) return;
        if (!res.ok) {
            const err = await res.json();
            if (sessionId === currentSessionId) alert(err.detail || 'خطا در ارسال پیام');
        }
    } catch (e) {
        if (sessionId === currentSessionId) alert('خطا در ارتباط با سرور');
    } finally {
        pendingOperatorTurns.delete(sessionId);
        updateOperatorComposer();
        if (sessionId === currentSessionId) {
            loadMessages(sessionId);
            loadSessions();
        }
    }
}

function handleInputKey(e) {
    if (e.key === 'Enter') sendOperatorMessage();
}

async function markCompleteCurrentSession() {
    if (!currentSessionId) return;
    await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(currentSessionId)}/complete`, { method: 'POST' });
    selectSession(currentSessionId);
}

async function openTransferModal() {
    if (!currentSessionId) return;
    try {
        const res = await apiFetch(`${API}/api/operator/auth/active`);
        const ops = await res.json();
        const select = document.getElementById('transferOperatorSelect');
        select.innerHTML = ops.map(o => `<option value="${escapeHtml(o.username)}">${escapeHtml(o.full_name)} (${escapeHtml(o.username)})</option>`).join('');
        document.getElementById('transferModal').classList.add('show');
    } catch (e) {
        alert('خطا در دریافت لیست اپراتورهای فعال');
    }
}

function closeTransferModal() {
    document.getElementById('transferModal').classList.remove('show');
}

async function submitTransferChat() {
    const target = document.getElementById('transferOperatorSelect').value;
    if (!target || !currentSessionId) return;

    try {
        const res = await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(currentSessionId)}/transfer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_username: target })
        });
        if (res.ok) {
            closeTransferModal();
            selectSession(currentSessionId);
        } else {
            alert('خطا در انتقال چت');
        }
    } catch (e) {
        alert('خطا در ارتباط با سرور');
    }
}

async function toggleCloseCurrentSession() {
    if (!currentSessionId || !currentSessionData) return;
    const endpoint = currentSessionData.is_active ? 'close' : 'reopen';
    await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(currentSessionId)}/${endpoint}`, { method: 'POST' });
    selectSession(currentSessionId);
}

async function toggleArchiveCurrentSession() {
    if (!currentSessionId || !currentSessionData) return;
    const endpoint = currentSessionData.is_archived ? 'unarchive' : 'archive';
    await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(currentSessionId)}/${endpoint}`, { method: 'POST' });
    selectSession(currentSessionId);
}

async function deleteCurrentSession() {
    if (!currentSessionId || !confirm('آیا از حذف این چت اطمینان دارید؟')) return;
    await apiFetch(`${API}/api/operator/chats/${encodeURIComponent(currentSessionId)}?permanent=true`, { method: 'DELETE' });
    currentSessionId = null;
    document.getElementById('activeChatView').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    loadSessions();
}

// Modal
function openNewChatModal() {
    document.getElementById('newChatModal').classList.add('show');
}
function closeNewChatModal() {
    document.getElementById('newChatModal').classList.remove('show');
}

async function submitNewChat() {
    const name = document.getElementById('modalCustomerName').value.trim();
    const phone = document.getElementById('modalCustomerPhone').value.trim();
    const initMsg = document.getElementById('modalInitialMessage').value.trim();

    if (!initMsg) {
        alert('لطفاً پیام اولیه یا مشخصات استعلام سفر را وارد کنید');
        return;
    }

    try {
        const res = await apiFetch(`${API}/api/operator/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_type: currentChatType,
                customer_name: name || null,
                customer_phone: phone || null,
                initial_message: initMsg
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'خطا در ایجاد چت جدید');
        closeNewChatModal();
        loadSessions();
        selectSession(data.session_id);
    } catch (e) {
        alert('خطا در ایجاد چت جدید');
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Auto refresh sessions every 10 seconds
setInterval(() => { if (currentUserToken) loadSessions(); }, 10000);
setInterval(() => { if (currentUserToken && currentSessionId) loadMessages(currentSessionId); }, 4000);
setInterval(() => {
    if (operatorLunchInfo?.lunch_active && Date.parse(operatorLunchInfo.lunch_until) <= Date.now()) {
        renderOperatorLunch({ ...operatorLunchInfo, lunch_active: false, lunch_until: null });
    }
}, 60000);

// Init
checkAuth();
