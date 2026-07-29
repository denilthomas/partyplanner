// Unified Search via Serper.dev (Google Images + Shopping)
// Replaces both pinterest-scraper.js and product-scraper.js
//
// Requires: SERPER_API_KEY environment variable
// API docs: https://serper.dev
//
// Exports:
//   searchInspiration(query, maxResults) — image search for party decor inspiration
//   searchProducts(query, maxResults)    — shopping search filtered to approved retailers
//   searchKits(query, maxResults)        — shopping search biased toward kit/bundle results

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';

const IMAGES_ENDPOINT = 'https://google.serper.dev/images';
const SHOPPING_ENDPOINT = 'https://google.serper.dev/shopping';

const APPROVED_RETAILERS = [
  'amazon', 'walmart', 'target', 'etsy', 'michaels',
  'hobby lobby', 'ace hardware', 'home depot',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isApprovedRetailer(source) {
  if (!source) return false;
  const lower = source.toLowerCase();
  return APPROVED_RETAILERS.some(r => lower.includes(r));
}

/**
 * Generic POST to a Serper.dev endpoint.
 * Returns parsed JSON or null on failure.
 */
async function serperPost(endpoint, body) {
  if (!SERPER_API_KEY) {
    console.error('[serper] SERPER_API_KEY not set');
    return null;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[serper] ${endpoint} returned ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`[serper] request to ${endpoint} failed:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// searchInspiration — Google Images via Serper
// ---------------------------------------------------------------------------

/**
 * Search for party inspiration images.
 *
 * @param {string} query      — user-provided search terms
 * @param {number} maxResults — number of results to return (default 12)
 * @returns {Promise<Array<{image_url: string, title: string, description: string, source_url: string}>>}
 */
async function searchInspiration(query, maxResults = 12) {
  const data = await serperPost(IMAGES_ENDPOINT, {
    q: `${query} party decor inspiration`,
    num: maxResults,
  });

  if (!data) return [];

  try {
    const results = (data.images || []).slice(0, maxResults);

    return results.map(item => ({
      image_url: item.imageUrl || item.thumbnailUrl || '',
      title: item.title || '',
      description: item.snippet || item.title || '',
      source_url: item.link || '',
    }));
  } catch (err) {
    console.error('[serper] failed to parse image results:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// searchProducts — Google Shopping via Serper
// ---------------------------------------------------------------------------

/**
 * Search for products, filtered to approved retailers.
 *
 * @param {string} query      — user-provided search terms
 * @param {number} maxResults — number of results to return (default 5)
 * @returns {Promise<Array<{name: string, price: number, url: string, image: string, rating: number|null, retailer: string}>>}
 */
async function searchProducts(query, maxResults = 5) {
  const data = await serperPost(SHOPPING_ENDPOINT, {
    q: query,
    num: maxResults * 4,
  });

  if (!data) return [];

  try {
    const all = data.shopping || [];
    const filtered = all.filter(item => isApprovedRetailer(item.source));

    return filtered.slice(0, maxResults).map(item => ({
      name: item.title || '',
      price: item.price ? parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0 : 0,
      url: item.link || '',
      image: item.imageUrl || item.thumbnail || '',
      rating: item.rating || null,
      retailer: item.source || 'Google Shopping',
    }));
  } catch (err) {
    console.error('[serper] failed to parse shopping results:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// searchKits — Google Shopping biased toward bundles / kits
// ---------------------------------------------------------------------------

/**
 * Search for all-in-one kits and party packs, filtered to approved retailers.
 *
 * @param {string} query      — user-provided search terms
 * @param {number} maxResults — number of results to return (default 3)
 * @returns {Promise<Array<{name: string, price: number, url: string, image: string, rating: number|null, retailer: string}>>}
 */
async function searchKits(query, maxResults = 3) {
  // Run two searches in parallel to maximise coverage of kit-style listings
  const [kitData, packData] = await Promise.all([
    serperPost(SHOPPING_ENDPOINT, {
      q: `all in one kit ${query}`,
      num: maxResults * 4,
    }),
    serperPost(SHOPPING_ENDPOINT, {
      q: `party pack ${query}`,
      num: maxResults * 4,
    }),
  ]);

  try {
    const combined = [
      ...((kitData && kitData.shopping) || []),
      ...((packData && packData.shopping) || []),
    ];

    // Deduplicate by link
    const seen = new Set();
    const unique = combined.filter(item => {
      const key = item.link || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const filtered = unique.filter(item => isApprovedRetailer(item.source));

    return filtered.slice(0, maxResults).map(item => ({
      name: item.title || '',
      price: item.price ? parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0 : 0,
      url: item.link || '',
      image: item.imageUrl || item.thumbnail || '',
      rating: item.rating || null,
      retailer: item.source || 'Google Shopping',
    }));
  } catch (err) {
    console.error('[serper] failed to parse kit results:', err.message);
    return [];
  }
}

module.exports = { searchInspiration, searchProducts, searchKits };
