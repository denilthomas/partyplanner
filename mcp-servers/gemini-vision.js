const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Analyze a room/venue photo and return anchor points suitable for party decoration.
 * @param {string} imageBase64 - Base64-encoded image of the room/venue.
 * @param {string} mediaType - MIME type of the image (e.g. "image/jpeg").
 * @returns {Promise<Array>} Array of anchor points.
 */
async function analyzeSpace(imageBase64, mediaType) {
  try {
    const prompt = `You are a party-planning spatial analyst. Look at this room photo and identify surfaces, walls, ceiling areas, and focal points that are suitable for party decoration placement.

Consider the room's size and layout carefully. Identify 3 to 8 anchor points where decorations could be placed or hung.

For each anchor point, return:
- "id": a unique string identifier (e.g. "anchor_1", "anchor_2")
- "label": a human-readable description (e.g. "dining table", "focal wall", "ceiling area", "fireplace mantel", "window area")
- "type": one of "surface", "wall", "ceiling", or "focal_point"
- "position": an [x, y] array with values normalized from 0 to 1000 representing the center of that anchor in the image

Return a JSON array of anchor point objects. Return between 3 and 8 anchor points.`;

    const body = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: mediaType,
                data: imageBase64,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[gemini] analyzeSpace API error ${response.status}: ${errText}`);
      return [];
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("[gemini] analyzeSpace: no text in response");
      return [];
    }

    const anchors = JSON.parse(text);
    if (!Array.isArray(anchors)) {
      console.error("[gemini] analyzeSpace: response is not an array");
      return [];
    }

    return anchors;
  } catch (err) {
    console.error("[gemini] analyzeSpace error:", err);
    return [];
  }
}

/**
 * Analyze inspiration images and extract buyable party supply items.
 * @param {Array<{base64: string, mediaType: string}>} inspirationImagesBase64 - Array of inspiration images.
 * @param {Array} spaceAnchors - Anchor points from analyzeSpace.
 * @returns {Promise<Array>} Array of extracted items.
 */
async function extractItems(inspirationImagesBase64, spaceAnchors) {
  try {
    const prompt = `You are an experienced event manager looking at these party mood-board images and deciding what to BUY to recreate the look. You are NOT cataloguing every object — you are curating the statement pieces a shopper actually needs.

Select ONLY the hero pieces: the decor that defines the look. Cap it at 3–5 items per image and about 8–12 items total across all images. Quality over quantity.

For each selected item, return:
- "item_name": descriptive name (e.g. "gold foil number balloons", "boho pampas centerpiece")
- "bucket": one of "tabletop", "wall_backdrop", "accent_decor", "activity_favors", or "food_display"
- "search_query": a recreation-oriented product search a shopper could order. STRONGLY prefer all-in-one kits/sets/units of purchase (e.g. "155pc dinosaur party tableware kit", "boho balloon garland arch kit") rather than individual plates/cups/napkins.
- "estimated_price": estimated price in USD as a number (e.g. 24.99)
- "importance": integer 1–5, where 5 = a must-have hero piece that defines the theme and 1 = minor. Rank so the most impactful pieces lead.
- "bbox": bounding box [ymin, xmin, ymax, xmax] normalized 0–1000, locating the item in its source image
- "image_index": zero-based index of which image this item comes from

RULES:
- Think in KITS and SETS, not individual units. Collapse "plates + cups + napkins of the same theme" into one tableware-kit line.
- DEDUPE across images: if the same item appears more than once, return it ONCE.
- EXCLUDE entirely: walls, floors, ceilings, furniture, permanent fixtures, ambient greenery that isn't a decor prop, the food/drink itself, people, and indistinct background clutter.
- If an item is low-confidence or visually ambiguous, SKIP it rather than guessing — a clean short list beats a noisy long one.
- Bucket guidance: hanging/backdrop pieces → "wall_backdrop"; things on the table → "tabletop"; standalone props/vignettes → "accent_decor"; favors/games → "activity_favors"; cake stands/food-display props (not the food) → "food_display".

Return a JSON array of item objects, ordered by "importance" descending.`;

    const imageParts = inspirationImagesBase64.map((img) => ({
      inlineData: {
        mimeType: img.mediaType,
        data: img.base64,
      },
    }));

    const body = {
      contents: [
        {
          parts: [...imageParts, { text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[gemini] extractItems API error ${response.status}: ${errText}`);
      return [];
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("[gemini] extractItems: no text in response");
      return [];
    }

    const items = JSON.parse(text);
    if (!Array.isArray(items)) {
      console.error("[gemini] extractItems: response is not an array");
      return [];
    }

    // Post-filter: remove items over $100 and furniture/food/fixtures
    const filtered = items.filter((item) => {
      if (item.estimated_price > 100) return false;
      const nameLower = (item.item_name || "").toLowerCase();
      const furnitureKeywords = [
        "table",
        "chair",
        "shelf",
        "shelving",
        "couch",
        "sofa",
        "desk",
        "cabinet",
      ];
      const fixtureKeywords = [
        "light switch",
        "outlet",
        "socket",
        "built-in",
        "window frame",
        "door frame",
      ];
      const foodKeywords = [
        "cake",
        "cupcake",
        "cookie",
        "candy",
        "pizza",
        "sandwich",
        "fruit",
        "juice",
        "soda",
        "water bottle",
      ];
      for (const kw of furnitureKeywords) {
        if (nameLower.includes(kw)) return false;
      }
      for (const kw of fixtureKeywords) {
        if (nameLower.includes(kw)) return false;
      }
      for (const kw of foodKeywords) {
        if (nameLower.includes(kw)) return false;
      }
      return true;
    });

    return filtered;
  } catch (err) {
    console.error("[gemini] extractItems error:", err);
    return [];
  }
}

module.exports = { analyzeSpace, extractItems };
