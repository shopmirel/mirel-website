// Keeps the "Mirel Orders" Notion database in sync with orders placed on
// the site. One-way only: website -> Notion. Notion -> website is not part
// of this.
//
// One row per PRODUCT, not per order. If an order has 3 items, 3 rows are
// created, all sharing the same "Order ID" value so you can see they came
// from one order, and so a status change updates all of them at once.
//
// Setup (done once, in the Netlify dashboard, not in this file):
//   Site settings -> Environment variables -> add:
//     NOTION_TOKEN        = the "Internal Integration Secret" from the
//                           "mirel sync" Notion integration
//     NOTION_DATABASE_ID  = 56b00fc2109947868a61abb121ba7784
//
// Requires an "Order ID" Text property on the database (shared across every
// row of one order — not unique per row, on purpose).

const NOTION_VERSION = '2022-06-28'; // pinned on purpose so Notion's 2025+ API changes don't break this

// Website status -> Notion "product Status" option.
// "Making" is intentionally left out — that's a manual, Notion-only stage
// for tracking the crochet work itself; the website never sets it.
const PRODUCT_STATUS_MAP = {
  ordered: 'New',
  out_for_delivery: 'Shipped',
  delivered: 'Delivered'
};

// Only this account may change an order's status (it's done from the admin panel).
const ADMIN_EMAIL = 'get.mirel@gmail.com';
// Public Firebase web key (the same one already in the site's HTML) — only used to
// check a sign-in token, it grants no access on its own.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDjzRdYk5GaJ-UmLr80rCqdjjGno7rW4Do';

// Notion rejects text longer than 2000 characters, so keep everything under that.
const clip = (v) => String(v == null ? '' : v).slice(0, 1900);

async function isAdmin(event) {
  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    });
    if (!r.ok) return false;
    const u = ((await r.json()).users || [])[0];
    return !!u && u.emailVerified === true && String(u.email || '').toLowerCase() === ADMIN_EMAIL;
  } catch (e) {
    return false;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return { statusCode: 500, body: 'Notion isn\'t configured yet (missing NOTION_TOKEN or NOTION_DATABASE_ID env vars).' };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Bad request body' };
  }

  const { orderId, isNewOrder } = data;
  if (!orderId) {
    return { statusCode: 400, body: 'Missing orderId' };
  }

  const notionHeaders = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };

  try {
    if (isNewOrder) {
      // One call per item, made by the website — creates exactly one row.
      const { item, customerName, phone, address, timestamp } = data;
      if (!item || !item.name) {
        return { statusCode: 400, body: 'Missing item' };
      }

      const properties = {
        'Customer Name': { title: [{ text: { content: clip(customerName) || 'Guest' } }] },
        'Order ID': { rich_text: [{ text: { content: clip(orderId) } }] },
        'Items': { rich_text: [{ text: { content: clip(item.name) } }] },
        'Total': { number: Number(item.price) || 0 },
        'Phone': { phone_number: clip(phone) || null },
        'Address': { rich_text: [{ text: { content: clip(address) } }] },
        'product Status': { select: { name: 'New' } },
        'order Status': { select: { name: 'ordered' } },
        'Payment Status': { select: { name: data.paid === false ? 'Pending' : 'Paid' } },
        'Order Date': timestamp ? { date: { start: timestamp } } : undefined
      };
      Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);

      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties })
      });
      if (!res.ok) {
        const errText = await res.text();
        return { statusCode: 502, body: `Notion rejected the request: ${errText}` };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };

    } else {
      // Status change — find every row that shares this Order ID and update
      // all of them, since one order can be several rows (one per product).
      const { statusKey } = data;
      if (!(await isAdmin(event))) {
        return { statusCode: 403, body: 'Only the admin can change order status.' };
      }
      const isCancel = statusKey === 'cancel';   // "Undo" in the admin Add-order panel
      const productStatusOption = PRODUCT_STATUS_MAP[statusKey];
      if (!productStatusOption && !isCancel) {
        return { statusCode: 400, body: 'Unknown status.' };
      }

      const searchRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
          filter: { property: 'Order ID', rich_text: { equals: String(orderId) } }
        })
      });
      if (!searchRes.ok) {
        return { statusCode: 502, body: `Notion search failed: ${await searchRes.text()}` };
      }
      const searchData = await searchRes.json();
      const pages = searchData.results || [];
      if (isCancel) {
        // Move every row of this order to Notion's trash (restorable from Notion for a while).
        const gone = await Promise.all(pages.map(p =>
          fetch(`https://api.notion.com/v1/pages/${p.id}`, {
            method: 'PATCH',
            headers: notionHeaders,
            body: JSON.stringify({ archived: true })
          })
        ));
        if (gone.some(r => !r.ok)) {
          return { statusCode: 502, body: 'Some Notion rows could not be removed.' };
        }
        return { statusCode: 200, body: JSON.stringify({ ok: true, removed: pages.length }) };
      }
      if (!pages.length) {
        return { statusCode: 404, body: 'No Notion rows found for this order yet — was it created before Order ID existed on the database?' };
      }

      const results = await Promise.all(pages.map(p =>
        fetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH',
          headers: notionHeaders,
          body: JSON.stringify({ properties: { 'product Status': { select: { name: productStatusOption } } } })
        })
      ));
      const failed = results.filter(r => !r.ok);
      if (failed.length) {
        return { statusCode: 502, body: `${failed.length} of ${pages.length} rows failed to update.` };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, updated: pages.length }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
