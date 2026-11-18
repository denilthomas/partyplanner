const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let server;
before(async () => { server = await h.startServer(); });
after(() => server?.stop());

const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health reports configured services without leaking keys', async () => {
  const d = await (await fetch(server.url + '/api/health')).json();
  assert.deepEqual(d, { ok: true, services: { anthropic: false, gemini: false, serper: false } });
});

test('static app + machines are served', async () => {
  for (const p of ['/', '/app.js', '/machines.js', '/styles.css']) {
    assert.equal((await fetch(server.url + p)).status, 200, p);
  }
});

test('checkout plan groups canonical-adapted items by retailer', async () => {
  const items = [
    { id: 'a', name: 'Plate pack', price: 10, store: 'Target', quantity: 3 },
    { id: 'b', name: 'Garland', price: 25, store: 'Amazon.com', quantity: 1 },
    { id: 'c', name: 'Mystery', price: 5, store: 'Etsy-ish Shop', quantity: 1 },
  ];
  const d = await (await post('/api/checkout/plan', { items })).json();
  assert.ok(d.retailers.some((r) => r.name === 'Target'));
});

test('agent endpoints fail loudly (non-200 + error) when keys are missing', async () => {
  const r = await post('/api/create-theme', { plan: { eventType: 'Birthday' }, theme_preference: 'zzz-uncached', fresh: true });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
  const s = await post('/api/shop', { items: [] });
  assert.equal(s.status, 400);
});
