// Shared harness for end-to-end tests: boots the real server on a random port
// (no API keys) and drives the real UI in headless Chrome. External AI/search
// endpoints are mocked at the browser's network layer so runs are free and
// deterministic; pure endpoints (e.g. /api/checkout/plan) hit the real server.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // fall back to puppeteer's bundled browser
}

async function startServer() {
  const port = 4100 + Math.floor(Math.random() * 800);
  const env = { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', SERPER_API_KEY: '' };
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return { url: `http://localhost:${port}`, stop: () => proc.kill() };
}

const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FIXTURES = {
  theme: {
    cached: false, key: 'birthday::boho',
    theme: { name: 'Boho Bloom', palette: ['#d4a373', '#faedcd'], style_anchor: 'warm boho' },
    facets: [{ facet: 'backdrop', prompt: 'b' }, { facet: 'table', prompt: 't' }, { facet: 'accent', prompt: 'a' }],
  },
  items: [
    { item_name: 'Balloon garland', bucket: 'wall_backdrop', importance: 5, estimated_price: 30, search_query: 'boho balloon garland', image_index: 0, bbox: [0, 0, 500, 500] },
    { item_name: 'Rattan plates', bucket: 'tabletop', importance: 4, estimated_price: 12, search_query: 'rattan plates', image_index: 1 },
  ],
  picks: [
    { item_name: 'Balloon garland', bucket: 'wall_backdrop', product: { title: 'Garland Kit', retailer: 'Amazon.com', link: 'https://example.com/g', price: 25, thumbnail: '' }, quantity: 1, reason: 'Best kit' },
    { item_name: 'Rattan plates', bucket: 'tabletop', product: { title: 'Plate pack', retailer: 'Target', link: 'https://example.com/p', price: 10, thumbnail: '' }, quantity: 3, reason: '3 packs for 40' },
  ],
};

/**
 * Open the app with mocked AI endpoints.
 * @param {object} opts
 *   routes: { '/api/x': (body, ctx) => ({ status?, json, delay? }) } overrides
 *   storage: object to seed into localStorage('partyplanner')
 */
async function openApp(browser, baseUrl, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { errors.push('dialog: ' + d.message()); await d.dismiss(); });

  const defaults = {
    '/api/create-theme': () => ({ json: FIXTURES.theme }),
    '/api/generate-image': () => ({ json: { images: [PX, PX, PX] } }),
    '/api/save-theme': () => ({ json: { id: 'x', images: [] } }),
    '/api/extract-items': () => ({ json: { items: FIXTURES.items } }),
    '/api/shop': () => ({ json: { picks: FIXTURES.picks, subtotal: 55, budget: 200 } }),
    '/api/chat': () => ({ json: { content: [{ type: 'text', text: 'ok' }] } }),
  };
  const routes = { ...defaults, ...(opts.routes || {}) };

  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = new URL(req.url());
    if (u.hostname.includes('stripe')) return req.respond({ status: 200, contentType: 'application/javascript', body: '' });
    const handler = routes[u.pathname];
    if (!handler || !u.pathname.startsWith('/api/')) return req.continue();
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch {}
    calls.push({ path: u.pathname, body });
    const r = await handler(body, { calls });
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    req.respond({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.json) });
  });

  // Every test starts from its own storage (seeded or empty); reloads within a
  // test keep whatever the app persisted.
  await page.evaluateOnNewDocument((s) => {
    if (!sessionStorage.getItem('__seeded')) {
      if (s) localStorage.setItem('partyplanner', JSON.stringify(s));
      else localStorage.removeItem('partyplanner');
      sessionStorage.setItem('__seeded', '1');
    }
  }, opts.storage || null);
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plan-cards .pp-card');
  return { page, calls, errors };
}

const visible = (page, sel) => page.$eval(sel, (el) => !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none').catch(() => false);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());

async function clickChip(page, cardIndex, label) {
  await page.evaluate((i, l) => {
    const card = document.querySelectorAll('#plan-cards .pp-card')[i];
    [...card.querySelectorAll('.pp-chip')].find((b) => b.textContent === l).click();
  }, cardIndex, label);
}

async function fillPlan(page) {
  await clickChip(page, 0, 'Birthday');
  await clickChip(page, 1, '$100–300');
  await page.evaluate(() => {
    const card = document.querySelectorAll('#plan-cards .pp-card')[4];
    [...card.querySelectorAll('.pp-chip')].find((b) => b.textContent === 'Boho').click();
  });
}

// Programmatic tap (logic only — see realTap for hit-testing).
async function tap(page, sel) {
  await page.$eval(sel, (el) => el.click());
}

// Real pointer tap at the element's centre: fails if something covers it.
// Returns what a finger would actually hit at the element's centre.
async function hitTarget(page, sel) {
  return page.$eval(sel, (el) => {
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { ok: !!hit && (hit === el || el.contains(hit)), hit: hit ? (hit.id || hit.className) : null };
  });
}

async function waitFor(page, fn, ...args) {
  return page.waitForFunction(fn, { timeout: 5000 }, ...args);
}

// Drive home → theme → decide → cart with fixtures.
async function reachCart(page) {
  await fillPlan(page);
  await tap(page, '#design-theme-btn');
  await waitFor(page, () => !document.querySelector('#theme-use').disabled);
  await tap(page, '#theme-use');
  await waitFor(page, () => !document.querySelector('#decide-screen').classList.contains('hidden'));
  await waitFor(page, () => !document.querySelector('#decide-shop').disabled);
  await tap(page, '#decide-shop');
  await waitFor(page, () => !document.querySelector('#cart-screen').classList.contains('hidden'));
}

async function launch() {
  return puppeteer.launch({ headless: true, executablePath: findChrome(), args: ['--no-sandbox'] });
}

module.exports = { startServer, openApp, launch, visible, text, fillPlan, reachCart, waitFor, clickChip, tap, hitTarget, FIXTURES, PX };
