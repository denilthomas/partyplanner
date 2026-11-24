// Shared Gemini REST client (generateContent).
//
// Why this exists: model IDs get retired (gemini-2.0-flash shut down
// 2026-06-01 and broke item extraction). Every Gemini call now goes through
// here so that:
//   - model IDs live in one place, with env overrides (no code change needed
//     to swap a model on Render: set GEMINI_VISION_MODEL / GEMINI_IMAGE_MODEL),
//   - a retired/unknown model (404 or "not found/supported") falls through to
//     the next model in the list instead of failing the whole feature,
//   - the API key is sent as a header, never in the URL (keeps it out of logs).

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Defaults checked against Google's deprecation page (Nov 2026).
const DEFAULT_MODELS = {
  // Image understanding + JSON output (item extraction, space analysis)
  vision: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  // Image generation (theme facet images). 2.5-flash-image is legacy
  // (earliest shutdown 2027-03-15) and kept only as a last resort.
  image: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'],
};

const ENV_OVERRIDE = { vision: 'GEMINI_VISION_MODEL', image: 'GEMINI_IMAGE_MODEL' };

// Remember the first model that worked per kind, so a retired default only
// costs one extra request per server start, not one per call.
const preferred = {};

function modelsFor(kind) {
  const override = (process.env[ENV_OVERRIDE[kind]] || '').trim();
  const list = override
    ? [override, ...DEFAULT_MODELS[kind].filter((m) => m !== override)]
    : [...DEFAULT_MODELS[kind]];
  if (preferred[kind] && list.includes(preferred[kind])) {
    return [preferred[kind], ...list.filter((m) => m !== preferred[kind])];
  }
  return list;
}

function isModelUnavailable(status, text) {
  if (status === 404) return true;
  return status === 400 && /not found|not supported|unknown model|invalid model|is not available/i.test(text);
}

/**
 * POST a generateContent request, falling back across models of `kind`.
 * @param {'vision'|'image'} kind
 * @param {object} body generateContent request body
 * @param {string} tag log prefix
 * @returns {Promise<{data?: object, model?: string, error?: string}>}
 */
async function generateContent(kind, body, tag = 'gemini') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: 'GEMINI_API_KEY not set' };

  let lastError = 'no models configured';
  for (const model of modelsFor(kind)) {
    let response;
    try {
      response = await fetch(`${BASE_URL}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { error: `network: ${err.message}` };
    }
    if (response.ok) {
      preferred[kind] = model;
      return { data: await response.json(), model };
    }
    const text = await response.text();
    lastError = `${model} → ${response.status}: ${text.slice(0, 300)}`;
    if (isModelUnavailable(response.status, text)) {
      console.warn(`[${tag}] model ${model} unavailable (${response.status}); trying next`);
      continue;
    }
    // Auth, quota, billing, bad request: switching models won't help.
    break;
  }
  console.error(`[${tag}] ${lastError}`);
  return { error: lastError };
}

// Concatenate the answer's text parts (skipping any thought summaries).
function textOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}

// First inline image part as a data: URL, or null.
function imageOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!img) return null;
  return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
}

function _resetPreferred() { for (const k of Object.keys(preferred)) delete preferred[k]; }

module.exports = { generateContent, textOf, imageOf, modelsFor, DEFAULT_MODELS, _resetPreferred };
