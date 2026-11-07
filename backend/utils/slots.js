// Date helpers and slot generation. All dates are 'YYYY-MM-DD' strings, times 'HH:MM'.
const pool = require('../config/db');

const MAX_ADVANCE_DAYS = 30; // patients can book up to 30 days ahead
const pad = (n) => String(n).padStart(2, '0');

const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISODate(new Date());

function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dayOfWeek(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const timeLabel = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${pad(h % 12 || 12)}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
};

/**
 * Returns { working, reason?, slots: [{ time, label, available }] } for one doctor on one date.
 * A slot is unavailable when it is already booked (pending/confirmed/completed),
 * falls in the doctor's break, or has already started (for today).
 */
async function getAvailableSlots(doctorId, date) {
  if (!isValidISODate(date)) return { working: false, slots: [], reason: 'Invalid date.' };
  const today = todayISO();
  if (date < today) return { working: false, slots: [], reason: 'This date is in the past.' };
  if (date > addDays(today, MAX_ADVANCE_DAYS)) {
    return { working: false, slots: [], reason: `Bookings open only ${MAX_ADVANCE_DAYS} days ahead.` };
  }

  const [avail] = await pool.execute(
    'SELECT * FROM doctor_availability WHERE doctor_id = ? AND day_of_week = ? AND is_working = 1',
    [doctorId, dayOfWeek(date)]
  );
  if (!avail.length) return { working: false, slots: [], reason: 'Doctor is not available on this day.' };

  const [blocked] = await pool.execute(
    'SELECT id FROM doctor_blocked_dates WHERE doctor_id = ? AND blocked_date = ?',
    [doctorId, date]
  );
  if (blocked.length) return { working: false, slots: [], reason: 'Doctor is unavailable on this date.' };

  const a = avail[0];
  const [booked] = await pool.execute(
    `SELECT slot_time FROM appointments
      WHERE doctor_id = ? AND appointment_date = ? AND status NOT IN ('cancelled','rejected')`,
    [doctorId, date]
  );
  const bookedSet = new Set(booked.map((b) => b.slot_time.slice(0, 5)));

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = toMin(a.start_time);
  const end = toMin(a.end_time);
  const step = a.slot_minutes;
  const bStart = a.break_start ? toMin(a.break_start) : null;
  const bEnd = a.break_end ? toMin(a.break_end) : null;

  const slots = [];
  for (let t = start; t + step <= end; t += step) {
    if (bStart !== null && bEnd !== null && t < bEnd && t + step > bStart) continue; // inside break
    const time = fromMin(t);
    const passed = date === today && t <= nowMin;
    slots.push({ time, label: timeLabel(time), available: !bookedSet.has(time) && !passed });
  }
  return { working: true, slots };
}

/** Next bookable dates (within `windowDays`) for a doctor. */
async function getAvailableDates(doctorId, windowDays = 14) {
  const [days] = await pool.execute(
    'SELECT day_of_week FROM doctor_availability WHERE doctor_id = ? AND is_working = 1',
    [doctorId]
  );
  if (!days.length) return [];
  const workDays = new Set(days.map((d) => d.day_of_week));
  const today = todayISO();
  const last = addDays(today, windowDays - 1);
  const [blocked] = await pool.execute(
    'SELECT blocked_date FROM doctor_blocked_dates WHERE doctor_id = ? AND blocked_date BETWEEN ? AND ?',
    [doctorId, today, last]
  );
  const blockedSet = new Set(blocked.map((b) => b.blocked_date));

  const out = [];
  for (let i = 0; i < windowDays; i++) {
    const d = addDays(today, i);
    if (!workDays.has(dayOfWeek(d)) || blockedSet.has(d)) continue;
    if (i === 0) {
      const r = await getAvailableSlots(doctorId, d);
      if (!r.slots.some((s) => s.available)) continue;
    }
    out.push(d);
  }
  return out;
}

module.exports = {
  MAX_ADVANCE_DAYS, toISODate, todayISO, isValidISODate, dayOfWeek, addDays,
  timeLabel, getAvailableSlots, getAvailableDates,
};
