// Small helpers so route handlers can throw HTTP errors and skip try/catch boilerplate.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Express 4 does not catch rejected promises from async handlers; this forwards them to the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ?page=1&pageSize=20 (max 50)
function parsePage(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 50);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

module.exports = { httpError, wrap, parsePage };
