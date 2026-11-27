const express = require('express');
const path = require('path');
const { analyzeSpace, extractItems } = require('./mcp-servers/gemini-vision');
const { generateImages } = require('./mcp-servers/gemini-image');
const themeStore = require('./mcp-servers/theme-store');
const { searchProducts, searchKits, findFullImage } = require('./mcp-servers/serper-search');
const { buildCheckoutPlan, createUCPCheckout, completeUCPCheckout } = require('./mcp-servers/ucp-checkout');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health: which upstreams are configured (no secrets returned) ──
// Lets a developer — or an agent driving the app — see why a stage would fail.
// Claude model for the chat assistant and the theme/shopper agents.
// Server-owned: the browser can't pick a (pricier) model or a bigger budget.
// claude-sonnet-4-6 retires no sooner than 2027-02-17; override on Render
// with ANTHROPIC_MODEL when it's time to move.
const AGENT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const CHAT_MAX_TOKENS = 2048;
const { modelsFor: geminiModelsFor } = require('./mcp-servers/gemini-client');

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    services: {
      anthropic: !!ANTHROPIC_KEY,          // chat, theme + shopper agents
      gemini: !!process.env.GEMINI_API_KEY, // image generation + extraction
      serper: !!process.env.SERPER_API_KEY, // product search
    },
    // Which models will be tried, in order (no secrets).
    models: {
      claude: AGENT_MODEL,
      geminiVision: geminiModelsFor('vision'),
      geminiImage: geminiModelsFor('image'),
    },
  });
});

// ── Claude API proxy ──
app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      // Only forward what the planner needs; model and budget are server-owned.
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: Math.min(Number(req.body?.max_tokens) || CHAT_MAX_TOKENS, CHAT_MAX_TOKENS),
        system: req.body?.system,
        tools: req.body?.tools,
        messages: req.body?.messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(500).json({ error: 'Failed to reach Anthropic API' });
  }
});

// ── Gemini: Analyze space photo for anchor points ──
app.post('/api/analyze-space', async (req, res) => {
  const { image_base64, media_type = 'image/jpeg' } = req.body || {};
  if (!image_base64) {
    return res.status(400).json({ error: 'image_base64 required' });
  }

  try {
    const anchors = await analyzeSpace(image_base64, media_type);
    res.json({ anchors });
  } catch (err) {
    console.error('[analyze-space] failed:', err.message);
    res.status(500).json({ error: 'Space analysis failed', detail: err.message, anchors: [] });
  }
});

// ── Gemini: Extract items from inspiration images ──
app.post('/api/extract-items', async (req, res) => {
  const { images, space_anchors = [] } = req.body || {};
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images array required' });
  }

  try {
    const items = await extractItems(images, space_anchors);
    res.json({ items });
  } catch (err) {
    console.error('[extract-items] failed:', err.message);
    res.status(500).json({ error: 'Item extraction failed', detail: err.message, items: [] });
  }
});

// ── Serper: Search products ──
app.post('/api/search-products', async (req, res) => {
  const { query, max_results = 5 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const products = await searchProducts(query, max_results);
    res.json({ query, products });
  } catch (err) {
    console.error('[products] search failed:', err.message);
    res.status(500).json({ error: 'Product search failed', detail: err.message, products: [] });
  }
});

// ── Serper: Search kits/bundles ──
app.post('/api/search-kits', async (req, res) => {
  const { query, max_results = 3 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const kits = await searchKits(query, max_results);
    res.json({ query, kits });
  } catch (err) {
    console.error('[kits] search failed:', err.message);
    res.status(500).json({ error: 'Kit search failed', detail: err.message, kits: [] });
  }
});

// ── UCP Checkout: Build checkout plan ──
app.post('/api/checkout/plan', (req, res) => {
  const { items } = req.body || {};
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items array required' });
  }
  const plan = buildCheckoutPlan(items);
  res.json(plan);
});

// ── UCP Checkout: Create session ──
app.post('/api/checkout/create', async (req, res) => {
  const { retailerKey, items, buyerInfo } = req.body || {};
  if (!retailerKey || !items) {
    return res.status(400).json({ error: 'retailerKey and items required' });
  }
  const result = await createUCPCheckout(retailerKey, items, buyerInfo);
  res.json(result);
});

