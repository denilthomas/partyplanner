// Inspiration Image Search via SerpApi (Google Images)
// Reliable API-based image search — no Puppeteer needed
//
// Requires: SERPAPI_KEY environment variable
// Free tier: 100 searches/month at serpapi.com
//
// Returns: array of { image_url, title, description, pin_url }

const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

async function searchPinterest(query, maxResults = 12) {
  if (!SERPAPI_KEY) {
    console.error('[image-search] SERPAPI_KEY not set');
    return [];
  }

  try {
    const params = new URLSearchParams({
      engine: 'google_images',
      q: `${query} party decor inspiration`,
      api_key: SERPAPI_KEY,
      num: String(maxResults),
    });

    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) {
      console.error(`[image-search] SerpApi returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = (data.images_results || []).slice(0, maxResults);

    return results.map(item => ({
      image_url: item.original || item.thumbnail || '',
      title: item.title || '',
      description: item.snippet || item.title || '',
      pin_url: item.link || '',
    }));
  } catch (err) {
    console.error('[image-search] SerpApi request failed:', err.message);
    return [];
  }
}

function closeBrowser() {
  return Promise.resolve();
}

module.exports = { searchPinterest, closeBrowser };
