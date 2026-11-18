(function () {
  'use strict';

  // ══════════════════════════════════════
  //  DATA LAYER
  // ══════════════════════════════════════

  // All state machines live in machines.js (pure, unit-tested). See that file
  // for the journey / plan / cart / agent / designer definitions.
  const M = window.PartyMachines;
  const emptyPlan = M.emptyPlan;

  // Persisted shape (localStorage 'partyplanner'):
  //   partyPlan       — see M.emptyPlan()
  //   partyBucket     — canonical cart lines, see M.normalizeLine()
  //   chatHistory     — [{ role, text }] transcript
  //   extractedItems  — last detected pieces (inputs to the Decide stage)
  //   stage           — last journey stage (resumed via M.resumeStage)
  function loadData() {
    const defaults = {
      partyPlan: emptyPlan(),
      partyBucket: [],
      chatHistory: [],
      extractedItems: [],
      inspirationUrls: [],
      stage: 'home',
    };
    try {
      const raw = localStorage.getItem('partyplanner');
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        ...defaults, ...parsed,
        partyPlan: { ...emptyPlan(), ...(parsed.partyPlan || {}) },
        partyBucket: M.normalizeCart(parsed.partyBucket), // migrates legacy line shapes
      };
    } catch { return defaults; }
  }

  function saveData(d) {
    try { localStorage.setItem('partyplanner', JSON.stringify(d)); } catch (e) { console.warn('[partyplanner] save failed', e); }
  }

  let data = loadData();

  // ══════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════

  const state = {
    apiMessages: M.messagesFromTranscript(data.chatHistory), // agent memory survives reload
    manifest: { themes: [] },
    inspirationUrls: [],
    extractedItems: data.extractedItems || [],
    sheetState: 'collapsed',  // collapsed | half | full
    sheetMode: 'browse',      // browse | checkout | results
    chatOpen: false,
  };

  const journey = M.createJourney(M.resumeStage(data.stage, data));
  const agent = M.createAgent();
  const designer = M.createDesigner();

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
    tabletop:        { label: 'Tabletop',          icon: '\u{1F37D}', color: '#5b6b5e' },
    wall_backdrop:   { label: 'Wall & Backdrop',    icon: '\u{1F3A8}', color: '#8a5a44' },
    accent_decor:    { label: 'Accent Decor',       icon: '\u{1F56F}', color: '#6b6457' },
    activity_favors: { label: 'Activity & Favors',  icon: '\u{1F381}', color: '#8a7240' },
    food_display:    { label: 'Food Display',       icon: '\u{1F382}', color: '#4f6170' },
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
      `  Theme: ${M.themeLabel(plan) || '(not set)'}${plan.theme ? ' (designed)' : ''}`,
    ];
    return PLANNER_SYSTEM_BASE + '\n' + planLines.join('\n') + '\n\n' + describeAppState();
  }

  // One snapshot of "where we are", shared by the agent prompt, tool results
  // and the window.partyplanner debug handle.
  function snapshot() {
    const lines = data.partyBucket;
    return {
      stage: journey.state,
      allowedEvents: journey.events(),
      readiness: M.planReadiness(data.partyPlan),
      cart: { lines: lines.length, ...M.budgetStatus(lines, data.partyPlan.budget) },
      designer: { status: designer.status, regensLeft: designer.regensLeft() },
      agent: agent.state,
      sheet: { position: state.sheetState, mode: state.sheetMode },
    };
  }

  function describeAppState() {
    const s = snapshot();
    const can = [];
    if (journey.can('DESIGN')) can.push(s.readiness.ready ? 'create_theme (opens the designer)' : `create_theme once ${s.readiness.missing.join(' and ')} ${s.readiness.missing.length > 1 ? 'are' : 'is'} set`);
    if (s.cart.lines) can.push('update_party_bucket (add/remove cart lines)');
    const budget = s.cart.state === 'no_budget' ? 'no budget set'
      : `${s.cart.state === 'over' ? 'over' : 'under'} the $${s.cart.budget} budget by $${s.cart.delta.toFixed(2)}`;
    return [
      'CURRENT APP STATE:',
      `  Stage: ${s.stage} — the user is ${M.STAGE_DESCRIPTION[s.stage]}.`,
      `  Cart: ${s.cart.lines} lines, ${formatCurrency(s.cart.subtotal)} (${budget}).`,
      `  You can: ${can.join('; ') || 'answer questions'}.`,
    ].join('\n');
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

  // POST JSON and normalize failures into { error } so callers can branch on
  // an explicit outcome instead of guessing from an empty array.
  async function postJson(url, body, signal) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) return { ...d, error: d.detail || d.error?.message || d.error || `HTTP ${res.status}` };
      return d;
    } catch (err) {
      if (err.name === 'AbortError') return { aborted: true, error: 'aborted' };
      return { error: err.message || 'Network error' };
    }
  }

  // → { items, error? }
  async function callExtractItems(images, spaceAnchors) {
    const d = await postJson('/api/extract-items', { images, space_anchors: spaceAnchors });
    if (d.error) console.error('Extract items failed:', d.error);
    return { items: d.items || [], error: d.error || null };
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

  // Sheet content mode: browse (plan/items/products) | checkout (form) | results.
  // The checkout form is never destroyed — results render in their own node.
  let checkoutResultsEl = null;
  function setSheetMode(mode) {
    state.sheetMode = mode;
    if (!checkoutResultsEl) {
      checkoutResultsEl = document.createElement('div');
      checkoutResultsEl.id = 'checkout-results';
      checkoutResultsEl.className = 'checkout-results hidden';
      sheetCheckout.appendChild(checkoutResultsEl);
    }
    const browsing = mode === 'browse';
    sheetItemsList.style.display = browsing ? '' : 'none';
    sheetProducts.style.display = browsing ? '' : 'none';
    planCard.style.display = browsing ? '' : 'none'; // checkout leads with the order
    sheetBody.scrollTop = 0;
    sheetCheckout.classList.toggle('hidden', browsing);
    sheetCheckout.querySelectorAll(':scope > :not(#checkout-results)').forEach((el) => { el.style.display = mode === 'checkout' ? '' : 'none'; });
    checkoutResultsEl.classList.toggle('hidden', mode !== 'results');
    if (browsing) checkoutResultsEl.innerHTML = '';
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

  // Bucket badge: on Home it toggles the sheet; on a full-screen step (sheet is
  // offstage) it jumps to the cart if there is one.
  bucketBadgeBtn.addEventListener('click', () => {
    if (journey.state !== 'home') {
      if (data.partyBucket.length && journey.can('OPEN_CART')) journey.send('OPEN_CART');
      return;
    }
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
    if (key === 'theme') return M.themeLabel(plan);
    const v = plan[key];
    if (v == null || v === '') return null;
    if (key === 'budget') return '$' + v;
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
    planCard.innerHTML = `<div class="plan-card-title">Your party plan</div><div class="plan-card-rows">${rows}</div>`;
  }

  // Merge free-text-derived fields into the plan (used by the chat-assist agent).
  function applyPlanUpdate(fields, opts) {
    const result = M.applyPlanUpdate(data.partyPlan, fields);
    data.partyPlan = result.plan;
    saveData(data);
    renderPlanCard();
    renderHomeCards(opts && opts.flash ? result.changed.map(k => FIELD_OF_CHANGE[k]) : null);
    refreshDesignBtn();
    if (result.invalidatedTheme) sheetThemeName.textContent = M.themeLabel(data.partyPlan) || 'No theme selected';
    if (journey.state === 'cart') renderBudgetTracker();
    return result;
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

  // ── Home plan: 5 compact rows; tapping one opens the field chooser ──
  // The chooser is a tiny machine of its own: closed | open(field).
  const HOME_FIELDS = [
    { key: 'eventType', label: 'Party type' },
    { key: 'budget', label: 'Budget' },
    { key: 'guestCount', label: 'People' },
    { key: 'setting', label: 'Indoor / outdoor' },
    { key: 'theme', label: 'Theme' },
  ];
  const FIELD_OF_CHANGE = { eventType: 'eventType', budget: 'budget', guestCount: 'guestCount', setting: 'setting', themePreference: 'theme' };
  const fieldPicker = $('#field-picker');
  const fieldPickerBackdrop = $('#field-picker-backdrop');
  let pickerField = null;

  function fieldValue(key) {
    const plan = data.partyPlan || emptyPlan();
    if (key === 'theme') return M.themeLabel(plan);
    const v = plan[key];
    if (v == null || v === '') return null;
    if (key === 'budget') return '$' + v;
    if (key === 'guestCount') return `${v} ${v === 1 ? 'guest' : 'guests'}`;
    if (key === 'setting') return v[0].toUpperCase() + v.slice(1);
    return String(v);
  }

  // flash: plan fields the assistant just changed, so the user sees what it did
  function renderHomeCards(flash) {
    if (!planCardsEl) return;
    planCardsEl.innerHTML = '';
    HOME_FIELDS.forEach(f => {
      const v = fieldValue(f.key);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pp-row';
      row.dataset.field = f.key;
      row.innerHTML = `<span class="pp-row-label">${escapeHtml(f.label)}</span>` +
        `<span class="pp-row-value${v ? '' : ' empty'}">${escapeHtml(v || 'Choose')}</span>` +
        '<span class="pp-row-chev" aria-hidden="true">›</span>';
      if (flash && flash.includes(f.key)) row.classList.add('pp-row-flash');
      row.addEventListener('click', () => openFieldPicker(f.key));
      planCardsEl.appendChild(row);
    });
    if (pickerField) renderFieldPicker(); // keep an open chooser in sync with agent updates
  }

  function openFieldPicker(key) {
    pickerField = key;
    renderFieldPicker();
    fieldPicker.classList.remove('hidden');
    fieldPickerBackdrop.classList.remove('hidden');
  }

  function closeFieldPicker() {
    if (!fieldPicker) return;
    pickerField = null;
    fieldPicker.classList.add('hidden');
    fieldPickerBackdrop.classList.add('hidden');
  }

  // Single-choice picks apply and close; typed values apply on Enter/blur.
  function pick(fields) { applyPlanUpdate(fields); closeFieldPicker(); }

  function renderFieldPicker() {
    const plan = data.partyPlan || emptyPlan();
    const field = HOME_FIELDS.find(f => f.key === pickerField);
    $('#field-picker-title').textContent = field ? field.label : '';
    const body = $('#field-picker-body');
    body.innerHTML = '';
    const chips = document.createElement('div');
    chips.className = 'pp-chips';
    body.appendChild(chips);

    if (pickerField === 'eventType') {
      EVENT_TYPES.forEach(t => chips.appendChild(chip(t, plan.eventType === t, () => pick({ eventType: t }))));
    } else if (pickerField === 'budget') {
      BUDGET_RANGES.forEach(r => chips.appendChild(chip(r.label, plan.budget === r.value, () => pick({ budget: r.value }))));
      const input = document.createElement('input');
      input.type = 'number'; input.className = 'pp-num-input'; input.placeholder = 'Custom $'; input.min = '0';
      input.inputMode = 'numeric';
      if (plan.budget != null && !BUDGET_RANGES.some(r => r.value === plan.budget)) input.value = plan.budget;
      input.addEventListener('change', () => { const v = parseInt(input.value, 10); if (!isNaN(v) && v > 0) pick({ budget: v }); });
      chips.appendChild(input);
    } else if (pickerField === 'guestCount') {
      const stepper = document.createElement('div');
      stepper.className = 'pp-stepper';
      const dec = document.createElement('button'); dec.className = 'pp-step'; dec.textContent = '−'; dec.setAttribute('aria-label', 'Fewer');
      const num = document.createElement('input'); num.type = 'number'; num.className = 'pp-num-input'; num.min = '1'; num.inputMode = 'numeric';
      num.value = plan.guestCount != null ? plan.guestCount : ''; num.placeholder = '0';
      const inc = document.createElement('button'); inc.className = 'pp-step'; inc.textContent = '+'; inc.setAttribute('aria-label', 'More');
      dec.addEventListener('click', () => applyPlanUpdate({ guestCount: Math.max(1, (data.partyPlan.guestCount || 0) - 5) }));
      inc.addEventListener('click', () => applyPlanUpdate({ guestCount: (data.partyPlan.guestCount || 0) + 5 }));
      num.addEventListener('change', () => { const v = parseInt(num.value, 10); if (!isNaN(v) && v > 0) applyPlanUpdate({ guestCount: v }); });
      stepper.appendChild(dec); stepper.appendChild(num); stepper.appendChild(inc);
      chips.replaceWith(stepper);
    } else if (pickerField === 'setting') {
      SETTINGS.forEach(st => chips.appendChild(chip(st[0].toUpperCase() + st.slice(1), plan.setting === st, () => pick({ setting: st }))));
    } else if (pickerField === 'theme') {
      const suggestions = THEME_SUGGESTIONS[plan.eventType] || [];
      if (!suggestions.length) {
        const hint = document.createElement('p');
        hint.className = 'field-picker-hint';
        hint.textContent = 'Pick a party type for suggestions, or describe your own vibe.';
        body.insertBefore(hint, chips);
      }
      suggestions.forEach(t => chips.appendChild(chip(t, plan.themePreference === t, () => pick({ themePreference: t }))));
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'pp-text-input'; input.placeholder = 'or describe your own vibe…';
      if (plan.themePreference && !suggestions.includes(plan.themePreference)) input.value = plan.themePreference;
      input.addEventListener('change', () => { const v = input.value.trim(); if (v) pick({ themePreference: v }); });
      chips.appendChild(input);
    }
  }

  if (fieldPicker) {
    $('#field-picker-done').addEventListener('click', closeFieldPicker);
    fieldPickerBackdrop.addEventListener('click', closeFieldPicker);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pickerField) closeFieldPicker(); });
  }

  function refreshDesignBtn() {
    if (!designThemeBtn) return;
    designThemeBtn.disabled = !M.planReadiness(data.partyPlan).ready;
  }

  if (designThemeBtn) {
    designThemeBtn.addEventListener('click', () => startThemeCreation(M.themeRequest(data.partyPlan)));
  }

  // Home chat-assist lane
  const homeChatInput = $('#home-chat-input');
  const homeChatSend = $('#home-chat-send');
  function sendHomeChat() {
    const text = (homeChatInput.value || '').trim();
    if (!text || agent.state !== 'idle') return;
    homeChatInput.value = '';
    openChatDrawer();
    addChatMessage('user', text);
    runAgent(text);
  }
  if (homeChatSend) homeChatSend.addEventListener('click', sendHomeChat);
  const homeChatHistory = $('#home-chat-history');
  if (homeChatHistory) homeChatHistory.addEventListener('click', () => openChatDrawer());
  if (homeChatInput) homeChatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHomeChat(); } });

  // ══════════════════════════════════════
  //  JOURNEY — one stage → exactly one surface
  // ══════════════════════════════════════
  //
  //  home ─DESIGN→ theme ─ACCEPT→ extracting ─EXTRACTED→ decide ─SHOP→ shopping ─SHOPPED→ cart
  //                  ↑                 └──FAILED──┘          └──────────FAILED──────┘     │
  //                  └──────────────────────── DESIGN (from decide/cart) ────────────────┘
  //  (full table + guards in machines.js → JOURNEY)

  const SURFACES = ['landing-overlay', 'theme-screen', 'decide-screen', 'cart-screen'];
  const DEBUG = /[?&]debug\b/.test(location.search);

  function renderStage(stage) {
    const surface = M.STAGE_SURFACE[stage];
    SURFACES.forEach((id) => { const el = $('#' + id); if (el) el.classList.toggle('hidden', id !== surface); });
    // The bottom sheet belongs to Home. On full-screen steps it sat on top of
    // the footer CTAs and swallowed taps, so it goes offstage there.
    bottomSheet.classList.toggle('sheet-offstage', stage !== 'home');
    $('#extraction-overlay').classList.toggle('hidden', stage !== 'extracting');
    document.body.dataset.stage = stage; // hook for CSS, tests and debugging
    if (stage !== 'home') closeFieldPicker();
    placeChatButton();
    refreshThemeCtas();
  }

  // On full-screen steps the floating chat button rides just above that
  // screen's footer so it never covers the CTAs or the budget tracker.
  function placeChatButton() {
    const surface = $('#' + M.STAGE_SURFACE[journey.state]);
    const footer = surface && surface.querySelector('.fs-footer');
    const h = footer ? footer.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--fab-bottom', h + 'px');
  }
  window.addEventListener('resize', placeChatButton);

  journey.subscribe((stage, t) => {
    data.stage = stage;
    saveData(data);
    renderStage(stage);
    if (DEBUG) console.debug(`[journey] ${t.from} --${t.event}--> ${stage}`, snapshot());
  });

  function showStageError(screenId, message, retry) {
    clearStageError(screenId);
    const body = $('#' + screenId + ' .fs-body');
    if (!body) return;
    const el = document.createElement('div');
    el.className = 'stage-error';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (retry) {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary btn-sm';
      b.textContent = 'Try again';
      b.addEventListener('click', retry);
      el.appendChild(b);
    }
    body.prepend(el);
  }
  function clearStageError(screenId) { $$('#' + screenId + ' .stage-error').forEach((e) => e.remove()); }

  const FACET_LABELS = { backdrop: 'Backdrop', table: 'Table decor', accent: 'Accents' };
  const FACET_ORDER = M.FACETS;

  // ══════════════════════════════════════
  //  THEME SCREEN — generate + facet chooser
  // ══════════════════════════════════════
  //
  //  designer.status: idle → loading → ready | error. Every request carries a
  //  token (designer.req); a response whose token is stale is dropped, and the
  //  previous fetch is aborted, so a slow old look can never overwrite a new one.

  const themeRegenBtn = $('#theme-regen');
  const themeUseBtn = $('#theme-use');
  let themeAbort = null;

  function refreshThemeCtas() {
    if (!themeUseBtn) return;
    const busy = journey.state === 'extracting';
    const left = designer.regensLeft();
    themeRegenBtn.disabled = busy || left <= 0;
    themeRegenBtn.textContent = left <= 0 ? 'No more looks' : 'Try a different look';
    themeUseBtn.disabled = busy || !designer.canAccept();
  }

  // Returns false if the journey can't enter the designer right now (e.g. mid-shopping).
  function startThemeCreation(pref, opts) {
    const fresh = !!(opts && opts.fresh);
    if (!journey.send('DESIGN')) return false;
    if (themeAbort) themeAbort.abort();
    themeAbort = new AbortController();
    const signal = themeAbort.signal;
    const token = designer.begin(pref);
    clearStageError('theme-screen');
    $('#theme-title').textContent = 'Designing your theme…';
    $('#theme-sub').textContent = '';
    $('#facet-sections').innerHTML = '<div class="theme-loading"><div class="spinner"></div><span>Designing…</span></div>';
    refreshThemeCtas();

    const body = { plan: data.partyPlan, theme_preference: pref };
    if (fresh) body.fresh = true; // "Try a different look" must not get the same cached look back
    postJson('/api/create-theme', body, signal).then((d) => {
      if (!designer.isCurrent(token)) return; // superseded by a newer request
      if (d.error) {
        designer.status = 'error';
        $('#facet-sections').innerHTML = `<div class="theme-error">Couldn't design that theme (${escapeHtml(d.error)}). <button class="btn btn-secondary" id="theme-retry">Try again</button></div>`;
        $('#theme-retry').addEventListener('click', () => startThemeCreation(pref, { fresh }));
        refreshThemeCtas();
        return;
      }
      designer.key = d.key;
      designer.theme = d.theme || {};
      designer.cached = !!d.cached;
      designer.status = 'ready';
      $('#theme-title').textContent = designer.theme.name || pref || 'Your theme';
      $('#theme-sub').textContent = designer.cached ? 'From your library' : 'Freshly designed';
      renderFacetChooser(d.facets || [], designer.cached, token, signal);
      refreshThemeCtas();
    });
    return true;
  }

  function renderFacetChooser(facets, cached, token, signal) {
    const container = $('#facet-sections');
    container.innerHTML = '';
    const byFacet = {};
    (facets || []).forEach(f => { byFacet[f.facet] = f; });

    FACET_ORDER.forEach(facet => {
      const f = byFacet[facet];
      if (!f) return;
      const section = document.createElement('div');
      section.className = 'facet-section';
      section.dataset.facet = facet;
      section.innerHTML = `<div class="facet-label">${FACET_LABELS[facet]}</div>`;
      const row = document.createElement('div');
      row.className = 'facet-variations';
      section.appendChild(row);
      container.appendChild(section);

      if (cached && f.options) {
        const urls = f.options.map(o => o.url);
        designer.facets[facet] = { status: urls.length ? 'ready' : 'failed', images: urls, prompt: null };
        f.options.forEach((o, i) => row.appendChild(makeVariationTile(facet, o.url, i, o.hasItems, o.id)));
        if (f.options[0]) selectVariation(facet, f.options[0].url, row.firstChild);
      } else {
        designer.facets[facet] = { status: 'loading', images: [], prompt: f.prompt };
        generateFacetVariations(facet, section, token, signal);
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
    designer.chosen[facet] = url;
    const row = tile.parentElement;
    row.querySelectorAll('.facet-tile').forEach(t => t.classList.remove('selected'));
    tile.classList.add('selected');
    refreshThemeCtas();
  }

  // Per-facet: loading → ready | failed (failed offers its own retry).
  async function generateFacetVariations(facet, section, token, signal) {
    const f = designer.facets[facet];
    const row = section.querySelector('.facet-variations');
    f.status = 'loading';
    section.querySelectorAll('.facet-retry').forEach(b => b.remove());
    row.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement('div');
      slot.className = 'facet-tile shimmer';
      slot.dataset.facet = facet;
      slot.dataset.idx = i;
      row.appendChild(slot);
    }
    refreshThemeCtas();

    const styleAnchor = (designer.theme && designer.theme.style_anchor) || '';
    const d = await postJson('/api/generate-image', { prompt: `${styleAnchor}\n\n${f.prompt}`.trim(), count: 3 }, signal);
    if (!designer.isCurrent(token)) return;
    const images = d.images || [];
    f.images = images;
    f.status = images.length ? 'ready' : 'failed';
    row.querySelectorAll('.facet-tile').forEach((slot, i) => {
      if (images[i]) {
        row.replaceChild(makeVariationTile(facet, images[i], i, false), slot);
      } else {
        slot.classList.remove('shimmer');
        slot.classList.add('facet-tile-empty');
        slot.innerHTML = `<span>${images.length ? 'no image' : 'failed'}</span>`;
      }
    });
    if (f.status === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'btn btn-secondary btn-sm facet-retry';
      retry.textContent = 'Retry ' + FACET_LABELS[facet].toLowerCase();
      retry.addEventListener('click', () => generateFacetVariations(facet, section, designer.req, themeAbort && themeAbort.signal));
      section.appendChild(retry);
    }
    const firstTile = row.querySelector('.facet-tile:not(.facet-tile-empty)');
    if (firstTile && !designer.chosen[facet]) selectVariation(facet, images[0], firstTile);
    refreshThemeCtas();
  }

  // Regenerate: capped per theme preference, and always bypasses the library cache.
  if (themeRegenBtn) themeRegenBtn.addEventListener('click', () => {
    if (designer.regensLeft() <= 0) return;
    designer.useRegen();
    startThemeCreation(M.themeRequest(data.partyPlan), { fresh: true });
  });

  const themeBackBtn = $('#theme-back');
  if (themeBackBtn) themeBackBtn.addEventListener('click', () => {
    designer.cancel();
    if (themeAbort) themeAbort.abort();
    journey.send('BACK');
  });

  if (themeUseBtn) themeUseBtn.addEventListener('click', handleThemeAccepted);

  async function handleThemeAccepted() {
    if (!designer.canAccept() || !journey.can('ACCEPT')) return;
    const theme = designer.theme || {};
    data.partyPlan.theme = { name: theme.name || '', source: 'generated', palette: theme.palette || [] };
    saveData(data);
    renderPlanCard();
    sheetThemeName.textContent = theme.name || '';

    const chosenUrls = FACET_ORDER.map(f => designer.chosen[f]).filter(Boolean);
    state.themeFacets = chosenUrls;

    // Save all generated variations to the library (miss path only, once per design)
    if (!designer.cached && !designer.saved) {
      designer.saved = true;
      const images = [];
      FACET_ORDER.forEach(facet => ((designer.facets[facet] || {}).images || []).forEach(url => {
        if (url && url.startsWith('data:')) images.push({ facet, dataUrl: url });
      }));
      if (images.length) postJson('/api/save-theme', { key: designer.key, theme, images }); // fire and forget
    }

    await runExtraction(chosenUrls);
  }

  // ══════════════════════════════════════
  //  EXTRACTION → DECIDE
  // ══════════════════════════════════════

  async function runExtraction(chosenUrls) {
    if (!journey.send('ACCEPT')) return;
    clearStageError('theme-screen');
    const payloads = [];
    for (const url of chosenUrls) {
      const parsed = await urlToBase64(url);
      if (parsed) payloads.push(parsed);
    }
    const { items, error } = payloads.length
      ? await callExtractItems(payloads, [])
      : { items: [], error: 'could not read the chosen images' };

    if (error || items.length === 0) {
      journey.send('FAILED');
      showStageError('theme-screen',
        error ? `Couldn't spot the pieces in this look (${error}).` : 'No shoppable pieces found in these looks — try different picks or another look.',
        error ? handleThemeAccepted : null);
      return;
    }
    items.forEach(it => { it.source_url = chosenUrls[it.image_index] || chosenUrls[0]; });
    state.extractedItems = items;
    data.extractedItems = items;
    saveData(data);
    renderDecideScreen(items);
    journey.send('EXTRACTED');
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

  let refreshDecideCta = () => {};

  function renderDecideScreen(items) {
    $('#decide-sub').textContent = `${items.length} pieces found`;
    clearStageError('decide-screen');
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
          refreshDecideCta();
        });
        section.appendChild(row);
      });
      container.appendChild(section);
    });

    refreshDecideCta = function () {
      container.querySelectorAll('.decide-section').forEach(sec => {
        const boxes = sec.querySelectorAll('input[type=checkbox]');
        const on = Array.from(boxes).filter(b => b.checked).length;
        const c = sec.querySelector('.decide-count');
        if (c) c.textContent = `${on} of ${boxes.length}`;
      });
      const btn = $('#decide-shop');
      if (journey.state === 'shopping') { btn.disabled = true; btn.textContent = 'Shopping for the best picks…'; return; }
      btn.disabled = selected.size === 0;
      btn.textContent = `Find products (${selected.size})`;
    };
    refreshDecideCta();

    $('#decide-shop').onclick = () => runShop(Array.from(selected).map(i => items[i]));
  }

  const decideBackBtn = $('#decide-back');
  if (decideBackBtn) decideBackBtn.addEventListener('click', () => {
    // After a reload there is no theme in memory: Back goes Home, not to an empty designer.
    journey.send('BACK', { hasTheme: designer.status === 'ready' && !!designer.theme });
  });

  // ══════════════════════════════════════
  //  SHOP → CART decision hub
  // ══════════════════════════════════════

  async function runShop(selectedItems) {
    if (!journey.send('SHOP')) return;
    clearStageError('decide-screen');
    refreshDecideCta();
    const d = await postJson('/api/shop', { items: selectedItems, plan: data.partyPlan });
    const picks = (d.picks || []).filter(p => p.product);
    if (d.error || picks.length === 0) {
      journey.send('FAILED');
      refreshDecideCta();
      showStageError('decide-screen',
        d.error ? `Couldn't find products (${d.error}).` : 'No products matched these pieces — try a different selection.',
        d.error ? () => runShop(selectedItems) : null);
      return;
    }
    data.partyBucket = M.normalizeCart(picks);
    saveData(data);
    updateBucketUI();
    renderCart();
    journey.send('SHOPPED');
    refreshDecideCta();
  }

  function cartSubtotal() {
    return M.subtotal(data.partyBucket);
  }

  function renderCart() {
    const list = $('#cart-list');
    list.innerHTML = '';
    $('#cart-sub').textContent = `${data.partyBucket.length} items`;

    data.partyBucket.forEach(line => {
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
            <span class="cart-line-total">${formatCurrency(M.lineTotal(line))}</span></div>
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

    $('#cart-checkout').disabled = data.partyBucket.length === 0;
    renderBudgetTracker();
  }

  // Single write path for cart mutations: persist, then refresh every view of it.
  function commitCart() {
    saveData(data);
    updateBucketUI();
    renderCart();
  }

  function changeCartQty(id, delta) {
    const line = data.partyBucket.find(l => l.id === id);
    if (!line) return;
    line.quantity = Math.max(1, (line.quantity || 1) + delta);
    commitCart();
  }

  function removeCartLine(id) {
    data.partyBucket = data.partyBucket.filter(l => l.id !== id);
    commitCart();
  }

  function renderBudgetTracker() {
    const b = M.budgetStatus(data.partyBucket, data.partyPlan.budget);
    const fill = $('#budget-fill');
    const label = $('#budget-label');
    if (b.state === 'no_budget') {
      fill.style.width = '0%';
      label.textContent = `Subtotal: ${formatCurrency(b.subtotal)}`;
      $('#budget-tracker').classList.remove('over');
      return;
    }
    fill.style.width = Math.min(100, (b.subtotal / b.budget) * 100) + '%';
    $('#budget-tracker').classList.toggle('over', b.state === 'over');
    label.textContent = b.state === 'over'
      ? `${formatCurrency(b.subtotal)} — ${formatCurrency(b.delta)} over your ${formatCurrency(b.budget)} budget`
      : `You've used ${formatCurrency(b.subtotal)} of ${formatCurrency(b.budget)}`;
  }

  const cartBackBtn = $('#cart-back');
  if (cartBackBtn) cartBackBtn.addEventListener('click', () => journey.send('BACK', { hasItems: state.extractedItems.length > 0 }));

  const cartCheckoutBtn = $('#cart-checkout');
  if (cartCheckoutBtn) cartCheckoutBtn.addEventListener('click', () => {
    if (!data.partyBucket.length) return;
    // Checkout lives in the bottom sheet over Home; the cart stays canonical and
    // is adapted to the checkout API shape at the boundary (M.toCheckoutItems).
    journey.send('CHECKOUT');
    openCheckout();
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

      const meta = BUCKET_META[bucket] || { label: bucket, icon: '', color: '#6b655d' };

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
      data.partyBucket.push(M.normalizeLine({
        item_name: product.name,
        bucket: bucket || 'accent_decor',
        quantity: 1,
        product: { title: product.name, retailer: product.retailer || 'Google Shopping', link: product.url || '', price: product.price || 0, thumbnail: product.image || '' },
      }));
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
    // One agent turn at a time: while thinking, keep the draft and ignore sends.
    if (agent.state !== 'idle') return;
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

      const { items, error } = await callExtractItems(images, []);
      if (error) {
        addChatMessage('assistant', `Sorry — I couldn't analyze those images (${error}).`);
        return;
      }
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
    await runAgent(text);
  }

  // ── Agent loop: idle → thinking → (tools → thinking)* → idle ──
  // Bounded to M.MAX_AGENT_TURNS model calls; messages are appended through
  // M.pushMessage so roles always alternate, even after an error.
  function setAgentBusy(busy) {
    if (chatSendBtn) chatSendBtn.disabled = busy;
    if (homeChatSend) homeChatSend.disabled = busy;
    chatDrawer.classList.toggle('agent-busy', busy);
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'chat-message assistant';
    el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(el);
    scrollChatToBottom();
    return el;
  }

  async function runAgent(userText) {
    if (!agent.send('SEND')) return false;
    setAgentBusy(true);
    M.pushMessage(state.apiMessages, 'user', userText);
    try {
      for (let turn = 0; turn < M.MAX_AGENT_TURNS; turn++) {
        const typingEl = showTyping();
        const result = await callClaude(state.apiMessages);
        typingEl.remove();

        if (!result || result.error || !Array.isArray(result.content)) {
          addChatMessage('assistant', 'Sorry, something went wrong. ' + ((result && result.error) || ''));
          agent.send('ERROR');
          return false;
        }

        const content = result.content;
        M.pushMessage(state.apiMessages, 'assistant', content);
        const texts = content.filter(b => b.type === 'text').map(b => b.text);
        if (texts.length > 0) addChatMessage('assistant', texts.join('\n'));

        const toolUses = content.filter(b => b.type === 'tool_use');
        if (toolUses.length === 0) { agent.send('DONE'); return true; }

        const toolResults = [];
        for (const tool of toolUses) toolResults.push(await processToolCall(tool));
        M.pushMessage(state.apiMessages, 'user', toolResults);
        saveData(data);
      }
      // Turn budget spent: stop rather than loop (and bill) indefinitely.
      addChatMessage('assistant', "I've made those updates — tell me what you'd like next.");
      agent.send('DONE');
      return true;
    } finally {
      if (agent.state !== 'idle') agent.send('ERROR');
      setAgentBusy(false);
    }
  }

  // Each tool result tells the agent what changed AND where the app now is,
  // so its next turn is grounded in real state rather than its own guess.
  function toolResult(tool, text, isError) {
    const r = { type: 'tool_result', tool_use_id: tool.id, content: `${text}\n[stage: ${journey.state}]` };
    if (isError) r.is_error = true;
    return r;
  }

  async function processToolCall(tool) {
    const inp = tool.input || {};

    if (tool.name === 'update_party_plan') {
      const { changed, invalidatedTheme } = applyPlanUpdate(inp, { flash: true });
      const recorded = changed.map(k => {
        const v = data.partyPlan[k];
        return { eventType: `type=${v}`, budget: `budget=$${v}`, guestCount: `people=${v}`, setting: `setting=${v}`, themePreference: `theme=${v}` }[k];
      });
      const { ready, missing } = M.planReadiness(data.partyPlan);
      return toolResult(tool,
        `Cards updated (${recorded.join(', ') || 'no changes'}).` +
        (invalidatedTheme ? ' The previously designed theme no longer matches and was cleared.' : '') +
        (ready ? ' Party type and theme are set — you may call create_theme, or invite the user to tap "Design my theme".' : ` Still missing: ${missing.join(', ')}.`));
    }

    if (tool.name === 'create_theme') {
      const pref = inp.theme_preference || M.themeRequest(data.partyPlan);
      if (!journey.can('DESIGN')) {
        return toolResult(tool, `Can't open the theme designer right now — the user is ${M.STAGE_DESCRIPTION[journey.state]}. Try again once that finishes.`, true);
      }
      closeChatDrawer();
      startThemeCreation(pref);
      return toolResult(tool, `Opened the theme designer for "${pref}". The user is choosing their favorite look per section.`);
    }

    if (tool.name === 'update_party_bucket') {
      const results = [];
      for (const action of (inp.actions || [])) {
        if (action.action === 'add' && action.item_name) {
          data.partyBucket.push(M.normalizeLine({
            item_name: action.item_name,
            product: { title: action.item_name, price: action.price || 0, retailer: action.store || 'Amazon' },
          }));
          results.push(`Added "${action.item_name}"`);
        } else if (action.action === 'remove') {
          const idx = M.findLineByName(data.partyBucket, action.item_name);
          if (idx !== -1) {
            results.push(`Removed "${data.partyBucket[idx].item_name}"`);
            data.partyBucket.splice(idx, 1);
          } else {
            results.push(`No cart line matched "${action.item_name}"`);
          }
        }
      }
      commitCart();
      return toolResult(tool, results.join('. ') + `. Cart: ${data.partyBucket.length} lines, ${formatCurrency(getBucketTotal())}.`);
    }

    return toolResult(tool, `Unknown tool "${tool.name}".`, true);
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
    return M.subtotal(data.partyBucket);
  }

  function updateBucketUI() {
    const count = data.partyBucket.length;
    bucketCountBadge.textContent = count;
    sheetItemCount.textContent = `${count} item${count === 1 ? '' : 's'}`;
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

  // Sheet mode: browse → checkout → results → (Done) browse.
  async function openCheckout() {
    if (data.partyBucket.length === 0) return;
    setSheetMode('checkout');
    setSheetState('full');
    resetPlaceOrderBtn();
    await renderCheckoutSummary();
    initStripeElements();
  }

  function resetPlaceOrderBtn() {
    const btn = $('#checkout-place-order-btn');
    btn.disabled = false;
    btn.textContent = 'Place Order';
  }

  bucketCheckoutBtn.addEventListener('click', openCheckout);

  function initStripeElements() {
    const stripe = getStripe();
    if (!stripe || stripeCardElement) return;
    const elements = stripe.elements();
    stripeCardElement = elements.create('card', {
      style: { base: { fontSize: '16px', color: '#1f1c19', '::placeholder': { color: '#b5aea4' } } },
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

    const plan = await postJson('/api/checkout/plan', { items: M.toCheckoutItems(data.partyBucket) });
    checkoutPlan = plan.error ? { retailers: [], unsupported: [] } : plan;

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
      resetPlaceOrderBtn();
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
          resetPlaceOrderBtn();
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

    setSheetMode('results');
    checkoutResultsEl.innerHTML = html;
    $('#checkout-done-btn').addEventListener('click', () => {
      data.partyBucket = [];
      saveData(data);
      updateBucketUI();
      renderCart();
      setSheetMode('browse');
      setSheetState('collapsed');
      resetPlaceOrderBtn();
      if (journey.state !== 'home') journey.send('HOME');
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

    // Rebuild the persisted stages' screens so a resumed journey (and Back) has content.
    if (state.extractedItems.length) renderDecideScreen(state.extractedItems);
    renderCart();

    // Restore chat transcript (the agent's API context was rebuilt from it in `state`)
    if (data.chatHistory && data.chatHistory.length > 0) {
      chatMessages.innerHTML = '';
      data.chatHistory.forEach(msg => {
        const el = document.createElement('div');
        el.className = `chat-message ${msg.role}`;
        el.innerHTML = escapeHtml(msg.text).replace(/\n/g, '<br>');
        chatMessages.appendChild(el);
      });
    }

    renderStage(journey.state);
  }

  window.app = {
    removeBucketItem(id) {
      data.partyBucket = data.partyBucket.filter(b => b.id !== id);
      commitCart();
    },
    changeQuantity(id, delta) {
      const item = data.partyBucket.find(b => b.id === id);
      if (!item) return;
      const newQty = (item.quantity || 1) + delta;
      if (newQty < 1) { this.removeBucketItem(id); return; }
      item.quantity = newQty;
      commitCart();
    },
  };

  // Read-only debugging/automation handle (DX + AX): what stage, what's legal next,
  // and the recent transition log. Add ?debug to the URL to log every transition.
  window.partyplanner = {
    snapshot,
    describe: describeAppState,
    get history() { return journey.history.slice(); },
    machines: M,
  };

  init();
})();
