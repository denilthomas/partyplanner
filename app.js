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
      uploadedImages: [], // { id, name, timestamp }
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

  // ── Settings (API Key) ──

  function getApiKey() {
    return localStorage.getItem('partyplanner_openai_key') || '';
  }

  function saveApiKey(key) {
    if (key) {
      localStorage.setItem('partyplanner_openai_key', key);
    } else {
      localStorage.removeItem('partyplanner_openai_key');
    }
  }

  // Settings modal wiring
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

  // ── Tab Navigation ──

  const navButtons = document.querySelectorAll('.nav-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      navButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(target).classList.add('active');
      if (target === 'moodboard') renderMoodBoard();
    });
  });

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

  // Build a descriptive prompt for party decor images
  function buildImagePrompt(itemName, partyType, theme) {
    const typeLabel = partyTypeLabels[partyType] || 'party';
    const themeDesc = theme ? ` with a "${theme}" theme` : '';
    return `Professional product photography of ${itemName} for a ${typeLabel}${themeDesc}. Clean white background, high quality, styled beautifully for a party supply catalog. No text or watermarks.`;
  }

  // ══════════════════════════════════════
  //  PRE-CURATED THEME IMAGES
  // ══════════════════════════════════════

  // Curated image descriptions for AI generation, keyed by partyType
  // These serve as the "pre-curated catalog" - when an API key is present,
  // images are generated on demand and cached in IndexedDB
  const curatedImagePrompts = {
    birthday: {
      decorations: 'Colorful birthday party table setup with balloons, streamers, and confetti, festive atmosphere',
      tableware: 'Beautiful birthday party table setting with themed plates, cups, and napkins arranged elegantly',
      favors: 'Cute birthday party favor bags filled with treats and small toys, wrapped with ribbons',
      baking: 'Decorated birthday cupcakes and cake with frosting and sprinkles on a party table',
      entertainment: 'Fun photo booth props for birthday party including hats, glasses, and signs',
      accessories: 'Sparkly birthday party accessories including crowns, hats, and tiaras on display',
    },
    wedding: {
      decorations: 'Elegant wedding reception table with white flowers, candles, and gold accents',
      stationery: 'Beautiful calligraphy wedding place cards and invitations with floral details',
      tableware: 'Crystal champagne flutes and fine china on a wedding reception table',
      favors: 'Elegant wedding favor boxes with ribbons and flowers arranged on a white table',
      accessories: 'Wedding cake cutting set with silver handles and crystal details',
      entertainment: 'Wedding bubble tubes and sparklers arranged in a decorative display',
    },
    babyshower: {
      decorations: 'Pastel baby shower decorations with balloons, banner, and stuffed animals',
      tableware: 'Adorable baby shower table setting with themed plates and cups in soft colors',
      entertainment: 'Baby shower game cards and activity stations set up on decorated table',
      favors: 'Sweet baby shower favor bags with tiny baby items and thank you tags',
      baking: 'Baby-themed cupcakes with booties, rattles, and onesie decorations on top',
      accessories: 'Mommy-to-be sash and tiara set in pink or blue with sparkle details',
      stationery: 'Baby shower advice cards and wishes cards with cute illustrations',
    },
    graduation: {
      decorations: 'Graduation party decorations with cap-shaped balloons and congratulations banner',
      tableware: 'Graduation party table with themed plates and cups in school colors',
      favors: 'Graduation party favor boxes with diploma roll decorations and treats inside',
      stationery: 'Graduation guest signing board with space for well-wishes and photos',
      entertainment: 'Graduation photo display with pictures from kindergarten through senior year',
    },
    retirement: {
      decorations: 'Elegant retirement party decorations with gold and black balloons and banner',
      tableware: 'Sophisticated retirement party table setting with gold-rimmed plates and cups',
      stationery: 'Retirement memory book and guestbook with gold pen on decorated table',
      favors: 'Retirement party favor bags with gold tissue paper and thank you tags',
    },
    holiday: {
      decorations: 'Festive holiday party table with garland, ornaments, and twinkling lights',
      tableware: 'Holiday themed plates, cups, and napkins with seasonal patterns and colors',
      baking: 'Holiday cookie decorating station with various shapes, icing, and sprinkles',
      favors: 'Holiday party favor tins filled with homemade treats and tied with ribbon',
    },
    dinner: {
      decorations: 'Sophisticated dinner party centerpiece with candles, flowers, and greenery',
      tableware: 'Elegant dinner party place setting with charger plates, wine glasses, and linen napkins',
      stationery: 'Handwritten dinner party menu cards and place cards with calligraphy',
      accessories: 'Cocktail stirrers and drink garnishes arranged beautifully on a bar cart',
    },
    anniversary: {
      decorations: 'Romantic anniversary party setup with rose petals, fairy lights, and candles',
      tableware: 'Anniversary celebration table with champagne flutes and gold-rimmed plates',
      stationery: 'Anniversary photo timeline display with pictures from throughout the years',
      favors: 'Romantic anniversary favor boxes with hearts and gold ribbon accents',
    },
  };

  // Generate or retrieve a cached image for a mood board item
  async function getItemImage(item, partyType, theme) {
    const cacheKey = 'img_' + item.id;

    // Check IndexedDB cache first
    const cached = await getImage(cacheKey).catch(() => null);
    if (cached) return cached;

    // No API key = no generation
    const apiKey = getApiKey();
    if (!apiKey) return null;

    // Build prompt from curated templates or item name
    const categoryPrompts = curatedImagePrompts[partyType] || {};
    let prompt;
    if (categoryPrompts[item.category]) {
      const themeDesc = theme ? `, ${theme} style` : '';
      prompt = categoryPrompts[item.category] + themeDesc + '. Professional product photo, no text.';
    } else {
      prompt = buildImagePrompt(item.name, partyType, theme);
    }

    const imageData = await generateImageWithDallE(prompt);
    if (imageData) {
      await saveImage(cacheKey, imageData).catch(() => {});
      return imageData;
    }
    return null;
  }

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

  // Planner state machine stages:
  // 'ask-theme' → 'ask-guests' → 'ask-budget' → 'ask-diy' → 'generate' → 'complete'

  function initPlannerState(partyType, userPrompt) {
    return {
      partyType: partyType || 'other',
      theme: userPrompt || '',
      guestCount: null,
      budget: null,
      isDIY: null,
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

  // Quick pick buttons
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
    return 'birthday'; // default
  }

  function startPlanner(partyType, userPrompt) {
    data.plannerState = initPlannerState(partyType, userPrompt);
    data.chatHistory = [];
    data.moodBoardItems = [];
    saveData(data);

    plannerLanding.classList.add('hidden');
    plannerChat.classList.remove('hidden');

    const label = partyTypeLabels[partyType] || 'Party';
    document.getElementById('planner-party-title').textContent = label + ' Planner';

    chatMessages.innerHTML = '';

    if (userPrompt) {
      addChatMessage('user', userPrompt);
    }

    // Start the conversation flow
    advancePlanner();
  }

  function advancePlanner() {
    const state = data.plannerState;
    if (!state) return;

    switch (state.stage) {
      case 'ask-theme': {
        const label = partyTypeLabels[state.partyType] || 'party';
        showTypingThen(() => {
          addAssistantMessage(
            `Great choice! Let's plan an amazing ${label}! \n\nWhat theme or style do you have in mind? For example, you could describe a color scheme, a character theme, or a vibe like "rustic" or "elegant".`,
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
            `${themeDesc}Now, how many people are you expecting at the event? This will help me suggest the right quantities for supplies.`,
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
            `Got it, planning for about ${state.guestCount} guests! What's your approximate budget for the event?`,
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
            `Budget of ${formatCurrency(state.budget)} \u2014 I'll make sure to find options that fit! One last question: Are you doing this DIY style, or do you have an event coordinator helping out?`,
            [
              { text: 'DIY \u2014 I\'m doing it myself!', value: 'DIY' },
              { text: 'I have a coordinator', value: 'coordinator' },
            ]
          );
        });
        break;
      }
      case 'generate': {
        showTypingThen(() => {
          const items = generateMoodBoardItems(state);
          data.moodBoardItems = items;
          saveData(data);

          const hasApiKey = !!getApiKey();
          let summary = buildSummaryMessage(state);
          if (hasApiKey) {
            summary += '\n\nGenerating mood board images for your theme...';
          }

          addAssistantMessageWithMoodBoard(summary, items);

          state.stage = 'complete';
          saveData(data);

          // If API key available, generate images in background
          if (hasApiKey) {
            generateImagesForItems(items, state.partyType, state.theme);
          }
        }, 1500);
        break;
      }
      case 'complete': {
        // Already complete, user can keep chatting for more suggestions
        break;
      }
    }
  }

  function buildSummaryMessage(state) {
    const label = partyTypeLabels[state.partyType] || 'Party';
    const diyLabel = state.isDIY ? 'DIY' : 'with a coordinator';
    return `Here's your curated ${label} mood board! I picked items that match your "${escapeHtml(state.theme || 'classic')}" theme for ${state.guestCount} guests within a ${formatCurrency(state.budget)} budget (${diyLabel}).\n\nClick "Add to Bucket" on any item you like \u2014 it'll be saved to your Party Bucket with direct shopping links. You can also check the Mood Board tab for a full-screen view!`;
  }

  // ── Background Image Generation ──

  async function generateImagesForItems(items, partyType, theme) {
    // Generate images one at a time to avoid rate limits
    for (const item of items) {
      const imageData = await getItemImage(item, partyType, theme);
      if (imageData) {
        // Update the card in the chat if it exists
        updateCardImage('mood-item-' + item.id, imageData);
        // Also update mood board tab card if visible
        updateCardImage('moodboard-card-' + item.id, imageData);
      }
    }
  }

  function updateCardImage(cardId, imageDataUrl) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const visual = card.querySelector('.mood-item-visual, .moodboard-card-visual');
    if (!visual) return;
    // Replace emoji/loading with the image
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
    if (!text) return;
    chatInput.value = '';
    addChatMessage('user', text);
    processUserInput(text);
  }

  function processUserInput(text) {
    const state = data.plannerState;
    if (!state) return;

    switch (state.stage) {
      case 'ask-theme': {
        state.theme = text;
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
        state.stage = 'generate';
        saveData(data);
        advancePlanner();
        break;
      }
      case 'complete': {
        // Allow follow-up: regenerate or answer questions
        showTypingThen(() => {
          if (text.toLowerCase().includes('more') || text.toLowerCase().includes('different') || text.toLowerCase().includes('regenerate')) {
            const items = generateMoodBoardItems(state);
            data.moodBoardItems = [...data.moodBoardItems, ...items];
            saveData(data);
            addAssistantMessageWithMoodBoard(
              'Here are some more options for your party! Pick the ones you like:',
              items
            );
            // Generate images for new items too
            if (getApiKey()) {
              generateImagesForItems(items, state.partyType, state.theme);
            }
          } else {
            addAssistantMessage(
              'Your mood board is ready above! You can say "show me more options" to see additional items, or browse your Party Bucket to review what you\'ve picked. You can also explore the Mood Board and Budget Tracker tabs for more features.',
              [
                { text: 'Show me more options', value: 'show me more different options' },
                { text: 'View Party Bucket', value: '__toggle_bucket__' },
              ]
            );
          }
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
    msg.innerHTML = text.replace(/\n/g, '<br>');

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

    // Show loading state if API key available, otherwise emoji
    let visualContent;
    if (hasApiKey) {
      visualContent = '<div class="img-loading"><div class="spinner"></div><span>Generating...</span></div>';
    } else {
      visualContent = item.emoji;
    }

    card.innerHTML = `
      <div class="mood-item-visual">${visualContent}</div>
      <div class="mood-item-info">
        <span class="mood-item-name">${escapeHtml(item.name)}</span>
        <span class="mood-item-price">${formatCurrency(item.price)}</span>
        <span class="mood-item-store">at ${escapeHtml(item.store)}</span>
      </div>
      <div class="mood-item-actions">
        <button class="btn ${isInBucket(item.id) ? 'btn-in-bucket' : 'btn-add-bucket'}" data-item-id="${item.id}">
          ${isInBucket(item.id) ? 'In Bucket' : 'Add to Bucket'}
        </button>
        <a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener" class="btn-view-store">Shop</a>
      </div>
    `;

    card.querySelector('[data-item-id]').addEventListener('click', () => {
      toggleBucketItem(item);
    });

    // Check IndexedDB for cached image
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

      // Replay chat history
      data.chatHistory.forEach(msg => {
        const el = document.createElement('div');
        el.className = `chat-message ${msg.role}`;
        el.innerHTML = escapeHtml(msg.text).replace(/\n/g, '<br>');
        chatMessages.appendChild(el);
      });

      // If mood board items exist and we're complete, re-render them
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
  //  PRODUCT / MOOD BOARD GENERATION
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

  function randomStore() {
    return storeNames[Math.floor(Math.random() * storeNames.length)];
  }

  function generateMoodBoardItems(state) {
    const type = state.partyType;
    const theme = (state.theme || '').toLowerCase();
    const guests = state.guestCount || 30;
    const budget = state.budget || 500;

    const catalog = getProductCatalog(type, theme, guests);

    // Select a subset based on budget - pick 8-12 items
    const count = Math.min(catalog.length, Math.floor(Math.random() * 5) + 8);
    const shuffled = catalog.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);

    // Scale prices based on budget
    const totalRaw = selected.reduce((s, item) => s + item.price, 0);
    const scale = totalRaw > 0 ? (budget * 0.7) / totalRaw : 1;

    return selected.map(item => ({
      id: generateId(),
      name: item.name,
      emoji: item.emoji,
      price: Math.max(2.99, Math.round(item.price * scale * 100) / 100),
      store: randomStore(),
      category: item.category,
    }));
  }

  function getProductCatalog(type, theme, guests) {
    const themeAdj = extractThemeAdjective(theme);
    const sizeLabel = guests > 50 ? 'Set of 100' : guests > 20 ? 'Set of 50' : 'Set of 25';
    const smallSet = guests > 50 ? 'Pack of 24' : 'Pack of 12';

    const baseCatalog = {
      birthday: [
        { name: `${themeAdj} Birthday Banner`, emoji: '\u{1F389}', price: 12.99, category: 'decorations' },
        { name: `${themeAdj} Party Balloons ${smallSet}`, emoji: '\u{1F388}', price: 8.99, category: 'decorations' },
        { name: `${themeAdj} Paper Plates ${sizeLabel}`, emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
        { name: `${themeAdj} Paper Cups ${sizeLabel}`, emoji: '\u{1F964}', price: 11.99, category: 'tableware' },
        { name: `${themeAdj} Napkins ${sizeLabel}`, emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
        { name: `${themeAdj} Party Tablecloth Pack of 3`, emoji: '\u{1F3A8}', price: 15.99, category: 'decorations' },
        { name: `${themeAdj} Cake Topper`, emoji: '\u{1F382}', price: 7.99, category: 'decorations' },
        { name: `${themeAdj} Party Favor Bags ${smallSet}`, emoji: '\u{1F381}', price: 13.99, category: 'favors' },
        { name: `${themeAdj} Centerpiece Decoration`, emoji: '\u{1F490}', price: 18.99, category: 'decorations' },
        { name: `${themeAdj} Party Hats ${smallSet}`, emoji: '\u{1F451}', price: 9.99, category: 'accessories' },
        { name: `${themeAdj} Confetti Scatter Pack`, emoji: '\u{1F38A}', price: 6.99, category: 'decorations' },
        { name: `${themeAdj} Cupcake Liners ${sizeLabel}`, emoji: '\u{1F9C1}', price: 8.49, category: 'baking' },
        { name: `${themeAdj} String Lights 20ft`, emoji: '\u{1F4A1}', price: 16.99, category: 'decorations' },
        { name: `${themeAdj} Photo Booth Props Set`, emoji: '\u{1F4F8}', price: 12.49, category: 'entertainment' },
        { name: `${themeAdj} Plastic Utensils ${sizeLabel}`, emoji: '\u{1F374}', price: 10.99, category: 'tableware' },
      ],
      wedding: [
        { name: `${themeAdj} Wedding Arch Flowers`, emoji: '\u{1F490}', price: 45.99, category: 'decorations' },
        { name: `${themeAdj} Table Runner Pack of 5`, emoji: '\u{1F3A8}', price: 28.99, category: 'decorations' },
        { name: `${themeAdj} Wedding Place Cards ${sizeLabel}`, emoji: '\u{1F4DD}', price: 15.99, category: 'stationery' },
        { name: `${themeAdj} Candle Holders Set of 12`, emoji: '\u{1F56F}', price: 34.99, category: 'decorations' },
        { name: `${themeAdj} Champagne Flutes ${smallSet}`, emoji: '\u{1F942}', price: 24.99, category: 'tableware' },
        { name: `${themeAdj} Wedding Favor Boxes ${sizeLabel}`, emoji: '\u{1F381}', price: 19.99, category: 'favors' },
        { name: `${themeAdj} Satin Ribbon 100 yards`, emoji: '\u{1F380}', price: 12.99, category: 'decorations' },
        { name: `${themeAdj} Guest Book & Pen Set`, emoji: '\u{1F4D6}', price: 22.99, category: 'stationery' },
        { name: `${themeAdj} Rose Petals 2000 pcs`, emoji: '\u{1F339}', price: 14.99, category: 'decorations' },
        { name: `${themeAdj} Table Numbers Set of 25`, emoji: '\u{1F522}', price: 16.99, category: 'stationery' },
        { name: `${themeAdj} Cake Cutting Set`, emoji: '\u{1F52A}', price: 18.99, category: 'accessories' },
        { name: `${themeAdj} Fairy Lights 50ft`, emoji: '\u{2728}', price: 22.99, category: 'decorations' },
        { name: `${themeAdj} Tulle Roll 100 yards`, emoji: '\u{1F3A8}', price: 11.99, category: 'decorations' },
        { name: `${themeAdj} Wedding Bubbles ${sizeLabel}`, emoji: '\u{1FAE7}', price: 12.99, category: 'entertainment' },
      ],
      babyshower: [
        { name: `${themeAdj} Baby Shower Banner`, emoji: '\u{1F476}', price: 11.99, category: 'decorations' },
        { name: `${themeAdj} Baby Shower Balloons ${smallSet}`, emoji: '\u{1F388}', price: 9.99, category: 'decorations' },
        { name: `${themeAdj} Paper Plates ${sizeLabel}`, emoji: '\u{1F37D}', price: 13.99, category: 'tableware' },
        { name: `${themeAdj} Paper Cups ${sizeLabel}`, emoji: '\u{1F964}', price: 10.99, category: 'tableware' },
        { name: `${themeAdj} Napkins ${sizeLabel}`, emoji: '\u{1F9FB}', price: 8.99, category: 'tableware' },
        { name: `${themeAdj} Diaper Cake Kit`, emoji: '\u{1F381}', price: 24.99, category: 'decorations' },
        { name: `${themeAdj} Baby Shower Games Pack`, emoji: '\u{1F3B2}', price: 14.99, category: 'entertainment' },
        { name: `${themeAdj} Favor Bags ${smallSet}`, emoji: '\u{1F381}', price: 11.99, category: 'favors' },
        { name: `${themeAdj} Centerpiece Baby Blocks`, emoji: '\u{1F9F1}', price: 16.99, category: 'decorations' },
        { name: `${themeAdj} Mommy-to-Be Sash`, emoji: '\u{1F451}', price: 8.99, category: 'accessories' },
        { name: `${themeAdj} Advice Card Set 50pc`, emoji: '\u{1F4DD}', price: 9.99, category: 'stationery' },
        { name: `${themeAdj} Cupcake Toppers ${smallSet}`, emoji: '\u{1F9C1}', price: 7.99, category: 'baking' },
        { name: `${themeAdj} Table Confetti Pack`, emoji: '\u{1F38A}', price: 6.49, category: 'decorations' },
        { name: `${themeAdj} Photo Props Kit`, emoji: '\u{1F4F8}', price: 11.49, category: 'entertainment' },
      ],
      graduation: [
        { name: `${themeAdj} Graduation Banner`, emoji: '\u{1F393}', price: 12.99, category: 'decorations' },
        { name: `${themeAdj} Grad Cap Balloons ${smallSet}`, emoji: '\u{1F388}', price: 10.99, category: 'decorations' },
        { name: `${themeAdj} Party Plates ${sizeLabel}`, emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
        { name: `${themeAdj} Party Cups ${sizeLabel}`, emoji: '\u{1F964}', price: 11.99, category: 'tableware' },
        { name: `${themeAdj} Napkins ${sizeLabel}`, emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
        { name: `${themeAdj} Congratulations Cake Topper`, emoji: '\u{1F382}', price: 8.99, category: 'decorations' },
        { name: `${themeAdj} Photo Banner Garland`, emoji: '\u{1F4F8}', price: 13.99, category: 'decorations' },
        { name: `${themeAdj} Grad Party Favor Boxes ${smallSet}`, emoji: '\u{1F381}', price: 12.99, category: 'favors' },
        { name: `${themeAdj} Table Centerpiece Set`, emoji: '\u{1F490}', price: 19.99, category: 'decorations' },
        { name: `${themeAdj} Confetti Scatter Pack`, emoji: '\u{1F38A}', price: 7.49, category: 'decorations' },
        { name: `${themeAdj} Guest Signing Board`, emoji: '\u{1F4DD}', price: 17.99, category: 'stationery' },
        { name: `${themeAdj} Star String Lights 15ft`, emoji: '\u{2B50}', price: 14.99, category: 'decorations' },
      ],
      retirement: [
        { name: `${themeAdj} Retirement Banner`, emoji: '\u{1F3C6}', price: 12.99, category: 'decorations' },
        { name: `${themeAdj} Gold Balloons ${smallSet}`, emoji: '\u{1F388}', price: 10.99, category: 'decorations' },
        { name: `${themeAdj} Party Plates ${sizeLabel}`, emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
        { name: `${themeAdj} Paper Cups ${sizeLabel}`, emoji: '\u{1F964}', price: 11.99, category: 'tableware' },
        { name: `${themeAdj} Napkins ${sizeLabel}`, emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
        { name: `${themeAdj} Memory Book & Guestbook`, emoji: '\u{1F4D6}', price: 18.99, category: 'stationery' },
        { name: `${themeAdj} Cake Topper "Happy Retirement"`, emoji: '\u{1F382}', price: 9.99, category: 'decorations' },
        { name: `${themeAdj} Photo Display Board`, emoji: '\u{1F5BC}', price: 15.99, category: 'decorations' },
        { name: `${themeAdj} Party Favor Bags ${smallSet}`, emoji: '\u{1F381}', price: 11.99, category: 'favors' },
        { name: `${themeAdj} Table Centerpiece`, emoji: '\u{1F490}', price: 17.99, category: 'decorations' },
        { name: `${themeAdj} Confetti & Streamer Kit`, emoji: '\u{1F38A}', price: 8.99, category: 'decorations' },
      ],
      holiday: [
        { name: `${themeAdj} Holiday Garland 9ft`, emoji: '\u{1F384}', price: 16.99, category: 'decorations' },
        { name: `${themeAdj} Holiday Lights 30ft`, emoji: '\u{1F4A1}', price: 18.99, category: 'decorations' },
        { name: `${themeAdj} Party Plates ${sizeLabel}`, emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
        { name: `${themeAdj} Party Cups ${sizeLabel}`, emoji: '\u{1F964}', price: 11.99, category: 'tableware' },
        { name: `${themeAdj} Napkins ${sizeLabel}`, emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
        { name: `${themeAdj} Ornament Decor Set of 12`, emoji: '\u{1F3AA}', price: 22.99, category: 'decorations' },
        { name: `${themeAdj} Candle Set of 6`, emoji: '\u{1F56F}', price: 14.99, category: 'decorations' },
        { name: `${themeAdj} Table Runner Pack of 3`, emoji: '\u{1F3A8}', price: 15.99, category: 'decorations' },
        { name: `${themeAdj} Party Favor Tins ${smallSet}`, emoji: '\u{1F381}', price: 13.99, category: 'favors' },
        { name: `${themeAdj} Cookie Cutter Set`, emoji: '\u{1F36A}', price: 9.99, category: 'baking' },
        { name: `${themeAdj} Wreath 20 inch`, emoji: '\u{1F33F}', price: 24.99, category: 'decorations' },
      ],
      dinner: [
        { name: `${themeAdj} Linen Napkins ${smallSet}`, emoji: '\u{1F9FB}', price: 19.99, category: 'tableware' },
        { name: `${themeAdj} Pillar Candles Set of 6`, emoji: '\u{1F56F}', price: 16.99, category: 'decorations' },
        { name: `${themeAdj} Table Runner 90 inch`, emoji: '\u{1F3A8}', price: 14.99, category: 'decorations' },
        { name: `${themeAdj} Place Card Holders ${smallSet}`, emoji: '\u{1F4DD}', price: 12.99, category: 'stationery' },
        { name: `${themeAdj} Wine Glasses ${smallSet}`, emoji: '\u{1F377}', price: 28.99, category: 'tableware' },
        { name: `${themeAdj} Centerpiece Vase Set of 3`, emoji: '\u{1F490}', price: 22.99, category: 'decorations' },
        { name: `${themeAdj} Fairy Lights 20ft`, emoji: '\u{2728}', price: 12.99, category: 'decorations' },
        { name: `${themeAdj} Charger Plates ${smallSet}`, emoji: '\u{1F37D}', price: 34.99, category: 'tableware' },
        { name: `${themeAdj} Menu Card Templates 25pc`, emoji: '\u{1F4C4}', price: 10.99, category: 'stationery' },
        { name: `${themeAdj} Cocktail Stirrers 50pc`, emoji: '\u{1F378}', price: 8.99, category: 'accessories' },
      ],
      anniversary: [
        { name: `${themeAdj} Anniversary Banner`, emoji: '\u{1F495}', price: 12.99, category: 'decorations' },
        { name: `${themeAdj} Heart Balloons ${smallSet}`, emoji: '\u{1F388}', price: 10.99, category: 'decorations' },
        { name: `${themeAdj} Party Plates ${sizeLabel}`, emoji: '\u{1F37D}', price: 14.99, category: 'tableware' },
        { name: `${themeAdj} Champagne Flutes ${smallSet}`, emoji: '\u{1F942}', price: 22.99, category: 'tableware' },
        { name: `${themeAdj} Napkins ${sizeLabel}`, emoji: '\u{1F9FB}', price: 9.99, category: 'tableware' },
        { name: `${themeAdj} Photo Display Banner`, emoji: '\u{1F5BC}', price: 14.99, category: 'decorations' },
        { name: `${themeAdj} Cake Topper "Anniversary"`, emoji: '\u{1F382}', price: 9.99, category: 'decorations' },
        { name: `${themeAdj} Rose Petals 1000 pcs`, emoji: '\u{1F339}', price: 11.99, category: 'decorations' },
        { name: `${themeAdj} Candle Holders Set of 6`, emoji: '\u{1F56F}', price: 18.99, category: 'decorations' },
        { name: `${themeAdj} Party Favor Boxes ${smallSet}`, emoji: '\u{1F381}', price: 11.99, category: 'favors' },
        { name: `${themeAdj} Fairy Lights 30ft`, emoji: '\u{2728}', price: 15.99, category: 'decorations' },
        { name: `${themeAdj} Guest Signing Canvas`, emoji: '\u{1F4DD}', price: 19.99, category: 'stationery' },
      ],
    };

    return baseCatalog[type] || baseCatalog.birthday;
  }

  function extractThemeAdjective(theme) {
    if (!theme) return 'Classic';
    // Take the first meaningful words from the theme
    const cleaned = theme.replace(/theme|themed|style|styled|a |the |an /gi, '').trim();
    if (cleaned.length > 40) return cleaned.substring(0, 40);
    if (cleaned.length === 0) return 'Classic';
    // Capitalize first letter
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
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
      data.partyBucket.push({ ...item });
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
    const total = data.partyBucket.reduce((s, item) => s + item.price, 0);
    document.getElementById('bucket-total-price').textContent = formatCurrency(total);

    if (count === 0) {
      bucketItemsEl.innerHTML = '<div class="bucket-empty">Your party bucket is empty. Add items from the mood board!</div>';
      return;
    }

    bucketItemsEl.innerHTML = data.partyBucket.map(item => {
      const storeUrl = getStoreUrl(item.name, item.store);
      return `
        <div class="bucket-item">
          <span class="bucket-item-icon">${item.emoji}</span>
          <div class="bucket-item-info">
            <span class="bucket-item-name">${escapeHtml(item.name)}</span>
            <span class="bucket-item-price">${formatCurrency(item.price)}</span>
            <a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener" class="bucket-item-store-link">Buy at ${escapeHtml(item.store)}</a>
          </div>
          <button class="bucket-item-remove" onclick="app.removeBucketItem('${item.id}')">&times;</button>
        </div>
      `;
    }).join('');
  }

  function refreshMoodItemCards() {
    // Update all mood item cards in chat to reflect bucket state
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

    // Also refresh mood board tab
    renderMoodBoard();
  }

  // ── Bucket Panel Toggle ──

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
  //  GUEST LIST & RSVP
  // ══════════════════════════════════════

  const addGuestBtn = document.getElementById('add-guest-btn');

  addGuestBtn.addEventListener('click', () => {
    document.getElementById('guest-form').reset();
    document.getElementById('guest-id').value = '';
    document.getElementById('guest-num-people').value = '1';
    document.getElementById('guest-modal-title').textContent = 'Add Guest';
    openModal('guest-modal');
  });

  document.getElementById('guest-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('guest-id').value;
    const guestData = {
      name: document.getElementById('guest-name').value.trim(),
      email: document.getElementById('guest-email').value.trim(),
      numPeople: parseInt(document.getElementById('guest-num-people').value, 10) || 1,
      rsvp: document.getElementById('guest-rsvp').value,
    };

    if (id) {
      const idx = data.guests.findIndex(g => g.id === id);
      if (idx !== -1) data.guests[idx] = { ...data.guests[idx], ...guestData };
    } else {
      data.guests.push({ id: generateId(), ...guestData });
    }

    saveData(data);
    closeModal('guest-modal');
    renderGuests();
  });

  function renderGuests() {
    const listEl = document.getElementById('guests-list');
    const summaryEl = document.getElementById('guest-summary');

    if (data.guests.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No guests added yet. Click "+ Add Guest" to start building your guest list.</p>';
      summaryEl.classList.add('hidden');
      return;
    }

    summaryEl.classList.remove('hidden');

    const yesCount = data.guests.filter(g => g.rsvp === 'yes').length;
    const pendingCount = data.guests.filter(g => g.rsvp === 'pending').length;
    const noCount = data.guests.filter(g => g.rsvp === 'no').length;
    const totalPeople = data.guests.reduce((s, g) => s + (g.numPeople || 1), 0);

    document.getElementById('confirmed-count').textContent = `${yesCount} Confirmed`;
    document.getElementById('pending-count').textContent = `${pendingCount} Pending`;
    document.getElementById('declined-count').textContent = `${noCount} Declined`;
    document.getElementById('total-people-count').textContent = `${totalPeople} Total People`;

    listEl.innerHTML = `
      <table class="guests-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th># People</th>
            <th>RSVP</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${data.guests.map(g => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td>${escapeHtml(g.email || '-')}</td>
              <td>${g.numPeople || 1}</td>
              <td><span class="rsvp-badge rsvp-${g.rsvp}">${g.rsvp === 'yes' ? 'Yes' : g.rsvp === 'no' ? 'No' : 'Pending'}</span></td>
              <td class="actions-cell">
                <button class="btn btn-sm btn-secondary" onclick="app.editGuest('${g.id}')">Edit</button>
                <button class="btn btn-sm btn-danger" onclick="app.deleteGuest('${g.id}')">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function editGuest(id) {
    const g = data.guests.find(g => g.id === id);
    if (!g) return;
    document.getElementById('guest-id').value = g.id;
    document.getElementById('guest-name').value = g.name;
    document.getElementById('guest-email').value = g.email || '';
    document.getElementById('guest-num-people').value = g.numPeople || 1;
    document.getElementById('guest-rsvp').value = g.rsvp;
    document.getElementById('guest-modal-title').textContent = 'Edit Guest';
    openModal('guest-modal');
  }

  function deleteGuest(id) {
    if (!confirm('Remove this guest?')) return;
    data.guests = data.guests.filter(g => g.id !== id);
    saveData(data);
    renderGuests();
  }

  // ══════════════════════════════════════
  //  BUDGET TRACKER
  // ══════════════════════════════════════

  const categoryLabels = {
    venue: 'Venue',
    food: 'Food & Drinks',
    decorations: 'Decorations',
    entertainment: 'Entertainment',
    photography: 'Photography',
    invitations: 'Invitations',
    supplies: 'Party Supplies',
    other: 'Other',
  };

  const addExpenseBtn = document.getElementById('add-expense-btn');

  // Budget limit
  const budgetLimitInput = document.getElementById('budget-limit');
  budgetLimitInput.value = data.budgetLimit || 0;

  document.getElementById('set-budget-btn').addEventListener('click', () => {
    data.budgetLimit = parseFloat(budgetLimitInput.value) || 0;
    saveData(data);
    renderExpenses();
  });

  addExpenseBtn.addEventListener('click', () => {
    document.getElementById('expense-form').reset();
    document.getElementById('expense-id').value = '';
    document.getElementById('expense-modal-title').textContent = 'Add Expense';
    openModal('expense-modal');
  });

  document.getElementById('expense-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('expense-id').value;
    const expenseData = {
      category: document.getElementById('expense-category').value,
      description: document.getElementById('expense-description').value.trim(),
      amount: parseFloat(document.getElementById('expense-amount').value),
      paid: document.getElementById('expense-paid').checked,
    };

    if (id) {
      const idx = data.expenses.findIndex(ex => ex.id === id);
      if (idx !== -1) data.expenses[idx] = { ...data.expenses[idx], ...expenseData };
    } else {
      data.expenses.push({ id: generateId(), ...expenseData });
    }

    saveData(data);
    closeModal('expense-modal');
    renderExpenses();
  });

  function renderExpenses() {
    const listEl = document.getElementById('expenses-list');
    const totalSpent = data.expenses.reduce((s, ex) => s + Number(ex.amount), 0);
    const budgetLimit = data.budgetLimit || 0;
    const remaining = budgetLimit - totalSpent;

    document.getElementById('budget-spent').textContent = formatCurrency(totalSpent);
    document.getElementById('budget-total-display').textContent = formatCurrency(budgetLimit);
    document.getElementById('budget-remaining').textContent = formatCurrency(Math.max(0, remaining));

    const pct = budgetLimit > 0 ? Math.min((totalSpent / budgetLimit) * 100, 100) : 0;
    const bar = document.getElementById('budget-bar');
    bar.style.width = pct + '%';
    bar.className = 'budget-bar' + (pct > 90 ? ' over-budget' : '');

    if (data.expenses.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No expenses tracked yet. Click "+ Add Expense" to start tracking your party budget.</p>';
      return;
    }

    listEl.innerHTML = data.expenses.map(ex => `
      <div class="card expense-card ${ex.paid ? 'paid' : ''}">
        <div class="card-header">
          <h4>${escapeHtml(ex.description)}</h4>
          <span class="expense-amount">${formatCurrency(ex.amount)}</span>
        </div>
        <div class="card-body">
          <span class="expense-category">${categoryLabels[ex.category] || ex.category}</span>
          <span class="expense-status ${ex.paid ? 'paid' : 'unpaid'}">${ex.paid ? 'Paid' : 'Unpaid'}</span>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm btn-secondary" onclick="app.editExpense('${ex.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="app.deleteExpense('${ex.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  }

  function editExpense(id) {
    const ex = data.expenses.find(e => e.id === id);
    if (!ex) return;
    document.getElementById('expense-id').value = ex.id;
    document.getElementById('expense-category').value = ex.category;
    document.getElementById('expense-description').value = ex.description;
    document.getElementById('expense-amount').value = ex.amount;
    document.getElementById('expense-paid').checked = ex.paid;
    document.getElementById('expense-modal-title').textContent = 'Edit Expense';
    openModal('expense-modal');
  }

  function deleteExpense(id) {
    if (!confirm('Delete this expense?')) return;
    data.expenses = data.expenses.filter(ex => ex.id !== id);
    saveData(data);
    renderExpenses();
  }

  // ══════════════════════════════════════
  //  MOOD BOARD TAB
  // ══════════════════════════════════════

  function renderMoodBoard() {
    const grid = document.getElementById('moodboard-grid');
    const allItems = data.moodBoardItems || [];
    const uploads = data.uploadedImages || [];

    if (allItems.length === 0 && uploads.length === 0) {
      grid.innerHTML = '<div class="moodboard-empty">No mood board items yet. Use the DIY AI Planner to generate themed suggestions, or upload your own inspiration images!</div>';
      return;
    }

    let html = '';

    // Render uploaded images first
    uploads.forEach(img => {
      html += `
        <div class="moodboard-card uploaded" id="moodboard-upload-${img.id}">
          <div class="moodboard-card-visual">
            <div class="img-loading"><div class="spinner"></div></div>
            <button class="moodboard-card-delete" onclick="app.deleteUploadedImage('${img.id}')">&times;</button>
          </div>
          <div class="moodboard-card-info">
            <span class="moodboard-card-name">${escapeHtml(img.name)}</span>
          </div>
        </div>
      `;
    });

    // Render AI-generated/planner items
    allItems.forEach(item => {
      const storeUrl = getStoreUrl(item.name, item.store);
      const inBucket = isInBucket(item.id);
      html += `
        <div class="moodboard-card" id="moodboard-card-${item.id}">
          <div class="moodboard-card-visual">${item.emoji}</div>
          <div class="moodboard-card-info">
            <span class="moodboard-card-name">${escapeHtml(item.name)}</span>
            <span class="moodboard-card-price">${formatCurrency(item.price)}</span>
            <span class="moodboard-card-store">at ${escapeHtml(item.store)}</span>
          </div>
          <div class="moodboard-card-actions">
            <button class="btn ${inBucket ? 'btn-in-bucket' : 'btn-add-bucket'}" onclick="app.toggleMoodBoardItem('${item.id}')">${inBucket ? 'In Bucket' : 'Add to Bucket'}</button>
            <a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener" class="btn btn-secondary">Shop</a>
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;

    // Load uploaded images from IndexedDB
    uploads.forEach(img => {
      getImage('upload_' + img.id).then(dataUrl => {
        if (dataUrl) {
          const card = document.getElementById('moodboard-upload-' + img.id);
          if (card) {
            const visual = card.querySelector('.moodboard-card-visual');
            // Keep delete button, replace loading with image
            visual.innerHTML = `<img src="${dataUrl}" alt="${escapeHtml(img.name)}" loading="lazy"><button class="moodboard-card-delete" onclick="app.deleteUploadedImage('${img.id}')">&times;</button>`;
          }
        }
      }).catch(() => {});
    });

    // Load cached AI images for planner items
    allItems.forEach(item => {
      getImage('img_' + item.id).then(dataUrl => {
        if (dataUrl) {
          updateCardImage('moodboard-card-' + item.id, dataUrl);
        }
      }).catch(() => {});
    });
  }

  function toggleMoodBoardItem(itemId) {
    const item = (data.moodBoardItems || []).find(i => i.id === itemId);
    if (!item) return;
    toggleBucketItem(item);
  }

  // ══════════════════════════════════════
  //  USER IMAGE UPLOAD
  // ══════════════════════════════════════

  const uploadBtn = document.getElementById('upload-image-btn');
  const uploadInput = document.getElementById('upload-image-input');

  uploadBtn.addEventListener('click', () => {
    uploadInput.click();
  });

  uploadInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;

      const id = generateId();
      const name = file.name.replace(/\.[^.]+$/, ''); // strip extension

      // Compress and store
      const compressed = await compressImage(file, 800, 0.7);
      await saveImage('upload_' + id, compressed).catch(() => {});

      // Save metadata
      if (!data.uploadedImages) data.uploadedImages = [];
      data.uploadedImages.push({ id, name, timestamp: Date.now() });
      saveData(data);
    }

    // Reset input so same file can be re-selected
    uploadInput.value = '';

    // Re-render mood board
    renderMoodBoard();
  });

  function deleteUploadedImage(id) {
    if (!confirm('Delete this uploaded image?')) return;
    data.uploadedImages = (data.uploadedImages || []).filter(img => img.id !== id);
    saveData(data);
    deleteImage('upload_' + id).catch(() => {});
    renderMoodBoard();
  }

  // ══════════════════════════════════════
  //  RENDER ALL & INIT
  // ══════════════════════════════════════

  function renderAll() {
    renderGuests();
    renderExpenses();
    renderMoodBoard();
    updateBucketUI();
    restorePlannerState();
  }

  // ── Public API (for onclick handlers) ──

  window.app = {
    editGuest,
    deleteGuest,
    editExpense,
    deleteExpense,
    removeBucketItem,
    toggleMoodBoardItem,
    deleteUploadedImage,
  };

  // ── Init ──
  openDB().catch(() => console.warn('IndexedDB unavailable, image storage disabled'));
  renderAll();
})();
