// Regression tests for bugs that came from IMPLICIT state (state spread across
// DOM classes, closures and loosely-shaped objects). Each test names the
// machine it exercises. All of these failed before the explicit-FSM refactor.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let server, browser;
before(async () => { server = await h.startServer(); browser = await h.launch(); });
after(async () => { await browser?.close(); server?.stop(); });

const cartShapeBucket = () => h.FIXTURES.picks.map((p, i) => ({ id: 'L' + i, ...p }));

// ── Journey machine: one stage → exactly one surface ──

test('journey: footer CTAs are tappable (not covered by the bottom sheet)', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
  assert.deepEqual(await h.hitTarget(page, '#theme-use'), { ok: true, hit: 'theme-use' });
  await h.tap(page, '#theme-use');
  await h.waitFor(page, () => !document.querySelector('#decide-shop').disabled);
  assert.equal((await h.hitTarget(page, '#decide-shop')).ok, true);
  await h.tap(page, '#decide-shop');
  await h.waitFor(page, () => !document.querySelector('#cart-screen').classList.contains('hidden'));
  assert.equal((await h.hitTarget(page, '#cart-checkout')).ok, true);
  await page.close();
});

test('journey: reload mid-flow resumes at the cart', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plan-cards .pp-card');
  assert.ok(await h.visible(page, '#cart-screen'), 'cart screen restored');
  assert.equal(await h.visible(page, '#landing-overlay'), false);
  assert.equal(await h.text(page, '#cart-sub'), '2 items');
  // after a reload there is no in-memory theme, so Back from decide must go home, not to an empty theme screen
  await h.tap(page, '#cart-back');
  await h.tap(page, '#decide-back');
  assert.ok(await h.visible(page, '#landing-overlay'));
  await page.close();
});

test('journey: checkout Done returns to home (no blank screen)', async () => {
  const { page } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  await h.tap(page, '#cart-checkout');
  await h.waitFor(page, () => document.querySelectorAll('.checkout-retailer-group').length > 0);
  await page.type('#checkout-email', 'a@b.co');
  await page.type('#checkout-street', '1 Main');
  await h.tap(page, '#checkout-place-order-btn');
  await h.waitFor(page, () => !!document.querySelector('#checkout-done-btn'));
  await h.tap(page, '#checkout-done-btn');
  assert.ok(await h.visible(page, '#landing-overlay'), 'landing visible after Done');
  await page.close();
});

// ── Sheet/checkout machine ──

test('checkout: a second checkout in the same session still works', async () => {
  const { page, errors } = await h.openApp(browser, server.url);
  for (let round = 0; round < 2; round++) {
    await h.reachCart(page);
    await h.tap(page, '#cart-checkout');
    await h.waitFor(page, () => document.querySelectorAll('.checkout-retailer-group').length > 0);
    await page.$eval('#checkout-email', (e) => { e.value = 'a@b.co'; });
    await page.$eval('#checkout-street', (e) => { e.value = '1 Main'; });
    await h.tap(page, '#checkout-place-order-btn');
    await h.waitFor(page, () => !!document.querySelector('#checkout-done-btn'));
    await h.tap(page, '#checkout-done-btn');
  }
  assert.deepEqual(errors, []);
  await page.close();
});

// ── Cart model: one line shape everywhere ──

test('cart: bucket total is a number after shopping + reload', async () => {
  const { page } = await h.openApp(browser, server.url, {
    storage: { partyPlan: { eventType: 'Birthday', budget: 200 }, partyBucket: cartShapeBucket() },
  });
  assert.equal(await h.text(page, '#bucket-total-price'), '$55.00');
  assert.equal(await h.text(page, '#bucket-count-badge'), '2');
  await page.close();
});

test('cart: legacy checkout-shaped lines migrate on load', async () => {
  const { page } = await h.openApp(browser, server.url, {
    storage: { partyBucket: [{ id: 'x', name: 'Garland Kit', price: 25, store: 'Amazon.com', bucket: 'wall_backdrop', quantity: 2, url: 'https://example.com/g', image: '' }] },
  });
  assert.equal(await h.text(page, '#bucket-total-price'), '$50.00');
  await page.close();
});

