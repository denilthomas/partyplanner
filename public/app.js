(function () {
  'use strict';

  // ══════════════════════════════════════
  //  DATA LAYER
  // ══════════════════════════════════════

  function emptyPlan() {
    return {
      eventType: null,   // "Birthday" | "Wedding" | ...
      budget: null,      // number (USD)
      guestCount: null,  // number
      setting: null,     // "indoor" | "outdoor" | "both"
      theme: null,       // { id, name }
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
    'You are a friendly, knowledgeable AI Party Planning Agent. You guide the user through a short, ordered set of questions to build a PARTY PLAN, then help them source decor.',
    '',
    'INTAKE — gather these ONE AT A TIME, in this order. Ask ONE question per message, keep it warm and brief. Skip anything already filled in the CURRENT PARTY PLAN below. Each time the user answers, call update_party_plan to record it.',
    '  1. Event type (Birthday, Wedding, Retirement, Graduation, Holiday, Baby Shower, Anniversary, Dinner Party, etc.)',
    '  2. Budget for the event (a dollar amount or range)',
    '  3. Guest count (approximate number of people)',
    '  4. Setting (indoor, outdoor, or both)',
    '  5. Theme — ask if they have a theme in mind, and PROACTIVELY suggest a few of the trending themes listed below that fit their event type. When they choose one, call update_party_plan with its theme_id.',
    '',
    'AFTER THEME IS CHOSEN:',
    '- The app shows curated inspiration images for that theme. The user picks their favorites and the app instantly lists buyable items in the bottom panel, grouped by bucket.',
    '- Respond warmly, e.g. "Beautiful choice! Pick the looks you love and I\'ll pull together your shopping list."',
    '- Do NOT try to list or search for products yourself — the app handles it when the user taps Find Products.',
    '',
    'ONGOING:',
    '- Keep responses concise: 1-3 sentences. Be warm and enthusiastic.',
    '- Use the CURRENT PARTY PLAN (budget, guest count, setting) to tailor every suggestion — e.g. scale quantities to guest count, respect the budget, favor outdoor-friendly decor when setting is outdoor.',
    '- If the user asks to add or remove items, call update_party_bucket.',
    '- NEVER ask to add items to the bucket before any items have been shown.',
    '- Do NOT ask about a photo of their space — that is not part of this flow.',
  ].join('\n');

  function buildSystemPrompt() {
    const plan = data.partyPlan || emptyPlan();
    const planLines = [
      '',
      'CURRENT PARTY PLAN (already known — do not re-ask these):',
      `  Event type: ${plan.eventType || '(not set)'}`,
      `  Budget: ${plan.budget != null ? '$' + plan.budget : '(not set)'}`,
      `  Guest count: ${plan.guestCount != null ? plan.guestCount : '(not set)'}`,
      `  Setting: ${plan.setting || '(not set)'}`,
      `  Theme: ${plan.theme ? plan.theme.name : '(not set)'}`,
    ];

    // Themes available for this event type (featured first)
    const themes = (state.manifest.themes || []);
    const relevant = themes.filter(t =>
      !plan.eventType || (t.eventTypes || []).some(e => e.toLowerCase() === String(plan.eventType).toLowerCase())
    );
    const pool = relevant.length ? relevant : themes;
    const featured = pool.filter(t => t.featured);
    const suggestList = (featured.length ? featured : pool).slice(0, 6);

    const themeLines = ['', 'AVAILABLE CURATED THEMES (suggest these by name; use theme_id when recording a choice):'];
    if (suggestList.length === 0) {
      themeLines.push('  (none loaded yet)');
    } else {
      for (const t of suggestList) {
        themeLines.push(`  - ${t.name} (theme_id: "${t.id}")${t.tags && t.tags.length ? ' — ' + t.tags.slice(0, 4).join(', ') : ''}`);
      }
    }
    themeLines.push('If the user wants a theme not listed, pick the closest curated match and say so.');

    return PLANNER_SYSTEM_BASE + '\n' + planLines.join('\n') + '\n' + themeLines.join('\n');
  }

  const PLANNER_TOOLS = [
    {
      name: 'update_party_plan',
      description: 'Record one or more answers into the Party Plan checklist. Call this whenever the user provides their event type, budget, guest count, setting, or chosen theme.',
      input_schema: {
        type: 'object',
        properties: {
          eventType: { type: 'string', description: 'Event type, e.g. "Birthday", "Wedding"' },
          budget: { type: 'number', description: 'Budget in USD (a single number; use the midpoint if a range)' },
          guestCount: { type: 'number', description: 'Approximate number of guests' },
          setting: { type: 'string', enum: ['indoor', 'outdoor', 'both'], description: 'Where the event is held' },
          theme_id: { type: 'string', description: 'The id of the chosen curated theme (from the available themes list). Setting this shows the inspiration images.' },
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

  // ══════════════════════════════════════
  //  THEME MANIFEST
  // ══════════════════════════════════════

  async function loadManifest() {
    try {
      const res = await fetch('themes/manifest.json', { cache: 'no-cache' });
      const d = await res.json();
      state.manifest = { themes: d.themes || [] };
    } catch (err) {
      console.error('Failed to load theme manifest:', err);
      state.manifest = { themes: [] };
    }
  }

  function getTheme(themeId) {
    return (state.manifest.themes || []).find(t => t.id === themeId) || null;
  }

  // bbox pixel crop { x, y, w, h } → ImageKit transform URL
  function buildImageKitCropUrl(url, crop) {
    if (!url || !crop) return url || '';
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}tr=x-${crop.x},y-${crop.y},w-${crop.w},h-${crop.h}`;
  }

  // ══════════════════════════════════════
  //  PARTY PLAN
  // ══════════════════════════════════════

  const PLAN_FIELDS = [
    { key: 'eventType', label: 'Event' },
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
    if (key === 'theme') return v.name || null;
    if (key === 'setting') return v.charAt(0).toUpperCase() + v.slice(1);
    return String(v);
  }

  function renderPlanCard() {
    const plan = data.partyPlan || {};
    const anySet = PLAN_FIELDS.some(f => planValueText(f.key) != null);
    if (!anySet) {
      planCard.classList.add('hidden');
      return;
    }
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

  // Merge fields into the plan, persist, re-render. Returns true if a theme was newly set.
  function applyPlanUpdate(fields) {
    const plan = data.partyPlan || emptyPlan();
    let themeSet = false;

    if (fields.eventType != null) plan.eventType = fields.eventType;
    if (fields.budget != null) plan.budget = fields.budget;
    if (fields.guestCount != null) plan.guestCount = fields.guestCount;
    if (fields.setting != null) plan.setting = fields.setting;

    if (fields.theme_id) {
      const theme = getTheme(fields.theme_id);
      if (theme) {
        plan.theme = { id: theme.id, name: theme.name };
        themeSet = true;
      }
    }

    data.partyPlan = plan;
    saveData(data);
    renderPlanCard();
    if (data.partyPlan.theme) sheetThemeName.textContent = data.partyPlan.theme.name;
    return themeSet;
  }

  // ══════════════════════════════════════
  //  QUICK-PICK EVENT CHIPS
  // ══════════════════════════════════════

  $$('.quick-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const eventType = btn.dataset.type;
      landingOverlay.classList.add('hidden');
      applyPlanUpdate({ eventType });
      if (state.sheetState === 'collapsed') setSheetState('half');
      openChatDrawer();
      const seed = `I'm planning a ${eventType} event.`;
      addChatMessage('user', seed);
      state.apiMessages.push({ role: 'user', content: seed });
      sendToLLM();
    });
  });

  // ══════════════════════════════════════
  //  INSPIRATION GRID (curated theme images)
  // ══════════════════════════════════════

  function renderInspirationGrid(images) {
    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.style.maxWidth = '100%';

    const heading = document.createElement('div');
    heading.className = 'pinterest-heading';
    heading.textContent = 'Pick up to 3 inspiration images:';
    msg.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'pinterest-grid';

    const selected = new Map();

    const counter = document.createElement('div');
    counter.className = 'pinterest-counter';
    counter.textContent = '0/3 selected';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary pinterest-confirm-btn';
    confirmBtn.textContent = 'Confirm (0)';
    confirmBtn.disabled = true;

    function updateUI() {
      counter.textContent = `${selected.size}/3 selected`;
      confirmBtn.textContent = `Confirm (${selected.size})`;
      confirmBtn.disabled = selected.size === 0;
      grid.querySelectorAll('.pinterest-card').forEach((c, i) => {
        const isSel = selected.has(i);
        c.classList.toggle('selected', isSel);
        c.classList.toggle('dimmed', !isSel && selected.size >= 3);
        let badge = c.querySelector('.pinterest-selection-count');
        if (isSel) {
          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'pinterest-selection-count';
            c.querySelector('.pinterest-img-wrap').appendChild(badge);
          }
          badge.textContent = Array.from(selected.keys()).indexOf(i) + 1;
        } else if (badge) {
          badge.remove();
        }
      });
    }

    images.forEach((img, i) => {
      const card = document.createElement('div');
      card.className = 'pinterest-card';
      card.innerHTML = `<div class="pinterest-img-wrap" style="position:relative;">
        <img src="${escapeHtml(img.url)}" alt="inspiration" loading="lazy">
      </div>`;
      card.addEventListener('click', () => {
        if (selected.has(i)) selected.delete(i);
        else if (selected.size < 3) selected.set(i, img);
        updateUI();
      });
      grid.appendChild(card);
    });

    confirmBtn.addEventListener('click', () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Building your list...';
      grid.querySelectorAll('.pinterest-card').forEach((c, i) => {
        c.style.pointerEvents = 'none';
        if (!selected.has(i)) c.classList.add('dimmed');
      });
      handleInspirationConfirmed(Array.from(selected.values()));
    });

    msg.appendChild(grid);
    msg.appendChild(counter);
    const confirmWrap = document.createElement('div');
    confirmWrap.className = 'pinterest-confirm-container';
    confirmWrap.appendChild(confirmBtn);
    msg.appendChild(confirmWrap);

    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  function handleInspirationConfirmed(selectedImages) {
    // Each selected image is a manifest image object with pre-extracted items.
    state.inspirationUrls = selectedImages.map(img => img.url);
    data.inspirationUrls = state.inspirationUrls;

    addChatMessage('user', `I picked ${selectedImages.length} inspiration image${selectedImages.length > 1 ? 's' : ''}!`);

    // Merge pre-extracted items, carrying each item's source image url + crop.
    const items = [];
    selectedImages.forEach((img, imageIndex) => {
      (img.items || []).forEach(it => {
        items.push({ ...it, image_index: imageIndex, source_url: img.url });
      });
    });

    state.extractedItems = items;
    data.extractedItems = items;
    saveData(data);

    closeChatDrawer();
    renderExtractedItemsInSheet(items);

    if (items.length > 0) {
      sheetThemeName.textContent = (data.partyPlan.theme && data.partyPlan.theme.name) || 'Party Items';
      sheetItemCount.textContent = `${items.length} items found`;
      setSheetState('half');

      // Tell Claude what happened
      const bucketSummary = BUCKET_ORDER
        .map(b => { const c = items.filter(i => i.bucket === b).length; return c > 0 ? `${BUCKET_META[b].label}: ${c}` : null; })
        .filter(Boolean).join(', ');
      addChatMessage('assistant', `Found ${items.length} items from your inspiration! (${bucketSummary}) Review them in the panel below and tap "Find Products" when ready.`);
      state.apiMessages.push({ role: 'user', content: `Extraction complete: ${items.length} items found across buckets: ${bucketSummary}. Items are displayed for the user to review.` });
      state.apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: `Found ${items.length} items from your inspiration! Review them below and tap "Find Products" when you're ready.` }] });
    } else {
      addChatMessage('assistant', 'Hmm, those images don\'t have items ready yet. Try selecting different ones.');
      openChatDrawer();
    }
  }

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
      const themeSet = applyPlanUpdate(inp);

      const recorded = [];
      if (inp.eventType != null) recorded.push(`event=${inp.eventType}`);
      if (inp.budget != null) recorded.push(`budget=$${inp.budget}`);
      if (inp.guestCount != null) recorded.push(`guests=${inp.guestCount}`);
      if (inp.setting != null) recorded.push(`setting=${inp.setting}`);

      if (themeSet) {
        const theme = data.partyPlan.theme;
        const manifestTheme = getTheme(theme.id);
        const images = (manifestTheme && manifestTheme.images) || [];
        recorded.push(`theme=${theme.name}`);
        if (images.length > 0) {
          renderInspirationGrid(images);
          return {
            type: 'tool_result',
            tool_use_id: tool.id,
            content: `Party plan updated (${recorded.join(', ')}). Showing ${images.length} curated inspiration images for "${theme.name}". The user is selecting their favorites — encourage them and wait for their picks.`,
          };
        }
        return {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: `Party plan updated (${recorded.join(', ')}), but that theme has no images yet. Suggest a different theme.`,
        };
      }

      if (inp.theme_id) {
        return {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: `Theme id "${inp.theme_id}" is not in the curated library. Suggest one of the available themes by its exact theme_id.`,
        };
      }

      return {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: `Party plan updated (${recorded.join(', ') || 'no changes'}). Continue to the next unanswered question.`,
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

  async function init() {
    updateBucketUI();
    await loadManifest();

    // Restore party plan checklist
    renderPlanCard();
    if (data.partyPlan && data.partyPlan.eventType) {
      landingOverlay.classList.add('hidden');
      if (state.sheetState === 'collapsed') setSheetState('half');
    }
    if (data.partyPlan && data.partyPlan.theme) {
      sheetThemeName.textContent = data.partyPlan.theme.name;
    }

    // Restore extracted items
    if (data.extractedItems && data.extractedItems.length > 0) {
      state.extractedItems = data.extractedItems;
      state.inspirationUrls = data.inspirationUrls || [];
      sheetItemCount.textContent = `${data.extractedItems.length} items`;
      renderExtractedItemsInSheet(data.extractedItems);
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
