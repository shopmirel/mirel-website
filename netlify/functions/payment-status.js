// netlify/functions/payment-status.js
//
// Asks Razorpay directly: "was this order actually paid, and how much?"
// Used in two places on the shop page:
//   1. When a customer paid but the page never got to save the order (tab closed, UPI app switch,
//      bad signal) — the page asks again next time they open the shop and saves it.
//   2. In your Orders panel — each paid order gets a tick (Razorpay confirms) or a warning.
// Uses the same RAZORPAY_KEY_SECRET setting as create-order.js.

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TpLdbzwdBLlkGO'; // same public key ID as create-order.js
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return json(500, { error: 'not_configured' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_request' }); }
  const id = String(body.orderId || '');
  if (!/^order_[A-Za-z0-9]+$/.test(id)) return json(400, { error: 'bad_request' });
  try {
    const res = await fetch('https://api.razorpay.com/v1/orders/' + id, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64') },
    });
    if (res.status === 404 || res.status === 400) return json(200, { paid: false, amount: 0 });
    if (!res.ok) return json(502, { error: 'razorpay_error' });
    const o = await res.json();
    return json(200, { paid: o.status === 'paid' && o.amount_paid >= o.amount, amount: o.amount_paid || 0 });
  } catch (e) { return json(500, { error: 'server_error' }); }
};
