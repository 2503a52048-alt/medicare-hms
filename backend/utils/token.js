// JWT is stored in an httpOnly cookie so page scripts (and XSS) cannot read it.
const jwt = require('jsonwebtoken');

const COOKIE = 'medicare_token';

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
}

function setAuthCookie(res, user) {
  // Session cookie; the JWT's own expiry limits how long it is accepted.
  res.cookie(COOKIE, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

const clearAuthCookie = (res) => res.clearCookie(COOKIE);
const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

module.exports = { COOKIE, setAuthCookie, clearAuthCookie, verifyToken };
