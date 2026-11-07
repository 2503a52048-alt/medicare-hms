// Weekly schedule validation and saving (used by both the doctor and the admin).
const pool = require('../config/db');

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLOT_OPTIONS = [10, 15, 20, 30, 45, 60];
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * days: [{ day_of_week 0-6, is_working, start_time, end_time, break_start?, break_end?, slot_minutes }]
 * Returns an error message, or null when valid.
 */
function validateSchedule(days) {
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) return 'Provide the schedule for up to 7 days.';
  const seen = new Set();
  for (const d of days) {
    if (!Number.isInteger(d.day_of_week) || d.day_of_week < 0 || d.day_of_week > 6) return 'Invalid day of week.';
    if (seen.has(d.day_of_week)) return 'Each day can appear only once.';
    seen.add(d.day_of_week);
    if (!d.is_working) continue;

    if (!TIME.test(d.start_time || '') || !TIME.test(d.end_time || '')) return 'Use HH:MM times for working hours.';
    if (toMin(d.end_time) <= toMin(d.start_time)) return 'End time must be after start time.';
    if (!SLOT_OPTIONS.includes(d.slot_minutes)) return `Slot length must be one of ${SLOT_OPTIONS.join(', ')} minutes.`;
    if (toMin(d.end_time) - toMin(d.start_time) < d.slot_minutes) return 'Working hours are shorter than one slot.';

    const hasBreak = d.break_start || d.break_end;
    if (hasBreak) {
      if (!TIME.test(d.break_start || '') || !TIME.test(d.break_end || '')) return 'Enter both break start and end (HH:MM).';
      if (toMin(d.break_end) <= toMin(d.break_start)) return 'Break end must be after break start.';
      if (toMin(d.break_start) < toMin(d.start_time) || toMin(d.break_end) > toMin(d.end_time)) {
        return 'Break must fall within working hours.';
      }
    }
  }
  return null;
}

async function saveSchedule(doctorId, days) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const d of days) {
      const working = d.is_working ? 1 : 0;
      await conn.execute(
        `INSERT INTO doctor_availability
           (doctor_id, day_of_week, is_working, start_time, end_time, break_start, break_end, slot_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE is_working = VALUES(is_working), start_time = VALUES(start_time),
           end_time = VALUES(end_time), break_start = VALUES(break_start), break_end = VALUES(break_end),
           slot_minutes = VALUES(slot_minutes)`,
        [
          doctorId, d.day_of_week, working,
          d.is_working ? d.start_time : '09:00', d.is_working ? d.end_time : '17:00',
          d.is_working && d.break_start ? d.break_start : null,
          d.is_working && d.break_end ? d.break_end : null,
          d.is_working ? d.slot_minutes : 20,
        ]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { validateSchedule, saveSchedule };
