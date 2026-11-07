// Creates FICTIONAL demonstration accounts and sample appointments. DEVELOPMENT ONLY.
//   npm run db:seed
// All demo accounts share the password in SEED_DEMO_PASSWORD (.env). Nothing is hardcoded here.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./config/db');
const ids = require('./utils/ids');
const { todayISO, addDays, dayOfWeek } = require('./utils/slots');

const DOCTORS = [
  { name: 'Dr. Anil Kumar',    spec: 'General Physician', qual: 'MBBS, MD (General Medicine)', exp: 12, mobile: '9000000101', email: 'dr.anil@medicare.example' },
  { name: 'Dr. Priya Sharma',  spec: 'Cardiologist',      qual: 'MBBS, MD, DM (Cardiology)',   exp: 15, mobile: '9000000102', email: 'dr.priya@medicare.example' },
  { name: 'Dr. Rahul Verma',   spec: 'Dermatologist',     qual: 'MBBS, MD (Dermatology)',      exp: 9,  mobile: '9000000103', email: 'dr.rahul@medicare.example' },
  { name: 'Dr. Meera Nair',    spec: 'Ophthalmologist',   qual: 'MBBS, MS (Ophthalmology)',    exp: 11, mobile: '9000000104', email: 'dr.meera@medicare.example' },
  { name: 'Dr. Suresh Reddy',  spec: 'Orthopedic',        qual: 'MBBS, MS (Orthopaedics)',     exp: 14, mobile: '9000000105', email: 'dr.suresh@medicare.example' },
  { name: 'Dr. Kavya Rao',     spec: 'Dentist',           qual: 'BDS, MDS (Prosthodontics)',   exp: 8,  mobile: '9000000106', email: 'dr.kavya@medicare.example' },
  { name: 'Dr. Arvind Menon',  spec: 'Neurologist',       qual: 'MBBS, MD, DM (Neurology)',    exp: 16, mobile: '9000000107', email: 'dr.arvind@medicare.example' },
  { name: 'Dr. Fatima Sheikh', spec: 'Pediatrician',      qual: 'MBBS, MD (Pediatrics)',       exp: 10, mobile: '9000000108', email: 'dr.fatima@medicare.example' },
];

const PATIENTS = [
  { name: 'Ravi Teja',   age: 34, gender: 'male',   mobile: '9000000201', email: 'ravi.teja@patient.example' },
  { name: 'Sneha Reddy', age: 27, gender: 'female', mobile: '9000000202', email: 'sneha.reddy@patient.example' },
  { name: 'Arjun Rao',   age: 45, gender: 'male',   mobile: '9000000203', email: 'arjun.rao@patient.example' },
];

