const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Gemini image-generation model. Kept in one place so it can be swapped if the
// key needs a different image model (a 404/permission error means swap this).
const IMAGE_MODEL = "gemini-2.5-flash-image";
const IMAGE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Generate ONE image from a text prompt using Gemini's image model.
 * The key stays server-side — this is only ever called from server.js.
 * @param {string} prompt
 * @returns {Promise<string|null>} a `data:<mime>;base64,<data>` URL, or null on failure.
 */
async function generateImage(prompt) {
  if (!GEMINI_API_KEY) {
    console.error("[gemini-image] GEMINI_API_KEY not set");
    return null;
  }
  try {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    };

    const response = await fetch(IMAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[gemini-image] API error ${response.status}: ${errText}`);
      return null;
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!imgPart) {
      console.error("[gemini-image] no image in response");
      return null;
    }
    const mime = imgPart.inlineData.mimeType || "image/png";
    return `data:${mime};base64,${imgPart.inlineData.data}`;
  } catch (err) {
    console.error("[gemini-image] error:", err.message);
    return null;
  }
}

/**
 * Generate N variations of a prompt in parallel (same prompt, stochastic output).
 * @param {string} prompt
 * @param {number} count
 * @returns {Promise<Array<string>>} data URLs (failed ones dropped).
 */
async function generateImages(prompt, count = 1) {
  const n = Math.max(1, Math.min(6, count | 0 || 1));
  const results = await Promise.all(
    Array.from({ length: n }, () => generateImage(prompt))
  );
  return results.filter(Boolean);
}

module.exports = { generateImage, generateImages, IMAGE_MODEL };
