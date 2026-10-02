// netlify/functions/get-products.js
//
// Reads every row from the "Mirel Products" Notion database and returns it
// as JSON, in the exact shape the site's loadNotionProducts() already expects.
//
// Setup:
// 1. Put this file at netlify/functions/get-products.js in your project.
// 2. It reuses the same Notion token your notion-sync (orders) function
//    already uses — checked under a few common names so you shouldn't need
//    to add a new one. If it can't find one, check Netlify → Site
//    configuration → Environment variables for the exact name your
//    notion-sync function reads, and add that same name/value here too.
// 3. IMPORTANT: open the "Mirel Products" database in Notion → "..." menu
//    (top right) → Connections → add the same integration your orders
//    database is connected to (the one notion-sync already uses). Without
//    this, Notion will return a 403 "restricted" error even with the
//    right token, because the token can only see databases it's been
//    explicitly shared with.

const NOTION_VERSION = '2022-06-28';
const DATABASE_ID = '4f3a4a591fb948d3822e1360136b225b'; // "Mirel Products"

function getToken() {
  return (
    process.env.NOTION_API_KEY ||
    process.env.NOTION_TOKEN ||
    process.env.NOTION_SECRET ||
    process.env.NOTION_KEY ||
    process.env.NOTION_INTEGRATION_TOKEN
  );
}

function plainText(richTextArray) {
  return (richTextArray || []).map((t) => t.plain_text).join('');
}

// Reads a Notion property as plain text, whatever type it was made as
// (Number, Text, Title, Select) — so "Drop Number" and "Connected To" work
// even if the column type is slightly different from what's expected.
function propToText(prop) {
  if (!prop) return '';
  if (typeof prop.number === 'number') return String(prop.number);
  if (prop.rich_text) return plainText(prop.rich_text);
  if (prop.title) return plainText(prop.title);
  if (prop.select && prop.select.name) return prop.select.name;
  if (prop.multi_select) return prop.multi_select.map((o) => o.name).join(',');
  return '';
}

function filesToUrls(filesProp) {
  return ((filesProp && filesProp.files) || [])
    .map((f) => (f.file ? f.file.url : f.external ? f.external.url : null))
    .filter(Boolean);
}

exports.handler = async function () {
  const token = getToken();
  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'No Notion token found in environment variables.' }),
    };
  }

  try {
    const products = [];
    let cursor;

    do {
      const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        // Only in-stock rows leave Notion, so hidden products can never be seen
        // by opening this function's address directly.
        body: JSON.stringify({
          page_size: 100,
          start_cursor: cursor,
          filter: { property: 'In Stock', checkbox: { equals: true } },
        }),
      });

      if (!res.ok) {
        const detail = await res.text();
        return {
          statusCode: res.status === 404 ? 404 : 502,
          body: JSON.stringify({
            error: 'Notion query failed',
            hint:
              res.status === 404 || res.status === 403
                ? 'The database may not be shared with this integration yet — see the setup notes at the top of this file.'
                : undefined,
            detail,
          }),
        };
      }

      const data = await res.json();

      for (const page of data.results || []) {
        const p = page.properties || {};
        const images = [1, 2, 3, 4, 5].flatMap((n) => filesToUrls(p['Image ' + n]));
        const name = plainText(p.Name && p.Name.title);
        if (!name || !images.length) continue; // matches the frontend's own requirement
        if (!(p.Price && typeof p.Price.number === 'number')) continue; // no price = don't show

        products.push({
          id: page.id,
          name,
          description: plainText(p.Description && p.Description.rich_text),
          price: p.Price && typeof p.Price.number === 'number' ? p.Price.number : null,
          salePrice: p['Sale Price'] && typeof p['Sale Price'].number === 'number' ? p['Sale Price'].number : null,
          categories: ((p.Category && p.Category.multi_select) || []).map((o) => o.name),
          sizeType: (p['Size Type'] && p['Size Type'].select && p['Size Type'].select.name) || '',
          inStock: !!(p['In Stock'] && p['In Stock'].checkbox),
          images,
          dropNumber: propToText(p['Drop Number']),
          connectedTo: propToText(p['Connected To']),
        });
      }

      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        // Fast for visitors: Netlify keeps a copy for 60s (and refreshes it quietly in the
        // background), so Notion isn't asked on every single visit.
        'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
      body: JSON.stringify({ products }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
