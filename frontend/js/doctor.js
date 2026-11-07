/* Doctor dashboard: statistics + chart, appointment management, consultation notes & prescriptions,
 * weekly schedule, blocked dates, profile & photo, reviews. */
(function () {
  'use strict';
  const {
    $, $$, esc, api, toast, fail, showModal, confirmDialog, askText, busy, formObj, todayISO,
    fmtDate, fmtShortDate, fmtTime, money, photoUrl, cap, badge, stars, emptyState,
    initShell, renderNotifications, makeChart, CHART_COLORS,
  } = MC;

  let shell = null;
  const view = (title, fn) => ({ title, render: (section, sh) => { shell = sh; return fn(section); } });
  const spinner = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

  const statCard = (icon, label, n, extra = '') => `
    <div class="col-6 col-lg"><div class="card-soft stat-card"><div class="icon-bubble"><i class="bi ${icon}"></i></div>
      <div><div class="num">${n}</div><div class="lbl">${esc(label)}</div>${extra}</div></div></div>`;

  // ============================================================== OVERVIEW
  async function renderOverview(section) {
    const [d, pending] = await Promise.all([api('/doctor/dashboard'), api('/doctor/appointments?scope=upcoming')]);
    const requests = pending.filter((a) => a.status === 'pending');
    section.innerHTML = `
      <div class="row g-3 mb-4">
        ${statCard('bi-calendar-day', "Today's appointments", d.counts.today)}
        ${statCard('bi-calendar-week', 'Upcoming', d.counts.upcoming)}
        ${statCard('bi-hourglass-split', 'Awaiting your reply', d.counts.pendingRequests)}
        ${statCard('bi-check2-circle', 'Completed', d.counts.completed)}
        ${statCard('bi-x-circle', 'Cancelled', d.counts.cancelled)}
      </div>
      <div class="row g-4">
        <div class="col-lg-8"><div class="card-soft p-4 h-100">
          <h2 class="h6 text-uppercase text-secondary mb-3">Daily appointment statistics (last 7 days and next 7 days)</h2>
          <div class="chart-box"><canvas id="dailyChart" aria-label="Daily appointments bar chart" role="img"></canvas></div></div></div>
        <div class="col-lg-4"><div class="card-soft p-4 h-100">
          <h2 class="h6 text-uppercase text-secondary mb-3">Your rating</h2>
          <div class="display-5 fw-bold">${d.rating.average === null ? '-' : d.rating.average}<span class="fs-5 text-secondary"> / 5</span></div>
          <div class="mb-1">${stars(d.rating.average)}</div>
          <div class="small text-secondary">${d.rating.reviews} review${d.rating.reviews === 1 ? '' : 's'} from patients</div>
        </div></div>
      </div>
      <div class="card-soft p-4 mt-4">
        <h2 class="h6 text-uppercase text-secondary mb-3">New appointment requests</h2>
        ${requests.length ? apptTable(requests, true) : emptyState('bi-inbox', 'No requests are waiting for your reply.')}</div>`;

    const today = todayISO();
    makeChart($('#dailyChart', section), {
      type: 'bar',
      data: {
        labels: d.daily.map((x) => (x.date === today ? 'Today' : fmtShortDate(x.date))),
        datasets: [{ label: 'Appointments', data: d.daily.map((x) => x.total), backgroundColor: d.daily.map((x) => (x.date < today ? '#9bbcf5' : CHART_COLORS[0])), borderRadius: 6 }],
      },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  // ========================================================== APPOINTMENTS
  function apptTable(rows, showDate) {
    return `<div class="table-responsive"><table class="table table-hover align-middle mb-0">
      <thead><tr>${showDate ? '<th>Date</th>' : ''}<th>Time</th><th>Patient</th><th>Reason</th><th>Status</th><th class="text-end">Actions</th></tr></thead>
      <tbody>${rows.map((a) => {
        const acts = [];
        const b = (action, label, cls) => `<button class="btn btn-sm btn-${cls}" data-action="${action}" data-id="${a.id}">${label}</button>`;
        if (a.status === 'pending') acts.push(b('accept', 'Accept', 'success'), b('reject', 'Reject', 'outline-danger'));
        if (a.status === 'confirmed') acts.push(b('consult', 'Consult', 'primary'), b('cancel', 'Cancel', 'outline-danger'));
        if (a.status === 'completed') acts.push(b('consult', 'Details', 'outline-primary'));
        if (['cancelled', 'rejected'].includes(a.status)) acts.push(b('consult', 'Details', 'outline-secondary'));
        if (a.status === 'pending') acts.unshift(b('consult', 'View', 'outline-primary'));
        return `<tr>${showDate ? `<td>${fmtDate(a.appointment_date)}</td>` : ''}
          <td class="fw-semibold text-nowrap">${fmtTime(a.slot_time)}</td>
          <td><div class="fw-semibold">${esc(a.patient_name)}</div><div class="small text-secondary">${esc(a.age)} yrs, ${esc(cap(a.gender))}${a.blood_group ? ` &middot; ${esc(a.blood_group)}` : ''}</div></td>
          <td style="max-width:260px"><div class="text-truncate" title="${esc(a.reason)}">${esc(a.reason)}</div>${a.cancel_reason ? `<div class="small text-danger">Cancelled: ${esc(a.cancel_reason)}</div>` : ''}</td>
          <td>${badge(a.status)}${a.has_prescription ? ' <i class="bi bi-file-medical text-brand" title="Prescription added"></i>' : ''}<div class="small text-secondary">${esc(a.appointment_code)}</div></td>
          <td class="text-end text-nowrap"><div class="d-inline-flex gap-1">${acts.join('')}</div></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  async function renderScope(section, scope, title, emptyText) {
    const rows = await api('/doctor/appointments?scope=' + scope);
    section.innerHTML = `<div class="card-soft p-3 p-md-4"><h2 class="h5 mb-3">${esc(title)} <span class="badge bg-brand-soft text-brand ms-1">${rows.length}</span></h2>
      ${rows.length ? apptTable(rows, scope !== 'today') : emptyState('bi-calendar-x', emptyText)}</div>`;
  }
  const renderToday = (s) => renderScope(s, 'today', "Today's appointments", 'You have no appointments today.');
  const renderUpcoming = (s) => renderScope(s, 'upcoming', 'Upcoming appointments', 'No upcoming appointments.');

  let histScope = 'completed';
  async function renderHistory(section) {
    const rows = await api('/doctor/appointments?scope=' + histScope);
    section.innerHTML = `<ul class="nav nav-pills gap-1 mb-3">${[['completed', 'Completed'], ['cancelled', 'Cancelled / rejected'], ['all', 'All']].map(([k, l]) =>
      `<li class="nav-item"><button class="nav-link ${histScope === k ? 'active' : ''}" data-action="histScope" data-scope="${k}">${l}</button></li>`).join('')}</ul>
      <div class="card-soft p-3 p-md-4">${rows.length ? apptTable(rows, true) : emptyState('bi-clock-history', 'Nothing to show here yet.')}</div>`;
  }

  async function acceptAppt(id) {
    toast((await api(`/doctor/appointments/${id}/accept`, { method: 'POST' })).message);
    shell.reload();
  }
  async function rejectAppt(id) {
    const reason = await askText({ title: 'Reject request', label: 'Reason for rejecting (shown to the patient). The patient is refunded automatically.', danger: true, okText: 'Reject request' });
    if (reason === null) return;
    toast((await api(`/doctor/appointments/${id}/reject`, { method: 'POST', body: { reason } })).message);
    shell.reload();
  }
  async function cancelAppt(id) {
    const reason = await askText({ title: 'Cancel appointment', label: 'Reason for cancelling (shown to the patient). The patient is refunded automatically.', danger: true, okText: 'Cancel appointment' });
    if (reason === null) return;
    toast((await api(`/doctor/appointments/${id}/cancel`, { method: 'POST', body: { reason } })).message);
    shell.reload();
  }

  // Consultation: patient details, history, notes, prescription, completion.
  async function openConsult(id) {
    const d = await api('/doctor/appointments/' + id);
    const a = d.appointment;
    const p = d.patient;
    const canWork = ['confirmed', 'completed'].includes(a.status);
    const rx = d.prescription;
    const m = showModal({
      title: `Appointment ${a.appointment_code}`, size: 'modal-xl',
      body: `<div class="row g-4">
        <div class="col-lg-5">
          <div class="card-soft p-3 mb-3">
            <div class="d-flex justify-content-between"><h3 class="h6 mb-2">Patient</h3>${badge(a.status)}</div>
            <div class="fw-bold">${esc(p.full_name)}</div>
            <div class="small text-secondary">${esc(p.age)} years &middot; ${esc(cap(p.gender))}${p.blood_group ? ` &middot; Blood group ${esc(p.blood_group)}` : ''}</div>
            <div class="small mt-2"><i class="bi bi-calendar3 me-1"></i>${fmtDate(a.appointment_date)} at ${fmtTime(a.slot_time)}</div>
            <div class="mt-2 small text-secondary">Reason for visit</div><div>${esc(a.reason)}</div></div>
          <h3 class="h6">Medical history</h3>
          ${d.medicalHistory.length ? `<ul class="list-unstyled small">${d.medicalHistory.map((r) => `<li class="mb-2"><span class="badge bg-brand-soft text-brand me-1">${esc(cap(r.record_type.replace('_', ' ')))}</span><strong>${esc(r.title)}</strong> <span class="text-secondary">${fmtDate(r.record_date)}</span>${r.details ? `<div style="white-space:pre-wrap">${esc(r.details)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="small text-secondary">No history recorded.</p>'}
          <h3 class="h6">Previous prescriptions</h3>
          ${d.previousPrescriptions.length ? `<ul class="list-unstyled small">${d.previousPrescriptions.map((r) => `<li class="mb-2"><strong>${esc(r.doctor_name)}</strong> <span class="text-secondary">${fmtDate(r.created_at)}</span>${r.diagnosis ? `<div>${esc(r.diagnosis)}</div>` : ''}<div style="white-space:pre-wrap">${esc(r.medicines)}</div></li>`).join('')}</ul>` : '<p class="small text-secondary">None.</p>'}
        </div>
        <div class="col-lg-7">
          ${canWork ? `
          <h3 class="h6">Consultation notes</h3>
          <textarea id="cNotes" class="form-control mb-2" rows="4" maxlength="2000" placeholder="Findings, advice, follow-up...">${esc(a.consultation_notes || '')}</textarea>
          <button class="btn btn-sm btn-outline-primary mb-4" id="saveNotes">Save notes</button>
          <h3 class="h6">Prescription ${rx ? '<span class="badge bg-success ms-1">Saved</span>' : ''}</h3>
          <form id="rxForm" novalidate>
            <div class="mb-2"><label class="form-label small" for="rxDx">Diagnosis (optional)</label><input class="form-control" id="rxDx" name="diagnosis" maxlength="255" value="${esc(rx ? rx.diagnosis || '' : '')}"></div>
            <div class="mb-2"><label class="form-label small" for="rxMed">Medicines and dosage</label><textarea class="form-control" id="rxMed" name="medicines" rows="4" maxlength="3000" required>${esc(rx ? rx.medicines : '')}</textarea></div>
            <div class="mb-2"><label class="form-label small" for="rxIns">Instructions (optional)</label><textarea class="form-control" id="rxIns" name="instructions" rows="2" maxlength="2000">${esc(rx ? rx.instructions || '' : '')}</textarea></div>
            <div class="mb-3"><label class="form-label small" for="rxFile">Attach scanned prescription (JPG, PNG or PDF, max 3 MB)${rx && rx.has_file ? ' &ndash; a file is already attached; choosing a new one replaces it' : ''}</label>
              <input class="form-control" type="file" id="rxFile" name="file" accept="image/jpeg,image/png,application/pdf"></div>
            <button class="btn btn-primary" type="submit"><i class="bi bi-file-earmark-medical me-1"></i>Save prescription</button>
          </form>` : `<div class="alert alert-secondary">Notes and prescriptions can be added once the appointment is confirmed.
            ${a.status === 'pending' ? 'Accept the request first.' : ''}</div>
          ${a.consultation_notes ? `<h3 class="h6">Consultation notes</h3><p style="white-space:pre-wrap">${esc(a.consultation_notes)}</p>` : ''}`}
        </div></div>`,
      footer: `<button class="btn btn-light" data-bs-dismiss="modal">Close</button>
        ${a.status === 'confirmed' ? '<button class="btn btn-success" id="completeBtn"><i class="bi bi-check2-circle me-1"></i>Mark as completed</button>' : ''}`,
    });

    const refresh = () => { if (['today', 'upcoming', 'history', 'overview'].includes(shell.current)) shell.reload(); };
    if (canWork) {
      $('#saveNotes', m.el).addEventListener('click', async (e) => {
        const notes = $('#cNotes', m.el).value.trim();
        if (!notes) { toast('Write some notes first.', 'warning'); return; }
        try { toast((await busy(e.currentTarget, () => api(`/doctor/appointments/${id}/notes`, { method: 'PUT', body: { notes } }))).message); } catch (err) { fail(err); }
      });
      $('#rxForm', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!$('#rxMed', m.el).value.trim()) { toast('List the prescribed medicines.', 'warning'); return; }
        try {
          const r = await busy(e.submitter, () => api(`/doctor/appointments/${id}/prescription`, { method: 'POST', form: new FormData(e.target) }));
          toast(r.message); refresh();
        } catch (err) { fail(err); }
      });
    }
    const done = $('#completeBtn', m.el);
    if (done) done.addEventListener('click', async (e) => {
      if (!(await confirmDialog('Mark this consultation as completed? The patient will be able to rate you.', { okText: 'Mark completed' }))) return;
      try {
        const notes = $('#cNotes', m.el).value.trim();
        toast((await busy(e.currentTarget, () => api(`/doctor/appointments/${id}/complete`, { method: 'POST', body: { notes } }))).message);
        m.hide(); refresh();
      } catch (err) { fail(err); }
    });
  }

  // =============================================================== SCHEDULE
  async function renderSchedule(section) {
    const [sched, blocked] = await Promise.all([api('/doctor/schedule'), api('/doctor/blocked-dates')]);
    const byDay = Object.fromEntries(sched.map((r) => [r.day_of_week, r]));
    section.innerHTML = `<div class="row g-4">
      <div class="col-xl-8"><div class="card-soft p-4">
        <h2 class="h5">Weekly working hours</h2>
        <p class="small text-secondary">Patients can only book inside these hours, outside your break. Changing this does not affect existing appointments.</p>
        <form id="schedForm" novalidate>
          <div class="table-responsive"><table class="table align-middle">
            <thead><tr><th>Day</th><th>Working</th><th>Start</th><th>End</th><th>Break from</th><th>Break to</th><th>Slot</th></tr></thead>
            <tbody>${DAY_ORDER.map((i) => {
              const r = byDay[i] || { is_working: 0, start_time: '09:00', end_time: '17:00', slot_minutes: 20 };
              return `<tr data-day="${i}"><td class="fw-semibold">${DAYS[i]}</td>
                <td><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="work" ${r.is_working ? 'checked' : ''} aria-label="Working on ${DAYS[i]}"></div></td>
                <td><input class="form-control form-control-sm" type="time" name="start" value="${hhmm(r.start_time)}" aria-label="Start time"></td>
                <td><input class="form-control form-control-sm" type="time" name="end" value="${hhmm(r.end_time)}" aria-label="End time"></td>
                <td><input class="form-control form-control-sm" type="time" name="bs" value="${hhmm(r.break_start)}" aria-label="Break start"></td>
                <td><input class="form-control form-control-sm" type="time" name="be" value="${hhmm(r.break_end)}" aria-label="Break end"></td>
                <td><select class="form-select form-select-sm" name="slot" aria-label="Slot length">${[10, 15, 20, 30, 45, 60].map((n) => `<option value="${n}" ${Number(r.slot_minutes) === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></td></tr>`;
            }).join('')}</tbody></table></div>
          <button class="btn btn-primary" type="submit"><i class="bi bi-save me-1"></i>Save schedule</button>
        </form></div></div>
      <div class="col-xl-4"><div class="card-soft p-4">
        <h2 class="h5">Block unavailable dates</h2>
        <p class="small text-secondary">Leave, conferences or holidays. You cannot block a date that already has active appointments.</p>
        <form id="blockForm" class="mb-3" novalidate>
          <div class="mb-2"><label class="form-label small" for="bDate">Date</label><input class="form-control" type="date" id="bDate" name="date" min="${todayISO()}" required></div>
          <div class="mb-2"><label class="form-label small" for="bReason">Reason (optional)</label><input class="form-control" id="bReason" name="reason" maxlength="150"></div>
          <button class="btn btn-outline-primary w-100" type="submit">Block date</button></form>
        <h3 class="h6">Blocked dates</h3>
        ${blocked.length ? `<ul class="list-group">${blocked.map((b) => `<li class="list-group-item d-flex justify-content-between align-items-center">
          <div><div class="fw-semibold">${fmtDate(b.blocked_date)}</div>${b.reason ? `<div class="small text-secondary">${esc(b.reason)}</div>` : ''}</div>
          <button class="btn btn-sm btn-outline-danger" data-action="unblock" data-id="${b.id}" aria-label="Unblock ${esc(b.blocked_date)}"><i class="bi bi-x-lg"></i></button></li>`).join('')}</ul>`
          : '<p class="small text-secondary mb-0">No blocked dates.</p>'}
      </div></div></div>`;

    // Disable the time fields of days that are switched off.
    const syncRow = (tr) => { const on = $('[name=work]', tr).checked; $$('input:not([name=work]), select', tr).forEach((x) => { x.disabled = !on; }); };
    $$('#schedForm tbody tr', section).forEach((tr) => { syncRow(tr); $('[name=work]', tr).addEventListener('change', () => syncRow(tr)); });

    $('#schedForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const days = $$('tbody tr', e.target).map((tr) => {
        const work = $('[name=work]', tr).checked;
        return {
          day_of_week: Number(tr.dataset.day), is_working: work,
          start_time: $('[name=start]', tr).value, end_time: $('[name=end]', tr).value,
          break_start: $('[name=bs]', tr).value || null, break_end: $('[name=be]', tr).value || null,
          slot_minutes: Number($('[name=slot]', tr).value),
        };
      });
      try { toast((await busy(e.submitter, () => api('/doctor/schedule', { method: 'PUT', body: { days } }))).message); } catch (err) { fail(err); }
    });
    $('#blockForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      if (!d.date) { toast('Choose a date to block.', 'warning'); return; }
      try { toast((await busy(e.submitter, () => api('/doctor/blocked-dates', { method: 'POST', body: d }))).message); shell.reload(); } catch (err) { fail(err); }
    });
  }

  // ================================================================ PROFILE
  async function renderProfile(section) {
    const p = await api('/doctor/profile');
    const hours = p.schedule.filter((r) => r.is_working).map((r) => `${DAYS[r.day_of_week].slice(0, 3)} ${fmtTime(r.start_time)}-${fmtTime(r.end_time)}`).join(' &middot; ');
    section.innerHTML = `<div class="row g-4">
      <div class="col-lg-4"><div class="card-soft p-4 text-center">
        <img class="doc-photo mb-3" id="docPhoto" src="${photoUrl(p.photo)}" alt="Your profile photo" width="88" height="88" style="width:120px;height:120px">
        <h2 class="h5 mb-1">${esc(p.full_name)}</h2>
        <div class="text-brand fw-semibold">${esc(p.specialization)}</div>
        <div class="my-2">${p.is_verified ? '<span class="badge bg-success"><i class="bi bi-patch-check-fill me-1"></i>Verified by hospital</span>' : '<span class="badge bg-warning text-dark">Verification pending</span>'}</div>
        <label class="btn btn-outline-primary btn-sm mt-2" for="photoInput"><i class="bi bi-camera me-1"></i>Upload photo</label>
        <input type="file" id="photoInput" class="d-none" accept="image/jpeg,image/png">
        <div class="form-text">JPG or PNG, max 2 MB</div>
        <hr><dl class="row text-start small mb-0">
          <dt class="col-5">Email</dt><dd class="col-7 text-break">${esc(p.email)}</dd>
          <dt class="col-5">License no.</dt><dd class="col-7">${esc(p.license_number || '-')}</dd>
          <dt class="col-5">Consultation fee</dt><dd class="col-7 fw-semibold">${money(p.consultation_fee)}</dd>
          <dt class="col-5">Working hours</dt><dd class="col-7">${hours || 'Not set'}</dd></dl>
      </div></div>
      <div class="col-lg-8">
        <div class="card-soft p-4 mb-4"><h2 class="h5 mb-3">Edit profile</h2>
          <form id="profForm" novalidate><div class="row g-3">
            <div class="col-12"><label class="form-label" for="dName">Full name</label><input class="form-control" id="dName" name="fullName" value="${esc(p.full_name)}" maxlength="120" required></div>
            <div class="col-12"><label class="form-label" for="dQual">Qualifications</label><input class="form-control" id="dQual" name="qualifications" value="${esc(p.qualifications)}" maxlength="255" required></div>
            <div class="col-sm-6"><label class="form-label" for="dExp">Experience (years)</label><input class="form-control" type="number" id="dExp" name="experienceYears" min="0" max="70" value="${esc(p.experience_years)}" required></div>
            <div class="col-sm-6"><label class="form-label" for="dPhone">Phone</label><input class="form-control" id="dPhone" name="phone" value="${esc(p.phone || '')}" maxlength="10" inputmode="numeric" required></div>
            <div class="col-12"><label class="form-label" for="dBio">About you</label><textarea class="form-control" id="dBio" name="bio" rows="3" maxlength="1000">${esc(p.bio || '')}</textarea></div>
          </div><button class="btn btn-primary mt-3" type="submit">Save profile</button></form></div>
        <div class="card-soft p-4"><h2 class="h5 mb-3">Change password</h2>
          <form id="pwForm" novalidate><div class="row g-3">
            <div class="col-md-4"><label class="form-label" for="cpOld">Current password</label><input class="form-control" type="password" id="cpOld" name="currentPassword" autocomplete="current-password" required></div>
            <div class="col-md-4"><label class="form-label" for="cpNew">New password</label><input class="form-control" type="password" id="cpNew" name="newPassword" autocomplete="new-password" maxlength="72" required></div>
            <div class="col-md-4"><label class="form-label" for="cpConf">Confirm</label><input class="form-control" type="password" id="cpConf" name="confirm" autocomplete="new-password" required></div>
          </div><div class="form-text">8+ characters with uppercase, lowercase and a number.</div>
          <button class="btn btn-primary mt-3" type="submit">Update password</button></form></div>
      </div></div>`;

    $('#photoInput', section).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (!['image/jpeg', 'image/png'].includes(f.type) || f.size > 2 * 1024 * 1024) { toast('Choose a JPG or PNG image up to 2 MB.', 'warning'); e.target.value = ''; return; }
      const form = new FormData();
      form.append('photo', f);
      try {
        const r = await api('/doctor/photo', { method: 'POST', form });
        $('#docPhoto', section).src = photoUrl(r.photo) + '?t=' + Date.now();
        toast(r.message);
      } catch (err) { fail(err); }
    });
    $('#profForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      try { toast((await busy(e.submitter, () => api('/doctor/profile', { method: 'PUT', body: { ...d, experienceYears: Number(d.experienceYears) } }))).message); } catch (err) { fail(err); }
    });
    $('#pwForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      if (d.newPassword !== d.confirm) { toast('The new passwords do not match.', 'warning'); return; }
      try { toast((await busy(e.submitter, () => api('/auth/change-password', { method: 'POST', body: { currentPassword: d.currentPassword, newPassword: d.newPassword } }))).message); e.target.reset(); } catch (err) { fail(err); }
    });
  }

  // ================================================================ REVIEWS
  async function renderReviews(section) {
    const rows = await api('/doctor/reviews');
    const avg = rows.length ? (rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(1) : null;
    section.innerHTML = `<div class="card-soft p-4 mb-3 d-flex align-items-center gap-4 flex-wrap">
        <div class="display-6 fw-bold">${avg || '-'}</div><div>${stars(avg)}<div class="small text-secondary">${rows.length} recent review${rows.length === 1 ? '' : 's'}</div></div></div>
      ${rows.length ? rows.map((r) => `<div class="card-soft p-3 mb-2"><div class="d-flex justify-content-between"><div>${stars(r.rating)}</div><span class="small text-secondary">${fmtDate(r.created_at)}</span></div>
        <div class="fw-semibold small">${esc(r.patient_name)}</div>${r.comment ? `<div>${esc(r.comment)}</div>` : '<div class="text-secondary small">No comment</div>'}</div>`).join('')
        : emptyState('bi-star', 'No reviews yet. Patients can rate you after a completed consultation.')}`;
  }

  // =========================================================== EVENT ROUTER
  const actions = {
    accept: (el) => acceptAppt(el.dataset.id),
    reject: (el) => rejectAppt(el.dataset.id),
    cancel: (el) => cancelAppt(el.dataset.id),
    consult: (el) => openConsult(el.dataset.id),
    histScope: (el) => { histScope = el.dataset.scope; shell.reload(); },
    unblock: async (el) => {
      if (!(await confirmDialog('Unblock this date so patients can book it again?', { okText: 'Unblock' }))) return;
      toast((await api('/doctor/blocked-dates/' + el.dataset.id, { method: 'DELETE' })).message);
      shell.reload();
    },
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    const fn = el && actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve(fn(el)).catch(fail);
  });
  document.addEventListener('themechange', () => { if (shell && shell.current === 'overview') shell.reload(); });

  initShell({
    role: 'doctor',
    defaultView: 'overview',
    views: {
      overview: view('Dashboard', renderOverview),
      today: view("Today's Appointments", renderToday),
      upcoming: view('Upcoming Appointments', renderUpcoming),
      history: view('Completed & Cancelled', renderHistory),
      schedule: view('Schedule & Availability', renderSchedule),
      profile: view('My Profile', renderProfile),
      reviews: view('Patient Reviews', renderReviews),
      notifications: view('Notifications', renderNotifications),
    },
  });
})();
