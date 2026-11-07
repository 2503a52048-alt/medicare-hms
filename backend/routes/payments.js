// Payments.
//   PAYMENT_MODE=test      -> built-in simulated gateway (clearly labelled TEST MODE; no real money)
//   PAYMENT_MODE=razorpay  -> Razorpay Checkout with your rzp_test_ keys (signature verified server-side)
//
// Flow:  POST /initiate  ->  (patient pays)  ->  POST /confirm  ->  receipt
// Every attempt is stored in `payments`, including failed ones.
const crypto = require('crypto');
const express = require('express');
const { body, param } = require('express-validator');

const pool = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { wrap, httpError } = require('../utils/httpError');
const ids = require('../utils/ids');
const { logActivity } = require('../utils/logger');
const { notifyUser } = require('../utils/notifier');
const { streamReceipt } = require('../utils/receiptPdf');
const svc = require('../services/appointmentService');

const router = express.Router();
router.use(authenticate);

const isRazorpay = () => process.env.PAYMENT_MODE === 'razorpay';
const keyMode = () => (String(process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test_') ? 'test' : 'live');

router.post(
  '/initiate',
  authorize('patient'),
  [
    body('appointmentId').isInt({ min: 1 }).toInt(),
    body('method').isIn(['upi', 'card', 'netbanking']).withMessage('Choose UPI, card or net banking.'),
  ],
  validate,
  wrap(async (req, res) => {
    const { appointmentId, method } = req.body;
    await svc.expireUnpaid();

    const [rows] = await pool.execute(
      `SELECT a.id, a.status, d.consultation_fee
         FROM appointments a JOIN doctors d ON d.id = a.doctor_id
        WHERE a.id = ? AND a.patient_id = ?`,
      [appointmentId, req.user.patientId]
    );
    const a = rows[0];
    if (!a) throw httpError(404, 'Appointment not found.');
    if (a.status !== 'pending') throw httpError(409, 'This booking is no longer awaiting payment (the hold may have expired).');
    const [paid] = await pool.execute("SELECT id FROM payments WHERE appointment_id = ? AND status = 'success'", [a.id]);
    if (paid.length) throw httpError(409, 'This appointment is already paid.');

    const amount = Number(a.consultation_fee);
    const txn = ids.transactionRef();
    let orderId = null;

    if (isRazorpay()) {
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: txn }),
      });
      if (!r.ok) throw httpError(502, 'Payment gateway is unavailable. Please try again.');
      orderId = (await r.json()).id;
    }

    // Any earlier unfinished attempt is superseded.
    await pool.execute("UPDATE payments SET status = 'failed' WHERE appointment_id = ? AND status = 'pending'", [a.id]);
    await pool.execute(
      `INSERT INTO payments (appointment_id, patient_id, amount, method, status, mode, transaction_ref, gateway_order_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [a.id, req.user.patientId, amount, method, isRazorpay() ? keyMode() : 'test', txn, orderId]
    );

    res.json(
      isRazorpay()
        ? { mode: 'razorpay', transactionRef: txn, amount, orderId, keyId: process.env.RAZORPAY_KEY_ID }
        : {
            mode: 'test',
            testMode: true,
            transactionRef: txn,
            amount,
            notice: 'TEST MODE: no real money is charged. You can simulate a successful or a failed payment.',
          }
    );
  })
);

router.post(
  '/confirm',
  authorize('patient'),
  [
    body('appointmentId').isInt({ min: 1 }).toInt(),
    body('simulate').optional().isIn(['success', 'failure']),
    body('razorpay_payment_id').optional().isString().isLength({ max: 80 }),
    body('razorpay_signature').optional().isString().isLength({ max: 200 }),
  ],
  validate,
  wrap(async (req, res) => {
    const { appointmentId, simulate, razorpay_payment_id: rzpPaymentId, razorpay_signature: rzpSignature } = req.body;

    const [rows] = await pool.execute(
      `SELECT p.*, a.status AS appt_status, a.appointment_code, a.appointment_date, a.slot_time,
              d.user_id AS doctor_user_id, d.full_name AS doctor_name, pt.full_name AS patient_name
         FROM payments p
         JOIN appointments a ON a.id = p.appointment_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN patients pt ON pt.id = p.patient_id
        WHERE p.appointment_id = ? AND p.patient_id = ? AND p.status = 'pending'
        ORDER BY p.id DESC LIMIT 1`,
      [appointmentId, req.user.patientId]
    );
    const p = rows[0];
    if (!p) throw httpError(404, 'No payment is in progress for this appointment.');
    if (p.appt_status !== 'pending') {
      await pool.execute("UPDATE payments SET status = 'failed' WHERE id = ?", [p.id]);
      throw httpError(409, 'This booking has expired or was cancelled. Please book again.');
    }

    let success;
    let gatewayPaymentId;
    if (isRazorpay()) {
      if (!rzpPaymentId || !rzpSignature) throw httpError(400, 'Missing payment details from the gateway.');
      const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${p.gateway_order_id}|${rzpPaymentId}`)
        .digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(rzpSignature);
      success = a.length === b.length && crypto.timingSafeEqual(a, b);
      gatewayPaymentId = rzpPaymentId;
    } else {
      // "simulate" is honoured ONLY in test mode.
      success = simulate !== 'failure';
      gatewayPaymentId = `test_${crypto.randomBytes(6).toString('hex')}`;
    }

    if (!success) {
      await pool.execute("UPDATE payments SET status = 'failed', gateway_payment_id = ? WHERE id = ?", [gatewayPaymentId, p.id]);
      await logActivity(req.user.id, 'PAYMENT_FAILED', p.transaction_ref, req.ip);
      return res.status(402).json({ message: 'Payment failed. Your slot is still held for a short time; please try again.', status: 'failed' });
    }

    const receiptNo = ids.receiptNo();
    await pool.execute(
      "UPDATE payments SET status = 'success', gateway_payment_id = ?, receipt_no = ?, paid_at = NOW() WHERE id = ? AND status = 'pending'",
      [gatewayPaymentId, receiptNo, p.id]
    );
    const when = svc.whenText(p);
    await notifyUser(req.user.id, 'Payment received', `Payment of Rs. ${Number(p.amount).toFixed(2)} received for appointment ${p.appointment_code} (receipt ${receiptNo}). The doctor will confirm your request shortly.`, 'payment');
    await notifyUser(p.doctor_user_id, 'New appointment request', `${p.patient_name} requested an appointment on ${when} (${p.appointment_code}).`, 'appointment');
    await logActivity(req.user.id, 'PAYMENT_SUCCESS', `${p.transaction_ref} Rs.${p.amount}`, req.ip);
    res.json({
      message: 'Payment successful. Your appointment request has been sent to the doctor.',
      status: 'success',
      receiptNo,
      transactionRef: p.transaction_ref,
      appointmentCode: p.appointment_code,
    });
  })
);

