// Background jobs, run every minute inside the server process:
//  - release unpaid slot holds
//  - cancel + refund paid requests the doctor never answered
//  - send appointment reminders (in-app + email) 24 hours ahead
const { expireUnpaid, expireMissed, sendReminders } = require('./appointmentService');

function startScheduler() {
  const tick = async () => {
    try {
      await expireUnpaid();
      await expireMissed();
      await sendReminders();
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  };
  tick();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = { startScheduler };
