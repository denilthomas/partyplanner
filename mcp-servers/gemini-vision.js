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
    const anchorDescriptions = spaceAnchors
      .map((a) => `  - id: "${a.id}", label: "${a.label}", type: "${a.type}"`)
      .join("\n");

    const prompt = `You are a party-planning supply analyst. Analyze the provided inspiration images and extract every buyable party supply or decoration item you can see.

For each item, return:
- "item_name": descriptive name of the item (e.g. "gold foil number balloons", "red honeycomb fans")
- "bucket": one of "tabletop", "wall_backdrop", "accent_decor", "activity_favors", or "food_display"
- "search_query": a product search query to find this item online. Prioritize "All-in-One Kits" when possible (e.g. "155pc firetruck party pack" instead of individual plates, cups, napkins). Group similar items together into kit searches.
- "estimated_price": estimated price in USD as a number (e.g. 12.99)
- "bbox": bounding box [ymin, xmin, ymax, xmax] with values normalized from 0 to 1000 indicating where this item appears in its source inspiration image
- "image_index": zero-based index indicating which inspiration image this item comes from
- "anchor_id": which room anchor this item should map to (or null if no clear match)

GRAVITY LOGIC for bucket assignment:
- If an item's vertical center (average of ymin and ymax) is < 300 and the item is round or pleated (e.g. paper fans, honeycomb balls, hanging decorations), assign bucket "wall_backdrop" — these are likely hanging decorations.
- If an item's vertical center is > 700 and the item is round and sits on a flat surface (e.g. plates, chargers, coasters), assign bucket "tabletop" — these are likely table items.
- Use your judgment for items in between, considering context clues.

ANCHOR MAPPING:
Map items to the most appropriate room anchor based on their type:
${anchorDescriptions}
- "tabletop" items → anchors of type "surface" (tables, counters)
- "wall_backdrop" items → anchors of type "wall"
- Ceiling-hung items → anchors of type "ceiling"
- Focal decorations → anchors of type "focal_point"
- If no anchor fits, use null.

FILTERING RULES — do NOT include:
- Furniture (tables, chairs, shelves)
- Actual food or drink items
- Permanent fixtures (light switches, outlets, built-in shelving)
- Any single item estimated above $100

Return a JSON array of item objects. Group similar small items (plates, cups, napkins of the same theme) and suggest a kit-based search query instead of listing them individually.`;

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
