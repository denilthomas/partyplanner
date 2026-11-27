// /api/moodboard: Claude plans pieces → Serper finds real listings →
// Claude picks a cohesive set. All three upstreams are stubbed via fetch.
process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.SERPER_API_KEY = 'serper-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;
const anthropicCalls = [];
const serperQueries = [];
let server, base;

const BOARD = {
  name: 'Garden Bunny ONE',
  description: 'Soft pastels and a gentle bunny motif.',
  palette: ['#f3e3a7', '#9cb79b', '#a9c7dc', '#faf7f0'],
  signature_motif: 'bunnies',
  pieces: [
    { item_name: 'balloon garland arch kit', bucket: 'wall_backdrop', shot: 'setup', search_query: 'pastel yellow sage blue balloon garland arch kit' },
    { item_name: 'bunny paper plates', bucket: 'tabletop', shot: 'detail', search_query: 'bunny print paper plates pastel' },
    { item_name: 'gingham tablecloth', bucket: 'tabletop', shot: 'detail', search_query: 'blue gingham plastic tablecloth' },
  ],
};

before(async () => {
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com')) {
      const body = JSON.parse(init.body);
      anthropicCalls.push(body);
      const tool = body.tools[0].name;
      const input = tool === 'plan_board'
        ? BOARD
        : { picks: [
          { item_name: 'balloon garland arch kit', candidate_index: 1, quantity: 1, reason: 'Matches the palette' },
          { item_name: 'bunny paper plates', candidate_index: 0, quantity: 2, reason: '2 packs of 24 for 40 guests' },
          { item_name: 'gingham tablecloth', candidate_index: -1, quantity: 1, reason: 'No good match' },
        ], budget_note: 'Under budget' };
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 't', name: tool, input }] }), { status: 200 });
    }
    if (u.startsWith('https://google.serper.dev')) {
      const q = JSON.parse(init.body).q;
      serperQueries.push(q);
      return new Response(JSON.stringify({ shopping: [
        { title: `${q} A`, price: '$12.99', source: 'Amazon.com', link: 'https://example.com/a', imageUrl: 'https://img.example.com/a.jpg' },
        { title: `${q} B`, price: '$24.50', source: 'Target', link: 'https://example.com/b', imageUrl: 'https://img.example.com/b.jpg' },
      ] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const app = require('../server.js');
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); global.fetch = realFetch; });

test('builds a board of real products, with no image generation', async () => {
  const r = await realFetch(`${base}/api/moodboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: { eventType: 'Birthday', guestCount: 40, budget: 400, setting: 'indoor', themePreference: 'garden bunny' } }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();

  assert.equal(d.theme.name, 'Garden Bunny ONE');
  assert.deepEqual(serperQueries, BOARD.pieces.map((p) => p.search_query), 'one shopping search per planned piece');

  const garland = d.picks.find((p) => p.item_name === 'balloon garland arch kit');
  assert.equal(garland.shot, 'setup');
  assert.deepEqual(garland.product, { title: 'pastel yellow sage blue balloon garland arch kit B', retailer: 'Target', link: 'https://example.com/b', price: 24.5, thumbnail: 'https://img.example.com/b.jpg' });
  assert.equal(d.picks.find((p) => p.item_name === 'gingham tablecloth').product, null, 'no fake product when nothing matched');
  assert.equal(d.subtotal, 50.48);

  // planner gets the plan; shopper gets the board theme + cohesion rules
  assert.match(anthropicCalls[0].messages[0].content, /Guests: 40/);
  assert.match(anthropicCalls[0].messages[0].content, /garden bunny/);
  assert.match(anthropicCalls[1].system, /MOOD BOARD MODE/);
  assert.match(anthropicCalls[1].messages[0].content, /signature_motif/);
  assert.match(anthropicCalls[1].messages[0].content, /"has_image": true/);
});

test('/api/shop keeps working without board rules', async () => {
  anthropicCalls.length = 0;
  const r = await realFetch(`${base}/api/shop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ item_name: 'bunny paper plates', bucket: 'tabletop', search_query: 'bunny plates' }], plan: { budget: 100 } }),
  });
  assert.equal(r.status, 200);
  assert.doesNotMatch(anthropicCalls[0].system, /MOOD BOARD MODE/);
});
