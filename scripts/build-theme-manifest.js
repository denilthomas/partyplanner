#!/usr/bin/env node
/**
 * build-theme-manifest.js — Offline pre-extraction for the curated theme library.
 *
 * Reads scripts/themes.source.json, and for every image:
 *   1. Fetches the image (ImageKit URL) as bytes
 *   2. Reads pixel dimensions from the file header (no dependencies)
 *   3. Runs Gemini extractItems() ONCE to detect buyable items + bounding boxes
 *   4. Converts each normalized bbox [ymin,xmin,ymax,xmax] (0-1000) into a
 *      pixel crop { x, y, w, h } for ImageKit ?tr= cropping at runtime
 * Writes the assembled result to public/themes/manifest.json.
 *
 * Run: GEMINI_API_KEY=... node scripts/build-theme-manifest.js
 * Re-run whenever you add or change theme images.
 */

const fs = require('fs');
const path = require('path');
const { extractItems } = require('../mcp-servers/gemini-vision');

const SOURCE = path.join(__dirname, 'themes.source.json');
const OUTPUT = path.join(__dirname, '..', 'public', 'themes', 'manifest.json');

// ── Dependency-free image dimension reader (JPEG / PNG / WebP) ──
function readImageSize(buf) {
  // PNG: 8-byte signature, then IHDR with width/height at bytes 16-24
  if (buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP (VP8/VP8L/VP8X)
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fmt === 'VP8L') {
      const b = buf.slice(21, 25);
      const w = 1 + (((b[1] & 0x3f) << 8) | b[0]);
      const h = 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
      return { width: w, height: h };
    }
    if (fmt === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
  }
  // JPEG: scan for SOF marker
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15 (except DHT=C4, JPG=C8, DAC=CC) carry dimensions
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
  }
  return null;
}

function mimeFromUrl(url) {
  const u = url.toLowerCase();
  if (u.includes('.png')) return 'image/png';
  if (u.includes('.webp')) return 'image/webp';
  if (u.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// bbox [ymin, xmin, ymax, xmax] normalized 0-1000 → pixel crop { x, y, w, h }
function bboxToCrop(bbox, width, height) {
  if (!bbox || bbox.length < 4) return null;
  const [ymin, xmin, ymax, xmax] = bbox;
  const x = Math.max(0, Math.round((xmin / 1000) * width));
  const y = Math.max(0, Math.round((ymin / 1000) * height));
  const w = Math.max(1, Math.round(((xmax - xmin) / 1000) * width));
  const h = Math.max(1, Math.round(((ymax - ymin) / 1000) * height));
  return { x, y, w, h };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY is not set. Run: GEMINI_API_KEY=... node scripts/build-theme-manifest.js');
    process.exit(1);
  }

  const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const outThemes = [];

  for (const theme of (source.themes || [])) {
    console.log(`\n[theme] ${theme.id} — ${theme.name}`);
    const outImages = [];

    for (const image of (theme.images || [])) {
      process.stdout.write(`  ${image.url} ... `);
      try {
        const resp = await fetch(image.url);
        if (!resp.ok) { console.log(`SKIP (HTTP ${resp.status})`); continue; }
        const buf = Buffer.from(await resp.arrayBuffer());

        const dims = readImageSize(buf);
        if (!dims) { console.log('SKIP (could not read dimensions)'); continue; }

        const base64 = buf.toString('base64');
        const mediaType = mimeFromUrl(image.url);
        const rawItems = await extractItems([{ base64, mediaType }], []);

        const items = (rawItems || []).map((it) => ({
          item_name: it.item_name,
          bucket: it.bucket,
          search_query: it.search_query,
          estimated_price: it.estimated_price,
          crop: bboxToCrop(it.bbox, dims.width, dims.height),
        })).filter((it) => it.crop);

        outImages.push({
          url: image.url,
          width: dims.width,
          height: dims.height,
          credit: image.credit || '',
          license: image.license || '',
          source: image.source || '',
          items,
        });
        console.log(`OK (${dims.width}x${dims.height}, ${items.length} items)`);
      } catch (err) {
        console.log(`ERROR (${err.message})`);
      }
    }

    outThemes.push({
      id: theme.id,
      name: theme.name,
      eventTypes: theme.eventTypes || [],
      featured: !!theme.featured,
      tags: theme.tags || [],
      palette: theme.palette || [],
      images: outImages,
    });
  }

  const manifest = {
    _comment: 'GENERATED FILE — do not edit by hand. Produced by scripts/build-theme-manifest.js.',
    themes: outThemes,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${OUTPUT} (${outThemes.length} themes)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
