const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/machines');

test('journey: every transition target exists and every stage has a surface', () => {
  for (const [name, node] of Object.entries(M.JOURNEY.states)) {
    assert.ok(M.STAGE_SURFACE[name], `surface for ${name}`);
    assert.ok(M.STAGE_DESCRIPTION[name], `description for ${name}`);
    for (const [ev, target] of Object.entries(node.on || {})) {
      const targets = typeof target === 'function' ? [target({ hasTheme: true, hasItems: true, via: 'board', hasBoard: true }), target({})] : [target];
      for (const t of targets) assert.ok(M.JOURNEY.states[t], `${name} --${ev}--> ${t}`);
    }
  }
});

test('journey: every stage is reachable from home and can get back home', () => {
  const graph = {};
  for (const [s, n] of Object.entries(M.JOURNEY.states)) {
    graph[s] = Object.values(n.on || {}).flatMap((t) => (typeof t === 'function' ? [t({ hasTheme: true, hasItems: true, via: 'board', hasBoard: true }), t({})] : [t]));
  }
  const reach = (from) => { const seen = new Set([from]); const q = [from]; while (q.length) for (const n of graph[q.shift()]) if (!seen.has(n)) { seen.add(n); q.push(n); } return seen; };
  assert.deepEqual([...reach('home')].sort(), Object.keys(graph).sort());
  for (const s of Object.keys(graph)) assert.ok(reach(s).has('home'), `${s} can return home`);
});

test('journey: happy path and illegal events', () => {
  const j = M.createJourney();
  assert.equal(j.send('SHOP'), false, 'cannot shop from home');
  assert.equal(j.state, 'home');
  for (const ev of ['DESIGN', 'ACCEPT', 'EXTRACTED', 'SHOP', 'SHOPPED']) assert.ok(j.send(ev), ev);
  assert.equal(j.state, 'cart');
  assert.equal(j.send('DESIGN') && j.state, 'theme');
  assert.equal(j.history.length, 6);
});

test('journey: guarded Back from decide depends on whether a theme is in memory', () => {
  const j = M.createJourney('decide');
  j.send('BACK', { hasTheme: false });
  assert.equal(j.state, 'home');
  const k = M.createJourney('decide');
  k.send('BACK', { hasTheme: true });
  assert.equal(k.state, 'theme');
});

test('journey: resume maps transient stages to persisted ones', () => {
  const full = { extractedItems: [1], partyBucket: [1] };
  assert.equal(M.resumeStage('cart', full), 'cart');
  assert.equal(M.resumeStage('shopping', full), 'decide');
  assert.equal(M.resumeStage('extracting', full), 'home');
  assert.equal(M.resumeStage('theme', full), 'home');
  assert.equal(M.resumeStage('cart', { extractedItems: [1], partyBucket: [] }), 'decide');
  assert.equal(M.resumeStage('decide', {}), 'home');
  assert.equal(M.resumeStage(undefined, full), 'home');
});

test('plan: readiness and theme label', () => {
  assert.deepEqual(M.planReadiness(M.emptyPlan()), { ready: false, missing: ['party type', 'theme'] });
  assert.equal(M.planReadiness({ eventType: 'Birthday', themePreference: 'Boho' }).ready, true);
  assert.equal(M.themeLabel({ themePreference: 'Boho', theme: null }), 'Boho');
  assert.equal(M.themeLabel({ themePreference: 'Boho', theme: { name: 'Boho Bloom' } }), 'Boho Bloom');
  assert.equal(M.themeRequest({ themePreference: 'Boho', theme: { name: 'Boho Bloom' } }), 'Boho');
});

test('plan: changing type or theme preference invalidates the designed theme', () => {
  const base = { eventType: 'Birthday', themePreference: 'Boho', theme: { name: 'Boho Bloom' } };
  assert.equal(M.applyPlanUpdate(base, { budget: 300 }).plan.theme.name, 'Boho Bloom');
  assert.equal(M.applyPlanUpdate(base, { themePreference: 'Boho' }).invalidatedTheme, false, 'same value is a no-op');
  assert.equal(M.applyPlanUpdate(base, { themePreference: 'Dino' }).plan.theme, null);
  assert.equal(M.applyPlanUpdate(base, { eventType: 'Wedding' }).plan.theme, null);
  assert.deepEqual(M.applyPlanUpdate(base, { budget: 300, guestCount: 40 }).changed, ['budget', 'guestCount']);
});

