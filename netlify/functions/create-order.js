// netlify/functions/create-order.js
//
// Step 1 of paying: the shop page says WHAT the customer wants (product names and
// quantities). This function looks up the real prices itself, adds up the total,
// and asks Razorpay to open a payment for exactly that amount.
// The page never decides the price, so changing it in the browser does nothing.
//
// Needs two settings in Netlify (Site configuration -> Environment variables):
//   RAZORPAY_KEY_ID      and      RAZORPAY_KEY_SECRET
// (it also reuses the Notion token your other functions already use)

const NOTION_VERSION = '2022-06-28';
const DATABASE_ID = '4f3a4a591fb948d3822e1360136b225b'; // "Mirel Products"
const FREE_DELIVERY_FROM = 699;  // same rule as the shop page
const DELIVERY_FEE = 89;

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const notionToken = () =>
  process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || process.env.NOTION_SECRET ||
  process.env.NOTION_KEY || process.env.NOTION_INTEGRATION_TOKEN;

const plain = (arr) => (arr || []).map((t) => t.plain_text).join('');
const norm = (s) => String(s || '').trim().toLowerCase();

// Same price rule the shop page uses: sale price if it is lower than the normal price.
function unitPriceOf(price, sale) {
  const onSale = !!(sale && price && sale < price);
  return onSale ? sale : (price || sale || 0);
}

async function loadPrices(token) {
  const prices = new Map(); // product name (lowercase) -> price in rupees
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, filter: { property: 'In Stock', checkbox: { equals: true } } }),
    });
    if (!res.ok) throw new Error('notion-failed');
    const data = await res.json();
    for (const page of data.results || []) {
      const p = page.properties || {};
      const name = plain(p.Name && p.Name.title);
      const price = p.Price && typeof p.Price.number === 'number' ? p.Price.number : null;
      const sale = p['Sale Price'] && typeof p['Sale Price'].number === 'number' ? p['Sale Price'].number : null;
      const unit = unitPriceOf(price, sale);
      if (name && unit > 0) prices.set(norm(name), unit);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return prices;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const token = notionToken();
  if (!keyId || !keySecret || !token) return json(500, { error: 'not_configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_request' }); }
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length || lines.length > 30) return json(400, { error: 'bad_request' });

  try {
    const prices = await loadPrices(token);
    let subtotal = 0;
    for (const line of lines) {
      const qty = Number(line.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10) return json(400, { error: 'bad_request' });
      // Match by product name; wishlist items only carry a title like "Name (size)", so also try without the bracket.
      const candidates = [line.base, line.title, String(line.title || '').replace(/\s*\([^)]*\)\s*$/, '')];
      let unit = 0;
      for (const c of candidates) {
        const hit = prices.get(norm(c));
        if (hit) { unit = hit; break; }
      }
      if (!unit) return json(400, { error: 'unknown_item' });
      subtotal += unit * qty;
    }
    const delivery = subtotal > 0 && subtotal < FREE_DELIVERY_FROM ? DELIVERY_FEE : 0;
    const amount = Math.round((subtotal + delivery) * 100); // Razorpay counts in paise
    if (amount < 100) return json(400, { error: 'amount_too_small' });

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify({ amount, currency: 'INR', receipt: 'mirel_' + Date.now() }),
    });
    if (res.status === 401) return json(401, { error: 'razorpay_auth_failed' });
    if (!res.ok) return json(500, { error: 'razorpay_error' });
    const order = await res.json();
    return json(200, { id: order.id, amount: order.amount, currency: order.currency, subtotal, delivery });
  } catch (err) {
    return json(500, { error: 'server_error' });
  }
};
