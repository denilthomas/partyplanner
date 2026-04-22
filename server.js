const express = require('express');
const path = require('path');
const { searchPinterest, closeBrowser: closePinterest } = require('./mcp-servers/pinterest-scraper');
const { searchProducts, closeBrowser: closeProducts } = require('./mcp-servers/product-scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Your Anthropic API key — set via environment variable
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

// ── Product scraper endpoint ──
app.post('/api/search-products', async (req, res) => {
  const { query, retailer = 'amazon', max_results = 5 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const products = await searchProducts(query, retailer, max_results);
    res.json({ query, retailer, products });
  } catch (err) {
    console.error('[products] scrape failed:', err.message);
    res.status(500).json({ error: 'Product scrape failed', detail: err.message, products: [] });
  }
});

// ── Graceful shutdown ──
process.on('SIGTERM', async () => {
  await closePinterest().catch(() => {});
  await closeProducts().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`PartyPlanner running at http://localhost:${PORT}`);
});
