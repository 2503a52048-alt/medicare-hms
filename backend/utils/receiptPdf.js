// Payment receipt PDF (pdfkit). Built-in PDF fonts have no rupee glyph, so amounts are printed as "Rs."
const PDFDocument = require('pdfkit');

function streamReceipt(res, r) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${r.appointment_code}.pdf"`);
  doc.pipe(res);

  const blue = '#0b5ed7';
  doc.rect(0, 0, doc.page.width, 90).fill(blue);
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text(r.hospital_name, 50, 28);
  doc.fontSize(10).font('Helvetica').text(r.hospital_address || '', 50, 58);

  doc.fillColor('#111111').fontSize(16).font('Helvetica-Bold').text('PAYMENT RECEIPT', 50, 120);

  const rows = [
    ['Receipt No', r.receipt_no || '-'],
    ['Transaction Ref', r.transaction_ref],
    ['Payment Date', r.paid_at || r.created_at],
    ['Payment Method', String(r.method).toUpperCase()],
    ['Payment Status', String(r.status).toUpperCase()],
    ['', ''],
    ['Appointment ID', r.appointment_code],
    ['Patient', r.patient_name],
    ['Doctor', `${r.doctor_name} (${r.specialization})`],
    ['Appointment Date', `${r.appointment_date}  ${r.slot_time.slice(0, 5)}`],
  ];
  let y = 155;
  rows.forEach(([k, v]) => {
    if (k) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#444444').text(k, 50, y, { width: 150 });
      doc.font('Helvetica').fillColor('#111111').text(String(v), 210, y, { width: 330 });
    }
    y += 24;
  });

  doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor('#cccccc').stroke();
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111')
    .text('Amount', 50, y + 18)
    .text(`Rs. ${Number(r.amount).toFixed(2)}`, 210, y + 18);

  if (r.status === 'refunded') {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#b02a37')
      .text('This payment has been refunded.', 50, y + 50);
  }
  if (r.mode === 'test') {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#b02a37')
      .text('TEST MODE: this is a simulated transaction. No real money was charged.', 50, y + 75);
  }
  doc.font('Helvetica').fontSize(9).fillColor('#777777')
    .text('This is a computer-generated receipt and does not require a signature.', 50, 770, { align: 'center', width: 495 });
  doc.end();
}

module.exports = { streamReceipt };