// PDF receipt for the patient who paid (or an admin).
router.get(
  '/receipt/:appointmentId',
  authorize('patient', 'admin'),
  [param('appointmentId').isInt({ min: 1 }).toInt()],
  validate,
  wrap(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT p.amount, p.method, p.status, p.mode, p.transaction_ref, p.receipt_no, p.paid_at, p.created_at,
              a.appointment_code, a.appointment_date, a.slot_time, a.patient_id,
              pt.full_name AS patient_name, d.full_name AS doctor_name, s.name AS specialization
         FROM payments p
         JOIN appointments a ON a.id = p.appointment_id
         JOIN patients pt ON pt.id = a.patient_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN specializations s ON s.id = d.specialization_id
        WHERE p.appointment_id = ? AND p.status IN ('success','refunded')
        ORDER BY p.id DESC LIMIT 1`,
      [req.params.appointmentId]
    );
    const r = rows[0];
    if (!r || (req.user.role === 'patient' && r.patient_id !== req.user.patientId)) {
      throw httpError(404, 'No paid receipt found for this appointment.');
    }
    const [settings] = await pool.execute("SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('hospital_name','hospital_address')");
    const s = Object.fromEntries(settings.map((x) => [x.setting_key, x.setting_value]));
    streamReceipt(res, { ...r, hospital_name: s.hospital_name || 'MediCare Hospital', hospital_address: s.hospital_address });
  })
);

module.exports = router;
