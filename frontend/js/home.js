/* Homepage: loads live data (specializations, doctors, testimonials, settings) from the API. */
(function () {
  'use strict';
  const { $, $$, esc, api, photoUrl, stars, money, emptyState } = MC;
  const DASHBOARDS = { patient: '/patient-dashboard.html', doctor: '/doctor-dashboard.html', admin: '/admin-dashboard.html' };

  $('#year').textContent = new Date().getFullYear();

  // Show a dashboard button instead of "Login" when already signed in; send patients straight to booking.
  async function updateAuthUI() {
    try {
      const me = await api('/auth/me', { noRedirect: true });
      $('#authMenu').classList.add('d-none');
      $('#dashMenu').classList.remove('d-none');
      $('#dashLink').href = DASHBOARDS[me.role];
      if (me.role === 'patient') $$('.book-link').forEach((a) => { a.href = DASHBOARDS.patient + '#doctors'; });
    } catch (e) { /* not signed in: default links go to the login page */ }
  }

  async function loadSettings() {
    try {
      const s = await api('/public/settings');
      $$('[data-setting]').forEach((el) => { if (s[el.dataset.setting]) el.textContent = s[el.dataset.setting]; });
      $$('[data-setting-tel]').forEach((el) => { if (s[el.dataset.settingTel]) el.href = 'tel:' + s[el.dataset.settingTel].replace(/[^0-9+]/g, ''); });
      if (s.hospital_email) $('#mailLink').href = 'mailto:' + s.hospital_email;
      $('#statFee').textContent = money(s.default_fee || 200).replace('.00', '');
    } catch (e) { $('#statFee').textContent = '-'; }
  }

  async function loadSpecializations() {
    const grid = $('#specGrid');
    try {
      const specs = await api('/public/specializations');
      $('#statSpecs').textContent = specs.length;
      grid.innerHTML = specs.map((s) => `
        <div class="col-sm-6 col-lg-3 reveal"><div class="card-soft card-hover p-4 h-100">
          <div class="icon-bubble mb-3"><i class="bi ${/^bi-[a-z0-9-]+$/.test(s.icon) ? esc(s.icon) : 'bi-heart-pulse'}"></i></div>
          <h3 class="h6">${esc(s.name)}</h3>
          <p class="small text-secondary mb-2">${esc(s.description || '')}</p>
          <span class="small text-brand fw-semibold">${s.doctor_count} doctor${s.doctor_count === 1 ? '' : 's'}</span>
        </div></div>`).join('') || `<div class="col-12">${emptyState('bi-heart-pulse', 'Specializations will appear here soon.')}</div>`;
    } catch (e) { grid.innerHTML = `<div class="col-12"><div class="alert alert-warning">Could not load specializations. Is the server running?</div></div>`; }
    observeReveal();
  }

  async function loadDoctors() {
    const grid = $('#doctorGrid');
    try {
      const all = await api('/public/doctors?limit=100');
      $('#statDoctors').textContent = all.length;
      const docs = all.slice(0, 6);
      grid.innerHTML = docs.map((d) => `
        <div class="col-md-6 col-lg-4 reveal"><div class="card-soft card-hover p-4 h-100 text-center">
          <img class="doc-photo mb-3" src="${photoUrl(d.photo)}" alt="Photo of ${esc(d.full_name)}" width="88" height="88" loading="lazy">
          <h3 class="h6 mb-1">${esc(d.full_name)}</h3>
          <div class="text-brand small fw-semibold mb-1">${esc(d.specialization)}</div>
          <div class="small text-secondary">${esc(d.qualifications)}</div>
          <div class="small text-secondary mb-2">${d.experience_years} years experience</div>
          <div class="mb-3">${stars(d.avg_rating)}</div>
          <div class="d-flex justify-content-between align-items-center">
            <span class="fw-semibold">${money(d.consultation_fee)}</span>
            <a class="btn btn-sm btn-primary book-link" href="/login.html?role=patient&next=doctors">Book Appointment</a>
          </div>
        </div></div>`).join('') || `<div class="col-12">${emptyState('bi-person-x', 'Doctors will appear here soon.')}</div>`;
    } catch (e) { grid.innerHTML = `<div class="col-12"><div class="alert alert-warning">Could not load doctors.</div></div>`; }
    updateAuthUI(); // re-point the freshly created "Book" links
    observeReveal();
  }

  async function loadTestimonials() {
    const grid = $('#testimonialGrid');
    try {
      const items = await api('/public/testimonials');
      grid.innerHTML = items.length ? items.map((t) => `
        <div class="col-md-6 col-lg-4 reveal"><div class="card-soft p-4 h-100 testimonial">
          <div class="mb-2">${stars(t.rating)}</div>
          <q class="d-block mb-3">${esc(t.comment)}</q>
          <div class="fw-semibold">${esc(t.patient_name)}</div>
          <div class="small text-secondary">Consulted ${esc(t.doctor_name)}</div>
        </div></div>`).join('')
        : `<div class="col-12">${emptyState('bi-chat-heart', 'Patient reviews will appear here after consultations are completed.')}</div>`;
    } catch (e) { grid.innerHTML = ''; }
    observeReveal();
  }

  // Fade sections in as they scroll into view.
  let observer = null;
  function observeReveal() {
    if (!('IntersectionObserver' in window)) { $$('.reveal').forEach((el) => el.classList.add('show')); return; }
    if (!observer) {
      observer = new IntersectionObserver((entries) => entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('show'); observer.unobserve(en.target); }
      }), { threshold: 0.12 });
    }
    $$('.reveal:not(.show)').forEach((el) => observer.observe(el));
  }

  updateAuthUI();
  loadSettings();
  loadSpecializations();
  loadDoctors();
  loadTestimonials();
  observeReveal();
})();
