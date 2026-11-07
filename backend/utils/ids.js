// Human-friendly unique identifiers. Uniqueness is ultimately enforced by UNIQUE keys in MySQL.
const crypto = require('crypto');

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};
const rand = (bytes) => crypto.randomBytes(bytes).toString('hex').toUpperCase();

module.exports = {
  appointmentCode: () => `MC${stamp()}${rand(2)}`, // e.g. MC20261105A1F3
  transactionRef: () => `TXN${stamp()}${rand(4)}`,
  receiptNo: () => `RCP${stamp()}${rand(3)}`,
};
