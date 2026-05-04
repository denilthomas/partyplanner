const express = require('express');
const path = require('path');
const { searchPinterest, closeBrowser: closePinterest } = require('./mcp-servers/pinterest-scraper');
const { searchProducts } = require('./mcp-servers/product-scraper');
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

// ── Pinterest scraper endpoint ──
app.post('/api/search-pinterest', async (req, res) => {
  const { query, max_results = 12 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const pins = await searchPinterest(query, max_results);
    res.json({ query, pins });
  } catch (err) {
    console.error('[pinterest] scrape failed:', err.message);
    res.status(500).json({ error: 'Pinterest scrape failed', detail: err.message, pins: [] });
  }
});

// ── Product search endpoint (SerpApi) ──
app.post('/api/search-products', async (req, res) => {
  const { query, retailer = 'amazon', max_results = 5 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const products = await searchProducts(query, retailer, max_results);
    res.json({ query, retailer, products });
  } catch (err) {
    console.error('[products] search failed:', err.message);
    res.status(500).json({ error: 'Product search failed', detail: err.message, products: [] });
  }
});

// ── UCP Checkout: Build checkout plan (groups items by retailer) ──
app.post('/api/checkout/plan', (req, res) => {
  const { items } = req.body || {};
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items array required' });
  }
  const plan = buildCheckoutPlan(items);
  res.json(plan);
});

// ── UCP Checkout: Create session with a retailer ──
app.post('/api/checkout/create', async (req, res) => {
  const { retailerKey, items, buyerInfo } = req.body || {};
  if (!retailerKey || !items) {
    return res.status(400).json({ error: 'retailerKey and items required' });
  }
  const result = await createUCPCheckout(retailerKey, items, buyerInfo);
  res.json(result);
});

// ── UCP Checkout: Complete session with payment ──
app.post('/api/checkout/complete', async (req, res) => {
  const { retailerKey, sessionId, paymentToken } = req.body || {};
  if (!retailerKey || !sessionId || !paymentToken) {
    return res.status(400).json({ error: 'retailerKey, sessionId, and paymentToken required' });
  }
  const result = await completeUCPCheckout(retailerKey, sessionId, paymentToken);
  res.json(result);
});

// ── Graceful shutdown ──
process.on('SIGTERM', async () => {
  await closePinterest().catch(() => {});
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PartyPlanner running at http://localhost:${PORT}`);
});
