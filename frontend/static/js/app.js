(function (global) {
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

    function currentMonthValue(now = new Date()) {
        return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    }

    function isoFromDate(date) {
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function addDays(now, days) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        date.setDate(date.getDate() + days);
        return isoFromDate(date);
    }

    function isPastIsoDate(isoDate, now = new Date()) {
        return isValidIsoDate(isoDate) && isoDate < isoFromDate(now);
    }

    function currentWeekStartIso(now = new Date()) {
        const offset = (now.getDay() + 6) % 7;
        return addDays(now, -offset);
    }

    function isPastDateIncurrentWeek(isoDate, now = new Date()) {
        const today = isoFromDate(now);
        return isValidIsoDate(isoDate) && isoDate >= currentWeekStartIso(now) && isoDate < today;
    }

    function isDirectBookingDate(isoDate, now = new Date()) {
        return isValidIsoDate(isoDate) && isoDate >= addDays(now, 1) && isoDate <= addDays(now, 7);
    }

    function currentYearValue(now = new Date()) {
        return now.getFullYear();
    }

    function populateYearSelect(select, selectedYear, yearsBefore = 10, yearsAfter = 10) {
        const currentYear = currentYearValue();
        const targetYear = Number(selectedYear) || currentYear;
        const startYear = Math.max(currentYear - yearsBefore, targetYear);
        const endYear = Math.max(currentYear + yearsAfter, targetYear);
        select.innerHTML = '';
        for (let year = startYear; year <= endYear; year += 1) {
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
        for (let month = 1; month <= 12; month += 1) {
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
        if (!name) return isHoliday ? '节假日' : '调休';
        if (isHoliday && SPRING_FESTIVAL_ALIASES.has(name)) return '春节';
        let base = name.replace(/[前后]?(调休|补班|放假|假期)$/, '').trim();
        base = base || name.replace(/补班|调休/g, '').trim();
        if (!base) base = isHoliday ? '节假日' : '调休';
        if (isHoliday) return name.includes('调休') ? `${base}调休` : base;
        return `${base}补班`;
    }

    function isValidIsoDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
        const [year, month, day] = String(value).split('-').map(Number);
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    }

    function parseHolidayInput(input) {
        const matches = (String(input) || '').match(/\d{4}-\d{2}-\d{2}/g) || [];
        return normalizeHolidayList(matches);
    }

    function normalizeHolidayList(list) {
        return Array.from(new Set((list || []).filter(isValidIsoDate))).sort();
    }

    function normalizeHolidayItems(items) {
        const byDate = new Map();
        (items || []).forEach((item) => {
            if (typeof item === 'string' && isValidIsoDate(item)) {
                byDate.set(item, {date: item, name: '节假日', isHoliday: true});
            } else if (item && isValidIsoDate(item.date)) {
                const isHoliday = item.isHoliday !== false;
                byDate.set(item.date, {date: item.date, name: item.name || isHoliday ? '节假日' : '补班', isHoliday});
            }
        });
        return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    function isWeekend(date) {
        const day = date.getDay();
        return day === 0 || day === 6;
    }

    function buildMonthDays(monthValue, holidays) {
        const [year, month] = String(monthValue).split('-').map(Number);
        if (!year || !month) return [];

        const overrideMap = new Map(normalizeHolidayItems(holidays).map((item) => [item.date, item]));
        const daysInMonth = new Date(year, month, 0).getDate();
        const days = [];

        for (let day = 1; day <= daysInMonth; day += 1) {
            const date = new Date(year, month - 1, day);
            const iso = `${year}-${pad2(month)}-${pad2(day)}`;
            const weekend = isWeekend(date);
            const override = overrideMap.get(iso);
            const isHolidayOverride = Boolean(override && override.isHoliday);
            const isWorkdayOverride = Boolean(override && override.isWorkday === false);
            const overrideName = override ? override.name : '';
            days.push({
                iso,
                day,
                weekday: date.getDay(),
                weekdayName: WEEKDAY_NAMES[date.getDay()],
                isWeekend: weekend,
                selectable: isWorkdayOverride || (!weekend && !isHolidayOverride),
                reason: isHolidayOverride ? overrideName : isWorkdayOverride ? overrideName : weekend ? '周末' : '',
                holidayName: isHolidayOverride ? overrideName : '',
                isWorkdayOverride
            });
        }

        return days;
    }

    function mapTimerHolidayResponse(year, payload) {
        if (!payload || typeof payload.holiday !== 'object') return [];
        return normalizeHolidayItems(Object.entries(payload.holiday)
            .filter(([, item]) => item && typeof item.holiday === 'boolean')
            .map(([monthDay, item]) => {
                const isHoliday = item.holiday === true;
                return {date: `${year}-${monthDay}`, name: normalizeHolidayName(item.name, isHoliday), isHoliday};
            }));
    }

    function mapNagerHolidayResponse(payload) {
        if (!Array.isArray(payload)) return [];
        return normalizeHolidayItems(payload.map(item => ({date: item.date, name: normalizeHolidayName
            (item.name, true), isHoliday: true})));
    }

    async function fetchChinaHolidays(year, fetchImpl) {
        const fetcher = fetchImpl || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
        if (!fetcher) throw new Error('当前浏览器不支持 fetch，无法自动获取节假日。');

        try {
            const timerResponse = await fetcher(`https://timer.tech/api/holiday/year/${year}`);
            if (timerResponse && timerResponse.ok) {
                const holidays = mapTimerHolidayResponse(String(year), await timerResponse.json());
                if (holidays.length) return {holidays, source: 'timer.tech 中国节假日接口'};
            }
        } catch (error) {
            // 接口A失败时尝试备用接口
        }

        try {
            const nagerResponse = await fetcher(`https://date.nager.at/api/v3/PublicHolidays/${year}/CN`);
            if (nagerResponse && nagerResponse.ok) {
                const holidays = mapNagerHolidayResponse(await nagerResponse.json());
                if (holidays.length) return {holidays, source: 'Nager.Date Public Holidays API'};
            }
        } catch (error) {
            // 两个接口都失败时，声明不能自动获取
        }

        throw new Error('当前接口无法获取可用数据。');
    }

    async function apiFetch(url, options) {
        const response = await fetch(url, Object.assign({
            headers: {'Content-Type': 'application/json'},
        }, options || {}));
        if (response.status === 401 && document.body.dataset.page === 'login') {
            window.location.href = '/login.html';
            throw new Error('unauthorized');
        }
        const data = await response.json().catch(()=>({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    }

    const PAGE_PATHS = {
        attendance: '/index.html',
        holidays: '/holidays.html',
        'seat-booking': '/seat-booking.html',
        'api-docs': '/api-docs.html',
        admin: '/admin.html',
    };

    function pageIdFromHref(href) {
        if (!href) return null;
        if (href.endsWith('index.html') || href === '/' || href === '') return 'attendance';
        if (href.endsWith('holidays.html')) return 'holidays';
        if (href.endsWith('seat-booking.html')) return 'seat-booking';
        if (href.endsWith('api-docs.html')) return 'api-docs';
        if (href.endsWith('admin.html')) return 'admin';
        return null;
    }

    async function requireUser() {
        const data = await apiFetch('/api/me');
        const badge = document.getElementById('userBadge');
        if (badge) badge.textContent = data.user.username;
        const allowedPages = new Set(data.user.accessiblePages || []);
        document.querySelectorAll('.top-nav a[href]').forEach((link) => {
            const pageId = pageIdFromHref(link.getAttribute('href'));
            if (pageId) link.classList.toggle('hidden', !allowedPages.has(pageId));
        });
        const currentPage = document.body.dataset.page;
        if (currentPage && currentPage !== 'login' && !allowedPages.has(currentPage)) {
            const fallback = (data.user.accessiblePages || []).find((pageId) => PAGE_PATHS[pageId]);
            window.location.href = fallback ? PAGE_PATHS[fallback] : '/login.html';
            throw new Error('当前用户无权访问此页面');
        }
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                await apiFetch('/api/logout', {method: 'POST', body: '{}'});
                window.location.href = './login.html';
            });
        }
        return data.user;
    }

    let sharedConfirmResolve = null;
    let sharedConfirmTrigger = null;

    function ensureConfirmDialog() {
        let dialog = document.getElementById('confirmDialog');
        if (dialog) return dialog;
        dialog = document.createElement('div');
        dialog.id = 'confirmDialog';
        dialog.className = 'confirm-overlay hidden';
        dialog.setAttribute('role', 'presentation');
        dialog.innerHTML = `
        <section class="confirmDialog" role="dialog" aria-modal="true" aria-labelledby="confirmDialogTitle" aria-describedby="confirmDialogMessage">
            <div class="confirm-modal__halo" aria-hidden="true"></div>
            <div class="confirm-modal__head">
                <div>
            <p class="eyebrow">Confirm Action</p>
            <h2 id="confirmDialogTitle">确认操作</h2>
    </div>
    <button id="confirmDialogClose" class="confirm-modal__close" type="button" aria-label="取消并关闭确认弹窗">×</button>
</div>
    <p id="confirmDialogMessage" class="confirm-modal__message">-</p>
    <div class="confirm-modal__actions">
    <button id="confirmDialogCancel" type="button">取消</button>
    <button id="confirmDialogConfirm" class="danger-button" type="button">确认继续</button>
</div>
        </section>
        `;
        document.body.appendChild(dialog);
        dialog.querySelector('#confirmDialogCancel').addEventListener('click', () => closeSharedConfirmDialog(false));
        dialog.querySelector('#confirmDialogClose').addEventListener('click', () => closeSharedConfirmDialog(false));
        dialog.querySelector('#confirmDialogConfirm').addEventListener('click', () => closeSharedConfirmDialog(true));
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) closeSharedConfirmDialog(false);
        });
        document.addEventListener('keydown', (event) => {
        if (dialog.classList.contains('hidden')) return;
        if(event.key === 'Escape') closeSharedConfirmDialog(false);
    });
        return dialog;
    }

    function closeSharedConfirmDialog(confirmed) {
        const dialog = document.getElementById('confirmDialog');
        if (!dialog || ! sharedConfirmResolve) return;
        const resolve = sharedConfirmResolve;
        const trigger = sharedConfirmTrigger;
        sharedConfirmResolve = null;
        sharedConfirmTrigger = null;
        dialog.classList.add('hidden');
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
        resolve(Boolean(confirmed));
    }

    function confirmAction(message, options = {}) {
        const dialog = ensureConfirmDialog();
        const title = dialog.querySelector('#confirmDialogTitle');
        const messageNode = dialog.querySelector('#confirmDialogMessage');
        const confirmButton = dialog.querySelector('#confirmDialogConfirm');
        if (sharedConfirmResolve) closeSharedConfirmDialog(false);
        title.textContent = options.title || '确认操作';
        messageNode.textContent = message;
        confirmButton.textContent = options.confirmText || '确认继续';
        confirmButton.classList.toggle('danger-button', options.tone === 'danger');
        confirmButton.classList.toggle('primary-button', options.tone !== 'danger');
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

        document.querySelectorAll('[data-auth]').forEach((button) => {
            button.addEventListener('click', () => {
                action = button.dataset.auth;
            });
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            message.textContent = action === 'register' ? '正在注册...' : '正在登录...';
            try {
                await apiFetch(`/api/${action}`,{
                    method: 'POST',
                    body: JSON.stringify({username: usernameInput.value.trim(),password: passwordInput.value}),
            });
                window.location.href = './index.html';
            } catch (error) {
                message.textContent = error.message;
            }
        });
    }

    function createAdminApp() {
        const adminBadge = document.getElementById('adminBadge');
        const userAccessList = document.getElementById('userAccessList');
        const userAccessStatus = document.getElementById('userAccessStatus');
        const cleanupSchedulerToggle = document.getElementById('cleanupSchedulerToggle');
        const cleanupSchedulerText = document.getElementById('cleanupSchedulerText');
        const attendanceRetentionInput = document.getElementById('attendanceRetentionInput');
        const overdueRetentionInput = document.getElementById('overdueRetentionInput');
        const planRetentionInput = document.getElementById('planRetentionInput');
        const runRetentionInput = document.getElementById('runRetentionInput');
        const cleanupForm = document.getElementById('cleanupForm');
        const previewCleanupBtn = document.getElementById('previewCleanupBtn');
        const runCleanupBtn = document.getElementById('runCleanupBtn');
        const cleanupSchedulerStatus = document.getElementById('cleanupSchedulerStatus');
        const cleanupSchedulerDetail = document.getElementById('cleanupSchedulerDetail');
        const cleanupLastRun = document.getElementById('cleanupLastRun');
        const cleanupLastMessage = document.getElementById('cleanupLastMessage');
        const cleanupResultTotal = document.getElementById('cleanupResultTotal');
        const cleanupResultDetail = document.getElementById('cleanupResultDetail');
        let availablePages = [];
        let currentAdminId = null;

        function escapeHtml(value) {
            return String(value).replace(/[&<>"]/g, (char) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[char]);
        }

        function payloadFromForm() {
            return {
                scheduledEnabled: cleanupSchedulerToggle.checked,
                attendanceRetentionMonths: Number(attendanceRetentionInput.value),
                overdueRetentionMonths: Number(overdueRetentionInput.value),
                seatBookingPlanRetentionMonths: Number(planRetentionInput.value),
                seatBookingRunRetentionMonths: Number(runRetentionInput.value),
            };
        }

        function renderSettings(settings, schedule) {
            cleanupSchedulerToggle.checked = Boolean(settings.scheduledEnabled);
            cleanupSchedulerText.textContent = settings.scheduledEnabled ? '定时清理开启' : '定时清理关闭';
            attendanceRetentionInput.value = settings.attendanceRetentionMonths;
            overdueRetentionInput.value = settings.overdueRetentionMonths;
            planRetentionInput.value = settings.seatBookingPlanRetentionMonths;
            runRetentionInput.value = settings.seatBookingRunRetentionMonths;
            cleanupLastRun.textContent = settings.lastRunAt || '尚未执行';
            cleanupLastMessage.textContent = settings.lastMessage || '尚未执行自动或手动清理。';
            if (schedule) {
                cleanupSchedulerStatus.textContent = schedule.enabled ? '调度程序已启动' : '调度未启动';
                cleanupSchedulerDetail.textContent = schedule.lastMessage || (settings.scheduledEnabled ? `等待下一次检查` : `等待管理员开启。`); //11
            }
        }

        function renderCleanupResult(result) {
            cleanupResultTotal.textContent = result.message || `影响${result.total || 0}条`;
            const deleted = result.deleted || {};
            const cutoffs = result.cutoffs || {};
            cleanupResultDetail.textContent = [
                `考勤 ${deleted.attendance || 0} 条（早于 ${cutoffs.attendance || '--'}）`,
                `加班 ${deleted.overtime || 0} 条（早于 ${cutoffs.overtime || '--'}）`,
                `座位计划 ${deleted.seatBookingPlans || 0} 条（早于 ${cutoffs.seatBookingPlans || '--'}）`,
                `运行日志 ${deleted.seatBookingRuns || 0} 条（早于 ${cutoffs.seatBookingRuns || '--'}）`,
            ].join('；');
            if (result.settings) renderSettings(result.settings, result.schedule);
        }

        function renderUsers(payload) {
            availablePages = payload.pages || [];
            const users = payload.users || [];
            userAccessList.innerHTML = '';
            users.forEach(user => {
                const card = document.createElement('article');
                card.className = 'admin-user-card';
                if (!user.isActive) card.classList.add('inactive');
                card.dataset.userId = String(user.id);
                const checks = availablePages.map((page) => {
                    const checked = (user.accessiblePages || []).includes(page.id) ? 'checked' : '';
                    const disabled = page.adminOnly && user.role === 'admin' ? ' disabled' : '';
                    return `<label><input type="checkbox" value="${escapeHtml(page.id)}" ${checked} ${disabled}/> ${escapeHtml(page.label)}</label>`;
                }).join('');
                card.innerHTML = `
                    <div>
                    <h3>${escapeHtml(user.username)}<span class="user-status-badge" ${user.isActive ? 'active' : 'inactive'}>${user.isActive ? '启用' : '停用'}</span></h3>
                    <small class="hint">id=${user.id}${user.createdAt ? ` · ${escapeHtml(user.createdAt)}` : ''} 
${user.deactivatedAt ? ` · 停用${escapeHtml(user.deactivatedAt)}` : ''}</small>
                    </div>
                    <label class="field">
                    <span>角色</span>
                    <select data-role>
                    <option value="user" ${user.role === 'user' ? 'selected' : ''}>普通用户</option>
                    <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option>
                    </select>
                    </label>
                    <div class="admin-page-checks" aria-label="${escapeHtml(user.username)} 可访问页面">${checks}</div>
                    <div class="admin-user-actions">
                    <button type="button" data-save-user>保存</button>
                    <button type="button" data-toggle-user>${user.isActive ? '停用' : '启用'}</button>
                    <button type="button" class="danger-button" data-delete-user>删除</button>
                    </div>
                `;
                const roleSelect = card.querySelector('[data-role]');
                const saveButton = card.querySelector('[data-save-user]');
                const toggleButton = card.querySelector('[data-toggle-user]');
                const deleteButton = card.querySelector('[data-delete-user]');
                if(user.id===currentAdminId) roleSelect.title ='不能取消自己的管理员角色';
                if (user.id === currentAdminId || user.username.toLowerCase()==='luohao') {
                    toggleButton.disabled = true;
                    deleteButton.disabled = true;
                }
                roleSelect.addEventListener('change', () => {
                    const isAdmin = roleSelect.value === 'admin';
                    card.querySelectorAll('.admin-page-checks input').forEach((input) => {
                        const page = availablePages.find((item) => item.id === input.value);
                        if (page && page.adminOnly) {
                            input.disabled = !isAdmin;
                            input.checked = isAdmin;
                        } else if(isAdmin) {
                            input.checked = true;
                        }
                    });
                });
                saveButton.addEventListener('click', async () => {
                    saveButton.disabled = true;
                    userAccessStatus.textContent = `正在保存${user.username}的权限...`;
                    const accessiblePages = Array.from(card.querySelectorAll('.admin-page-checks input:checked')).map((input) => input.value);
                    try {
                        const result = await apiFetch(`/api/admin/users/${user.id}`, {
                            method: 'POST',
                            body: JSON.stringify({role: roleSelect.value, accessiblePages}),
                        });
                        const usersData = await apiFetch('/api/admin/users');
                        renderUsers(usersData);
                        userAccessStatus.textContent = `${result.user.username} 的权限已保存。`;
                    } catch (error) {
                        userAccessStatus.textContent = `保存失败。${error.message}`;
                    } finally {
                        saveButton.disabled = false;
                    }
                });
                toggleButton.addEventListener('click', async () => {
                    const nextActive = !user.isActive;
                    const actionText = nextActive ? '启用' : '停用';
                    const confirmed = nextActive || await confirmAction(`停用 ${user.username} 后，该用户将无法登录，已登录会话也会失效；历史数据会保留，确定继续吗？`,
                        {
                            title: `确认${actionText}用户`,
                            confirmText: `确认${actionText}`,
                            tone: 'danger'
                        });
                    if (!confirmed) return;
                    toggleButton.disabled = true;
                    userAccessStatus.textContent = `正在${actionText} ${user.username}`;
                    try {
                        const result = await apiFetch(`/api/admin/users/${user.id}/status`, {
                            method: 'PATCH',
                            body: JSON.stringify({isActive: nextActive}),
                        });
                        const usersData = await apiFetch('/api/admin/users');
                        renderUsers(usersData);
                        userAccessStatus.textContent = `${user.username} 已${actionText}`;
                    } catch (error) {
                        userAccessStatus.textContent = `${actionText}失败: ${error.message}`;
                    } finally {
                        toggleButton.disabled = false;
                    }
                });
                deleteButton.addEventListener('click', async () => {
                    const confirmed = await confirmAction(`删除 ${user.username} 会永久删除该用户及其出勤、节假日、座位预约等所有业务数据，建议先备份数据库，确定继续吗？`,
                        {
                        title: '删除用户及相关数据',
                        confirmText: '确认删除',
                        tone: 'danger',
                    });
                    if (!confirmed) return;
                    deleteButton.disabled = true;
                    userAccessStatus.textContent = `正在删除 ${user.username}`;
                    try {
                        await apiFetch(`/api/admin/users/${user.id}`, {method: 'DELETE'});
                        const usersData = await apiFetch('/api/admin/users');
                        renderUsers(usersData);
                        userAccessStatus.textContent = `${user.username} 已删除。`;
                    } catch (error) {
                        userAccessStatus.textContent = `删除失败: ${error.message}`;
                    } finally {
                        deleteButton.disabled = false;
                    }
                });
                userAccessList.appendChild(card);
            });
            if (!users.length) userAccessList.textContent = '暂无用户';
        }
        
        async function load() {
        const user = await requireUser();
        currentAdminId = user.id;
        if (!user.isAdmin) {
        adminBadge.textContent = '无权限';
        cleanupSchedulerDetail.textContent = '只有管理员可以访问系统管理。';
        window.location.href = `./index.html`;
        return;
        }
        adminBadge.textContent = `${user.username} · 管理员`;
        const data = await apiFetch('/api/admin/cleanup');
        renderSettings(data.settings,data.scheduler);
        const usersData = await apiFetch('/api/admin/users');
        renderUsers(usersData);

    }
    cleanupSchedulerToggle.addEventListener('change', () => {
            cleanupSchedulerText.textContent = cleanupSchedulerToggle.checked ? '定时清理开启' : '定时清理关闭';
        });

        cleanupForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            cleanupSchedulerDetail.textContent = '正在保存清理策略...';
            try {
                const data = await apiFetch('/api/admin/cleanup', {method: 'PUT', body: JSON.stringify(payloadFromForm())});
                renderSettings(data.settings, data.schedule);
                cleanupSchedulerDetail.textContent = '清理策略已保存。';
            } catch (error) {
                cleanupSchedulerDetail.textContent = `保存失败：${error.message}`;
            }
        });

        previousCleanupBtn.addEventListener('click', async () => {
            cleanupResultTotal.textContent = '正在预览...';
            try {
                const result = await apiFetch('/api/admin/cleanup/run', {method: 'POST', body: JSON.stringify({dryRun: true})});
                renderCleanupResult(result);
            } catch (error) {
                cleanupResultTotal.textContent = `获取失败：${error.message}`;
            }
        });

        runCleanupBtn.addEventListener('click', async () => {
            const confirmed = await confirmAction('将按当前保留策略永久删除国企数据，并尝试回收 SQLite 空间，建议先点击”预览清理“', {
                title: '立即清理过期数据',
                confirmText: '确认清理',
                tone: 'danger',
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

        load().catch((error) => {
        cleanupSchedulerDetail.textContent = error.message;
        });
    }

        function createAttendanceApp() {
            const attendanceYearSelect = document.getElementById('attendanceYearSelect');
            const attendanceMonthSelect = document.getElementById('attendanceMonthSelect');
            const holidaySummary = document.getElementById('holidaySummary');
            const smartScheduleBtn = document.getElementById('smartScheduleBtn');
            const smartStrategySelect = document.getElementById('smartStrategySelect');
            const smartStrategyHint = document.getElementById('smartStrategyHint');
            const includePastToggle = document.getElementById('includePastToggle');
            const showRulesToggle = document.getElementById('showRulesToggle');
            const showRulesText = document.getElementById('showRulesText');
            const attendanceWorkspace = document.getElementById('attendanceWorkspace');
            const rulesPanel = document.getElementById('rulesPanel');
            const calendarGrid = document.getElementById('calendarGrid');
            const template = document.getElementById('datCardTemplate');
            const confirmDialog = document.getElementById('confirmDialog');
            const confirmDialogTitle = document.getElementById('confirmDialogTitle');
            const confirmDialogMessage = document.getElementById('confirmDialogMessage');
            const confirmDialogClose = document.getElementById('confirmDialogClose');
            const confirmDialogCancel = document.getElementById('confirmDialogCancel');
            const confirmDialogConfirm = document.getElementById('confirmDialogConfirm');

            const statusCard = document.getElementById('statusCard');
            const statusText = document.getElementById('statusText');
            const statusDetail = document.getElementById('statusDetail');
            const requiredDays = document.getElementById('requiredDay');
            const officeDays = document.getElementById('officeDays');
            const remainingDays = document.getElementById('remainingDays');
            const attendanceRate = document.getElementById('attendanceRate');
            const denominatorText = document.getElementById('denominatorText');
            const attendanceRateToday = document.getElementById('attendanceRateToday');
            const denominatorToTodayText = document.getElementById('denominatorToTodayText');
            const formulaText = document.getElementById('formulaText');

            const state = {month: currentMonthValue(), targetRate: 60, selections: {}, summary: null, dayOverrides: [],
                holidayCountForYear: 0, workdayCountForYear: 0, smartSchedule: null, seatBookings: {} };

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
                rulesPanel.textContent = visible ? '显示' : '隐藏';
                rulesPanel.classList.toggle('hidden', !visible);
                attendanceWorkspace.classList.toggle('rules-hidden', !visible);
            }

            function closeConfirmDialog(confirmed) {
                closeSharedConfirmDialog(confirmed);
            }

            function confirmBulkAction(message, options = {}) {
                return confirmAction(message, options);
            }

            function includePastDates() {
                return Boolean(window.includePastToggle && window.includePastToggle.checked);
            }

            function scheduleScopeText() {
                // 这里的文案必须雨后端 `filter_adjustable_dates` 保持一致
                // 未勾选表示严格的明天及之后，已勾选表示整个月
                return includePastDates() ? '整个月非手动选择日期' : '明天及之后的非手动选择日期'
            }

            function selectedStrategyLabel() {
                if (!smartStrategySelect) return;
                const option = smartStrategySelect.options[smartStrategySelect.selectedIndex];
                return option ? option.textContent : smartStrategySelect.value;
            }

            function updateSmartStrategyHint() {
                if (!smartStrategyMint) return;
                const recommendation = state.smartSchedule && typeof state.smartSchedule.recommendation;
                // 提示文案
                if (smartStrategySelect && smartStrategySelect.value === 'recommended' && recommendation) {
                    smartStrategyMint.textContent = `智能推荐：${recommendation.label}。${recommendation.reason} 当前范围：${scheduleScopeText()}。`;
                } else {
                    smartStrategyMint.textContent = `当前使用：${selectedStrategyLabel()}。范围：${scheduleScopeText()}，优先满足每周 ${state.targetRate}% 公司打卡。`;
                }
            }

            async function loadMonth() {
                holidaySummary.textContent = '正在读取登记与节假日...';
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
                const monthStartWeekday = days.length ? new Date(`${days[0].iso}T00:00:00`).getDay() : 1;
                const leadingBlanks = days.length ? (monthStartWeekday + 6) % 7 : 0;

                calendarGrid.innerHTML = '';
                for (let i = 0; i < leadingBlanks; i+=1) {
                    const blank = document.createElement('div');
                    blank.className = 'day-card empty';
                    calendarGrid.appendChild(blank);
                }

                days.forEach((day, index) => {
                    const node = template.content.firstElementChild.cloneNode(true);
                    const status = state.selections[day.iso];
                    node.dataset.date = day.iso;
                    node.style.animationDelay = `${Math.min(index * 12, 260)}ms`;
                    node.querySelector('.day-number').textContent = day.day;
                    node.querySelector('.day-name').textContent = day.weekdayName;
                    node.querySelector('.day-reason').textContent = day.reason || day.iso;
                    const seat = state.seatBookings[day.iso];
                    const seatNode = node.querySelector('.day-seat');
                    if (seat && seatNode) {
                        seatNode.textContent = `座位 ${seat.seatName || seat.seatId}`;
                        seatNode.classList.remove('hidden');
                    }

                    if (!day.selectable) {
                        node.classList.add('locked');
                        node.querySelector('.day-reason').textContent = `${day.iso} - ${day.reason}`;
                        node.querySelectorAll('button').forEach((button) => {
                            button.disabled = true;
                            button.setAttribute('aria-disabled', 'true');
                        });
                    } else if (status) {
                        node.classList.add('active');
                    }

                    node.querySelectorAll('button').forEach((button) => {
                        const buttonStatus = button.dataset.status;
                        button.setAttribute('aria-pressed', String(status === buttonStatus));
                        if (status === buttonStatus) button.classList.add('active');
                        button.addEventListener('click', async () => {
                            const nextStatus = status.selections[day.iso] === buttonStatus ? null : buttonStatus;
                            await apiFetch('/api/attendance', {
                                method: 'PUT',
                                body: JSON.stringify({date: day.iso, status: nextStatus})
                            });
                            loadMonth();
                        });
                    });

                    calendarGrid.appendChild(node);
                });

                const result = state.summary || {
                    denominator:0,
                    requiredOfficeDays:0,
                    officeDays:0,
                    homeDays:0,
                    leaveDays:0,
                    unselectedDays:0,
                    attendanceRate:0,
                    remainingDays:0,
                    passed: true,
                    toToday:{
                        denominator:0,
                        requiredOfficeDays:0,
                        officeDays:0,
                        homeDays:0,
                        leaveDays:0,
                        unselectedDays:0,
                        attendanceRate:0,
                        remainingDays:0,
                        passed: true,
                    }
                };
                // 出勤计算完全以后端 summary 为准，前端只负责格式化权威字段，避免整月和截至今日
                // 两种出勤率与 API 行为发生偏差。
                statusCard.classList.toggle('pass', result.passed);
                statusCard.classList.toggle('fail', !result.passed && result.denominator > 0);
                statusText.textContent = result.passed ? '已达标' : '未达标';
                statusDetail.textContent = result.denominator === 0
                    ? '本月暂无可统计工作日'
                    : result.passed
                        ? `已超过最低要求 ${result.officeDays - result.requiredOfficeDays} 天`
                        : `还需公司打卡 ${result / remainingDays} 天`;
                requiredDays.textContent = result.requiredOfficeDays
                officeDays.textContent = result.officeDays
                remainingDays.textContent = result.remainingDays
                const ratePercentText = `${Math.round(result.attendanceRate * 1000) / 10}%`;
                // `summary.toToday` 与整月出勤率使用同一公式，但会从分母中移除未来日期
                // 这样用户查看进度时，不会被未来未选择工作日拉低指标
                const toToday = result.toToday || {denominator: 0, officeDays: 0, homeDays: 0, leaveDays: 0, attendanceRate: 0,
                    requiredOfficeDays: 0};
                const rateToTodayText = `${Math.round(toToday.attendanceRate * 1000) / 10}%`;
                const targetRate = Number(state.targetRate) || 0;
                attendanceRate.textContent = ratePercentText;
                attendanceRateToday.textContent = rateToTodayText;
                denominatorText.textContent = `分母 ${result.denominator} 天（含居家 ${result.homeDays} 天，未选 ${result.unselectedDays} 天，
                请假 ${result.leaveDays} 天已排除，不含周末/休息日）`;
                denominatorToTodayText.textContent = `截至今日分母 ${toToday.denominator} 天（含居家 ${toToday.homeDays} 天，未选 ${toToday.unselectedDays} 
                天，请假 ${toToday.leaveDays} 天已排除。`;
                formulaText.textContent = [
                    `整月出勤率 = 整月公司打卡天数 ÷ 整月应统计工作日 = ${result.officeDays} ÷ ${result.denominator} = ${ratePercentText}`,
                    `截至今日出勤率 = 截至今日公司打卡天数 ÷ 截至今日应统计工作日 = ${toToday.officeDays} ÷ ${toToday.denominator} = ${rateToTodayText}`,
                    `达标线 = ceil(应统计工作日 × 目标出勤率) = ceil(${result.denominator} × ${targetRate}%) = ${result.requiredOfficeDays} 天`,
                    '分母包含：公司打卡、居家帮、未选的可统计工作日，请假按休息日处理，不计入坟墓；分子只包含公司打卡。'
                ].join('\n');
                const monthHolidayCount = state.dayOverrides.filter((item) => item.isHoliday !== false).length;
                const monthWorkdayCOunt = state.dayOverrides.filter((item) => item.isHoliday === false).length;
                holidaySummary.textContent = `${monthValue.slice(0, 4)} 年休息日 ${state.holidayCountForYear} 天，补班日 ${state.workdayCountForYear} 天，
                本月休息 ${monthHolidayCount} 天，补班 ${monthWorkdayCOunt} 天`;
                updateSmartStrategyHint();
            }

            async function init(){
                await requireUser();
                setSelectedMonth(currentMonthValue());
                applyRulesVisibility(readShowRulesPreference());
                await loadMonth();
        }

            attendanceYearSelect.addEventListener('change', loadMonth);
            attendanceMonthSelect.addEventListener('change', loadMonth);

            showRulesToggle.addEventListener('change', () => {
                    const visible = showRulesToggle.checked;
                    applyRulesVisibility(visible);
                    try {
                        localStorage.setItem(SHOW_RULES_STORAGE_KEY, String(visible));
                    } catch (error) {
                        // 隐私模式或受限环境可能禁用 localStorage，失败时忽略即可。
                    }
                });

                smartScheduleBtn.addEventListener('click', async () => {
                    const strategy =smartStrategySelect ? smartStrategySelect.value : 'weekly-balaned';
                    const includePast = includePast;
                    // 智能排班不会覆盖手动选择，只会在当前日期范围内重新生成 bulk/smart 记录
                    if (!(await confirmAction(`将被⌈${selectedStrategyLabel()}⌋ 对 ${selectedMonthValue()} 中 ${scheduleScopeText()}进行智能排班，不会覆盖你手动选择的日期，是否继续？`,
                        {title: '确认智能排班', confirmText: '开始排班', tone: 'primary'}))) return;
                    smartScheduleBtn.disabled = true;
                    holidaySummary.textContent = '正在智能分配公司打卡和居家帮...';
                    try {
                        const data = await apiFetch('/api/attendance/smart-schedule', {
                            method: 'POST',
                            body: JSON.stringify({month: selectedMonthValue(), strategy, includePast}),
                        });
                        await loadMonth();
                        const recommendationCount = Array.isArray(data.recommendation) ? data.recommendation.length : 0;
                        const recommendationText = recommendationCount ? `，算法推荐 ${recommendationCount} 个工作日` :'';
                        holidaySummary.textContent = `智能排班完成，使用⌈${data.strategyLabel}⌋ ${recommendationText}，${data.weeklyPlan.length} 个周数已尽量满足每周 ${state.targetRate}% 公司打卡。`;
                    } finally {
                        smartScheduleBtn.disabled = false;
                    }
                });

                document.querySelectorAll('[data-bulk]').forEach(button => {
                    button.addEventListener('click', async () => {
                        const action = button.dataset.bulk;
                        // 清空是“手动保护”的例外，它回删除范围内所有的选择，包括手动选择。
                        // 因此确认文案必须明确说明这个差异。
                        const message = action === 'clear'
                            ? `将清空 ${selectedMonthValue()} 中${scheduleScopeText()}的登记，包括手动选择，是否继续？`
                            : `将把 ${selectedMonthValue()} 中${scheduleScopeText()}设为公司打卡；不会覆盖你手动选择的日期，是否继续？`;
                        if (!await confirmBulkAction(message,{title: action==='clear' ? '确认清空选择' : '确认批量设置',confirmText:action ==='clear' ? '确认清空': '确认设置',
                            tone:action === 'clear' ? 'danger' : 'primary'})) return;
                        await apiFetch('/api/attendance/bulk', {
                            method: 'POST',
                            body: JSON.stringify({month: selectedMonthValue(),status: action === 'clear'?null:action,includePast:includePastDates()}),
                        });
                        await loadMonth();
                    });
                });
                if(smartStrategySelect) smartStrategySelect.addEventListener('change', updateSmartStrategyHint);
                if(includePastToggle) includePastToggle.addEventListener('change', updateSmartStrategyHint);
                if(confirmDialog && confirmDialogCancel && confirmDialogClose && confirmDialogConfirm) {
                    confirmDialogCancel().addEventListener('click', () => confirmDialog(false));
                    confirmDialogClose().addEventListener('click', () => confirmDialog(false));
                    confirmDialogConfirm().addEventListener('click', () => confirmDialog(true));
                    confirmDialog.addEventListener('click', (event) => {
                        if (event.target === confirmDialogCancel) confirmDialog(false)
                    });
                    document.addEventListener('keydown', (event) => {
                        if (confirmDialog.classList.contains('hidden')) return;
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            closeConfirmDialog(false);
                            return;
                        }
                        if (event.key !== 'Tab') return;
                        const focusable = [confirmDialogClose, confirmDialogCancel, confirmDialogConfirm].filter((node) => !node.disabled);
                        const first = focusable[0];
                        const last = focusable[focusable.length - 1];
                        if (event.shiftKey && document.activeElement === first) {
                            event.preventDefault();
                            last.focus();
                        } else if (!event.shiftKey && document.activeElement === last) {
                            event.preventDefault();
                            first.focus();
                        }
                    });
}

                    init().catch(error => {
                        holidaySummary.textContent = error.message;
                    });
                }

                function initGuideWidget() {
                    const guideFab = document.getElementById('guideFab');
                    const guidePanel = document.getElementById('guidePanel');
                    const closeGuideBtn = document.getElementById('closeGuideBtn');
                    if (!guideFab || !guidePanel || !closeGuideBtn) return;

                    function setGuideOpen(open) {
                        // 设置界面设置进行引导可见性，并将开关设置为扩展。
                        // 移到关闭按钮，让键盘用户立即能获得上下文
                        guidePanel.classList.toggle('hidden', !open);
                        guideFab.setAttribute('aria-expanded', String(open));
                        if (open) closeGuideBtn.focus();
                    }

                    guideFab.addEventListener('click', () => setGuideOpen(guidePanel.classList.contains('hidden')));
                    closeGuideBtn.addEventListener('click', () => setGuideOpen(false));
                    document.addEventListener('keydown', (event) => {
                        if (event.key === 'Escape' && !guidePanel.classList.contains('hidden')) setGuideOpen(false);
                    });
        }


        function createHolidayApp() {
            const yearInput = document.getElementById('yearInput');
            const holidayStatus = document.getElementById('holidayStatus');
            const holidayCount = document.getElementById('holidayCount');
            const workdayCount = document.getElementById('workdayCount');
            const holidayMeta = document.getElementById('holidayMeta');
            const holidayCalendar = document.getElementById('holidayCalendar');
            const fetchHolidayBtn = document.getElementById('fetchHolidayBtn');
            const sourceUserSelect = document.getElementById('sourceUserSelect');
            const copyHolidayBtn = document.getElementById('copyHolidayBtn');
            const selectedDateLabel = document.getElementById('selectedDateLabel');
            const dayTypeSelect = document.getElementById('dayTypeSelect');
            const dayNameInput = document.getElementById('dayNameInput');
            const saveDayBtn = document.getElementById('saveDayBtn');
            const state = {year: currentYearValue(), calendar: [], holidays: [], selected: null};

            async function loadYear() {
                state.year = Number(yearInput.value) || currentYearValue();
                holidayStatus.textContent = `正在加载 ${state.year} 年完整日历...`;
                const data = await apiFetch(`/api/holidays?year=${state.year}`);
                state.calendar = data.calendar || [];
                state.holidays = data.holidays || [];
                state.workdays = data.workdays || [];
                holidayCount.textContent = state.holidays.length;
                workdayCount.textContent = state.workdays.length;
                holidayMeta.textContent = data.meta ? `${data.meta.source} · ${new Date(data.meta.updatedAt).toLocaleString('zh-CN')}` : '尚未同步';
                holidayStatus.textContent = `已加载 ${state.year} 年日历，点击任意日期可编辑。`;
                renderHolidayCalendar();
                await loadSourceUsers();
            }

            async function loadSourceUsers() {
                const data = await apiFetch(`/api/holiday/source-users?year=${state.year}`);
                sourceUserSelect.innerHTML = '';
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = data.user.length ? '请选择用户' : '暂无其他用户';
                sourceUserSelect.appendChild(placeholder);
                data.users.forEach((user) => {
                    const option = document.createElement('option');
                    option.value = String(user.id);
                    option.textContent = `${user.username} (${user.overdueCount} 条配置)`;
                    sourceUserSelect.appendChild(option);
                });
                copyHolidayBtn.disabled = data.users.length === 0;
            }

            function renderHolidayCalendar() {
                holidayCalendar.innerHTML = '';
                state.calendar.forEach((month) => {
                    const section = document.createElement('section');
                    section.className = 'month-panel';
                    const header = document.createElement('h3');
                    header.textContent = month.label;
                    const grid = document.createElement('div');
                    grid.className = 'month-grid';
                    MONDAY_FIRST_LABELS.forEach(label => {
                        const cell = document.createElement('span');
                        cell.className = 'month-weekday';
                        cell.textContent = label;
                        grid.appendChild(cell);
                    });
                    const leading = month.days.length ? month.days[0].weekday - 1 : 0;
                    for (let i = 0; i < leading; i+=1) {
                        const blank = document.createElement('span');
                        blank.className = 'month-day blank';
                        grid.appendChild(blank);
                    }
                    month.days.forEach((day) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'month-day';
                        if (day.isWeekend) button.classList.add('weekend');
                        if (day.isHoliday) button.classList.add('holiday');
                        if (day.isWorkdayOverride) button.classList.add('workday');
                        if (state.selected && state.selected.date === day.date) button.classList.add('selected');
                        const dayNumber = document.createElement('strong');
                        dayNumber.textContent = day.day;
                        button.appendChild(dayNumber);
                        if (day.name) {
                            const dayName = document.createElement('small');
                            dayName.textContent = day.name;
                            dayName.title = day.name;
                            button.title = `${day.date} · ${day.name}`;
                            button.appendChild(dayName);
                        }
                        button.addEventListener('click', () => selectDay(day));
                        grid.appendChild(button);
                    });
                    section.appendChild(header);
                    section.appendChild(grid);
                    holidayCalendar.appendChild(section);
                });
            }

            function selectDay(day) {
                state.selected = Object.assign({}, day);
                selectedDateLabel.textContent = `${day.date} - ${day.isWeekend ? '周末' : '工作日'}`;
                dayTypeSelect.value = day.dayType || (day.isHoliday ? 'holiday' : day.isWorkdayOverride ? 'workday' : 'normal');
                dayNameInput.value = day.name || '';
                renderHolidayCalendar();
            }

            async function init() {
                await requireUser();
                populateYearSelect(yearInput, currentYearValue());
                await loadYear();
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
                    holidayMeta.textContent = data.meta ? `${data.meta?.source} - ${new Date(data.meta.updatedAt).toLocaleString('zh-CN')}` : '已同步';
                    holidayStatus.textContent = `同步完成：${state.holidays.length} 天节假日。`;
                    renderHolidayCalendar();
                    await loadSourceUsers();
                } finally {
                    fetchHolidayBtn.disabled = false;
                }
            });
            copyHolidayBtn.addEventListener('click', async () => {
                if (!sourceUserSelect.value) {
                    holidayStatus.textContent = '请先选择一个源用户。';
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
                    holidayMeta.textContent = data.meta ? `${data.meta?.source} - ${new Date(data.meta.updatedAt).toLocaleString('zh-CN')}` : '已同步';
                    holidayStatus.textContent = `已同步所选用户配置，共 ${data.copied} 条。`;
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
                    method: 'PATCH',
                    body: JSON.stringify({
                        date: state.selected.date,
                        dayType: dayTypeSelect.value,
                        name: dayNameInput.value.trim(),
                    })
                });
                holidayStatus.textContent = `${state.selected.date} 已保存。`;
                await loadYear();
            });

            init().catch((error) => {
                holidayStatus.textContent = error.message;
            });
        }

        function createApiDocsApp() {
            const endpointList = document.getElementById('endpointlist');
            const apiDocsStatus = document.getElementById('apiDocsStatus');
            const methodSelect = document.getElementById('apiMethodSelect');
            const pathInput = document.getElementById('apiPathInput');
            const bodyInput = document.getElementById('apiBodyInput');
            const sendCustomBtn = document.getElementById('sendCustomApiBtn');
            const customResponse = document.getElementById('customApiResponse');

            const endpoints = [
                {method: 'GET', path: '/api/me', title: '当前用户', description: '读取当前登录用户。'},
                {method: 'GET', path: '/api/settings', title: '读取目标出勤率', description: '读取当前用户目标出勤率。'},
                {method: 'PUT', path: '/api/settings', title: '更新目标出勤率', description: '保存当前用户目标出勤率。', body: {targetRate: 60}},
                {method: 'GET', path: '/api/attendance/descmonth=2026-07', title: '读取月度出勤', description:'返回登记、节假日覆盖与后端权威 summary：summary 同时包含整月出勤率和截至今日出勤率。'},
                {method: 'PUT', path: '/api/attendance', title: '保存单日登记', description: 'status 可为 office/home/leave; 传 null 表示清空。', body: {date: '2026-07-01', status: 'office'}},
                {method: 'POST', path: '/api/attendance/bulk', title: '批量登记', description: '默认只批量设置明天及之后的非手动选择工作日。includePast=true 时包含过去日期和今天。', body: {month: '2026-07', status: 'office', includePast: false}},
                {method: 'POST', path: '/api/attendance/smart-schedule', title: '智能排班', description: '默认只排明天及之后; 按所选星期组合会尽量满足每周目标公司打卡比例。', body: {month: '2026-07', strategy: 'recommended', includePast: false}},
                {method: 'GET', path: '/api/holidays/year=2026', title: '读取年度节假日', description: '返回已休息日、补班日、叠加规则和完整年度日历。'},
                {method: 'POST', path: '/api/holidays/sync', title: '同步官方节假日', description: '自动获取指定年份中国节假日与补班信息。', body: {year: 2026}},
                {method: 'PATCH', path: '/api/holidays', title:'调整单日类型', description: 'dayType 可为 normal/holiday/workday', body: {date: '2026-07-01', dayType: 'holiday', name: '公司假期'}},
                {method: 'GET', path: '/api/holiday-source/users?year=2026',title: '可同步用户列表', description: '列出指定年份可作为节假日配置来源的其他用户。'},
                {method: 'POST', path: '/api/holidays/copy', title: '同步其他用户配置', description: '将某用户某年的节假日配置复制到当前用户。', body: {year: 2026, sourceUserId: 1}},
                {method: 'GET', path: '/api/seat-booking', title: '读取座位预约配置', description: '读取外部平台账号状态、预约日期、首选座位和执行记录。'},
                {
                    method: 'PUT',
                    path: '/api/seat-booking/settings',
                    title: '保存座位预约配置',
                    description: '保存外部平台账号、预约日期、座位、提前天数和定时开关。密码不会在读取接口返回。',
                    body: {externalUsername: 'username', externalPassword: 'password', bookingDate: '2026-07-10', preferredSeatId: 'A01', preferredSeatName: 'A01', bookingTime: '08:30', advanceDays: 3, enabled: true}
                },
                {method: 'POST', path: '/api/seat-booking/seats', title: '获取外部座位列表', description: '登录外部平台并读取指定日期座位列表。', body: {bookingDate: '2026-07-10'}},
                {method: 'POST', path: '/api/seat-booking/book', title: '立即预约座位', description: '使用已保存配置直接提交座位预约。', body: {bookingDate: '2026-07-10', seatId: 'A01', seatName: 'A01'}},
                {method: 'GET', path: '/api/seat-booking/scheduler', title: '座位预约调度状态', description: '查看 Flask 内置座位调度器的调度是否环境变量启动、是否运行以及最近一次检查结果。'},
                {method: 'GET', path: '/api/admin/cleanup', title: '管理员清理策略。',description: '管理员读取数据清理开关、保留周期和调度器状态'},
                {method: 'PUT', path: '/api/admin/cleanup', title: '更新清理策略。',description: '管理员读开启/关闭定时清理并调整保留月份。' ,body: {scheduledEnabled: true, attendanceRetentionMonths: 12, overtimeRetentionMonths: 12, seatBookingPlanRetentionMonths: 6, seatBookingRunRetentionMonths: 3}},
                {method: 'POST', path: '/api/admin/cleanup/run', title: '预览/执行清理', description: 'dryRun=true 仅预览; dryRun=false 执行清理。', body: {dryRun: true}},
                {method: 'GET', path: '/api/admin/users', title: '用户角色与页面权限', description: '管理员读取用户列表、角色和可访问页面。'},
                {method: 'PUT', path: '/api/admin/users/1', title: '更新用户权限', description: '管理员设置用户角色和可访问页面。', body: {role: 'user', accessiblePages: ['attendance', 'holidays', 'seat-booking']}},
                {method: 'PATCH', path: '/api/admin/users/1/status', title: '停用/启用用户', description: '管理员停用或启用用户，停用后用户无法登录，历史数据保留。', body: {isActive: false}},
                {method: 'DELETE', path: '/api/admin/users/1', title: '删除用户', description: '管理员永久删除用户及业务数据，执行前建议备份 SQLite。', body: {}},
                {method: 'POST', path: '/api/logout', title: '退出登录', description: '结束当前登录会话。', body: {}},
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
                <div class="endpoint-card__head">
                    <span class="api-method">${endpoint.method}</span>
                    <code>${endpoint.path}</code>
                </div>
                <h3>${endpoint.title}</h3>
                <p>${endpoint.description}</p>
                <textarea spellcheck="false" aria-label="${endpoint.title} 请求体">${endpoint.body ? formatJson(endpoint.body) : ''}</textarea>
                <div class="endpoint-actions">
                    <button type="button" data-action="send">发送</button>
                    <button type="button" data-action="fill">填入自定义请求</button>
                </div>
                <pre class="api-response" aria-live="polite">尚未发送</pre>
            `;
                    const requestBody = card.querySelector('textarea');
                    const responseOutput = card.querySelector('.api-response');
                    card.querySelector('[data-action="send"]').addEventListener('click', () => sendRequest(endpoint.method, endpoint.path, requestBody.value, responseOutput));
                    card.querySelector('[data-action="fill"]').addEventListener('click', () => fillCustomForm(endpoint));
                    endpointList.appendChild(card);
                });
            }

            async function init() {
                await requireUser();
                renderEndpoints();
                apiDocsStatus.textContent = `已加载 ${endpointList.children.length} 个接口。`;
                sendCustomBtn.addEventListener('click', () => sendRequest(methodSelect.value, pathInput.value.trim(), bodyInput.value, customResponse));
            }

            init().catch((error) => {
                apiDocsStatus.textContent = error.message;
            });
        }

        function createSeatBookingApp() {
            const form = document.getElementById('seatBookingForm');
            const usernameInput = document.getElementById('seatExternalUsername');
            const passwordInput = document.getElementById('seatExternalPassword');
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
            const calendarMonthSelect = document.getElementById('seatCalendarMonth');
            const prevMonthBtn = document.getElementById('seatPrevMonthBtn');
            const nextMonthBtn = document.getElementById('seatNextMonthBtn');
            const seatBookingGrid = document.getElementById('seatBookingGrid');
            const calendarGrid = document.getElementById('seatCalendarGrid');
            const calendarSummary = document.getElementById('seatCalendarSummary');
            const seatPickerInline = document.querySelector('.seat-picker-inline');
            const seatPickerCloseBtn = document.getElementById('seatPickerCloseBtn');
            const seatList = document.getElementById('seatList');
            const runList = document.getElementById('seatRunList');
            const runPanel = document.getElementById('seatRunPanel');
            const runLogVisibleInput = document.getElementById('seatRunlogVisible');
            let allSeats = [];
            let calendarSeatPlans = {};
            let selectedBookingDate = '';
            let seatPickerVisible = false;
            let seatListLoading = false;
            let seatListError = '';
            let calendarMonth = currentMonthValue();
            let seatBookingRefreshTimer = null;
            let seatBookingRefreshInFlight = false;

            function todayPlus(days) {
                const current = new Date();
                current.setDate(current.getDate() + days);
                return isoFromDate(current);
            }

            function addMonths(monthValue, delta) {
                const {year, month} = splitMonthYear(monthValue);
                const value = new Date(year, month - 1 + delta, 1);
                return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
            }

            function populateSeatCalendarMonths(selectMonth) {
                if (!calendarMonthSelect) return;
                const {year, month} = splitMonthYear(selectMonth);
                const canter = new Date(year, month - 1, 1);
                calendarMonthSelect.innerHTML = '';
                for (let offset = -12; offset <= 12; offset += 1) {
                    const value = new Date(canter.getFullYear(), canter.getMonth() + offset, 1);
                    const option = document.createElement('option');
                    option.value = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
                    option.textContent = `${value.getFullYear()} 年 ${value.getMonth() + 1} 月`;
                    calendarMonthSelect.appendChild(option);
                }
                calendarMonthSelect.value = selectMonth;
            }

            function selectBookingDate(isoDate, options = {}) {
                selectedBookingDate = isoDate;
                bookingDateInput.value = isoDate;
                if (options.jumpMonth !== false) calendarMonth = isoDate.slice(0,7);
                seatPickerVisible = options.showPicker !== false;
                seatListLoading = Boolean(options.loading);
                seatListError = '';
                allSeats = [];
                renderSeats();
                renderCalendar();
            }

            function firstBookingMonth(bookings) {
                const booking = (bookings || []).find((item)=> item && item.bookingDate);
                return booking ? String(booking.bookingDate?.slice(0,7)) : '';
            }

            function closeSeatPicker() {
                seatPickerVisible = false;
                seatListLoading = false;
                seatListError = '';
                allSeats = [];
                renderSeats();
                renderCalendar();
            }

            function renderCalendar() {
                if (!calendarGrid) return;
                populateSeatCalendarMonths(calendarMonth);
                const {year, month} = splitMonthYear(calendarMonth);
                const first = new Date(year, month - 1, 1);
                const leadingDays = (first.getDay() + 6) % 7;
                const start = new Date(year, month - 1, 1 - leadingDays);
                calendarGrid.innerHTML = '';
                for (let index = 0; index < 42; index += 1) {
                    const current = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
                    const iso = isoFromDate(current);
                    const monthValue = iso.slice(0, 7)
                    const cell = document.createElement('div');
                    cell.className = 'seat-calendar-cell';
                    cell.classList.toggle('has-picker', seatPickerVisible && iso === selectedBookingDate);
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'seat-calendar-day';
                    const bookedSeat = calendarSeatPlans[iso];
                    const pastDate = isPastIsoDate(iso);
                    const pastCurrentWeekBooking = Boolean(bookedSeat) && isPastDateIncurrentWeek(iso);
                    button.classList.toggle('outside', monthValue !== calendarMonth);
                    button.classList.toggle('selected', iso === selectedBookingDate);
                    button.classList.toggle('booked', Boolean(bookedSeat));
                    button.classList.toggle('past-booking', Boolean(bookedSeat) && pastDate);
                    button.classList.toggle('past-current-week-booking', pastCurrentWeekBooking);
                    button.disabled = pastDate;
                    button.title = pastCurrentWeekBooking ? '本周已过去的预约记录可取消，但不能重新预约' : '';
                    button.innerHTML = `<strong>${current.getDay()}</strong>><small>${monthValue !== calendarMonth ? monthValue : WEEKDAY_NAMES[current.getDay()]}{</small>${bookedSeat ?
                        `<span class="seat-calendar-seat ${bookedSeat.status || 'pending'}">${escapeHtml(bookedSeat.seatName || bookedSeat.seatId)} · ${bookedSeat.status === 'success' ?
                            '成功' : '预约中'}</span>` : ''}`;
                    button.addEventListener('click', async () => {
                        if (button.disabled) return;
                        if (monthValue !== calendarMonth) calendarMonth = monthValue;
                        selectBookingDate(iso, {leading: true});
                        await fetchSeatsForSelectedDate()
                    });
                    cell.appendChild(button)
                    if (button) {
                        const actions = document.createElement('div');
                        action.className = 'seat-calendar-actions';
                        if (bookedSeat.status !== 'success') {
                            const bookNow = document.createElement('button');
                            bookNow.type = 'button';
                            bookNow.className = 'seat-calendar-direct primary-button';
                            bookNow.textContent = '立即预约';
                            bookNow.disabled = !isDirectBookingDate(iso);
                            bookNow.title = bookNow.disabled ? '座位预约只能选择明天第7天后的日期' : '提交到外部平台';
                            bookNow.addEventListener('click', async (event) => {
                                event.stopPropagation();
                                await submitDirectBooking(iso, bookedSeat.seatId, bookedSeat.seatName);
                            });
                            actions.appendChild(bookNow);
                        }
                        const cancel = document.createElement('button');
                        cancel.type = 'button';
                        cancel.className = 'seat-calendar-cancel danger-button';
                        cancel.textContent = bookedSeat.cancel.status === 'success' ? '取消预约' : '取消计划';
                        cancel.addEventListener('click', async (event) => {
                            event.stopPropagation();
                            const confirmText = bookedSeat.status === 'success' ? `确认取消 ${iso} 的已成功座位预约吗？将同步提交到外部平台。` : `确认取消 ${iso} 的预约计划吗？`;
                            if (!await confirmAction(confirmText, {title: bookedSeat.status === 'success' ? '确认取消预约' : '确认取消计划', confirmText: '确认取消', tone: 'danger'})) return;
                            await apiFetch(`api/seat-booking/plans?date=${encodeURIComponent(iso)}`, {method: "DELETE"});
                            await refreshSeatBookingMonth();
                            statusText.textContent = `${iso} 的座位预约已取消。`;
                        });
                        action.appendChild(cancel);
                        cell.appendChild(actions);
                    }
                    if (seatPickerVisible && iso === selectedBookingDate && seatPickerInline) {
                        cell.appendChild(seatPickerInline);
                    }
                    calendarGrid.appendChild(cell);
                }
                if (calendarSummary) {
                    const advanceDays = Number(advanceDaysInput.value || 0);
                    calendarSummary.textContent = selectedBookingDate
                        ? `已选择 ${selectedBookingDate}，将在提前 ${advanceDays.value || 3} 天 ${(bookingTimeInput.value || "08:30")} 尝试预约。`
                        : `请选择预约日期。`;
                }
            }

            function readPayload(includePassword){
                const payload = {
                    externalUsername: usernameInput.value.trim(),
                    bookingDate: selectedBookingDate || bookingDateInput.value,
                    bookingTime: bookingTimeInput.value || "08:30",
                    advanceDays: Number(advanceDaysInput.value || 0),
                    enabled: enabledInput.checked,
                };
                if (includePassword && passwordInput.value) payload.externalPassword = passwordInput.value;
                return payload
            }

            function fillSettings(settings, options = {}) {
                usernameInput.value = settings.externalUsername || "";
                passwordInput.placeholder = settings.hasPassword ? "已保存密码，此处表示不修改" : "请输入外部平台密码";
                selectedBookingDate = settings.bookingDate || todayPlus(3);
                if (!options.presservePicker) seatPickerVisible = false;
                bookingDateInput.value = selectedBookingDate;
                calendarMonth = selectedBookingDate.slice(0,7);
                bookingTimeInput.value = settings.bookingTime || '08:30';
                advanceDaysInput.value = String(Math.max(0,Math.min(7,Number(settings.advanceDays || 0))));
                enabledInput.checked = Boolean(settings.enabled);
                const badge = document.getElementById('seatBookingBadge');
                badge.textContent = settings.enabled ? `已启用 ${settings.bookingTime || '08:30'}` : '未启用';
                renderCalendar();
            }

            function escapeHtml(value) {
                return String(value).replace(/[&<>"]/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char]));
            }

            function renderSchedulerStatus(scheduler) {
                if (!schedulerStatus) return;
                const enabledText = scheduler.enabled || scheduler.anyEnabled ? "内置调度器已启用" : "内置调度器未启用";
                const runningText = scheduler.running ? "运行中" : "未运行";
                const intervalText = scheduler.intervalSeconds ? `每${scheduler.intervalSeconds}秒检查一次` : "未配置检查间隔";
                schedulerStatus.textContent = `${enabledText}｜${runningText}｜${intervalText}｜${scheduler.lastMessage || ""}`;
            }

            function filterSeats(seats) {
                const keyword= (seatFilterInput && seatFilterInput.value.trim().toLowerCase()) || '';
                return seats.filter((seat) => {
                    const text = `${seat.id || ''} ${seat.name || ''}`.toLowerCase();
                    return !keyword || text.includes(keyword);
                });
            }

            function renderSeats() { // 1783771351983
                const seats = filterSeats();
                seatList.innerHTML = '';
                if (seatListLoading) {
                    if(seatFilterSummary) seatFilterSummary.textContent = `正在加载 ${selectedBookingDate || ''} 的座位...`;
                    seatList.innerHTML = '<p class="empty-note">正在加载座位列表，请稍后...</p>';
                    return;
                }
                if (seatListError) {
                    if(seatFilterSummary) seatFilterSummary.textContent = '座位加载失败';
                    seatList.innerHTML = `<p class="empty-note">获取座位失败，${escapeHtml(seatListError)}</p>`;
                    return;
                }
                if(seatFilterSummary) seatFilterSummary.textContent = `显示 ${seats.length} / ${allSeats.length} 个座位`;
                if (!seats.length) {
                    seatList.innerHTML = `<p class="empty-note">暂无匹配座位，请调整筛选条件，或确认账号、日期和内网访问是否可用。</p>`;
                    return;
                }
                seats.forEach((seat) => {
                    const card = document.createElement('article');
                    card.className = 'seat-card';
                    card.innerHTML = `
                <div>
                    <strong>${escapeHtml(seat.name || seat.id)}</strong>
                    <small>ID：${escapeHtml(seat.id)}${seat.available ? '' : ' - 可能不可用'}</small>
                </div>
                <div class="seat-card-actions">
                    <button type="button" data-action="plan" ${seat.available  ? '' : 'disabled'  }>保存计划</button>
                    <button type="button" class="primary-button" data-action="direct" ${seat.available && isDirectBookingDate(selectedBookingDate) ? '' : 'disabled'}>更新预约</button>
                </div>
            `;
                    card.querySelector('[data-action="plan"]').addEventListener('click', async () => {
                        if (!selectedBookingDate) return;
                        const data =  apiFetch('/api/seat-booking/plan', {
                            method: 'PUT',
                            body: JSON.stringify({bookingDate: selectedBookingDate, seatId: seat.id, seatName: seat.name || seat.id}),
                        });
                        calendarSeatPlans = data.plans || calendarSeatPlans;
                        renderCalendar();
                        statusText.textContent = `${selectedBookingDate} 已确认预约座位 ${seat.name || seat.id}。`;
                    });
                    card.querySelector('[data-action="direct"]').addEventListener('click', async () => {
                        if (!selectedBookingDate) return;
                        await submitDirectBooking(selectedBookingDate, seat.id, seat.name || seat.id);
                    });
                    seatList.appendChild(card);
                });
            }

            function renderRuns(runs) {
                runList.innerHTML = '';
                if (!runs.length) {
                    runList.innerHTML = '<p class="empty-note">暂无执行记录。</p>';
                    return;
                }
                runs.forEach((run) => {
                    const card = document.createElement('article');
                    card.className = `seat-run-card ${run.status || ''}`;
                    card.innerHTML = `
                <strong>${run.bookingDate} - ${run.seatName || run.seatId || '未指定座位'}</strong>
                <small>${run.runAt || ''} - ${run.status}</small>
                <p class="ampty-note">${run.message || '—'}</p>
            `;
                    runList.appendChild(card);
                });
            }

            function updateRunLogVisibility() {
                if(!runPanel || !runLogVisibleInput) return;
                const visible = runLogVisibleInput.checked;
                runLog.hidden = !visible;
                runLogVisibleInput.setAttribute('aria-expanded', String(visible));
                if (seatBookingGrid) seatBookingGrid.classList.toggle('logs-hidden', !visible);
            }

            async function loadSeatBooking(options = {}){  {
                const monthQuery = options.month ? `?month=${encodeURIComponent(options.month)}` : "";
                const data = await apiFetch( `/api/seat-booking${monthQuery}`);
                if (!options.preserveSettings) fillSettings( data.settings || {}, {preservePicker: options.preservePicker});
                calendarSeatPlans = data.plans || data.seatBookings || {};
                renderCalendar();
                renderRuns(  data.runs || []);
                renderSchedulerStatus(  data.scheduler || {});
                if (options.updateStatus !== false) statusText.textContent = '座位预约配置已加载。';
                return data;
            }

            async function refreshSeatBookingMonth() {
                return loadSeatBooking( {month: calendarMonth, preserveSettings: true, preservePicker: true, updateStatus: false});
            }

            async function refreshSeatBookingSilently() {
                if (seatBookingRefreshInFlight || document.hidden) return;
                seatBookingRefreshInFlight = true;
                try {
                    await refreshSeatBookingMonth();
                } catch (error) {
                    renderSchedulerStatus( {lastMessage: `自动刷新失败: ${error.message}`});
                } finally {
                    seatBookingRefreshInFlight = false;
                }
            }

            function startSeatBookingAutoRefresh() {
                if (seatBookingRefreshTimer) window.clearInterval(seatBookingRefreshTimer);
                seatBookingRefreshTimer = window.setInterval(refreshSeatBookingSilently, SEAT_BOOKING_REFRESH_INTERVAL_MS);
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) refreshSeatBookingSilently();
                });
                window.addEventListener('pagehide', () => {
                    if (seatBookingRefreshTimer) window.clearInterval(seatBookingRefreshTimer);
                });
            }

            async function fetchSeatsForSelectedDate() {
                if (!selectedBookingDate) return;
                if (isPastIsoDate(selectedBookingDate)) {
                    statusText.textContent = '不支持预约当前日期之前的座位。';
                    return;
                }
                statusText.textContent = `正在获取 ${selectedBookingDate} 的座位列表...`;
                seatPickerVisible = true;
                seatListLoading = true;
                renderSeats();
                renderCalendar();
                try {
                    await saveSettings( false, {preservePicker: true});
                    const data = await apiFetch('/api/seat-booking/seats', {
                        method: 'POST',
                        body: JSON.stringify({bookingDate: selectedBookingDate}),
                    });
                    allSeats = data.seats || [];
                    seatListError = '';
                    statusText.textContent = data.message || `已读取 ${allSeats.length} 个座位。`;
                } catch (error) {
                    allSeats = [];
                    seatListError = error.message;
                    statusText.textContent = `获取座位失败: ${error.message}`;
                } finally {
                    seatPickerVisible = true;
                    seatListLoading = false;
                    renderSeats();
                    renderCalendar();
                }
            }

            async function submitDirectBooking(bookingDate, seatId, seatName) {
                if (!isDirectBookingDate(bookingDate)) {
                    statusText.textContent = '直接预约只能选择明天至7天后的日期。';
                    return;
                }
                statusText.textContent = `正在直接预约 ${bookingDate} 的座位...`;
                const data = await apiFetch('/api/seat-booking/book', {
                    method: 'POST',
                    body: JSON.stringify({date: bookingDate, seatId, seatName}),
                });
                const message = data.run ? data.run.message : '预约请求已提交。';
                calendarMonth = bookingDate.slice(0, 7);
                statusText.textContent = message;
                try {
                    await refreshSeatBookingMonth();
                    statusText.textContent = message;
                } catch (error) {
                    statusText.textContent = `${message}：刷新当前页面状态失败: ${error.message}`;
                }
            }

            async function saveSettings(includePassword = false, callback = false, options = {}) {
                const data = await apiFetch('/api/seat-booking/settings', {
                    method: 'PUT',
                    body: JSON.stringify(readPayload(includePassword)),
                });
                fillSettings(data.settings || {}, options);
                statusText.textContent = `座位预约配置已保存。`;
            }

            async function init() {
                await requireUser();
                await loadSeatBooking();
                startSeatBookingAutoRefresh();
                if (seatPickerCloseBtn) seatPickerCloseBtn.addEventListener('click', closeSeatPicker);
                if (runLogVisibleInput) runLogVisibleInput.addEventListener('change', updateRunLogVisibility);
                updateRunLogVisibility();
                form.addEventListener('submit', async (event) => {
                    event.preventDefault();
                    await saveSettings(false);
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
                    syncSeatBookingsBtn.disabled = true;
                    statusText.textContent = '正在从外部平台同步预约记录...';
                    try {
                        const data = await apiFetch(`/api/seat-booking/sync?month=${encodeURIComponent(calendarMonth)}`, {method: 'POST', body: '{}'});
                        const syncedMonth = firstBookingMonth(data.bookings || []);
                        if (syncedMonth && syncedMonth !== calendarMonth && !Object.keys(data.plans || {}).length) {
                            calendarMonth = syncedMonth;
                            selectedBookingDate = (data.bookings || [])[0].bookingDate || selectedBookingDate;
                            seatPickerVisible = false;
                            bookingDateInput.value = selectedBookingDate;
                            const monthData = await apiFetch(`/api/seat-booking?month=${encodeURIComponent(calendarMonth)}`);
                            calendarSeatPlans = monthData.plans || monthData.seatBookings || {};
                            renderRuns(data.runs || []);
                        } else {
                            calendarSeatPlans = data.plans || calendarSeatPlans;
                            renderRuns(data.runs || []);
                        }
                        renderCalendar();
                        statusText.textContent = `同步完成，新增 ${data.synced || 0} 条，更新 ${data.updated || 0} 条。`;
                    } catch (error) {
                        statusText.textContent = `同步失败: ${error.message}`;
                    } finally {
                        syncSeatBookingsBtn.disabled = false;
                    }
                });
            }

        init().catch((error) => {
            statusText.textContent = error.message;
        });
    }

        function registerServiceWorker() {
            if (!('serviceWorker' in navigator)) return;
            window.addEventListener('load',  () => {
                navigator.serviceWorker.register('/service-worker.js', {scope:'/'}).catch(() => {
                    // 服务工作线程（Service Worker）除 localhost 外通常需要 HTTPS；普通 HTTP 部署注册失败时忽略。
                });
            });
        }

        const api = {
            STATUS,
            parseHolidayInput,
            buildMonthDays,
            mapTimerHolidayResponse,
            mapNagerHolidayResponse,
            fetchChinaHolidays,
            isPastIsoDate,
            isPastDateIncurrentWeek,
            isDirectBookingDate,
        };

        if (typeof module !== 'undefined' && module.exports) {
            module.exports = api;
        } else {
            global.AttendanceCalculator = api;
            registerServiceWorker();
            document.addEventListener('DOMContentLoaded', () => {
                initGuideWidget();
                if (document.body.dataset.page === 'login') createLoginApp();
                else if (document.body.dataset.page === 'api-docs') createApiDocsApp();
                else if (document.body.dataset.page === 'seat-booking') createSeatBookingApp();
                else if (document.body.dataset.page === 'admin') createAdminApp();
                else if (document.body.dataset.page === 'holidays') createHolidayApp();
                else createAttendanceApp();
            });
        }
})(typeof window !== 'undefined' ? window : globalThis);