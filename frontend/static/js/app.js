(function (global, window) {
    'use strict';

    const STATUS = Object.freeze({
        OFFICE: 'office',
        HOME: 'home',
        LEAVE: 'leave',
    });

    const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const MONDAY_FIRST_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
    const SPRING_FESTIVAL_ALIASES = new Set(['除夕', '初一', '初二', '初三', '初四', '初五', '初六', '初七']);
    const SHOW_RULES_STORAGE_KEY = 'attendance.showRules';
    const SEAT_BOOKING_REFRESH_INTERVAL_MS = 30000;

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function currentMonthValue(now) {
        now = new Date(now);
        return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    }

    function isoFromDate(date) {
        date = date || new Date();
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function addDays(isoDate, days) {
        const date = new Date(isoDate);
        date.setDate(date.getDate() + days);
        return isoFromDate(date);
    }

    function isPastIsoDate(isoDate, now) {
        now = new Date(now);
        return isValidIsoDate(isoDate) && isoDate < isoFromDate(now);
    }

    function currentWeekStartIso(now) {
        now = new Date(now);
        const offset = (now.getDay() + 6) % 7;
        return addDays(isoFromDate(now), -offset);
    }

    function isPastDateInCurrentWeek(isoDate, now) {
        now = new Date(now);
        const today = isoFromDate(now);
        const currentWeekStartIso = currentWeekStartIso(now);
        return isValidIsoDate(isoDate) && isoDate >= currentWeekStartIso && isoDate < today;
    }

    function isDirectBookingDate(isoDate, now = new Date()) {
        return isValidIsoDate(isoDate) && isoDate >= addDays(isoFromDate(now), 1) && isoDate <= addDays(isoFromDate(now), 7);
    }

    function currentYearValue(now) {
        now = new Date(now);
        return now.getFullYear();
    }

    function populateYearSelect(select, selectedYear, yearsBefore = 10, yearsAfter = 10) {
        const currentYear = currentYearValue();
        const targetYear = Number(selectedYear) || currentYear;
        const startYear = Math.max(currentYear - yearsBefore, targetYear - yearsBefore);
        const endYear = Math.max(currentYear + yearsAfter, targetYear + yearsAfter);
        select.innerHTML = '';
        for (let year = startYear; year <= endYear; year++) {
            const option = document.createElement('option');
            option.value = String(year);
            option.textContent = `${year} 年`;
            select.appendChild(option);
        }
        select.value = String(targetYear);
    }

    function populateMonthSelect(select, selectedMonth) {
        const targetMonth = Number(selectedMonth) || new Date().getMonth() + 1;
        select.innerHTML = '';
        for (let month = 1; month <= 12; month++) {
            const option = document.createElement('option');
            option.value = pad2(month);
            option.textContent = `${month} 月`;
            select.appendChild(option);
        }
        select.value = pad2(targetMonth);
    }

    function splitMonthYear(monthValue) {
        const [year, month, day] = (String(monthValue) || currentMonthValue()).split('-');
        return {year: Number(year) || currentYearValue(), month: Number(month) || new Date().getMonth() + 1};
    }

    function normalizeHolidayName(rawName, isHoliday) {
        const name = (rawName || '').trim();
        if (!name) return isHoliday ? '假期' : '调休';
        if (isHoliday && SPRING_FESTIVAL_ALIASES.has(name)) return '春节';
        let base = name.replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase();
        base = base.replace(/^labour(?:day)?/, '劳动节').replace(/^national(?:day)?/, '国庆节');
        if (isHoliday) return name.includes('休') ? `${base}休` : base;
        return `${base}补`;
    }

    function isValidIsoDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
        const [year, month, day] = String(value).split('-').map(Number);
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    }

    function parseHolidayInput(input) {
        const matches = (String(input) || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return normalizeHolidayList(matches);
    }

    function normalizeHolidayList(list) {
        return Array.from(new Set(list || [])).filter(isValidIsoDate).sort();
    }

    function normalizeHolidayItems(items) {
        const byDate = new Map();
        (items || []).forEach(item => {
            if (typeof item === 'string' && isValidIsoDate(item)) {
                byDate.set(item, {date: item, name: '假期', isHoliday: true});
            }
            if (item && typeof item === 'object') {
                const date = isValidIsoDate(item.date) ? item.date : '';
                const isHoliday = item.isHoliday !== false;
                if (date) byDate.set(date, {date: item.date, name: normalizeHolidayName(item.name, isHoliday), isHoliday});
            }
        });
        return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    function isWeekend(date) {
        const day = date.getDay();
        return day === 0 || day === 6;
    }

    function buildMonthDays(monthValue, holidays) {
        const {year, month} = splitMonthYear(monthValue);
        const days = [];
        const daysInMonth = new Date(year, month, 0).getDate();

        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month - 1, day);
            const iso = `${year}-${pad2(month)}-${pad2(day)}`;
            const weekend = isWeekend(date);
            const isHolidayOverride = holidays.has(iso);
            const isHoliday = isHolidayOverride || weekend;
            const name = holidays.get(iso) || (weekend ? '周末' : '');
            days.push({
                day,
                weekday: date.getDay(),
                weekdayName: WEEKDAY_NAMES[date.getDay()],
                isWeekend: weekend,
                isHoliday,
                holidayName: name,
                reason: isHolidayOverride ? '节假日' : (weekend ? '周末' : ''),
                iso,
            });
        }
        return days;
    }

    function mapTimerHolidayResponse(year, payload) {
        if (!payload || typeof payload.holiday !== 'object') return [];
        return normalizeHolidayItems(Object.entries(payload.holiday)
            .filter(([_, item]) => item && typeof item.holiday === 'boolean')
            .map(([date, item]) => ({
                date,
                name: normalizeHolidayName(item.name, item.holiday),
                isHoliday: item.holiday,
            })));
    }

    function mapNagerHolidayResponse(payload) {
        if (!Array.isArray(payload)) return [];
        return normalizeHolidayItems(payload.map(item => ({
            date: item.date,
            name: normalizeHolidayName(item.name, true),
        })));
    }

    async function fetchHolidays(year, fetcher) {
        const fallbackFetcher = (typeof global.fetch === 'function' || typeof window.fetch === 'function')
            ? (global.fetch || window.fetch) : null;
        if (!fetcher && !fallbackFetcher) throw new Error('当前浏览器不支持 fetch，无法自动获取节假日。');

        try {
            const timerResponse = await fetcher(`https://timer.tech/api/holiday/year/${year}`);
            if (timerResponse && timerResponse.ok) {
                const holidays = await timerResponse.json();
                if (holidays.length) return {holidays, source: 'timer.tech 中国节假日接口'};
            }
        } catch (error) {
            // 接口A失败时尝试备用接口
        }

        try {
            const nagerResponse = await fetcher(`https://date.nager.at/api/v3/PublicHolidays/${year}/CN`);
            if (nagerResponse && nagerResponse.ok) {
                const holidays = await nagerResponse.json();
                if (holidays.length) return {holidays, source: 'Nager.Date Public Holidays API'};
            }
        } catch (error) {
            // 两个接口都失败时，声明不能自动获取
        }
        throw new Error('当前接口无法获取可用数据。');
    }

    async function apiFetch(url, options) {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        });
        if (response.status === 401 && document.body.dataset.page === 'login') {
            window.location.href = '/login.html';
            throw new Error('未授权');
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    }

    const PAGE_PATHS = {
        'attendance': '/index.html',
        'holidays': '/holidays.html',
        'seat-booking': '/seat-booking.html',
        'api-docs': '/api-docs.html',
        'admin': '/admin.html',
    };

    function pageIdFromHref(href) {
        if (!href) return null;
        if (href.endsWith('/index.html') || href === '/' || href === '') return 'attendance';
        if (href.endsWith('/holidays.html')) return 'holidays';
        if (href.endsWith('/seat-booking.html')) return 'seat-booking';
        if (href.endsWith('/api-docs.html')) return 'api-docs';
        if (href.endsWith('/admin.html')) return 'admin';
        return null;
    }

    async function requireUser() {
        const data = await apiFetch('/api/admin/me');
        const badge = document.getElementById('userBadge');
        if (badge) badge.textContent = data.user.username;
        const allowedPages = new Set(data.user.accessiblePages || []);
        document.querySelectorAll('#nav .nav-link').forEach(link => {
            const pageId = pageIdFromHref(link.getAttribute('href'));
            if (pageId) link.classList.toggle('hidden', !allowedPages.has(pageId));
        });
        const currentPage = document.body.dataset.page;
        if (currentPage && currentPage !== 'login' && !allowedPages.has(currentPage)) {
            const fallback = [...data.user.accessiblePages || []].find(p => PAGE_PATHS[p]);
            window.location.href = fallback || PAGE_PATHS['attendance'] || '/login.html';
            throw new Error('当前用户无权访问此页面');
        }
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                await apiFetch('/api/admin/logout', {method: 'POST', body: JSON.stringify({})});
                window.location.href = '/login.html';
            });
        }
        return data.user;
    }

    let sharedConfirmResolve = null;
    let sharedConfirmTrigger = null;

    function ensureConfirmDialog() {
        const trigger = document.getElementById('confirmDialog');
        if (trigger) return trigger;
        const dialog = document.createElement('div');
        dialog.id = 'confirmDialog';
        dialog.className = 'confirm-overlay hidden';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'confirmDialogTitle');
        dialog.setAttribute('aria-describedby', 'confirmDialogMessage');
        dialog.innerHTML = `
            <div class="confirm-modal">
                <div class="confirm-modal-header">
                    <h2 id="confirmDialogTitle" class="confirm-modal-title">确认操作</h2>
                    <button id="confirmDialogClose" class="confirm-modal-close" type="button" aria-label="关闭确认对话框">×</button>
                </div>
                <div id="confirmDialogMessage" class="confirm-modal-message"></div>
                <div class="confirm-modal-actions">
                    <button id="confirmDialogCancel" type="button" class="confirm-btn btn-secondary">取消</button>
                    <button id="confirmDialogConfirm" class="confirm-btn btn-danger" type="button">确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        dialog.querySelector('#confirmDialogClose').addEventListener('click', () => closeSharedConfirmDialog(false));
        dialog.querySelector('#confirmDialogCancel').addEventListener('click', () => closeSharedConfirmDialog(false));
        dialog.querySelector('#confirmDialogConfirm').addEventListener('click', () => closeSharedConfirmDialog(true));
        return dialog;
    }

    function closeSharedConfirmDialog(confirmed) {
        const dialog = document.getElementById('confirmDialog');
        if (!dialog) return;
        const resolve = sharedConfirmResolve;
        const trigger = sharedConfirmTrigger;
        sharedConfirmResolve = null;
        sharedConfirmTrigger = null;
        dialog.classList.add('hidden');
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
        resolve(Boolean(confirmed));
    }

    function confirmation(message, options = {}) {
        const dialog = ensureConfirmDialog();
        const title = dialog.querySelector('#confirmDialogTitle');
        const messageNode = dialog.querySelector('#confirmDialogMessage');
        const confirmButton = dialog.querySelector('#confirmDialogConfirm');
        if (sharedConfirmResolve) closeSharedConfirmDialog(false);
        title.textContent = options.title || '确认操作';
        messageNode.textContent = message;
        confirmButton.textContent = options.confirmText || '确认';
        confirmButton.classList.toggle('btn-danger', !options.danger);
        confirmButton.classList.toggle('btn-primary', options.danger);
        sharedConfirmTrigger = document.activeElement;
        dialog.classList.remove('hidden');
        confirmButton.focus();
        return new Promise((resolve) => {
            sharedConfirmResolve = resolve;
        });
    }

    function createLoginApp() {
        const form = document.getElementById('authForm');
        const usernameInput = document.getElementById('usernameInput');
        const passwordInput = document.getElementById('passwordInput');
        const message = document.getElementById('authMessage');
        let action = 'login';

        document.querySelectorAll('[data-auth]').forEach(btn => {
            btn.addEventListener('click', () => {
                action = btn.dataset.auth;
            });
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            message.textContent = action === 'register' ? '正在注册...' : '正在登录...';
            try {
                const resp = await apiFetch('/api/auth', {
                    method: 'POST',
                    body: JSON.stringify({
                        username: usernameInput.value.trim(),
                        password: passwordInput.value
                    }),
                });
                window.location.href = '/index.html';
            } catch (error) {
                message.textContent = error.message;
            }
        });
    }

    function createAdminApp() {
        const userAccessList = document.getElementById('userAccessList');
        const cleanupScheduleToggle = document.getElementById('cleanupScheduleToggle');
        const cleanupScheduleText = document.getElementById('cleanupScheduleText');
        const attendanceRetentionInput = document.getElementById('attendanceRetentionInput');
        const overdueRetentionInput = document.getElementById('overdueRetentionInput');
        const planRetentionInput = document.getElementById('planRetentionInput');
        const runRetentionInput = document.getElementById('runRetentionInput');
        const cleanupForm = document.getElementById('cleanupForm');
        const previousCleanupBtn = document.getElementById('previousCleanupBtn');
        const runCleanupBtn = document.getElementById('runCleanupBtn');
        const cleanupScheduleStatus = document.getElementById('cleanupScheduleStatus');
        const cleanupScheduleDetail = document.getElementById('cleanupScheduleDetail');
        const cleanupPlanBtn = document.getElementById('cleanupPlanBtn');
        const cleanupLastMessage = document.getElementById('cleanupLastMessage');
        const cleanupResultTotal = document.getElementById('cleanupResultTotal');
        const cleanupResultDetail = document.getElementById('cleanupResultDetail');
        let availablePages = [];
        let currentAdminId = null;

        function escapeHtml(value) {
            return String(value).replace(/[&<>"]/g, (ch) => {
                const map = {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                };
                return map[ch];
            });
        }

        function payloadFromUi() {
            return {
                scheduledEnabled: cleanupScheduleToggle.checked,
                attendanceRetentionMonths: Number(attendanceRetentionInput.value),
                overdueRetentionMonths: Number(overdueRetentionInput.value),
                seatBookingPlanRetentionMonths: Number(planRetentionInput.value),
                seatBookingRunRetentionMonths: Number(runRetentionInput.value),
            };
        }

        function renderSettings(settings, schedule) {
            cleanupScheduleToggle.checked = Boolean(settings.scheduledEnabled);
            cleanupScheduleText.textContent = settings.scheduledEnabled ? '定时清理开启' : '定时清理关闭';
            attendanceRetentionInput.value = settings.attendanceRetentionMonths;
            overdueRetentionInput.value = settings.overdueRetentionMonths;
            planRetentionInput.value = settings.seatBookingPlanRetentionMonths;
            runRetentionInput.value = settings.seatBookingRunRetentionMonths;
            cleanupForm.dataset.lastRun = schedule?.date || '';
            cleanupLastMessage.textContent = settings.lastMessage || '尚未执行自动清理。';
            if (schedule) {
                cleanupScheduleStatus.textContent = schedule.scheduled ? '调度程序已启动' : '调度未启动';
                cleanupScheduleDetail.textContent = schedule.scheduled ? `等待下一次检查` : `等待管理员开启。`;
            }
        }

        function renderCleanupResult(result) {
            cleanupResultTotal.textContent = `清理完成，共清理 ${result.totalDeleted || 0} 条`;
            cleanupResultDetail.innerHTML = '';
            const entries = result.overrides || {};
            cleanupPlanBtn.textContent = [
                `考勤记录保留 ${entries.attendance || '--'} 月`,
                `逾期记录保留 ${entries.overdue || '--'} 月`,
                `预约方案保留 ${entries.seatBookingPlan || '--'} 月`,
                `预约运行保留 ${entries.seatBookingRun || '--'} 月`,
            ].join(' | ');
            if (result.settings) renderSettings(result.settings, result.schedule);
        }

        function renderUsers(users) {
            let availablePages = pages || [];

            userAccessList.innerHTML = '';
            users.forEach(user => {
                const card = document.createElement('div');
                card.className = 'admin-user-card';
                if (!user.isActive) card.classList.add('inactive');
                card.dataset.userId = String(user.id);

                const pageCheckboxes = availablePages.map(page => {
                    const checked = (user.accessiblePages || []).includes(page.id);
                    const disabled = page.adminOnly && user.role === 'admin' ? ' disabled' : '';
                    return `<label><input type="checkbox" value="${escapeHtml(page.id)}" ${checked} ${disabled}/> ${escapeHtml(page.label)}</label>`;
                }).join('');

                card.innerHTML = `
                    <div>
                        <div class="user-header">
                            <span class="user-username">${escapeHtml(user.username)}</span>
                            <span class="user-status-badge ${user.isActive ? 'active' : 'inactive'}">${user.isActive ? '启用' : '停用'}</span>
                            <span class="user-created-date">创建于 ${escapeHtml(user.createdAt) || ''}</span>
                        </div>
                        <div class="user-details">
                            <div class="user-info">ID: ${escapeHtml(user.id)}</div>
                        </div>
                        <div class="user-actions">
                            <label class="field">
                                <span class="label">身份</span>
                                <select data-role>
                                    <option value="user" ${user.role === 'user' ? 'selected' : ''}>普通用户</option>
                                    <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option>
                                </select>
                            </label>
                            <div class="admin-page-checks" aria-label="${escapeHtml(user.username)} 的可访问页面">
                                ${pageCheckboxes}
                            </div>
                            <div class="admin-user-actions">
                                <button type="button" data-action="toggle-user" class="btn btn-primary">${user.isActive ? '停用' : '启用'}</button>
                                <button type="button" data-action="delete-user" class="btn btn-danger">删除用户</button>
                            </div>
                        </div>
                    </div>
                `;

                const roleSelect = card.querySelector('[data-role]');
                const toggleButton = card.querySelector('[data-action="toggle-user"]');
                const deleteButton = card.querySelector('[data-action="delete-user"]');

                if (user.id === currentAdminId) {
                    roleSelect.title = '不能修改自己的管理员身份';
                    toggleButton.disabled = true;
                    deleteButton.disabled = true;
                }

                roleSelect.addEventListener('change', () => {
                    const isAdmin = roleSelect.value === 'admin';
                    card.querySelectorAll('.admin-page-checks input[type="checkbox"]').forEach(input => {
                        const page = availablePages.find(p => p.id === input.value);
                        if (page && page.adminOnly) {
                            input.checked = isAdmin;
                            input.disabled = !isAdmin;
                        } else {
                            input.checked = isAdmin ? true : input.checked;
                        }
                    });
                });

                toggleButton.addEventListener('click', async () => {
                    toggleButton.disabled = true;
                    const nextAction = toggleButton.textContent.trim() === '启用' ? 'activate' : 'deactivate';
                    const confirmText = nextAction === 'activate' ? '启用' : '停用';
                    const confirmed = await confirmation(`是否 ${confirmText} 用户 ${user.username}？`, {
                        title: `${confirmText}用户`,
                        confirmText: `确认${confirmText}`,
                        danger: true,
                    });
                    if (!confirmed) return;
                    toggleButton.disabled = true;
                    const statusText = nextAction === 'activate' ? '启用' : '停用';
                    try {
                        const result = await apiFetch(`/api/admin/users/${user.id}/status`, {
                            method: 'PATCH',
                            body: JSON.stringify({isActive: nextAction === 'activate'}),
                        });
                        const usersData = await apiFetch('/api/admin/users');
                        renderUsers(usersData);
                        userDataMessage.textContent = `${user.username} 已${statusText}`;
                    } catch (error) {
                        userDataMessage.textContent = `${statusText}失败: ${error.message}`;
                    } finally {
                        toggleButton.disabled = false;
                    }
                });

                deleteButton.addEventListener('click', async () => {
                    const confirmed = await confirmation(`确定要删除用户 ${user.username} 吗？\n\n删除用户为不可逆操作，其关联的考勤、预约、日志等数据也将被清理。`, {
                        title: '删除用户确认',
                        confirmText: '确认删除',
                        danger: true,
                    });
                    if (!confirmed) return;
                    deleteButton.disabled = true;
                    userDataMessage.textContent = `正在删除 ${user.username}`;
                    try {
                        await apiFetch(`/api/admin/users/${user.id}`, {method: 'DELETE'});
                        const usersData = await apiFetch('/api/admin/users');
                        renderUsers(usersData);
                        userDataMessage.textContent = `${user.username} 已删除。`;
                    } catch (error) {
                        userDataMessage.textContent = `删除失败: ${error.message}`;
                    } finally {
                        deleteButton.disabled = false;
                    }
                });
                userAccessList.appendChild(card);
            });
            if (!users.length) userAccessList.textContent = '暂无用户';
        }

        async function init() {
            const user = await requireUser();
            currentAdminId = user.id;
            if (user.id !== 'admin') {
                document.getElementById('adminOnly').hidden = false;
                document.getElementById('adminOnly').textContent = '只有管理员可以访问后台管理。';
                window.location.href = '/index.html';
                return;
            }
            const settingsData = await apiFetch('/api/admin/settings');
            const scheduleData = await apiFetch('/api/admin/schedule');
            renderSettings(settingsData, scheduleData);
            const usersData = await apiFetch('/api/admin/users');
            renderUsers(usersData);
        }

        init();

        cleanupScheduleToggle.addEventListener('change', () => {
            cleanupScheduleText.textContent = cleanupScheduleToggle.checked ? '定时清理开启' : '定时清理关闭';
        });
        cleanupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            cleanupScheduleDetail.textContent = '正在保存清理设置...';
            try {
                const data = await apiFetch('/api/admin/settings', {method: 'PUT', body: JSON.stringify(payloadFromUi())});
                renderSettings(data.settings, data.schedule);
                cleanupScheduleDetail.textContent = '清理设置已保存。';
            } catch (error) {
                cleanupScheduleDetail.textContent = `保存失败：${error.message}`;
            }
        });

        previousCleanupBtn.addEventListener('click', async () => {
            cleanupResultTotal.textContent = '正在获取...';
            try {
                const result = await apiFetch('/api/admin/cleanup/run', {method: 'POST', body: JSON.stringify({dryRun: true})});
                renderCleanupResult(result);
            } catch (error) {
                cleanupResultTotal.textContent = `获取失败：${error.message}`;
            }
        });

        runCleanupBtn.addEventListener('click', async () => {
            const confirmed = await confirmation('当前清理将执行全部过期数据清理，并清除已过期 5 年以上的数据，清理后无法恢复。是否继续？', {
                title: '清理运行确认',
                confirmText: '确认清理',
                danger: true,
            });
            if (!confirmed) return;
            cleanupResultTotal.textContent = '正在清理...';
            try {
                const result = await apiFetch('/api/admin/cleanup/run', {method: 'POST', body: JSON.stringify({dryRun: false, vacuum: true})});
                renderCleanupResult(result);
            } catch (error) {
                cleanupResultTotal.textContent = `清理失败：${error.message}`;
            }
        });


// ========== createAttendanceApp 函数续（包含批量操作和日期计算） ==========
        function createAttendanceApp() {
            const attendanceYearSelect = document.getElementById('attendanceYearSelect');
            const attendanceMonthSelect = document.getElementById('attendanceMonthSelect');
            const calendarGrid = document.getElementById('calendarGrid');
            const templateContent = document.getElementById('dayCardTemplate');
            const resultText = document.getElementById('resultText');
            const requireOfficeDays = document.getElementById('requireOfficeDays');
            const homeDays = document.getElementById('homeDays');
            const leaveDays = document.getElementById('leaveDays');
            const unselectedDays = document.getElementById('unselectedDays');
            const attendanceRate = document.getElementById('attendanceRate');
            const attendanceRateToToday = document.getElementById('attendanceRateToToday');
            const remainingDays = document.getElementById('remainingDays');
            const remainingDaysToToday = document.getElementById('remainingDaysToToday');
            const officeDays = document.getElementById('officeDays');
            const officeDaysToToday = document.getElementById('officeDaysToToday');
            const resultDate = document.getElementById('resultDate');
            const calendarLegend = document.getElementById('calendarLegend');
            const saveChangesBtn = document.getElementById('saveChangesBtn');
            const holidaySummary = document.getElementById('holidaySummary');
            const smartScheduleBtn = document.getElementById('smartScheduleBtn');
            const smartStrategySelect = document.getElementById('smartStrategySelect');
            const smartStrategyText = document.getElementById('smartStrategyText');
            const showRulesToggle = document.getElementById('showRulesToggle');
            const rulesPanel = document.getElementById('rulesPanel');
            const attendanceWorkspace = document.getElementById('attendanceWorkspace');
            const confirmDialog = document.getElementById('confirmDialog');
            const dialogMessage = document.getElementById('confirmDialogMessage');
            const closeConfirmDialogBtn = document.getElementById('confirmDialogCancel');
            const confirmDialogBtn = document.getElementById('confirmDialogConfirm');
            const saveBtn = document.getElementById('saveBtn');
            const cancelBtn = document.getElementById('cancelBtn');
            const editBtn = document.getElementById('editBtn');
            const userAccessList = document.getElementById('userAccessList');

            const state = {
                month: currentMonthValue(),
                targetRate: 40,
                selections: {},
                summary: null,
                dayOverrides: [],
                holidayCountForYear: 0,
                workdayCountForYear: 0,
                smartSchedule: null,
                seatBookings: {}
            };

            function selectedMonthValue() {
                return `${attendanceYearSelect.value}-${attendanceMonthSelect.value}`;
            }

            function setSelectedMonth(monthValue) {
                const {year, month} = splitMonthYear(monthValue);
                populateYearSelect(attendanceYearSelect, year);
                populateMonthSelect(attendanceMonthSelect, month);
            }

            function readShowRulesPreference() {
                try {
                    return localStorage.getItem(SHOW_RULES_STORAGE_KEY) === 'true';
                } catch (error) {
                    return false;
                }
            }

            function applyRulesVisibility(visible) {
                showRulesToggle.checked = visible;
                showRulesToggle.setAttribute('aria-checked', String(visible));
                rulesPanel.textContent = visible ? '已开启' : '已关闭';
                rulesPanel.classList.toggle('hidden', !visible);
                attendanceWorkspace.classList.toggle('hidden', !visible);
            }

            function closeConfirmDialog(confirmed) {
                closeSharedConfirmDialog(confirmed);
            }

            function confirmAction(message, options = {}) {
                return confirmation(message, options);
            }

            function includePastDates() {
                return Boolean(window.includePastToggle && window.includePastToggle.checked);
            }

            function scheduleIsExpired() {
                // 如果当前日期早于状态中的调度日期，则已过期。
                return isoFromDate() < state.smartSchedule?.startDate;
            }

            function updateSmartStrategySelect() {
                if (!smartStrategySelect) return;
                const option = smartStrategySelect.options[smartStrategySelect.selectedIndex];
                return option ? option.textContent : smartStrategySelect.value;
            }

            function updateSmartStrategyText() {
                if (!smartStrategyText) return;
                const recommendation = state.smartSchedule && typeof state.smartSchedule.recommendation === 'string'
                    ? state.smartSchedule.recommendation : '';
                if (smartStrategySelect && smartStrategySelect.value === 'recommended') {
                    smartStrategyText.textContent = `推荐策略：${recommendation || '无'}`;
                } else {
                    const strategyName = smartStrategySelect?.value || '未知';
                    smartStrategyText.textContent = `用户策略：${strategyName}`;
                }
            }

            async function loadMonth() {
                holidaySummary.textContent = '正在加载考勤日历...';
                const monthValue = selectedMonthValue();
                const data = await apiFetch(`/api/attendance?month=${encodeURIComponent(monthValue)}`);
                state.month = data.month;
                state.targetRate = data.settings.targetRate;
                state.selections = data.selections || {};
                state.summary = data.summary || null;
                state.dayOverrides = data.dayOverrides || data.holidays || [];
                state.holidayCountForYear = data.holidayCountForYear || 0;
                state.workdayCountForYear = data.workdayCountForYear || 0;
                state.smartSchedule = data.smartSchedule || null;
                state.seatBookings = data.seatBookings || {};
                render();
            }

            function render() {
                const monthValue = selectedMonthValue();
                const days = buildMonthDays(monthValue, state.dayOverrides);
                const monthStartWeekday = days.length > 0 ? new Date(`${days[0].iso}T00:00:00`).getDay() : 0;
                const leadingBlanks = days.length > 0 ? days[0].day % 7 : 0;

                calendarGrid.innerHTML = '';
                for (let i = 0; i < leadingBlanks; i++) {
                    const blank = document.createElement('div');
                    blank.className = 'day-card empty';
                    calendarGrid.appendChild(blank);
                }

                days.forEach((day, index) => {
                    const node = templateContent.firstElementChild.cloneNode(true);
                    const status = state.selections[day.iso];
                    node.dataset.date = day.iso;

                    node.style.animationDelay = `${Math.min(index * 12, 240)}ms`;
                    node.querySelector('.day-number').textContent = day.day;
                    node.querySelector('.weekday-label').textContent = day.weekdayName;
                    node.querySelector('.day-reason').textContent = day.reason || day.iso;

                    const seat = state.seatBookings[day.iso];
                    const seatNode = node.querySelector('.seat-day');
                    if (seat) {
                        seatNode.textContent = seat.seatName || seat.seatId;
                        seatNode.classList.remove('hidden');
                    }

                    if (!day.selectable) {
                        node.classList.add('locked');
                        node.querySelector('.day-reason').textContent = `${day.iso} - ${day.reason}`;
                        node.querySelectorAll('button').forEach(button => {
                            button.disabled = true;
                            button.setAttribute('aria-disabled', 'true');
                        });
                    } else if (status) {
                        node.classList.add('active');
                    }

                    node.querySelectorAll('button').forEach(button => {
                        const buttonStatus = button.dataset.status;
                        button.setAttribute('aria-pressed', status === buttonStatus);
                        if (status === buttonStatus) button.classList.add('active');
                        button.addEventListener('click', async () => {
                            const nextStatus = status === buttonStatus ? null : buttonStatus;
                            const result = await apiFetch('/api/attendance', {
                                method: 'PUT',
                                body: JSON.stringify({date: day.iso, status: nextStatus})
                            });
                            loadMonth();
                        });
                    });
                    calendarGrid.appendChild(node);
                });

                // 统计数据渲染
                const resultData = state.summary || {};
                const isFinished = resultData.passed && state.selections && state.selections.length > 0 && state.selections.length === state.summary?.denominator;
                const statusText = isFinished ? '已完成' : '未完成';
                const statusData = resultData.status;
                const officeDaysDate = resultData.requiredOfficeDays || 0;
                const remainingDaysText = resultData.remainingDays || 0;
                const attendanceRateText = resultData.attendanceRate || 0;
                const attendanceRateToTodayText = resultData.attendanceRateToToday || 0;
                const remainingDaysToTodayText = resultData.remainingDaysToToday || 0;

                resultText.textContent = isFinished ? `已统计` : `统计中`;
                requireOfficeDays.textContent = resultData.requireOfficeDays || 0;
                homeDays.textContent = resultData.homeDays || 0;
                leaveDays.textContent = resultData.leaveDays || 0;
                unselectedDays.textContent = resultData.unselectedDays || 0;
                attendanceRate.textContent = `${attendanceRateText}%`;
                remainingDays.textContent = remainingDaysText;
                officeDays.textContent = officeDaysDate;
                officeDaysToToday.textContent = officeDaysDate;
                attendanceRateToToday.textContent = `${attendanceRateToTodayText}%`;
                remainingDaysToToday.textContent = remainingDaysToTodayText;
                resultDate.textContent = `基准：${state.month}`;

                const targetRate = state.targetRate;
                const requireOffice = resultData.requireOfficeDays || 0;
                const rateToToday = resultData.attendanceRateToToday || 0;
                const percent = Math.round(rateToToday);

                // 事件监听：显示规则
                showRulesToggle.addEventListener('change', () => {
                    const visible = showRulesToggle.checked;
                    applyRulesVisibility(visible);
                    try {
                        localStorage.setItem(SHOW_RULES_STORAGE_KEY, String(visible));
                    } catch (error) {
                        // ignore
                    }
                });

                // 智能排班执行
                smartScheduleBtn.addEventListener('click', async () => {
                    const strategy = smartStrategySelect.value;
                    if (!(await confirmation('确定要清空当前考勤设置吗？', {title: '清空确认', confirmText: '确认清空', danger: 'primary'}))) return;
                    smartScheduleBtn.disabled = true;
                    holidaySummary.textContent = '正在分配办公室考勤规则...';
                    try {
                        const data = await apiFetch('/api/attendance/smart-schedule', {
                            method: 'POST',
                            body: JSON.stringify({month: selectedMonthValue(), strategy, includePast: includePastDates()}),
                        });
                        await loadMonth();
                        const recommendation = data.recommendation || [];
                        const recText = recommendation[0] || '';
                        const smartRecText = `推荐指数：${recText || '当前暂无推荐'}`;
                        holidaySummary.textContent = `智能计划完成，${data.strategy === 'recommended' ? `推荐指数 ${data.recommendation} ` : '依据所选策略，'} 已分配 ${state.workdayCountForYear} 个工作日的${targetRate}% 的总目标到${state.targetRate}% 。`;
                    } finally {
                        smartScheduleBtn.disabled = false;
                    }
                });

                // 批量设置
                document.querySelectorAll('[data-bulk]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const action = btn.dataset.bulk;
                        if (action === 'clear') {
                            const confirmTitle = '清除所有选择';
                            const confirmMsg = `您确定要清除 ${selectedMonthValue()} 月份的所有状态吗？这将移除所有选择。`;
                            const confirmText = '确认清除';
                            if (!(await confirmation(confirmMsg, {title: confirmTitle, confirmText: confirmText, danger: true}))) return;
                            await apiFetch('/api/attendance/bulk', {
                                method: 'POST',
                                body: JSON.stringify({month: selectedMonthValue(), status: action === 'clear' ? null : action, includePast: includePastDates()})
                            });
                            await loadMonth();
                        }
                    });
                });

                smartStrategySelect.addEventListener('change', updateSmartStrategyText);
                const includePastToggle = document.getElementById('includePastToggle');
                includePastToggle?.addEventListener('change', updateSmartStrategyText);

                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !confirmDialog.classList.contains('hidden')) {
                        closeConfirmDialog(false);
                    }
                });

                init().catch(error => {
                    holidaySummary.textContent = error.message;
                });

                function initGuideDialog() {
                    const guideFab = document.getElementById('guideFab');
                    const guidePanel = document.getElementById('guidePanel');
                    const closeGuideBtn = document.getElementById('closeGuideBtn');
                    if (!guideFab || !guidePanel || !closeGuideBtn) return;

                    function setGuideOpen(open) {
                        // 设置界面设置进行引导可见性，并将开关设置为扩展。
                        guidePanel.classList.toggle('hidden', !open);
                        guideFab.setAttribute('aria-expanded', String(open));
                        if (open) closeGuideBtn.focus();
                    }

                    guideFab.addEventListener('click', () => setGuideOpen(guidePanel.classList.contains('hidden')));
                    closeGuideBtn.addEventListener('click', () => setGuideOpen(false));
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape' && !guidePanel.classList.contains('hidden')) setGuideOpen(false);
                    });
                }
            }
        }

// ========== createHolidayApp 函数（完整的节假日管理功能） ==========
        function createHolidayApp() {
            const yearInput = document.getElementById('yearInput');
            const holidayStatus = document.getElementById('holidayStatus');
            const holidayCount = document.getElementById('holidayCount');
            const workdayCount = document.getElementById('workdayCount');
            const holidayMeta = document.getElementById('holidayMeta');
            const fetchHolidayBtn = document.getElementById('fetchHolidayBtn');
            const sourceUserSelect = document.getElementById('sourceUserSelect');
            const copyHolidayBtn = document.getElementById('copyHolidayBtn');
            const holidayCalendar = document.getElementById('holidayCalendar');
            const dayTypeSelect = document.getElementById('dayTypeSelect');
            const dayNameInput = document.getElementById('dayNameInput');
            const saveDayBtn = document.getElementById('saveDayBtn');
            const state = {year: currentYearValue(), calendar: [], holidays: [], selected: null};
            const selectedDateLabel = document.getElementById('selectedDateLabel');
            const selectedDayType = document.getElementById('selectedDayType');
            const dayTypeInput = document.getElementById('dayTypeInput');
            const saveHolidayBtn = document.getElementById('saveHolidayBtn');

            async function loadSourceUsers() {
                const data = await apiFetch(`/api/holiday/source-users?year=${state.year}`);
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = '请选择用户';
                sourceUserSelect.appendChild(placeholder);
                data.users.forEach(user => {
                    const option = document.createElement('option');
                    option.value = String(user.id);
                    option.textContent = `${user.username} (${user.overdueCount} 条延期)`;
                    sourceUserSelect.appendChild(option);
                });
                copyHolidayBtn.disabled = data.users.length === 0;
            }

            function renderHolidayCalendar() {
                holidayCalendar.innerHTML = '';
                state.calendar.forEach(month => {
                    const section = document.createElement('section');
                    section.className = 'month';
                    const header = document.createElement('header');
                    header.textContent = month.label;
                    section.appendChild(header);
                    const grid = document.createElement('div');
                    grid.className = 'month-grid';
                    MONDAY_FIRST_LABELS.forEach(label => {
                        const cell = document.createElement('span');
                        cell.className = 'month-weekday';
                        cell.textContent = label;
                        grid.appendChild(cell);
                    });
                    const leading = month.days.length > month.days[0].weekday - 1 ? 0 : 0;
                    for (let i = 0; i < leading; i++) {
                        const blank = document.createElement('span');
                        blank.className = 'month-day blank';
                        grid.appendChild(blank);
                    }
                    month.days.forEach(day => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'month-day';
                        if (day.isWeekend) button.classList.add('weekend');
                        if (day.isHoliday) button.classList.add('holiday');
                        if (day.isWorkdayOverride) button.classList.add('workday-override');
                        if (state.selected?.date === day.date) button.classList.add('selected');
                        const dayNumber = document.createElement('strong');
                        dayNumber.textContent = day.day;
                        button.appendChild(dayNumber);
                        if (day.name) {
                            const dayName = document.createElement('small');
                            dayName.textContent = day.name;
                            dayName.title = day.name;
                            button.appendChild(dayName);
                        }
                        button.addEventListener('click', () => selectDay(day));
                        grid.appendChild(button);
                    });
                    section.appendChild(grid);
                    holidayCalendar.appendChild(section);
                });
            }

            function selectDay(day) {
                state.selected = Object.assign({}, day);
                selectedDateLabel.textContent = `${day.date} - ${day.isWeekend ? '周末' : '工作日'}`;
                dayTypeSelect.value = day.type || (day.isHoliday ? 'holiday' : (day.isWorkdayOverride ? 'workday' : 'normal'));
                dayNameInput.value = day.name || '';
                renderHolidayCalendar();
            }

            async function init() {
                await requireUser();
                populateYearSelect(yearInput, currentYearValue());
                await loadYear();
            }

            async function loadYear() {
                state.year = Number(yearInput.value) || currentYearValue();
                holidayStatus.textContent = `正在加载 ${state.year} 年节假日...`;
                const data = await apiFetch(`/api/holidays?year=${state.year}`);
                state.calendar = data.calendar || [];
                state.holidays = data.holidays || [];
                state.workdays = data.workdays || [];
                holidayCount.textContent = state.holidays.length;
                workdayCount.textContent = state.workdays.length;
                holidayMeta.textContent = `数据来源: ${data.meta?.source || ''} - ${new Date(data.meta?.updatedAt).toLocaleString('zh-CN', {hour12: false})}`;
                holidayStatus.textContent = `加载完成，共 ${state.holidays.length} 条节日数据。`;
                renderHolidayCalendar();
                await loadSourceUsers();
            }

            yearInput.addEventListener('change', loadYear);
            fetchHolidayBtn.addEventListener('click', async () => {
                fetchHolidayBtn.disabled = true;
                holidayStatus.textContent = '正在从国家节假日接口同步...';
                try {
                    const data = await apiFetch('/api/holidays/sync', {method: 'POST', body: JSON.stringify({year: Number(yearInput.value)})});
                    state.calendar = data.calendar || [];
                    state.holidays = data.holidays || [];
                    state.workdays = data.workdays || [];
                    holidayCount.textContent = state.holidays.length;
                    workdayCount.textContent = state.workdays.length;
                    holidayMeta.textContent = `数据来源: ${data.meta?.source || ''} - ${new Date(data.meta?.updatedAt).toLocaleString('zh-CN', {hour12: false})}`;
                    holidayStatus.textContent = `已同步 ${state.holidays.length} 条节假日数据。`;
                    renderHolidayCalendar();
                    await loadSourceUsers();
                } finally {
                    fetchHolidayBtn.disabled = false;
                }
            });

            copyHolidayBtn.addEventListener('click', async () => {
                if (!sourceUserSelect.value) {
                    holidayStatus.textContent = '请先选择一个用户。';
                    return;
                }
                copyHolidayBtn.disabled = true;
                holidayStatus.textContent = '正在同步所选用户的节假日配置...';
                try {
                    const data = await apiFetch('/api/holidays/copy', {
                        method: 'POST',
                        body: JSON.stringify({year: Number(yearInput.value), sourceUserId: Number(sourceUserSelect.value)}),
                    });
                    state.calendar = data.calendar || [];
                    state.holidays = data.holidays || [];
                    state.workdays = data.workdays || [];
                    holidayCount.textContent = state.holidays.length;
                    workdayCount.textContent = state.workdays.length;
                    holidayMeta.textContent = `数据来源: ${data.meta?.source || ''} - ${new Date(data.meta?.updatedAt).toLocaleString('zh-CN', {hour12: false})}`;
                    holidayStatus.textContent = `已同步用户配置，共 ${data.copied} 条。`;
                    renderHolidayCalendar();
                } finally {
                    copyHolidayBtn.disabled = sourceUserSelect.options.length <= 1;
                }
            });

            saveDayBtn.addEventListener('click', async () => {
                if (!state.selected) {
                    holidayStatus.textContent = '请先选择一个日期。';
                    return;
                }
                await apiFetch('/api/holidays', {
                    method: 'PUT',
                    body: JSON.stringify({
                        date: state.selected.date,
                        dayType: dayTypeSelect.value,
                        name: dayNameInput.value.trim(),
                    })
                });
                holidayStatus.textContent = `${state.selected.date} 已保存。`;
                await loadYear();
            });

            init().catch(error => {
                holidayStatus.textContent = error.message;
            });
        }

        // ===========================
// API 文档面板 (从图1、图2提取)
// ===========================
        function createApiDocsApp() {
            const endpointList = document.getElementById('endpointList');
            const endpointStatus = document.getElementById('endpointStatus');
            const methodSelect = document.getElementById('methodSelect');
            const pathInput = document.getElementById('pathInput');
            const bodyInput = document.getElementById('bodyInput');
            const output = document.getElementById('output');
            const sendButton = document.getElementById('sendButton');
            const clearBtn = document.getElementById('clearBtn');

            const endpoints = [
                {method: 'GET', path: '/api/', title: '首页', description: '获取后端首页。'},
                {method: 'GET', path: '/api/settings', title: '系统设置', description: '获取当前用户系统设置。'},
                {method: 'PUT', path: '/api/settings', title: '更新系统设置', description: '更新当前用户系统设置。', body: {targetRate: 60}},
                {method: 'GET', path: '/api/attendance', title: '考勤记录', description: '获取指定月份考勤记录。', body: {month: '2026-07'}},
                {method: 'PUT', path: '/api/attendance', title: '更新考勤状态', description: '更新某一日考勤状态。', body: {date: '2026-07-01', status: 'office'}},
                {method: 'POST', path: '/api/attendance/bulk', title: '批量更新考勤', description: '一次性批量更新指定日期范围的数据。', body: {month: '2026-07', strategy: 'recommended', includePast: false}},
                {method: 'POST', path: '/api/attendance/smart-schedule', title: '智能排班', description: '根据指定策略生成智能排班。', body: {month: '2026-07', strategy: 'recommended', includePast: false}},
                {method: 'GET', path: '/api/holidays', title: '节假日列表', description: '获取指定年份的节假日列表。', body: {year: 2026}},
                {method: 'POST', path: '/api/holidays/sync', title: '同步国家节假日', description: '从国家法定节假日接口同步节假日数据。', body: {year: 2026}},
                {method: 'PUT', path: '/api/holidays', title: '更新自定义节假日', description: '添加、修改或删除某一天的节假日信息。', body: {date: '2026-07-01', dayType: 'holiday', name: '自定义'}},
                {method: 'POST', path: '/api/holidays/copy', title: '同步用户节假日', description: '将其他用户的节假日设置复制给当前用户。', body: {year: 2026, sourceUserId: 1}},
                {method: 'GET', path: '/api/seat-booking', title: '获取座位预定列表', description: '获取指定月份的座位预定记录。', body: {month: '2026-07'}},

                {method: 'POST', path: '/api/seat-booking/settings', title: '保存座位预约设置', description: '保存座位预约设置及预约计划。', body: {username: 'test', password: '123', bookingDate: '2026-07-10', preferredSeat: 'A01', bookingTime: '08:30', advanceDays: 3, enabled: true}},
                {method: 'GET', path: '/api/seat-booking/seats', title: '获取可用座位列表', description: '获取指定日期的可用座位列表。', body: {date: '2026-07-10'}},
                {method: 'POST', path: '/api/seat-booking/seats', title: '预订座位', description: '预订指定座位。', body: {date: '2026-07-10', seatId: 'A01'}},
                {method: 'GET', path: '/api/admin/settings', title: '系统设置', description: '获取系统设置。'},
                {method: 'GET', path: '/api/admin/users', title: '获取用户列表', description: '获取所有用户列表。', body: {}},
                {method: 'POST', path: '/api/admin/users', title: '创建用户', description: '创建新用户。', body: {username: 'test', password: '123', role: 'user'}},
                {method: 'DELETE', path: '/api/admin/users/{userId}', title: '删除用户', description: '删除指定用户。'},
                {method: 'PATCH', path: '/api/admin/users/{userId}/status', title: '修改用户状态', description: '启用或禁用指定用户。', body: {isActive: true}},
                {method: 'GET', path: '/api/admin/cleanup', title: '清理状态', description: '获取清理状态。'},
                {method: 'POST', path: '/api/admin/cleanup/run', title: '执行清理', description: '执行数据清理任务。', body: {dryRun: true}},
                {method: 'PUT', path: '/api/admin/settings', title: '保存系统设置', description: '更新系统设置。', body: {}}
            ];

            function formatJson(value) {
                return JSON.stringify(value, null, 2);
            }

            function fillCustomForm(endpoint) {
                methodSelect.value = endpoint.method;
                pathInput.value = endpoint.path;
                bodyInput.value = endpoint.body ? formatJson(endpoint.body) : '';
                bodyInput.focus();
            }

            async function sendRequest(method, path, bodyText, output) {
                output.textContent = 'Sending...';
                const options = {method: method || 'GET', headers: {'Content-Type': 'application/json'}};
                if (method !== 'GET' && bodyText.trim()) {
                    try {
                        options.body = JSON.stringify(JSON.parse(bodyText));
                    } catch (error) {
                        output.textContent = `请求体不是合法的 JSON: ${error.message}`;
                        return;
                    }
                } else if (method !== 'GET') {
                    options.body = '{}';
                }

                try {
                    const response = await fetch(path, options);
                    const text = await response.text();
                    let payload = text;
                    try {
                        payload = JSON.parse(text);
                    } catch (error) { /* 保留原始文本。 */
                    }
                    output.textContent = `HTTP ${response.status} ${response.statusText}\n${typeof payload === 'string' ? payload : formatJson(payload)}`;
                } catch (error) {
                    output.textContent = error.message;
                }
            }

            function renderEndpoints() {
                endpointList.innerHTML = '';
                endpoints.forEach(endpoint => {
                    const card = document.createElement('article');
                    card.className = 'endpoint-card';
                    card.innerHTML = `
                <div class="endpoint-card-head">
                    <span class="api-method">${endpoint.method}</span>
                    <code>${endpoint.path}</code>
                </div>
                <div class="endpoint-title">
                    <h3>${endpoint.title}</h3>
                    <p class="description">${endpoint.description}</p>
                </div>
                <div class="endpoint-body">
                    <details>
                        <summary>${endpoint.body ? formatJson(endpoint.body) : '无请求体'}</summary>
                        <pre>${endpoint.body ? formatJson(endpoint.body) : '无请求体'}</pre>
                    </details>
                </div>
                <div class="endpoint-actions">
                    <button type="button" data-action="send">发送请求</button>
                    <button type="button" data-action="fill">填充请求</button>
                </div>
            `;
                    const requestBody = card.querySelector('details > summary');
                    const responseOutput = card.querySelector('.endpoint-actions > pre');
                    card.querySelector('[data-action="send"]').addEventListener('click', () => sendRequest(endpoint.method, endpoint.path, requestBody.value, responseOutput));
                    card.querySelector('[data-action="fill"]').addEventListener('click', () => fillCustomForm(endpoint));
                    endpointList.appendChild(card);
                });
            }

            async function init() {
                await requireUser();
                renderEndpoints();
                endpointStatus.textContent = `共加载 ${endpointList.children.length} 个接口。`;
                sendButton.addEventListener('click', () => sendRequest(methodSelect.value, pathInput.value, bodyInput.value, output));
            }

            init().catch(error => {
                endpointStatus.textContent = error.message;
            });
        }


// ===========================
// 座位预约管理应用 (从图3至图8提取)
// ===========================
        function createSeatBookingApp() {
            const form = document.getElementById('seatBookingForm');
            const usernameInput = document.getElementById('seatInternalUsername');
            const passwordInput = document.getElementById('seatInternalPassword');
            const bookingDateInput = document.getElementById('seatBookingDate');
            const bookingTimeInput = document.getElementById('seatBookingTime');
            const advanceDaysInput = document.getElementById('seatAdvanceDays');
            const enabledInput = document.getElementById('seatBookingEnabled');
            const syncSeatBookingsBtn = document.getElementById('syncSeatBookingsBtn');
            const statusText = document.getElementById('seatBookingStatus');
            const badge = document.getElementById('seatBookingBadge');
            const schedulerStatus = document.getElementById('seatSchedulerStatus');
            const seatFilterInput = document.getElementById('seatFilterInput');
            const seatFilterSummary = document.getElementById('seatFilterSummary');
            const seatList = document.getElementById('seatList');
            const prevMonthBtn = document.getElementById('seatPrevMonthBtn');
            const nextMonthBtn = document.getElementById('seatNextMonthBtn');
            const seatBookingGrid = document.getElementById('seatBookingGrid');
            const calendarGrid = document.getElementById('seatCalendarGrid');
            const calendarSummary = document.getElementById('seatCalendarSummary');
            const seatPickerInline = document.querySelector('.seat-picker-inline');
            const seatPickerCloseBtn = document.getElementById('seatPickerCloseBtn');
            const runList = document.getElementById('runList');
            const runLog = document.getElementById('runLog');
            const runLogVisibleInput = document.getElementById('runLogVisible');

            let allSeats = [];
            let calendarSeatPlans = [];
            let seatPickers = {};
            let seatPickerVisible = false;
            let seatListLoading = false;
            let seatListError = '';
            let seatListErrorMsg = '';
            let calendarMonth = currentMonthValue();
            let seatBookings = {};
            let seatBookingRefreshLight = false;

            function todayPlusDays(days) {
                const current = new Date();
                current.setDate(current.getDate() + days);
                return isoFromDate(current);
            }

            function addMonths(value, delta) {
                const {year, month} = splitMonthYear(monthValue);
                const date = new Date(year, month - 1 + delta, 1);
                return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
            }

            function populateSeatCalendarMonths(selectMonth) {
                if (!calendarMonth) return;
                const {year, month} = splitMonthYear(selectMonth);
                const date = new Date(year, month - 1, 1);
                calendarMonthSelect.innerHTML = '';
                for (let offset = -12; offset <= 12; offset += 1) {
                    const value = new Date(date.getFullYear(), month + offset, 1);
                    const option = document.createElement('option');
                    option.value = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
                    option.textContent = `${value.getFullYear()} 年 ${value.getMonth() + 1} 月`;
                    calendarMonthSelect.appendChild(option);
                }
                calendarMonthSelect.value = selectMonth;
            }

            function selectBookingDate(date, options = {}) {
                const bookingDate = date || selectedBookingDate;
                seatPickers = {};
                if (options.dummyMonth === false) calendarMonth = date.slice(0, 7);
                seatPickerVisible = options.showPicker !== false;
                seatListLoading = true;
                seatListError = '';
                seatListErrorMsg = '';
                allSeats = [];
                renderSeats();
                renderCalendar();
            }

            function findBookingFromSeats(booking) {
                const bookingObj = (allSeats || []).find(item => item.date === booking.date);
                return booking ? String(bookingObj?.seat || '') : '';
            }

            function closeSeatPicker() {
                seatPickerVisible = false;
                seatListLoading = false;
                seatListError = '';
                seatListErrorMsg = '';
                allSeats = [];
                renderSeats();
                renderCalendar();
            }

            function renderCalendar() {
                if (!calendarMonth) return;
                populateSeatCalendarMonths(calendarMonth);
                const year = parseInt(calendarMonth);
                const month = new Date(year, month - 1, 1);
                const firstDayOfMonth = 1;
                const lastDayOfMonth = new Date(year, month, 0).getDate();
                const leadingBlanks = (firstDayOfMonth % 7) + 7;
                const startDate = new Date(year, month - 1, 1);
                const endDate = new Date(year, month - 1, lastDayOfMonth);
                calendarGrid.innerHTML = '';
                for (let i = 0; i < 42; i += 1) {
                    const currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
                    const currentDateIso = isoFromDate(currentDate);
                    const isPast = currentDate < new Date().setHours(0, 0, 0, 0);
                    const cell = document.createElement('div');
                    cell.className = 'seat-calendar-cell';
                    cell.classList.toggle('picker-visible', seatPickerVisible && seatPickers[currentDateIso] === true);
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'seat-calendar-day';
                    const bookingDate = calendarSeatPlans.find(p => p.date === currentDateIso);
                    const booking = bookingDate && bookingDate.isBooking;
                    const isPastDate = !booking && currentDate < new Date().setHours(0, 0, 0, 0);
                    button.dataset.date = currentDateIso;
                    button.textContent = currentDate.getDate();
                    if (currentDateIso === calendarMonth.slice(0, 7) + '-01') button.classList.add('first');
                    if (booking) button.classList.add('booked');
                    button.classList.toggle('past', isPast);
                    if (isPast) button.classList.add('locked');

                    const isToday = currentDate.toDateString() === new Date().toDateString();
                    if (isToday) button.classList.add('today');
                    const isWeekend = [0, 6].includes(currentDate.getDay());
                    if (isWeekend) button.classList.add('weekend');
                    if (selectedBookingDate === currentDateIso) button.classList.add('selected');

                    button.addEventListener('click', () => {
                        if (button.disabled) return;
                        if (calendarMonth !== date =>
                        date.slice(0, 7)
                    )
                        {
                            calendarMonth = date.slice(0, 7);
                            populateSeatCalendarMonths(calendarMonth);
                            renderCalendar();
                        }
                        const selectedDate = currentDateIso;
                        fetchSeatsForSelectedDate(selectedDate);
                    });
                    cell.appendChild(button);

                    // 座位选择框渲染
                    if (seatPickerVisible && seatPickers[currentDateIso]) {
                        const actions = document.createElement('div');
                        actions.className = 'seat-calendar-actions';
                        if (bookingDate) {
                            const status = bookingDate.status;
                            const bookingBtn = document.createElement('button');
                            bookingBtn.className = 'seat-calendar-direct-primary-button';
                            bookingBtn.textContent = '取消预选';
                            if (bookingBtn.textContent === '取消预选') {
                                bookingBtn.disabled = true;
                                const confirmMsg = '确认取消';
                                if (bookingBtn.textContent === '取消预选') {
                                    bookingBtn.textContent = '已取消预选';
                                }
                            }
                            actions.appendChild(bookingBtn);
                        }
                        cell.appendChild(actions);
                    }

                    calendarGrid.appendChild(cell);
                    if (calendarSummary) {
                        const advanceDays = Number(advanceDaysInput.value) || 0;
                        calendarSummary.innerHTML = `已选择 ${selectedBookingDate || '未选'} 日期，将在 ${advanceDays || 0} 天内执行...`;
                    }
                }
            }

            function fillSettings(settings, options = {}) {
                const passwordInput = document.getElementById('seatInternalPassword');
                const passwordInputPlaceholder = passwordInput?.placeholder || '设置密码后生效';
                const settingsBool = settings.holidayBooking && settings.holidayBooking;
                if (options.preservePicker) seatPickerVisible = settingsBool;
                const bookingDateInput = document.getElementById('seatBookingDate');
                const bookingTimeInput = document.getElementById('seatBookingTime');
                const advanceDaysInput = document.getElementById('seatAdvanceDays');
                const enabledInput = document.getElementById('seatBookingEnabled');
                const bookingDate = settings.bookingDate || todayPlusDays(0);
                bookingDateInput.value = bookingDate;
                bookingTimeInput.value = settings.bookingTime || '08:30';
                advanceDaysInput.value = String(settings.advanceDays || 0);
                enabledInput.checked = settings.enabled;
                const badge = document.getElementById('seatBookingBadge');
                badge.textContent = settings.enabled ? `已启用 (${settings.bookingTime || '08:30'})` : '未启用';
                renderCalendar();
            }

            function escapeHtml(value) {
                return String(value).replace(/[&<>"]/g, (ch) => {
                    const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'};
                    return map[ch] || ch;
                });
            }

            function renderSchedulerStatus(scheduler) {
                if (!scheduler) return;
                const enabledText = scheduler.enabled ? '已启用' : '已禁用';
                const statusTextEl = document.getElementById('seatSchedulerStatus');
                statusTextEl.textContent = `${enabledText}, 运行间隔 ${scheduler.intervalSeconds || 0} 秒。`;
            }

            function filterSeats(seats) {
                const query = (seatFilterInput?.value?.trim?.() ?? '').toLowerCase();
                return seats.filter(seat => {
                    const seatId = seat.seatId || seat.id || '';
                    const seatName = seat.seatName || seat.name || '';
                    return `${seatId} ${seatName}`.toLowerCase().includes(query);
                });
            }

            function renderSeats() {
                const seats = filterSeats(allSeats);
                seatList.innerHTML = '';
                if (seatListLoading) {
                    seatListFilterSummary.innerHTML = '正在加载';
                    seatList.innerHTML = '<p class="empty-note">正在加载座位列表...</p>';
                    return;
                }
                if (seatListError) {
                    seatListFilterSummary.textContent = '加载失败';
                    seatList.innerHTML = `<p class="empty-note">${escapeHtml(seatListError)}</p>`;
                    return;
                }
                if (!seats.length) {
                    seatListFilterSummary.textContent = `${allSeats.length || 0} 个座位`;
                    seatList.innerHTML = `<p class="empty-note">${seatListErrorMsg || '在指定时间段内没有可用座位。'}</p>`;
                    return;
                }
                seats.forEach(seat => {
                    const card = document.createElement('article');
                    card.className = 'seat-card';
                    card.innerHTML = `
                <div class="seat-header">
                    <span class="seat-id">${escapeHtml(seat.id || seat.seatId)}</span>
                    <span class="seat-name">${escapeHtml(seat.name || seat.seatName || '无名')}</span>
                    <span class="seat-status ${seat.isAvailable ? 'available' : 'unavailable'}">
                        ${seat.isAvailable ? '可用' : '不可用'}
                    </span>
                </div>
                <div class="seat-actions">
                    <button type="button" class="primary-button" data-action="plan" ${!seat.isAvailable || new Date(selectedBookingDate) < new Date().setHours(0, 0, 0, 0) ? 'disabled' : ''}>预选</button>
                    <button type="button" class="primary-button" data-action="direct" ${!seat.isAvailable && new Date(selectedBookingDate) < new Date().setHours(0, 0, 0, 0) ? 'disabled' : ''}>立即预约</button>
                </div>
            `;
                    card.querySelector('[data-action="plan"]').addEventListener('click', async () => {
                        if (!selectedBookingDate) return;
                        await apiFetch('/api/seat-booking/plan', {
                            method: 'PUT',
                            body: JSON.stringify({bookingDate: selectedBookingDate, seatId: seat.id, seatName: seat.name || seat.id}),
                        });
                        calendarSeatPlans = data.plans || calendarSeatPlans;
                        renderCalendar();
                        statusText.textContent = `已预约座位 ${seat.name || seat.id}。`;
                    });
                    card.querySelector('[data-action="direct"]').addEventListener('click', () => {
                        if (!selectedBookingDate) return;
                        submitDirectBooking(selectedBookingDate, seat.id, seat.name || seat.id);
                    });
                    seatList.appendChild(card);
                });
            }

            function renderRuns(runs) {
                runList.innerHTML = '';
                if (!runs.length) {
                    runList.innerHTML = '<p class="empty-note">暂无运行记录。</p>';
                    return;
                }
                runs.forEach(run => {
                    const card = document.createElement('article');
                    card.className = 'seat-run-card';
                    card.innerHTML = `
                <div class="run-header">
                    <span class="run-id">${escapeHtml(run.id)}</span>
                    <span class="run-time">${escapeHtml(run.createdAt || run.time)}</span>
                </div>
                <pre class="run-log">${escapeHtml(run.message || run.log) || ''}</pre>
            `;
                    runList.appendChild(card);
                });
            }

            function updateRunLogVisibility() {
                const visible = !!runLogVisibleInput?.checked;
                runLog.hidden = !visible;
                runLogVisibleInput.setAttribute('aria-expanded', String(visible));
                if (seatBookingGrid) seatBookingGrid.classList.toggle('full', !visible);
            }

            function startSeatBookingAutoRefresh() {
                if (seatBookingRefreshTimer) {
                    window.clearInterval(seatBookingRefreshTimer);
                }
                seatBookingRefreshTimer = window.setInterval(refreshSeatBookingLight, SEAT_BOOKING_REFRESH_INTERVAL_MS);
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) {
                        clearInterval(seatBookingRefreshTimer);
                    } else {
                        refreshSeatBookingLight();
                    }
                });
                window.addEventListener('pagehide', () => {
                    if (seatBookingRefreshTimer) {
                        window.clearInterval(seatBookingRefreshTimer);
                    }
                });
            }

            async function fetchSeatsForSelectedDate(date) {
                if (!selectedBookingDate) return;
                if (isPastIsoDate(selectedBookingDate)) {
                    statusText.textContent = '不允许选择过去的日期。';
                    return;
                }
                statusText.textContent = `正在加载 ${selectedBookingDate} 的座位列表...`;
                seatPickerVisible = true;
                seatListLoading = true;
                seatListError = '';
                seatListErrorMsg = '';
                allSeats = [];
                renderSeats();
                renderCalendar();
                try {
                    const data = await apiFetch('/api/seat-booking/seats?date=' + encodeURIComponent(date));
                    allSeats = data.seats || [];
                    seatListLoading = false;
                    seatListErrorMsg = '';
                    seatListErrorMsg = data.message || `已加载 ${allSeats.length} 个座位。`;
                    renderSeats();
                    renderCalendar();
                } catch (error) {
                    allSeats = [];
                    seatListError = error.message;
                    statusText.textContent = `加载座位失败: ${error.message}`;
                } finally {
                    seatPickerVisible = true;
                    seatListLoading = false;
                    renderSeats();
                    renderCalendar();
                }
            }

            async function submitDirectBooking(bookingDate, seatId, seatName) {
                if (!isDirectBookingDate(bookingDate)) {
                    statusText.textContent = '直接预约只能选择7天内的日期。';
                    return;
                }
                statusText.textContent = `正在预约座位 ${bookingDate} 的座席...`;
                const data = await apiFetch('/api/seat-booking/book', {
                    method: 'POST',
                    body: JSON.stringify({date: bookingDate, seatId, seatName}),
                });
                const message = data.run ? data.run.message : '预约请求已发送。';
                calendarMonth = bookingDate.slice(0, 7);
                statusText.textContent = message;
                try {
                    await refreshSeatBookingMonth();
                } catch (error) {
                    statusText.textContent = `${message}，但刷新列表失败: ${error.message}`;
                }
            }

            async function saveSettings(includePassword, callback = false, options = {}) {
                const data = await apiFetch('/api/seat-booking/settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        ...payload,
                        ...(includePassword ? {password: passwordInput.value} : {}),
                    }),
                });
                fillSettings(data.settings || {}, options);
                statusText.textContent = `参数配置已保存。`;
            }

            async function init() {
                await requireUser();
                await loadSeatBooking();
                startSeatBookingAutoRefresh();
                if (seatPickerCloseBtn) seatPickerCloseBtn.addEventListener('click', closeSeatPicker);
                if (runLogVisibleInput) runLogVisibleInput.addEventListener('change', updateRunLogVisibility);

                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    await saveSettings(true);
                    statusText.textContent = settings?.message || '设置已保存。';
                });

                if (seatFilterInput) seatFilterInput.addEventListener('input', renderSeats);
                if (calendarMonthSelect) calendarMonthSelect.addEventListener('change', async () => {
                    calendarMonth = calendarMonthSelect.value;
                    renderCalendar();
                    await refreshSeatBookingMonth();
                });
                if (prevMonthBtn) prevMonthBtn.addEventListener('click', async () => {
                    calendarMonth = addMonths(calendarMonth, -1);
                    renderCalendar();
                    await refreshSeatBookingMonth();
                });
                if (nextMonthBtn) nextMonthBtn.addEventListener('click', async () => {
                    calendarMonth = addMonths(calendarMonth, 1);
                    renderCalendar();
                    await refreshSeatBookingMonth();
                });

                if (advanceDaysInput) advanceDaysInput.addEventListener('change', renderCalendar);
                if (bookingDateInput) bookingDateInput.addEventListener('change', renderCalendar);
                if (syncSeatBookingsBtn) syncSeatBookingsBtn.addEventListener('click', async () => {
                    statusText.textContent = '正在同步所有日历信息...';
                    try {
                        const data = await apiFetch('/api/seat-booking/sync?month=' + encodeURIComponent(calendarMonth), {method: 'POST', body: '{}'});
                        const syncMonth = data.syncMonth;
                        if (syncMonth && syncMonth !== calendarMonth && Object.keys(data.plans || {}).length) {
                            calendarMonth = syncMonth;
                            selectedBookingDate = data.bookings || [];
                            seatPickerVisible = false;
                            bookingDateInput.value = selectedBookingDate;
                            calendarSeatPlans = await apiFetch('/api/seat-booking?month=' + encodeURIComponent(calendarMonth));
                            renderCalendar();
                            renderRuns(data.runs || []);
                        } else {
                            calendarSeatPlans = data.plans || calendarSeatPlans;
                            renderRuns(data.runs || []);
                            renderCalendar();
                        }
                        statusText.textContent = `同步完成，新增 ${data.synced || 0} 条，更新 ${data.updated || 0} 条。`;
                    } catch (error) {
                        statusText.textContent = `同步失败: ${error.message}`;
                    } finally {
                        syncSeatBookingsBtn.disabled = false;
                    }
                });
            }

            init().catch(error => {
                statusText.textContent = error.message;
            });
        }


// ===========================
// Service Worker 注册与导出 (从图8提取)
// ===========================
        function registerServiceWorker() {
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                    navigator.serviceWorker.register('/service-worker.js', {scope: '/'}).catch(() => {
                        // 服务工作线程注册失败，通常是因为文件缓存或HTTPS等问题，后续处理。
                    });
                });
            }
        }

        const api = {
            STATUS,
            parseHolidayInput,
            buildMonthDays,
            mapTimerHolidayResponse,
            mapNagerHolidayResponse,
            fetchHolidays,
            apiFetch,
            requireUser,
            isPastIsoDate,
            isDirectBookingDate,
            addMonths,
        };

        if (typeof module !== 'undefined' && module.exports) {
            module.exports = api;
        } else {
            global.attendanceCalculator = api;
            registerServiceWorker();
            document.addEventListener('DOMContentLoaded', () => {
                const body = document.body;
                if (document.body.dataset.page === 'login') createLoginApp();
                else if (document.body.dataset.page === 'api-docs') createApiDocsApp();
                else if (document.body.dataset.page === 'seat-booking') createSeatBookingApp();
                else if (document.body.dataset.page === 'admin') createAdminApp();
                else if (document.body.dataset.page === 'holidays') createHolidayApp();
                else createAttendanceApp();
            });
        }
    })(typeof window !== 'undefined'? window = globalThis);