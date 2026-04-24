// PartyPlanner App - Core Application Logic
// Uses localStorage for persistence, IndexedDB for images

(function () {
  'use strict';

  // ── Data Layer ──

  function loadData() {
    const defaults = {
      guests: [],
      expenses: [],
      budgetLimit: 0,
      partyBucket: [],
      moodBoardItems: [],
      plannerState: null,
      chatHistory: [],
      uploadedImages: [],
    };
    try {
      const raw = localStorage.getItem('partyplanner');
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  function saveData(d) {
    localStorage.setItem('partyplanner', JSON.stringify(d));
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  let data = loadData();

  // ── Settings (API Keys) ──

  function getApiKey() {
    return localStorage.getItem('partyplanner_openai_key') || '';
  }

  function saveApiKey(key) {
    if (key) localStorage.setItem('partyplanner_openai_key', key);
    else localStorage.removeItem('partyplanner_openai_key');
  }

  function isLLMMode() {
    return true; // Always use LLM — backend holds the API key
  }

  const settingsBtn = document.getElementById('settings-btn');
  const settingsForm = document.getElementById('settings-form');
  const openaiKeyInput = document.getElementById('openai-key');

  settingsBtn.addEventListener('click', () => {
    openaiKeyInput.value = getApiKey();
    openModal('settings-modal');
  });

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveApiKey(openaiKeyInput.value.trim());
    closeModal('settings-modal');
  });

  // ══════════════════════════════════════
  //  Claude — LLM Party Planner
  // ══════════════════════════════════════

  const PLANNER_SYSTEM = [
    'You are a friendly, knowledgeable AI Party Planning Agent built into the PartyPlanner app.',
    'You orchestrate a multi-stage pipeline: gather preferences → fetch Pinterest inspiration → analyze chosen image → search real products → build shopping bucket.',
    '',
    'PIPELINE FLOW:',
    '',
    'STAGE 1 — Gather info (briefly, not all at once):',
    '- Party type and theme/style',
    '- Approximate guest count',
    '- Budget range',
    'Once you have party type + one other detail, move to Stage 2.',
    '',
    'STAGE 2 — Fetch Pinterest inspiration:',
    '- Call search_pinterest_inspiration with a descriptive query matching their vision',
    '- Example queries: "bohemian garden tea party decor", "moana birthday party kids", "rose gold elegant wedding"',
    '- The app displays the returned images as a selectable grid for the user.',
    '- Wait for the user to pick one, or respond to refinement requests like "more rustic" / "less pink" by calling search_pinterest_inspiration again with refined query.',
    '',
    'STAGE 3 — Extract items from chosen image:',
    '- When the user selects an inspiration image, they will upload it back to you as a vision input.',
    '- Analyze the image and identify every distinct item: furniture, decor, tableware, florals, lighting, etc.',
    '- For each item, decide a specific searchable product name (e.g. "wicker rattan dining chairs" not "chairs").',
    '',
    'STAGE 4 — Search real products:',
    '- For each identified item, call search_real_products with the product name and best retailer.',
    '- The app will fetch live listings from Amazon/Walmart/Target and add them to the Party Bucket automatically.',
    '- After all searches complete, summarize what was added.',
    '',
    'ONGOING:',
    '- If user asks to add, remove, or change items later, call update_party_bucket.',
    '- If user wants different inspiration, call search_pinterest_inspiration again.',
    '- Keep responses concise: 1-3 sentences. Be warm and enthusiastic.',
    '- React to what the user actually says. Do not repeat questions already answered.',
    '',
    'WHEN USER UPLOADS OWN IMAGES (not from Pinterest): skip Stage 2, go straight to Stage 3 analysis.',
  ].join('\n');

  const PLANNER_TOOLS = [
    {
      name: 'search_pinterest_inspiration',
      description: 'Fetch a grid of real inspiration images from Pinterest for the user to choose from. Call this once you know the party type and theme. Also call when the user wants refined/different inspiration (e.g. "more rustic", "less pink").',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Descriptive Pinterest search query (e.g. "bohemian garden tea party decor", "rose gold elegant wedding table")' },
          party_type: { type: 'string', description: 'The type of party' },
          theme: { type: 'string', description: 'Theme or style' },
          max_results: { type: 'number', description: 'Number of images to return (default 12)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_real_products',
      description: 'Search real retailer websites (Amazon/Walmart/Target) for a product and add the best matching listings to the Party Bucket. Call this for EACH item identified in the chosen inspiration image.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Specific product search query (e.g. "wicker rattan dining chair", "eucalyptus garland 6ft")' },
          retailer: { type: 'string', enum: ['amazon', 'walmart', 'target'], description: 'Which retailer to search (default amazon)' },
          category: {
            type: 'string',
            enum: ['decorations', 'tableware', 'entertainment', 'favors', 'stationery', 'accessories', 'baking', 'lighting', 'florals', 'furniture'],
            description: 'Category for bucket organization',
          },
          max_results: { type: 'number', description: 'Max listings to return (default 1, the top match gets auto-added)' },
        },
        required: ['query', 'category'],
      },
    },
    {
      name: 'update_party_bucket',
      description: 'Add, remove, or update the quantity of items in the user\'s party bucket. Use this when the user asks to add more items, remove items, or change quantities.',
      input_schema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            description: 'List of bucket modifications',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'remove', 'update_quantity'], description: 'What to do' },
                item_name: { type: 'string', description: 'Name of the item (for add: new product name, for remove/update: existing item name or close match)' },
                price: { type: 'number', description: 'Price in USD (required for add)' },
                store: { type: 'string', enum: ['Amazon', 'Walmart', 'Target'], description: 'Retailer (required for add)' },
                category: { type: 'string', description: 'Category (required for add)' },
                quantity: { type: 'number', description: 'New quantity (for update_quantity) or quantity to add (for add)' },
              },
              required: ['action', 'item_name'],
            },
          },
        },
        required: ['actions'],
      },
    },
  ];

  async function callClaude(apiMessages) {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: PLANNER_SYSTEM,
          tools: PLANNER_TOOLS,
          messages: apiMessages,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Chat API error:', err);
        return { error: (err.error && err.error.message) || err.error || 'API request failed' };
      }

      return await res.json();
    } catch (err) {
      console.error('Chat API request failed:', err);
      return { error: err.message || 'Network error' };
    }
  }

  // Send the current conversation to Claude and handle the response.
  async function sendToLLM() {
    const state = data.plannerState;
    if (!state || !state.apiMessages) return;

    // Typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-message assistant';
    typingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(typingEl);
    scrollChatToBottom();
    chatInput.disabled = true;

    const result = await callClaude(state.apiMessages);
    typingEl.remove();
    chatInput.disabled = false;
    chatInput.focus();

    if (!result || result.error) {
      const msg = result && result.error ? result.error : 'Could not reach the API.';
      addAssistantMessage('Sorry, something went wrong: ' + msg + '\n\nPlease try again in a moment.');
      return;
    }

    // Collect text and tool_use blocks
    const content = result.content || [];
    const textParts = content.filter(b => b.type === 'text').map(b => b.text);
    const toolUses = content.filter(b => b.type === 'tool_use');

    // Append full assistant message to API history
    state.apiMessages.push({ role: 'assistant', content: content });

    // Display text
    if (textParts.length > 0) {
      addAssistantMessage(textParts.join('\n'));
    }

    // Handle tool calls
    for (const tool of toolUses) {
      if (tool.name === 'search_pinterest_inspiration') {
        const inp = tool.input || {};
        if (inp.party_type) state.partyType = inp.party_type;
        if (inp.theme) state.theme = inp.theme;

        // Fetch real Pinterest results from our scraper
        const pins = await fetchPinterestInspiration(inp.query, inp.max_results || 12);

        // Display as selectable grid
        addPinterestGrid(pins, tool.id);

        // Tool result: tell Claude what we got, wait for user to select
        state.apiMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tool.id,
            content: `Displayed ${pins.length} Pinterest inspiration images for "${inp.query}". Waiting for the user to select one or request refinement.`,
          }],
        });

        saveData(data);
        await sendToLLMContinue();
        return;
      }

      if (tool.name === 'search_real_products') {
        const inp = tool.input || {};

        // Fetch real listings from retailer
        const products = await fetchRealProducts(inp.query, inp.retailer || 'amazon', inp.max_results || 1);

        let toolResultText;
        if (products.length === 0) {
          toolResultText = `No products found for "${inp.query}" on ${inp.retailer || 'amazon'}. Try a different query or retailer.`;
        } else {
          // Auto-add the top match to the bucket
          const top = products[0];
          const newItem = {
            id: generateId(),
            name: top.name,
            price: top.price,
            store: top.retailer,
            category: inp.category || 'decorations',
            quantity: 1,
            url: top.url,
            image: top.image,
            rating: top.rating,
          };
          data.partyBucket.push(newItem);
          saveData(data);
          updateBucketUI();

          toolResultText = `Added "${top.name}" ($${top.price}) from ${top.retailer} to Party Bucket.`;
        }

        // Send tool result
        state.apiMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tool.id,
            content: toolResultText,
          }],
        });

        saveData(data);
        await sendToLLMContinue();
        return;
      }

      if (tool.name === 'update_party_bucket') {
        const inp = tool.input || {};
        const results = [];

        for (const action of (inp.actions || [])) {
          if (action.action === 'add') {
            const newItem = {
              id: generateId(),
              name: action.item_name,
              price: action.price || 0,
              store: action.store || 'Amazon',
              category: action.category || 'decorations',
              quantity: action.quantity || 1,
            };
            data.partyBucket.push(newItem);
            results.push(`Added "${action.item_name}" to bucket`);
          } else if (action.action === 'remove') {
            const idx = data.partyBucket.findIndex(b =>
              b.name.toLowerCase().includes(action.item_name.toLowerCase()) ||
              action.item_name.toLowerCase().includes(b.name.toLowerCase())
            );
            if (idx !== -1) {
              results.push(`Removed "${data.partyBucket[idx].name}" from bucket`);
              data.partyBucket.splice(idx, 1);
            } else {
              results.push(`Could not find "${action.item_name}" in bucket`);
            }
          } else if (action.action === 'update_quantity') {
            const item = data.partyBucket.find(b =>
              b.name.toLowerCase().includes(action.item_name.toLowerCase()) ||
              action.item_name.toLowerCase().includes(b.name.toLowerCase())
            );
            if (item) {
              item.quantity = action.quantity || 1;
              results.push(`Updated "${item.name}" quantity to ${item.quantity}`);
            } else {
              results.push(`Could not find "${action.item_name}" in bucket`);
            }
          }
        }

        saveData(data);
        updateBucketUI();
        refreshMoodItemCards();

        // Send tool result
        state.apiMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tool.id,
            content: results.join('. ') + `. Bucket now has ${data.partyBucket.length} items, total: ${formatCurrency(getBucketTotal())}.`,
          }],
        });

        saveData(data);
        await sendToLLMContinue();
        return;
      }
    }

    saveData(data);
  }

  // Continue LLM conversation after a tool result (no typing indicator needed since we already showed one)
  async function sendToLLMContinue() {
    const state = data.plannerState;
    if (!state || !state.apiMessages) return;

    const result = await callClaude(state.apiMessages);
    if (result && !result.error && result.content) {
      const texts = result.content.filter(b => b.type === 'text').map(b => b.text);
      const toolUses = result.content.filter(b => b.type === 'tool_use');

      state.apiMessages.push({ role: 'assistant', content: result.content });

      if (texts.length > 0) {
        addAssistantMessage(texts.join('\n'));
      }

      // Handle any further tool calls recursively
      for (const tool of toolUses) {
        if (tool.name === 'update_party_bucket') {
          const inp = tool.input || {};
          const results = [];
          for (const action of (inp.actions || [])) {
            if (action.action === 'add') {
              data.partyBucket.push({
                id: generateId(),
                name: action.item_name,
                price: action.price || 0,
                store: action.store || 'Amazon',
                category: action.category || 'decorations',
                quantity: action.quantity || 1,
              });
              results.push(`Added "${action.item_name}"`);
            } else if (action.action === 'remove') {
              const idx = data.partyBucket.findIndex(b =>
                b.name.toLowerCase().includes(action.item_name.toLowerCase())
              );
              if (idx !== -1) {
                results.push(`Removed "${data.partyBucket[idx].name}"`);
                data.partyBucket.splice(idx, 1);
              }
            } else if (action.action === 'update_quantity') {
              const item = data.partyBucket.find(b =>
                b.name.toLowerCase().includes(action.item_name.toLowerCase())
              );
              if (item) {
                item.quantity = action.quantity || 1;
                results.push(`Updated "${item.name}" qty to ${item.quantity}`);
              }
            }
          }
          saveData(data);
          updateBucketUI();

          state.apiMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: tool.id,
              content: results.join('. ') + `. Bucket: ${data.partyBucket.length} items, ${formatCurrency(getBucketTotal())}.`,
            }],
          });
          saveData(data);
          await sendToLLMContinue();
          return;
        }
      }

      saveData(data);
    }
  }

  function getBucketTotal() {
    return data.partyBucket.reduce((s, item) => s + (item.price * (item.quantity || 1)), 0);
  }

  // ══════════════════════════════════════
  //  MCP Pipeline: Pinterest + Products
  // ══════════════════════════════════════

  async function fetchPinterestInspiration(query, maxResults) {
    try {
      const res = await fetch('/api/search-pinterest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: maxResults || 12 }),
      });
      const data = await res.json();
      return data.pins || [];
    } catch (err) {
      console.error('Pinterest fetch failed:', err);
      return [];
    }
  }

  async function fetchRealProducts(query, retailer, maxResults) {
    try {
      const res = await fetch('/api/search-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, retailer, max_results: maxResults || 1 }),
      });
      const data = await res.json();
      return data.products || [];
    } catch (err) {
      console.error('Product search failed:', err);
      return [];
    }
  }

  // Render Pinterest inspiration grid in chat
  function addPinterestGrid(pins, toolUseId) {
    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.style.maxWidth = '100%';

    if (pins.length === 0) {
      msg.innerHTML = '<em>No Pinterest results found. Try a different description or refinement.</em>';
      chatMessages.appendChild(msg);
      scrollChatToBottom();
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'pinterest-heading';
    heading.textContent = `Pick the inspiration you love — I'll extract every item and find real products for your bucket.`;
    msg.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'pinterest-grid';

    pins.forEach((pin, i) => {
      const card = document.createElement('div');
      card.className = 'pinterest-card';
      card.innerHTML = `
        <div class="pinterest-img-wrap">
          <img src="${pin.image_url}" alt="${escapeHtml(pin.title || 'Inspiration')}" loading="lazy">
        </div>
        <button class="pinterest-select-btn" data-idx="${i}">Use this inspiration</button>
      `;
      grid.appendChild(card);
    });

    msg.appendChild(grid);
    chatMessages.appendChild(msg);
    scrollChatToBottom();

    // Wire up selection handlers
    grid.querySelectorAll('.pinterest-select-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const chosenPin = pins[idx];
        if (!chosenPin) return;

        // Disable all buttons and highlight the chosen one
        grid.querySelectorAll('.pinterest-select-btn').forEach(b => {
          b.disabled = true;
          b.textContent = b === btn ? '✓ Selected' : 'Use this inspiration';
          b.classList.toggle('selected', b === btn);
        });
        grid.querySelectorAll('.pinterest-card').forEach((c, i) => {
          c.classList.toggle('selected', i === idx);
          c.classList.toggle('dimmed', i !== idx);
        });

        await handlePinterestSelection(chosenPin);
      });
    });
  }

  // When user picks a Pinterest image, feed it back to Claude as a vision input
  async function handlePinterestSelection(pin) {
    const state = data.plannerState;
    if (!state || !state.apiMessages) return;

    addChatMessage('user', `I love this one! Please analyze it and find the items.`);

    // Fetch image, convert to base64 (so Claude vision can see it)
    let imageBlock = null;
    try {
      const imgRes = await fetch(pin.image_url);
      const blob = await imgRes.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          const match = result.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) resolve({ mediaType: match[1], data: match[2] });
          else reject(new Error('Could not extract base64'));
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      imageBlock = {
        type: 'image',
        source: { type: 'base64', media_type: base64.mediaType, data: base64.data },
      };
    } catch (err) {
      console.warn('Could not fetch Pinterest image for vision, using URL reference:', err);
    }

    const contentBlocks = [];
    if (imageBlock) contentBlocks.push(imageBlock);
    contentBlocks.push({
      type: 'text',
      text: `I selected this inspiration from Pinterest: ${pin.pin_url || pin.image_url}. Please analyze the image: identify every distinct item (furniture, decor, tableware, florals, lighting, etc.), then for each item call search_real_products to find and add real listings to my Party Bucket.`,
    });

    state.apiMessages.push({ role: 'user', content: contentBlocks });
    saveData(data);
    sendToLLM();
  }

  // Display shopping list products in the chat
  function addShoppingListToChat(items, colorPalette) {
    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.style.maxWidth = '100%';

    // Show color palette if available
    if (colorPalette && colorPalette.length > 0) {
      const paletteDiv = document.createElement('div');
      paletteDiv.className = 'color-palette-bar';
      colorPalette.forEach(hex => {
        const swatch = document.createElement('div');
        swatch.className = 'color-swatch';
        swatch.style.background = hex;
        swatch.title = hex;
        paletteDiv.appendChild(swatch);
      });
      msg.appendChild(paletteDiv);
    }

    const grid = document.createElement('div');
    grid.className = 'chat-mood-grid';

    items.forEach(item => {
      grid.appendChild(createMoodItemCard(item));
    });

    msg.appendChild(grid);
    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  // ── Chat Image Upload Handling ──

  let pendingChatImages = []; // Array of { dataUrl, base64, mediaType }

  const chatUploadBtn = document.getElementById('chat-upload-btn');
  const chatUploadInput = document.getElementById('chat-upload-input');
  const chatImagePreview = document.getElementById('chat-image-preview');

  chatUploadBtn.addEventListener('click', () => {
    chatUploadInput.click();
  });

  chatUploadInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (pendingChatImages.length >= 10) break;

      const compressed = await compressImage(file, 800, 0.8);
      // Extract base64 and media type from data URL
      const match = compressed.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) continue;

      pendingChatImages.push({
        dataUrl: compressed,
        base64: match[2],
        mediaType: match[1],
      });
    }

    chatUploadInput.value = '';
    renderChatImagePreview();
  });

  function renderChatImagePreview() {
    if (pendingChatImages.length === 0) {
      chatImagePreview.classList.add('hidden');
      chatImagePreview.innerHTML = '';
      return;
    }

    chatImagePreview.classList.remove('hidden');
    chatImagePreview.innerHTML = pendingChatImages.map((img, i) => `
      <div class="chat-preview-thumb">
        <img src="${img.dataUrl}" alt="Upload ${i + 1}">
        <button class="chat-preview-remove" data-idx="${i}">&times;</button>
      </div>
    `).join('') + `<span class="chat-preview-count">${pendingChatImages.length}/10 images</span>`;

    chatImagePreview.querySelectorAll('.chat-preview-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        pendingChatImages.splice(idx, 1);
        renderChatImagePreview();
      });
    });
  }

  // After the user selects scenes in LLM mode, send the tool result and show products.
  async function handleLLMSceneSelection(sceneNames, items) {
    const state = data.plannerState;

    // Send tool result
    state.apiMessages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: state.pendingToolId,
          content: 'The user selected these inspiration scenes: ' + sceneNames + '. Product recommendations have been auto-generated and displayed. Summarize the picks and encourage the user to review and add items to their Party Bucket.',
        },
      ],
    });
    state.pendingToolId = null;
    saveData(data);

    // Show products immediately
    addAssistantMessageWithMoodBoard('', items);

    // Get Claude's commentary
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-message assistant';
    typingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(typingEl);
    scrollChatToBottom();

    const result = await callClaude(state.apiMessages);
    typingEl.remove();

    if (result && !result.error && result.content) {
      const texts = result.content.filter(b => b.type === 'text').map(b => b.text);
      if (texts.length > 0) {
        addAssistantMessage(texts.join('\n'));
      }
      state.apiMessages.push({ role: 'assistant', content: result.content });
    }

    state.stage = 'complete';
    saveData(data);

    if (getApiKey()) {
      generateImagesForItems(items, state.partyType, state.theme);
    }
  }

  // ══════════════════════════════════════
  //  IndexedDB for Image Storage
  // ══════════════════════════════════════

  const DB_NAME = 'partyplanner_images';
  const DB_VERSION = 1;
  const STORE_NAME = 'images';
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function saveImage(id, dataUrl) {
    return openDB().then(database => {
      return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, dataUrl, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  function getImage(id) {
    return openDB().then(database => {
      return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result ? request.result.dataUrl : null);
        request.onerror = () => reject(request.error);
      });
    });
  }

  function deleteImage(id) {
    return openDB().then(database => {
      return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  // ── Image Compression ──

  function compressImage(file, maxWidth, quality) {
    maxWidth = maxWidth || 800;
    quality = quality || 0.7;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width;
          let h = img.height;
          if (w > maxWidth) {
            h = Math.round((h * maxWidth) / w);
            w = maxWidth;
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Utility ──

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatCurrency(amount) {
    return '$' + Number(amount).toFixed(2);
  }

  // ── Tab Navigation (removed — single-page MVP) ──

  // ── Modal Helpers ──

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
    el.addEventListener('click', () => {
      const modalId = el.dataset.modal;
      if (modalId) closeModal(modalId);
    });
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  // ══════════════════════════════════════
  //  DALL-E Image Generation
  // ══════════════════════════════════════

  async function generateImageWithDallE(prompt) {
    const apiKey = getApiKey();
    if (!apiKey) return null;

    try {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('DALL-E error:', err);
        return null;
      }

      const result = await response.json();
      if (result.data && result.data[0] && result.data[0].b64_json) {
        return 'data:image/png;base64,' + result.data[0].b64_json;
      }
      return null;
    } catch (err) {
      console.error('DALL-E request failed:', err);
      return null;
    }
  }

  function buildImagePrompt(itemName, partyType, theme) {
    const typeLabel = partyTypeLabels[partyType] || 'party';
    const themeDesc = theme ? ` with a "${theme}" theme` : '';
    return `Professional product photography of ${itemName} for a ${typeLabel}${themeDesc}. Clean white background, high quality, styled beautifully for a party supply catalog. No text or watermarks.`;
  }

  // ══════════════════════════════════════
  //  INSPIRATION SCENE CATALOG
  // ══════════════════════════════════════
  //
  // Each scene represents a visual "look" — a curated decor setup.
  // Scenes have pre-tagged products so we can recommend items
  // based on which scenes the user loves.

  const inspirationScenes = {
    birthday: [
      {
        id: 'bday-balloon-arch',
        name: 'Balloon Arch Entrance',
        description: 'A dramatic balloon arch in themed colors welcoming guests at the entrance',
        emoji: '\u{1F388}\u{1F38A}',
        imagePrompt: 'Beautiful balloon arch entrance for a birthday party with colorful balloons in pink gold and white, party entrance decoration, professional event photography',
        products: [
          { name: 'Balloon Arch Kit', emoji: '\u{1F388}', price: 24.99, category: 'decorations' },
          { name: 'Balloon Pump', emoji: '\u{1F4A8}', price: 12.99, category: 'decorations' },
          { name: 'Metallic Gold Balloons Pack of 50', emoji: '\u{1F388}', price: 9.99, category: 'decorations' },
          { name: 'Balloon Decorating Strip 25ft', emoji: '\u{1F380}', price: 6.99, category: 'decorations' },
        ],
      },
      {
        id: 'bday-dessert-table',
        name: 'Themed Dessert Table',
        description: 'A beautifully styled dessert table with cake, cupcakes, and coordinated treats',
        emoji: '\u{1F382}\u{1F9C1}',
        imagePrompt: 'Stunning birthday dessert table with tiered cake, cupcakes, cake pops, candy jars, themed decorations, professional party photography',
        products: [
          { name: 'Tiered Cake Stand', emoji: '\u{1F382}', price: 22.99, category: 'tableware' },
          { name: 'Cupcake Tower Display', emoji: '\u{1F9C1}', price: 18.99, category: 'tableware' },
          { name: 'Cake Topper', emoji: '\u{2728}', price: 8.99, category: 'decorations' },
          { name: 'Dessert Table Backdrop', emoji: '\u{1F3A8}', price: 19.99, category: 'decorations' },
          { name: 'Candy Jars Set of 6', emoji: '\u{1F36C}', price: 14.99, category: 'tableware' },
        ],
      },
      {
        id: 'bday-table-setting',
        name: 'Coordinated Table Setting',
        description: 'Matching plates, cups, napkins, and centerpieces in your party theme',
        emoji: '\u{1F37D}\u{1F3A8}',
        imagePrompt: 'Beautiful themed birthday party table setting with coordinated plates cups napkins centerpieces and party favors, overhead shot, professional event styling',
        products: [
          { name: 'Themed Paper Plates Set of 24', emoji: '\u{1F37D}', price: 12.99, category: 'tableware' },
          { name: 'Themed Paper Cups Set of 24', emoji: '\u{1F964}', price: 9.99, category: 'tableware' },
          { name: 'Themed Napkins Set of 50', emoji: '\u{1F9FB}', price: 8.99, category: 'tableware' },
          { name: 'Tablecloth Pack of 3', emoji: '\u{1F3A8}', price: 14.99, category: 'decorations' },
          { name: 'Table Centerpiece', emoji: '\u{1F490}', price: 16.99, category: 'decorations' },
          { name: 'Plastic Utensils Set of 72', emoji: '\u{1F374}', price: 10.99, category: 'tableware' },
        ],
      },
      {
        id: 'bday-photo-zone',
        name: 'Photo Booth & Backdrop',
        description: 'An Instagram-worthy photo zone with props, backdrop, and fun accessories',
        emoji: '\u{1F4F8}\u{1F451}',
        imagePrompt: 'Fun birthday party photo booth with backdrop, props, balloons and string lights, colorful and Instagram-worthy, professional party setup',
        products: [
          { name: 'Photo Booth Backdrop 5x7ft', emoji: '\u{1F4F8}', price: 18.99, category: 'decorations' },
          { name: 'Photo Booth Props Kit 30pc', emoji: '\u{1F451}', price: 12.49, category: 'entertainment' },
          { name: 'String Lights 20ft', emoji: '\u{1F4A1}', price: 14.99, category: 'decorations' },
          { name: 'Polaroid Guest Book Set', emoji: '\u{1F4D6}', price: 16.99, category: 'stationery' },
        ],
      },
      {
        id: 'bday-party-favors',
        name: 'Party Favor Station',
        description: 'A curated display of thank-you bags, treats, and small gifts for guests',
        emoji: '\u{1F381}\u{1F36D}',
        imagePrompt: 'Beautiful party favor station with decorated gift bags, candy, small toys, and thank you tags displayed on a styled table, professional event photography',
        products: [
          { name: 'Party Favor Bags Pack of 24', emoji: '\u{1F381}', price: 13.99, category: 'favors' },
          { name: 'Favor Tags & Ribbon Set', emoji: '\u{1F380}', price: 7.99, category: 'favors' },
          { name: 'Mini Candy Bags 50pc', emoji: '\u{1F36C}', price: 9.99, category: 'favors' },
          { name: 'Party Hats Pack of 12', emoji: '\u{1F451}', price: 8.99, category: 'accessories' },
        ],
      },
      {
        id: 'bday-hanging-decor',
        name: 'Ceiling & Hanging Decor',
        description: 'Paper lanterns, streamers, and hanging decorations transforming the space',
        emoji: '\u{1F3AA}\u{1F38A}',
        imagePrompt: 'Beautiful ceiling decorations for birthday party with paper lanterns, streamers, hanging tissue pom poms and garlands in coordinated colors, looking up perspective',
        products: [
          { name: 'Paper Lanterns Set of 10', emoji: '\u{1F3AA}', price: 14.99, category: 'decorations' },
          { name: 'Tissue Pom Poms Pack of 12', emoji: '\u{1F338}', price: 11.99, category: 'decorations' },
          { name: 'Crepe Streamers 6 Rolls', emoji: '\u{1F38A}', price: 8.99, category: 'decorations' },
          { name: 'Birthday Banner Garland', emoji: '\u{1F389}', price: 10.99, category: 'decorations' },
          { name: 'Confetti Scatter Pack', emoji: '\u{1F38A}', price: 6.99, category: 'decorations' },
        ],
      },
    ],
    wedding: [
      {
        id: 'wed-ceremony-arch',
        name: 'Ceremony Arch & Flowers',
        description: 'A stunning floral arch as the centerpiece of the ceremony',
        emoji: '\u{1F490}\u{1F492}',
        imagePrompt: 'Beautiful wedding ceremony arch decorated with white and blush flowers, greenery, and flowing fabric, outdoor setting, professional wedding photography',
        products: [
          { name: 'Wedding Arch Frame', emoji: '\u{1F492}', price: 45.99, category: 'decorations' },
          { name: 'Artificial Flower Garland 2-pack', emoji: '\u{1F490}', price: 28.99, category: 'decorations' },
          { name: 'Sheer Draping Fabric 10 yards', emoji: '\u{1F380}', price: 16.99, category: 'decorations' },
          { name: 'Greenery Garland 12ft', emoji: '\u{1F33F}', price: 18.99, category: 'decorations' },
        ],
      },
      {
        id: 'wed-reception-table',
        name: 'Elegant Reception Table',
        description: 'Candlelit reception tables with floral runners, place settings, and gold accents',
        emoji: '\u{1F56F}\u{1F942}',
        imagePrompt: 'Elegant wedding reception table with candles, floral centerpiece, gold charger plates, crystal champagne flutes, and silk table runner, warm lighting, professional wedding photography',
        products: [
          { name: 'Gold Charger Plates Set of 12', emoji: '\u{1F37D}', price: 34.99, category: 'tableware' },
          { name: 'Champagne Flutes Pack of 12', emoji: '\u{1F942}', price: 24.99, category: 'tableware' },
          { name: 'Pillar Candle Holders Set of 12', emoji: '\u{1F56F}', price: 28.99, category: 'decorations' },
          { name: 'Silk Table Runner 5-pack', emoji: '\u{1F3A8}', price: 22.99, category: 'decorations' },
          { name: 'Place Card Holders Set of 24', emoji: '\u{1F4DD}', price: 14.99, category: 'stationery' },
          { name: 'Table Numbers 1-25', emoji: '\u{1F522}', price: 12.99, category: 'stationery' },
        ],
      },
      {
        id: 'wed-cake-display',
        name: 'Wedding Cake Display',
        description: 'An elegant multi-tier cake on a decorated table with cake cutting set',
        emoji: '\u{1F382}\u{2728}',
        imagePrompt: 'Beautiful multi-tier white wedding cake on decorated cake table with flowers, cake cutting set, and elegant backdrop, professional wedding photography',
        products: [
          { name: 'Cake Stand Pedestal', emoji: '\u{1F382}', price: 26.99, category: 'tableware' },
          { name: 'Cake Cutting Set', emoji: '\u{1F52A}', price: 18.99, category: 'accessories' },
          { name: 'Cake Topper', emoji: '\u{2728}', price: 12.99, category: 'decorations' },
          { name: 'Dessert Plates Set of 50', emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
        ],
      },
      {
        id: 'wed-aisle-decor',
        name: 'Aisle & Seating Decor',
        description: 'Rose petals down the aisle, chair sashes, and aisle markers',
        emoji: '\u{1F339}\u{1F380}',
        imagePrompt: 'Wedding aisle decorated with rose petals, chair sashes, aisle markers with flowers and lanterns, white chairs, professional wedding photography',
        products: [
          { name: 'Rose Petals 2000 pcs', emoji: '\u{1F339}', price: 14.99, category: 'decorations' },
          { name: 'Chair Sashes Pack of 25', emoji: '\u{1F380}', price: 19.99, category: 'decorations' },
          { name: 'Aisle Runner 100ft', emoji: '\u{1F3A8}', price: 16.99, category: 'decorations' },
          { name: 'Lantern Aisle Markers Set of 6', emoji: '\u{1F56F}', price: 24.99, category: 'decorations' },
        ],
      },
      {
        id: 'wed-guest-favors',
        name: 'Guest Favors & Keepsakes',
        description: 'Beautifully wrapped favors, a guest book, and bubbles for the send-off',
        emoji: '\u{1F381}\u{1F4D6}',
        imagePrompt: 'Elegant wedding favor table with wrapped favor boxes, guest book with pen, and bubble tubes, white and gold theme, professional wedding photography',
        products: [
          { name: 'Wedding Favor Boxes Set of 50', emoji: '\u{1F381}', price: 19.99, category: 'favors' },
          { name: 'Guest Book & Pen Set', emoji: '\u{1F4D6}', price: 22.99, category: 'stationery' },
          { name: 'Wedding Bubbles Set of 48', emoji: '\u{1FAE7}', price: 12.99, category: 'entertainment' },
          { name: 'Satin Ribbon 100 yards', emoji: '\u{1F380}', price: 9.99, category: 'decorations' },
        ],
      },
      {
        id: 'wed-fairy-lights',
        name: 'Fairy Lights & Ambiance',
        description: 'Twinkling fairy lights, candles, and tulle creating a magical atmosphere',
        emoji: '\u{2728}\u{1F56F}',
        imagePrompt: 'Magical wedding venue with fairy lights draped from ceiling, candles on tables, tulle decorations, warm romantic ambiance, professional wedding photography',
        products: [
          { name: 'Fairy Lights 100ft', emoji: '\u{2728}', price: 26.99, category: 'decorations' },
          { name: 'LED Tea Light Candles 36-pack', emoji: '\u{1F56F}', price: 14.99, category: 'decorations' },
          { name: 'Tulle Roll 100 yards', emoji: '\u{1F3A8}', price: 11.99, category: 'decorations' },
          { name: 'Hanging Glass Votives Set of 12', emoji: '\u{2728}', price: 19.99, category: 'decorations' },
        ],
      },
    ],
    babyshower: [
      {
        id: 'bs-dessert-table',
        name: 'Sweet Dessert Display',
        description: 'Pastel dessert table with themed cookies, cupcakes, and cake',
        emoji: '\u{1F370}\u{1F9C1}',
        imagePrompt: 'Adorable baby shower dessert table with pastel themed cake, cupcakes, cookies shaped like baby items, candy jars, and cute decorations, professional event photography',
        products: [
          { name: 'Baby Shower Cake Topper', emoji: '\u{1F382}', price: 8.99, category: 'decorations' },
          { name: 'Cupcake Stand 3-Tier', emoji: '\u{1F9C1}', price: 16.99, category: 'tableware' },
          { name: 'Cookie Cutter Set - Baby Shapes', emoji: '\u{1F36A}', price: 9.99, category: 'baking' },
          { name: 'Dessert Labels & Picks 30pc', emoji: '\u{1F4DD}', price: 6.99, category: 'stationery' },
          { name: 'Candy Jars Set of 4', emoji: '\u{1F36C}', price: 12.99, category: 'tableware' },
        ],
      },
      {
        id: 'bs-table-setting',
        name: 'Themed Table Setting',
        description: 'Coordinated pastel table decor with cute baby-themed plates and centerpieces',
        emoji: '\u{1F476}\u{1F37D}',
        imagePrompt: 'Beautiful baby shower table setting with pastel themed plates, cups, napkins, cute centerpieces with baby blocks and stuffed animals, professional event photography',
        products: [
          { name: 'Baby Shower Plates Set of 24', emoji: '\u{1F37D}', price: 11.99, category: 'tableware' },
          { name: 'Baby Shower Cups Set of 24', emoji: '\u{1F964}', price: 9.99, category: 'tableware' },
          { name: 'Pastel Napkins Set of 50', emoji: '\u{1F9FB}', price: 8.99, category: 'tableware' },
          { name: 'Centerpiece Baby Blocks Set', emoji: '\u{1F9F1}', price: 14.99, category: 'decorations' },
          { name: 'Tablecloth Pastel 3-pack', emoji: '\u{1F3A8}', price: 12.99, category: 'decorations' },
        ],
      },
      {
        id: 'bs-balloon-garland',
        name: 'Balloon Garland & Banner',
        description: 'Soft pastel balloon garland with a "Welcome Baby" banner',
        emoji: '\u{1F388}\u{1F476}',
        imagePrompt: 'Pastel balloon garland decoration for baby shower with welcome baby banner, soft pink blue and white balloons, stuffed animals, professional event photography',
        products: [
          { name: 'Pastel Balloon Garland Kit', emoji: '\u{1F388}', price: 22.99, category: 'decorations' },
          { name: 'Welcome Baby Banner', emoji: '\u{1F476}', price: 9.99, category: 'decorations' },
          { name: 'Balloon Pump', emoji: '\u{1F4A8}', price: 8.99, category: 'decorations' },
          { name: 'Confetti Balloons 12-pack', emoji: '\u{1F38A}', price: 7.99, category: 'decorations' },
        ],
      },
      {
        id: 'bs-games-activities',
        name: 'Games & Activity Station',
        description: 'Fun baby shower games, advice cards, and activities for guests',
        emoji: '\u{1F3B2}\u{1F4DD}',
        imagePrompt: 'Baby shower game station with activity cards, prediction cards, diaper raffle tickets, and prizes displayed on a decorated table, professional event photography',
        products: [
          { name: 'Baby Shower Games Pack (5 games)', emoji: '\u{1F3B2}', price: 14.99, category: 'entertainment' },
          { name: 'Advice & Wishes Cards 50pc', emoji: '\u{1F4DD}', price: 9.99, category: 'stationery' },
          { name: 'Diaper Raffle Tickets 50pc', emoji: '\u{1F3AB}', price: 6.99, category: 'entertainment' },
          { name: 'Prize Gift Set', emoji: '\u{1F381}', price: 18.99, category: 'favors' },
        ],
      },
      {
        id: 'bs-diaper-cake',
        name: 'Diaper Cake & Gifts Display',
        description: 'A stunning diaper cake centerpiece surrounded by wrapped baby gifts',
        emoji: '\u{1F381}\u{1F476}',
        imagePrompt: 'Beautiful diaper cake centerpiece for baby shower with ribbons and baby items, surrounded by wrapped gifts, soft pastel styling, professional event photography',
        products: [
          { name: 'Diaper Cake Kit', emoji: '\u{1F476}', price: 24.99, category: 'decorations' },
          { name: 'Baby Gift Wrapping Set', emoji: '\u{1F381}', price: 11.99, category: 'favors' },
          { name: 'Mommy-to-Be Sash & Tiara', emoji: '\u{1F451}', price: 9.99, category: 'accessories' },
          { name: 'Photo Props Kit', emoji: '\u{1F4F8}', price: 11.49, category: 'entertainment' },
        ],
      },
    ],
    graduation: [
      {
        id: 'grad-balloon-display',
        name: 'Congrats Balloon Display',
        description: 'Cap-shaped balloons, number balloons, and school-color decorations',
        emoji: '\u{1F393}\u{1F388}',
        imagePrompt: 'Graduation party balloon display with grad cap balloons, number balloons showing graduation year, school color decorations, professional event photography',
        products: [
          { name: 'Grad Cap Foil Balloons 6-pack', emoji: '\u{1F393}', price: 12.99, category: 'decorations' },
          { name: 'Number Balloons Set', emoji: '\u{1F388}', price: 9.99, category: 'decorations' },
          { name: 'Graduation Banner', emoji: '\u{1F389}', price: 10.99, category: 'decorations' },
          { name: 'School Color Balloons 50-pack', emoji: '\u{1F388}', price: 8.99, category: 'decorations' },
        ],
      },
      {
        id: 'grad-photo-timeline',
        name: 'Photo Memory Timeline',
        description: 'A timeline display showing photos from kindergarten through graduation',
        emoji: '\u{1F4F8}\u{1F5BC}',
        imagePrompt: 'Graduation photo memory timeline display showing photos from childhood through graduation hanging on string with clothespins, decorated with school colors',
        products: [
          { name: 'Photo Banner Garland with Clips', emoji: '\u{1F4F8}', price: 13.99, category: 'decorations' },
          { name: 'Photo Display Board', emoji: '\u{1F5BC}', price: 15.99, category: 'decorations' },
          { name: 'Mini Clothespins 100-pack', emoji: '\u{1F4DD}', price: 5.99, category: 'decorations' },
          { name: 'Guest Signing Board', emoji: '\u{1F4DD}', price: 17.99, category: 'stationery' },
        ],
      },
      {
        id: 'grad-table-setup',
        name: 'Graduation Table Setup',
        description: 'Themed table with plates, cups, and graduation-themed centerpieces',
        emoji: '\u{1F37D}\u{1F393}',
        imagePrompt: 'Graduation party table setting with themed plates cups and napkins, diploma-shaped centerpieces, confetti, school colors, professional event photography',
        products: [
          { name: 'Graduation Plates Set of 24', emoji: '\u{1F37D}', price: 12.99, category: 'tableware' },
          { name: 'Graduation Cups Set of 24', emoji: '\u{1F964}', price: 9.99, category: 'tableware' },
          { name: 'Graduation Napkins Set of 50', emoji: '\u{1F9FB}', price: 8.99, category: 'tableware' },
          { name: 'Table Centerpiece Set', emoji: '\u{1F490}', price: 16.99, category: 'decorations' },
          { name: 'Confetti Scatter Pack', emoji: '\u{1F38A}', price: 6.99, category: 'decorations' },
        ],
      },
      {
        id: 'grad-favors',
        name: 'Grad Party Favors',
        description: 'Favor boxes shaped like grad caps with treats and thank-you tags',
        emoji: '\u{1F381}\u{1F393}',
        imagePrompt: 'Graduation party favor station with cap-shaped favor boxes, treats, thank you tags, and small gifts on decorated table, professional event photography',
        products: [
          { name: 'Grad Cap Favor Boxes 24-pack', emoji: '\u{1F381}', price: 14.99, category: 'favors' },
          { name: 'Thank You Tags 50pc', emoji: '\u{1F4DD}', price: 6.99, category: 'stationery' },
          { name: 'Star String Lights 15ft', emoji: '\u{2B50}', price: 12.99, category: 'decorations' },
          { name: 'Congratulations Cake Topper', emoji: '\u{1F382}', price: 8.99, category: 'decorations' },
        ],
      },
    ],
    retirement: [
      {
        id: 'ret-gold-decor',
        name: 'Gold & Elegant Decor',
        description: 'Gold balloons, banner, and sophisticated table decor for a classy celebration',
        emoji: '\u{1F388}\u{1F3C6}',
        imagePrompt: 'Elegant retirement party with gold and black balloons, Happy Retirement banner, sophisticated table decorations, candles, professional event photography',
        products: [
          { name: 'Gold Balloon Set 30-pack', emoji: '\u{1F388}', price: 11.99, category: 'decorations' },
          { name: 'Happy Retirement Banner', emoji: '\u{1F3C6}', price: 10.99, category: 'decorations' },
          { name: 'Gold Tablecloth 3-pack', emoji: '\u{1F3A8}', price: 12.99, category: 'decorations' },
          { name: 'Candle Centerpiece Set', emoji: '\u{1F56F}', price: 18.99, category: 'decorations' },
        ],
      },
      {
        id: 'ret-memory-display',
        name: 'Career Memory Wall',
        description: 'Photo display celebrating career milestones and memories',
        emoji: '\u{1F5BC}\u{1F4D6}',
        imagePrompt: 'Retirement party memory wall with career photos, milestone timeline, guest book, and heartfelt messages on a decorated display, professional event photography',
        products: [
          { name: 'Memory Book & Guestbook', emoji: '\u{1F4D6}', price: 18.99, category: 'stationery' },
          { name: 'Photo Display Board', emoji: '\u{1F5BC}', price: 15.99, category: 'decorations' },
          { name: 'Retirement Wishes Cards 50pc', emoji: '\u{1F4DD}', price: 9.99, category: 'stationery' },
          { name: 'Gold Photo Clips 30-pack', emoji: '\u{1F4F8}', price: 7.99, category: 'decorations' },
        ],
      },
      {
        id: 'ret-table-setting',
        name: 'Retirement Table Setting',
        description: 'Sophisticated table with gold-rimmed plates and elegant napkins',
        emoji: '\u{1F37D}\u{2728}',
        imagePrompt: 'Sophisticated retirement party table with gold rimmed plates, elegant napkins, champagne glasses, and classy centerpiece, professional event photography',
        products: [
          { name: 'Gold-Rimmed Plates Set of 24', emoji: '\u{1F37D}', price: 16.99, category: 'tableware' },
          { name: 'Champagne Cups Set of 24', emoji: '\u{1F964}', price: 11.99, category: 'tableware' },
          { name: 'Elegant Napkins Set of 50', emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
          { name: 'Table Centerpiece', emoji: '\u{1F490}', price: 17.99, category: 'decorations' },
          { name: 'Retirement Cake Topper', emoji: '\u{1F382}', price: 8.99, category: 'decorations' },
        ],
      },
    ],
    holiday: [
      {
        id: 'hol-table-setting',
        name: 'Festive Table Setting',
        description: 'Holiday-themed table with seasonal plates, garland runner, and candles',
        emoji: '\u{1F384}\u{1F56F}',
        imagePrompt: 'Festive holiday party table setting with seasonal plates, garland table runner, candles, ornaments, and warm lighting, professional event photography',
        products: [
          { name: 'Holiday Plates Set of 24', emoji: '\u{1F37D}', price: 12.99, category: 'tableware' },
          { name: 'Holiday Cups Set of 24', emoji: '\u{1F964}', price: 9.99, category: 'tableware' },
          { name: 'Festive Napkins Set of 50', emoji: '\u{1F9FB}', price: 8.99, category: 'tableware' },
          { name: 'Garland Table Runner 6ft', emoji: '\u{1F33F}', price: 16.99, category: 'decorations' },
          { name: 'Pillar Candles Set of 6', emoji: '\u{1F56F}', price: 14.99, category: 'decorations' },
        ],
      },
      {
        id: 'hol-entrance-decor',
        name: 'Holiday Entrance & Wreath',
        description: 'A welcoming entrance with wreath, lights, and festive garland',
        emoji: '\u{1F33F}\u{1F4A1}',
        imagePrompt: 'Festive holiday party entrance with wreath on door, twinkling lights, garland, and seasonal decorations, warm and welcoming, professional event photography',
        products: [
          { name: 'Wreath 20 inch', emoji: '\u{1F33F}', price: 24.99, category: 'decorations' },
          { name: 'Holiday Lights 30ft', emoji: '\u{1F4A1}', price: 18.99, category: 'decorations' },
          { name: 'Holiday Garland 9ft', emoji: '\u{1F384}', price: 16.99, category: 'decorations' },
          { name: 'Ornament Decor Set of 12', emoji: '\u{1F3AA}', price: 14.99, category: 'decorations' },
        ],
      },
      {
        id: 'hol-cookie-station',
        name: 'Cookie Decorating Station',
        description: 'An interactive cookie decorating station with icing, sprinkles, and shapes',
        emoji: '\u{1F36A}\u{1F3A8}',
        imagePrompt: 'Fun holiday cookie decorating station with various cookie shapes, icing bottles, sprinkles, and decorated cookies on display, professional event photography',
        products: [
          { name: 'Cookie Cutter Set - Holiday', emoji: '\u{1F36A}', price: 9.99, category: 'baking' },
          { name: 'Icing Decorating Kit', emoji: '\u{1F3A8}', price: 12.99, category: 'baking' },
          { name: 'Sprinkles Assortment 6-pack', emoji: '\u{2728}', price: 8.99, category: 'baking' },
          { name: 'Cookie Display Stand', emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
          { name: 'Holiday Favor Tins 12-pack', emoji: '\u{1F381}', price: 11.99, category: 'favors' },
        ],
      },
    ],
    dinner: [
      {
        id: 'din-elegant-table',
        name: 'Elegant Place Settings',
        description: 'Sophisticated place settings with charger plates, wine glasses, and linen napkins',
        emoji: '\u{1F377}\u{1F37D}',
        imagePrompt: 'Elegant dinner party table with charger plates, crystal wine glasses, linen napkins with rings, calligraphy place cards, and candles, professional event photography',
        products: [
          { name: 'Charger Plates Set of 12', emoji: '\u{1F37D}', price: 34.99, category: 'tableware' },
          { name: 'Wine Glasses Set of 12', emoji: '\u{1F377}', price: 28.99, category: 'tableware' },
          { name: 'Linen Napkins Set of 12', emoji: '\u{1F9FB}', price: 19.99, category: 'tableware' },
          { name: 'Napkin Rings Set of 12', emoji: '\u{1F380}', price: 12.99, category: 'tableware' },
          { name: 'Place Card Holders Set of 12', emoji: '\u{1F4DD}', price: 11.99, category: 'stationery' },
        ],
      },
      {
        id: 'din-centerpiece',
        name: 'Floral Centerpieces & Candles',
        description: 'Low floral arrangements with pillar candles creating warm ambiance',
        emoji: '\u{1F490}\u{1F56F}',
        imagePrompt: 'Beautiful dinner party centerpiece with low floral arrangement, pillar candles, greenery, and elegant vases on table runner, warm lighting, professional event photography',
        products: [
          { name: 'Centerpiece Vase Set of 3', emoji: '\u{1F490}', price: 22.99, category: 'decorations' },
          { name: 'Pillar Candles Set of 6', emoji: '\u{1F56F}', price: 16.99, category: 'decorations' },
          { name: 'Table Runner 90 inch', emoji: '\u{1F3A8}', price: 14.99, category: 'decorations' },
          { name: 'Fairy Lights 20ft', emoji: '\u{2728}', price: 12.99, category: 'decorations' },
          { name: 'Eucalyptus Garland 6ft', emoji: '\u{1F33F}', price: 14.99, category: 'decorations' },
        ],
      },
      {
        id: 'din-bar-cart',
        name: 'Bar & Cocktail Setup',
        description: 'A styled bar area with cocktail tools, garnishes, and menu cards',
        emoji: '\u{1F378}\u{1F3A8}',
        imagePrompt: 'Stylish dinner party bar cart with cocktail tools, garnishes, drink menu cards, elegant glasses and bottles, professional event photography',
        products: [
          { name: 'Cocktail Stirrers 50pc', emoji: '\u{1F378}', price: 8.99, category: 'accessories' },
          { name: 'Menu Card Templates 25pc', emoji: '\u{1F4C4}', price: 10.99, category: 'stationery' },
          { name: 'Cocktail Napkins Set of 100', emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
          { name: 'Ice Bucket & Tongs', emoji: '\u{1F9CA}', price: 16.99, category: 'accessories' },
        ],
      },
    ],
    anniversary: [
      {
        id: 'ann-romantic-table',
        name: 'Romantic Table Setting',
        description: 'Rose petals, candles, champagne flutes, and elegant place settings',
        emoji: '\u{1F339}\u{1F56F}',
        imagePrompt: 'Romantic anniversary dinner table with rose petals, candles, champagne flutes, elegant plates, and soft lighting, professional event photography',
        products: [
          { name: 'Rose Petals 1000 pcs', emoji: '\u{1F339}', price: 11.99, category: 'decorations' },
          { name: 'Candle Holders Set of 6', emoji: '\u{1F56F}', price: 18.99, category: 'decorations' },
          { name: 'Champagne Flutes Set of 12', emoji: '\u{1F942}', price: 22.99, category: 'tableware' },
          { name: 'Anniversary Plates Set of 24', emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
          { name: 'Anniversary Napkins Set of 50', emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
        ],
      },
      {
        id: 'ann-photo-display',
        name: 'Photo Memory Display',
        description: 'A timeline of photos through the years with a guest signing canvas',
        emoji: '\u{1F5BC}\u{1F495}',
        imagePrompt: 'Anniversary photo timeline display with couple photos through the years, fairy lights, heart decorations, and guest signing canvas, professional event photography',
        products: [
          { name: 'Photo Display Banner with Clips', emoji: '\u{1F5BC}', price: 14.99, category: 'decorations' },
          { name: 'Guest Signing Canvas', emoji: '\u{1F4DD}', price: 19.99, category: 'stationery' },
          { name: 'Fairy Lights 30ft', emoji: '\u{2728}', price: 15.99, category: 'decorations' },
          { name: 'Heart Confetti Pack', emoji: '\u{1F495}', price: 6.99, category: 'decorations' },
        ],
      },
      {
        id: 'ann-balloon-decor',
        name: 'Balloon & Banner Display',
        description: 'Heart balloons, anniversary banner, and party decorations',
        emoji: '\u{1F388}\u{1F495}',
        imagePrompt: 'Anniversary party decorations with heart shaped balloons, happy anniversary banner, gold accents, and elegant balloon arrangement, professional event photography',
        products: [
          { name: 'Heart Balloons Pack of 24', emoji: '\u{1F388}', price: 10.99, category: 'decorations' },
          { name: 'Anniversary Banner', emoji: '\u{1F495}', price: 10.99, category: 'decorations' },
          { name: 'Party Favor Boxes Pack of 24', emoji: '\u{1F381}', price: 11.99, category: 'favors' },
          { name: 'Cake Topper "Anniversary"', emoji: '\u{1F382}', price: 9.99, category: 'decorations' },
        ],
      },
    ],
  };

  // ══════════════════════════════════════
  //  DIY AI PLANNER
  // ══════════════════════════════════════

  const partyTypeLabels = {
    birthday: 'Birthday Party',
    wedding: 'Wedding',
    babyshower: 'Baby Shower',
    graduation: 'Graduation Party',
    retirement: 'Retirement Party',
    holiday: 'Holiday Party',
    dinner: 'Dinner Party',
    anniversary: 'Anniversary',
  };

  const partyTypeEmojis = {
    birthday: '\u{1F382}',
    wedding: '\u{1F492}',
    babyshower: '\u{1F476}',
    graduation: '\u{1F393}',
    retirement: '\u{1F3C6}',
    holiday: '\u{1F384}',
    dinner: '\u{1F37D}',
    anniversary: '\u{1F495}',
  };

  // Category color map for product card visuals (replaces emoji)
  const categoryStyles = {
    decorations: { gradient: 'linear-gradient(135deg, #ffecd2, #fcb69f)', label: 'Decor' },
    tableware:   { gradient: 'linear-gradient(135deg, #a1c4fd, #c2e9fb)', label: 'Tableware' },
    entertainment: { gradient: 'linear-gradient(135deg, #d4fc79, #96e6a1)', label: 'Fun' },
    favors:      { gradient: 'linear-gradient(135deg, #f093fb, #f5576c)', label: 'Favors' },
    stationery:  { gradient: 'linear-gradient(135deg, #fff1c1, #f7c948)', label: 'Stationery' },
    accessories: { gradient: 'linear-gradient(135deg, #667eea, #764ba2)', label: 'Accessories' },
    baking:      { gradient: 'linear-gradient(135deg, #f6d365, #fda085)', label: 'Baking' },
    lighting:    { gradient: 'linear-gradient(135deg, #ffecd2, #fcb69f)', label: 'Lighting' },
    florals:     { gradient: 'linear-gradient(135deg, #f5c6ec, #fce4ec)', label: 'Florals' },
  };

  function getCategoryStyle(category) {
    return categoryStyles[category] || { gradient: 'linear-gradient(135deg, #dfe6e9, #b2bec3)', label: category || 'Item' };
  }

  // Conversational planner — no rigid state machine.
  // The agent tracks what info it still needs and detects user intent.

  function initPlannerState(partyType, userPrompt) {
    return {
      partyType: partyType || 'other',
      theme: userPrompt || '',
      guestCount: null,
      budget: null,
      isDIY: null,
      selectedScenes: [],
      stage: partyType && userPrompt ? 'ask-guests' : 'ask-theme',
    };
  }

  // ── Planner UI Elements ──
  const plannerLanding = document.getElementById('planner-landing');
  const plannerChat = document.getElementById('planner-chat');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const plannerInput = document.getElementById('planner-input');

  // ── Start Planner from Landing ──

  document.getElementById('planner-send-btn').addEventListener('click', () => {
    const text = plannerInput.value.trim();
    if (!text) return;
    const detected = detectPartyType(text);
    startPlanner(detected, text);
  });

  plannerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('planner-send-btn').click();
    }
  });

  document.querySelectorAll('.quick-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      startPlanner(type, '');
    });
  });

  function detectPartyType(text) {
    const lower = text.toLowerCase();
    if (lower.includes('birthday')) return 'birthday';
    if (lower.includes('wedding')) return 'wedding';
    if (lower.includes('baby shower') || lower.includes('babyshower')) return 'babyshower';
    if (lower.includes('graduation') || lower.includes('grad party')) return 'graduation';
    if (lower.includes('retirement')) return 'retirement';
    if (lower.includes('holiday') || lower.includes('christmas') || lower.includes('halloween')) return 'holiday';
    if (lower.includes('dinner')) return 'dinner';
    if (lower.includes('anniversary')) return 'anniversary';
    return 'birthday';
  }

  function startPlanner(partyType, userPrompt) {
    data.plannerState = initPlannerState(partyType, userPrompt);
    data.plannerState.apiMessages = [];
    data.chatHistory = [];
    data.moodBoardItems = [];
    saveData(data);

    plannerLanding.classList.add('hidden');
    plannerChat.classList.remove('hidden');

    const label = partyTypeLabels[partyType] || 'Party';
    document.getElementById('planner-party-title').textContent = label + ' Planner';

    chatMessages.innerHTML = '';

    if (isLLMMode()) {
      // LLM-powered flow
      const firstMsg = userPrompt || ('I want to plan a ' + (partyTypeLabels[partyType] || 'party'));
      addChatMessage('user', firstMsg);
      data.plannerState.apiMessages.push({ role: 'user', content: firstMsg });
      saveData(data);
      sendToLLM();
    } else {
      // Fallback: hardcoded flow
      if (userPrompt) addChatMessage('user', userPrompt);
      advancePlanner();
    }
  }

  function advancePlanner() {
    const state = data.plannerState;
    if (!state) return;

    switch (state.stage) {
      case 'ask-theme': {
        const label = partyTypeLabels[state.partyType] || 'party';
        showTypingThen(() => {
          addAssistantMessage(
            `Great choice! Let's plan an amazing ${label}! \n\nWhat theme or style do you have in mind? For example, a color scheme, character theme, or a vibe like "rustic" or "elegant".`,
            [
              { text: 'Elegant & Classic', value: 'elegant and classic theme' },
              { text: 'Rustic & Natural', value: 'rustic and natural theme' },
              { text: 'Fun & Colorful', value: 'fun and colorful theme' },
              { text: 'Minimalist & Modern', value: 'minimalist and modern theme' },
            ]
          );
        });
        break;
      }
      case 'ask-guests': {
        showTypingThen(() => {
          const themeDesc = state.theme ? `Love the "${escapeHtml(state.theme)}" theme! ` : '';
          addAssistantMessage(
            `${themeDesc}How many people are you expecting?`,
            [
              { text: '10-20 people', value: '15' },
              { text: '20-50 people', value: '35' },
              { text: '50-100 people', value: '75' },
              { text: '100+ people', value: '120' },
            ]
          );
        });
        break;
      }
      case 'ask-budget': {
        showTypingThen(() => {
          addAssistantMessage(
            `Planning for ${state.guestCount} guests! What's your approximate budget?`,
            [
              { text: 'Under $200', value: '150' },
              { text: '$200 - $500', value: '350' },
              { text: '$500 - $1,000', value: '750' },
              { text: '$1,000 - $2,500', value: '1750' },
              { text: '$2,500+', value: '3000' },
            ]
          );
        });
        break;
      }
      case 'ask-diy': {
        showTypingThen(() => {
          addAssistantMessage(
            `Budget of ${formatCurrency(state.budget)} \u2014 got it! Last question: Are you doing this DIY or with a coordinator?`,
            [
              { text: 'DIY \u2014 Doing it myself!', value: 'DIY' },
              { text: 'I have a coordinator', value: 'coordinator' },
            ]
          );
        });
        break;
      }
      case 'show-inspiration': {
        showTypingThen(() => {
          const scenes = inspirationScenes[state.partyType] || inspirationScenes.birthday;
          const themeLabel = state.theme ? ` with your "${escapeHtml(state.theme)}" vibe` : '';
          addAssistantMessage(
            `Here's some inspiration for your ${partyTypeLabels[state.partyType] || 'party'}${themeLabel}! \n\nTap the scenes you love \u2014 I'll use your picks to recommend exactly what to buy.`
          );
          addInspirationGrid(scenes);
        }, 1200);
        break;
      }
      case 'generate': {
        showTypingThen(() => {
          const items = data.moodBoardItems || [];
          const sceneCount = state.selectedScenes.length;
          addAssistantMessage(
            `Based on the ${sceneCount} look${sceneCount > 1 ? 's' : ''} you picked, here's what I recommend to bring it to life! Click "Add to Bucket" on the ones you want.`
          );

          addAssistantMessageWithMoodBoard('', items);

          state.stage = 'complete';
          saveData(data);

          if (getApiKey()) {
            generateImagesForItems(items, state.partyType, state.theme);
          }
        }, 1500);
        break;
      }
      case 'complete': {
        break;
      }
    }
  }

  // ══════════════════════════════════════
  //  INSPIRATION SCENE GRID (Multi-Select)
  // ══════════════════════════════════════

  function addInspirationGrid(scenes) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message assistant';
    wrapper.style.maxWidth = '100%';

    const grid = document.createElement('div');
    grid.className = 'inspiration-grid';

    const selected = new Set();

    scenes.forEach(scene => {
      const card = document.createElement('div');
      card.className = 'inspiration-card';
      card.id = 'inspiration-' + scene.id;

      const hasApiKey = !!getApiKey();
      let visualContent;
      if (hasApiKey) {
        visualContent = '<div class="img-loading"><div class="spinner"></div><span>Loading...</span></div>';
      } else {
        visualContent = `<span class="inspiration-emoji">${scene.emoji}</span>`;
      }

      card.innerHTML = `
        <div class="inspiration-visual">${visualContent}</div>
        <div class="inspiration-check">\u2713</div>
        <div class="inspiration-info">
          <span class="inspiration-name">${escapeHtml(scene.name)}</span>
          <span class="inspiration-desc">${escapeHtml(scene.description)}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        if (selected.has(scene.id)) {
          selected.delete(scene.id);
          card.classList.remove('selected');
        } else {
          selected.add(scene.id);
          card.classList.add('selected');
        }
        // Update continue button
        updateContinueButton(selected.size);
      });

      grid.appendChild(card);

      // Load AI image if available
      if (hasApiKey) {
        const cacheKey = 'scene_' + scene.id;
        getImage(cacheKey).then(cached => {
          if (cached) {
            updateSceneImage(scene.id, cached);
          } else {
            generateImageWithDallE(scene.imagePrompt).then(imgData => {
              if (imgData) {
                saveImage(cacheKey, imgData).catch(() => {});
                updateSceneImage(scene.id, imgData);
              }
            });
          }
        }).catch(() => {});
      }
    });

    wrapper.appendChild(grid);

    // Continue button
    const btnContainer = document.createElement('div');
    btnContainer.className = 'inspiration-actions';
    btnContainer.id = 'inspiration-continue-container';

    const continueBtn = document.createElement('button');
    continueBtn.className = 'btn btn-primary inspiration-continue-btn';
    continueBtn.id = 'inspiration-continue-btn';
    continueBtn.textContent = 'Select at least 1 scene to continue';
    continueBtn.disabled = true;

    continueBtn.addEventListener('click', () => {
      if (selected.size === 0) return;

      const state = data.plannerState;
      state.selectedScenes = Array.from(selected);
      saveData(data);

      // Show user's selection as a message
      const sceneNames = state.selectedScenes
        .map(sid => {
          const allScenes = inspirationScenes[state.partyType] || [];
          const s = allScenes.find(sc => sc.id === sid);
          return s ? s.name : sid;
        })
        .join(', ');
      addChatMessage('user', `I love these: ${sceneNames}`);

      // Disable further selection
      grid.querySelectorAll('.inspiration-card').forEach(c => {
        c.style.pointerEvents = 'none';
      });
      continueBtn.disabled = true;
      continueBtn.textContent = 'Generating recommendations...';

      // Generate products from selected scenes
      const items = generateProductsFromScenes(state);
      data.moodBoardItems = items;
      saveData(data);

      if (isLLMMode() && state.pendingToolId) {
        handleLLMSceneSelection(sceneNames, items);
      } else {
        state.stage = 'generate';
        saveData(data);
        advancePlanner();
      }
    });

    btnContainer.appendChild(continueBtn);
    wrapper.appendChild(btnContainer);

    chatMessages.appendChild(wrapper);
    scrollChatToBottom();
  }

  function updateContinueButton(count) {
    const btn = document.getElementById('inspiration-continue-btn');
    if (!btn) return;
    if (count > 0) {
      btn.disabled = false;
      btn.textContent = `Continue with ${count} scene${count > 1 ? 's' : ''} selected`;
    } else {
      btn.disabled = true;
      btn.textContent = 'Select at least 1 scene to continue';
    }
  }

  function updateSceneImage(sceneId, imageDataUrl) {
    const card = document.getElementById('inspiration-' + sceneId);
    if (!card) return;
    const visual = card.querySelector('.inspiration-visual');
    if (!visual) return;
    visual.innerHTML = '<img src="' + imageDataUrl + '" alt="Inspiration" loading="lazy">';
  }

  // ══════════════════════════════════════
  //  PRODUCT GENERATION FROM SCENES
  // ══════════════════════════════════════

  function generateProductsFromScenes(state) {
    // Use AI-generated scenes if available, otherwise fall back to hardcoded catalog
    const scenes = state.generatedScenes || inspirationScenes[state.partyType] || inspirationScenes.birthday;
    const selectedIds = state.selectedScenes || [];

    // Collect products from all selected scenes, dedupe by name
    const productMap = new Map();
    selectedIds.forEach(sceneId => {
      const scene = scenes.find(s => s.id === sceneId);
      if (!scene) return;
      scene.products.forEach(p => {
        if (!productMap.has(p.name)) {
          productMap.set(p.name, { ...p });
        }
      });
    });

    // Assign a retailer per item deterministically based on product name
    return Array.from(productMap.values()).map(p => {
      const storeIdx = Math.abs(hashString(p.name)) % storeNames.length;
      return {
        id: generateId(),
        name: p.name,
        price: p.price,
        store: storeNames[storeIdx],
        category: p.category,
      };
    });
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  // ── Background Image Generation ──

  async function generateImagesForItems(items, partyType, theme) {
    for (const item of items) {
      const cacheKey = 'img_' + item.id;
      const cached = await getImage(cacheKey).catch(() => null);
      if (cached) {
        updateCardImage('mood-item-' + item.id, cached);
        updateCardImage('moodboard-card-' + item.id, cached);
        continue;
      }
      const prompt = buildImagePrompt(item.name, partyType, theme);
      const imageData = await generateImageWithDallE(prompt);
      if (imageData) {
        await saveImage(cacheKey, imageData).catch(() => {});
        updateCardImage('mood-item-' + item.id, imageData);
        updateCardImage('moodboard-card-' + item.id, imageData);
      }
    }
  }

  function updateCardImage(cardId, imageDataUrl) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const visual = card.querySelector('.mood-item-visual, .moodboard-card-visual');
    if (!visual) return;
    visual.innerHTML = '<img src="' + imageDataUrl + '" alt="Mood board image" loading="lazy">';
  }

  // ── Chat Input Handling ──

  document.getElementById('chat-send-btn').addEventListener('click', handleChatSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  });

  function handleChatSend() {
    const text = chatInput.value.trim();
    const hasImages = pendingChatImages.length > 0;
    if (!text && !hasImages) return;
    chatInput.value = '';

    // Show user message with image thumbnails if any
    if (hasImages) {
      addChatMessageWithImages(text, pendingChatImages);
    } else {
      addChatMessage('user', text);
    }

    if (isLLMMode() && data.plannerState && data.plannerState.apiMessages) {
      // Build content blocks: images first, then text
      const contentBlocks = [];

      for (const img of pendingChatImages) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64,
          },
        });
      }

      if (text) {
        contentBlocks.push({ type: 'text', text: text });
      } else if (hasImages) {
        contentBlocks.push({ type: 'text', text: `I've uploaded ${pendingChatImages.length} inspiration image(s). Please analyze them and help me plan my party based on what you see.` });
      }

      data.plannerState.apiMessages.push({ role: 'user', content: contentBlocks });

      // Clear pending images
      pendingChatImages = [];
      renderChatImagePreview();

      saveData(data);
      sendToLLM();
    } else {
      pendingChatImages = [];
      renderChatImagePreview();
      processUserInput(text);
    }
  }

  function addChatMessageWithImages(text, images) {
    data.chatHistory.push({ role: 'user', text: text || `[${images.length} image(s) uploaded]` });
    saveData(data);

    const msg = document.createElement('div');
    msg.className = 'chat-message user';

    if (images.length > 0) {
      const thumbsDiv = document.createElement('div');
      thumbsDiv.className = 'chat-msg-thumbs';
      images.forEach(img => {
        const thumb = document.createElement('img');
        thumb.src = img.dataUrl;
        thumb.className = 'chat-msg-thumb';
        thumb.alt = 'Uploaded image';
        thumbsDiv.appendChild(thumb);
      });
      msg.appendChild(thumbsDiv);
    }

    if (text) {
      const textEl = document.createElement('div');
      textEl.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
      msg.appendChild(textEl);
    }

    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  // ── Intent Detection ──
  // Understands what the user is saying regardless of current stage.

  function detectIntent(text) {
    const lower = text.toLowerCase().trim();

    // Detect explicit party type mention → user wants to change/set theme
    const typeKeywords = {
      birthday: ['birthday', 'bday', 'b-day'],
      wedding: ['wedding', 'bridal'],
      babyshower: ['baby shower', 'babyshower'],
      graduation: ['graduation', 'grad party', 'commencement'],
      retirement: ['retirement', 'retiring'],
      holiday: ['holiday', 'christmas', 'halloween', 'thanksgiving', 'new year'],
      dinner: ['dinner party', 'dinner gathering', 'supper'],
      anniversary: ['anniversary'],
    };

    // Detect correction / "go back" intent
    if (/\b(change|switch|go back|redo|actually|instead|wait|no i meant|i meant)\b/.test(lower)) {
      // Check if they're changing the party type specifically
      for (const [type, kws] of Object.entries(typeKeywords)) {
        if (kws.some(k => lower.includes(k))) {
          return { intent: 'switch-party-type', partyType: type, raw: text };
        }
      }
      // Check if changing theme
      if (/theme|style|vibe|look/.test(lower)) {
        return { intent: 'change-theme', raw: text };
      }
      // Check if changing guest count
      if (/guests?|people|headcount/.test(lower)) {
        const num = parseInt((lower.match(/(\d+)/) || [])[1], 10);
        return { intent: 'set-guests', count: num || null, raw: text };
      }
      // Check if changing budget
      if (/budget|spend|cost|price/.test(lower)) {
        const amt = parseFloat((lower.match(/[\$]?\s*([\d,]+\.?\d*)/) || [])[1]);
        return { intent: 'set-budget', amount: amt || null, raw: text };
      }
      // Generic correction — re-ask current question
      return { intent: 'correction', raw: text };
    }

    // Detect guest count anywhere (e.g. "30 people", "expecting 50 guests")
    const guestMatch = lower.match(/(\d+)\s*(people|guests?|persons?|folks|attendees?|friends|family)/);
    if (guestMatch) {
      return { intent: 'set-guests', count: parseInt(guestMatch[1], 10), raw: text };
    }

    // Detect budget anywhere (e.g. "$500", "budget is 1000", "spend about 300")
    if (/budget|spend|afford|cost/.test(lower)) {
      const amt = parseFloat((lower.match(/[\$]?\s*([\d,]+\.?\d*)/) || [])[1]);
      if (amt > 0) return { intent: 'set-budget', amount: amt, raw: text };
    }

    // Detect DIY preference
    if (/\b(diy|do it myself|doing it myself|on my own|by myself)\b/.test(lower)) {
      return { intent: 'set-diy', isDIY: true, raw: text };
    }
    if (/\b(coordinator|planner|professional|hired help|event planner)\b/.test(lower)) {
      return { intent: 'set-diy', isDIY: false, raw: text };
    }

    // Detect "more options" / "show different"
    if (/\b(more|different|other|another|regenerate|again|redo)\b/.test(lower) && /\b(option|scene|inspiration|look|idea|style|choice)\b/.test(lower)) {
      return { intent: 'more-options', raw: text };
    }

    // Detect "start over"
    if (/\b(start over|restart|begin again|new plan)\b/.test(lower)) {
      return { intent: 'restart', raw: text };
    }

    // Check for a party type mention without a correction keyword
    for (const [type, kws] of Object.entries(typeKeywords)) {
      if (kws.some(k => lower.includes(k))) {
        return { intent: 'set-theme-type', partyType: type, raw: text };
      }
    }

    // Default — treat as a direct answer to whatever the agent last asked
    return { intent: 'answer', raw: text };
  }

  function processUserInput(text) {
    const state = data.plannerState;
    if (!state) return;

    const intent = detectIntent(text);

    // ── Handle intents that work regardless of current stage ──

    if (intent.intent === 'restart') {
      showTypingThen(() => {
        addAssistantMessage("No problem! Let's start fresh. What kind of party are you planning?");
      });
      state.stage = 'ask-theme';
      state.theme = '';
      state.guestCount = null;
      state.budget = null;
      state.isDIY = null;
      state.selectedScenes = [];
      saveData(data);
      return;
    }

    if (intent.intent === 'switch-party-type') {
      const oldType = state.partyType;
      state.partyType = intent.partyType;
      state.theme = text;
      state.selectedScenes = [];
      // Keep answers the user already gave, just move forward
      if (!state.guestCount) {
        state.stage = 'ask-guests';
      } else if (!state.budget) {
        state.stage = 'ask-budget';
      } else if (state.isDIY === null) {
        state.stage = 'ask-diy';
      } else {
        state.stage = 'show-inspiration';
      }
      saveData(data);
      const label = partyTypeLabels[intent.partyType] || 'party';
      showTypingThen(() => {
        addAssistantMessage(`Got it — switching to a ${label}!`);
        setTimeout(() => advancePlanner(), 400);
      });
      return;
    }

    if (intent.intent === 'change-theme') {
      state.stage = 'ask-theme';
      state.selectedScenes = [];
      saveData(data);
      showTypingThen(() => {
        addAssistantMessage("Sure! What theme or style would you prefer instead?", [
          { text: 'Elegant & Classic', value: 'elegant and classic theme' },
          { text: 'Rustic & Natural', value: 'rustic and natural theme' },
          { text: 'Fun & Colorful', value: 'fun and colorful theme' },
          { text: 'Minimalist & Modern', value: 'minimalist and modern theme' },
        ]);
      });
      return;
    }

    if (intent.intent === 'correction') {
      // User said "actually…" / "wait" without a clear new value — re-ask current question
      showTypingThen(() => {
        addAssistantMessage("No worries! What would you like to change? You can update the theme, guest count, budget, or anything else.");
      });
      return;
    }

    if (intent.intent === 'set-guests' && intent.count && intent.count > 0) {
      state.guestCount = intent.count;
      saveData(data);
      if (state.stage === 'ask-guests' || state.stage === 'ask-theme') {
        state.stage = state.budget ? (state.isDIY !== null ? 'show-inspiration' : 'ask-diy') : 'ask-budget';
        saveData(data);
      }
      showTypingThen(() => {
        addAssistantMessage(`Got it — planning for ${state.guestCount} guests!`);
        setTimeout(() => advancePlanner(), 400);
      });
      return;
    }

    if (intent.intent === 'set-budget' && intent.amount && intent.amount > 0) {
      state.budget = intent.amount;
      saveData(data);
      if (state.stage === 'ask-budget' || state.stage === 'ask-guests') {
        state.stage = state.isDIY !== null ? 'show-inspiration' : 'ask-diy';
        saveData(data);
      }
      showTypingThen(() => {
        addAssistantMessage(`Budget set to ${formatCurrency(state.budget)}!`);
        setTimeout(() => advancePlanner(), 400);
      });
      return;
    }

    if (intent.intent === 'set-diy') {
      state.isDIY = intent.isDIY;
      if (state.stage === 'ask-diy') {
        state.stage = 'show-inspiration';
      }
      saveData(data);
      advancePlanner();
      return;
    }

    if (intent.intent === 'more-options') {
      state.stage = 'show-inspiration';
      state.selectedScenes = [];
      saveData(data);
      advancePlanner();
      return;
    }

    // ── Default: treat as answer to the current stage's question ──
    handleStageAnswer(text);
  }

  function handleStageAnswer(text) {
    const state = data.plannerState;

    switch (state.stage) {
      case 'ask-theme': {
        state.theme = text;
        const detected = detectPartyType(text);
        if (detected) state.partyType = detected;
        state.stage = 'ask-guests';
        saveData(data);
        advancePlanner();
        break;
      }
      case 'ask-guests': {
        const num = parseInt(text.replace(/[^0-9]/g, ''), 10);
        state.guestCount = num > 0 ? num : 30;
        state.stage = 'ask-budget';
        saveData(data);
        advancePlanner();
        break;
      }
      case 'ask-budget': {
        const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
        state.budget = amount > 0 ? amount : 500;
        state.stage = 'ask-diy';
        saveData(data);
        advancePlanner();
        break;
      }
      case 'ask-diy': {
        const lower = text.toLowerCase();
        state.isDIY = lower.includes('diy') || lower.includes('myself') || lower.includes('own');
        state.stage = 'show-inspiration';
        saveData(data);
        advancePlanner();
        break;
      }
      case 'show-inspiration': {
        showTypingThen(() => {
          addAssistantMessage(
            'Tap on the scene images above that you love, then click the "Continue" button!'
          );
        });
        break;
      }
      case 'complete': {
        showTypingThen(() => {
          addAssistantMessage(
            'Your recommendations are ready! Say "show me more options" to browse different inspiration, or check your Party Bucket.',
            [
              { text: 'More options', value: 'show me different options' },
              { text: 'View Party Bucket', value: '__toggle_bucket__' },
            ]
          );
        });
        break;
      }
    }
  }

  // ── Chat Message Rendering ──

  function addChatMessage(role, text) {
    data.chatHistory.push({ role, text });
    saveData(data);

    const msg = document.createElement('div');
    msg.className = `chat-message ${role}`;
    msg.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  function addAssistantMessage(text, suggestions) {
    data.chatHistory.push({ role: 'assistant', text });
    saveData(data);

    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.innerHTML = text.replace(/\n/g, '<br>');

    if (suggestions && suggestions.length > 0) {
      const sugDiv = document.createElement('div');
      sugDiv.className = 'chat-suggestions';
      suggestions.forEach(sug => {
        const btn = document.createElement('button');
        btn.className = 'chat-suggestion-btn';
        btn.textContent = sug.text;
        btn.addEventListener('click', () => {
          if (sug.value === '__toggle_bucket__') {
            toggleBucketPanel();
          } else {
            chatInput.value = sug.value;
            handleChatSend();
          }
        });
        sugDiv.appendChild(btn);
      });
      msg.appendChild(sugDiv);
    }

    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  function addAssistantMessageWithMoodBoard(text, items) {
    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.style.maxWidth = '100%';
    if (text) {
      msg.innerHTML = text.replace(/\n/g, '<br>');
    }

    const grid = document.createElement('div');
    grid.className = 'chat-mood-grid';

    items.forEach(item => {
      grid.appendChild(createMoodItemCard(item));
    });

    msg.appendChild(grid);
    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  function createMoodItemCard(item) {
    const card = document.createElement('div');
    card.className = 'mood-item' + (isInBucket(item.id) ? ' in-bucket' : '');
    card.id = 'mood-item-' + item.id;

    const storeUrl = getStoreUrl(item.name, item.store);
    const hasApiKey = !!getApiKey();
    const catStyle = getCategoryStyle(item.category);

    let visualContent;
    if (hasApiKey) {
      visualContent = `<div class="mood-item-visual"><div class="img-loading"><div class="spinner"></div><span>Loading...</span></div></div>`;
    } else {
      visualContent = `<div class="mood-item-visual" style="background: ${catStyle.gradient}"><span class="mood-item-cat-label">${escapeHtml(catStyle.label)}</span></div>`;
    }

    card.innerHTML = `
      ${visualContent}
      <div class="mood-item-info">
        <span class="mood-item-name">${escapeHtml(item.name)}</span>
        <span class="mood-item-price">${formatCurrency(item.price)}</span>
        <span class="mood-item-store">at ${escapeHtml(item.store)}</span>
      </div>
      <div class="mood-item-actions">
        <button class="btn ${isInBucket(item.id) ? 'btn-in-bucket' : 'btn-add-bucket'}" data-item-id="${item.id}">
          ${isInBucket(item.id) ? 'In Bucket' : 'Add to Bucket'}
        </button>
        <a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener" class="btn-view-store">View on ${escapeHtml(item.store)}</a>
      </div>
    `;

    card.querySelector('[data-item-id]').addEventListener('click', () => {
      toggleBucketItem(item);
    });

    const cacheKey = 'img_' + item.id;
    getImage(cacheKey).then(cached => {
      if (cached) {
        updateCardImage('mood-item-' + item.id, cached);
      }
    }).catch(() => {});

    return card;
  }

  function showTypingThen(callback, delay) {
    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(msg);
    scrollChatToBottom();

    setTimeout(() => {
      msg.remove();
      callback();
    }, delay || 800);
  }

  function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Restart Planner ──

  document.getElementById('planner-restart-btn').addEventListener('click', () => {
    data.plannerState = null;
    data.chatHistory = [];
    saveData(data);
    plannerChat.classList.add('hidden');
    plannerLanding.classList.remove('hidden');
    plannerInput.value = '';
  });

  // ── Restore Chat on Load ──

  function restorePlannerState() {
    if (data.plannerState && data.chatHistory.length > 0) {
      plannerLanding.classList.add('hidden');
      plannerChat.classList.remove('hidden');
      const label = partyTypeLabels[data.plannerState.partyType] || 'Party';
      document.getElementById('planner-party-title').textContent = label + ' Planner';
      chatMessages.innerHTML = '';

      data.chatHistory.forEach(msg => {
        const el = document.createElement('div');
        el.className = `chat-message ${msg.role}`;
        el.innerHTML = escapeHtml(msg.text).replace(/\n/g, '<br>');
        chatMessages.appendChild(el);
      });

      // If in inspiration stage, re-render the grid
      if (data.plannerState.stage === 'show-inspiration') {
        const scenes = inspirationScenes[data.plannerState.partyType] || inspirationScenes.birthday;
        addInspirationGrid(scenes);
      }

      // If complete and mood board items exist, re-render
      if (data.plannerState.stage === 'complete' && data.moodBoardItems.length > 0) {
        const grid = document.createElement('div');
        grid.className = 'chat-mood-grid';
        grid.style.marginTop = '1rem';
        data.moodBoardItems.forEach(item => {
          grid.appendChild(createMoodItemCard(item));
        });
        chatMessages.appendChild(grid);
      }

      scrollChatToBottom();
    }
  }

  // ══════════════════════════════════════
  //  STORE URLS & HELPERS
  // ══════════════════════════════════════

  const storeNames = ['Amazon', 'Walmart', 'Target'];

  function getStoreUrl(productName, store) {
    const q = encodeURIComponent(productName);
    switch (store) {
      case 'Amazon': return 'https://www.amazon.com/s?k=' + q;
      case 'Walmart': return 'https://www.walmart.com/search?q=' + q;
      case 'Target': return 'https://www.target.com/s?searchTerm=' + q;
      default: return 'https://www.amazon.com/s?k=' + q;
    }
  }

  // ══════════════════════════════════════
  //  PARTY BUCKET
  // ══════════════════════════════════════

  function isInBucket(itemId) {
    return data.partyBucket.some(b => b.id === itemId);
  }

  function toggleBucketItem(item) {
    if (isInBucket(item.id)) {
      data.partyBucket = data.partyBucket.filter(b => b.id !== item.id);
    } else {
      data.partyBucket.push({ ...item, quantity: item.quantity || 1 });
    }
    saveData(data);
    updateBucketUI();
    refreshMoodItemCards();
  }

  function removeBucketItem(itemId) {
    data.partyBucket = data.partyBucket.filter(b => b.id !== itemId);
    saveData(data);
    updateBucketUI();
    refreshMoodItemCards();
  }

  function updateBucketUI() {
    const count = data.partyBucket.length;
    document.getElementById('bucket-count-header').textContent = count;

    const bucketItemsEl = document.getElementById('bucket-items');
    const total = getBucketTotal();
    document.getElementById('bucket-total-price').textContent = formatCurrency(total);

    // Update checkout button
    const checkoutBtn = document.getElementById('bucket-checkout-btn');
    if (checkoutBtn) {
      checkoutBtn.textContent = count > 0 ? `Checkout — ${formatCurrency(total)}` : 'Checkout';
      checkoutBtn.disabled = count === 0;
    }

    if (count === 0) {
      bucketItemsEl.innerHTML = '<div class="bucket-empty">Your party bucket is empty. Add items from the shopping list!</div>';
      return;
    }

    bucketItemsEl.innerHTML = data.partyBucket.map(item => {
      const catStyle = getCategoryStyle(item.category);
      const qty = item.quantity || 1;
      const lineTotal = item.price * qty;
      return `
        <div class="bucket-item">
          <div class="bucket-item-swatch" style="background: ${catStyle.gradient}"></div>
          <div class="bucket-item-info">
            <span class="bucket-item-name">${escapeHtml(item.name)}</span>
            <span class="bucket-item-price">${formatCurrency(lineTotal)} <span class="bucket-item-store-tag">via ${escapeHtml(item.store)}</span></span>
            <div class="bucket-qty-controls">
              <button class="bucket-qty-btn" onclick="app.changeQuantity('${item.id}', -1)">-</button>
              <span class="bucket-qty-value">${qty}</span>
              <button class="bucket-qty-btn" onclick="app.changeQuantity('${item.id}', 1)">+</button>
            </div>
          </div>
          <button class="bucket-item-remove" onclick="app.removeBucketItem('${item.id}')">&times;</button>
        </div>
      `;
    }).join('');
  }

  function changeQuantity(itemId, delta) {
    const item = data.partyBucket.find(b => b.id === itemId);
    if (!item) return;
    const newQty = (item.quantity || 1) + delta;
    if (newQty < 1) {
      removeBucketItem(itemId);
      return;
    }
    item.quantity = newQty;
    saveData(data);
    updateBucketUI();
  }

  // ── Unified Checkout ──

  function initCheckout() {
    const checkoutBtn = document.getElementById('bucket-checkout-btn');
    const checkoutPanel = document.getElementById('checkout-panel');
    const checkoutForm = document.getElementById('checkout-form');
    const backBtn = document.getElementById('checkout-back-btn');

    if (!checkoutBtn) return;

    checkoutBtn.addEventListener('click', () => {
      if (data.partyBucket.length === 0) return;
      document.getElementById('bucket-items').classList.add('hidden');
      document.getElementById('bucket-footer').classList.add('hidden');
      checkoutPanel.classList.remove('hidden');
      renderCheckoutSummary();
    });

    backBtn.addEventListener('click', () => {
      checkoutPanel.classList.add('hidden');
      document.getElementById('bucket-items').classList.remove('hidden');
      document.getElementById('bucket-footer').classList.remove('hidden');
    });

    checkoutForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = {
        name: document.getElementById('checkout-name').value.trim(),
        email: document.getElementById('checkout-email').value.trim(),
        address: document.getElementById('checkout-address').value.trim(),
        card: document.getElementById('checkout-card').value.trim(),
        expiry: document.getElementById('checkout-expiry').value.trim(),
        cvv: document.getElementById('checkout-cvv').value.trim(),
      };

      // Simulate order placement
      checkoutPanel.innerHTML = `
        <div class="checkout-success">
          <div class="checkout-success-icon">&#x2714;</div>
          <h4>Order Placed!</h4>
          <p>Your party supplies are on the way to <strong>${escapeHtml(formData.name)}</strong>.</p>
          <p class="checkout-success-detail">Confirmation sent to <strong>${escapeHtml(formData.email)}</strong></p>
          <p class="checkout-success-detail">${data.partyBucket.length} items — ${formatCurrency(getBucketTotal())}</p>
          <button class="btn btn-primary" id="checkout-done-btn">Done</button>
        </div>
      `;
      document.getElementById('checkout-done-btn').addEventListener('click', () => {
        data.partyBucket = [];
        saveData(data);
        updateBucketUI();
        checkoutPanel.classList.add('hidden');
        checkoutPanel.innerHTML = '';
        document.getElementById('bucket-items').classList.remove('hidden');
        document.getElementById('bucket-footer').classList.remove('hidden');
        toggleBucketPanel();
      });
    });
  }

  function renderCheckoutSummary() {
    const el = document.getElementById('checkout-summary');
    if (!el) return;
    const total = getBucketTotal();
    el.innerHTML = `
      <div class="checkout-summary-items">
        ${data.partyBucket.map(item => {
          const qty = item.quantity || 1;
          return `
          <div class="checkout-line-item">
            <span>${escapeHtml(item.name)}${qty > 1 ? ` x${qty}` : ''}</span>
            <span>${formatCurrency(item.price * qty)}</span>
          </div>
        `}).join('')}
      </div>
      <div class="checkout-summary-total">
        <strong>Total</strong>
        <strong>${formatCurrency(total)}</strong>
      </div>
    `;
  }

  function refreshMoodItemCards() {
    document.querySelectorAll('.mood-item').forEach(card => {
      const idAttr = card.id;
      if (!idAttr) return;
      const itemId = idAttr.replace('mood-item-', '');
      const btn = card.querySelector('[data-item-id]');
      if (!btn) return;
      if (isInBucket(itemId)) {
        card.classList.add('in-bucket');
        btn.className = 'btn btn-in-bucket';
        btn.textContent = 'In Bucket';
      } else {
        card.classList.remove('in-bucket');
        btn.className = 'btn btn-add-bucket';
        btn.textContent = 'Add to Bucket';
      }
    });
  }

  function toggleBucketPanel() {
    const panel = document.getElementById('party-bucket-panel');
    panel.classList.toggle('hidden');
    updateBucketUI();
  }

  document.getElementById('toggle-bucket-btn').addEventListener('click', toggleBucketPanel);
  document.getElementById('close-bucket-btn').addEventListener('click', () => {
    document.getElementById('party-bucket-panel').classList.add('hidden');
  });

  // ══════════════════════════════════════
  //  RENDER ALL & INIT
  // ══════════════════════════════════════

  function renderAll() {
    updateBucketUI();
    initCheckout();
    restorePlannerState();
  }

  window.app = {
    removeBucketItem,
    changeQuantity,
  };

  openDB().catch(() => console.warn('IndexedDB unavailable'));
  renderAll();
})();