const REVIEWS = [
  [5, 'Very patient doctor who explained everything clearly. Booking was quick and simple.'],
  [5, 'Excellent consultation and no long waiting time. Highly recommended.'],
  [4, 'Good experience overall. The online slot booking saved a lot of time.'],
  [4, 'Professional staff and a clean hospital. The doctor listened carefully.'],
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
  }
  const demoPassword = process.env.SEED_DEMO_PASSWORD;
  if (!demoPassword) {
    console.error('Set SEED_DEMO_PASSWORD in .env first (see .env.example).');
    process.exit(1);
  }
  const [exists] = await pool.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (exists.length) {
    console.log('Demo data already present (an admin exists). Run npm run db:init first to reset.');
    return;
  }

  const hash = await bcrypt.hash(demoPassword, 12);
  const [specRows] = await pool.execute('SELECT id, name FROM specializations');
  const specId = Object.fromEntries(specRows.map((s) => [s.name, s.id]));

  // Admin
  await pool.execute(
    "INSERT INTO users (email, mobile, password_hash, role, mobile_verified) VALUES ('admin@medicare.example', '9000000001', ?, 'admin', 1)",
    [hash]
  );

  // Doctors (verified) + Mon-Sat 09:00-17:00 schedule, lunch break 13:00-14:00, 20-minute slots
  const doctorIds = [];
  for (const [i, d] of DOCTORS.entries()) {
    const [u] = await pool.execute(
      "INSERT INTO users (email, mobile, password_hash, role, mobile_verified) VALUES (?, ?, ?, 'doctor', 1)",
      [d.email, d.mobile, hash]
    );
    const [doc] = await pool.execute(
      `INSERT INTO doctors (user_id, specialization_id, full_name, qualifications, experience_years,
                            license_number, phone, consultation_fee, bio, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, 200.00, ?, 1)`,
      [u.insertId, specId[d.spec], d.name, d.qual, d.exp, `DEMO-LIC-${1001 + i}`, d.mobile,
       `${d.name} is a ${d.spec.toLowerCase()} with ${d.exp} years of clinical experience at MediCare Hospital.`]
    );
    doctorIds.push(doc.insertId);
    for (let day = 1; day <= 6; day++) {
      await pool.execute(
        `INSERT INTO doctor_availability (doctor_id, day_of_week, is_working, start_time, end_time, break_start, break_end, slot_minutes)
         VALUES (?, ?, 1, '09:00', '17:00', '13:00', '14:00', 20)`,
        [doc.insertId, day]
      );
    }
    await pool.execute(
      'INSERT INTO doctor_availability (doctor_id, day_of_week, is_working, start_time, end_time) VALUES (?, 0, 0, \'09:00\', \'17:00\')',
      [doc.insertId]
    );
  }

  // Patients
  const patientIds = [];
  for (const p of PATIENTS) {
    const [u] = await pool.execute(
      "INSERT INTO users (email, mobile, password_hash, role, mobile_verified) VALUES (?, ?, ?, 'patient', 1)",
      [p.email, p.mobile, hash]
    );
    const [pt] = await pool.execute(
      'INSERT INTO patients (user_id, full_name, age, gender) VALUES (?, ?, ?, ?)',
      [u.insertId, p.name, p.age, p.gender]
    );
    patientIds.push(pt.insertId);
  }

  // Completed past appointments with successful payments and reviews (feeds charts and testimonials)
  const today = todayISO();
  const times = ['10:00', '10:20', '11:00', '11:40'];
  for (let k = 0; k < 4; k++) {
    const apptDate = addDays(today, -(k + 2));
    const doctorId = doctorIds[k % doctorIds.length];
    const patientId = patientIds[k % patientIds.length];
    const [a] = await pool.execute(
      `INSERT INTO appointments (appointment_code, patient_id, doctor_id, appointment_date, slot_time, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
      [ids.appointmentCode(), patientId, doctorId, apptDate, times[k], 'General consultation (demo data)']
    );
    await pool.execute(
      `INSERT INTO payments (appointment_id, patient_id, amount, method, status, mode, transaction_ref, receipt_no, paid_at)
       VALUES (?, ?, 200.00, ?, 'success', 'test', ?, ?, ?)`,
      [a.insertId, patientId, ['upi', 'card', 'netbanking', 'upi'][k], ids.transactionRef(), ids.receiptNo(), `${apptDate} ${times[k]}:00`]
    );
    await pool.execute(
      'INSERT INTO reviews (appointment_id, patient_id, doctor_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [a.insertId, patientId, doctorId, REVIEWS[k][0], REVIEWS[k][1]]
    );
    if (k === 0) {
      await pool.execute(
        `INSERT INTO prescriptions (appointment_id, doctor_id, patient_id, diagnosis, medicines, instructions)
         VALUES (?, ?, ?, 'Seasonal viral fever (demo)', 'Paracetamol 500 mg - twice daily for 3 days', 'Drink plenty of fluids and rest.')`,
        [a.insertId, doctorId, patientId]
      );
      await pool.execute(
        "INSERT INTO medical_records (patient_id, doctor_id, record_type, title, details, record_date) VALUES (?, ?, 'note', 'Fever consultation', 'Advised rest and hydration (demo record).', ?)",
        [patientId, doctorId, apptDate]
      );
    }
  }

  // Two upcoming confirmed + paid appointments on the next working days
  let upcoming = addDays(today, 1);
  for (let k = 0; k < 2; k++) {
    while (dayOfWeek(upcoming) === 0) upcoming = addDays(upcoming, 1); // skip Sundays
    const [a] = await pool.execute(
      `INSERT INTO appointments (appointment_code, patient_id, doctor_id, appointment_date, slot_time, reason, status)
       VALUES (?, ?, ?, ?, '09:40', 'Follow-up consultation (demo data)', 'confirmed')`,
      [ids.appointmentCode(), patientIds[k], doctorIds[0], upcoming]
    );
    await pool.execute(
      `INSERT INTO payments (appointment_id, patient_id, amount, method, status, mode, transaction_ref, receipt_no, paid_at)
       VALUES (?, ?, 200.00, 'upi', 'success', 'test', ?, ?, NOW())`,
      [a.insertId, patientIds[k], ids.transactionRef(), ids.receiptNo()]
    );
    upcoming = addDays(upcoming, 1);
  }

  console.log('Demo data created.\n');
  console.log('Admin   : admin@medicare.example');
  console.log('Doctors : dr.anil@medicare.example, dr.priya@medicare.example, ... (see backend/seed.js)');
  console.log('Patients: ravi.teja@patient.example, sneha.reddy@patient.example, arjun.rao@patient.example');
  console.log('Password for ALL demo accounts: the SEED_DEMO_PASSWORD value in your .env');
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
