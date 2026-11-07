/* Admin dashboard: analytics charts, doctor / patient / appointment / payment management,
 * specializations, review moderation, settings and activity logs. */
(function () {
  'use strict';
  const {
    $, $$, esc, api, toast, fail, showModal, confirmDialog, askText, busy, formObj, todayISO,
    fmtDate, fmtShortDate, fmtTime, fmtDateTime, money, photoUrl, cap, badge, stars, emptyState, pager,
    initShell, renderNotifications, makeChart, CHART_COLORS,
  } = MC;

  let shell = null;
  const view = (title, fn) => ({ title, render: (section, sh) => { shell = sh; return fn(section); } });
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
  const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();

  // Filter / page state is kept per view so it survives re-renders.
  const st = {
    doctors: { q: '', status: '' },
    patients: { q: '', page: 1 },
    appts: { q: '', date: '', doctorId: '', status: '', page: 1 },
    pay: { status: '', from: '', to: '', page: 1 },
    reviews: { page: 1 },
    logs: { q: '', page: 1 },
  };

  const statCard = (icon, label, value, col = 'col-6 col-xl-3') => `
    <div class="${col}"><div class="card-soft stat-card"><div class="icon-bubble"><i class="bi ${icon}"></i></div>
      <div><div class="num">${value}</div><div class="lbl">${esc(label)}</div></div></div></div>`;
  const table = (heads, rows) => `<div class="table-responsive"><table class="table table-hover align-middle mb-0">
    <thead><tr>${heads.map((h) => `<th${h.endsWith('!') ? ' class="text-end"' : ''}>${esc(h.replace('!', ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const btn = (action, id, label, cls, extra = '') => `<button class="btn btn-sm btn-${cls}" data-action="${action}" data-id="${id}" ${extra}>${label}</button>`;

  // ================================================================ OVERVIEW
  async function renderOverview(section) {
    const s = await api('/admin/stats');
    const t = s.totals;
    section.innerHTML = `
      <div class="row g-3 mb-4">
        ${statCard('bi-people', 'Total patients', t.patients)}
        ${statCard('bi-heart-pulse', 'Active doctors', t.doctors)}
        ${statCard('bi-calendar-check', 'Total appointments', t.appointments)}
        ${statCard('bi-calendar-day', "Today's appointments", t.today)}
        ${statCard('bi-currency-rupee', 'Total revenue', money(t.revenue), 'col-6 col-xl-4')}
        ${statCard('bi-hourglass-split', 'Pending (awaiting doctor)', t.pending, 'col-6 col-xl-4')}
        <div class="col-12 col-xl-4"><div class="card-soft stat-card h-100"><div class="icon-bubble"><i class="bi bi-lightning-charge"></i></div>
          <div><div class="lbl mb-1">Quick actions</div><button class="btn btn-sm btn-primary me-1" data-action="goto" data-view="doctors">Manage doctors</button><button class="btn btn-sm btn-outline-primary" data-action="goto" data-view="payments">Payments</button></div></div></div>
      </div>
      <div class="row g-4">
        <div class="col-lg-7"><div class="card-soft p-4"><h2 class="h6 text-uppercase text-secondary mb-3">Appointments, last 14 days</h2><div class="chart-box"><canvas id="cTrend" role="img" aria-label="Appointments per day line chart"></canvas></div></div></div>
        <div class="col-lg-5"><div class="card-soft p-4"><h2 class="h6 text-uppercase text-secondary mb-3">Revenue, last 14 days (INR)</h2><div class="chart-box"><canvas id="cRevenue" role="img" aria-label="Revenue per day bar chart"></canvas></div></div></div>
        <div class="col-lg-6"><div class="card-soft p-4"><h2 class="h6 text-uppercase text-secondary mb-3">Most popular specializations</h2>
          <div class="chart-box">${s.popularSpecializations.length ? '<canvas id="cSpec" role="img" aria-label="Popular specializations doughnut chart"></canvas>' : emptyState('bi-pie-chart', 'Not enough data yet.')}</div></div></div>
        <div class="col-lg-6"><div class="card-soft p-4"><h2 class="h6 text-uppercase text-secondary mb-3">Appointment status</h2>
          <div class="chart-box">${s.statusBreakdown.length ? '<canvas id="cStatus" role="img" aria-label="Appointment status doughnut chart"></canvas>' : emptyState('bi-pie-chart', 'Not enough data yet.')}</div></div></div>
      </div>`;

    const labels = s.trend.map((x) => fmtShortDate(x.date));
    const opts = { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } };
    makeChart($('#cTrend', section), { type: 'line', data: { labels, datasets: [{ label: 'Appointments', data: s.trend.map((x) => x.appointments), borderColor: CHART_COLORS[0], backgroundColor: 'rgba(11,94,215,0.15)', fill: true, tension: 0.35, pointRadius: 3 }] }, options: opts });
    makeChart($('#cRevenue', section), { type: 'bar', data: { labels, datasets: [{ label: 'Revenue', data: s.trend.map((x) => x.revenue), backgroundColor: CHART_COLORS[1], borderRadius: 5 }] }, options: { ...opts, scales: { y: { beginAtZero: true } } } });
    const pie = (id, labs, data) => { const el = $(id, section); if (el) makeChart(el, { type: 'doughnut', data: { labels: labs, datasets: [{ data, backgroundColor: CHART_COLORS, borderWidth: 0 }] }, options: { maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '58%' } }); };
    pie('#cSpec', s.popularSpecializations.map((x) => x.name), s.popularSpecializations.map((x) => x.total));
    pie('#cStatus', s.statusBreakdown.map((x) => cap(x.status)), s.statusBreakdown.map((x) => x.total));
  }

  // ================================================================= DOCTORS
  const docCache = new Map();
  async function renderDoctors(section) {
    const f = st.doctors;
    const rows = await api('/admin/doctors?' + qs(f));
    docCache.clear();
    rows.forEach((d) => docCache.set(d.id, d));
    section.innerHTML = `<div class="card-soft p-3 p-md-4">
      <div class="d-flex flex-wrap gap-2 justify-content-between align-items-end mb-3">
        <form id="docFilter" class="d-flex flex-wrap gap-2 align-items-end">
          <div><label class="form-label small mb-1" for="fq">Search</label><input class="form-control" id="fq" name="q" value="${esc(f.q)}" placeholder="Name, email, specialization" maxlength="80"></div>
          <div><label class="form-label small mb-1" for="fs">Status</label><select class="form-select" id="fs" name="status">
            ${[['', 'All'], ['active', 'Active'], ['inactive', 'Inactive'], ['unverified', 'Unverified']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <button class="btn btn-outline-primary" type="submit"><i class="bi bi-search me-1"></i>Filter</button></form>
        <button class="btn btn-primary" data-action="addDoctor"><i class="bi bi-plus-lg me-1"></i>Add doctor</button></div>
      ${rows.length ? table(['Doctor', 'Specialization', 'Experience', 'Fee', 'Status', 'Appts', 'Actions!'], rows.map((d) => `<tr>
        <td><div class="d-flex gap-2 align-items-center"><img class="doc-photo sm" style="width:44px;height:44px" src="${photoUrl(d.photo)}" alt="" loading="lazy">
          <div><div class="fw-semibold">${esc(d.full_name)}</div><div class="small text-secondary">${esc(d.email)}</div><div class="small text-secondary">${esc(d.qualifications)}</div></div></div></td>
        <td>${esc(d.specialization)}</td><td>${d.experience_years} yrs</td><td>${money(d.consultation_fee)}</td>
        <td>${d.is_verified ? badge('success', 'Verified') : badge('pending', 'Unverified')} ${d.is_active ? '' : badge('cancelled', 'Inactive')}</td>
        <td>${d.appointments}</td>
        <td class="text-end"><div class="btn-group btn-group-sm">
          ${btn('editDoctor', d.id, '<i class="bi bi-pencil"></i>', 'outline-primary', 'title="Edit details"')}
          ${btn('docSchedule', d.id, '<i class="bi bi-calendar2-range"></i>', 'outline-primary', 'title="Manage availability"')}
          ${btn('docPhoto', d.id, '<i class="bi bi-camera"></i>', 'outline-primary', 'title="Upload photo"')}
          ${btn('verifyDoctor', d.id, d.is_verified ? '<i class="bi bi-patch-minus"></i>' : '<i class="bi bi-patch-check"></i>', d.is_verified ? 'outline-warning' : 'outline-success', `title="${d.is_verified ? 'Remove verification' : 'Verify qualifications'}"`)}
          ${btn('toggleDoctor', d.id, d.is_active ? '<i class="bi bi-pause-circle"></i>' : '<i class="bi bi-play-circle"></i>', d.is_active ? 'outline-secondary' : 'outline-success', `title="${d.is_active ? 'Deactivate' : 'Activate'}"`)}
          ${btn('deleteDoctor', d.id, '<i class="bi bi-trash"></i>', 'outline-danger', 'title="Delete"')}
        </div></td></tr>`)) : emptyState('bi-person-x', 'No doctors found.')}</div>`;
    $('#docFilter', section).addEventListener('submit', (e) => { e.preventDefault(); Object.assign(st.doctors, formObj(e.target)); shell.reload(); });
  }

  async function openDoctorForm(id) {
    const d = id ? docCache.get(id) : null;
    const specs = (await api('/admin/specializations')).filter((s) => s.is_active || (d && s.id === d.specialization_id));
    const m = showModal({
      title: d ? `Edit ${d.full_name}` : 'Add doctor', size: 'modal-lg',
      body: `<form id="docForm" novalidate><div class="row g-3">
        <div class="col-md-6"><label class="form-label" for="fFull">Full name</label><input class="form-control" id="fFull" name="fullName" maxlength="120" value="${esc(d ? d.full_name : 'Dr. ')}" required></div>
        <div class="col-md-6"><label class="form-label" for="fSpec">Specialization</label><select class="form-select" id="fSpec" name="specializationId" required>
          ${specs.map((s) => `<option value="${s.id}" ${d && d.specialization_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        ${d ? '' : `<div class="col-md-6"><label class="form-label" for="fEmail">Login email</label><input class="form-control" type="email" id="fEmail" name="email" maxlength="150" required></div>
        <div class="col-md-6"><label class="form-label" for="fPass">Initial password</label><input class="form-control" type="password" id="fPass" name="password" autocomplete="new-password" maxlength="72" required>
          <div class="form-text">8+ characters, upper + lower case and a number. Share it securely; the doctor can change it after login.</div></div>`}
        <div class="col-12"><label class="form-label" for="fQual">Qualifications</label><input class="form-control" id="fQual" name="qualifications" maxlength="255" value="${esc(d ? d.qualifications : '')}" required></div>
        <div class="col-md-3"><label class="form-label" for="fExp">Experience (years)</label><input class="form-control" type="number" id="fExp" name="experienceYears" min="0" max="70" value="${esc(d ? d.experience_years : 0)}" required></div>
        <div class="col-md-3"><label class="form-label" for="fPhone">Mobile</label><input class="form-control" id="fPhone" name="phone" inputmode="numeric" maxlength="10" value="${esc(d ? d.phone || '' : '')}" required></div>
        <div class="col-md-3"><label class="form-label" for="fLic">License no.</label><input class="form-control" id="fLic" name="licenseNumber" maxlength="50" value="${esc(d ? d.license_number || '' : '')}"></div>
        <div class="col-md-3"><label class="form-label" for="fFee">Fee (INR)</label><input class="form-control" type="number" id="fFee" name="consultationFee" min="0" step="0.01" value="${d ? esc(d.consultation_fee) : ''}" placeholder="Default fee"></div>
        <div class="col-12"><label class="form-label" for="fBio">About</label><textarea class="form-control" id="fBio" name="bio" rows="3" maxlength="1000">${esc(d ? d.bio || '' : '')}</textarea></div>
        ${d ? '' : '<div class="col-12"><div class="form-check"><input class="form-check-input" type="checkbox" id="fVer" name="verified" checked><label class="form-check-label" for="fVer">Qualifications verified (doctor becomes visible to patients immediately)</label></div></div>'}
      </div><div id="docErr" class="mt-3"></div></form>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="docSave">Save</button>',
    });
    $('#docSave', m.el).addEventListener('click', async (e) => {
      const form = $('#docForm', m.el);
      const v = formObj(form);
      const body = {
        fullName: v.fullName, specializationId: Number(v.specializationId), qualifications: v.qualifications,
        experienceYears: Number(v.experienceYears), phone: v.phone, licenseNumber: v.licenseNumber, bio: v.bio,
      };
      if (v.consultationFee !== '') body.consultationFee = Number(v.consultationFee);
      if (!d) { body.email = v.email; body.password = v.password; body.verified = !!$('#fVer', m.el).checked; }
      try {
        const r = await busy(e.currentTarget, () => api(d ? `/admin/doctors/${d.id}` : '/admin/doctors', { method: d ? 'PUT' : 'POST', body }));
        toast(r.message); m.hide(); shell.reload();
      } catch (err) { $('#docErr', m.el).innerHTML = `<div class="alert alert-danger py-2 mb-0">${esc(err.message)}</div>`; }
    });
  }

  async function openDoctorSchedule(id) {
    const d = docCache.get(id);
    const sched = await api(`/admin/doctors/${id}/schedule`);
    const byDay = Object.fromEntries(sched.map((r) => [r.day_of_week, r]));
    const m = showModal({
      title: `Availability: ${d.full_name}`, size: 'modal-xl',
      body: `<div class="table-responsive"><table class="table align-middle" id="schedTbl">
        <thead><tr><th>Day</th><th>Working</th><th>Start</th><th>End</th><th>Break from</th><th>Break to</th><th>Slot</th></tr></thead>
        <tbody>${DAY_ORDER.map((i) => {
          const r = byDay[i] || { is_working: 0, start_time: '09:00', end_time: '17:00', slot_minutes: 20 };
          return `<tr data-day="${i}"><td class="fw-semibold">${DAYS[i]}</td>
            <td><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="work" ${r.is_working ? 'checked' : ''} aria-label="Working on ${DAYS[i]}"></div></td>
            <td><input class="form-control form-control-sm" type="time" name="start" value="${hhmm(r.start_time)}"></td>
            <td><input class="form-control form-control-sm" type="time" name="end" value="${hhmm(r.end_time)}"></td>
            <td><input class="form-control form-control-sm" type="time" name="bs" value="${hhmm(r.break_start)}"></td>
            <td><input class="form-control form-control-sm" type="time" name="be" value="${hhmm(r.break_end)}"></td>
            <td><select class="form-select form-select-sm" name="slot">${[10, 15, 20, 30, 45, 60].map((n) => `<option value="${n}" ${Number(r.slot_minutes) === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></td></tr>`;
        }).join('')}</tbody></table></div><p class="small text-secondary mb-0">Existing appointments are not changed.</p>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="schedSave">Save schedule</button>',
    });
    const sync = (tr) => { const on = $('[name=work]', tr).checked; $$('input:not([name=work]), select', tr).forEach((x) => { x.disabled = !on; }); };
    $$('#schedTbl tbody tr', m.el).forEach((tr) => { sync(tr); $('[name=work]', tr).addEventListener('change', () => sync(tr)); });
    $('#schedSave', m.el).addEventListener('click', async (e) => {
      const days = $$('#schedTbl tbody tr', m.el).map((tr) => ({
        day_of_week: Number(tr.dataset.day), is_working: $('[name=work]', tr).checked,
        start_time: $('[name=start]', tr).value, end_time: $('[name=end]', tr).value,
        break_start: $('[name=bs]', tr).value || null, break_end: $('[name=be]', tr).value || null, slot_minutes: Number($('[name=slot]', tr).value),
      }));
      try { toast((await busy(e.currentTarget, () => api(`/admin/doctors/${id}/schedule`, { method: 'PUT', body: { days } }))).message); m.hide(); } catch (err) { fail(err); }
    });
  }

  function pickDoctorPhoto(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png';
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      if (!['image/jpeg', 'image/png'].includes(f.type) || f.size > 2 * 1024 * 1024) { toast('Choose a JPG or PNG image up to 2 MB.', 'warning'); return; }
      const form = new FormData();
      form.append('photo', f);
      try { toast((await api(`/admin/doctors/${id}/photo`, { method: 'POST', form })).message); shell.reload(); } catch (err) { fail(err); }
    });
    input.click();
  }

  // ================================================================ PATIENTS
  async function renderPatients(section) {
    const f = st.patients;
    const r = await api('/admin/patients?' + qs({ q: f.q, page: f.page }));
    section.innerHTML = `<div class="card-soft p-3 p-md-4">
      <form id="patFilter" class="d-flex gap-2 align-items-end mb-3"><div><label class="form-label small mb-1" for="pq">Search patients</label>
        <input class="form-control" id="pq" name="q" value="${esc(f.q)}" placeholder="Name, email or mobile" maxlength="80"></div>
        <button class="btn btn-outline-primary" type="submit"><i class="bi bi-search me-1"></i>Search</button></form>
      ${r.items.length ? table(['Patient', 'Contact', 'Age / Gender', 'Appts', 'Joined', 'Status', 'Actions!'], r.items.map((p) => `<tr>
        <td class="fw-semibold">${esc(p.full_name)}</td><td><div>${esc(p.email)}</div><div class="small text-secondary">+91 ${esc(p.mobile)}</div></td>
        <td>${esc(p.age)} / ${esc(cap(p.gender))}</td><td>${p.appointments}</td><td>${fmtDate(p.created_at)}</td>
        <td>${p.is_active ? badge('success', 'Active') : badge('cancelled', 'Deactivated')}${p.mobile_verified ? '' : ' ' + badge('pending', 'Unverified')}</td>
        <td class="text-end"><div class="btn-group btn-group-sm">${btn('viewPatient', p.id, 'View', 'outline-primary')}
          ${btn('togglePatient', p.id, p.is_active ? 'Deactivate' : 'Activate', p.is_active ? 'outline-danger' : 'outline-success', `data-active="${p.is_active ? 1 : 0}"`)}</div></td></tr>`))
        : emptyState('bi-people', 'No patients found.')}
      ${pager(r.page, r.pageSize, r.total, 'patPage')}</div>`;
    $('#patFilter', section).addEventListener('submit', (e) => { e.preventDefault(); st.patients = { q: formObj(e.target).q, page: 1 }; shell.reload(); });
  }

  async function viewPatient(id) {
    const { patient: p, appointments } = await api('/admin/patients/' + id);
    showModal({
      title: p.full_name, size: 'modal-lg',
      body: `<dl class="row small"><dt class="col-sm-3">Email</dt><dd class="col-sm-9">${esc(p.email)}</dd>
        <dt class="col-sm-3">Mobile</dt><dd class="col-sm-9">+91 ${esc(p.mobile)}</dd>
        <dt class="col-sm-3">Age / Gender</dt><dd class="col-sm-9">${esc(p.age)} / ${esc(cap(p.gender))}${p.blood_group ? ` &middot; ${esc(p.blood_group)}` : ''}</dd>
        <dt class="col-sm-3">Address</dt><dd class="col-sm-9">${esc(p.address || '-')}</dd>
        <dt class="col-sm-3">Registered</dt><dd class="col-sm-9">${fmtDateTime(p.created_at)}</dd></dl>
        <h3 class="h6">Appointment history</h3>
        ${appointments.length ? table(['ID', 'Date', 'Doctor', 'Status'], appointments.map((a) => `<tr><td class="small">${esc(a.appointment_code)}</td><td>${fmtDate(a.appointment_date)} ${fmtTime(a.slot_time)}</td><td>${esc(a.doctor_name)}</td><td>${badge(a.status)}</td></tr>`)) : '<p class="text-secondary small">No appointments yet.</p>'}`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Close</button>',
    });
  }

  // ============================================================== APPOINTMENTS
  async function renderAppointments(section) {
    const f = st.appts;
    const [r, doctors] = await Promise.all([api('/admin/appointments?' + qs(f)), api('/admin/doctors')]);
    section.innerHTML = `<div class="card-soft p-3 p-md-4">
      <form id="apFilter" class="row g-2 align-items-end mb-3">
        <div class="col-md-3"><label class="form-label small mb-1" for="aq">Search</label><input class="form-control" id="aq" name="q" value="${esc(f.q)}" placeholder="ID, patient or doctor" maxlength="80"></div>
        <div class="col-md-2"><label class="form-label small mb-1" for="ad">Date</label><input class="form-control" type="date" id="ad" name="date" value="${esc(f.date)}"></div>
        <div class="col-md-3"><label class="form-label small mb-1" for="adoc">Doctor</label><select class="form-select" id="adoc" name="doctorId"><option value="">All doctors</option>
          ${doctors.map((d) => `<option value="${d.id}" ${String(f.doctorId) === String(d.id) ? 'selected' : ''}>${esc(d.full_name)}</option>`).join('')}</select></div>
        <div class="col-md-2"><label class="form-label small mb-1" for="ast">Status</label><select class="form-select" id="ast" name="status"><option value="">All</option>
          ${['pending', 'confirmed', 'completed', 'cancelled', 'rejected'].map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></div>
        <div class="col-md-2 d-flex gap-1"><button class="btn btn-outline-primary flex-fill" type="submit">Filter</button><button class="btn btn-outline-secondary" type="button" data-action="clearAppts" title="Clear filters"><i class="bi bi-x-lg"></i></button></div>
      </form>
      ${r.items.length ? table(['ID', 'Date & time', 'Patient', 'Doctor', 'Status', 'Payment', 'Actions!'], r.items.map((a) => `<tr>
        <td class="small fw-semibold">${esc(a.appointment_code)}</td><td class="text-nowrap">${fmtDate(a.appointment_date)}<div class="small text-secondary">${fmtTime(a.slot_time)}</div></td>
        <td>${esc(a.patient_name)}</td><td>${esc(a.doctor_name)}</td>
        <td>${badge(a.status)}${a.cancel_reason ? `<div class="small text-secondary">${esc(a.cancel_reason)}</div>` : ''}</td>
        <td>${a.payment_status ? badge(a.payment_status) : '<span class="text-secondary small">none</span>'}</td>
        <td class="text-end">${['pending', 'confirmed'].includes(a.status) ? btn('adminCancel', a.id, 'Cancel', 'outline-danger') : ''}</td></tr>`))
        : emptyState('bi-calendar-x', 'No appointments match these filters.')}
      ${pager(r.page, r.pageSize, r.total, 'apPage')}</div>`;
    $('#apFilter', section).addEventListener('submit', (e) => { e.preventDefault(); st.appts = { ...formObj(e.target), page: 1 }; shell.reload(); });
  }

  // ================================================================ PAYMENTS
  async function renderPayments(section) {
    const f = st.pay;
    const r = await api('/admin/payments?' + qs(f));
    const s = r.summary;
    section.innerHTML = `<div class="row g-3 mb-4">
        ${statCard('bi-currency-rupee', 'Total revenue (successful)', money(s.revenue))}
        ${statCard('bi-check-circle', 'Successful payments', s.successful)}
        ${statCard('bi-x-circle', 'Failed payments', s.failed)}
        ${statCard('bi-arrow-counterclockwise', 'Refunded amount', money(s.refunded))}</div>
      <div class="card-soft p-3 p-md-4">
        <form id="payFilter" class="row g-2 align-items-end mb-3">
          <div class="col-md-3"><label class="form-label small mb-1" for="ps">Status</label><select class="form-select" id="ps" name="status"><option value="">All</option>
            ${['success', 'failed', 'pending', 'refunded'].map((x) => `<option value="${x}" ${f.status === x ? 'selected' : ''}>${cap(x)}</option>`).join('')}</select></div>
          <div class="col-md-3"><label class="form-label small mb-1" for="pf">From</label><input class="form-control" type="date" id="pf" name="from" value="${esc(f.from)}"></div>
          <div class="col-md-3"><label class="form-label small mb-1" for="pt">To</label><input class="form-control" type="date" id="pt" name="to" value="${esc(f.to)}"></div>
          <div class="col-md-3 d-flex gap-1"><button class="btn btn-outline-primary flex-fill" type="submit">Filter</button>
            <a class="btn btn-success" href="/api/admin/payments/report?${qs({ status: f.status, from: f.from, to: f.to })}"><i class="bi bi-download me-1"></i>CSV report</a></div>
        </form>
        ${r.items.length ? table(['Date', 'Receipt / Txn', 'Appointment', 'Patient', 'Doctor', 'Method', 'Status', 'Amount!'], r.items.map((p) => `<tr>
          <td class="text-nowrap small">${fmtDateTime(p.payment_date)}</td>
          <td class="small">${esc(p.receipt_no || '-')}<div class="text-secondary">${esc(p.transaction_ref)}</div></td>
          <td class="small">${esc(p.appointment_code)}</td><td>${esc(p.patient_name)}</td><td>${esc(p.doctor_name)}</td>
          <td>${esc(String(p.method).toUpperCase())}${p.mode === 'test' ? ' <span class="badge bg-warning text-dark">TEST</span>' : ''}</td>
          <td>${badge(p.status)}</td><td class="text-end fw-semibold">${money(p.amount)}</td></tr>`)) : emptyState('bi-credit-card', 'No payments match these filters.')}
        ${pager(r.page, r.pageSize, r.total, 'payPage')}</div>`;
    $('#payFilter', section).addEventListener('submit', (e) => { e.preventDefault(); st.pay = { ...formObj(e.target), page: 1 }; shell.reload(); });
  }

  // ========================================================== SPECIALIZATIONS
  const specCache = new Map();
  async function renderSpecializations(section) {
    const [specs, issues] = await Promise.all([api('/admin/specializations'), api('/admin/health-issues')]);
    specCache.clear();
    specs.forEach((s) => specCache.set(s.id, s));
    section.innerHTML = `<div class="row g-4">
      <div class="col-lg-7"><div class="card-soft p-4">
        <div class="d-flex justify-content-between align-items-center mb-3"><h2 class="h5 mb-0">Specializations</h2>
          <button class="btn btn-primary btn-sm" data-action="addSpec"><i class="bi bi-plus-lg me-1"></i>Add specialization</button></div>
        ${table(['Name', 'Icon', 'Doctors', 'Status', 'Actions!'], specs.map((s) => `<tr>
          <td><div class="fw-semibold">${esc(s.name)}</div><div class="small text-secondary">${esc(s.description || '')}</div></td>
          <td><i class="bi ${/^bi-[a-z0-9-]+$/.test(s.icon) ? esc(s.icon) : 'bi-heart-pulse'} fs-5 text-brand"></i></td><td>${s.doctors}</td>
          <td>${s.is_active ? badge('success', 'Active') : badge('cancelled', 'Inactive')}</td>
          <td class="text-end"><div class="btn-group btn-group-sm">${btn('editSpec', s.id, 'Edit', 'outline-primary')}${btn('toggleSpec', s.id, s.is_active ? 'Deactivate' : 'Activate', s.is_active ? 'outline-secondary' : 'outline-success')}</div></td></tr>`))}</div></div>
      <div class="col-lg-5"><div class="card-soft p-4">
        <h2 class="h5">Health concern &rarr; specialization</h2>
        <p class="small text-secondary">These power the patient "select your health concern" guidance.</p>
        <form id="issueForm" class="row g-2 mb-3" novalidate>
          <div class="col-12"><input class="form-control" name="name" placeholder="Health concern, e.g. Knee pain" maxlength="100" aria-label="Health concern"></div>
          <div class="col-8"><select class="form-select" name="specializationId" aria-label="Specialization">${specs.filter((s) => s.is_active).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
          <div class="col-4"><button class="btn btn-outline-primary w-100" type="submit">Add</button></div></form>
        <ul class="list-group list-group-flush">${issues.map((i) => `<li class="list-group-item d-flex justify-content-between align-items-center px-0">
          <div><div class="small fw-semibold">${esc(i.name)}</div><div class="small text-brand">${esc(i.specialization)}</div></div>
          ${btn('delIssue', i.id, '<i class="bi bi-trash"></i>', 'outline-danger')}</li>`).join('')}</ul></div></div></div>`;
    $('#issueForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      if (d.name.length < 2) { toast('Enter the health concern.', 'warning'); return; }
      try { toast((await busy(e.submitter, () => api('/admin/health-issues', { method: 'POST', body: { name: d.name, specializationId: Number(d.specializationId) } }))).message); shell.reload(); } catch (err) { fail(err); }
    });
  }

  function openSpecForm(id) {
    const s = id ? specCache.get(id) : null;
    const m = showModal({
      title: s ? 'Edit specialization' : 'Add specialization',
      body: `<form id="specForm" novalidate>
        <div class="mb-3"><label class="form-label" for="sName">Name</label><input class="form-control" id="sName" name="name" maxlength="80" value="${esc(s ? s.name : '')}" required></div>
        <div class="mb-3"><label class="form-label" for="sDesc">Description</label><input class="form-control" id="sDesc" name="description" maxlength="255" value="${esc(s ? s.description || '' : '')}"></div>
        <div class="mb-3"><label class="form-label" for="sIcon">Icon (Bootstrap Icons class)</label><input class="form-control" id="sIcon" name="icon" maxlength="45" placeholder="bi-heart-pulse" value="${esc(s ? s.icon : 'bi-heart-pulse')}">
          <div class="form-text">Browse names at icons.getbootstrap.com</div></div></form><div id="specErr"></div>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="specSave">Save</button>',
    });
    $('#specSave', m.el).addEventListener('click', async (e) => {
      const d = formObj($('#specForm', m.el));
      try {
        const r = await busy(e.currentTarget, () => api(s ? `/admin/specializations/${s.id}` : '/admin/specializations', { method: s ? 'PUT' : 'POST', body: { name: d.name, description: d.description, icon: d.icon } }));
        toast(r.message); m.hide(); shell.reload();
      } catch (err) { $('#specErr', m.el).innerHTML = `<div class="alert alert-danger py-2 mt-3 mb-0">${esc(err.message)}</div>`; }
    });
  }

  // ================================================================= REVIEWS
  async function renderReviews(section) {
    const r = await api('/admin/reviews?' + qs({ page: st.reviews.page }));
    section.innerHTML = `<div class="card-soft p-3 p-md-4"><p class="small text-secondary">Hidden reviews no longer appear on the website or in a doctor's rating.</p>
      ${r.items.length ? table(['Date', 'Patient', 'Doctor', 'Rating', 'Comment', 'Visible'], r.items.map((v) => `<tr>
        <td class="small text-nowrap">${fmtDate(v.created_at)}</td><td>${esc(v.patient_name)}</td><td>${esc(v.doctor_name)}</td><td>${stars(v.rating)}</td>
        <td style="max-width:320px">${esc(v.comment || '')}</td>
        <td><div class="form-check form-switch"><input class="form-check-input" type="checkbox" data-action="reviewVis" data-id="${v.id}" ${v.is_visible ? 'checked' : ''} aria-label="Visible"></div></td></tr>`))
        : emptyState('bi-star', 'No reviews yet.')}
      ${pager(r.page, r.pageSize, r.total, 'revPage')}</div>`;
  }

  // ================================================================ SETTINGS
  async function renderSettings(section) {
    const s = await api('/admin/settings');
    const field = (key, label, extra = '') => `<div class="col-md-6"><label class="form-label" for="st_${key}">${label}</label><input class="form-control" id="st_${key}" name="${key}" value="${esc(s[key] || '')}" ${extra}></div>`;
    section.innerHTML = `<div class="row g-4">
      <div class="col-lg-7"><div class="card-soft p-4"><h2 class="h5 mb-3">Website information</h2>
        <form id="setForm" novalidate><div class="row g-3">
          ${field('hospital_name', 'Hospital name', 'maxlength="100" required')}${field('hospital_tagline', 'Tagline', 'maxlength="150"')}
          ${field('hospital_phone', 'Phone', 'maxlength="30"')}${field('hospital_email', 'Contact email', 'type="email" maxlength="150"')}
          <div class="col-12"><label class="form-label" for="st_hospital_address">Address</label><input class="form-control" id="st_hospital_address" name="hospital_address" value="${esc(s.hospital_address || '')}" maxlength="250"></div>
          ${field('emergency_phone', 'Emergency number', 'maxlength="20"')}${field('working_hours', 'Working hours text', 'maxlength="100"')}
          <div class="col-12"><hr><h3 class="h6">Appointment fee</h3></div>
          <div class="col-md-6"><label class="form-label" for="st_default_fee">Default consultation fee (INR)</label><input class="form-control" id="st_default_fee" name="default_fee" type="number" min="0" step="0.01" value="${esc(s.default_fee || '200')}"></div>
          <div class="col-md-6 d-flex align-items-end"><div class="form-check"><input class="form-check-input" type="checkbox" id="applyAll"><label class="form-check-label" for="applyAll">Also apply this fee to all existing doctors</label></div></div>
        </div><div class="form-text mt-2">The default fee is used for newly added doctors. Applying it to existing doctors affects future bookings only.</div>
        <button class="btn btn-primary mt-3" type="submit">Save settings</button></form></div></div>
      <div class="col-lg-5"><div class="card-soft p-4"><h2 class="h5 mb-3">Change admin password</h2>
        <form id="pwForm" novalidate>
          <div class="mb-3"><label class="form-label" for="cpOld">Current password</label><input class="form-control" type="password" id="cpOld" name="currentPassword" autocomplete="current-password" required></div>
          <div class="mb-3"><label class="form-label" for="cpNew">New password</label><input class="form-control" type="password" id="cpNew" name="newPassword" autocomplete="new-password" maxlength="72" required><div class="form-text">8+ characters with uppercase, lowercase and a number.</div></div>
          <div class="mb-3"><label class="form-label" for="cpConf">Confirm new password</label><input class="form-control" type="password" id="cpConf" name="confirm" autocomplete="new-password" required></div>
          <button class="btn btn-primary" type="submit">Update password</button></form></div></div></div>`;
    $('#setForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formObj(e.target);
      body.applyToAll = $('#applyAll', section).checked;
      try { toast((await busy(e.submitter, () => api('/admin/settings', { method: 'PUT', body }))).message); } catch (err) { fail(err); }
    });
    $('#pwForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      if (d.newPassword !== d.confirm) { toast('The new passwords do not match.', 'warning'); return; }
      try { toast((await busy(e.submitter, () => api('/auth/change-password', { method: 'POST', body: { currentPassword: d.currentPassword, newPassword: d.newPassword } }))).message); e.target.reset(); } catch (err) { fail(err); }
    });
  }

  // ==================================================================== LOGS
  async function renderLogs(section) {
    const f = st.logs;
    const r = await api('/admin/logs?' + qs(f));
    section.innerHTML = `<div class="card-soft p-3 p-md-4">
      <form id="logFilter" class="d-flex gap-2 align-items-end mb-3"><div><label class="form-label small mb-1" for="lq">Search logs</label>
        <input class="form-control" id="lq" name="q" value="${esc(f.q)}" placeholder="Action, details or user" maxlength="80"></div>
        <button class="btn btn-outline-primary" type="submit"><i class="bi bi-search me-1"></i>Search</button></form>
      ${r.items.length ? table(['Time', 'User', 'Action', 'Details', 'IP'], r.items.map((l) => `<tr>
        <td class="small text-nowrap">${fmtDateTime(l.created_at)}</td><td class="small">${l.email ? `${esc(l.email)} <span class="badge bg-secondary">${esc(l.role)}</span>` : '<span class="text-secondary">system / unknown</span>'}</td>
        <td><span class="badge bg-brand-soft text-brand">${esc(l.action)}</span></td><td class="small">${esc(l.details || '')}</td><td class="small text-secondary">${esc(l.ip_address || '')}</td></tr>`))
        : emptyState('bi-journal-text', 'No log entries found.')}
      ${pager(r.page, r.pageSize, r.total, 'logPage')}</div>`;
    $('#logFilter', section).addEventListener('submit', (e) => { e.preventDefault(); st.logs = { q: formObj(e.target).q, page: 1 }; shell.reload(); });
  }

  // =========================================================== EVENT ROUTER
  const actions = {
    goto: (el) => shell.go(el.dataset.view),
    addDoctor: () => openDoctorForm(null),
    editDoctor: (el) => openDoctorForm(Number(el.dataset.id)),
    docSchedule: (el) => openDoctorSchedule(Number(el.dataset.id)),
    docPhoto: (el) => pickDoctorPhoto(Number(el.dataset.id)),
    verifyDoctor: async (el) => {
      const d = docCache.get(Number(el.dataset.id));
      const verified = !d.is_verified;
      if (!(await confirmDialog(verified ? `Confirm that ${d.full_name}'s qualifications have been verified? The doctor becomes visible to patients.` : `Remove verification from ${d.full_name}? The doctor will be hidden from patients.`, { okText: verified ? 'Verify' : 'Remove verification' }))) return;
      toast((await api(`/admin/doctors/${d.id}/verify`, { method: 'POST', body: { verified } })).message);
      shell.reload();
    },
    toggleDoctor: async (el) => {
      const d = docCache.get(Number(el.dataset.id));
      const active = !d.is_active;
      const msg = active ? `Activate ${d.full_name}?` : `Deactivate ${d.full_name}? Their upcoming appointments will be cancelled and refunded, and they will no longer be able to log in.`;
      if (!(await confirmDialog(msg, { danger: !active, okText: active ? 'Activate' : 'Deactivate' }))) return;
      toast((await api(`/admin/doctors/${d.id}/status`, { method: 'POST', body: { active } })).message);
      shell.reload();
    },
    deleteDoctor: async (el) => {
      const d = docCache.get(Number(el.dataset.id));
      if (!(await confirmDialog(`Permanently delete ${d.full_name}? This cannot be undone. Doctors with appointment history cannot be deleted; deactivate them instead.`, { danger: true, okText: 'Delete doctor' }))) return;
      toast((await api('/admin/doctors/' + d.id, { method: 'DELETE' })).message);
      shell.reload();
    },
    viewPatient: (el) => viewPatient(el.dataset.id),
    togglePatient: async (el) => {
      const active = el.dataset.active !== '1';
      if (!(await confirmDialog(active ? 'Activate this patient account?' : 'Deactivate this patient account? They will no longer be able to log in.', { danger: !active, okText: active ? 'Activate' : 'Deactivate' }))) return;
      toast((await api(`/admin/patients/${el.dataset.id}/status`, { method: 'POST', body: { active } })).message);
      shell.reload();
    },
    patPage: (el) => { st.patients.page = Number(el.dataset.page); shell.reload(); },
    apPage: (el) => { st.appts.page = Number(el.dataset.page); shell.reload(); },
    payPage: (el) => { st.pay.page = Number(el.dataset.page); shell.reload(); },
    revPage: (el) => { st.reviews.page = Number(el.dataset.page); shell.reload(); },
    logPage: (el) => { st.logs.page = Number(el.dataset.page); shell.reload(); },
    clearAppts: () => { st.appts = { q: '', date: '', doctorId: '', status: '', page: 1 }; shell.reload(); },
    adminCancel: async (el) => {
      const reason = await askText({ title: 'Cancel appointment', label: 'Reason (shown to the patient and doctor). The patient is refunded automatically.', danger: true, okText: 'Cancel appointment' });
      if (reason === null) return;
      toast((await api(`/admin/appointments/${el.dataset.id}/cancel`, { method: 'POST', body: { reason } })).message);
      shell.reload();
    },
    addSpec: () => openSpecForm(null),
    editSpec: (el) => openSpecForm(Number(el.dataset.id)),
    toggleSpec: async (el) => {
      const s = specCache.get(Number(el.dataset.id));
      try {
        toast((await api(`/admin/specializations/${s.id}`, { method: 'PUT', body: { name: s.name, description: s.description || '', icon: s.icon, isActive: !s.is_active } })).message);
      } catch (err) { fail(err); }
      shell.reload();
    },
    delIssue: async (el) => {
      if (!(await confirmDialog('Remove this health concern from the guidance list?', { danger: true, okText: 'Remove' }))) return;
      toast((await api('/admin/health-issues/' + el.dataset.id, { method: 'DELETE' })).message);
      shell.reload();
    },
    reviewVis: async (el) => {
      try { toast((await api(`/admin/reviews/${el.dataset.id}/visibility`, { method: 'PUT', body: { visible: el.checked } })).message); } catch (err) { el.checked = !el.checked; fail(err); }
    },
  };
  // Checkbox toggles must not be preventDefault()-ed, so they are handled separately from buttons.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    const fn = el && actions[el.dataset.action];
    if (!fn || el.type === 'checkbox') return;
    e.preventDefault();
    Promise.resolve(fn(el)).catch(fail);
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.type === 'checkbox' && el.dataset.action && actions[el.dataset.action]) Promise.resolve(actions[el.dataset.action](el)).catch(fail);
  });
  document.addEventListener('themechange', () => { if (shell && shell.current === 'overview') shell.reload(); });

  initShell({
    role: 'admin',
    defaultView: 'overview',
    views: {
      overview: view('Dashboard', renderOverview),
      doctors: view('Doctor Management', renderDoctors),
      patients: view('Patient Management', renderPatients),
      appointments: view('Appointment Management', renderAppointments),
      payments: view('Payment Management', renderPayments),
      specializations: view('Specializations', renderSpecializations),
      reviews: view('Reviews & Ratings', renderReviews),
      settings: view('Admin Settings', renderSettings),
      logs: view('Activity Logs', renderLogs),
      notifications: view('Notifications', renderNotifications),
    },
  });
})();
