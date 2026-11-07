/* Patient registration (step 1) and mobile OTP verification (step 2). */
(function () {
  'use strict';
  const { $, esc, api, busy, formObj } = MC;

  const regAlert = $('#regAlert');
  const otpAlert = $('#otpAlert');
  let mobile = '';
  let timer = null;

  // ---- password strength meter ----
  function strength(pw) {
    let score = 0;
    if (pw.length >= 8) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 12) score++;
    return score;
  }
  const strongEnough = (pw) => pw.length >= 8 && pw.length <= 72 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
  $('#password').addEventListener('input', (e) => {
    const s = strength(e.target.value);
    const bar = $('#strengthBar');
    bar.style.width = `${s * 25}%`;
    bar.style.background = ['#dc3545', '#dc3545', '#fd7e14', '#ffc107', '#198754'][s];
    $('#strengthText').textContent = e.target.value ? ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][s] : 'Use 8+ characters with uppercase, lowercase and a number.';
  });

  // ---- step 1 ----
  $('#regForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    regAlert.innerHTML = '';
    const f = e.target;
    const d = formObj(f);
    const checks = {
      fullName: /^[A-Za-z][A-Za-z .'-]{1,119}$/.test(d.fullName || ''),
      mobile: /^[6-9]\d{9}$/.test(d.mobile || ''),
      age: Number.isInteger(Number(d.age)) && Number(d.age) >= 1 && Number(d.age) <= 120 && d.age !== '',
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email || '') && d.email.length <= 150,
      password: strongEnough(d.password || ''),
    };
    let ok = true;
    Object.entries(checks).forEach(([k, v]) => { f[k].classList.toggle('is-invalid', !v); if (!v) ok = false; });
    const matches = d.password === $('#confirm').value;
    $('#confirm').classList.toggle('is-invalid', !matches);
    const genderOk = !!d.gender;
    $('#genderErr').classList.toggle('d-none', genderOk);
    if (!ok || !matches || !genderOk) return;

    try {
      const res = await busy($('#regBtn'), () => api('/auth/register', {
        method: 'POST', noRedirect: true,
        body: { fullName: d.fullName, mobile: d.mobile, email: d.email.toLowerCase(), age: Number(d.age), gender: d.gender, password: d.password },
      }));
      showOtpStep(res.mobile, res.devOtp);
    } catch (err) {
      regAlert.innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`;
    }
  });

  // ---- step 2 ----
  function showOtpStep(m, devOtp) {
    mobile = m;
    $('#step1').classList.add('d-none');
    $('#step2').classList.remove('d-none');
    $('#otpMobile').textContent = '+91 ' + m;
    // The server only returns devOtp when OTP_MODE=dev and NODE_ENV is not production.
    $('#devBanner').innerHTML = devOtp
      ? `<div class="test-banner mb-3"><strong>DEVELOPMENT MODE:</strong> no SMS is sent. Your OTP is <strong>${esc(devOtp)}</strong>.</div>` : '';
    $('#code').value = '';
    $('#code').focus();
    startTimer(30);
  }

  function startTimer(seconds) {
    clearInterval(timer);
    const btn = $('#resendBtn');
    let left = seconds;
    btn.disabled = true;
    const tick = () => {
      $('#resendTimer').textContent = left > 0 ? `(available in ${left}s)` : '';
      if (left <= 0) { clearInterval(timer); btn.disabled = false; }
      left--;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  $('#otpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    otpAlert.innerHTML = '';
    const code = $('#code').value.trim();
    if (!/^\d{6}$/.test(code)) { otpAlert.innerHTML = '<div class="alert alert-danger py-2">Enter the 6-digit OTP.</div>'; return; }
    try {
      const res = await busy($('#otpBtn'), () => api('/auth/verify-otp', { method: 'POST', body: { mobile, code }, noRedirect: true }));
      location.href = res.redirect;
    } catch (err) {
      otpAlert.innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`;
    }
  });

  $('#resendBtn').addEventListener('click', async () => {
    otpAlert.innerHTML = '';
    try {
      const res = await api('/auth/resend-otp', { method: 'POST', body: { mobile }, noRedirect: true });
      otpAlert.innerHTML = `<div class="alert alert-info py-2">${esc(res.message)}</div>`;
      if (res.devOtp) $('#devBanner').innerHTML = `<div class="test-banner mb-3"><strong>DEVELOPMENT MODE:</strong> your new OTP is <strong>${esc(res.devOtp)}</strong>.</div>`;
      startTimer(30);
    } catch (err) {
      otpAlert.innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`;
    }
  });

  // Coming from the login page with an unverified account: ?verify=<mobile>
  const v = new URLSearchParams(location.search).get('verify');
  if (v && /^[6-9]\d{9}$/.test(v)) {
    showOtpStep(v);
    api('/auth/resend-otp', { method: 'POST', body: { mobile: v }, noRedirect: true })
      .then((res) => { if (res.devOtp) $('#devBanner').innerHTML = `<div class="test-banner mb-3"><strong>DEVELOPMENT MODE:</strong> your OTP is <strong>${esc(res.devOtp)}</strong>.</div>`; })
      .catch((err) => { otpAlert.innerHTML = `<div class="alert alert-warning py-2">${esc(err.message)}</div>`; });
  }
})();
