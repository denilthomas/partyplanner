// Product Scraper
// Searches real retailer sites for product listings
//
// Retailers supported: Amazon, Walmart, Target
// Strategy: Puppeteer scrape of public search result pages
//
// Returns: array of { name, price, url, image, rating, retailer }

const puppeteer = require('puppeteer');

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

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function searchAmazon(query, maxResults = 5) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const products = await page.evaluate((max) => {
      const results = [];
      const items = document.querySelectorAll('[data-component-type="s-search-result"]');

      for (const item of items) {
        if (results.length >= max) break;

        const titleEl = item.querySelector('h2 a span');
        const linkEl = item.querySelector('h2 a');
        const priceWhole = item.querySelector('.a-price-whole');
        const priceFraction = item.querySelector('.a-price-fraction');
        const imgEl = item.querySelector('img.s-image');
        const ratingEl = item.querySelector('.a-icon-star-small .a-icon-alt');

        if (!titleEl || !priceWhole) continue;

        const price = parseFloat(
          (priceWhole.textContent || '').replace(/[^0-9]/g, '') +
          '.' +
          (priceFraction ? priceFraction.textContent.replace(/[^0-9]/g, '') : '00')
        );

        const rating = ratingEl
          ? parseFloat((ratingEl.textContent || '').match(/(\d+\.?\d*)/)?.[1] || 0)
          : null;

        results.push({
          name: titleEl.textContent.trim(),
          price: price,
          url: linkEl ? 'https://www.amazon.com' + linkEl.getAttribute('href') : '',
          image: imgEl ? imgEl.src : '',
          rating: rating,
          retailer: 'Amazon',
        });
      }

      return results;
    }, maxResults);

    return products;
  } finally {
    await page.close();
  }
}

async function searchWalmart(query, maxResults = 5) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    const url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const products = await page.evaluate((max) => {
      const results = [];
      const items = document.querySelectorAll('[data-item-id]');

      for (const item of items) {
        if (results.length >= max) break;

        const linkEl = item.querySelector('a[link-identifier]');
        const titleEl = item.querySelector('span[data-automation-id="product-title"]');
        const priceEl = item.querySelector('[data-automation-id="product-price"]');
        const imgEl = item.querySelector('img');

        if (!titleEl || !priceEl) continue;

        const priceText = priceEl.textContent || '';
        const priceMatch = priceText.match(/\$?([\d,]+\.?\d*)/);
        if (!priceMatch) continue;

        results.push({
          name: titleEl.textContent.trim(),
          price: parseFloat(priceMatch[1].replace(/,/g, '')),
          url: linkEl ? 'https://www.walmart.com' + linkEl.getAttribute('href') : '',
          image: imgEl ? imgEl.src : '',
          rating: null,
          retailer: 'Walmart',
        });
      }

      return results;
    }, maxResults);

    return products;
  } finally {
    await page.close();
  }
}

async function searchTarget(query, maxResults = 5) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    const url = `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    const products = await page.evaluate((max) => {
      const results = [];
      const items = document.querySelectorAll('[data-test="@web/site-top-of-funnel/ProductCardWrapper"]');

      for (const item of items) {
        if (results.length >= max) break;

        const titleEl = item.querySelector('a[data-test="product-title"]');
        const priceEl = item.querySelector('[data-test="current-price"]');
        const imgEl = item.querySelector('img');

        if (!titleEl || !priceEl) continue;

        const priceMatch = (priceEl.textContent || '').match(/\$?([\d,]+\.?\d*)/);
        if (!priceMatch) continue;

        results.push({
          name: titleEl.textContent.trim(),
          price: parseFloat(priceMatch[1].replace(/,/g, '')),
          url: 'https://www.target.com' + titleEl.getAttribute('href'),
          image: imgEl ? imgEl.src : '',
          rating: null,
          retailer: 'Target',
        });
      }

      return results;
    }, maxResults);

    return products;
  } finally {
    await page.close();
  }
}

async function searchProducts(query, retailer = 'amazon', maxResults = 5) {
  const r = (retailer || 'amazon').toLowerCase();
  try {
    if (r === 'walmart') return await searchWalmart(query, maxResults);
    if (r === 'target')  return await searchTarget(query, maxResults);
    return await searchAmazon(query, maxResults);
  } catch (err) {
    console.error(`[product-scraper] ${retailer} search failed:`, err.message);
    return [];
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { searchProducts, searchAmazon, searchWalmart, searchTarget, closeBrowser };
