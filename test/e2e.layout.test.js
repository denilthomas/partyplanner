// Layout regressions found in the end-to-end screenshot review. Each asserts
// what a finger/eye actually hits, at a 390×844 phone viewport.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let server, browser;
before(async () => { server = await h.startServer(); browser = await h.launch(); });
after(async () => { await browser?.close(); server?.stop(); });

const cart = () => h.FIXTURES.picks.map((p, i) => ({ id: 'L' + i, ...p }));

// What is drawn on top at (x, y)?
const topAt = (page, x, y) => page.evaluate((x, y) => {
  const el = document.elementFromPoint(x, y);
  return el ? (el.closest('[id]') || el).id : null;
}, x, y);

test('sheet peek shows the real cart count, not "0 items"', async () => {
  const { page } = await h.openApp(browser, server.url, { storage: { partyPlan: { eventType: 'Birthday', budget: 200 }, partyBucket: cart() } });
  assert.equal(await h.text(page, '#sheet-item-count'), '2 items');
  await page.close();
});

test('home: scrolled content never shows through the top bar', async () => {
  const { page } = await h.openApp(browser, server.url);
  await page.$eval('#landing-overlay', (e) => e.scrollTo(0, 260));
  const bar = await page.$eval('.top-bar', (e) => {
    const bg = getComputedStyle(e).backgroundColor;
    const r = e.getBoundingClientRect();
    return { bg, bottom: r.bottom };
  });
  assert.notEqual(bar.bg, 'rgba(0, 0, 0, 0)', 'top bar is opaque on Home');
  // content starts below the bar at rest
  await page.$eval('#landing-overlay', (e) => e.scrollTo(0, 0));
  const headingTop = await page.$eval('.home-heading', (e) => e.getBoundingClientRect().top);
  assert.ok(headingTop >= bar.bottom, `heading (${headingTop}) starts below the bar (${bar.bottom})`);
  await page.close();
});

test('home: chat lane is always reachable and the floating chat button covers nothing', async () => {
  const { page } = await h.openApp(browser, server.url, { storage: { chatHistory: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] } });
  assert.equal(await h.visible(page, '#chat-open-btn'), false, 'FAB hidden on Home (the lane replaces it)');
  for (const y of [0, 300, 99999]) {
    await page.$eval('#landing-overlay', (e, y) => e.scrollTo(0, y), y);
    assert.equal((await h.hitTarget(page, '#home-chat-input')).ok, true, `lane tappable at scroll ${y}`);
  }
  await h.tap(page, '#home-chat-history');
  assert.ok(await page.$eval('#chat-drawer', (e) => e.classList.contains('open')), 'history button opens the drawer');
  await page.close();
});

test('full-screen steps: the chat button sits above the footer, not on it', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  const r = await page.evaluate(() => ({
    fab: document.querySelector('#chat-open-btn').getBoundingClientRect().bottom,
    footer: document.querySelector('#cart-screen .fs-footer').getBoundingClientRect().top,
  }));
  assert.ok(r.fab <= r.footer, `FAB bottom ${r.fab} ≤ footer top ${r.footer}`);
  const label = await page.$eval('#budget-label', (e) => { const b = e.getBoundingClientRect(); return [b.left + 8, b.top + b.height / 2]; });
  assert.notEqual(await topAt(page, label[0], label[1]), 'chat-open-btn');
  await page.close();
});

test('checkout sheet leads with the order, not the plan card', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  await h.tap(page, '#cart-checkout');
  await h.waitFor(page, () => document.querySelectorAll('.checkout-retailer-group').length > 0);
  assert.equal(await h.visible(page, '#plan-card'), false);
  await new Promise((r) => setTimeout(r, 700)); // let the sheet finish sliding up
  const totalTop = await page.$eval('#checkout-summary', (e) => e.getBoundingClientRect().top);
  assert.ok(totalTop < 844 / 2, `order total in the top half (${totalTop})`);
  // back in browse mode the plan card returns
  await page.$eval('#checkout-email', (e) => { e.value = 'a@b.co'; });
  await page.$eval('#checkout-street', (e) => { e.value = '1 Main'; });
  await h.tap(page, '#checkout-place-order-btn');
  await h.waitFor(page, () => !!document.querySelector('#checkout-done-btn'));
  await h.tap(page, '#checkout-done-btn');
  assert.equal(await h.visible(page, '#plan-card'), true);
  await page.close();
});

test('top bar icons are legible (dark on light) on every stage', async () => {
  const { page } = await h.openApp(browser, server.url);
  const colors = async () => page.$$eval('.top-bar-icon-btn, .bucket-badge', (els) => els.map((e) => getComputedStyle(e).color));
  for (const c of await colors()) assert.notEqual(c, 'rgb(255, 255, 255)');
  await h.reachCart(page);
  assert.equal(await page.$eval('.top-bar', (e) => getComputedStyle(e).backgroundImage), 'none', 'no dark gradient over step headers');
  await page.close();
});
