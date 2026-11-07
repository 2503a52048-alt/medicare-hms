/* Login for the three roles + forgot-password (OTP) flow. */
(function () {
  'use strict';
  const { $, $$, esc, api, toast, showModal, busy, formObj } = MC;

  const params = new URLSearchParams(location.search);
  let role = ['patient', 'doctor', 'admin'].includes(params.get('role')) ? params.get('role') : 'patient';
  const next = /^[a-z]{3,20}$/.test(params.get('next') || '') ? params.get('next') : '';

  const alertBox = $('#alertBox');
  const showAlert = (html, type = 'danger') => { alertBox.innerHTML = `<div class="alert alert-${type} py-2">${html}</div>`; };

  function setRole(r) {
    role = r;
    $$('#roleTabs [data-role]').forEach((b) => b.classList.toggle('active', b.dataset.role === r));
    $('#registerLine').classList.toggle('d-none', r !== 'patient');
    $('#staffNote').classList.toggle('d-none', r === 'patient');
    $('#identifier').placeholder = r === 'patient' ? 'you@example.com or 10-digit mobile' : 'Registered email address';
    alertBox.innerHTML = '';
  }
  $$('#roleTabs [data-role]').forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));
  setRole(role);

  $('#togglePw').addEventListener('click', () => {
    const pw = $('#password');
    pw.type = pw.type === 'password' ? 'text' : 'password';
    $('#togglePw i').className = pw.type === 'password' ? 'bi bi-eye' : 'bi bi-eye-slash';
  });

  // Already signed in? Go straight to the right dashboard.
  api('/auth/me', { noRedirect: true }).then((me) => {
    const to = { patient: '/patient-dashboard.html', doctor: '/doctor-dashboard.html', admin: '/admin-dashboard.html' }[me.role];
    if (to && me.role === role) location.href = to;
  }).catch(() => {});

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const form = e.target;
    const data = formObj(form);
    let ok = true;
    ['identifier', 'password'].forEach((id) => {
      const empty = !data[id];
      form[id].classList.toggle('is-invalid', empty);
      if (empty) ok = false;
    });
    if (!ok) return;
    try {
      const res = await busy($('#loginBtn'), () => api('/auth/login', { method: 'POST', body: { identifier: data.identifier, password: data.password, role }, noRedirect: true }));
      location.href = res.redirect + (role === 'patient' && next ? '#' + next : '');
    } catch (err) {
      if (err.data && err.data.needsVerification) {
        showAlert(`${esc(err.message)} <a href="/register.html?verify=${encodeURIComponent(err.data.mobile)}" class="alert-link">Verify now</a>`, 'warning');
      } else {
        showAlert(esc(err.message));
      }
    }
  });

  // ------------------------------------------------- forgot password flow
  $('#forgotBtn').addEventListener('click', () => {
    const m = showModal({
      title: 'Reset your password',
      body: `<div id="fpBox"></div>
        <form id="fpStep1" novalidate>
          <p class="text-secondary small">Enter the email or mobile number of your account. We will send a one-time password (OTP) to the registered mobile number.</p>
          <label class="form-label" for="fpId">Email or mobile number</label>
          <input class="form-control mb-3" id="fpId" name="identifier" required maxlength="150" autocomplete="username">
          <button class="btn btn-primary w-100" type="submit">Send OTP</button>
        </form>
        <form id="fpStep2" class="d-none" novalidate>
          <div id="fpDev"></div>
          <label class="form-label" for="fpCode">6-digit OTP</label>
          <input class="form-control otp-input mb-3" id="fpCode" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
          <label class="form-label" for="fpPw">New password</label>
          <input class="form-control mb-1" type="password" id="fpPw" name="newPassword" autocomplete="new-password" maxlength="72">
          <div class="form-text mb-3">At least 8 characters with an uppercase letter, a lowercase letter and a number.</div>
          <button class="btn btn-primary w-100" type="submit">Reset password</button>
        </form>`,
    });
    const box = $('#fpBox', m.el);
    let identifier = '';

    $('#fpStep1', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      identifier = formObj(e.target).identifier;
      if (!identifier) { box.innerHTML = '<div class="alert alert-danger py-2">Enter your email or mobile number.</div>'; return; }
      try {
        const res = await busy(e.submitter, () => api('/auth/forgot-password', { method: 'POST', body: { identifier }, noRedirect: true }));
        box.innerHTML = `<div class="alert alert-info py-2">${esc(res.message)}</div>`;
        // devOtp is only ever returned by the server when OTP_MODE=dev and NODE_ENV is not production.
        if (res.devOtp) $('#fpDev', m.el).innerHTML = `<div class="test-banner mb-3"><strong>DEVELOPMENT MODE:</strong> no SMS is sent. Your OTP is <strong>${esc(res.devOtp)}</strong>.</div>`;
        $('#fpStep1', m.el).classList.add('d-none');
        $('#fpStep2', m.el).classList.remove('d-none');
        $('#fpCode', m.el).focus();
      } catch (err) { box.innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`; }
    });

    $('#fpStep2', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      if (!/^\d{6}$/.test(d.code)) { box.innerHTML = '<div class="alert alert-danger py-2">Enter the 6-digit OTP.</div>'; return; }
      try {
        const res = await busy(e.submitter, () => api('/auth/reset-password', { method: 'POST', body: { identifier, code: d.code, newPassword: d.newPassword }, noRedirect: true }));
        toast(res.message);
        m.hide();
      } catch (err) { box.innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`; }
    });
  });
})();
