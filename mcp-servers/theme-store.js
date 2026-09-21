const fs = require("fs");
const path = require("path");

// File-backed, image-centric library of AI-generated themes. Lets generated
// content accrete so repeat/similar requests are served from cache (no
// generation, no extraction). Single-instance / no-DB footprint on purpose —
// swap for object storage + a DB when multi-instance.

const THEMES_DIR = path.join(__dirname, "..", "public", "themes");
const GENERATED_DIR = path.join(THEMES_DIR, "generated");
const STORE_FILE = path.join(THEMES_DIR, "generated.json");

const MAX_VARIATIONS_PER_FACET = 6; // cap accretion so it can't grow unbounded

// ── key + slug helpers ──
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ");
}

function keyFor(eventType, themePreference) {
  return `${normalize(eventType)}::${normalize(themePreference)}`;
}

function slugFor(key) {
  return key.replace(/::/g, "-").replace(/[^\w-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "theme";
}

// ── store IO ──
function readStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.themes)) parsed.themes = [];
    return parsed;
  } catch {
    return { _comment: "GENERATED — accreted AI theme library. Do not edit by hand.", themes: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(THEMES_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function extForMime(mime) {
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  return "jpg";
}

// Write a data URL to disk under generated/<themeId>/, return the public URL.
function writeImageFile(themeId, facet, index, dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  const mime = m[1];
  const buf = Buffer.from(m[2], "base64");
  const dir = path.join(GENERATED_DIR, themeId);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${facet}-${index}.${extForMime(mime)}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `/themes/generated/${themeId}/${file}`;
}

// ── public API ──

/**
 * Look up a cached generated theme by event type + theme preference.
 * @returns theme record (with per-facet image options) or null.
 */
function findCachedTheme(eventType, themePreference) {
  const key = keyFor(eventType, themePreference);
  const store = readStore();
  return store.themes.find((t) => t.key === key) || null;
}

/**
 * Upsert a generated theme + its images. Accretes images per facet (capped).
 * @param {{ key, theme, images }} arg
 *   images: Array<{ facet, dataUrl }>
 * @returns {{ id, images: Array<{id, facet, url}> }}
 */
function saveGeneratedTheme({ key, theme, images }) {
  const store = readStore();
  const id = slugFor(key);
  let record = store.themes.find((t) => t.key === key);
  if (!record) {
    record = {
      id,
      key,
      name: theme.name || key,
      description: theme.description || "",
      palette: theme.palette || [],
      style_anchor: theme.style_anchor || "",
      eventTypes: theme.eventTypes || [],
      tags: theme.tags || [],
      facets: { backdrop: [], table: [], accent: [] },
      images: {},
    };
    store.themes.push(record);
  }

  const saved = [];
  // group incoming images by facet to number them per facet
  const perFacetCount = { backdrop: 0, table: 0, accent: 0 };
  for (const img of images || []) {
    const facet = img.facet;
    if (!record.facets[facet]) record.facets[facet] = [];
    const idx = (record.facets[facet].length || 0) + perFacetCount[facet];
    perFacetCount[facet] = (perFacetCount[facet] || 0) + 1;
    const url = writeImageFile(id, facet, idx, img.dataUrl);
    if (!url) continue;
    const imgId = `${facet}-${idx}`;
    record.images[imgId] = { id: imgId, facet, url, items: null };
    record.facets[facet].push(imgId);
    saved.push({ id: imgId, facet, url });
  }

  // trim to the cap, keeping the most recent variations
  for (const facet of Object.keys(record.facets)) {
    const list = record.facets[facet];
    while (list.length > MAX_VARIATIONS_PER_FACET) {
      const dropped = list.shift();
      delete record.images[dropped];
    }
  }

  writeStore(store);
  return { id, images: saved };
}

/**
 * Attach extracted items to specific image ids (lazy per-image extraction cache).
 * @param {string} key
 * @param {Object<string, Array>} itemsByImageId
 */
function attachItems(key, itemsByImageId) {
  const store = readStore();
  const record = store.themes.find((t) => t.key === key);
  if (!record) return false;
  for (const [imgId, items] of Object.entries(itemsByImageId || {})) {
    if (record.images[imgId]) record.images[imgId].items = items;
  }
  writeStore(store);
  return true;
}

module.exports = { keyFor, findCachedTheme, saveGeneratedTheme, attachItems, readStore };