// ── UCP Checkout: Complete session ──
app.post('/api/checkout/complete', async (req, res) => {
  const { retailerKey, sessionId, paymentToken } = req.body || {};
  if (!retailerKey || !sessionId || !paymentToken) {
    return res.status(400).json({ error: 'retailerKey, sessionId, and paymentToken required' });
  }
  const result = await completeUCPCheckout(retailerKey, sessionId, paymentToken);
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════
//  Generative theme + shopper agents
// ═══════════════════════════════════════════════════════════════════

const FACETS = ['backdrop', 'table', 'accent'];

// Call Anthropic Messages API with a forced single-tool call; return the tool input object.
async function callAgentTool({ system, tool, messages, max_tokens = 2048 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Anthropic error ${response.status}`);
  }
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('No tool_use in agent response');
  return block.input;
}

const THEME_AGENT_SYSTEM = [
  'You are an expert party theme designer. Given a party plan and the chosen theme, define ONE cohesive theme.',
  'Return: name, description (1-2 sentences), palette (3-5 hex colors), and a style_anchor — one paragraph fixing the shared palette, motifs, materials, lighting and mood that ALL images must obey (this keeps the three facets looking like one theme).',
  'Then write ONE image prompt per facet — backdrop (wall/entrance), table (table setting), accent (props/vignettes/favors) — 3 prompts total. Each prompt is the style_anchor applied to that facet.',
  'Each prompt MUST be composed so a shopper could recreate the look:',
  '- Feature 3-5 clear, distinct HERO pieces (statement decor: balloon garland, backdrop banner, centerpiece, themed tableware, cake stand). Name them so the image is built around them.',
  '- Photorealistic, bright, evenly lit, clean/uncluttered composition; hero pieces fully visible and separated (not overlapping or cropped).',
  '- AVOID: busy collages, extreme macro/close-ups with ambiguous scale, abstract art, heavy occlusion, dark/low-contrast scenes, text/logos/watermarks, and people.',
  'Also return hero_items (names) per facet as a hint. Do NOT price or finalize products — items are detected from the generated images later.',
].join('\n');

const THEME_TOOL = {
  name: 'propose_theme',
  description: 'Return one cohesive party theme with a shared style anchor and one image prompt per facet.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      palette: { type: 'array', items: { type: 'string' }, description: '3-5 hex colors' },
      style_anchor: { type: 'string', description: 'Shared palette/motifs/materials/lighting/mood paragraph all images obey' },
      facets: {
        type: 'array',
        description: 'Exactly 3 facets: backdrop, table, accent',
        items: {
          type: 'object',
          properties: {
            facet: { type: 'string', enum: FACETS },
            prompt: { type: 'string', description: 'Image prompt for this facet (style_anchor applied)' },
            hero_items: { type: 'array', items: { type: 'string' }, description: '3-5 hero piece names' },
          },
          required: ['facet', 'prompt'],
        },
      },
    },
    required: ['name', 'palette', 'style_anchor', 'facets'],
  },
};

function themePreferenceOf(plan, theme_preference) {
  if (theme_preference) return theme_preference;
  if (plan && plan.themePreference) return plan.themePreference;
  const t = plan && plan.theme;
  if (!t) return '';
  return typeof t === 'string' ? t : (t.name || '');
}

// ── Theme Creation Agent (cache-first) ──
app.post('/api/create-theme', async (req, res) => {
  // fresh: true → skip the library (used by "Try a different look", which
  // would otherwise get the identical cached theme back).
  const { plan = {}, theme_preference, fresh = false } = req.body || {};
  const eventType = plan.eventType || '';
  const pref = themePreferenceOf(plan, theme_preference);
  const key = themeStore.keyFor(eventType, pref);

  try {
    // Cache lookup first
    const cached = fresh ? null : themeStore.findCachedTheme(eventType, pref);
    if (cached) {
      const facets = FACETS.map((facet) => ({
        facet,
        options: (cached.facets[facet] || []).map((id) => ({
          id,
          url: cached.images[id] && cached.images[id].url,
          hasItems: !!(cached.images[id] && cached.images[id].items),
        })).filter((o) => o.url),
      }));
      return res.json({
        cached: true,
        key,
        theme: { name: cached.name, description: cached.description, palette: cached.palette, style_anchor: cached.style_anchor },
        facets,
      });
    }

    // Miss → generate via the Theme Creation Agent
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const userMsg = `Party plan:\n${JSON.stringify({ eventType, budget: plan.budget, guestCount: plan.guestCount, setting: plan.setting }, null, 2)}\nChosen theme / vibe: ${pref || '(none given — choose a fitting one)'}`;
    const theme = await callAgentTool({
      system: THEME_AGENT_SYSTEM,
      tool: THEME_TOOL,
      messages: [{ role: 'user', content: userMsg }],
    });
    res.json({ cached: false, key, theme, facets: theme.facets });
  } catch (err) {
    console.error('[create-theme] failed:', err.message);
    res.status(500).json({ error: 'Theme creation failed', detail: err.message });
  }
});

// ── Image generation proxy (key stays server-side) ──
app.post('/api/generate-image', async (req, res) => {
  const { prompt, count = 1 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const images = await generateImages(prompt, count);
    res.json({ images });
  } catch (err) {
    console.error('[generate-image] failed:', err.message);
    res.status(500).json({ error: 'Image generation failed', detail: err.message, images: [] });
  }
});

// ── Save / accrete a generated theme into the library ──
app.post('/api/save-theme', async (req, res) => {
  const { key, theme = {}, images, itemsByImageId } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    let result = { id: null, images: [] };
    if (Array.isArray(images) && images.length > 0) {
      result = themeStore.saveGeneratedTheme({ key, theme, images });
    }
    if (itemsByImageId && Object.keys(itemsByImageId).length > 0) {
      themeStore.attachItems(key, itemsByImageId);
    }
    res.json(result);
  } catch (err) {
    console.error('[save-theme] failed:', err.message);
    res.status(500).json({ error: 'Save theme failed', detail: err.message });
  }
});

const SHOPPER_SYSTEM = [
  'You are a personal party shopper. For each requested item you get candidate product listings (indexed) and the party plan (guest count, setting, and a budget FOR REFERENCE ONLY).',
  'For each item, choose the single best candidate by index — balance relevance, price, and rating; prefer all-in-one kits/sets.',
  'Compute a starting quantity from the guest count and the pack size implied by the product (e.g. a plate pack serving 16 with 40 guests → quantity 3; favors × guests; garland kits by span). If unsure, quantity 1.',
  'Do NOT restrict choices to fit the budget — always pick the genuinely best item even if the total runs over; the app shows a budget tracker and the user adjusts quantities themselves.',
  'Give each pick a one-line reason. If an item has no good candidate, set candidate_index to -1 and explain in reason.',
  'Also return a neutral budget_note describing how the subtotal compares to the budget (over/under and by how much).',
].join('\n');

const CART_TOOL = {
  name: 'build_cart',
  description: 'Choose the best candidate product per item and a starting quantity.',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_name: { type: 'string' },
            candidate_index: { type: 'integer', description: 'Index into that item\'s candidates; -1 if none suitable' },
            quantity: { type: 'integer' },
            pack_size: { type: ['integer', 'null'], description: 'How many the product serves/contains, if known' },
            reason: { type: 'string' },
          },
          required: ['item_name', 'candidate_index', 'quantity', 'reason'],
        },
      },
      budget_note: { type: 'string' },
    },
    required: ['picks'],
  },
};

// ── Shopper Agent: Serper candidates + one batched curation call ──
// Used by /api/shop (pieces spotted in AI images).
async function shopItems(items, plan = {}) {
  // 1) gather candidates per item (parallel)
  const withCandidates = await Promise.all(items.map(async (item) => {
    const q = item.search_query || item.item_name;
    let candidates = await searchProducts(q, 5);
    if (candidates.length === 0) candidates = await searchKits(q, 3);
    return { item, candidates: candidates.slice(0, 5) };
  }));

  // 2) batched curation
  const payload = withCandidates.map(({ item, candidates }, i) => ({
    index: i,
    item_name: item.item_name,
    bucket: item.bucket,
    candidates: candidates.map((c, ci) => ({
      candidate_index: ci,
      title: c.name, price: c.price, retailer: c.retailer, rating: c.rating, has_image: !!c.image,
    })),
  }));
  const userMsg = `Party plan: ${JSON.stringify({ budget: plan.budget, guestCount: plan.guestCount, setting: plan.setting })}\n\nItems and their candidate products:\n${JSON.stringify(payload, null, 2)}`;
  const result = await callAgentTool({
    system: SHOPPER_SYSTEM,
    tool: CART_TOOL,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 3072,
  });

  // 3) resolve picks back to real candidate products
  const picks = [];
  let subtotal = 0;
  for (const pick of (result.picks || [])) {
    const entry = withCandidates.find((w) => w.item.item_name === pick.item_name)
      || withCandidates[picks.length];
    if (!entry) continue;
    const ci = pick.candidate_index;
    const cand = (ci != null && ci >= 0) ? entry.candidates[ci] : null;
    const quantity = Math.max(1, pick.quantity || 1);
    const price = cand ? cand.price : (entry.item.estimated_price || 0);
    const line_total = +(price * quantity).toFixed(2);
    if (cand) subtotal += line_total;
    picks.push({
      item_name: entry.item.item_name,
      bucket: entry.item.bucket,
      product: cand ? { title: cand.name, retailer: cand.retailer, link: cand.url, price: cand.price, thumbnail: cand.image } : null,
      pack_size: pick.pack_size || null,
      quantity,
      line_total,
      reason: pick.reason || '',
    });
  }
  return { picks, subtotal: +subtotal.toFixed(2), budget_note: result.budget_note || '' };
}

app.post('/api/shop', async (req, res) => {
  const { items = [], plan = {} } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const { picks, subtotal, budget_note } = await shopItems(items, plan);
    res.json({ picks, subtotal, budget: plan.budget || null, budget_note });
  } catch (err) {
    console.error('[shop] failed:', err.message);
    res.status(500).json({ error: 'Shopping failed', detail: err.message, picks: [] });
  }
});

// ── Mood Board: plan pieces → real products (no AI images) ──
// The board is made of real retailer listings, so every picture is buyable
// and shows its store and price. Claude curates for cohesion; it never
// invents a product.
const BOARD_PLANNER_SYSTEM = [
  'You are the creative director for Utsav, an app that helps families throw beautiful parties at home with store-bought supplies.',
  'Plan ONE cohesive, shoppable mood board for the party below. It will be built only from real product listings found by search, so you choose WHAT to look for, not what it looks like.',
  '',
  'RETURN',
  '- name: a short, warm theme name (2-5 words). description: 1-2 sentences.',
  '- palette: 3-5 hex colors, 1-2 main colors plus neutrals; no neon.',
  '- signature_motif: one motif (e.g. "cherries", "bunnies", "daisies") or "none".',
  '- pieces: 8-10 things to buy.',
  '',
  'PIECES',
  '- 2-3 pieces with shot "setup": products sellers photograph as a styled party scene, such as a balloon garland arch kit, a backdrop banner or backdrop with stand, or a table decoration set. These are the big inspiration shots.',
  '- 5-7 pieces with shot "detail": close-up items such as paper plates, napkins, cups, cake topper, centerpiece or bud vases, favor bags, straws or a small sign.',
  '- Cover the wall or entrance, the table and the small accents; do not repeat the same kind of item.',
  '- search_query: plain shopping words a Target/Walmart/Amazon search would match, always including the color words from the palette (e.g. "sage green and cream balloon garland arch kit", "pink gingham paper napkins").',
  '- The motif appears on at most 3 pieces; the rest are solid or simple patterns in the palette, so the board feels styled, not themed-to-death.',
  '- Never include licensed characters, brand names, food, or custom/personalized items, and never put words like "custom" or "personalized" in a search_query.',
  '- Scale to the plan: under $150 budget = 8 simple pieces; larger budgets can include richer setup pieces.',
  '- quantity: packs to buy for the guest count, assuming typical pack sizes (plates/cups/napkins come in 16-24; favor bags in 12-24). Kits, backdrops, toppers and signs: 1. If unsure, 1.',
  '- bucket: one of tabletop, wall_backdrop, accent_decor, activity_favors.',
].join('\n');

const BOARD_TOOL = {
  name: 'plan_board',
  description: 'Plan a cohesive shoppable mood board: theme, palette and 8-10 pieces to search for.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      palette: { type: 'array', items: { type: 'string' } },
      signature_motif: { type: 'string' },
      pieces: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_name: { type: 'string', description: 'Plain name, e.g. "balloon garland arch kit"' },
            bucket: { type: 'string', enum: ['tabletop', 'wall_backdrop', 'accent_decor', 'activity_favors'] },
            shot: { type: 'string', enum: ['setup', 'detail'] },
            search_query: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
          },
          required: ['item_name', 'bucket', 'shot', 'search_query'],
        },
      },
    },
    required: ['name', 'palette', 'pieces'],
  },
};


// The top search result that has a photo — a tile without an image can't
// be on the board. Search order is already relevance order.
// Personalized listings ("Happy Birthday Sheppard") can't be bought as shown.
const CUSTOM_ITEM = /\b(custom(i[sz]ed|izable)?|personali[sz]ed|personali[sz]able|your (name|text|photo)|any (name|age)|monogram(med)?|name banner|made to order)\b/i;

function boardCandidate(candidates) {
  return candidates.find((c) => c.image && c.price > 0 && !CUSTOM_ITEM.test(c.name)) || null;
}

async function findBoardProduct(piece) {
  const q = piece.search_query || piece.item_name;
  let c = boardCandidate(await searchProducts(q, 5));
  if (!c) c = boardCandidate(await searchKits(q, 3));
  return c;
}

// Streams newline-delimited JSON so the phone can paint as results land:
//   {type:'theme', theme, pieces}  → after the planner (~a few seconds)
//   {type:'pick', index, pick}     → one per piece, as each search returns
//   {type:'image', index, url}     → full-size listing photo, when one is found
//   {type:'done', subtotal, budget, timings}
// Errors before the first line are a normal JSON error response.
app.post('/api/moodboard', async (req, res) => {
  const { plan = {}, theme_preference } = req.body || {};
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const pref = themePreferenceOf(plan, theme_preference);
  const t0 = Date.now();
  let board;
  try {
    const userMsg = `Party plan:\n- Occasion: ${plan.eventType || '(not set)'}\n- Guests: ${plan.guestCount || '(not set)'}\n- Budget: ${plan.budget ? '$' + plan.budget : '(not set)'}\n- Setting: ${plan.setting || '(not set)'}\nTheme / vibe: ${pref || '(none given — choose a fitting one)'}`;
    board = await callAgentTool({
      system: BOARD_PLANNER_SYSTEM,
      tool: BOARD_TOOL,
      messages: [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    console.error('[moodboard] planner failed:', err.message);
    return res.status(500).json({ error: 'Mood board failed', detail: err.message, picks: [] });
  }
  const pieces = (board.pieces || []).slice(0, 10);
  if (!pieces.length) return res.status(502).json({ error: 'The planner returned no pieces' });
  const tPlan = Date.now() - t0;

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  send({
    type: 'theme',
    theme: { name: board.name, description: board.description || '', palette: board.palette || [], signature_motif: board.signature_motif || '' },
    pieces: pieces.map((p, index) => ({ index, item_name: p.item_name, bucket: p.bucket, shot: p.shot || 'detail' })),
  });

  let subtotal = 0;
  let tFirst = null;
  await Promise.all(pieces.map(async (piece, index) => {
    let c = null;
    try { c = await findBoardProduct(piece); } catch (err) { console.error('[moodboard] search failed:', err.message); }
    const quantity = Math.max(1, Math.min(20, parseInt(piece.quantity, 10) || 1));
    const line_total = c ? +(c.price * quantity).toFixed(2) : 0;
    subtotal += line_total;
    if (c && tFirst == null) tFirst = Date.now() - t0;
    send({
      type: 'pick',
      index,
      pick: {
        item_name: piece.item_name,
        bucket: piece.bucket,
        shot: piece.shot || 'detail',
        product: c ? { title: c.name, retailer: c.retailer, link: c.url, price: c.price, thumbnail: c.image } : null,
        quantity,
        line_total,
        reason: '',
      },
    });
    if (c) {
      try {
        const url = await findFullImage(c.name, c.retailer);
        if (url && url !== c.image) send({ type: 'image', index, url });
      } catch (err) { console.error('[moodboard] full image failed:', err.message); }
    }
  }));
  const timings = { plan_ms: tPlan, first_product_ms: tFirst, total_ms: Date.now() - t0 };
  console.log('[moodboard] timings', JSON.stringify(timings));
  send({ type: 'done', subtotal: +subtotal.toFixed(2), budget: plan.budget || null, timings });
  res.end();
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Utsav running at http://localhost:${PORT}`);
  });
}

module.exports = app;
