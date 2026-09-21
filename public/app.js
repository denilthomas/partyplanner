(function () {
  'use strict';

  // ══════════════════════════════════════
  //  DATA LAYER
  // ══════════════════════════════════════

  function emptyPlan() {
    return {
      eventType: null,        // "Birthday" | "Wedding" | ...
      budget: null,           // number (USD)
      guestCount: null,       // number
      setting: null,          // "indoor" | "outdoor" | "both"
      themePreference: null,  // free-text theme/vibe the user wants
      theme: null,            // { name, source, palette } once designed
    };
  }

  function loadData() {
    const defaults = {
      partyPlan: emptyPlan(),
      partyBucket: [],
      chatHistory: [],
      extractedItems: [],
      inspirationUrls: [],
    };
    try {
      const raw = localStorage.getItem('partyplanner');
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed, partyPlan: { ...emptyPlan(), ...(parsed.partyPlan || {}) } };
    } catch { return defaults; }
  }

  function saveData(d) {
    localStorage.setItem('partyplanner', JSON.stringify(d));
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  let data = loadData();

  // ══════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════

  const state = {
    apiMessages: [],
    manifest: { themes: [] },
    inspirationUrls: [],
    extractedItems: [],
    sheetState: 'collapsed',
    chatOpen: false,
  };

  // ══════════════════════════════════════
  //  DOM REFS
  // ══════════════════════════════════════

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const landingOverlay = $('#landing-overlay');
  const bottomSheet = $('#bottom-sheet');
  const sheetHandle = $('#sheet-handle');
  const sheetThemeName = $('#sheet-theme-name');
  const sheetItemCount = $('#sheet-item-count');
  const sheetBuckets = $('#sheet-buckets');
  const sheetBody = $('#sheet-body');
  const sheetItemsList = $('#sheet-items-list');
  const planCard = $('#plan-card');
  const sheetProducts = $('#sheet-products');
  const sheetCheckout = $('#sheet-checkout');
  const sheetFooter = $('#sheet-footer');
  const bucketTotalPrice = $('#bucket-total-price');
  const bucketCheckoutBtn = $('#bucket-checkout-btn');
  const bucketCountBadge = $('#bucket-count-badge');
  const chatDrawer = $('#chat-drawer');
  const chatDrawerBackdrop = $('#chat-drawer-backdrop');
  const chatMessages = $('#chat-messages');
  const chatInput = $('#chat-input');
  const chatSendBtn = $('#chat-send-btn');
  const chatOpenBtn = $('#chat-open-btn');
  const chatDrawerClose = $('#chat-drawer-close');
  const chatUploadBtn = $('#chat-upload-btn');
  const chatUploadInput = $('#chat-upload-input');
  const chatImagePreview = $('#chat-image-preview');
  const zoomModal = $('#zoom-modal');
  const zoomModalClose = $('#zoom-modal-close');
  const zoomModalImageWrap = $('#zoom-modal-image-wrap');
  const zoomModalLabel = $('#zoom-modal-label');
  const contextMenu = $('#context-menu');
  const settingsBtn = $('#settings-btn');
  const settingsForm = $('#settings-form');
  const bucketBadgeBtn = $('#bucket-badge-btn');

  // ══════════════════════════════════════
  //  BUCKET METADATA
  // ══════════════════════════════════════

  const BUCKET_META = {
    tabletop:        { label: 'Tabletop',          icon: '\u{1F37D}', color: '#6c5ce7' },
    wall_backdrop:   { label: 'Wall & Backdrop',    icon: '\u{1F3A8}', color: '#e17055' },
    accent_decor:    { label: 'Accent Decor',       icon: '\u{1F56F}', color: '#00b894' },
    activity_favors: { label: 'Activity & Favors',  icon: '\u{1F381}', color: '#fdcb6e' },
    food_display:    { label: 'Food Display',       icon: '\u{1F382}', color: '#0984e3' },
  };

  const BUCKET_ORDER = ['tabletop', 'wall_backdrop', 'accent_decor', 'activity_favors', 'food_display'];

  // ══════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatCurrency(amount) {
    return '$' + Number(amount || 0).toFixed(2);
  }

  function compressImage(file, maxWidth, quality) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width, h = img.height;
          if (w > (maxWidth || 1024)) {
            h = Math.round(h * (maxWidth || 1024) / w);
            w = maxWidth || 1024;
          }
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality || 0.85));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToBase64(dataUrl) {
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mediaType: match[1], base64: match[2] };
  }

  function buildBboxThumbnailStyle(imageUrl, bbox) {
    if (!imageUrl || !bbox || bbox.length < 4) return '';
    const [ymin, xmin, ymax, xmax] = bbox;
    const bw = Math.max(xmax - xmin, 1);
    const bh = Math.max(ymax - ymin, 1);
    const bgSizeX = (1000 / bw) * 100;
    const bgSizeY = (1000 / bh) * 100;
    const bgPosX = (xmin / (1000 - bw)) * 100 || 0;
    const bgPosY = (ymin / (1000 - bh)) * 100 || 0;
    return `background-image: url('${imageUrl}'); background-size: ${bgSizeX.toFixed(1)}% ${bgSizeY.toFixed(1)}%; background-position: ${bgPosX.toFixed(1)}% ${bgPosY.toFixed(1)}%;`;
  }

  // ══════════════════════════════════════
  //  API CALLS
  // ══════════════════════════════════════

  const PLANNER_SYSTEM_BASE = [
    'You assist a card-based party planner. The user fills 5 cards (party type, budget, number of people, indoor/outdoor, theme) — the cards are the primary UI, not you.',
    '',
    'YOUR JOB:',
    '- Parse the user\'s message into update_party_plan calls. One message may fill several slots at once (e.g. "40 people, backyard, $300, boho 1st birthday" → eventType, guestCount, setting, budget, theme).',
    '- Proactively suggest a value for an empty slot when asked or clearly helpful (e.g. a sensible budget for the guest count, or 2-3 theme directions if they are unsure).',
    '- Keep replies to 1-2 warm sentences. Do NOT interrogate one question at a time — the cards handle that.',
    '- When the plan has at least a party type and a theme (or the user says "design it" / "go"), you MAY call create_theme to start designing.',
    '- If the user asks to add or remove specific bucket items later, call update_party_bucket.',
  ].join('\n');

  function buildSystemPrompt() {
    const plan = data.partyPlan || emptyPlan();
    const planLines = [
      '',
      'CURRENT PARTY PLAN (already known — do not re-ask):',
      `  Party type: ${plan.eventType || '(not set)'}`,
      `  Budget: ${plan.budget != null ? '$' + plan.budget : '(not set)'}`,
      `  Number of people: ${plan.guestCount != null ? plan.guestCount : '(not set)'}`,
      `  Setting: ${plan.setting || '(not set)'}`,
      `  Theme: ${plan.theme ? (plan.theme.name || plan.theme) : (plan.themePreference || '(not set)')}`,
    ];
    return PLANNER_SYSTEM_BASE + '\n' + planLines.join('\n');
  }

  const PLANNER_TOOLS = [
    {
      name: 'update_party_plan',
      description: 'Fill or adjust one or more Party Plan cards from what the user said. Call whenever they mention party type, budget, number of people, setting, or a theme/vibe.',
      input_schema: {
        type: 'object',
        properties: {
          eventType: { type: 'string', description: 'Party type, e.g. "Birthday", "Wedding"' },
          budget: { type: 'number', description: 'Budget in USD (a single number; use the midpoint if a range)' },
          guestCount: { type: 'number', description: 'Approximate number of people' },
          setting: { type: 'string', enum: ['indoor', 'outdoor', 'both'], description: 'Where the party is held' },
          themePreference: { type: 'string', description: 'Free-text theme or vibe, e.g. "Paw Patrol", "boho muted"' },
        },
      },
    },
    {
      name: 'create_theme',
      description: 'Start designing the theme once the plan has a party type and a theme/vibe (or the user says go). Opens the theme designer.',
      input_schema: {
        type: 'object',
        properties: {
          theme_preference: { type: 'string', description: 'The theme/vibe to design around (optional; defaults to the plan\'s theme).' },
        },
      },
    },
    {
      name: 'update_party_bucket',
      description: 'Add or remove items from the party bucket.',
      input_schema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'remove'] },
                item_name: { type: 'string' },
                price: { type: 'number' },
                store: { type: 'string' },
              },
              required: ['action', 'item_name'],
            },
          },
        },
        required: ['actions'],
      },
    },
  ];

  async function callClaude(messages) {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: buildSystemPrompt(),
          tools: PLANNER_TOOLS,
          messages,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { error: err.error?.message || err.error || 'API error' };
      }
      return await res.json();
    } catch (err) {
      return { error: err.message || 'Network error' };
    }
  }

  async function callExtractItems(images, spaceAnchors) {
    try {
      const res = await fetch('/api/extract-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, space_anchors: spaceAnchors }),
      });
      const d = await res.json();
      return d.items || [];
    } catch (err) {
      console.error('Extract items failed:', err);
      return [];
    }
  }

  async function callSearchProducts(query, maxResults) {
    try {
      const res = await fetch('/api/search-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: maxResults || 5 }),
      });
      const d = await res.json();
      return d.products || [];
    } catch (err) {
      console.error('Product search failed:', err);
      return [];
    }
  }

  async function callSearchKits(query, maxResults) {
    try {
      const res = await fetch('/api/search-kits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: maxResults || 3 }),
      });
      const d = await res.json();
      return d.kits || [];
    } catch (err) {
      console.error('Kit search failed:', err);
      return [];
    }
  }

  // ══════════════════════════════════════
  //  BOTTOM SHEET (3-state)
  // ══════════════════════════════════════

  function setSheetState(newState) {
    state.sheetState = newState;
    bottomSheet.classList.remove('sheet-collapsed', 'sheet-half', 'sheet-full');
    bottomSheet.classList.add('sheet-' + newState);
  }

  let sheetTouchStartY = 0;
  let sheetStartHeight = 0;

  sheetHandle.addEventListener('touchstart', (e) => {
    sheetTouchStartY = e.touches[0].clientY;
    const rect = bottomSheet.getBoundingClientRect();
    sheetStartHeight = rect.height;
    bottomSheet.style.transition = 'none';
  }, { passive: true });

  sheetHandle.addEventListener('touchmove', (e) => {
    const dy = sheetTouchStartY - e.touches[0].clientY;
    const newHeight = Math.max(60, Math.min(window.innerHeight * 0.92, sheetStartHeight + dy));
    bottomSheet.style.height = newHeight + 'px';
    bottomSheet.classList.remove('sheet-collapsed', 'sheet-half', 'sheet-full');
  }, { passive: true });

  sheetHandle.addEventListener('touchend', () => {
    bottomSheet.style.transition = '';
    bottomSheet.style.height = '';
    const rect = bottomSheet.getBoundingClientRect();
    const vh = window.innerHeight;
    const ratio = rect.height / vh;
    if (ratio < 0.15) setSheetState('collapsed');
    else if (ratio < 0.6) setSheetState('half');
    else setSheetState('full');
  });

  sheetHandle.addEventListener('click', () => {
    if (state.sheetState === 'collapsed') setSheetState('half');
    else if (state.sheetState === 'half') setSheetState('full');
    else setSheetState('collapsed');
  });

  // Bucket badge opens sheet to half
  bucketBadgeBtn.addEventListener('click', () => {
    if (state.sheetState === 'collapsed') setSheetState('half');
    else setSheetState('collapsed');
  });

  // bbox pixel crop { x, y, w, h } → ImageKit transform URL (legacy curated path)
  function buildImageKitCropUrl(url, crop) {
    if (!url || !crop) return url || '';
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}tr=x-${crop.x},y-${crop.y},w-${crop.w},h-${crop.h}`;
  }

  // ══════════════════════════════════════
  //  PARTY PLAN (sheet summary card)
  // ══════════════════════════════════════

  const PLAN_FIELDS = [
    { key: 'eventType', label: 'Party type' },
    { key: 'budget', label: 'Budget' },
    { key: 'guestCount', label: 'Guests' },
    { key: 'setting', label: 'Setting' },
    { key: 'theme', label: 'Theme' },
  ];

  function planValueText(key) {
    const plan = data.partyPlan || {};
    const v = plan[key];
    if (v == null || v === '') return null;
    if (key === 'budget') return '$' + v;
    if (key === 'theme') return (v && (v.name || v)) || plan.themePreference || null;
    if (key === 'setting') return v.charAt(0).toUpperCase() + v.slice(1);
    return String(v);
  }

  function renderPlanCard() {
    const plan = data.partyPlan || {};
    const anySet = PLAN_FIELDS.some(f => planValueText(f.key) != null);
    if (!anySet) { planCard.classList.add('hidden'); return; }
    planCard.classList.remove('hidden');
    const rows = PLAN_FIELDS.map(f => {
      const val = planValueText(f.key);
      const filled = val != null;
      return `<div class="plan-row ${filled ? 'filled' : ''}">
        <span class="plan-row-check">${filled ? '✓' : ''}</span>
        <span class="plan-row-label">${f.label}</span>
        <span class="plan-row-value ${filled ? '' : 'empty'}">${filled ? escapeHtml(val) : 'not set yet'}</span>
      </div>`;
    }).join('');
    planCard.innerHTML = `<div class="plan-card-title">\u{1F389} Your Party Plan</div><div class="plan-card-rows">${rows}</div>`;
  }

  // Merge free-text-derived fields into the plan (used by the chat-assist agent).
  function applyPlanUpdate(fields) {
    const plan = data.partyPlan || emptyPlan();
    if (fields.eventType != null) plan.eventType = fields.eventType;
    if (fields.budget != null) plan.budget = fields.budget;
    if (fields.guestCount != null) plan.guestCount = fields.guestCount;
    if (fields.setting != null) plan.setting = fields.setting;
    if (fields.themePreference != null) plan.themePreference = fields.themePreference;
    data.partyPlan = plan;
    saveData(data);
    renderPlanCard();
    renderHomeCards();
    refreshDesignBtn();
  }

  // ══════════════════════════════════════
  //  HOME — cards-first party builder
  // ══════════════════════════════════════

  const EVENT_TYPES = ['Birthday', 'Wedding', 'Retirement', 'Graduation', 'Holiday', 'Baby Shower', 'Anniversary', 'Dinner Party'];
  const BUDGET_RANGES = [
    { label: '< $100', value: 75 },
    { label: '$100–300', value: 200 },
    { label: '$300–600', value: 450 },
    { label: '$600+', value: 800 },
  ];
  const SETTINGS = ['indoor', 'outdoor', 'both'];
  const THEME_SUGGESTIONS = {
    Birthday: ['Paw Patrol', 'Dinosaur', 'Rainbow', 'Boho', 'Space'],
    Wedding: ['Rose Gold', 'Boho Garden', 'Classic White', 'Rustic'],
    Retirement: ['Golf', 'Tropical', 'Elegant Gold', 'Travel'],
    Graduation: ['School Colors', 'Gold & Black', 'Adventure Awaits'],
    Holiday: ['Winter Wonderland', 'Festive Red & Gold', 'Cozy Rustic'],
    'Baby Shower': ['Little Star', 'Woodland', 'Pastel Cloud', 'Safari'],
    Anniversary: ['Rose Gold', 'Romantic Red', 'Golden Years'],
    'Dinner Party': ['Elegant Neutral', 'Italian Trattoria', 'Garden Table'],
  };

  const planCardsEl = $('#plan-cards');
  const designThemeBtn = $('#design-theme-btn');

  function chip(label, active, onClick) {
    const b = document.createElement('button');
    b.className = 'pp-chip' + (active ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderHomeCards() {
    if (!planCardsEl) return;
    const plan = data.partyPlan || emptyPlan();
    planCardsEl.innerHTML = '';

    // 1. Party type
    const typeCard = cardShell('Party type', plan.eventType);
    const typeWrap = document.createElement('div');
    typeWrap.className = 'pp-chips';
    EVENT_TYPES.forEach(t => typeWrap.appendChild(chip(t, plan.eventType === t, () => {
      applyPlanUpdate({ eventType: t });
    })));
    typeCard.appendChild(typeWrap);
    planCardsEl.appendChild(typeCard);

    // 2. Budget
    const budgetCard = cardShell('Budget', plan.budget != null ? '$' + plan.budget : null);
    const budgetWrap = document.createElement('div');
    budgetWrap.className = 'pp-chips';
    BUDGET_RANGES.forEach(r => budgetWrap.appendChild(chip(r.label, plan.budget === r.value, () => {
      applyPlanUpdate({ budget: r.value });
    })));
    const budgetInput = document.createElement('input');
    budgetInput.type = 'number';
    budgetInput.className = 'pp-num-input';
    budgetInput.placeholder = 'Custom $';
    budgetInput.min = '0';
    if (plan.budget != null && !BUDGET_RANGES.some(r => r.value === plan.budget)) budgetInput.value = plan.budget;
    budgetInput.addEventListener('change', () => {
      const v = parseInt(budgetInput.value, 10);
      if (!isNaN(v) && v > 0) applyPlanUpdate({ budget: v });
    });
    budgetWrap.appendChild(budgetInput);
    budgetCard.appendChild(budgetWrap);
    planCardsEl.appendChild(budgetCard);

    // 3. Number of people
    const peopleCard = cardShell('Number of people', plan.guestCount != null ? String(plan.guestCount) : null);
    const stepper = document.createElement('div');
    stepper.className = 'pp-stepper';
    const dec = document.createElement('button'); dec.className = 'pp-step'; dec.textContent = '−';
    const num = document.createElement('input'); num.type = 'number'; num.className = 'pp-num-input'; num.min = '1';
    num.value = plan.guestCount != null ? plan.guestCount : '';
    num.placeholder = '0';
    const inc = document.createElement('button'); inc.className = 'pp-step'; inc.textContent = '+';
    dec.addEventListener('click', () => applyPlanUpdate({ guestCount: Math.max(1, (plan.guestCount || 0) - 5) }));
    inc.addEventListener('click', () => applyPlanUpdate({ guestCount: (plan.guestCount || 0) + 5 }));
    num.addEventListener('change', () => {
      const v = parseInt(num.value, 10);
      if (!isNaN(v) && v > 0) applyPlanUpdate({ guestCount: v });
    });
    stepper.appendChild(dec); stepper.appendChild(num); stepper.appendChild(inc);
    peopleCard.appendChild(stepper);
    planCardsEl.appendChild(peopleCard);

    // 4. Setting
    const setCard = cardShell('Indoor / Outdoor', plan.setting ? plan.setting[0].toUpperCase() + plan.setting.slice(1) : null);
    const setWrap = document.createElement('div');
    setWrap.className = 'pp-chips';
    SETTINGS.forEach(s => setWrap.appendChild(chip(s[0].toUpperCase() + s.slice(1), plan.setting === s, () => {
      applyPlanUpdate({ setting: s });
    })));
    setCard.appendChild(setWrap);
    planCardsEl.appendChild(setCard);

    // 5. Theme (chips per type + free text)
    const themeVal = plan.themePreference || (plan.theme && plan.theme.name) || null;
    const themeCard = cardShell('Theme', themeVal);
    const themeWrap = document.createElement('div');
    themeWrap.className = 'pp-chips';
    (THEME_SUGGESTIONS[plan.eventType] || []).forEach(t => themeWrap.appendChild(chip(t, plan.themePreference === t, () => {
      applyPlanUpdate({ themePreference: t });
    })));
    const themeInput = document.createElement('input');
    themeInput.type = 'text';
    themeInput.className = 'pp-text-input';
    themeInput.placeholder = 'or describe your own vibe…';
    if (plan.themePreference && !(THEME_SUGGESTIONS[plan.eventType] || []).includes(plan.themePreference)) themeInput.value = plan.themePreference;
    themeInput.addEventListener('change', () => {
      const v = themeInput.value.trim();
      if (v) applyPlanUpdate({ themePreference: v });
    });
    themeWrap.appendChild(themeInput);
    themeCard.appendChild(themeWrap);
    planCardsEl.appendChild(themeCard);
  }

  function cardShell(title, value) {
    const card = document.createElement('div');
    card.className = 'pp-card';
    const head = document.createElement('div');
    head.className = 'pp-card-head';
    head.innerHTML = `<span class="pp-card-title">${escapeHtml(title)}</span>` +
      (value ? `<span class="pp-card-value">${escapeHtml(value)}</span>` : '<span class="pp-card-value empty">—</span>');
    card.appendChild(head);
    return card;
  }

  function refreshDesignBtn() {
    if (!designThemeBtn) return;
    const plan = data.partyPlan || {};
    const ready = !!plan.eventType && !!(plan.themePreference || plan.theme);
    designThemeBtn.disabled = !ready;
  }

  if (designThemeBtn) {
    designThemeBtn.addEventListener('click', () => {
      const plan = data.partyPlan || {};
      startThemeCreation(plan.themePreference || (plan.theme && plan.theme.name) || '');
    });
  }

  // Home chat-assist lane
  const homeChatInput = $('#home-chat-input');
  const homeChatSend = $('#home-chat-send');
  function sendHomeChat() {
    const text = (homeChatInput.value || '').trim();
    if (!text) return;
    homeChatInput.value = '';
    openChatDrawer();
    addChatMessage('user', text);
    state.apiMessages.push({ role: 'user', content: text });
    sendToLLM();
  }
  if (homeChatSend) homeChatSend.addEventListener('click', sendHomeChat);
  if (homeChatInput) homeChatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendHomeChat(); } });

  // ══════════════════════════════════════
  //  FULL-SCREEN OVERLAYS
  // ══════════════════════════════════════

  function showScreen(id) { const el = $('#' + id); if (el) el.classList.remove('hidden'); }
  function hideScreen(id) { const el = $('#' + id); if (el) el.classList.add('hidden'); }

  const FACET_LABELS = { backdrop: 'Backdrop', table: 'Table decor', accent: 'Accents' };
  const FACET_ORDER = ['backdrop', 'table', 'accent'];

  // ══════════════════════════════════════
  //  THEME SCREEN — generate + facet chooser
  // ══════════════════════════════════════

  async function startThemeCreation(pref) {
    if (state.themeRegenCount == null) state.themeRegenCount = 0;
    landingOverlay.classList.add('hidden');
    showScreen('theme-screen');
    $('#theme-title').textContent = 'Designing your theme…';
    $('#theme-sub').textContent = '';
    $('#theme-palette').innerHTML = '';
    $('#facet-sections').innerHTML = '<div class="theme-loading"><div class="spinner"></div><span>Designing…</span></div>';
    $('#theme-use').disabled = true;

    try {
      const res = await fetch('/api/create-theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: data.partyPlan, theme_preference: pref }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);

      state.themeKey = d.key;
      state.theme = d.theme || {};
      state.cached = !!d.cached;
      state.chosen = {};             // facet → image url
      state.facetImages = {};        // facet → [urls]
      state.cachedItemsByUrl = {};   // url → items (for hit path)

      $('#theme-title').textContent = (state.theme.name || pref || 'Your theme');
      $('#theme-sub').textContent = state.cached ? 'From your library' : 'Freshly designed';
      renderPalette(state.theme.palette || []);
      renderFacetChooser(d.facets || [], d.cached);
    } catch (err) {
      $('#facet-sections').innerHTML = `<div class="theme-error">Couldn't design that theme (${escapeHtml(err.message)}). <button class="btn btn-secondary" id="theme-retry">Try again</button></div>`;
      const rb = $('#theme-retry'); if (rb) rb.addEventListener('click', () => startThemeCreation(pref));
    }
  }

  function renderPalette(palette) {
    $('#theme-palette').innerHTML = (palette || []).map(c => `<span class="swatch" style="background:${escapeHtml(c)}"></span>`).join('');
  }

  function renderFacetChooser(facets, cached) {
    const container = $('#facet-sections');
    container.innerHTML = '';
    // normalize facets into { facet, prompt?, options? }
    const byFacet = {};
    (facets || []).forEach(f => { byFacet[f.facet] = f; });

    FACET_ORDER.forEach(facet => {
      const f = byFacet[facet];
      if (!f) return;
      const section = document.createElement('div');
      section.className = 'facet-section';
      section.innerHTML = `<div class="facet-label">${FACET_LABELS[facet]}</div>`;
      const row = document.createElement('div');
      row.className = 'facet-variations';
      section.appendChild(row);
      container.appendChild(section);

      if (cached && f.options) {
        state.facetImages[facet] = f.options.map(o => o.url);
        f.options.forEach((o, i) => row.appendChild(makeVariationTile(facet, o.url, i, o.hasItems, o.id)));
        // preselect first
        if (f.options[0]) selectVariation(facet, f.options[0].url, row.firstChild);
      } else {
        // miss: 3 shimmer slots, then generate 3 variations
        state.facetImages[facet] = [];
        for (let i = 0; i < 3; i++) {
          const slot = document.createElement('div');
          slot.className = 'facet-tile shimmer';
          slot.dataset.facet = facet;
          slot.dataset.idx = i;
          row.appendChild(slot);
        }
        generateFacetVariations(facet, f.prompt, row);
      }
    });
  }

  function makeVariationTile(facet, url, idx, hasItems, imageId) {
    const tile = document.createElement('div');
    tile.className = 'facet-tile';
    tile.dataset.facet = facet;
    tile.dataset.idx = idx;
    if (imageId) tile.dataset.imageId = imageId;
    tile.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy"><span class="facet-check">✓</span>`;
    tile.addEventListener('click', () => selectVariation(facet, url, tile));
    return tile;
  }

  function selectVariation(facet, url, tile) {
    state.chosen[facet] = url;
    const row = tile.parentElement;
    row.querySelectorAll('.facet-tile').forEach(t => t.classList.remove('selected'));
    tile.classList.add('selected');
    // enable "Use this theme" once all three facets have a pick
    const allChosen = FACET_ORDER.every(f => state.chosen[f]);
    $('#theme-use').disabled = !allChosen;
  }

  async function generateFacetVariations(facet, prompt, row) {
    const styleAnchor = state.theme.style_anchor || '';
    const fullPrompt = `${styleAnchor}\n\n${prompt}`.trim();
    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: fullPrompt, count: 3 }),
      });
      const d = await res.json();
      const images = d.images || [];
      state.facetImages[facet] = images;
      const slots = row.querySelectorAll('.facet-tile');
      slots.forEach((slot, i) => {
        if (images[i]) {
          const tile = makeVariationTile(facet, images[i], i, false);
          row.replaceChild(tile, slot);
        } else {
          slot.classList.remove('shimmer');
          slot.classList.add('facet-tile-empty');
          slot.innerHTML = '<span>no image</span>';
        }
      });
      // preselect first available
      const firstTile = row.querySelector('.facet-tile:not(.facet-tile-empty)');
      if (firstTile && !state.chosen[facet]) selectVariation(facet, images[0], firstTile);
    } catch (err) {
      row.querySelectorAll('.facet-tile').forEach(slot => {
        slot.classList.remove('shimmer');
        slot.classList.add('facet-tile-empty');
        slot.innerHTML = '<span>failed</span>';
      });
    }
  }

  // Regenerate (capped)
  const MAX_REGENERATIONS = 3;
  const themeRegenBtn = $('#theme-regen');
  if (themeRegenBtn) themeRegenBtn.addEventListener('click', () => {
    state.themeRegenCount = (state.themeRegenCount || 0) + 1;
    if (state.themeRegenCount >= MAX_REGENERATIONS) {
      themeRegenBtn.disabled = true;
      themeRegenBtn.textContent = 'No more looks';
    }
    startThemeCreation(data.partyPlan.themePreference || (data.partyPlan.theme && data.partyPlan.theme.name) || '');
  });

  const themeBackBtn = $('#theme-back');
  if (themeBackBtn) themeBackBtn.addEventListener('click', () => { hideScreen('theme-screen'); landingOverlay.classList.remove('hidden'); });

  const themeUseBtn = $('#theme-use');
  if (themeUseBtn) themeUseBtn.addEventListener('click', handleThemeAccepted);

  async function handleThemeAccepted() {
    // record theme on the plan
    data.partyPlan.theme = { name: state.theme.name || '', source: 'generated', palette: state.theme.palette || [] };
    saveData(data);
    renderPlanCard();
    sheetThemeName.textContent = state.theme.name || '';

    const chosenUrls = FACET_ORDER.map(f => state.chosen[f]).filter(Boolean);
    state.themeFacets = chosenUrls;

    // Save all generated variations to the library (miss path only)
    if (!state.cached) {
      const images = [];
      FACET_ORDER.forEach(facet => (state.facetImages[facet] || []).forEach(url => {
        if (url && url.startsWith('data:')) images.push({ facet, dataUrl: url });
      }));
      // fire and forget
      fetch('/api/save-theme', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: state.themeKey, theme: state.theme, images }),
      }).catch(() => {});
    }

    await runExtraction(chosenUrls);
  }

  // ══════════════════════════════════════
  //  EXTRACTION → DECIDE
  // ══════════════════════════════════════

  async function runExtraction(chosenUrls) {
    const overlay = $('#extraction-overlay');
    overlay.classList.remove('hidden');
    try {
      // convert data/library URLs to base64 for the vision call
      const payloads = [];
      for (const url of chosenUrls) {
        const parsed = await urlToBase64(url);
        if (parsed) payloads.push(parsed);
      }
      const items = await callExtractItems(payloads, []);
      // tag each item with the chosen facet image for thumbnails
      items.forEach(it => { it.source_url = chosenUrls[it.image_index] || chosenUrls[0]; });
      state.extractedItems = items;
      data.extractedItems = items;
      saveData(data);
      overlay.classList.add('hidden');
      hideScreen('theme-screen');
      renderDecideScreen(items);
    } catch (err) {
      overlay.classList.add('hidden');
      alert('Extraction failed: ' + err.message);
    }
  }

  // fetch any URL (data: or /themes/...) and return { base64, mediaType }, downscaled
  async function urlToBase64(url) {
    try {
      const blob = await (await fetch(url)).blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });
      return dataUrlToBase64(dataUrl);
    } catch { return null; }
  }

  function renderDecideScreen(items) {
    showScreen('decide-screen');
    $('#decide-sub').textContent = `${items.length} pieces found`;
    const container = $('#decide-sections');
    container.innerHTML = '';
    const selected = new Set();

    const grouped = {};
    items.forEach((it, i) => {
      const b = it.bucket || 'accent_decor';
      (grouped[b] = grouped[b] || []).push(i);
    });

    BUCKET_ORDER.forEach(bucket => {
      const idxs = grouped[bucket];
      if (!idxs || !idxs.length) return;
      const meta = BUCKET_META[bucket] || { label: bucket, icon: '', color: '#888' };
      // sort by importance desc
      idxs.sort((a, b) => (items[b].importance || 0) - (items[a].importance || 0));

      const section = document.createElement('details');
      section.className = 'decide-section';
      section.open = true;
      const summary = document.createElement('summary');
      summary.className = 'decide-summary';
      summary.innerHTML = `<span>${meta.icon} ${escapeHtml(meta.label)}</span><span class="decide-count"></span>`;
      section.appendChild(summary);

      idxs.forEach(i => {
        const it = items[i];
        selected.add(i); // hero pieces pre-checked
        const row = document.createElement('label');
        row.className = 'decide-row';
        const thumb = it.source_url ? buildBboxThumbnailStyle(it.source_url, it.bbox) : '';
        row.innerHTML = `<input type="checkbox" checked data-i="${i}">
          ${thumb ? `<span class="decide-thumb" style="${thumb}"></span>` : '<span class="decide-thumb empty"></span>'}
          <span class="decide-info"><span class="decide-name">${escapeHtml(it.item_name)}</span>
          <span class="decide-price">${typeof it.estimated_price === 'number' ? formatCurrency(it.estimated_price) : ''}</span></span>`;
        const cb = row.querySelector('input');
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(i); else selected.delete(i);
          updateDecideCounts();
        });
        section.appendChild(row);
      });
      container.appendChild(section);
    });

    function updateDecideCounts() {
      container.querySelectorAll('.decide-section').forEach(sec => {
        const boxes = sec.querySelectorAll('input[type=checkbox]');
        const on = Array.from(boxes).filter(b => b.checked).length;
        const c = sec.querySelector('.decide-count');
        if (c) c.textContent = `${on} of ${boxes.length}`;
      });
      $('#decide-shop').disabled = selected.size === 0;
      $('#decide-shop').textContent = `Find products (${selected.size})`;
    }
    updateDecideCounts();

    const shopBtn = $('#decide-shop');
    shopBtn.onclick = () => {
      const chosen = Array.from(selected).map(i => items[i]);
      runShop(chosen);
    };
  }

  const decideBackBtn = $('#decide-back');
  if (decideBackBtn) decideBackBtn.addEventListener('click', () => { hideScreen('decide-screen'); showScreen('theme-screen'); });

  // ══════════════════════════════════════
  //  SHOP → CART decision hub
  // ══════════════════════════════════════

  async function runShop(selectedItems) {
    const shopBtn = $('#decide-shop');
    shopBtn.disabled = true;
    shopBtn.textContent = 'Shopping for the best picks…';
    try {
      const res = await fetch('/api/shop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selectedItems, plan: data.partyPlan }),
      });
      const d = await res.json();
      const picks = (d.picks || []).filter(p => p.product);
      state.cart = picks.map(p => ({
        id: generateId(),
        item_name: p.item_name,
        bucket: p.bucket,
        product: p.product,
        quantity: p.quantity || 1,
        pack_size: p.pack_size || null,
        reason: p.reason || '',
      }));
      data.partyBucket = state.cart.slice();
      saveData(data);
      hideScreen('decide-screen');
      renderCart();
    } catch (err) {
      alert('Shopping failed: ' + err.message);
    } finally {
      shopBtn.disabled = false;
      shopBtn.textContent = 'Find products';
    }
  }

  function cartSubtotal() {
    return (state.cart || []).reduce((s, l) => s + (l.product.price || 0) * (l.quantity || 1), 0);
  }

  function renderCart() {
    showScreen('cart-screen');
    const list = $('#cart-list');
    list.innerHTML = '';
    $('#cart-sub').textContent = `${(state.cart || []).length} items`;

    (state.cart || []).forEach(line => {
      const card = document.createElement('div');
      card.className = 'cart-card';
      const retailer = line.product.retailer || 'retailer';
      const cta = line.product.link
        ? `<a class="cart-cta" href="${escapeHtml(line.product.link)}" target="_blank" rel="noopener">View on ${escapeHtml(retailer)} →</a>`
        : '';
      card.innerHTML = `
        <div class="cart-img">${line.product.thumbnail ? `<img src="${escapeHtml(line.product.thumbnail)}" alt="" loading="lazy">` : '<div class="cart-img-empty"></div>'}</div>
        <div class="cart-main">
          <div class="cart-name">${escapeHtml(line.item_name)}</div>
          <div class="cart-title">${escapeHtml(line.product.title || '')}</div>
          <div class="cart-price-row"><span class="cart-unit">${formatCurrency(line.product.price || 0)}</span>
            <span class="cart-line-total">${formatCurrency((line.product.price || 0) * (line.quantity || 1))}</span></div>
          <div class="cart-controls">
            <div class="pp-stepper cart-stepper">
              <button class="pp-step" data-act="dec">−</button>
              <span class="cart-qty">${line.quantity}</span>
              <button class="pp-step" data-act="inc">+</button>
            </div>
            ${cta}
            <button class="cart-remove" data-act="remove" aria-label="Remove">✕</button>
          </div>
          ${line.reason ? `<div class="cart-reason">${escapeHtml(line.reason)}</div>` : ''}
        </div>`;
      card.querySelector('[data-act=dec]').addEventListener('click', () => changeCartQty(line.id, -1));
      card.querySelector('[data-act=inc]').addEventListener('click', () => changeCartQty(line.id, 1));
      card.querySelector('[data-act=remove]').addEventListener('click', () => removeCartLine(line.id));
      list.appendChild(card);
    });

    renderBudgetTracker();
  }

  function changeCartQty(id, delta) {
    const line = (state.cart || []).find(l => l.id === id);
    if (!line) return;
    line.quantity = Math.max(1, (line.quantity || 1) + delta);
    data.partyBucket = state.cart.slice();
    saveData(data);
    renderCart();
  }

  function removeCartLine(id) {
    state.cart = (state.cart || []).filter(l => l.id !== id);
    data.partyBucket = state.cart.slice();
    saveData(data);
    updateBucketUI();
    renderCart();
  }

  function renderBudgetTracker() {
    const budget = data.partyPlan.budget;
    const subtotal = cartSubtotal();
    const fill = $('#budget-fill');
    const label = $('#budget-label');
    if (!budget) {
      fill.style.width = '0%';
      label.textContent = `Subtotal: ${formatCurrency(subtotal)}`;
      $('#budget-tracker').classList.remove('over');
      return;
    }
    const pct = Math.min(100, (subtotal / budget) * 100);
    fill.style.width = pct + '%';
    const over = subtotal > budget;
    $('#budget-tracker').classList.toggle('over', over);
    label.textContent = over
      ? `${formatCurrency(subtotal)} — ${formatCurrency(subtotal - budget)} over your ${formatCurrency(budget)} budget`
      : `You've used ${formatCurrency(subtotal)} of ${formatCurrency(budget)}`;
  }

  const cartBackBtn = $('#cart-back');
  if (cartBackBtn) cartBackBtn.addEventListener('click', () => { hideScreen('cart-screen'); showScreen('decide-screen'); });

  const cartCheckoutBtn = $('#cart-checkout');
  if (cartCheckoutBtn) cartCheckoutBtn.addEventListener('click', () => {
    // hand the consolidated cart to the existing checkout flow
    data.partyBucket = (state.cart || []).map(l => ({
      id: l.id, name: l.product.title || l.item_name, price: l.product.price || 0,
      store: l.product.retailer || 'Google Shopping', bucket: l.bucket, quantity: l.quantity || 1,
      url: l.product.link || '', image: l.product.thumbnail || '',
    }));
    saveData(data);
    updateBucketUI();
    hideScreen('cart-screen');
    setSheetState('full');
    bucketCheckoutBtn.click();
  });

  // ══════════════════════════════════════
  //  EXTRACTED ITEMS IN BOTTOM SHEET
  // ══════════════════════════════════════

  function renderExtractedItemsInSheet(items) {
    sheetItemsList.innerHTML = '';
    sheetProducts.innerHTML = '';

    const grouped = {};
    for (const item of items) {
      const b = item.bucket || 'accent_decor';
      if (!grouped[b]) grouped[b] = [];
      grouped[b].push(item);
    }

    // Render bucket icons
    renderBucketIcons(grouped);

    const checkedKeys = new Set(items.map((_, i) => 'item_' + i));

    for (const bucket of BUCKET_ORDER) {
      const bucketItems = grouped[bucket];
      if (!bucketItems || bucketItems.length === 0) continue;

      const meta = BUCKET_META[bucket] || { label: bucket, icon: '', color: '#636e72' };

      const section = document.createElement('div');
      section.className = 'extraction-section';

      const header = document.createElement('div');
      header.className = 'extraction-section-header';
      header.style.background = meta.color;
      header.innerHTML = `<span class="extraction-section-title" style="color:white">${meta.icon} ${escapeHtml(meta.label)}</span>
        <span class="extraction-section-subtitle" style="color:rgba(255,255,255,0.8)">${bucketItems.length} item${bucketItems.length > 1 ? 's' : ''}</span>`;
      section.appendChild(header);

      const list = document.createElement('div');
      list.className = 'extracted-items-list';

      bucketItems.forEach((item, bi) => {
        const globalIdx = items.indexOf(item);
        const key = 'item_' + globalIdx;
        const imgUrl = item.source_url || state.inspirationUrls[item.image_index] || '';
        const thumbUrl = buildImageKitCropUrl(imgUrl, item.crop);

        const row = document.createElement('div');
        row.className = 'extracted-item-row';
        row.innerHTML = `<label class="extracted-item-label">
          <input type="checkbox" checked class="extracted-item-check" data-key="${key}">
          ${thumbUrl ? `<div class="extracted-item-thumb"><img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy"></div>` : '<div class="extracted-item-thumb extracted-item-thumb-empty"></div>'}
          <div class="extracted-item-info">
            <span class="extracted-item-name">${escapeHtml(item.item_name)}</span>
            <span class="extracted-item-meta">${typeof item.estimated_price === 'number' ? formatCurrency(item.estimated_price) : escapeHtml(String(item.estimated_price || ''))}</span>
          </div>
        </label>`;

        const cb = row.querySelector('input');
        cb.addEventListener('change', () => {
          if (cb.checked) checkedKeys.add(key);
          else checkedKeys.delete(key);
          findBtn.textContent = `Find Products (${checkedKeys.size})`;
          findBtn.disabled = checkedKeys.size === 0;
        });

        list.appendChild(row);
      });

      section.appendChild(list);
      sheetItemsList.appendChild(section);
    }

    // Find Products button
    const actions = document.createElement('div');
    actions.className = 'checklist-actions';
    actions.style.padding = '12px 16px';
    const findBtn = document.createElement('button');
    findBtn.className = 'btn btn-primary checklist-confirm-btn';
    findBtn.textContent = `Find Products (${checkedKeys.size})`;
    findBtn.addEventListener('click', () => {
      const confirmed = items.filter((_, i) => checkedKeys.has('item_' + i));
      findBtn.disabled = true;
      findBtn.textContent = 'Searching...';
      sheetItemsList.querySelectorAll('input').forEach(cb => cb.disabled = true);
      handleFindProducts(confirmed);
    });
    actions.appendChild(findBtn);
    sheetItemsList.appendChild(actions);
  }

  function renderBucketIcons(grouped) {
    sheetBuckets.innerHTML = '';
    for (const bucket of BUCKET_ORDER) {
      const items = grouped[bucket] || [];
      const meta = BUCKET_META[bucket];
      const btn = document.createElement('button');
      btn.className = 'sheet-bucket-icon' + (items.length > 0 ? '' : '');
      btn.dataset.bucket = bucket;
      btn.innerHTML = `
        <span class="sheet-bucket-emoji">${meta.icon}</span>
        ${items.length > 0 ? `<span class="sheet-bucket-count">${items.length}</span>` : ''}
        <span class="sheet-bucket-label">${meta.label.split(' ')[0]}</span>
      `;
      btn.addEventListener('click', () => {
        $$('.sheet-bucket-icon').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const section = sheetItemsList.querySelectorAll('.extraction-section');
        section.forEach(s => s.style.display = '');
        // scroll to this bucket's section
        const idx = BUCKET_ORDER.indexOf(bucket);
        if (section[idx]) section[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      sheetBuckets.appendChild(btn);
    }
  }

  // ══════════════════════════════════════
  //  PRODUCT SEARCH
  // ══════════════════════════════════════

  async function handleFindProducts(confirmedItems) {
    sheetProducts.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:8px;font-size:0.85rem;color:var(--text-light);">Searching products...</p></div>';
    setSheetState('full');

    const allResults = [];
    for (const item of confirmedItems) {
      const [products, kits] = await Promise.all([
        callSearchProducts(item.search_query, 3),
        callSearchKits(item.search_query, 2),
      ]);
      allResults.push({ item, products, kits });
    }

    renderProductResults(allResults);
  }

  function renderProductResults(allResults) {
    sheetProducts.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'checklist-heading';
    heading.innerHTML = '<strong>Product Matches</strong><br>Check items to add to your party bucket.';
    sheetProducts.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'product-results-list';

    const selectedProducts = new Map();

    allResults.forEach(({ item, products, kits }) => {
      const combined = [...(kits || []), ...(products || [])];
      if (combined.length === 0) return;

      const groupLabel = document.createElement('div');
      groupLabel.className = 'product-group-label';
      groupLabel.textContent = item.item_name;
      list.appendChild(groupLabel);

      combined.forEach((product, pi) => {
        const key = `${item.item_name}-${pi}`;
        const isFirst = pi === 0;
        if (isFirst) selectedProducts.set(key, { product, bucket: item.bucket });

        const row = document.createElement('div');
        row.className = 'product-result-row';
        row.innerHTML = `<label class="product-result-label">
          <input type="checkbox" ${isFirst ? 'checked' : ''} class="product-result-check" data-key="${escapeHtml(key)}">
          <div class="product-result-image">
            ${product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy">` : '<div class="product-no-image">No img</div>'}
          </div>
          <div class="product-result-info">
            <span class="product-result-name">${escapeHtml(product.name)}</span>
            <span class="product-result-price">${product.price ? formatCurrency(product.price) : 'Price N/A'}</span>
            <span class="product-result-retailer">${escapeHtml(product.retailer || '')}</span>
            ${product.url ? `<a href="${escapeHtml(product.url)}" target="_blank" rel="noopener" class="product-result-link" onclick="event.stopPropagation()">View &rarr;</a>` : ''}
          </div>
        </label>`;

        const cb = row.querySelector('input');
        cb.addEventListener('change', () => {
          if (cb.checked) selectedProducts.set(key, { product, bucket: item.bucket });
          else selectedProducts.delete(key);
          const total = Array.from(selectedProducts.values()).reduce((s, v) => s + (v.product.price || 0), 0);
          addBtn.textContent = `Add to Bucket (${selectedProducts.size} · ${formatCurrency(total)})`;
          addBtn.disabled = selectedProducts.size === 0;
        });

        list.appendChild(row);
      });
    });

    if (list.children.length === 0) {
      list.innerHTML = '<div class="product-no-results">No products found. Try adjusting your selections.</div>';
    }

    sheetProducts.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'checklist-actions';
    actions.style.padding = '12px 0';
    const total = Array.from(selectedProducts.values()).reduce((s, v) => s + (v.product.price || 0), 0);
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary checklist-confirm-btn';
    addBtn.textContent = `Add to Bucket (${selectedProducts.size} · ${formatCurrency(total)})`;
    addBtn.disabled = selectedProducts.size === 0;
    addBtn.addEventListener('click', () => {
      addProductsToBucket(selectedProducts);
      addBtn.disabled = true;
      addBtn.textContent = 'Added!';
      list.querySelectorAll('input').forEach(cb => cb.disabled = true);
    });
    actions.appendChild(addBtn);
    sheetProducts.appendChild(actions);
  }

  function addProductsToBucket(selectedProducts) {
    for (const [, { product, bucket }] of selectedProducts) {
      data.partyBucket.push({
        id: generateId(),
        name: product.name,
        price: product.price || 0,
        store: product.retailer || 'Google Shopping',
        bucket: bucket || 'accent_decor',
        quantity: 1,
        url: product.url || '',
        image: product.image || '',
      });
    }
    saveData(data);
    updateBucketUI();
    addChatMessage('assistant', `Added ${selectedProducts.size} items to your bucket! Total: ${formatCurrency(getBucketTotal())}.`);
  }

  // ══════════════════════════════════════
  //  CHAT DRAWER
  // ══════════════════════════════════════

  function openChatDrawer() {
    state.chatOpen = true;
    chatDrawer.classList.add('open');
    chatDrawerBackdrop.classList.remove('hidden');
    scrollChatToBottom();
  }

  function closeChatDrawer() {
    state.chatOpen = false;
    chatDrawer.classList.remove('open');
    chatDrawerBackdrop.classList.add('hidden');
  }

  chatOpenBtn.addEventListener('click', openChatDrawer);
  chatDrawerClose.addEventListener('click', closeChatDrawer);
  chatDrawerBackdrop.addEventListener('click', closeChatDrawer);

  function addChatMessage(role, text) {
    const el = document.createElement('div');
    el.className = `chat-message ${role}`;
    el.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    chatMessages.appendChild(el);
    data.chatHistory.push({ role, text });
    saveData(data);
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  // Chat send
  chatSendBtn.addEventListener('click', handleChatSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  });

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  async function handleChatSend() {
    const text = chatInput.value.trim();
    if (!text && pendingChatImages.length === 0) return;

    chatInput.value = '';
    chatInput.style.height = 'auto';

    // If user has images pending, handle as direct inspiration upload
    if (pendingChatImages.length > 0) {
      const images = pendingChatImages.map(img => ({
        base64: img.base64,
        mediaType: img.mediaType,
      }));
      pendingChatImages = [];
      renderChatImagePreview();

      if (text) addChatMessage('user', text);
      addChatMessage('user', `Uploaded ${images.length} image${images.length > 1 ? 's' : ''} for analysis.`);
      addChatMessage('assistant', 'Analyzing your images...');

      const items = await callExtractItems(images, []);
      state.extractedItems = items;
      data.extractedItems = items;
      saveData(data);
      closeChatDrawer();
      renderExtractedItemsInSheet(items);
      if (items.length > 0) {
        sheetThemeName.textContent = 'Your Party Items';
        sheetItemCount.textContent = `${items.length} items found`;
        setSheetState('half');
      }
      return;
    }

    if (text) addChatMessage('user', text);
    state.apiMessages.push({ role: 'user', content: text });
    await sendToLLM();
  }

  async function sendToLLM() {

    const typingEl = document.createElement('div');
    typingEl.className = 'chat-message assistant';
    typingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(typingEl);
    scrollChatToBottom();

    const result = await callClaude(state.apiMessages);
    typingEl.remove();

    if (!result || result.error) {
      addChatMessage('assistant', 'Sorry, something went wrong. ' + (result?.error || ''));
      return;
    }

    const content = result.content || [];
    state.apiMessages.push({ role: 'assistant', content });

    const texts = content.filter(b => b.type === 'text').map(b => b.text);
    if (texts.length > 0) {
      addChatMessage('assistant', texts.join('\n'));
    }

    // Handle tool calls
    const toolUses = content.filter(b => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const toolResults = [];
      for (const tool of toolUses) {
        const result = await processToolCall(tool);
        toolResults.push(result);
      }
      state.apiMessages.push({ role: 'user', content: toolResults });
      saveData(data);

      // Let Claude respond to tool results
      await sendToLLMContinue();
    }
  }

  async function sendToLLMContinue() {
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-message assistant';
    typingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(typingEl);
    scrollChatToBottom();

    const result = await callClaude(state.apiMessages);
    typingEl.remove();

    if (!result || result.error || !result.content) return;

    state.apiMessages.push({ role: 'assistant', content: result.content });

    const texts = result.content.filter(b => b.type === 'text').map(b => b.text);
    if (texts.length > 0) {
      addChatMessage('assistant', texts.join('\n'));
    }

    const toolUses = result.content.filter(b => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const toolResults = [];
      for (const tool of toolUses) {
        const r = await processToolCall(tool);
        toolResults.push(r);
      }
      state.apiMessages.push({ role: 'user', content: toolResults });
      saveData(data);
      await sendToLLMContinue();
    }
  }

  async function processToolCall(tool) {
    if (tool.name === 'update_party_plan') {
      const inp = tool.input || {};
      applyPlanUpdate(inp);
      const recorded = [];
      if (inp.eventType != null) recorded.push(`type=${inp.eventType}`);
      if (inp.budget != null) recorded.push(`budget=$${inp.budget}`);
      if (inp.guestCount != null) recorded.push(`people=${inp.guestCount}`);
      if (inp.setting != null) recorded.push(`setting=${inp.setting}`);
      if (inp.themePreference != null) recorded.push(`theme=${inp.themePreference}`);
      const plan = data.partyPlan;
      const ready = !!plan.eventType && !!(plan.themePreference || plan.theme);
      return {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: `Cards updated (${recorded.join(', ') || 'no changes'}).` +
          (ready ? ' Party type and theme are set — you may call create_theme, or invite the user to tap "Design my theme".' : ' Still missing party type or theme.'),
      };
    }

    if (tool.name === 'create_theme') {
      const inp = tool.input || {};
      const pref = inp.theme_preference || data.partyPlan.themePreference || (data.partyPlan.theme && data.partyPlan.theme.name) || '';
      closeChatDrawer();
      startThemeCreation(pref);
      return {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: `Opened the theme designer for "${pref}". The user is choosing their favorite look per section.`,
      };
    }

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
            quantity: 1,
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
        }
      }
      saveData(data);
      updateBucketUI();
      return {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: results.join('. ') + `. Bucket: ${data.partyBucket.length} items, ${formatCurrency(getBucketTotal())}.`,
      };
    }

    return { type: 'tool_result', tool_use_id: tool.id, content: 'Unknown tool.' };
  }

  // Chat image uploads
  let pendingChatImages = [];

  chatUploadBtn.addEventListener('click', () => chatUploadInput.click());

  chatUploadInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (!file.type.startsWith('image/') || pendingChatImages.length >= 10) continue;
      const dataUrl = await compressImage(file, 800, 0.8);
      const parsed = dataUrlToBase64(dataUrl);
      if (parsed) pendingChatImages.push({ ...parsed, dataUrl });
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
    `).join('') + `<span style="font-size:0.75rem;color:var(--text-light)">${pendingChatImages.length}/10</span>`;

    chatImagePreview.querySelectorAll('.chat-preview-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingChatImages.splice(parseInt(btn.dataset.idx), 1);
        renderChatImagePreview();
      });
    });
  }

  // ══════════════════════════════════════
  //  BUCKET MANAGEMENT
  // ══════════════════════════════════════

  function getBucketTotal() {
    return data.partyBucket.reduce((s, item) => s + (item.price * (item.quantity || 1)), 0);
  }

  function updateBucketUI() {
    const count = data.partyBucket.length;
    bucketCountBadge.textContent = count;
    bucketTotalPrice.textContent = formatCurrency(getBucketTotal());
    bucketCheckoutBtn.disabled = count === 0;
    bucketCheckoutBtn.textContent = count > 0 ? `Checkout (${formatCurrency(getBucketTotal())})` : 'Checkout';
  }

  // ══════════════════════════════════════
  //  ZOOM MODAL
  // ══════════════════════════════════════

  function showZoomModal(imageUrl, bbox, label) {
    zoomModalLabel.textContent = label || '';
    zoomModalImageWrap.innerHTML = '';

    if (bbox && bbox.length >= 4) {
      const div = document.createElement('div');
      div.style.cssText = `width:300px;height:300px;${buildBboxThumbnailStyle(imageUrl, bbox)}`;
      zoomModalImageWrap.appendChild(div);
    } else {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = label || '';
      zoomModalImageWrap.appendChild(img);
    }

    zoomModal.classList.remove('hidden');
  }

  zoomModalClose.addEventListener('click', () => zoomModal.classList.add('hidden'));
  zoomModal.querySelector('.zoom-modal-backdrop').addEventListener('click', () => zoomModal.classList.add('hidden'));

  // ══════════════════════════════════════
  //  CONTEXT MENU
  // ══════════════════════════════════════

  let contextMenuTarget = null;

  function showContextMenu(x, y, anchor) {
    contextMenuTarget = anchor;
    contextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    contextMenu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
    contextMenu.classList.remove('hidden');
  }

  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.classList.add('hidden');
    }
  });

  $$('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      contextMenu.classList.add('hidden');
      if (!contextMenuTarget) return;

      if (action === 'zoom' && data.spacePhoto) {
        showZoomModal(data.spacePhoto, null, contextMenuTarget.label);
      } else if (action === 'find-products') {
        openChatDrawer();
        chatInput.value = `Find products for ${contextMenuTarget.label}`;
        handleChatSend();
      } else if (action === 'remove') {
        const dot = $(`[data-anchor-id="${contextMenuTarget.id}"]`);
        if (dot) dot.remove();
      }
    });
  });

  // ══════════════════════════════════════
  //  CHECKOUT (UCP)
  // ══════════════════════════════════════

  let stripeInstance = null;
  let stripeCardElement = null;
  let checkoutPlan = null;

  function getStripe() {
    if (!stripeInstance && window.Stripe) {
      stripeInstance = window.Stripe(localStorage.getItem('partyplanner_stripe_pk') || 'pk_test_placeholder');
    }
    return stripeInstance;
  }

  bucketCheckoutBtn.addEventListener('click', async () => {
    if (data.partyBucket.length === 0) return;
    sheetCheckout.classList.remove('hidden');
    sheetItemsList.style.display = 'none';
    sheetProducts.style.display = 'none';
    setSheetState('full');
    await renderCheckoutSummary();
    initStripeElements();
  });

  function initStripeElements() {
    const stripe = getStripe();
    if (!stripe || stripeCardElement) return;
    const elements = stripe.elements();
    stripeCardElement = elements.create('card', {
      style: { base: { fontSize: '16px', color: '#2d3436', '::placeholder': { color: '#aab7c4' } } },
    });
    stripeCardElement.mount('#stripe-card-element');
    stripeCardElement.on('change', (event) => {
      const el = $('#stripe-card-errors');
      if (el) el.textContent = event.error ? event.error.message : '';
    });
  }

  async function renderCheckoutSummary() {
    const summaryEl = $('#checkout-summary');
    const retailersEl = $('#checkout-retailers');

    summaryEl.innerHTML = '<div style="text-align:center;padding:10px;"><div class="spinner" style="margin:0 auto;"></div></div>';

    try {
      const res = await fetch('/api/checkout/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: data.partyBucket }),
      });
      checkoutPlan = await res.json();
    } catch {
      checkoutPlan = { retailers: [], unsupported: [] };
    }

    const total = getBucketTotal();

    let html = '';
    for (const r of (checkoutPlan.retailers || [])) {
      const badge = r.method === 'ucp'
        ? '<span class="checkout-badge ucp">UCP</span>'
        : '<span class="checkout-badge amazon">Cart Link</span>';
      html += `<div class="checkout-retailer-group">
        <div class="checkout-retailer-header"><strong>${escapeHtml(r.name)}</strong>${badge}</div>
        <div class="checkout-retailer-items">
          ${r.items.map(it => `<div class="checkout-line-item"><span>${escapeHtml(it.name)}</span><span>${formatCurrency(it.price * (it.quantity || 1))}</span></div>`).join('')}
        </div>
        <div class="checkout-retailer-subtotal">Subtotal: ${formatCurrency(r.total)}</div>
      </div>`;
    }

    if ((checkoutPlan.unsupported || []).length > 0) {
      html += `<div class="checkout-retailer-group">
        <div class="checkout-retailer-header"><strong>Other</strong><span class="checkout-badge other">Direct</span></div>
        <div class="checkout-retailer-items">
          ${checkoutPlan.unsupported.map(it => `<div class="checkout-line-item"><span>${escapeHtml(it.name)}</span><span>${formatCurrency(it.price)}</span></div>`).join('')}
        </div>
      </div>`;
    }

    retailersEl.innerHTML = html;
    summaryEl.innerHTML = `<div class="checkout-summary-total"><strong>Total (${data.partyBucket.length} items)</strong><strong>${formatCurrency(total)}</strong></div>`;
  }

  $('#checkout-place-order-btn').addEventListener('click', handlePlaceOrder);

  async function handlePlaceOrder() {
    const btn = $('#checkout-place-order-btn');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    const buyerInfo = {
      firstName: ($('#checkout-name').value.trim().split(' ')[0]) || '',
      lastName: ($('#checkout-name').value.trim().split(' ').slice(1).join(' ')) || '',
      email: $('#checkout-email').value.trim(),
      address: {
        street: $('#checkout-street').value.trim(),
        city: $('#checkout-city').value.trim(),
        state: $('#checkout-state').value.trim(),
        zip: $('#checkout-zip').value.trim(),
        country: 'US',
      },
    };

    if (!buyerInfo.email || !buyerInfo.address.street) {
      btn.disabled = false;
      btn.textContent = 'Place Order';
      alert('Please fill in your email and shipping address.');
      return;
    }

    let stripeToken = null;
    const stripe = getStripe();
    if (stripe && stripeCardElement) {
      try {
        const { token, error } = await stripe.createToken(stripeCardElement);
        if (error) {
          $('#stripe-card-errors').textContent = error.message;
          btn.disabled = false;
          btn.textContent = 'Place Order';
          return;
        }
        stripeToken = token.id;
      } catch (err) {
        console.error('Stripe error:', err);
      }
    }

    const results = [];
    for (const retailer of (checkoutPlan.retailers || [])) {
      if (retailer.method === 'ucp') {
        try {
          const createRes = await fetch('/api/checkout/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ retailerKey: retailer.key, items: retailer.items, buyerInfo }),
          });
          const session = await createRes.json();

          if (session.error || session.fallback) {
            results.push({ retailer: retailer.name, status: 'fallback', items: retailer.items, message: session.error || 'UCP unavailable' });
            continue;
          }

          if (stripeToken && session.sessionId) {
            const completeRes = await fetch('/api/checkout/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ retailerKey: retailer.key, sessionId: session.sessionId, paymentToken: { token: stripeToken, handlerId: 'com.stripe' } }),
            });
            const order = await completeRes.json();
            results.push({ retailer: retailer.name, status: order.error ? 'fallback' : 'completed', orderId: order.orderId, orderUrl: order.orderUrl, message: order.error });
          } else {
            results.push({ retailer: retailer.name, status: 'fallback', message: 'No payment token' });
          }
        } catch (err) {
          results.push({ retailer: retailer.name, status: 'fallback', items: retailer.items, message: err.message });
        }
      } else if (retailer.method === 'cart_url' && retailer.cartUrl) {
        results.push({ retailer: retailer.name, status: 'cart_url', cartUrl: retailer.cartUrl });
      }
    }

    showCheckoutResults(results);
  }

  function showCheckoutResults(results) {
    let html = '<div class="checkout-success"><div class="checkout-success-icon">&#x2714;</div><h4>Checkout Summary</h4>';
    for (const r of results) {
      if (r.status === 'completed') {
        html += `<div class="checkout-result-item checkout-result-success"><strong>${escapeHtml(r.retailer)}</strong> — Order placed!</div>`;
      } else if (r.status === 'cart_url') {
        html += `<div class="checkout-result-item checkout-result-cart"><strong>${escapeHtml(r.retailer)}</strong><a href="${escapeHtml(r.cartUrl)}" target="_blank" class="btn btn-primary btn-sm">Open Cart</a></div>`;
      } else {
        const links = (r.items || []).filter(it => it.url).map(it => `<a href="${escapeHtml(it.url)}" target="_blank" class="product-result-link">${escapeHtml(it.name)}</a>`).join('');
        html += `<div class="checkout-result-item checkout-result-fallback"><strong>${escapeHtml(r.retailer)}</strong> — ${escapeHtml(r.message || 'Use links')}<div class="checkout-fallback-links">${links}</div></div>`;
      }
    }
    html += `<p style="margin-top:8px;font-size:0.85rem;color:var(--text-light)">${data.partyBucket.length} items — ${formatCurrency(getBucketTotal())}</p>`;
    html += '<button class="btn btn-primary" id="checkout-done-btn" style="margin-top:16px">Done</button></div>';

    sheetCheckout.innerHTML = html;
    $('#checkout-done-btn').addEventListener('click', () => {
      data.partyBucket = [];
      saveData(data);
      updateBucketUI();
      sheetCheckout.classList.add('hidden');
      sheetCheckout.innerHTML = '';
      sheetItemsList.style.display = '';
      sheetProducts.style.display = '';
      setSheetState('collapsed');
    });
  }

  // ══════════════════════════════════════
  //  SETTINGS
  // ══════════════════════════════════════

  settingsBtn.addEventListener('click', () => openModal('settings-modal'));

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#openai-key').value.trim();
    if (key) localStorage.setItem('partyplanner_openai_key', key);
    else localStorage.removeItem('partyplanner_openai_key');
    closeModal('settings-modal');
  });

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  $$('.modal-close, [data-modal]').forEach(el => {
    el.addEventListener('click', () => {
      const modalId = el.dataset.modal;
      if (modalId) closeModal(modalId);
    });
  });

  $$('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', () => {
      const modal = backdrop.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });

  // ══════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════

  function init() {
    updateBucketUI();

    // Home: cards-first party builder
    renderHomeCards();
    refreshDesignBtn();
    renderPlanCard();
    if (data.partyPlan && data.partyPlan.theme) {
      sheetThemeName.textContent = data.partyPlan.theme.name || '';
    }

    // Restore cart (if a shopping session was in progress)
    if (data.partyBucket && data.partyBucket.length > 0) {
      state.cart = data.partyBucket.filter(l => l.product).map(l => ({ ...l }));
    }

    // Restore chat
    if (data.chatHistory && data.chatHistory.length > 0) {
      chatMessages.innerHTML = '';
      data.chatHistory.forEach(msg => {
        const el = document.createElement('div');
        el.className = `chat-message ${msg.role}`;
        el.innerHTML = escapeHtml(msg.text).replace(/\n/g, '<br>');
        chatMessages.appendChild(el);
      });
    }
  }

  window.app = {
    removeBucketItem(id) {
      data.partyBucket = data.partyBucket.filter(b => b.id !== id);
      saveData(data);
      updateBucketUI();
    },
    changeQuantity(id, delta) {
      const item = data.partyBucket.find(b => b.id === id);
      if (!item) return;
      const newQty = (item.quantity || 1) + delta;
      if (newQty < 1) { this.removeBucketItem(id); return; }
      item.quantity = newQty;
      saveData(data);
      updateBucketUI();
    },
  };

  init();
})();