test('cart: normalizes picks, canonical and legacy lines to one shape', () => {
  const pick = { item_name: 'Plates', bucket: 'tabletop', product: { title: 'Plate pack', retailer: 'Target', link: 'l', price: 10, thumbnail: '' }, quantity: 3 };
  const legacy = { id: 'x', name: 'Garland Kit', price: 25, store: 'Amazon.com', quantity: 2, url: 'u', image: 'i' };
  const [a, b] = M.normalizeCart([pick, legacy]);
  assert.equal(a.product.price, 10);
  assert.equal(b.item_name, 'Garland Kit');
  assert.deepEqual(b.product, { title: 'Garland Kit', retailer: 'Amazon.com', link: 'u', price: 25, thumbnail: 'i' });
  assert.equal(M.subtotal([a, b]), 80);
  assert.deepEqual(M.normalizeLine(a), a, 'idempotent');
});

test('cart: checkout adapter matches the server contract', () => {
  const [l] = M.normalizeCart([{ id: 'i', item_name: 'Plates', bucket: 'tabletop', quantity: 2, product: { title: 'Plate pack', retailer: 'Target', link: 'l', price: 10 } }]);
  assert.deepEqual(M.toCheckoutItems([l]), [{ id: 'i', name: 'Plate pack', price: 10, store: 'Target', bucket: 'tabletop', quantity: 2, url: 'l', image: '' }]);
});

test('cart: find by name matches item or product title; budget status', () => {
  const lines = M.normalizeCart([{ item_name: 'Rattan plates', product: { title: 'Plate pack', price: 10 } }, { item_name: 'Garland', product: { title: 'Kit', price: 25 }, quantity: 4 }]);
  assert.equal(M.findLineByName(lines, 'PLATES'), 0);
  assert.equal(M.findLineByName(lines, 'kit'), 1);
  assert.equal(M.findLineByName(lines, ''), -1);
  assert.deepEqual(M.budgetStatus(lines, 100), { subtotal: 110, budget: 100, state: 'over', delta: 10 });
  assert.equal(M.budgetStatus(lines, null).state, 'no_budget');
});

test('agent: messages always alternate roles; tool_results lead a user turn', () => {
  const msgs = [];
  M.pushMessage(msgs, 'user', 'hi');
  M.pushMessage(msgs, 'user', 'again');
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi\nagain' }]);
  M.pushMessage(msgs, 'assistant', [{ type: 'tool_use', id: 't' }]);
  M.pushMessage(msgs, 'user', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]);
  M.pushMessage(msgs, 'user', 'next question');
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[2].content[1].text, 'next question');
});

test('agent: transcript rebuild drops leading assistant lines', () => {
  const msgs = M.messagesFromTranscript([{ role: 'assistant', text: 'welcome' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'c' }]);
  assert.deepEqual(msgs, [{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c' }]);
});

test('agent: loop machine only allows one turn at a time', () => {
  const a = M.createAgent();
  assert.ok(a.send('SEND'));
  assert.equal(a.send('SEND'), false);
  assert.ok(a.send('DONE'));
  assert.equal(a.state, 'idle');
});

test('designer: tokens make stale responses detectable; regen budget is per theme', () => {
  const d = M.createDesigner();
  const t1 = d.begin('Boho');
  const t2 = d.begin('Boho');
  assert.equal(d.isCurrent(t1), false);
  assert.equal(d.isCurrent(t2), true);
  assert.equal(d.regensLeft(), 3);
  d.useRegen(); d.useRegen(); d.useRegen();
  assert.equal(d.regensLeft(), 0);
  assert.equal(d.regensLeft('Dinosaur'), 3);
  assert.equal(d.regensLeft(' boho '), 0, 'normalized key');
});

test('designer: accept requires a pick for every facet that exists', () => {
  const d = M.createDesigner();
  d.begin('x');
  d.status = 'ready';
  d.facets = { backdrop: {}, table: {} };
  d.chosen = { backdrop: 'a' };
  assert.equal(d.canAccept(), false);
  d.chosen.table = 'b';
  assert.equal(d.canAccept(), true);
});

test('journey: mood-board path and its resume rules', () => {
  const j = M.createJourney();
  for (const ev of ['DESIGN_BOARD', 'BOARD_READY', 'ADD_TO_CART']) assert.ok(j.send(ev), ev);
  assert.equal(j.state, 'cart');
  j.send('BACK', { via: 'board', hasBoard: true, hasItems: true });
  assert.equal(j.state, 'board', 'back from a board cart returns to the board');
  const k = M.createJourney('cart');
  k.send('BACK', { via: 'theme', hasBoard: true, hasItems: true });
  assert.equal(k.state, 'decide', 'AI-image path unchanged');
  assert.equal(M.createJourney('boarding').send('ADD_TO_CART'), false, 'cannot add while still loading');
  const board = { picks: [1] };
  assert.equal(M.resumeStage('board', { board }), 'board');
  assert.equal(M.resumeStage('boarding', { board }), 'board');
  assert.equal(M.resumeStage('boarding', {}), 'home');
  assert.equal(M.resumeStage('cart', { board, partyBucket: [] }), 'board');
});
