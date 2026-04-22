// Pinterest Scraper
// Scrapes real inspiration images from Pinterest search results
//
// Strategy:
//   1. Primary: Use Pinterest's undocumented search JSON endpoint (fragile but fast)
//   2. Fallback: Puppeteer-based scrape of the public search page
//
// Returns: array of { image_url, title, description, pin_url }

const puppeteer = require('puppeteer');

// Shared browser instance (launch once, reuse for speed)
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }
  return browserPromise;
}

async function searchPinterest(query, maxResults = 12) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Realistic UA + viewport so Pinterest serves the full grid
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 1600 });

    const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // Scroll once to trigger lazy-loaded images
    await page.evaluate(() => window.scrollBy(0, 1500));
    await new Promise(r => setTimeout(r, 1200));

    // Extract pins from the grid
    const pins = await page.evaluate((max) => {
      const results = [];
      const seen = new Set();

      // Pinterest uses data-test-id="pin" for pin containers
      const nodes = document.querySelectorAll('[data-test-id="pin"], div[data-grid-item]');

      for (const node of nodes) {
        if (results.length >= max) break;

        const img = node.querySelector('img');
        if (!img || !img.src) continue;

        // Upgrade the thumbnail URL to a higher-res version
        let src = img.src;
        src = src.replace(/\/236x\//, '/564x/').replace(/\/60x60\//, '/564x/');

        if (seen.has(src)) continue;
        seen.add(src);

        const link = node.querySelector('a[href*="/pin/"]');
        const pinUrl = link ? new URL(link.href, 'https://www.pinterest.com').href : '';

        results.push({
          image_url: src,
          title: img.alt || '',
          description: img.alt || '',
          pin_url: pinUrl,
        });
      }

      return results;
    }, maxResults);

    return pins;
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { searchPinterest, closeBrowser };
