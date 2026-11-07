/* MediCare shared front-end toolkit.
 * No inline scripts or inline event handlers are used anywhere (the server's Content-Security-Policy forbids them),
 * and every piece of server data inserted into HTML goes through esc() to prevent XSS. */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) =>
    String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ API
  const ROLE_BY_PAGE = { 'patient-dashboard.html': 'patient', 'doctor-dashboard.html': 'doctor', 'admin-dashboard.html': 'admin' };
  function sessionExpired() {
    const role = ROLE_BY_PAGE[location.pathname.split('/').pop()];
    if (role) location.href = `/login.html?role=${role}`;
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.form) init.body = opts.form; // multipart: browser sets the boundary header
    let res;
    try {
      res = await fetch('/api' + path, init);
    } catch (e) {
      throw new Error('Cannot reach the server. Please check your connection.');
    }
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
    if (res.status === 401 && !opts.noRedirect) sessionExpired();
    if (!res.ok) {
      const err = new Error((data && data.message) || 'Request failed. Please try again.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- toasts
  function toast(message, type = 'success') {
    let wrap = $('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = `toast-msg ${type}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), type === 'danger' ? 6000 : 3800);
  }
  const fail = (err) => toast(err && err.message ? err.message : 'Something went wrong.', 'danger');

  // ---------------------------------------------------------------- modals
  function showModal({ title, body, footer = '', size = '' }) {
    const wrap = document.createElement('div');
    wrap.className = 'modal fade';
    wrap.tabIndex = -1;
    wrap.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size}">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div></div>`;
    document.body.appendChild(wrap);
    // focus:false so third-party popups (Razorpay Checkout) can take keyboard focus.
    const bs = new bootstrap.Modal(wrap, { focus: false });
    wrap.addEventListener('hidden.bs.modal', () => { bs.dispose(); wrap.remove(); });
    bs.show();
    return { el: wrap, bs, hide: () => bs.hide(), setBody: (html) => { $('.modal-body', wrap).innerHTML = html; } };
  }

  function confirmDialog(message, { title = 'Please confirm', okText = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      let result = false;
      const m = showModal({
        title,
        body: `<p class="mb-0">${esc(message)}</p>`,
        footer: `<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
                 <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>`,
      });
      $('[data-ok]', m.el).addEventListener('click', () => { result = true; m.hide(); });
      m.el.addEventListener('hidden.bs.modal', () => resolve(result));
    });
  }

  /** Asks for a line of text (e.g. a cancellation reason). Resolves to the text, or null if dismissed. */
  function askText({ title, label, required = true, placeholder = '', okText = 'Submit', danger = false, maxLength = 200 }) {
    return new Promise((resolve) => {
      let result = null;
      const m = showModal({
        title,
        body: `<label class="form-label" for="askTextInput">${esc(label)}</label>
               <textarea id="askTextInput" class="form-control" rows="3" maxlength="${maxLength}" placeholder="${esc(placeholder)}"></textarea>
               <div class="invalid-feedback">Please enter a reason.</div>`,
        footer: `<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
                 <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>`,
      });
      const input = $('#askTextInput', m.el);
      m.el.addEventListener('shown.bs.modal', () => input.focus());
      $('[data-ok]', m.el).addEventListener('click', () => {
        const v = input.value.trim();
        if (required && v.length < 3) { input.classList.add('is-invalid'); return; }
        result = v;
        m.hide();
      });
      m.el.addEventListener('hidden.bs.modal', () => resolve(result));
    });
  }

  async function busy(btn, fn) {
    if (!btn) return fn();
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Please wait...';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
  }

  const formObj = (form) => Object.fromEntries(Array.from(new FormData(form)).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ------------------------------------------------------------ formatting
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  const fmtDate = (iso) => {
    if (!iso) return '-';
    return new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  };
  const fmtShortDate = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const fmtTime = (t) => {
    if (!t) return '-';
    const [h, m] = String(t).split(':').map(Number);
    return `${pad(h % 12 || 12)}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  };
  const fmtDateTime = (ts) => {
    if (!ts) return '-';
    const d = new Date(String(ts).replace(' ', 'T'));
    return isNaN(d) ? esc(ts) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const photoUrl = (p) => (p && /^\/uploads\/photos\/[a-f0-9]+\.(jpg|png)$/.test(p) ? p : '/assets/avatar.svg');
  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

  const STATUS_COLORS = { pending: 'warning text-dark', confirmed: 'primary', completed: 'success', cancelled: 'secondary', rejected: 'danger', success: 'success', failed: 'danger', refunded: 'info text-dark' };
  const badge = (status, label) => `<span class="badge bg-${STATUS_COLORS[status] || 'secondary'}">${esc(label || cap(status))}</span>`;
  const stars = (rating) => {
    if (rating === null || rating === undefined) return '<span class="text-secondary small">No ratings yet</span>';
    const r = Math.round(Number(rating));
    return `<span class="rating-stars" aria-label="${esc(rating)} out of 5">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span> <span class="small text-secondary">${esc(rating)}</span>`;
  };
  const emptyState = (icon, text) => `<div class="empty"><i class="bi ${esc(icon)}"></i>${esc(text)}</div>`;

  function pager(page, pageSize, total, action) {
    const pages = Math.max(Math.ceil(total / pageSize), 1);
    if (pages <= 1) return '';
    return `<nav class="d-flex justify-content-between align-items-center mt-3" aria-label="Pagination">
      <span class="small text-secondary">Page ${page} of ${pages} &middot; ${total} records</span>
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-primary" data-action="${esc(action)}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <button class="btn btn-outline-primary" data-action="${esc(action)}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button>
      </div></nav>`;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ($(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load a required script.'));
      document.head.appendChild(s);
    });
  }

  // ----------------------------------------------------------------- theme
  function applyThemeIcons() {
    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    $$('.theme-toggle').forEach((b) => { b.innerHTML = `<i class="bi ${dark ? 'bi-sun' : 'bi-moon-stars'}"></i>`; b.title = dark ? 'Switch to light mode' : 'Switch to dark mode'; });
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-bs-theme', next);
    try { localStorage.setItem('medicare-theme', next); } catch (e) { /* ignore */ }
    applyThemeIcons();
    document.dispatchEvent(new CustomEvent('themechange'));
  }
  document.addEventListener('click', (e) => { if (e.target.closest('.theme-toggle')) toggleTheme(); });
  document.addEventListener('DOMContentLoaded', applyThemeIcons);

  // ---------------------------------------------------------------- charts
  // Chart.js instances are tracked so they can be destroyed when the user navigates to another view.
  const activeCharts = [];
  function makeChart(canvas, config) {
    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    Chart.defaults.color = dark ? '#c9d1d9' : '#495057';
    Chart.defaults.borderColor = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    const c = new Chart(canvas, config);
    activeCharts.push(c);
    return c;
  }
  const destroyCharts = () => { while (activeCharts.length) activeCharts.pop().destroy(); };
  const CHART_COLORS = ['#0b5ed7', '#20c997', '#fd7e14', '#6f42c1', '#d63384', '#ffc107'];

  // -------------------------------------------------------- notifications
  const NOTIF_ICON = { appointment: 'bi-calendar-check', payment: 'bi-credit-card', reminder: 'bi-alarm', system: 'bi-info-circle' };
  async function refreshBell() {
    const el = $('#bellCount');
    if (!el) return;
    try {
      const d = await api('/notifications', { noRedirect: true });
      el.textContent = d.unread > 99 ? '99+' : d.unread;
      el.classList.toggle('d-none', d.unread === 0);
    } catch (e) { /* ignore */ }
  }
  async function renderNotifications(section) {
    const d = await api('/notifications');
    section.innerHTML = `<div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="h5 mb-0">Notifications</h2>
        <button class="btn btn-sm btn-outline-primary" id="markAllRead" ${d.unread ? '' : 'disabled'}>Mark all as read</button></div>
      ${d.notifications.length ? d.notifications.map((n) => `
        <div class="card-soft notif-item ${n.is_read ? '' : 'unread'} p-3 mb-2 d-flex gap-3" data-notif="${n.id}">
          <i class="bi ${NOTIF_ICON[n.type] || NOTIF_ICON.system} fs-4 text-brand"></i>
          <div class="flex-grow-1"><div class="fw-semibold">${esc(n.title)}</div>
            <div class="small">${esc(n.message)}</div>
            <div class="small text-secondary mt-1">${fmtDateTime(n.created_at)}</div></div></div>`).join('')
        : emptyState('bi-bell-slash', 'You have no notifications yet.')}`;
    const btn = $('#markAllRead', section);
    if (btn) btn.addEventListener('click', async () => {
      try { await api('/notifications/read-all', { method: 'POST' }); await renderNotifications(section); refreshBell(); } catch (e) { fail(e); }
    });
  }

  // ----------------------------------------------------- dashboard shell
  /** Sets up routing (#view-id), sidebar, user info, logout, theme and the notification bell. */
  function initShell({ role, views, defaultView }) {
    const container = $('#view');
    const titleEl = $('#viewTitle');
    const sidebar = $('#sidebar');
    const backdrop = $('#backdrop');
    const shell = { me: null, current: null };

    const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
    $('#menuBtn').addEventListener('click', () => { sidebar.classList.toggle('open'); backdrop.classList.toggle('show'); });
    backdrop.addEventListener('click', closeSidebar);

    async function go(id) {
      if (!views[id]) id = defaultView;
      shell.current = id;
      $$('.side-link').forEach((a) => a.classList.toggle('active', a.dataset.view === id));
      titleEl.textContent = views[id].title;
      closeSidebar();
      destroyCharts();
      // Each navigation renders into a fresh element, so a slow, stale render can never overwrite the current view.
      const section = document.createElement('div');
      section.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';
      container.replaceChildren(section);
      try {
        await views[id].render(section, shell);
      } catch (err) {
        section.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
      }
      window.scrollTo({ top: 0 });
    }
    shell.go = (id) => { if (location.hash === '#' + id) go(id); else location.hash = '#' + id; };
    shell.reload = () => go(shell.current);

    window.addEventListener('hashchange', () => go(location.hash.slice(1)));
    document.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-action="logout"]')) return;
      try { await api('/auth/logout', { method: 'POST', noRedirect: true }); } finally { location.href = `/login.html?role=${role}`; }
    });

    api('/auth/me').then((me) => {
      shell.me = me;
      $$('[data-me="name"]').forEach((el) => { el.textContent = me.name; });
    }).catch(() => {});
    api('/public/settings', { noRedirect: true }).then((s) => {
      $$('[data-setting]').forEach((el) => { if (s[el.dataset.setting]) el.textContent = s[el.dataset.setting]; });
      $$('[data-setting-tel]').forEach((el) => { if (s[el.dataset.settingTel]) el.href = 'tel:' + s[el.dataset.settingTel].replace(/[^0-9+]/g, ''); });
    }).catch(() => {});

    refreshBell();
    setInterval(refreshBell, 60000);
    go(location.hash.slice(1));
    return shell;
  }

  window.MC = {
    $, $$, esc, api, toast, fail, showModal, confirmDialog, askText, busy, formObj, debounce,
    todayISO, addDays, fmtDate, fmtShortDate, fmtTime, fmtDateTime, money, photoUrl, cap, badge, stars, emptyState,
    pager, loadScript, initShell, renderNotifications, refreshBell, makeChart, destroyCharts, CHART_COLORS,
  };
})();
