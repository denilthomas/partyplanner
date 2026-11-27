// Mood-board path (opt-in with ?board): real product listings instead of AI images.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let server, browser;
before(async () => { server = await h.startServer(); browser = await h.launch(); });
after(async () => { await browser?.close(); server?.stop(); });

const prod = (title, retailer, price) => ({ title, retailer, link: 'https://example.com/' + encodeURIComponent(title), price, thumbnail: h.PX });
const BOARD = {
  theme: { name: 'Garden Bunny ONE', description: 'Soft pastels with a gentle bunny motif.', palette: ['#f3e3a7', '#9cb79b'] },
  picks: [
    { item_name: 'balloon garland arch kit', bucket: 'wall_backdrop', shot: 'setup', product: prod('Pastel Balloon Garland Arch Kit', 'Target', 24.5), quantity: 1, reason: 'Palette match' },
    { item_name: 'bunny paper plates', bucket: 'tabletop', shot: 'detail', product: prod('Bunny Paper Plates 24ct', 'Amazon.com', 12.99), quantity: 2, reason: '' },
    { item_name: 'gingham napkins', bucket: 'tabletop', shot: 'detail', product: prod('Blue Gingham Napkins', 'Walmart', 6), quantity: 1, reason: '' },
    { item_name: 'carrot favor bags', bucket: 'activity_favors', shot: 'detail', product: prod('Carrot Favor Bags', 'Amazon.com', 9.5), quantity: 1, reason: '' },
    { item_name: 'tablecloth', bucket: 'tabletop', shot: 'detail', product: null, quantity: 1, reason: 'No match' },
  ],
  subtotal: 65.98, budget: 200,
};

// The server streams: theme, then one pick per piece, then done.
const stream = (b) => [
  { type: 'theme', theme: b.theme, pieces: b.picks.map((p, index) => ({ index, item_name: p.item_name, bucket: p.bucket, shot: p.shot })) },
  ...b.picks.map((pick, index) => ({ type: 'pick', index, pick })),
  { type: 'done', subtotal: b.subtotal, budget: b.budget },
];

async function openBoardApp(routes = {}, path = '/?board') {
  const ctx = await h.openApp(browser, server.url, { routes: { '/api/moodboard': () => ({ delay: 300, ndjson: stream(BOARD) }), ...routes } });
  if (path !== '/') {
    await ctx.page.goto(server.url + path, { waitUntil: 'domcontentloaded' });
    await ctx.page.waitForSelector('#plan-cards .pp-row');
  }
  return ctx;
}

async function buildBoard(page) {
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => document.body.dataset.stage === 'board' && !document.querySelector('#board-add').disabled);
}

