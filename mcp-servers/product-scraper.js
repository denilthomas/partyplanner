// Product Search via SerpApi (Google Shopping)
// Reliable API-based product search — no Puppeteer needed
//
// Requires: SERPAPI_KEY environment variable
// Free tier: 100 searches/month at serpapi.com
//
// Returns: array of { name, price, url, image, rating, retailer }

const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

async function searchProducts(query, retailer = 'amazon', maxResults = 5) {
  if (!SERPAPI_KEY) {
    console.error('[product-search] SERPAPI_KEY not set');
    return [];
  }

  try {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      api_key: SERPAPI_KEY,
      num: String(maxResults),
    });

    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) {
      console.error(`[product-search] SerpApi returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = (data.shopping_results || []).slice(0, maxResults);

    return results.map(item => ({
      name: item.title || '',
      price: item.extracted_price || 0,
      url: item.link || item.product_link || '',
      image: item.thumbnail || '',
      rating: item.rating || null,
      retailer: item.source || retailer || 'Google Shopping',
    }));
  } catch (err) {
    console.error('[product-search] SerpApi request failed:', err.message);
    return [];
  }
}

module.exports = { searchProducts };
