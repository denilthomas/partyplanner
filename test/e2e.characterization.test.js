// Characterization tests: pin down what the app does TODAY so refactors can't
// silently change it. Written purely against user-visible DOM + network calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let server, browser;
before(async () => { server = await h.startServer(); browser = await h.launch(); });
after(async () => { await browser?.close(); server?.stop(); });

test('home: 5 plan rows; Design is gated on party type + theme', async () => {
  const { page, errors } = await h.openApp(browser, server.url);
  assert.equal((await page.$$('#plan-cards .pp-row')).length, 5);
  assert.equal(await page.$eval('#design-theme-btn', (b) => b.disabled), true);
  await h.clickChip(page, 0, 'Birthday');
  assert.equal(await page.$eval('#design-theme-btn', (b) => b.disabled), true, 'type alone is not enough');
  await h.clickChip(page, 4, 'Boho');
  assert.equal(await page.$eval('#design-theme-btn', (b) => b.disabled), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('plan persists across reload', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.fillPlan(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plan-cards .pp-row');
  const plan = await page.evaluate(() => JSON.parse(localStorage.getItem('partyplanner')).partyPlan);
  assert.equal(plan.eventType, 'Birthday');
  assert.equal(plan.budget, 200);
  assert.equal(plan.themePreference, 'Boho');
  await page.close();
});

test('happy path: design → choose facets → extract → decide → shop → cart', async () => {
  const { page, calls, errors } = await h.openApp(browser, server.url);
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  assert.ok(await h.visible(page, '#theme-screen'));
  assert.equal(await h.visible(page, '#landing-overlay'), false);

  await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
  assert.equal(await h.text(page, '#theme-title'), 'Boho Bloom');
  assert.equal((await page.$$('.facet-tile.selected')).length, 3, 'first variation preselected per facet');
  assert.equal(calls.filter((c) => c.path === '/api/generate-image').length, 3, 'one generate call per facet');

  await h.tap(page, '#theme-use');
  await h.waitFor(page, () => !document.querySelector('#decide-screen').classList.contains('hidden'));
  assert.equal(await h.text(page, '#decide-sub'), '2 pieces found');
  assert.equal(await h.text(page, '#decide-shop'), 'Find products (2)');
  assert.ok(calls.some((c) => c.path === '/api/save-theme'), 'generated theme saved to library');

  await h.tap(page, '#decide-shop');
  await h.waitFor(page, () => !document.querySelector('#cart-screen').classList.contains('hidden'));
  assert.equal(await h.text(page, '#cart-sub'), '2 items');
  assert.equal(await h.text(page, '#budget-label'), "You've used $55.00 of $200.00");
  const shopCall = calls.find((c) => c.path === '/api/shop');
  assert.equal(shopCall.body.items.length, 2);
  assert.equal(shopCall.body.plan.eventType, 'Birthday');
  assert.deepEqual(errors, []);
  await page.close();
});

test('cart: quantity stepper, remove line, budget over state', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  for (let i = 0; i < 15; i++) await h.tap(page, '#cart-list [data-act=inc]'); // 16 × $25 = 400 + 30
  assert.equal(await page.$eval('#cart-list .cart-qty', (e) => e.textContent), '16');
  assert.match(await h.text(page, '#budget-label'), /over your \$200\.00 budget/);
  assert.ok(await page.$eval('#budget-tracker', (e) => e.classList.contains('over')));
  await h.tap(page, '#cart-list [data-act=remove]');
  assert.equal(await h.text(page, '#cart-sub'), '1 items');
  await page.close();
});

test('cart → checkout opens the sheet checkout grouped by retailer', async () => {
  const { page, errors } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  await h.tap(page, '#cart-checkout');
  await h.waitFor(page, () => document.querySelectorAll('.checkout-retailer-group').length > 0);
  assert.equal(await h.visible(page, '#cart-screen'), false);
  assert.ok(await page.$eval('#bottom-sheet', (e) => e.classList.contains('sheet-full')));
  const groups = await page.$$eval('.checkout-retailer-header strong', (els) => els.map((e) => e.textContent));
  assert.ok(groups.includes('Target'), 'Target grouped as UCP retailer: ' + groups);
  assert.match(await h.text(page, '#checkout-summary'), /Total \(2 items\)\s*\$55\.00/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('back buttons: decide → theme, cart → decide, theme → home', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  await h.tap(page, '#cart-back');
  assert.ok(await h.visible(page, '#decide-screen'));
  await h.tap(page, '#decide-back');
  assert.ok(await h.visible(page, '#theme-screen'));
  await h.tap(page, '#theme-back');
  assert.ok(await h.visible(page, '#landing-overlay'));
  await page.close();
});

test('chat assist: update_party_plan tool fills the cards', async () => {
  let n = 0;
  const { page, calls } = await h.openApp(browser, server.url, {
    routes: {
      '/api/chat': () => (n++ === 0
        ? { json: { content: [{ type: 'text', text: 'Got it!' }, { type: 'tool_use', id: 't1', name: 'update_party_plan', input: { eventType: 'Wedding', guestCount: 40 } }] } }
        : { json: { content: [{ type: 'text', text: 'Cards updated.' }] } }),
    },
  });
  await page.type('#home-chat-input', '40 people wedding');
  await h.tap(page, '#home-chat-send');
  await h.waitFor(page, () => document.querySelectorAll('#chat-messages .chat-message.assistant').length >= 2);
  const plan = await page.evaluate(() => JSON.parse(localStorage.getItem('partyplanner')).partyPlan);
  assert.equal(plan.eventType, 'Wedding');
  assert.equal(plan.guestCount, 40);
  const second = calls.filter((c) => c.path === '/api/chat')[1];
  const last = second.body.messages[second.body.messages.length - 1];
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 't1');
  await page.close();
});

test('chat assist: create_theme tool opens the theme designer', async () => {
  let n = 0;
  const { page } = await h.openApp(browser, server.url, {
    routes: {
      '/api/chat': () => (n++ === 0
        ? { json: { content: [{ type: 'tool_use', id: 't1', name: 'create_theme', input: { theme_preference: 'Boho' } }] } }
        : { json: { content: [{ type: 'text', text: 'Pick your favorites!' }] } }),
    },
  });
  await page.type('#home-chat-input', 'design a boho birthday');
  await h.tap(page, '#home-chat-send');
  await h.waitFor(page, () => !document.querySelector('#theme-screen').classList.contains('hidden'));
  await h.waitFor(page, () => document.querySelector('#theme-title').textContent === 'Boho Bloom');
  await page.close();
});