test('cart: agent remove works on shopped lines (no crash)', async () => {
  let n = 0;
  const { page, errors } = await h.openApp(browser, server.url, {
    routes: {
      '/api/chat': () => (n++ === 0
        ? { json: { content: [{ type: 'tool_use', id: 't1', name: 'update_party_bucket', input: { actions: [{ action: 'remove', item_name: 'plates' }] } }] } }
        : { json: { content: [{ type: 'text', text: 'Removed.' }] } }),
    },
  });
  await h.reachCart(page);
  await h.tap(page, '#chat-open-btn');
  await page.type('#chat-input', 'remove the plates');
  await h.tap(page, '#chat-send-btn');
  await h.waitFor(page, () => [...document.querySelectorAll('#chat-messages .chat-message')].some((m) => m.textContent === 'Removed.'));
  assert.deepEqual(errors, []);
  assert.equal(await h.text(page, '#cart-sub'), '1 items', 'cart screen re-rendered');
  assert.equal(await h.text(page, '#bucket-total-price'), '$25.00');
  await page.close();
});

test('cart: shop failure keeps you on Decide with an error, not an empty cart', async () => {
  const { page } = await h.openApp(browser, server.url, {
    routes: { '/api/shop': () => ({ status: 500, json: { error: 'Shopping failed', picks: [] } }) },
  });
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
  await h.tap(page, '#theme-use');
  await h.waitFor(page, () => !document.querySelector('#decide-shop').disabled);
  await h.tap(page, '#decide-shop');
  await h.waitFor(page, () => !!document.querySelector('#decide-screen .stage-error'));
  assert.equal(await h.visible(page, '#cart-screen'), false);
  assert.equal(await h.text(page, '#decide-shop'), 'Find products (2)', 'button label keeps the count');
  await page.close();
});

// ── Theme designer machine ──

test('theme: a slow stale response cannot overwrite a newer one', async () => {
  let n = 0;
  const { page } = await h.openApp(browser, server.url, {
    routes: {
      '/api/create-theme': () => (n++ === 0
        ? { delay: 900, json: { ...h.FIXTURES.theme, theme: { ...h.FIXTURES.theme.theme, name: 'Stale' } } }
        : { json: { ...h.FIXTURES.theme, theme: { ...h.FIXTURES.theme.theme, name: 'Fresh' } } }),
    },
  });
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.tap(page, '#theme-regen');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(await h.text(page, '#theme-title'), 'Fresh');
  await page.close();
});

test('theme: "Try a different look" asks for a fresh theme, and the cap resets per theme', async () => {
  const { page, calls } = await h.openApp(browser, server.url);
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  for (let i = 0; i < 3; i++) {
    await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
    await h.tap(page, '#theme-regen');
  }
  const creates = calls.filter((c) => c.path === '/api/create-theme');
  assert.equal(creates[0].body.fresh, undefined, 'first design may use the library cache');
  assert.equal(creates[1].body.fresh, true, 'regenerate bypasses the cache');
  assert.equal(await page.$eval('#theme-regen', (b) => b.disabled), true, 'capped after 3');
  await h.tap(page, '#theme-back');
  await h.clickChip(page, 4, 'Dinosaur');
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
  assert.equal(await page.$eval('#theme-regen', (b) => b.disabled), false, 'new theme gets a fresh budget');
  await page.close();
});

test('theme: a facet whose images failed can be retried', async () => {
  let gen = 0;
  const { page } = await h.openApp(browser, server.url, {
    routes: { '/api/generate-image': () => (gen++ < 3 ? { json: { images: [] } } : { json: { images: [h.PX, h.PX, h.PX] } }) },
  });
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => document.querySelectorAll('.facet-retry').length === 3);
  assert.equal(await page.$eval('#theme-use', (b) => b.disabled), true);
  await page.$$eval('.facet-retry', (bs) => bs.forEach((b) => b.click()));
  await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
  await page.close();
});