test('?board switches Design to a mood board of real products', async () => {
  const { page, calls, errors } = await openBoardApp();
  assert.equal(await h.text(page, '#design-theme-btn'), 'Build my board →');
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => document.body.dataset.stage === 'boarding');
  assert.ok((await page.$$('.board-skel')).length > 0, 'skeleton while loading');
  await h.waitFor(page, () => document.body.dataset.stage === 'board');

  assert.equal(calls.filter((c) => c.path === '/api/generate-image').length, 0, 'no AI images');
  assert.equal(calls.find((c) => c.path === '/api/moodboard').body.plan.eventType, 'Birthday');
  assert.equal(await h.text(page, '#board-title'), 'Garden Bunny ONE');
  assert.equal(await h.text(page, '#board-sub'), '4 real products · Target, Amazon, Walmart');
  assert.equal((await page.$$('#board-setup .board-tile')).length, 1, 'setup shot is the big hero');
  assert.equal((await page.$$('#board-details .board-tile')).length, 3, 'unmatched piece is not shown');
  const badges = await page.$$eval('.board-store', (els) => els.map((e) => e.textContent));
  assert.ok(badges.includes('Target · $24.50'), 'store + real price on each tile: ' + badges);
  const href = await page.$eval('#board-setup .board-img', (a) => [a.getAttribute('href'), a.target]);
  assert.deepEqual(href, ['https://example.com/Pastel%20Balloon%20Garland%20Arch%20Kit', '_blank']);
  assert.equal(await h.text(page, '#board-add'), 'Add all to cart · $65.98');
  assert.equal((await h.hitTarget(page, '#board-add')).ok, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('remove a tile, add all to cart, and Back returns to the board', async () => {
  const { page } = await openBoardApp();
  await buildBoard(page);
  await page.$$eval('#board-details .board-remove', (bs) => bs[2].click()); // carrot favor bags
  assert.equal((await page.$$('#board-details .board-tile')).length, 2);
  assert.equal(await h.text(page, '#board-add'), 'Add all to cart · $56.48');
  await h.tap(page, '#board-add');
  await h.waitFor(page, () => document.body.dataset.stage === 'cart');
  assert.equal(await h.text(page, '#cart-sub'), '3 items');
  assert.equal(await h.text(page, '#budget-label'), "You've used $56.48 of $200.00");
  await h.tap(page, '#cart-back');
  assert.equal(await page.evaluate(() => document.body.dataset.stage), 'board');
  await page.close();
});

test("the board's name never replaces the theme the user picked", async () => {
  const { page } = await openBoardApp();
  await buildBoard(page);
  await h.tap(page, '#board-back');
  await h.waitFor(page, () => document.body.dataset.stage === 'home');
  const row = await page.$$eval('#plan-cards .pp-row', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()).find((t) => t.startsWith('Theme')));
  assert.match(row, /Boho/);
  assert.doesNotMatch(row, /Garden Bunny/);
  await page.close();
});

test('a full-size photo replaces the thumbnail, and the chat button stays off the photos', async () => {
  const lines = stream(BOARD);
  const big = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"/>');
  lines.splice(lines.length - 1, 0, { type: 'image', index: 0, url: big });
  const { page } = await openBoardApp({ '/api/moodboard': () => ({ ndjson: lines }) });
  await buildBoard(page);
  await h.waitFor(page, () => document.querySelector('#board-setup img').src.startsWith('data:image/svg'));

  const overlap = await page.evaluate(() => {
    const fab = document.querySelector('.chat-open-btn').getBoundingClientRect();
    const footer = document.querySelector('.board-footer').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.board-footer .btn')].map((b) => b.getBoundingClientRect());
    const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { inFooter: fab.top >= footer.top - 1 && fab.bottom <= footer.bottom + 1, onButton: btns.some((b) => hits(fab, b)) };
  });
  assert.deepEqual(overlap, { inFooter: true, onButton: false });
  assert.equal((await h.hitTarget(page, '#board-add')).ok, true);
  assert.equal((await h.hitTarget(page, '#board-refresh')).ok, true);
  await page.close();
});

test('board survives a reload', async () => {
  const { page } = await openBoardApp();
  await buildBoard(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plan-cards .pp-row');
  assert.equal(await page.evaluate(() => document.body.dataset.stage), 'board');
  assert.equal((await page.$$('.board-tile')).length, 4);
  await page.close();
});

test('a failed board shows a retryable error', async () => {
  let n = 0;
  const { page } = await openBoardApp({ '/api/moodboard': () => (n++ === 0 ? { status: 500, json: { error: 'Mood board failed' } } : { ndjson: stream(BOARD) }) });
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => !!document.querySelector('#board-screen .stage-error'));
  await page.$eval('#board-screen .stage-error button', (b) => b.click());
  await h.waitFor(page, () => document.querySelectorAll('.board-tile:not(.board-skel)').length === 4);
  await page.close();
});

test('a board whose searches all come back empty shows an error, not a blank board', async () => {
  const empty = { ...BOARD, picks: BOARD.picks.map((p) => ({ ...p, product: null })) };
  const { page } = await openBoardApp({ '/api/moodboard': () => ({ ndjson: stream(empty) }) });
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => !!document.querySelector('#board-screen .stage-error'));
  assert.equal((await page.$$('.board-tile')).length, 0);
  assert.equal(await page.$eval('#board-add', (b) => b.disabled), true);
  await page.close();
});

test('the AI-image path stays the default; ?board=0 switches back', async () => {
  const { page } = await openBoardApp({}, '/?board=0');
  assert.equal(await h.text(page, '#design-theme-btn'), 'Design my theme →');
  await page.close();
});
