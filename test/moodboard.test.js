// /api/moodboard: Claude plans pieces → Serper finds real listings, streamed
// back as NDJSON. One Claude call only. Upstreams are stubbed via fetch.
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
    { item_name: 'bunny paper plates', bucket: 'tabletop', shot: 'detail', search_query: 'bunny print paper plates pastel', quantity: 2 },
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
    if (u.startsWith('https://google.serper.dev/images')) {
      const q = JSON.parse(init.body).q;
      // full-size photo only for the garland; plates get a photo of a different product
      if (q.includes('garland')) return new Response(JSON.stringify({ images: [
        { title: 'Pastel yellow sage blue balloon garland arch kit A', imageUrl: 'https://img.example.com/a-full.jpg', imageWidth: 1200, domain: 'www.amazon.com' },
      ] }), { status: 200 });
      return new Response(JSON.stringify({ images: [
        { title: 'Dinosaur napkins 20 pack', imageUrl: 'https://img.example.com/wrong.jpg', imageWidth: 1200, domain: 'www.amazon.com' },
      ] }), { status: 200 });
    }
    if (u.startsWith('https://google.serper.dev')) {
      const q = JSON.parse(init.body).q;
      serperQueries.push(q);
      if (q.includes('tablecloth')) return new Response(JSON.stringify({ shopping: [] }), { status: 200 });
      return new Response(JSON.stringify({ shopping: [
        { title: `${q} no photo`, price: '$9.99', source: 'Walmart', link: 'https://example.com/x' },
        { title: `Personalized ${q}`, price: '$19.99', source: 'Etsy - PopFestCo', link: 'https://example.com/c', imageUrl: 'https://img.example.com/c.jpg' },
        { title: `${q} A`, price: '$12.99', source: 'Amazon.com', link: `https://example.com/${encodeURIComponent(q)}/a`, imageUrl: 'https://img.example.com/a.jpg' },
        { title: `${q} B`, price: '$24.50', source: 'Target', link: `https://example.com/${encodeURIComponent(q)}/b`, imageUrl: 'https://img.example.com/b.jpg' },
      ] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const app = require('../server.js');
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); global.fetch = realFetch; });

test('streams a board of real products: theme first, then one pick per piece', async () => {
  const r = await realFetch(`${base}/api/moodboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: { eventType: 'Birthday', guestCount: 40, budget: 400, setting: 'indoor', themePreference: 'garden bunny' } }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /ndjson/);
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));

  assert.equal(lines[0].type, 'theme');
  assert.equal(lines[0].theme.name, 'Garden Bunny ONE');
  assert.deepEqual(lines[0].pieces.map((p) => p.shot), ['setup', 'detail', 'detail']);
  assert.equal(lines.at(-1).type, 'done');
  const picks = lines.filter((l) => l.type === 'pick');
  assert.equal(picks.length, 3);

  assert.equal(anthropicCalls.length, 1, 'one Claude call: the planner; no shopper pass');
  assert.match(anthropicCalls[0].messages[0].content, /Guests: 40/);
  assert.match(anthropicCalls[0].messages[0].content, /garden bunny/);

  const byIndex = Object.fromEntries(picks.map((l) => [l.index, l.pick]));
  // skips the result with no photo, takes the next one
  assert.deepEqual(byIndex[0].product, { title: 'pastel yellow sage blue balloon garland arch kit A', retailer: 'Amazon', link: 'https://example.com/pastel%20yellow%20sage%20blue%20balloon%20garland%20arch%20kit/a', price: 12.99, thumbnail: 'https://img.example.com/a.jpg' });
  assert.equal(byIndex[1].quantity, 2, 'planner sets quantity');
  assert.equal(byIndex[2].product, null, 'no fake product when nothing matched');
  assert.equal(lines.at(-1).subtotal, 38.97);

  // full-size photo only when the store and title match
  const images = lines.filter((l) => l.type === 'image');
  assert.deepEqual(images.map((l) => [l.index, l.url]), [[0, 'https://img.example.com/a-full.jpg']]);
  assert.ok(lines.indexOf(images[0]) < lines.length - 1, 'image arrives before done');
  assert.ok(lines.at(-1).timings.total_ms >= 0);
});

test('store names are clean and personalized listings are skipped', () => {
  const { retailerName, titleOverlap } = require('../mcp-servers/serper-search');
  assert.equal(retailerName('Etsy - PopFestCo'), 'Etsy');
  assert.equal(retailerName('Amazon.com - Seller'), 'Amazon');
  assert.equal(retailerName('Walmart - Olexman'), 'Walmart');
  assert.ok(titleOverlap('Pastel Balloon Garland Arch Kit 120 pcs', 'pastel balloon garland arch kit') >= 0.6);
  assert.ok(titleOverlap('Dinosaur napkins 20 pack', 'bunny paper plates') < 0.6);
});

test('licensed pieces come only from big stores; the planner is told to keep the franchise', async () => {
  const { boardCandidate } = require('../server.js')._board;
  const cands = [
    { name: 'Paw Patrol plates', price: 8, retailer: 'Etsy', image: 'e' },
    { name: 'Paw Patrol plates', price: 9, retailer: 'Target', image: 't' },
  ];
  assert.equal(boardCandidate(cands, { licensed: true }).retailer, 'Target');
  assert.equal(boardCandidate(cands, { licensed: false }).retailer, 'Etsy');
  assert.equal(boardCandidate([cands[0]], { licensed: true }), null);
  const { BOARD_PLANNER_SYSTEM } = require('../server.js')._board;
  assert.match(BOARD_PLANNER_SYSTEM, /OFFICIAL licensed party supplies/);
  assert.doesNotMatch(BOARD_PLANNER_SYSTEM, /Never include licensed characters/);
});

test('one listing never fills two tiles', () => {
  const { boardCandidate } = require('../server.js')._board;
  const kit = { name: 'Dinosaur Balloon Garland Arch Kit', price: 52.99, retailer: 'Etsy', image: 'k', url: 'https://etsy.com/l/1?ref=a' };
  const other = { name: 'Green dinosaur backdrop', price: 20, retailer: 'Target', image: 'b', url: 'https://target.com/b' };
  const used = new Set();
  assert.equal(boardCandidate([kit, other], {}, used), kit);
  assert.equal(boardCandidate([{ ...kit, url: 'https://etsy.com/l/1?ref=b' }, other], {}, used), other, 'same listing, different tracking link');
  assert.equal(boardCandidate([kit], {}, used), null);
});

test('planner failure is a plain JSON error', async () => {
  const before = global.fetch;
  global.fetch = async (url, init) => (String(url).startsWith('https://api.anthropic.com') ? new Response('{"error":{"message":"overloaded"}}', { status: 529 }) : before(url, init));
  const r = await realFetch(`${base}/api/moodboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  global.fetch = before;
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'Mood board failed');
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
