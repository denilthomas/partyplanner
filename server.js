const express = require('express');
const path = require('path');
const { analyzeSpace, extractItems } = require('./mcp-servers/gemini-vision');
const { searchProducts, searchKits } = require('./mcp-servers/serper-search');
const { buildCheckoutPlan, createUCPCheckout, completeUCPCheckout } = require('./mcp-servers/ucp-checkout');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
      body: JSON.stringify(req.body),
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PartyPlanner running at http://localhost:${PORT}`);
});
