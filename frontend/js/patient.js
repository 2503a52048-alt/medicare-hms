/* Patient dashboard: overview, doctor search + recommendation, booking + payment,
 * appointments (reschedule / cancel / review / receipt), records & prescriptions, profile. */
(function () {
  'use strict';
  const {
    $, $$, esc, api, toast, fail, showModal, confirmDialog, askText, busy, formObj, debounce, todayISO,
    fmtDate, fmtShortDate, fmtTime, money, photoUrl, cap, badge, stars, emptyState, loadScript,
    initShell, renderNotifications, pager,
  } = MC;

  let shell = null;
  const state = { tab: 'upcoming' };
  const view = (title, fn) => ({ title, render: (section, sh) => { shell = sh; return fn(section); } });
  const spinner = '<div class="col-12 text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const statCard = (icon, label, n, color = '') => `
    <div class="col-6 col-lg-3"><div class="card-soft stat-card">
      <div class="icon-bubble ${color}"><i class="bi ${icon}"></i></div>
      <div><div class="num">${n}</div><div class="lbl">${esc(label)}</div></div></div></div>`;

  // =============================================================== OVERVIEW
  async function renderOverview(section) {
    const [d, s] = await Promise.all([api('/patient/dashboard'), api('/public/settings')]);
    const n = d.nextAppointment;
    section.innerHTML = `
      <div class="card-soft p-4 mb-4 bg-brand-soft d-flex flex-wrap justify-content-between align-items-center gap-3">
        <div><h2 class="h4 fw-bold mb-1">${esc(d.welcome)}</h2>
          <p class="mb-0 text-secondary">Find a specialist and book your next visit in a few clicks.</p></div>
        <button class="btn btn-primary btn-lg" data-action="goto" data-view="doctors"><i class="bi bi-calendar2-plus me-2"></i>Book Appointment</button>
      </div>
      <div class="row g-3 mb-4">
        ${statCard('bi-calendar-event', 'Upcoming', d.counts.upcoming)}
        ${statCard('bi-hourglass-split', 'Awaiting payment', d.counts.awaitingPayment)}
        ${statCard('bi-check2-circle', 'Completed', d.counts.completed)}
        ${statCard('bi-x-circle', 'Cancelled', d.counts.cancelled)}
      </div>
      <div class="row g-4">
        <div class="col-lg-8"><div class="card-soft p-4 h-100">
          <h3 class="h6 text-secondary text-uppercase mb-3">Your next appointment</h3>
          ${n ? `<div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
              <div><div class="h5 mb-1">${esc(n.doctor_name)}</div><div class="text-brand small fw-semibold">${esc(n.specialization)}</div>
                <div class="mt-2"><i class="bi bi-calendar3 me-1"></i>${fmtDate(n.appointment_date)} at <strong>${fmtTime(n.slot_time)}</strong></div>
                <div class="small text-secondary">ID: ${esc(n.appointment_code)}</div></div>
              <div>${badge(n.status, n.status === 'pending' ? 'Awaiting doctor' : 'Confirmed')}</div></div>`
            : emptyState('bi-calendar-x', 'No upcoming appointments. Book one to get started.')}
        </div></div>
        <div class="col-lg-4"><div class="card-soft p-4 h-100">
          <h3 class="h6 text-secondary text-uppercase mb-3">Emergency contact</h3>
          <p class="mb-2">For emergencies, do not wait for an appointment.</p>
          <a class="btn btn-danger w-100 mb-2" href="tel:${esc((s.emergency_phone || '108').replace(/[^0-9+]/g, ''))}"><i class="bi bi-telephone-fill me-2"></i>Call ${esc(s.emergency_phone || '108')}</a>
          <div class="small text-secondary">Hospital: ${esc(s.hospital_phone || '')}<br>${esc(s.hospital_address || '')}</div>
        </div></div>
      </div>`;
  }

  // ============================================================ FIND DOCTORS
  let docReq = 0;
  async function renderDoctors(section) {
    const [specs, issues] = await Promise.all([api('/public/specializations'), api('/public/health-issues')]);
    section.innerHTML = `
      <div class="card-soft p-3 p-md-4 mb-4"><div class="row g-3">
        <div class="col-lg-4"><label class="form-label" for="dq">Search by doctor or specialization</label>
          <div class="input-group"><span class="input-group-text"><i class="bi bi-search"></i></span>
          <input id="dq" class="form-control" placeholder="e.g. Priya or Cardiologist" maxlength="80"></div></div>
        <div class="col-md-6 col-lg-3"><label class="form-label" for="dspec">Specialization</label>
          <select id="dspec" class="form-select"><option value="">All specializations</option>
          ${specs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="col-md-6 col-lg-5"><label class="form-label" for="dissue">Not sure? Select your health concern</label>
          <select id="dissue" class="form-select"><option value="">Choose a health concern...</option>
          ${issues.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
      </div></div>
      <div id="dnote"></div><div class="row g-4" id="dlist">${spinner}</div>`;

    async function load() {
      const token = ++docReq;
      const q = $('#dq', section).value.trim();
      const spec = $('#dspec', section).value;
      const issue = $('#dissue', section).value;
      $('#dlist', section).innerHTML = spinner;
      let doctors;
      let note = '';
      try {
        if (issue) {
          const r = await api('/public/recommend?issueId=' + encodeURIComponent(issue));
          doctors = r.doctors;
          note = `<div class="alert alert-info"><i class="bi bi-lightbulb me-1"></i>For <strong>${esc(r.issue)}</strong> we suggest seeing a <strong>${esc(r.specialization)}</strong>. <span class="d-block small mt-1">${esc(r.disclaimer)}</span></div>`;
        } else {
          const p = new URLSearchParams({ availability: '1' });
          if (q) p.set('q', q);
          if (spec) p.set('specialization', spec);
          doctors = await api('/public/doctors?' + p.toString());
        }
      } catch (err) {
        if (token === docReq) $('#dlist', section).innerHTML = `<div class="col-12"><div class="alert alert-danger">${esc(err.message)}</div></div>`;
        return;
      }
      if (token !== docReq) return; // a newer search is already running
      $('#dnote', section).innerHTML = note;
      $('#dlist', section).innerHTML = doctors.length
        ? doctors.map(doctorCard).join('')
        : `<div class="col-12">${emptyState('bi-person-x', 'No doctors match your search. Try a different name or specialization.')}</div>`;
    }

    $('#dq', section).addEventListener('input', debounce(() => { $('#dissue', section).value = ''; load(); }));
    $('#dspec', section).addEventListener('change', () => { $('#dissue', section).value = ''; load(); });
    $('#dissue', section).addEventListener('change', () => { if ($('#dissue', section).value) { $('#dq', section).value = ''; $('#dspec', section).value = ''; } load(); });
    await load();
  }

  function doctorCard(d) {
    const slots = (d.next_slots || []).map((s) => `<span class="badge bg-brand-soft text-brand fw-medium">${esc(s.label)}</span>`).join(' ');
    const dates = (d.available_dates || []).map((x) => `<span class="badge border text-body fw-normal">${fmtShortDate(x)}</span>`).join(' ');
    return `<div class="col-md-6 col-xl-4"><div class="card-soft card-hover p-4 h-100 d-flex flex-column">
      <div class="d-flex gap-3 mb-3">
        <img class="doc-photo sm" src="${photoUrl(d.photo)}" alt="Photo of ${esc(d.full_name)}" width="56" height="56" loading="lazy">
        <div><div class="fw-bold">${esc(d.full_name)}</div><div class="small text-brand fw-semibold">${esc(d.specialization)}</div>
          <div class="small">${stars(d.avg_rating)}</div></div></div>
      <div class="small text-secondary mb-1"><i class="bi bi-mortarboard me-1"></i>${esc(d.qualifications)}</div>
      <div class="small text-secondary mb-1"><i class="bi bi-briefcase me-1"></i>${d.experience_years} years experience</div>
      <div class="small mb-3"><i class="bi bi-cash me-1"></i>Consultation fee: <strong>${money(d.consultation_fee)}</strong></div>
      <div class="mb-3 flex-grow-1">
        ${d.next_date ? `<div class="small fw-semibold mb-1">Available dates</div><div class="d-flex flex-wrap gap-1 mb-2">${dates}</div>
          <div class="small fw-semibold mb-1">Earliest slots on ${fmtShortDate(d.next_date)}</div><div class="d-flex flex-wrap gap-1">${slots}</div>`
          : '<div class="small text-danger"><i class="bi bi-calendar-x me-1"></i>No free slots in the next 14 days</div>'}
      </div>
      <div class="d-flex gap-2">
        <button class="btn btn-outline-primary flex-fill" data-action="profile" data-id="${d.id}">View Profile</button>
        <button class="btn btn-primary flex-fill" data-action="book" data-id="${d.id}" ${d.next_date ? '' : 'disabled'}>Book Appointment</button>
      </div></div></div>`;
  }

  async function openDoctorProfile(id) {
    const d = await api('/public/doctors/' + id);
    const sched = d.schedule.map((r) => `<tr><td>${DAYS[r.day_of_week]}</td><td>${r.is_working
      ? `${fmtTime(r.start_time)} - ${fmtTime(r.end_time)}${r.break_start ? ` <span class="text-secondary small">(break ${fmtTime(r.break_start)} - ${fmtTime(r.break_end)})</span>` : ''}`
      : '<span class="text-secondary">Off</span>'}</td></tr>`).join('');
    showModal({
      title: 'Doctor profile', size: 'modal-lg',
      body: `<div class="d-flex gap-3 align-items-center mb-3">
          <img class="doc-photo" src="${photoUrl(d.photo)}" alt="Photo of ${esc(d.full_name)}" width="88" height="88">
          <div><h3 class="h5 mb-1">${esc(d.full_name)} ${d.is_verified ? '<i class="bi bi-patch-check-fill text-primary" title="Verified"></i>' : ''}</h3>
            <div class="text-brand fw-semibold">${esc(d.specialization)}</div>
            <div class="small">${stars(d.avg_rating)} <span class="text-secondary">(${d.review_count} review${d.review_count === 1 ? '' : 's'})</span></div></div></div>
        <div class="row g-3 mb-3">
          <div class="col-sm-4"><div class="small text-secondary">Qualifications</div><div>${esc(d.qualifications)}</div></div>
          <div class="col-sm-4"><div class="small text-secondary">Experience</div><div>${d.experience_years} years</div></div>
          <div class="col-sm-4"><div class="small text-secondary">Consultation fee</div><div class="fw-semibold">${money(d.consultation_fee)}</div></div></div>
        ${d.bio ? `<p>${esc(d.bio)}</p>` : ''}
        <h4 class="h6">Weekly working hours</h4>
        <table class="table table-sm"><tbody>${sched}</tbody></table>
        <h4 class="h6">Next available dates</h4>
        <div class="d-flex flex-wrap gap-1 mb-3">${d.available_dates.length ? d.available_dates.map((x) => `<span class="badge bg-brand-soft text-brand">${fmtDate(x)}</span>`).join('') : '<span class="text-secondary small">No free dates in the next 14 days.</span>'}</div>
        <h4 class="h6">Patient reviews</h4>
        ${d.reviews.length ? d.reviews.map((r) => `<div class="border-bottom py-2"><div>${stars(r.rating)} <span class="small fw-semibold ms-1">${esc(r.patient_name)}</span></div>${r.comment ? `<div class="small">${esc(r.comment)}</div>` : ''}</div>`).join('') : '<p class="text-secondary small">No reviews yet.</p>'}`,
      footer: `<button class="btn btn-light" data-bs-dismiss="modal">Close</button>
               <button class="btn btn-primary" data-action="book" data-id="${d.id}" data-bs-dismiss="modal" ${d.available_dates.length ? '' : 'disabled'}>Book Appointment</button>`,
    });
  }

  // ======================================================= DATE / SLOT PICKER
  function mountPicker(root, doctorId, dates, onChange) {
    const sel = { date: null, time: null };
    root.innerHTML = `<div class="fw-semibold mb-2">Choose a date</div>
      <div class="d-flex flex-wrap gap-2 mb-3" data-dates>${dates.length
        ? dates.map((x) => `<button type="button" class="date-chip" data-date="${esc(x)}">${fmtDate(x)}</button>`).join('')
        : '<div class="alert alert-warning py-2 mb-0 w-100">No free dates in the next 14 days.</div>'}</div>
      <div class="fw-semibold mb-2">Choose a time slot</div>
      <div data-slots><div class="text-secondary small">Select a date to see the available time slots.</div></div>`;

    async function loadSlots() {
      const box = $('[data-slots]', root);
      box.innerHTML = '<div class="text-secondary small">Loading slots...</div>';
      try {
        const r = await api(`/public/doctors/${doctorId}/slots?date=${encodeURIComponent(sel.date)}`);
        const free = r.slots.filter((s) => s.available).length;
        box.innerHTML = r.slots.length
          ? `<div class="slot-grid">${r.slots.map((s) => `<button type="button" class="slot-btn ${s.time === sel.time && s.available ? 'selected' : ''}" data-time="${esc(s.time)}" ${s.available ? '' : 'disabled title="Already booked"'}>${esc(s.label)}</button>`).join('')}</div>
             <div class="small text-secondary mt-2">${free} slot${free === 1 ? '' : 's'} free. Booked slots are crossed out.</div>`
          : `<div class="alert alert-warning py-2 mb-0">${esc(r.reason || 'No slots on this date.')}</div>`;
        if (sel.time && !r.slots.some((s) => s.time === sel.time && s.available)) { sel.time = null; onChange(sel); }
      } catch (err) { box.innerHTML = `<div class="alert alert-danger py-2 mb-0">${esc(err.message)}</div>`; }
    }

    root.addEventListener('click', (e) => {
      const dc = e.target.closest('[data-date]');
      if (dc) {
        sel.date = dc.dataset.date; sel.time = null;
        $$('[data-date]', root).forEach((b) => b.classList.toggle('selected', b === dc));
        onChange(sel);
        loadSlots();
        return;
      }
      const sb = e.target.closest('[data-time]');
      if (sb && !sb.disabled) {
        sel.time = sb.dataset.time;
        $$('[data-time]', root).forEach((b) => b.classList.toggle('selected', b === sb));
        onChange(sel);
      }
    });
    return { selection: sel, refresh: () => { if (sel.date) loadSlots(); } };
  }

  // ===================================================== BOOKING + PAYMENT
  async function openBooking(doctorId) {
    const doc = await api('/public/doctors/' + doctorId);
    const m = showModal({
      title: 'Book appointment', size: 'modal-lg',
      body: `<div class="d-flex gap-3 align-items-center mb-3">
          <img class="doc-photo sm" src="${photoUrl(doc.photo)}" alt="" width="56" height="56">
          <div><div class="fw-bold">${esc(doc.full_name)}</div><div class="small text-brand fw-semibold">${esc(doc.specialization)}</div>
            <div class="small text-secondary">Consultation fee: <strong>${money(doc.consultation_fee)}</strong></div></div></div>
        <div id="picker"></div>
        <div class="mt-3"><label class="form-label" for="bkReason">Reason for consultation</label>
          <textarea id="bkReason" class="form-control" rows="3" maxlength="500" placeholder="Briefly describe your symptoms or the reason for your visit"></textarea>
          <div class="invalid-feedback">Please describe the reason (at least 5 characters).</div></div>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Close</button><button class="btn btn-primary" id="bkGo">Confirm &amp; continue to payment</button>',
    });
    const picker = mountPicker($('#picker', m.el), doc.id, doc.available_dates, () => {});
    $('#bkGo', m.el).addEventListener('click', async (e) => {
      const sel = picker.selection;
      if (!sel.date || !sel.time) { toast('Please select a date and a time slot.', 'warning'); return; }
      const reasonEl = $('#bkReason', m.el);
      const reason = reasonEl.value.trim();
      reasonEl.classList.toggle('is-invalid', reason.length < 5);
      if (reason.length < 5) return;
      try {
        const r = await busy(e.currentTarget, () => api('/patient/appointments', { method: 'POST', body: { doctorId: doc.id, date: sel.date, time: sel.time, reason } }));
        showPayment(m, { appointmentId: r.appointmentId, code: r.appointmentCode, amount: r.amount, doctorName: doc.full_name, date: sel.date, time: sel.time, holdMinutes: r.holdMinutes });
      } catch (err) { fail(err); if (err.status === 409) picker.refresh(); }
    });
  }

  const METHODS = { upi: ['bi-phone', 'UPI', 'Google Pay, PhonePe, Paytm and more'], card: ['bi-credit-card', 'Debit / Credit card', 'Visa, Mastercard, RuPay'], netbanking: ['bi-bank', 'Net banking', 'All major banks'] };
  const setFooter = (m, html) => {
    let f = $('.modal-footer', m.el);
    if (!f) { f = document.createElement('div'); f.className = 'modal-footer'; $('.modal-content', m.el).appendChild(f); }
    f.innerHTML = html;
    return f;
  };
  const summaryBox = (info) => `<div class="mb-3 p-3 rounded bg-brand-soft">
      <div class="fw-semibold">${esc(info.doctorName)}</div>
      <div class="small">${fmtDate(info.date)} at ${fmtTime(info.time)}</div>
      <div class="small text-secondary">Appointment ID: <strong>${esc(info.code)}</strong></div>
      <div class="fs-4 fw-bold mt-2">${money(info.amount)}</div></div>`;

  function showPayment(m, info, opts = {}) {
    clearInterval(m.timer);
    m.setBody(`${summaryBox(info)}
      ${info.holdMinutes
        ? '<div class="alert alert-warning py-2 small">Slot reserved for <strong id="holdLeft"></strong>. Complete the payment to send your request to the doctor.</div>'
        : '<div class="alert alert-warning py-2 small">Please complete the payment soon. Unpaid slots are released automatically.</div>'}
      ${opts.error ? `<div class="alert alert-danger py-2">${esc(opts.error)}</div>` : ''}
      <div id="payErr"></div>
      <div class="fw-semibold mb-2">Select payment method</div>
      ${Object.entries(METHODS).map(([k, [ic, label, sub]], i) => `<label class="pay-option mb-2">
          <input type="radio" class="form-check-input" name="pm" value="${k}" ${i === 0 ? 'checked' : ''}><i class="bi ${ic} fs-4"></i>
          <span>${label}<br><small class="text-secondary">${sub}</small></span></label>`).join('')}`);
    setFooter(m, `<button class="btn btn-light" data-bs-dismiss="modal">Pay later</button><button class="btn btn-primary" id="payGo">Pay ${money(info.amount)}</button>`);

    if (info.holdMinutes) {
      const end = info.holdEnds || (info.holdEnds = Date.now() + info.holdMinutes * 60000);
      const tick = () => {
        const left = end - Date.now();
        const el = $('#holdLeft', m.el);
        if (left <= 0) {
          clearInterval(m.timer);
          m.setBody('<div class="alert alert-danger">This reservation has expired and the slot was released. Please book again.</div>');
          setFooter(m, '<button class="btn btn-primary" data-bs-dismiss="modal">Close</button>');
          return;
        }
        if (el) el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} minutes`;
      };
      tick();
      m.timer = setInterval(tick, 1000);
      m.el.addEventListener('hidden.bs.modal', () => clearInterval(m.timer), { once: true });
    }

    $('#payGo', m.el).addEventListener('click', async (e) => {
      const method = $('input[name="pm"]:checked', m.el).value;
      try {
        const init = await busy(e.currentTarget, () => api('/payments/initiate', { method: 'POST', body: { appointmentId: info.appointmentId, method } }));
        if (init.mode === 'razorpay') await razorpayFlow(m, info, init); else testGateway(m, info, init, method);
      } catch (err) { $('#payErr', m.el).innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`; }
    });
  }

  // Built-in simulated gateway. Clearly labelled; no real money moves.
  function testGateway(m, info, init, method) {
    m.setBody(`${summaryBox(info)}
      <div class="test-banner mb-3"><strong>TEST MODE PAYMENT GATEWAY</strong><br>${esc(init.notice)}</div>
      <dl class="row small mb-0">
        <dt class="col-5">Method</dt><dd class="col-7">${esc(METHODS[method][1])}</dd>
        <dt class="col-5">Transaction reference</dt><dd class="col-7">${esc(init.transactionRef)}</dd>
        <dt class="col-5">Amount</dt><dd class="col-7">${money(init.amount)}</dd></dl>`);
    setFooter(m, `<button class="btn btn-light" id="payBack">Back</button>
      <button class="btn btn-outline-danger" id="payFail">Simulate failed payment</button>
      <button class="btn btn-success" id="payOk">Complete test payment</button>`);
    $('#payBack', m.el).addEventListener('click', () => showPayment(m, info));
    const run = async (simulate, btn) => {
      try {
        const r = await busy(btn, () => api('/payments/confirm', { method: 'POST', body: { appointmentId: info.appointmentId, simulate } }));
        showSuccess(m, info, r);
      } catch (err) {
        if (err.status === 402) showPayment(m, info, { error: err.message }); else fail(err);
      }
    };
    $('#payOk', m.el).addEventListener('click', (e) => run('success', e.currentTarget));
    $('#payFail', m.el).addEventListener('click', (e) => run('failure', e.currentTarget));
  }

  // Razorpay Checkout (PAYMENT_MODE=razorpay). The server verifies the signature before marking it paid.
  async function razorpayFlow(m, info, init) {
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    const me = shell.me || {};
    await new Promise((resolve) => {
      const rz = new window.Razorpay({
        key: init.keyId, amount: Math.round(init.amount * 100), currency: 'INR', order_id: init.orderId,
        name: 'MediCare Hospital', description: `Consultation ${info.code}`,
        prefill: { name: me.name, email: me.email, contact: me.mobile },
        theme: { color: '#0b5ed7' },
        handler: async (resp) => {
          try {
            const r = await api('/payments/confirm', { method: 'POST', body: { appointmentId: info.appointmentId, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature } });
            showSuccess(m, info, r);
          } catch (err) { fail(err); }
          resolve();
        },
        modal: { ondismiss: () => { toast('Payment window closed. You can try again.', 'warning'); resolve(); } },
      });
      rz.on('payment.failed', (r) => toast((r.error && r.error.description) || 'Payment failed.', 'danger'));
      rz.open();
    });
  }

  function showSuccess(m, info, r) {
    clearInterval(m.timer);
    m.setBody(`<div class="text-center py-3">
        <i class="bi bi-check-circle-fill text-success" style="font-size:3.5rem"></i>
        <h3 class="h5 mt-2">Payment successful</h3>
        <p class="text-secondary">Your request has been sent to ${esc(info.doctorName)}. You will be notified when it is confirmed.</p>
        <dl class="row text-start small mx-auto" style="max-width:360px">
          <dt class="col-6">Appointment ID</dt><dd class="col-6">${esc(r.appointmentCode)}</dd>
          <dt class="col-6">Receipt no.</dt><dd class="col-6">${esc(r.receiptNo)}</dd>
          <dt class="col-6">Transaction ref.</dt><dd class="col-6">${esc(r.transactionRef)}</dd>
          <dt class="col-6">Amount paid</dt><dd class="col-6">${money(info.amount)}</dd></dl></div>`);
    setFooter(m, `<a class="btn btn-outline-primary" href="/api/payments/receipt/${info.appointmentId}"><i class="bi bi-download me-1"></i>Download receipt</a>
      <button class="btn btn-primary" data-action="goto" data-view="appointments" data-bs-dismiss="modal">View my appointments</button>`);
    m.el.addEventListener('hidden.bs.modal', () => { if (['overview', 'appointments'].includes(shell.current)) shell.reload(); }, { once: true });
  }

  function openPaymentFor(a) {
    const m = showModal({ title: 'Complete payment', body: '', footer: '<span></span>' });
    showPayment(m, { appointmentId: a.id, code: a.appointment_code, amount: a.fee, doctorName: a.doctor_name, date: a.appointment_date, time: a.slot_time });
    m.el.addEventListener('hidden.bs.modal', () => { if (shell.current === 'appointments') shell.reload(); }, { once: true });
  }

  // ============================================================ APPOINTMENTS
  const TABS = [['upcoming', 'Upcoming'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All history']];
  const apptCache = new Map();

  async function renderAppointments(section) {
    section.innerHTML = `<ul class="nav nav-pills mb-3 gap-1">${TABS.map(([k, l]) => `<li class="nav-item"><button class="nav-link ${state.tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}">${l}</button></li>`).join('')}</ul>
      <div class="row g-3" id="apList">${spinner}</div>`;
    const list = await api('/patient/appointments?status=' + state.tab);
    apptCache.clear();
    list.forEach((a) => apptCache.set(a.id, a));
    $('#apList', section).innerHTML = list.length ? list.map(apptCard).join('')
      : `<div class="col-12">${emptyState('bi-calendar-x', 'No appointments here yet.')}</div>`;
  }

  function apptStatus(a) {
    if (a.awaiting_payment) return badge('pending', 'Awaiting payment');
    if (a.status === 'pending') return badge('pending', 'Awaiting doctor');
    return badge(a.status);
  }

  function apptCard(a) {
    const paid = ['success', 'refunded'].includes(a.payment_status);
    const live = ['pending', 'confirmed'].includes(a.status);
    const act = [];
    const b = (action, label, cls, icon) => `<button class="btn btn-sm btn-${cls}" data-action="${action}" data-id="${a.id}"><i class="bi ${icon} me-1"></i>${label}</button>`;
    if (a.awaiting_payment) act.push(b('pay', 'Pay now', 'primary', 'bi-credit-card'), b('cancel', 'Cancel', 'outline-danger', 'bi-x-circle'));
    else if (live) act.push(b('reschedule', 'Reschedule', 'outline-primary', 'bi-arrow-repeat'), b('cancel', 'Cancel', 'outline-danger', 'bi-x-circle'));
    if (paid) act.push(`<a class="btn btn-sm btn-outline-secondary" href="/api/payments/receipt/${a.id}"><i class="bi bi-download me-1"></i>Receipt</a>`);
    if (a.status === 'completed') {
      if (a.has_prescription) act.push(`<button class="btn btn-sm btn-outline-primary" data-action="goto" data-view="records"><i class="bi bi-file-medical me-1"></i>Prescription</button>`);
      if (!a.reviewed) act.push(b('review', 'Rate doctor', 'warning', 'bi-star'));
    }
    return `<div class="col-lg-6"><div class="card-soft p-3 h-100">
      <div class="d-flex gap-3">
        <img class="doc-photo sm" src="${photoUrl(a.photo)}" alt="" width="56" height="56" loading="lazy">
        <div class="flex-grow-1">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div><div class="fw-bold">${esc(a.doctor_name)}</div><div class="small text-brand fw-semibold">${esc(a.specialization)}</div></div>
            <div class="text-end">${apptStatus(a)}${a.payment_status === 'refunded' ? ' ' + badge('refunded', 'Refunded') : ''}</div></div>
          <div class="mt-2"><i class="bi bi-calendar3 me-1"></i>${fmtDate(a.appointment_date)} at <strong>${fmtTime(a.slot_time)}</strong></div>
          <div class="small text-secondary">ID: ${esc(a.appointment_code)}${a.amount ? ` &middot; ${money(a.amount)}` : ''}</div>
          <div class="small mt-1">${esc(a.reason)}</div>
          ${a.cancel_reason ? `<div class="small text-danger mt-1">Reason: ${esc(a.cancel_reason)} (by ${esc(a.cancelled_by || 'n/a')})</div>` : ''}
        </div></div>
      ${act.length ? `<div class="d-flex flex-wrap gap-2 mt-3">${act.join('')}</div>` : ''}
    </div></div>`;
  }

  async function cancelAppointment(id) {
    const reason = await askText({
      title: 'Cancel appointment', required: false, danger: true, okText: 'Cancel appointment',
      label: 'Reason (optional). Refunds apply only when you cancel at least 2 hours before the appointment.',
    });
    if (reason === null) return;
    const r = await api(`/patient/appointments/${id}/cancel`, { method: 'POST', body: { reason } });
    toast(r.message);
    shell.reload();
  }

  async function openReschedule(id) {
    const a = apptCache.get(id);
    const doc = await api('/public/doctors/' + a.doctor_id);
    const m = showModal({
      title: 'Reschedule appointment', size: 'modal-lg',
      body: `<p class="small text-secondary">Currently: <strong>${fmtDate(a.appointment_date)} at ${fmtTime(a.slot_time)}</strong> with ${esc(a.doctor_name)}</p><div id="picker"></div>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Close</button><button class="btn btn-primary" id="rsGo">Confirm new time</button>',
    });
    const picker = mountPicker($('#picker', m.el), doc.id, doc.available_dates, () => {});
    $('#rsGo', m.el).addEventListener('click', async (e) => {
      const sel = picker.selection;
      if (!sel.date || !sel.time) { toast('Select a new date and time slot.', 'warning'); return; }
      try {
        const r = await busy(e.currentTarget, () => api(`/patient/appointments/${id}/reschedule`, { method: 'PUT', body: { date: sel.date, time: sel.time } }));
        toast(r.message); m.hide(); shell.reload();
      } catch (err) { fail(err); if (err.status === 409) picker.refresh(); }
    });
  }

  function openReview(id) {
    let rating = 0;
    const m = showModal({
      title: 'Rate your consultation',
      body: `<div class="star-pick text-center mb-3" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
        <label class="form-label" for="rvText">Comment (optional)</label>
        <textarea id="rvText" class="form-control" rows="3" maxlength="500"></textarea>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="rvGo">Submit review</button>',
    });
    $('#stars', m.el).addEventListener('click', (e) => {
      const s = e.target.closest('[data-star]');
      if (!s) return;
      rating = Number(s.dataset.star);
      $$('[data-star]', m.el).forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= rating));
    });
    $('#rvGo', m.el).addEventListener('click', async (e) => {
      if (!rating) { toast('Please choose a star rating.', 'warning'); return; }
      try {
        const r = await busy(e.currentTarget, () => api(`/patient/appointments/${id}/review`, { method: 'POST', body: { rating, comment: $('#rvText', m.el).value.trim() } }));
        toast(r.message); m.hide(); shell.reload();
      } catch (err) { fail(err); }
    });
  }

  // ============================================================== RECORDS
  async function renderRecords(section) {
    const [rx, recs] = await Promise.all([api('/patient/prescriptions'), api('/patient/records')]);
    section.innerHTML = `
      <h2 class="h5 mb-3">Prescriptions</h2>
      <div class="row g-3 mb-4">${rx.length ? rx.map((p) => `<div class="col-lg-6"><div class="card-soft p-3 h-100">
        <div class="d-flex justify-content-between"><div><div class="fw-bold">${esc(p.doctor_name)}</div><div class="small text-brand">${esc(p.specialization)}</div></div>
          <div class="small text-secondary text-end">${fmtDate(p.appointment_date)}<br>${esc(p.appointment_code)}</div></div>
        ${p.diagnosis ? `<div class="mt-2 small text-secondary">Diagnosis</div><div>${esc(p.diagnosis)}</div>` : ''}
        <div class="mt-2 small text-secondary">Medicines</div><div style="white-space:pre-wrap">${esc(p.medicines)}</div>
        ${p.instructions ? `<div class="mt-2 small text-secondary">Instructions</div><div style="white-space:pre-wrap">${esc(p.instructions)}</div>` : ''}
        ${p.has_file ? `<a class="btn btn-sm btn-outline-primary mt-3" target="_blank" rel="noopener" href="/api/files/prescription/${p.id}"><i class="bi bi-paperclip me-1"></i>Open attached file</a>` : ''}
      </div></div>`).join('') : `<div class="col-12">${emptyState('bi-file-earmark-medical', 'No prescriptions yet. They appear here after your consultations.')}</div>`}</div>
      <div class="d-flex justify-content-between align-items-center mb-3"><h2 class="h5 mb-0">Medical history</h2>
        <button class="btn btn-sm btn-primary" data-action="addRecord"><i class="bi bi-plus-lg me-1"></i>Add record</button></div>
      <div class="card-soft">${recs.length ? `<ul class="list-group list-group-flush">${recs.map((r) => `<li class="list-group-item d-flex justify-content-between align-items-start gap-3 py-3">
          <div><span class="badge bg-brand-soft text-brand me-2">${esc(cap(r.record_type.replace('_', ' ')))}</span><strong>${esc(r.title)}</strong>
            <div class="small text-secondary">${fmtDate(r.record_date)}${r.doctor_name ? ` &middot; ${esc(r.doctor_name)}` : ' &middot; added by you'}</div>
            ${r.details ? `<div class="small mt-1" style="white-space:pre-wrap">${esc(r.details)}</div>` : ''}</div>
          ${r.added_by_me ? `<button class="btn btn-sm btn-outline-danger" data-action="delRecord" data-id="${r.id}" aria-label="Delete record"><i class="bi bi-trash"></i></button>` : ''}
        </li>`).join('')}</ul>` : emptyState('bi-journal-medical', 'No history recorded yet.')}</div>`;
  }

  function openAddRecord() {
    const m = showModal({
      title: 'Add to medical history',
      body: `<form id="recForm" novalidate>
        <div class="row g-3">
          <div class="col-sm-6"><label class="form-label" for="rType">Type</label><select class="form-select" id="rType" name="recordType">
            <option value="condition">Condition</option><option value="allergy">Allergy</option><option value="surgery">Surgery</option>
            <option value="vaccination">Vaccination</option><option value="lab_report">Lab report</option><option value="note">Note</option></select></div>
          <div class="col-sm-6"><label class="form-label" for="rDate">Date</label><input class="form-control" type="date" id="rDate" name="recordDate" max="${todayISO()}" value="${todayISO()}" required></div>
          <div class="col-12"><label class="form-label" for="rTitle">Title</label><input class="form-control" id="rTitle" name="title" maxlength="150" required></div>
          <div class="col-12"><label class="form-label" for="rDetails">Details (optional)</label><textarea class="form-control" id="rDetails" name="details" rows="3" maxlength="2000"></textarea></div>
        </div></form>`,
      footer: '<button class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="recGo">Save record</button>',
    });
    $('#recGo', m.el).addEventListener('click', async (e) => {
      const d = formObj($('#recForm', m.el));
      if (d.title.length < 2) { toast('Enter a title.', 'warning'); return; }
      try {
        const r = await busy(e.currentTarget, () => api('/patient/records', { method: 'POST', body: d }));
        toast(r.message); m.hide(); shell.reload();
      } catch (err) { fail(err); }
    });
  }

  // ============================================================== PROFILE
  async function renderProfile(section) {
    const p = await api('/patient/profile');
    section.innerHTML = `<div class="row g-4">
      <div class="col-lg-7"><div class="card-soft p-4">
        <h2 class="h5 mb-3">Personal details</h2>
        <form id="profForm" novalidate>
          <div class="row g-3">
            <div class="col-12"><label class="form-label" for="pName">Full name</label><input class="form-control" id="pName" name="fullName" value="${esc(p.full_name)}" maxlength="120" required></div>
            <div class="col-6"><label class="form-label" for="pAge">Age</label><input class="form-control" id="pAge" name="age" type="number" min="1" max="120" value="${esc(p.age)}" required></div>
            <div class="col-6"><label class="form-label" for="pGender">Gender</label><select class="form-select" id="pGender" name="gender">
              ${['male', 'female', 'other'].map((g) => `<option value="${g}" ${p.gender === g ? 'selected' : ''}>${cap(g)}</option>`).join('')}</select></div>
            <div class="col-6"><label class="form-label" for="pBlood">Blood group</label><select class="form-select" id="pBlood" name="bloodGroup"><option value="">Not set</option>
              ${['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => `<option ${p.blood_group === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
            <div class="col-6"><label class="form-label" for="pMobile">Mobile (verified)</label><input class="form-control" id="pMobile" value="+91 ${esc(p.mobile)}" disabled></div>
            <div class="col-12"><label class="form-label" for="pEmail">Email</label><input class="form-control" id="pEmail" value="${esc(p.email)}" disabled></div>
            <div class="col-12"><label class="form-label" for="pAddr">Address</label><input class="form-control" id="pAddr" name="address" value="${esc(p.address || '')}" maxlength="255"></div>
          </div>
          <button class="btn btn-primary mt-3" type="submit">Save changes</button>
        </form></div>
        <div class="card-soft p-4 mt-4 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div><h2 class="h6 mb-0">Appointment history</h2><span class="small text-secondary">All your past and upcoming appointments</span></div>
          <button class="btn btn-outline-primary" data-action="history">View history</button></div></div>
      <div class="col-lg-5"><div class="card-soft p-4">
        <h2 class="h5 mb-3">Change password</h2>
        <form id="pwForm" novalidate>
          <div class="mb-3"><label class="form-label" for="cpOld">Current password</label><input class="form-control" type="password" id="cpOld" name="currentPassword" autocomplete="current-password" required></div>
          <div class="mb-3"><label class="form-label" for="cpNew">New password</label><input class="form-control" type="password" id="cpNew" name="newPassword" autocomplete="new-password" maxlength="72" required>
            <div class="form-text">8+ characters with uppercase, lowercase and a number.</div></div>
          <div class="mb-3"><label class="form-label" for="cpConf">Confirm new password</label><input class="form-control" type="password" id="cpConf" name="confirm" autocomplete="new-password" required></div>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form></div></div></div>`;

    $('#profForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      try {
        const r = await busy(e.submitter, () => api('/patient/profile', { method: 'PUT', body: { fullName: d.fullName, age: Number(d.age), gender: d.gender, bloodGroup: d.bloodGroup, address: d.address } }));
        toast(r.message);
        $$('[data-me="name"]').forEach((el) => { el.textContent = d.fullName; });
      } catch (err) { fail(err); }
    });
    $('#pwForm', section).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formObj(e.target);
      if (d.newPassword !== d.confirm) { toast('The new passwords do not match.', 'warning'); return; }
      try {
        const r = await busy(e.submitter, () => api('/auth/change-password', { method: 'POST', body: { currentPassword: d.currentPassword, newPassword: d.newPassword } }));
        toast(r.message); e.target.reset();
      } catch (err) { fail(err); }
    });
  }

  // ========================================================== EVENT ROUTER
  const actions = {
    goto: (el) => shell.go(el.dataset.view),
    profile: (el) => openDoctorProfile(Number(el.dataset.id)),
    book: (el) => openBooking(Number(el.dataset.id)),
    tab: (el) => { state.tab = el.dataset.tab; shell.reload(); },
    pay: (el) => openPaymentFor(apptCache.get(Number(el.dataset.id))),
    cancel: (el) => cancelAppointment(Number(el.dataset.id)),
    reschedule: (el) => openReschedule(Number(el.dataset.id)),
    review: (el) => openReview(Number(el.dataset.id)),
    addRecord: () => openAddRecord(),
    delRecord: async (el) => {
      if (!(await confirmDialog('Delete this record from your medical history?', { danger: true, okText: 'Delete' }))) return;
      toast((await api('/patient/records/' + el.dataset.id, { method: 'DELETE' })).message);
      shell.reload();
    },
    history: () => { state.tab = 'all'; shell.go('appointments'); },
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    const fn = el && actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve(fn(el, e)).catch(fail);
  });

  initShell({
    role: 'patient',
    defaultView: 'overview',
    views: {
      overview: view('Dashboard', renderOverview),
      doctors: view('Find Doctors & Book Appointment', renderDoctors),
      appointments: view('My Appointments', renderAppointments),
      records: view('Prescriptions & Medical History', renderRecords),
      profile: view('My Profile', renderProfile),
      notifications: view('Notifications', renderNotifications),
    },
  });
})();
