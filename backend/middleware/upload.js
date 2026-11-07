// File uploads (multer). Safety measures:
//  - only JPEG / PNG (photos) and JPEG / PNG / PDF (prescriptions)
//  - size limits
//  - random server-generated file names (the client's file name is never used)
//  - the first bytes of the saved file are checked against the claimed type
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const ROOT = path.join(__dirname, '..', '..', 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const MAGIC = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

function build(dir, allowed, maxMb) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, path.join(ROOT, dir)),
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!allowed.includes(file.mimetype)) {
        const e = new Error(`Unsupported file type. Allowed: ${allowed.map((m) => EXT[m].slice(1)).join(', ')}.`);
        e.status = 400;
        return cb(e);
      }
      cb(null, true);
    },
  });
}

const photoMulter = build('photos', ['image/jpeg', 'image/png'], 2);
const rxMulter = build('prescriptions', ['image/jpeg', 'image/png', 'application/pdf'], 3);

function magicOk(file) {
  const fd = fs.openSync(file.path, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  return MAGIC[file.mimetype].every((byte, i) => buf[i] === byte);
}

function wrapUpload(multerMw) {
  return [
    (req, res, next) =>
      multerMw(req, res, (err) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') err.message = 'File is too large.';
          err.status = err.status || 400;
        }
        next(err);
      }),
    (req, res, next) => {
      if (req.file && !magicOk(req.file)) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: 'The file content does not match its type.' });
      }
      next();
    },
  ];
}

const uploadPhoto = wrapUpload(photoMulter.single('photo'));
const uploadPrescription = wrapUpload(rxMulter.single('file'));

/** Deletes a previously uploaded file. `relative` looks like 'photos/abc.jpg'. Stays inside uploads/. */
function removeUpload(relative) {
  if (!relative) return;
  const full = path.resolve(ROOT, relative.replace(/^\/?uploads\//, ''));
  if (full.startsWith(ROOT + path.sep)) fs.unlink(full, () => {});
}

module.exports = { ROOT, uploadPhoto, uploadPrescription, removeUpload };
