// Appointment lifecycle rules shared by patient, doctor, admin routes and the scheduler.
//
//  pending   = slot held. Becomes "awaiting doctor" once a payment succeeds.
//  confirmed = doctor accepted.      completed = consultation done.
//  cancelled / rejected = slot is released automatically (see slot_lock in schema.sql).
//
// Unpaid holds expire after HOLD_MINUTES so abandoned bookings never block a slot.
const pool = require('../config/db');
const { httpError } = require('../utils/httpError');
const { notifyUser } = require('../utils/notifier');
const { logActivity } = require('../utils/logger');
const { toISODate, timeLabel } = require('../utils/slots');

const HOLD_MINUTES = 15;
const REFUND_CUTOFF_HOURS = 2; // patient cancellations earlier than this get a refund

// SQL fragment: the appointment (alias `a`) has a successful or refunded payment.
const HAS_PAID = `EXISTS (SELECT 1 FROM payments pp WHERE pp.appointment_id = a.id AND pp.status IN ('success','refunded'))`;

const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) => `${toISODate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const slotStart = (a) => new Date(`${a.appointment_date}T${a.slot_time.slice(0, 8)}`);
const whenText = (a) => `${a.appointment_date} at ${timeLabel(a.slot_time.slice(0, 5))}`;

/** Releases slots held by bookings that were never paid. */
async function expireUnpaid() {
  const [r] = await pool.execute(
    `UPDATE appointments a
        SET a.status = 'cancelled', a.cancelled_by = 'system', a.cancel_reason = 'Payment not completed in time'
      WHERE a.status = 'pending'
        AND a.created_at < (NOW() - INTERVAL ${HOLD_MINUTES} MINUTE)
        AND NOT ${HAS_PAID}`
  );
  await pool.execute(
    `UPDATE payments SET status = 'failed'
      WHERE status = 'pending' AND created_at < (NOW() - INTERVAL ${HOLD_MINUTES} MINUTE)`
  );
  return r.affectedRows;
}

/**
 * Cancels (or rejects) a live appointment inside a transaction.
 * Refund policy: doctor / admin / system actions always refund; a patient gets a refund
 * when cancelling at least REFUND_CUTOFF_HOURS before the slot.
 * In test mode the refund is simulated by marking the payment 'refunded'.
 */
async function cancelAppointment(appointmentId, { by, reason, finalStatus = 'cancelled', ip = null, actorUserId = null }) {
  const conn = await pool.getConnection();
  let a;
  let refunded = false;
  let hadPayment = false;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT a.*, p.user_id AS patient_user_id, d.user_id AS doctor_user_id, d.full_name AS doctor_name
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN doctors d ON d.id = a.doctor_id
        WHERE a.id = ? FOR UPDATE OF a`,
      [appointmentId]
    );
    a = rows[0];
    if (!a) throw httpError(404, 'Appointment not found.');
    if (!['pending', 'confirmed'].includes(a.status)) {
      throw httpError(409, `This appointment is already ${a.status}.`);
    }

    const [pay] = await conn.execute(
      "SELECT id FROM payments WHERE appointment_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [a.id]
    );
    hadPayment = pay.length > 0;
    if (hadPayment) {
      const hoursLeft = (slotStart(a) - new Date()) / 36e5;
      refunded = by !== 'patient' || hoursLeft >= REFUND_CUTOFF_HOURS;
      if (refunded) await conn.execute("UPDATE payments SET status = 'refunded' WHERE id = ?", [pay[0].id]);
    }
    await conn.execute(
      'UPDATE appointments SET status = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?',
      [finalStatus, by, String(reason).slice(0, 255), a.id]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  const verb = finalStatus === 'rejected' ? 'rejected' : 'cancelled';
  let refundText = '';
  if (hadPayment) {
    refundText = refunded
      ? ' Your payment will be refunded.'
      : ` No refund applies because it was cancelled less than ${REFUND_CUTOFF_HOURS} hours before the appointment.`;
  }
  await notifyUser(
    a.patient_user_id,
    `Appointment ${verb}`,
    `Your appointment ${a.appointment_code} with ${a.doctor_name} on ${whenText(a)} was ${verb} by ${by}. Reason: ${reason}.${refundText}`,
    'appointment'
  );
  if (by !== 'doctor') {
    await notifyUser(
      a.doctor_user_id,
      `Appointment ${verb}`,
      `Appointment ${a.appointment_code} on ${whenText(a)} was ${verb} by ${by}. Reason: ${reason}.`,
      'appointment'
    );
  }
  await logActivity(actorUserId, `APPOINTMENT_${verb.toUpperCase()}`, `${a.appointment_code} by ${by}`, ip);
  return { refunded, hadPayment, refundText: refundText.trim() };
}

/** Paid appointments the doctor never answered before the slot time are cancelled + refunded. */
async function expireMissed() {
  const [rows] = await pool.execute(
    `SELECT a.id FROM appointments a
      WHERE a.status = 'pending' AND TIMESTAMP(a.appointment_date, a.slot_time) < ? AND ${HAS_PAID}`,
    [fmtLocal(new Date())]
  );
  for (const r of rows) {
    await cancelAppointment(r.id, {
      by: 'system',
      reason: 'The doctor did not respond before the appointment time',
    }).catch((e) => console.error('expireMissed:', e.message));
  }
  return rows.length;
}

/** In-app + email reminder for confirmed appointments starting within the next 24 hours. */
async function sendReminders() {
  const now = new Date();
  const [rows] = await pool.execute(
    `SELECT a.id, a.appointment_code, a.appointment_date, a.slot_time,
            p.user_id AS patient_user_id, d.full_name AS doctor_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
      WHERE a.status = 'confirmed' AND a.reminder_sent = 0
        AND TIMESTAMP(a.appointment_date, a.slot_time) BETWEEN ? AND ?`,
    [fmtLocal(now), fmtLocal(new Date(now.getTime() + 24 * 36e5))]
  );
  let sent = 0;
  for (const a of rows) {
    // Claim the reminder first so it cannot be sent twice.
    const [claim] = await pool.execute(
      'UPDATE appointments SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0',
      [a.id]
    );
    if (!claim.affectedRows) continue;
    await notifyUser(
      a.patient_user_id,
      'Appointment reminder',
      `Reminder: you have an appointment (${a.appointment_code}) with ${a.doctor_name} on ${whenText(a)}.`,
      'reminder'
    );
    sent++;
  }
  return sent;
}

module.exports = {
  HOLD_MINUTES, REFUND_CUTOFF_HOURS, HAS_PAID, fmtLocal, slotStart, whenText,
  expireUnpaid, cancelAppointment, expireMissed, sendReminders,
};
