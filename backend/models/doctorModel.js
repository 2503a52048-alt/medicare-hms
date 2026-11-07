// Doctor queries shared by the public site, patient dashboard and recommendation feature.
const pool = require('../config/db');
const { getAvailableDates, getAvailableSlots } = require('../utils/slots');

const BASE_SELECT = `
  SELECT d.id, d.full_name, d.qualifications, d.experience_years, d.consultation_fee,
         d.photo, d.bio, d.is_verified,
         s.id AS specialization_id, s.name AS specialization,
         (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.doctor_id = d.id AND r.is_visible = 1) AS avg_rating,
         (SELECT COUNT(*) FROM reviews r WHERE r.doctor_id = d.id AND r.is_visible = 1) AS review_count
    FROM doctors d
    JOIN specializations s ON s.id = d.specialization_id
    JOIN users u ON u.id = d.user_id
   WHERE d.is_active = 1 AND d.is_verified = 1 AND u.is_active = 1`;

/** Public list of bookable doctors. Only active + verified doctors are ever shown. */
async function listDoctors({ q, specializationId, limit = 50 } = {}) {
  const params = [];
  let sql = BASE_SELECT;
  if (specializationId) {
    sql += ' AND d.specialization_id = ?';
    params.push(specializationId);
  }
  if (q) {
    sql += ' AND (d.full_name LIKE ? OR s.name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  sql += ` ORDER BY avg_rating IS NULL, avg_rating DESC, d.experience_years DESC LIMIT ${safeLimit}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getDoctor(id) {
  const [rows] = await pool.execute(`${BASE_SELECT} AND d.id = ?`, [id]);
  return rows[0] || null;
}

/** Adds upcoming available dates and the first few free slots to each doctor. */
async function withAvailability(doctors) {
  return Promise.all(
    doctors.map(async (d) => {
      const dates = await getAvailableDates(d.id, 14);
      let nextSlots = [];
      if (dates.length) {
        const r = await getAvailableSlots(d.id, dates[0]);
        nextSlots = r.slots.filter((s) => s.available).slice(0, 6);
      }
      return { ...d, available_dates: dates.slice(0, 5), next_date: dates[0] || null, next_slots: nextSlots };
    })
  );
}

async function getWeeklySchedule(doctorId) {
  const [rows] = await pool.execute(
    `SELECT day_of_week, is_working, start_time, end_time, break_start, break_end, slot_minutes
       FROM doctor_availability WHERE doctor_id = ? ORDER BY day_of_week`,
    [doctorId]
  );
  return rows;
}

module.exports = { listDoctors, getDoctor, withAvailability, getWeeklySchedule };
