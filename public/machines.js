/*
 * machines.js — the app's state machines, made explicit.
 *
 * Pure, DOM-free, dependency-free. Loaded by the browser as a plain <script>
 * (exposes window.PartyMachines) and by Node tests via require().
 *
 * Why: the app's flow used to live in scattered `classList.add('hidden')`
 * calls, closures and loosely shaped objects. Every bug fixed in this
 * refactor came from two pieces of code disagreeing about "where we are".
 * Each machine below is the single source of truth for one such question:
 *
 *   journey   — which full-screen step the user is on (one stage → one surface)
 *   plan      — is the Party Plan ready to design, and what's the theme label
 *   cart      — one canonical cart-line shape + the derived numbers
 *   agent     — the chat agent's turn loop (one request in flight, bounded)
 *   designer  — theme designer request/regen bookkeeping (stale-safe)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PartyMachines = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ══════════════════════════════════════
  //  Tiny FSM
  // ══════════════════════════════════════

  /**
   * @param {{ id: string, initial: string, states: Object<string, { on?: Object<string, string|function> }> }} def
   *   A transition target may be a function (payload) => stateName, for guarded branches.
   */
  function createMachine(def, initial) {
    let current = initial && def.states[initial] ? initial : def.initial;
    const listeners = new Set();
    const history = [];

    function events() { return Object.keys((def.states[current] || {}).on || {}); }
    function can(event) { return events().includes(event); }

    function send(event, payload) {
      const node = def.states[current];
      let target = node.on && node.on[event];
      if (typeof target === 'function') target = target(payload || {});
      if (!target) return false; // illegal in this state: ignored, caller can check the return
      if (!def.states[target]) throw new Error(`[${def.id}] unknown target "${target}" for ${current} --${event}-->`);
      const from = current;
      current = target;
      history.push({ from, event, to: target, at: Date.now() });
      if (history.length > 50) history.shift();
      listeners.forEach((fn) => fn(current, { from, event, payload }));
      return true;
    }

    return {
      id: def.id,
      def,
      get state() { return current; },
      events,
      can,
      send,
      history,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  // ══════════════════════════════════════
  //  Journey: home → theme → extracting → decide → shopping → cart
  // ══════════════════════════════════════

  const JOURNEY = {
    id: 'journey',
    initial: 'home',
    states: {
      home:       { on: { DESIGN: 'theme', DESIGN_BOARD: 'boarding', OPEN_CART: 'cart' } },
      theme:      { on: { DESIGN: 'theme', BACK: 'home', ACCEPT: 'extracting' } },
      extracting: { on: { EXTRACTED: 'decide', FAILED: 'theme' } },
      decide:     { on: { DESIGN: 'theme', BACK: (p) => (p.hasTheme ? 'theme' : 'home'), SHOP: 'shopping', OPEN_CART: 'cart' } },
      shopping:   { on: { SHOPPED: 'cart', FAILED: 'decide' } },
      cart:       { on: { DESIGN: 'theme', DESIGN_BOARD: 'boarding', BACK: (p) => (p.via === 'board' && p.hasBoard ? 'board' : (p.hasItems ? 'decide' : 'home')), CHECKOUT: 'home', HOME: 'home' } },
      // Mood-board path: real product listings instead of AI images.
      boarding:   { on: { BOARD_READY: 'board', FAILED: 'board', BACK: 'home' } },
      board:      { on: { BACK: 'home', DESIGN_BOARD: 'boarding', ADD_TO_CART: 'cart', OPEN_CART: 'cart' } },
    },
  };

  // Which DOM surface each stage shows. Exactly one is visible at a time.
  const STAGE_SURFACE = {
    home: 'landing-overlay',
    theme: 'theme-screen',
    extracting: 'theme-screen',
    decide: 'decide-screen',
    shopping: 'decide-screen',
    cart: 'cart-screen',
    boarding: 'board-screen',
    board: 'board-screen',
  };

  // Human/agent-readable description of each stage.
  const STAGE_DESCRIPTION = {
    home: 'filling in the Party Plan cards',
    theme: 'choosing one look per facet in the theme designer',
    extracting: 'waiting while hero pieces are detected from the chosen images',
    decide: 'choosing which detected pieces to shop for',
    shopping: 'waiting while products are found',
    cart: 'reviewing their cart (quantities, budget, checkout)',
    boarding: 'waiting while a mood board of real products is put together',
    board: 'browsing a mood board of real products (each with its store and price)',
  };

  // Transient stages can't survive a reload (their inputs live in memory).
  // Resume to the nearest stage whose inputs are persisted.
  function resumeStage(saved, persisted) {
    const hasItems = !!(persisted && persisted.extractedItems && persisted.extractedItems.length);
    const hasCart = !!(persisted && persisted.partyBucket && persisted.partyBucket.length);
    const hasBoard = !!(persisted && persisted.board && persisted.board.picks && persisted.board.picks.length);
    switch (saved) {
      case 'cart': return hasCart ? 'cart' : (hasItems ? 'decide' : (hasBoard ? 'board' : 'home'));
      case 'board':
      case 'boarding': return hasBoard ? 'board' : 'home';
      case 'decide':
      case 'shopping': return hasItems ? 'decide' : 'home';
      default: return 'home';
    }
  }

  function createJourney(initial) { return createMachine(JOURNEY, initial); }

  // ══════════════════════════════════════
  //  Plan
  // ══════════════════════════════════════

  function emptyPlan() {
    return { eventType: null, budget: null, guestCount: null, setting: null, themePreference: null, theme: null };
  }

  // What the user calls their theme: the designed one if any, else what they asked for.
  function themeLabel(plan) {
    if (!plan) return null;
    const t = plan.theme;
    if (t) return typeof t === 'string' ? t : (t.name || plan.themePreference || null);
    return plan.themePreference || null;
  }

  // The text we send to the theme designer.
  function themeRequest(plan) {
    if (!plan) return '';
    return plan.themePreference || (plan.theme && (plan.theme.name || plan.theme)) || '';
  }

  function planReadiness(plan) {
    const missing = [];
    if (!plan || !plan.eventType) missing.push('party type');
    if (!themeLabel(plan)) missing.push('theme');
    return { ready: missing.length === 0, missing };
  }

  /**
   * Merge fields into the plan. A designed theme is derived from (eventType,
   * themePreference); changing either invalidates it so nothing shows a stale name.
   * @returns {{ plan, changed: string[], invalidatedTheme: boolean }}
   */
  function applyPlanUpdate(plan, fields) {
    const next = { ...emptyPlan(), ...(plan || {}) };
    const changed = [];
    for (const k of ['eventType', 'budget', 'guestCount', 'setting', 'themePreference']) {
      if (fields[k] != null && fields[k] !== next[k]) { next[k] = fields[k]; changed.push(k); }
    }
    const invalidatedTheme = !!next.theme && (changed.includes('eventType') || changed.includes('themePreference'));
    if (invalidatedTheme) next.theme = null;
    return { plan: next, changed, invalidatedTheme };
  }

  // ══════════════════════════════════════
  //  Cart: one canonical line shape
  // ══════════════════════════════════════
  //
  //  { id, item_name, bucket, quantity, pack_size, reason,
  //    product: { title, retailer, link, price, thumbnail } }

  let idSeq = 0;
  function newId() { return Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6); }

  // Accepts the canonical shape, a Shopper pick, or the legacy checkout shape
  // ({ name, price, store, url, image }) and returns a canonical line.
  function normalizeLine(l) {
    if (!l) return null;
    const p = l.product || {};
    const legacy = !l.product;
    return {
      id: l.id || newId(),
      item_name: l.item_name || l.name || p.title || 'Item',
      bucket: l.bucket || 'accent_decor',
      quantity: Math.max(1, Number(l.quantity) || 1),
      pack_size: l.pack_size || null,
      reason: l.reason || '',
      product: {
        title: (legacy ? l.name : p.title) || l.item_name || '',
        retailer: (legacy ? (l.store || l.retailer) : p.retailer) || '',
        link: (legacy ? l.url : p.link) || '',
        price: Number(legacy ? l.price : p.price) || 0,
        thumbnail: (legacy ? l.image : p.thumbnail) || '',
      },
    };
  }

  function normalizeCart(lines) { return (Array.isArray(lines) ? lines : []).map(normalizeLine).filter(Boolean); }

  function lineTotal(l) { return (l.product.price || 0) * (l.quantity || 1); }
  function subtotal(lines) { return +(lines || []).reduce((s, l) => s + lineTotal(l), 0).toFixed(2); }

  // Shape expected by /api/checkout/* (server unchanged).
  function toCheckoutItems(lines) {
    return (lines || []).map((l) => ({
      id: l.id, name: l.product.title || l.item_name, price: l.product.price || 0,
      store: l.product.retailer || 'Google Shopping', bucket: l.bucket, quantity: l.quantity || 1,
      url: l.product.link || '', image: l.product.thumbnail || '',
    }));
  }

  function findLineByName(lines, name) {
    const q = String(name || '').toLowerCase();
    if (!q) return -1;
    return (lines || []).findIndex((l) =>
      (l.item_name || '').toLowerCase().includes(q) || (l.product.title || '').toLowerCase().includes(q));
  }

  function budgetStatus(lines, budget) {
    const s = subtotal(lines);
    if (!budget) return { subtotal: s, budget: null, state: 'no_budget', delta: 0 };
    return { subtotal: s, budget, state: s > budget ? 'over' : 'within', delta: +Math.abs(budget - s).toFixed(2) };
  }

  // ══════════════════════════════════════
  //  Agent loop: idle ⇄ thinking (bounded, one request in flight)
  // ══════════════════════════════════════

  const MAX_AGENT_TURNS = 5;

  const AGENT = {
    id: 'agent',
    initial: 'idle',
    states: {
      idle:     { on: { SEND: 'thinking' } },
      thinking: { on: { DONE: 'idle', ERROR: 'idle' } },
    },
  };
  function createAgent() { return createMachine(AGENT); }

  // Append a message keeping roles strictly alternating (the Messages API
  // contract). Same-role neighbours are merged into one content array.
  function toBlocks(content) {
    if (Array.isArray(content)) return content;
    return [{ type: 'text', text: String(content) }];
  }
  function pushMessage(messages, role, content) {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === 'string' && typeof content === 'string') last.content = last.content + '\n' + content;
      else {
        // tool_result blocks must come first in a user turn
        const merged = [...toBlocks(last.content), ...toBlocks(content)];
        merged.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
        last.content = merged;
      }
    } else {
      messages.push({ role, content });
    }
    return messages;
  }

  // Rebuild API context from the persisted, text-only transcript.
  function messagesFromTranscript(history) {
    const msgs = [];
    for (const m of history || []) {
      if (!m || !m.text || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if (msgs.length === 0 && m.role !== 'user') continue; // must start with user
      pushMessage(msgs, m.role, m.text);
    }
    return msgs;
  }

  // ══════════════════════════════════════
  //  Theme designer bookkeeping
  // ══════════════════════════════════════

  const MAX_REGENERATIONS = 3;
  const FACETS = ['backdrop', 'table', 'accent'];

  function normalizeKey(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

  function createDesigner() {
    const regenUsed = {};
    const d = {
      status: 'idle',          // idle | loading | ready | error
      req: 0,                  // bumped on every new request; async results carry it
      pref: '',
      theme: null, key: null, cached: false, saved: false,
      facets: {},              // facet → { status: loading|ready|failed, images: [], prompt }
      chosen: {},              // facet → url

      begin(pref) {
        d.req += 1;
        d.status = 'loading';
        d.pref = pref || '';
        d.theme = null; d.key = null; d.cached = false; d.saved = false;
        d.facets = {}; d.chosen = {};
        return d.req;
      },
      isCurrent(token) { return token === d.req; },
      cancel() { d.req += 1; if (d.status === 'loading') d.status = 'idle'; },
      regensLeft(pref) { return Math.max(0, MAX_REGENERATIONS - (regenUsed[normalizeKey(pref ?? d.pref)] || 0)); },
      useRegen(pref) { const k = normalizeKey(pref ?? d.pref); regenUsed[k] = (regenUsed[k] || 0) + 1; return d.regensLeft(pref); },
      canAccept() { return d.status === 'ready' && FACETS.every((f) => !d.facets[f] || d.chosen[f]) && Object.keys(d.chosen).length > 0; },
    };
    return d;
  }

  return {
    createMachine,
    JOURNEY, STAGE_SURFACE, STAGE_DESCRIPTION, resumeStage, createJourney,
    emptyPlan, themeLabel, themeRequest, planReadiness, applyPlanUpdate,
    normalizeLine, normalizeCart, lineTotal, subtotal, toCheckoutItems, findLineByName, budgetStatus,
    MAX_AGENT_TURNS, AGENT, createAgent, pushMessage, messagesFromTranscript,
    MAX_REGENERATIONS, FACETS, createDesigner,
  };
});