test('theme: extraction failure shows a retryable error instead of "0 pieces found"', async () => {
  let ex = 0;
  const { page } = await h.openApp(browser, server.url, {
    routes: { '/api/extract-items': () => (ex++ === 0 ? { status: 500, json: { error: 'Item extraction failed', items: [] } } : { json: { items: h.FIXTURES.items } }) },
  });
  await h.fillPlan(page);
  await h.tap(page, '#design-theme-btn');
  await h.waitFor(page, () => !document.querySelector('#theme-use').disabled);
  await h.tap(page, '#theme-use');
  await h.waitFor(page, () => !!document.querySelector('#theme-screen .stage-error'));
  assert.equal(await h.visible(page, '#decide-screen'), false);
  await h.tap(page, '#theme-use'); // retry
  await h.waitFor(page, () => !document.querySelector('#decide-screen').classList.contains('hidden'));
  assert.equal(await h.text(page, '#decide-sub'), '2 pieces found');
  await page.close();
});

// ── Plan machine: derived theme state stays consistent ──

test('plan: changing the theme preference invalidates the previously designed theme', async () => {
  const { page } = await h.openApp(browser, server.url, {
    storage: { partyPlan: { eventType: 'Birthday', themePreference: 'Boho', theme: { name: 'Boho Bloom', source: 'generated' } } },
  });
  await h.clickChip(page, 4, 'Dinosaur');
  const plan = await page.evaluate(() => JSON.parse(localStorage.getItem('partyplanner')).partyPlan);
  assert.equal(plan.theme, null);
  assert.match(await h.text(page, '#plan-card'), /Dinosaur/);
  await page.close();
});

// ── Agent loop machine ──

test('agent: one request in flight at a time (no interleaved turns)', async () => {
  let inflight = 0, maxInflight = 0;
  const { page, calls } = await h.openApp(browser, server.url, {
    routes: {
      '/api/chat': async () => {
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 400));
        inflight--;
        return { json: { content: [{ type: 'text', text: 'ok' }] } };
      },
    },
  });
  await h.tap(page, '#chat-open-btn');
  await page.type('#chat-input', 'one');
  await h.tap(page, '#chat-send-btn');
  await page.type('#chat-input', 'two');
  await h.tap(page, '#chat-send-btn');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(maxInflight, 1);
  // every request alternates user/assistant correctly
  for (const c of calls.filter((x) => x.path === '/api/chat')) {
    const roles = c.body.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], 'roles alternate: ' + roles);
  }
  await page.close();
});

test('agent: tool loop is bounded', async () => {
  const { page, calls } = await h.openApp(browser, server.url, {
    routes: { '/api/chat': () => ({ json: { content: [{ type: 'tool_use', id: 't' + Math.random(), name: 'update_party_plan', input: { guestCount: 10 } }] } }) },
  });
  await page.type('#home-chat-input', 'loop forever');
  await h.tap(page, '#home-chat-send');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(calls.filter((c) => c.path === '/api/chat').length <= 6, 'capped turns');
  await page.close();
});

test('agent: sees the journey stage and cart in its context', async () => {
  const { page, calls } = await h.openApp(browser, server.url);
  await h.reachCart(page);
  await h.tap(page, '#chat-open-btn');
  await page.type('#chat-input', 'how am I doing on budget?');
  await h.tap(page, '#chat-send-btn');
  await h.waitFor(page, () => document.querySelectorAll('#chat-messages .chat-message.assistant').length >= 1);
  const sys = calls.filter((c) => c.path === '/api/chat').pop().body.system;
  assert.match(sys, /Stage: cart/);
  assert.match(sys, /Cart: 2 lines, \$55\.00/);
  await page.close();
});

test('agent: conversation memory survives reload', async () => {
  const { page, calls } = await h.openApp(browser, server.url, {
    storage: { chatHistory: [{ role: 'user', text: 'boho first birthday' }, { role: 'assistant', text: 'Love it!' }] },
  });
  await h.tap(page, '#chat-open-btn');
  await page.type('#chat-input', 'make it 30 people');
  await h.tap(page, '#chat-send-btn');
  await h.waitFor(page, () => document.querySelectorAll('#chat-messages .chat-message.assistant').length >= 2);
  const msgs = calls.find((c) => c.path === '/api/chat').body.messages;
  assert.equal(msgs[0].content, 'boho first birthday');
  assert.equal(msgs.length, 3);
  await page.close();
});
