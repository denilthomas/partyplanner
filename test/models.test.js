// Model selection: Gemini fallback/override/key handling, and the server
// owning the Claude model + budget. External APIs are stubbed via fetch.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const gemini = require('../mcp-servers/gemini-client');
const realFetch = global.fetch;
let calls;

function stubFetch(handler) {
  calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const r = await handler(String(url), init);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {}), { status: r.status || 200 });
  };
}

beforeEach(() => {
  gemini._resetPreferred();
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.GEMINI_VISION_MODEL;
  delete process.env.GEMINI_IMAGE_MODEL;
});
afterEach(() => { global.fetch = realFetch; });

const ok = (parts) => ({ body: { candidates: [{ content: { parts } }] } });

test('no retired models in the defaults', () => {
  const all = [...gemini.DEFAULT_MODELS.vision, ...gemini.DEFAULT_MODELS.image];
  assert.ok(!all.includes('gemini-2.0-flash'), 'gemini-2.0-flash was shut down 2026-06-01');
  assert.equal(gemini.modelsFor('vision')[0], 'gemini-3.6-flash');
  assert.equal(gemini.modelsFor('image')[0], 'gemini-3.1-flash-image');
});

test('key goes in a header, never the URL', async () => {
  stubFetch(() => ok([{ text: '[]' }]));
  await gemini.generateContent('vision', { contents: [] });
  assert.ok(!calls[0].url.includes('test-key'));
  assert.ok(!calls[0].url.includes('key='));
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  assert.match(calls[0].url, /\/models\/gemini-3\.6-flash:generateContent$/);
});

test('a retired model (404) falls through to the next, and the winner is remembered', async () => {
  stubFetch((url) => (url.includes('gemini-3.6-flash') ? { status: 404, body: 'models/gemini-3.6-flash is not found' } : ok([{ text: '"hi"' }])));
  const r = await gemini.generateContent('vision', { contents: [] });
  assert.equal(r.model, 'gemini-3.5-flash');
  assert.equal(calls.length, 2);
  await gemini.generateContent('vision', { contents: [] });
  assert.match(calls[2].url, /gemini-3\.5-flash/, 'second call goes straight to the working model');
});

test('"model not supported" 400 also falls through; quota/auth errors do not', async () => {
  stubFetch((url) => (url.includes('gemini-3.1-flash-image:') ? { status: 400, body: 'Model gemini-3.1-flash-image is not supported for generateContent' } : ok([])));
  assert.equal((await gemini.generateContent('image', {})).model, 'gemini-3.1-flash-lite-image');

  gemini._resetPreferred();
  stubFetch(() => ({ status: 429, body: 'RESOURCE_EXHAUSTED quota' }));
  const r = await gemini.generateContent('image', {});
  assert.match(r.error, /429/);
  assert.equal(calls.length, 1, 'no point trying other models on a quota error');
});

test('env override goes first without dropping the fallbacks', () => {
  process.env.GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1';
  assert.deepEqual(gemini.modelsFor('image').slice(0, 2), ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image']);
});

test('missing key returns an error without calling Google', async () => {
  delete process.env.GEMINI_API_KEY;
  stubFetch(() => ok([]));
  assert.match((await gemini.generateContent('vision', {})).error, /GEMINI_API_KEY/);
  assert.equal(calls.length, 0);
});

test('textOf skips thought parts; imageOf builds a data URL', () => {
  const data = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '[1,' }, { text: '2]' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAA' } }] } }] };
  assert.equal(gemini.textOf(data), '[1,2]');
  assert.equal(gemini.imageOf(data), 'data:image/jpeg;base64,AAA');
  assert.equal(gemini.imageOf({}), null);
});

test('extractItems and generateImage work end-to-end through the client', async () => {
  const { extractItems } = require('../mcp-servers/gemini-vision');
  const { generateImage } = require('../mcp-servers/gemini-image');
  stubFetch((url) => (url.includes('image')
    ? ok([{ inlineData: { mimeType: 'image/png', data: 'PNG' } }])
    : ok([{ text: JSON.stringify([{ item_name: 'Balloon garland', bucket: 'wall_backdrop', importance: 5, estimated_price: 30, search_query: 'q', image_index: 0 }]) }])));
  const items = await extractItems([{ base64: 'x', mediaType: 'image/jpeg' }], []);
  assert.equal(items[0].item_name, 'Balloon garland');
  assert.match(calls[0].url, /gemini-3\.6-flash/);
  assert.equal(await generateImage('a boho backdrop'), 'data:image/png;base64,PNG');
  assert.deepEqual(calls[1].body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
});

test('server owns the Claude model and caps the token budget', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
  const app = require('../server.js');
  const server = app.listen(0);
  const port = server.address().port;
  let sent;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.anthropic.com')) {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const r = await realFetch(`http://localhost:${port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 64000, system: 's', messages: [{ role: 'user', content: 'x' }], extra: 'dropped' }),
    });
    assert.equal(r.status, 200);
    assert.equal(sent.model, 'claude-sonnet-4-6', 'client cannot choose the model');
    assert.equal(sent.max_tokens, 2048, 'client cannot raise the budget');
    assert.equal(sent.extra, undefined);
    const health = await (await realFetch(`http://localhost:${port}/api/health`)).json();
    assert.equal(health.models.claude, 'claude-sonnet-4-6');
    assert.equal(health.models.geminiVision[0], 'gemini-3.6-flash');
  } finally {
    server.close();
  }
});
