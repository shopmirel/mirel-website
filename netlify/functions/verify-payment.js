// netlify/functions/verify-payment.js
//
// Step 2 of paying: after the customer pays, Razorpay hands the page three values.
// This function checks them against the secret key. Only a real payment can pass,
// so nobody can fake "paid" from their browser.

const crypto = require('crypto');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return json(500, { error: 'not_configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_request' }); }
  const orderId = body.razorpay_order_id;
  const paymentId = body.razorpay_payment_id;
  const signature = body.razorpay_signature;
  if (!orderId || !paymentId || !signature) return json(400, { error: 'missing_fields' });

  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(400, { error: 'signature_mismatch' });

  return json(200, { ok: true });
};
