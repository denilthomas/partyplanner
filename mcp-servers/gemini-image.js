const { generateContent, imageOf, modelsFor } = require("./gemini-client");

// Image model selection (with env override + fallback) lives in gemini-client.js.

/**
 * Generate ONE image from a text prompt using Gemini's image model.
 * The key stays server-side — this is only ever called from server.js.
 * @param {string} prompt
 * @returns {Promise<string|null>} a `data:<mime>;base64,<data>` URL, or null on failure.
 */
async function generateImage(prompt) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };
  const { data, error } = await generateContent("image", body, "gemini-image");
  if (error) return null;
  const url = imageOf(data);
  if (!url) console.error("[gemini-image] no image in response");
  return url;
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

module.exports = { generateImage, generateImages, imageModels: () => modelsFor("image") };
