/* ============================================================
   DL CO-PILOT — CORE (STANDALONE)
   ------------------------------------------------------------
   Responsibilities:
   - Find DOM + wire CTA / panel open/close
   - Render messages (AI/User)
   - Render pills (option buttons) in a consistent, styleable way
   - Render selectable lists (cards) for categories / products
   - Lock/unlock input (so flows can force “choose above”)
   - Persist/restore conversation + flow + user sizing profile
   - Route intents (emit flow:route) without duplicating flow starts
   - Own SIZING flows (global + product-specific) using window.DLCopilotSizing

   Modules are expected to:
   - Listen to: flow:route, input:submit
   - Optionally emit: intent:select (core will route → flow:route)
   - Use api.appendAI / api.renderPills / api.setInputLocked
   - Never hardcode products/categories (core provides helpers)

   NOTE:
   - sizing.js is a pure logic lib (window.DLCopilotSizing), not a module.
   - products.js is resolver only (no UI), may be used by modules. Core does not rewrite it.
============================================================ */

(function () {
  'use strict';

  /* ============================================================
     0) CONFIG
  ============================================================ */

  var CONFIG = {
    // BUMPED: we need new persisted shape (profile + product sizing flow)
    // Old data is safely ignored (and won’t cause dead ends).
    storageKey: 'dl_copilot_state_v5',
    debug: !!window.DL_COPILOT_DEBUG,

    selectors: {
      // Panel root is in sections/dl-copilot.liquid
      panel: '#DLCopilotPanel',
      body: '#DLCopilotBody',
      input: '#DLCopilotInput',
      send: '#DLCopilotSend',
      close: '#DLCopilotClose',

      // CTA (floating button)
      cta: '.dl-copilot-float'
    },

    // Shopify JSON endpoints (no storefront token required)
    endpoints: {
      collectionsJson: '/collections.json?limit=250',
      collectionProductsJson: function (collectionHandle) {
        return '/collections/' + encodeURIComponent(collectionHandle) + '/products.json?limit=250';
      }
    },

    // Rendering guardrails
    maxMessagesToPersist: 250,
    maxMessageHtmlLength: 16000,

    // UX / anti-spam guards
    readyFallbackCooldownMs: 6000
  };

  function log() {
    if (!CONFIG.debug) return;
    try { console.log.apply(console, ['[DL Copilot]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function warn() {
    try { console.warn.apply(console, ['[DL Copilot]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ============================================================
     1) SAFE UTILS
  ============================================================ */

  function qs(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function qsa(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  }

  function toStr(v) {
    return String(v == null ? '' : v);
  }

  function toInt(v, fallback) {
    var n = parseInt(v, 10);
    return isNaN(n) ? (fallback == null ? null : fallback) : n;
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var ctx = this;
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function escapeText(text) {
    return toStr(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Small sanitizer for AI html content
  function sanitizeHtml(html) {
    html = toStr(html);
    html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/\son\w+="[^"]*"/gi, '');
    html = html.replace(/\son\w+='[^']*'/gi, '');
    return html;
  }

  function nowId() {
    return (
      'r_' +
      Math.random().toString(16).slice(2) +
      '_' +
      Date.now().toString(16)
    );
  }

  function nowTs() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  function isLikelyProductPage() {
    try { return !!(window.location && /\/products\//i.test(window.location.pathname || '')); } catch (e) { return false; }
  }

  function isLikelyCollectionPage() {
    try { return !!(window.location && /\/collections\//i.test(window.location.pathname || '')); } catch (e) { return false; }
  }

  function hasPillGroupInDom() {
    if (!dom.body) return false;
    return !!qs('.dl-copilot-pillgroup, .dl-copilot-options, .dl-copilot-cardgrid', dom.body);
  }

  function safeJsonParse(raw, fallback) {
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ============================================================
     1.1) LABEL / LIST HELPERS (ADDED — fixes ugly repeats)
  ============================================================ */

  function cleanCategoryTitle(rawTitle) {
    var t = toStr(rawTitle || '').trim();
    if (!t) return '';

    // Remove gender prefixes and common separators
    t = t.replace(/^(menswear|mens|men)\s*[-:|/]\s*/i, '');
    t = t.replace(/^(womenswear|womens|women)\s*[-:|/]\s*/i, '');
    t = t.replace(/^(man)\s*[-:|/]\s*/i, '');
    t = t.replace(/^(woman)\s*[-:|/]\s*/i, '');

    // Also remove standalone gender words
    t = t.replace(/\bmenswear\b/ig, '');
    t = t.replace(/\bwomenswear\b/ig, '');
    t = t.replace(/\bmens\b/ig, '');
    t = t.replace(/\bwomens\b/ig, '');
    t = t.replace(/\bmen\b/ig, '');
    t = t.replace(/\bwomen\b/ig, '');
    t = t.replace(/\bman\b/ig, '');
    t = t.replace(/\bwoman\b/ig, '');

    // Cleanup whitespace
    t = t.replace(/\s{2,}/g, ' ').trim();

    // If the result becomes empty, fall back to original
    if (!t) t = toStr(rawTitle || '').trim();

    return t;
  }

  function dedupeByKey(items, keyFn) {
    var out = [];
    var seen = {};
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      if (!it) continue;
      var key = toStr(keyFn(it) || '').toLowerCase().trim();
      if (!key) continue;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(it);
    }
    return out;
  }

  /* ============================================================
     1.2) LENGTH HELPERS (CORE FALLBACK)
     ------------------------------------------------------------
     IMPORTANT:
     - DL sizing doctrine: EU size is anchored to user's usual size.
     - Length is derived from height and product's length variants.
     - If sizing.js doesn't return length yet for GENERAL flows,
       core provides a height-based fallback mapping.
     - When sizing.js is updated to return length everywhere,
       this fallback remains safe and can be removed.
  ============================================================ */

  function lengthLabelFromHeight(heightCm) {
    var h = toInt(heightCm, null);
    if (!h) return '';
    // Matches your variant wording style (Short / Standard / Long).
    // Ranges mirror what you already show to users (e.g. Standard 166–185).
    if (h < 166) return 'Short';
    if (h > 185) return 'Long';
    return 'Standard';
  }

  function lengthRangeHint(label) {
    label = toStr(label || '');
    if (!label) return '';
    if (/^short$/i.test(label)) return '(≤165 cm)';
    if (/^standard$/i.test(label)) return '(166–185 cm)';
    if (/^long$/i.test(label)) return '(≥186 cm)';
    return '';
  }

  /* ============================================================
     2) EVENT BUS
  ============================================================ */

  function createBus() {
    var listeners = {};
    function on(evt, fn) {
      if (!evt || typeof fn !== 'function') return;
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    }
    function off(evt, fn) {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter(function (x) { return x !== fn; });
    }
    function emit(evt, payload) {
      if (!listeners[evt] || !listeners[evt].length) return;
      listeners[evt].slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { warn('Listener error for', evt, e); }
      });
    }
    return { on: on, off: off, emit: emit };
  }

  var bus = createBus();

  /* ============================================================
     3) DOM + STATE
  ============================================================ */

  var dom = {
    panel: null,
    body: null,
    input: null,
    send: null,
    close: null,
    cta: null
  };

  // Persistent “global” state
  var state = {
    hasBooted: false,

    // UI
    isOpen: false,
    inputLocked: true,
    inputLockPlaceholder: 'Please choose an option above',

    // Persisted content
    messages: [],

    // Persisted flow routing (high-level)
    flow: {
      intent: null,           // 'size_guidance' | 'size_product' | 'styling_advice' | 'order_support'
      step: 'entry',          // step inside a flow (string)
      payload: {},            // ephemeral payload
      activeModule: null,     // if a module owns the flow
      routeId: null
    },

    // Persisted profile + product sizing session
    sizing: {
      // user body
      height_cm: null,
      weight_kg: null,

      // optional preferences
      gender: null,            // 'men' | 'women' | null
      // category sizing memory (for global profile)
      // ex: { "jackets": { usual_size_eu: 48, recommended_size_eu: 48, recommended_length: "Regular", updated_at: 123 } }
      categories: {},

      // last used category/product context (for product-specific sizing)
      last: {
        gender: null,
        category_handle: null,
        category_title: null,
        product_handle: null,
        product_title: null
      }
    },

    // Persisted module stores (optional)
    modules: {},

    // Guards
    entryRenderedOnce: false,
    lastRoutedId: null,

    // Anti-spam
    lastReadyFallbackAt: 0
  };

  /* ============================================================
     4) STORAGE
  ============================================================ */

  function storageRead() {
    try {
      var raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) return null;
      return safeJsonParse(raw, null);
    } catch (e) {
      return null;
    }
  }

  function storageWrite(obj) {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageClear() {
    try { localStorage.removeItem(CONFIG.storageKey); } catch (e) {}
  }

  function persistNow() {
    var safeMessages = (state.messages || []).slice(-CONFIG.maxMessagesToPersist).map(function (m) {
      var t = m && m.type ? m.type : 'ai';
      var h = m && m.html ? toStr(m.html) : '';
      if (h.length > CONFIG.maxMessageHtmlLength) h = h.slice(0, CONFIG.maxMessageHtmlLength);
      return { type: t, html: h };
    });

    var payload = {
      v: 5,
      isOpen: !!state.isOpen,
      inputLocked: !!state.inputLocked,
      inputLockPlaceholder: toStr(state.inputLockPlaceholder || ''),
      messages: safeMessages,
      flow: state.flow || {},
      sizing: state.sizing || {},
      modules: state.modules || {},
      entryRenderedOnce: !!state.entryRenderedOnce,
      lastRoutedId: toStr(state.lastRoutedId || ''),
      lastReadyFallbackAt: toInt(state.lastReadyFallbackAt || 0, 0)
    };

    storageWrite(payload);
  }

  function restoreFromStorage() {
    var saved = storageRead();
    if (!saved || typeof saved !== 'object') return false;

    state.isOpen = !!saved.isOpen;
    state.inputLocked = saved.inputLocked == null ? true : !!saved.inputLocked;
    state.inputLockPlaceholder = toStr(saved.inputLockPlaceholder || 'Please choose an option above');

    state.messages = Array.isArray(saved.messages) ? saved.messages : [];
    state.flow = saved.flow && typeof saved.flow === 'object' ? saved.flow : state.flow;
    state.sizing = saved.sizing && typeof saved.sizing === 'object' ? saved.sizing : state.sizing;

    if (!state.sizing || typeof state.sizing !== 'object') state.sizing = { height_cm: null, weight_kg: null, gender: null, categories: {}, last: {} };
    if (!state.sizing.categories || typeof state.sizing.categories !== 'object') state.sizing.categories = {};
    if (!state.sizing.last || typeof state.sizing.last !== 'object') state.sizing.last = {};

    state.modules = saved.modules && typeof saved.modules === 'object' ? saved.modules : {};
    state.entryRenderedOnce = !!saved.entryRenderedOnce;
    state.lastRoutedId = toStr(saved.lastRoutedId || '');
    state.lastReadyFallbackAt = toInt(saved.lastReadyFallbackAt || 0, 0);

    return true;
  }

  /* ============================================================
     5) DOM DISCOVERY
  ============================================================ */

  function findDom() {
    dom.panel = qs(CONFIG.selectors.panel);
    dom.body = qs(CONFIG.selectors.body);
    dom.input = qs(CONFIG.selectors.input);
    dom.send = qs(CONFIG.selectors.send);
    dom.close = qs(CONFIG.selectors.close);
    dom.cta = qs(CONFIG.selectors.cta);

    return !!(dom.panel && dom.body && dom.input && dom.send);
  }

  /* ============================================================
     6) RENDERING — MESSAGES
  ============================================================ */

  function scrollBodyToBottom() {
    if (!dom.body) return;
    try { dom.body.scrollTop = dom.body.scrollHeight; } catch (e) {}
  }

  function makeMsgEl(type, html) {
    var wrap = document.createElement('div');
    wrap.className = 'dl-copilot-msg ' + (type === 'user' ? 'dl-copilot-msg--user' : 'dl-copilot-msg--ai');

    var bubble = document.createElement('div');
    bubble.className = 'dl-copilot-bubble';
    bubble.innerHTML = sanitizeHtml(toStr(html || ''));

    wrap.appendChild(bubble);
    return wrap;
  }

  function appendAI(html, opts) {
    opts = opts || {};
    var m = { type: 'ai', html: toStr(html || '') };

    state.messages.push(m);

    if (dom.body) {
      dom.body.appendChild(makeMsgEl('ai', m.html));
      scrollBodyToBottom();
    }

    if (!opts.noPersist) persistNow();
  }

  function appendUser(text, opts) {
    opts = opts || {};
    var m = { type: 'user', html: escapeText(toStr(text || '')) };

    state.messages.push(m);

    if (dom.body) {
      dom.body.appendChild(makeMsgEl('user', m.html));
      scrollBodyToBottom();
    }

    if (!opts.noPersist) persistNow();
  }

  function clearMessages() {
    state.messages = [];
    if (dom.body) dom.body.innerHTML = '';
    persistNow();
  }

  function reRenderAllMessagesFromState() {
    if (!dom.body) return;
    dom.body.innerHTML = '';
    (state.messages || []).forEach(function (m) {
      dom.body.appendChild(makeMsgEl(m.type === 'user' ? 'user' : 'ai', m.html));
    });
    scrollBodyToBottom();
  }

  /* ============================================================
     7) RENDERING — PILLS + CARD GRIDS
  ============================================================ */

  function removeExistingChoiceUIs() {
    if (!dom.body) return;
    qsa('.dl-copilot-pillgroup, .dl-copilot-options, .dl-copilot-cardgrid', dom.body).forEach(function (el) {
      try { el.remove(); } catch (e) {}
    });
  }

  function renderPills(pills) {
    pills = Array.isArray(pills) ? pills : [];
    if (!dom.body) return;

    removeExistingChoiceUIs();

    // Container that matches your existing CSS
    var group = document.createElement('div');
    group.className = 'dl-copilot-options';

    // Row wrapper that your CSS expects for spacing/wrapping
    var row = document.createElement('div');
    row.className = 'dl-copilot-options__row';

    pills.forEach(function (p) {
      if (!p) return;

      var label = toStr(p.label || '').trim();
      if (!label) return;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl-copilot-pill dl-copilot-option dl-copilot-quick';
      btn.textContent = label;

      btn.addEventListener('click', function () {
        if (p.userEcho !== false) appendUser(label);

        removeExistingChoiceUIs();

        if (p.unlockInput) setInputLocked(false, '');

        try {
          if (typeof p.onClick === 'function') p.onClick();
          else if (typeof p.onSelect === 'function') p.onSelect();
        } catch (e) {
          warn('Pill handler error', e);
        }
      });

      row.appendChild(btn);
    });

    group.appendChild(row);
    dom.body.appendChild(group);
    scrollBodyToBottom();
  }

  function renderCardGrid(items, opts) {
    opts = opts || {};
    items = Array.isArray(items) ? items : [];
    if (!dom.body) return;

    removeExistingChoiceUIs();

    var grid = document.createElement('div');
    grid.className = 'dl-copilot-cardgrid';

    items.forEach(function (it) {
      if (!it) return;

      var title = toStr(it.title || '');
      var subtitle = toStr(it.subtitle || '');
      var image = toStr(it.image || '');
      var value = it.value;

      if (!title) return;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl-copilot-card';
      btn.setAttribute('data-value', toStr(value == null ? '' : value));

      var inner = '';
      if (image) {
        inner += '<div class="dl-copilot-card__img"><img src="' + escapeText(image) + '" alt="' + escapeText(title) + '"></div>';
      }
      inner += '<div class="dl-copilot-card__meta">';
      inner += '<div class="dl-copilot-card__title">' + escapeText(title) + '</div>';
      if (subtitle) inner += '<div class="dl-copilot-card__sub">' + escapeText(subtitle) + '</div>';
      inner += '</div>';

      btn.innerHTML = inner;

      btn.addEventListener('click', function () {
        if (opts.userEchoTitle !== false) appendUser(title);

        removeExistingChoiceUIs();

        try {
          if (typeof opts.onSelect === 'function') opts.onSelect(value, it);
        } catch (e) {
          warn('CardGrid onSelect error', e);
        }
      });

      grid.appendChild(btn);
    });

    dom.body.appendChild(grid);
    scrollBodyToBottom();
  }
  /* ============================================================
     7.1) MAIN MENU (STATE-AWARE)
  ============================================================ */

  function hasAnySavedSizingProfile() {
    // A profile is considered “available” if we at least have height and weight.
    // Category-specific “usual sizes” are optional but preferred.
    return !!(state.sizing && state.sizing.height_cm && state.sizing.weight_kg);
  }

  function renderMainMenuPills() {
    var firstLabel = hasAnySavedSizingProfile() ? 'Review my recommended size' : 'Recommend my size';

    renderPills([
      {
        label: firstLabel,
        unlockInput: false,
        onClick: function () {
          bus.emit('intent:select', { intent: 'size_guidance', payload: { mode: hasAnySavedSizingProfile() ? 'review' : 'new' }, routeId: nowId() });
        }
      },
      {
        label: 'Find my size for a product',
        unlockInput: false,
        onClick: function () {
          bus.emit('intent:select', { intent: 'size_product', payload: {}, routeId: nowId() });
        }
      },
      {
        label: 'Style an outfit',
        unlockInput: false,
        onClick: function () {
          bus.emit('intent:select', { intent: 'styling_advice', payload: {}, routeId: nowId() });
        }
      },
      {
        label: 'Help with my order',
        unlockInput: false,
        onClick: function () {
          bus.emit('intent:select', { intent: 'order_support', payload: {}, routeId: nowId() });
        }
      }
    ]);
  }

  function ensureMenuWhenLocked() {
    if (!dom.body) return;
    if (!state.inputLocked) return;
    if (hasPillGroupInDom()) return;
    renderMainMenuPills();
  }

  /* ============================================================
     8) INPUT LOCKING
  ============================================================ */

  function applyInputLockState() {
    if (!dom.input || !dom.send) return;

    if (state.inputLocked) {
      dom.input.setAttribute('readonly', 'readonly');
      dom.input.classList.add('is-locked');
      dom.send.setAttribute('disabled', 'disabled');
      dom.send.classList.add('is-disabled');

      dom.input.placeholder = toStr(state.inputLockPlaceholder || 'Please choose an option above');
    } else {
      dom.input.removeAttribute('readonly');
      dom.input.classList.remove('is-locked');
      dom.send.removeAttribute('disabled');
      dom.send.classList.remove('is-disabled');

      dom.input.placeholder = 'Type your message…';
    }
  }

  function setInputLocked(locked, placeholder) {
    state.inputLocked = !!locked;
    if (typeof placeholder === 'string') state.inputLockPlaceholder = placeholder;
    applyInputLockState();
    persistNow();
    ensureMenuWhenLocked();
  }

  function lockInput(placeholder) {
    setInputLocked(true, typeof placeholder === 'string' ? placeholder : 'Please choose an option above');
  }

  function unlockInput() {
    setInputLocked(false, '');
  }

  function setComposerPlaceholder(placeholder) {
    if (!dom.input) return;
    if (state.inputLocked) return;
    dom.input.placeholder = toStr(placeholder || 'Type your message…');
  }

  /* ============================================================
     9) PANEL OPEN/CLOSE
  ============================================================ */

  function openPanel() {
    if (!dom.panel) return;

    dom.panel.classList.add('is-open');
    state.isOpen = true;
    persistNow();

    renderEntryIfAvailable();
    ensureMenuWhenLocked();

    try {
      if (dom.input && !state.inputLocked) dom.input.focus();
    } catch (e) {}
  }

  function closePanel() {
    if (!dom.panel) return;
    dom.panel.classList.remove('is-open');
    state.isOpen = false;
    persistNow();
  }

  /* ============================================================
     10) FLOW ROUTING
  ============================================================ */

  function normalizeIntent(intent) {
    intent = toStr(intent).trim();
    if (!intent) return '';

    var map = {
      // sizing
      'recommend_my_size': 'size_guidance',
      'size': 'size_guidance',
      'sizing': 'size_guidance',
      'review_size': 'size_guidance',

      // product sizing
      'size_product': 'size_product',
      'find_size_for_product': 'size_product',
      'product_size': 'size_product',

      // styling
      'style': 'styling_advice',
      'styling': 'styling_advice',
      'styling_flow': 'styling_advice',

      // order
      'order': 'order_support',
      'help_with_order': 'order_support'
    };

    return map[intent] || intent;
  }

  function routeIntent(payload) {
    payload = payload || {};

    var rawIntent = typeof payload === 'string' ? payload : payload.intent;
    var intent = normalizeIntent(rawIntent);

    var pld = (typeof payload === 'object' && payload.payload) ? payload.payload : {};
    var routeId = (typeof payload === 'object' && payload.routeId) ? toStr(payload.routeId) : '';

    if (!routeId) routeId = nowId();

    if (state.lastRoutedId && routeId === state.lastRoutedId) {
      log('routeIntent deduped', routeId, intent);
      return;
    }

    state.lastRoutedId = routeId;

    state.flow = state.flow || {};
    state.flow.intent = intent || null;
    state.flow.payload = (pld && typeof pld === 'object') ? pld : {};
    state.flow.step = state.flow.step || 'active';
    state.flow.routeId = routeId;

    persistNow();

    bus.emit('flow:route', { intent: intent, payload: state.flow.payload, routeId: routeId, source: 'core-router' });
  }

  bus.on('intent:select', routeIntent);

  /* ============================================================
     10.1) CORE-OWNED SIZING FLOWS
     - Global size profile: review / new
     - Global recommendation: choose Category vs Product (C)
     - Product-specific sizing: gender → category → product → user info → recommend (EU + length)
  ============================================================ */

  function sizingIsAvailable() {
    return !!(window.DLCopilotSizing && typeof window.DLCopilotSizing === 'object');
  }

  /* ============================================================
     GLOBAL SIZING FLOW STATE
  ============================================================ */

  var globalSizingFlow = {
    active: false,
    routeId: null,

    // new in v5 global sizing:
    targetMode: null, // 'category' | 'product'
    gender: null,
    category: null,
    usual_size_eu: null
  };

  function globalSizingResetSession() {
    globalSizingFlow.targetMode = null;
    globalSizingFlow.gender = null;
    globalSizingFlow.category = null;
    globalSizingFlow.usual_size_eu = null;
  }

  function globalSizingStart(route) {
    route = route || {};
    var mode = (route.payload && route.payload.mode) ? toStr(route.payload.mode) : 'new';
    var routeId = toStr(route.routeId || '');

    globalSizingFlow.active = true;
    globalSizingFlow.routeId = routeId || nowId();
    globalSizingResetSession();

    state.flow.intent = 'size_guidance';
    state.flow.step = 'global_start';
    persistNow();

    removeExistingChoiceUIs();

    if (mode === 'review' && hasAnySavedSizingProfile()) {
      globalSizingReview();
      return;
    }

    appendAI("Let’s set up your size profile.");
    globalSizingAskBody();
  }

  function globalSizingStop() {
    globalSizingFlow.active = false;
    globalSizingFlow.routeId = null;
    globalSizingResetSession();

    state.flow.intent = null;
    state.flow.step = 'entry';
    state.flow.payload = {};
    persistNow();

    renderMainMenuPills();
    lockInput('Please choose an option above');
  }

  /* ============================================================
     GLOBAL SIZING: REVIEW + NEXT STEP (FIXED)
  ============================================================ */

  function globalSizingReview() {
    state.flow.step = 'global_review';
    persistNow();

    var h = state.sizing.height_cm;
    var w = state.sizing.weight_kg;

    appendAI(
      "I already have sizing info saved:<br>" +
      "• Height: <strong>" + escapeText(h) + " cm</strong><br>" +
      "• Weight: <strong>" + escapeText(w) + " kg</strong><br><br>" +
      "Is this still correct?"
    );

    renderPills([
      {
        label: 'Yes, that’s correct',
        unlockInput: false,
        onClick: function () {
          // IMPORTANT: do not stop here anymore.
          appendAI("Great. What would you like sizing for?");
          globalSizingAskTarget();
        }
      },
      {
        label: 'No, update it',
        unlockInput: false,
        onClick: function () {
          // Reset body only (category sizes can remain, but are now “stale”)
          state.sizing.height_cm = null;
          state.sizing.weight_kg = null;
          persistNow();

          appendAI("No problem. Let’s update your measurements.");
          globalSizingAskBody();
        }
      }
    ]);

    lockInput('Please choose an option above');
  }

  function globalSizingAskBody() {
    state.flow.step = 'global_collect_body';
    persistNow();

    appendAI("What is your height in cm?");
    unlockInput();
    setComposerPlaceholder('e.g. 178');
  }

  function globalSizingAskTarget() {
    state.flow.step = 'global_target';
    persistNow();

    renderPills([
      {
        label: 'A specific product',
        unlockInput: false,
        onClick: function () {
          globalSizingFlow.targetMode = 'product';
          persistNow();

          // Route into the product sizing flow (re-uses saved body)
          appendAI("Perfect. Let’s size a specific product.");
          bus.emit('intent:select', { intent: 'size_product', payload: {}, routeId: nowId() });
        }
      },
      {
        label: 'A product category (general sizing)',
        unlockInput: false,
        onClick: function () {
          globalSizingFlow.targetMode = 'category';
          persistNow();

          appendAI("Perfect. Let’s do a category-based recommendation.");
          globalSizingAskGender();
        }
      }
    ]);

    lockInput('Please choose an option above');
  }

  function globalSizingAskGender() {
    state.flow.step = 'global_gender';
    persistNow();

    // If gender is already saved, we can skip asking.
    if (state.sizing && (state.sizing.gender === 'men' || state.sizing.gender === 'women')) {
      globalSizingFlow.gender = state.sizing.gender;
      persistNow();
      globalSizingAskCategory();
      return;
    }

    appendAI("Who are you shopping for?");
    renderPills([
      {
        label: 'Menswear',
        unlockInput: false,
        onClick: function () {
          globalSizingFlow.gender = 'men';
          state.sizing.gender = 'men';
          state.sizing.last.gender = 'men';
          persistNow();
          globalSizingAskCategory();
        }
      },
      {
        label: 'Womenswear',
        unlockInput: false,
        onClick: function () {
          globalSizingFlow.gender = 'women';
          state.sizing.gender = 'women';
          state.sizing.last.gender = 'women';
          persistNow();
          globalSizingAskCategory();
        }
      }
    ]);

    lockInput('Please choose an option above');
  }

  function normalizeGenderForCollectionFilter(gender) {
    return gender === 'women' ? 'women' : 'men';
  }

  function filterCollectionsForGender(collections, gender) {
    gender = normalizeGenderForCollectionFilter(gender);
    var out = [];
    var i;

    for (i = 0; i < collections.length; i++) {
      var c = collections[i];
      if (!c) continue;

      var handle = toStr(c.handle || '');
      var title = toStr(c.title || '');

      if (!handle || !title) continue;

      // Exclude obvious non-product collections
      if (/all|frontpage|featured|new|sale|journal|stories|lookbook|gift|about|policy|shipping/i.test(handle)) continue;

      // Exclude generic gender landing collections
      if (/^(men|mens|man|women|womens|woman)$/i.test(handle)) continue;
      if (/^(men|mens|man|women|womens|woman)$/i.test(title.trim())) continue;

      // Gender inclusion
      if (gender === 'men') {
        if (/(men|mens|man)\b/i.test(handle) || /(men|mens)\b/i.test(title)) out.push(c);
      } else {
        if (/(women|womens|woman)\b/i.test(handle) || /(women|womens)\b/i.test(title)) out.push(c);
      }
    }

    if (!out.length) out = collections.slice();

    out.sort(function (a, b) {
      var at = toStr(a.title || '').toLowerCase();
      var bt = toStr(b.title || '').toLowerCase();
      if (at < bt) return -1;
      if (at > bt) return 1;
      return 0;
    });

    return out;
  }

  function globalSizingAskCategory() {
    state.flow.step = 'global_category_loading';
    persistNow();

    appendAI("Which category do you want sizing for?");
    appendAI("Loading categories…");
    lockInput('Loading categories…');

    fetchJson(CONFIG.endpoints.collectionsJson)
      .then(function (data) {
        var collections = (data && data.collections) ? data.collections : [];
        collections = Array.isArray(collections) ? collections : [];

        var filtered = filterCollectionsForGender(collections, globalSizingFlow.gender);

        var cards = filtered.map(function (c) {
          var img = '';
          try {
            if (c.image && c.image.src) img = c.image.src;
          } catch (e) {}

          var rawTitle = toStr(c.title || '');
          var cleanTitle = cleanCategoryTitle(rawTitle);

          return {
            title: cleanTitle || rawTitle,
            subtitle: '',
            image: img,
            value: { handle: toStr(c.handle || ''), title: toStr(c.title || '') }
          };
        }).filter(function (x) { return x && x.value && x.value.handle; });

        cards = dedupeByKey(cards, function (it) { return toStr(it.title || ''); });

        state.flow.step = 'global_category';
        persistNow();

        renderCardGrid(cards, {
          userEchoTitle: true,
          onSelect: function (value, item) {
            globalSizingFlow.category = { handle: value.handle, title: value.title };

            state.sizing.last.category_handle = value.handle;
            state.sizing.last.category_title = value.title;
            persistNow();

            globalSizingAskUsualSize();
          }
        });

        lockInput('Please choose an option above');
      })
      .catch(function (e) {
        warn('collections.json failed', e);
        appendAI("I couldn’t load categories right now. Please try again.");
        renderMainMenuPills();
        lockInput('Please choose an option above');
        globalSizingStop();
      });
  }

  function globalSizingAskUsualSize() {
    state.flow.step = 'global_usual_size';
    persistNow();

    var catHandle = (globalSizingFlow.category && globalSizingFlow.category.handle) ? globalSizingFlow.category.handle : '';
    var catTitle = (globalSizingFlow.category && globalSizingFlow.category.title) ? globalSizingFlow.category.title : 'this category';

    // If we already have a saved usual size for this category, offer it as a pill.
    var saved = null;
    try {
      if (catHandle && state.sizing && state.sizing.categories && state.sizing.categories[catHandle] && state.sizing.categories[catHandle].usual_size_eu) {
        saved = state.sizing.categories[catHandle].usual_size_eu;
      }
    } catch (e) { saved = null; }

    if (saved) {
      appendAI("I have your usual EU size saved for <strong>" + escapeText(catTitle) + "</strong>: <strong>EU " + escapeText(saved) + "</strong>.<br>Do you want to use it?");
      renderPills([
        {
          label: 'Yes, use EU ' + saved,
          unlockInput: false,
          onClick: function () {
            globalSizingFlow.usual_size_eu = saved;
            persistNow();
            globalSizingComputeGeneralRecommendation();
          }
        },
        {
          label: 'No, enter a different size',
          unlockInput: false,
          onClick: function () {
            appendAI("Sure. What is your usual EU size?");
            unlockInput();
            setComposerPlaceholder('e.g. 48');
          }
        }
      ]);
      lockInput('Please choose an option above');
      return;
    }

    appendAI("What is your usual EU size for <strong>" + escapeText(catTitle) + "</strong>?");
    unlockInput();
    setComposerPlaceholder('e.g. 48');
  }
  function globalSizingComputeGeneralRecommendation() {
    state.flow.step = 'global_compute';
    persistNow();

    if (!sizingIsAvailable()) {
      appendAI("Sizing isn't available right now.");
      globalSizingStop();
      return;
    }

    // Core sizing doctrine (DL):
    // - EU size is anchored to user's usual size
    // - Weight/height are used for sanity checks and length only
    // - Length is derived from height, and should be returned by sizing.js when available
    var user = {
      height_cm: state.sizing.height_cm,
      weight_kg: state.sizing.weight_kg,
      usual_size_eu: globalSizingFlow.usual_size_eu
    };

    var catHandle = (globalSizingFlow.category && globalSizingFlow.category.handle) ? globalSizingFlow.category.handle : null;
    var gender = globalSizingFlow.gender || (state.sizing ? state.sizing.gender : null);

    // Try sizing.js schemaForGeneral -> recommend
    var schema = null;
    var rec = null;

    try {
      if (window.DLCopilotSizing && typeof window.DLCopilotSizing.schemaForGeneral === 'function') {
        schema = window.DLCopilotSizing.schemaForGeneral(catHandle, gender);
      }
    } catch (e) { schema = null; }

    try {
      if (schema && window.DLCopilotSizing && typeof window.DLCopilotSizing.recommend === 'function') {
        rec = window.DLCopilotSizing.recommend(schema, user);
      }
    } catch (e) { rec = null; }

    // If sizing.js doesn't return length for general, we fallback based on height.
    var sizeEu = null;
    var length = '';

    if (rec) {
      sizeEu = rec.size_eu != null ? rec.size_eu : (rec.eu_size != null ? rec.eu_size : null);
      length = rec.length != null ? rec.length : (rec.length_variant != null ? rec.length_variant : '');
    }

    // In DL doctrine: EU size should match usual size unless sizing.js explicitly overrides for some reason.
    // If sizing.js returns null/undefined, use user's usual size.
    if (sizeEu == null) sizeEu = globalSizingFlow.usual_size_eu;

    if (!length) {
      length = lengthLabelFromHeight(state.sizing.height_cm);
    }

    // Persist category memory
    var catKey = catHandle || 'unknown';
    if (!state.sizing.categories[catKey]) state.sizing.categories[catKey] = {};
    state.sizing.categories[catKey].usual_size_eu = globalSizingFlow.usual_size_eu;
    state.sizing.categories[catKey].recommended_size_eu = sizeEu;
    state.sizing.categories[catKey].recommended_length = length;
    state.sizing.categories[catKey].updated_at = nowTs();
    persistNow();

    var catTitle = (globalSizingFlow.category && globalSizingFlow.category.title) ? globalSizingFlow.category.title : 'this category';
    var lengthHint = lengthRangeHint(length);

    appendAI(
      "For <strong>" + escapeText(catTitle) + "</strong>, I recommend:<br>" +
      "• Size: <strong>EU " + escapeText(sizeEu) + "</strong><br>" +
      "• Length: <strong>" + escapeText(length) + "</strong> " + (lengthHint ? escapeText(lengthHint) : "") + "<br><br>" +
      "Does that look right?"
    );

    renderPills([
      {
        label: 'Yes, that’s correct',
        unlockInput: false,
        onClick: function () {
          appendAI("Perfect. How can I help next?");
          globalSizingStop();
        }
      },
      {
        label: 'No, adjust',
        unlockInput: false,
        onClick: function () {
          appendAI("No problem. Let’s adjust your usual size for this category.");
          globalSizingAskUsualSize();
        }
      }
    ]);

    lockInput('Please choose an option above');
  }

  function globalSizingHandleText(text) {
    text = toStr(text || '').trim();
    if (!text) return true;

    // Step machine:
    // - If height missing → parse height
    // - Else if weight missing → parse weight
    // - Else if usual size step → parse usual size
    // - Else stop safely
    if (!state.sizing.height_cm) {
      var h = toInt(text.replace(/[^\d]/g, ''), null);
      if (!h || h < 120 || h > 220) {
        appendAI("Please send your height as a number in cm (e.g. 178).");
        setComposerPlaceholder('e.g. 178');
        return true;
      }
      state.sizing.height_cm = h;
      persistNow();

      appendAI("Got it. What is your weight in kg?");
      setComposerPlaceholder('e.g. 75');
      return true;
    }

    if (!state.sizing.weight_kg) {
      var w = toInt(text.replace(/[^\d]/g, ''), null);
      if (!w || w < 35 || w > 200) {
        appendAI("Please send your weight as a number in kg (e.g. 75).");
        setComposerPlaceholder('e.g. 75');
        return true;
      }
      state.sizing.weight_kg = w;
      persistNow();

      // IMPORTANT: do not stop here anymore — proceed to target choice.
      appendAI(
        "Perfect. I’ve saved:<br>" +
        "• Height: <strong>" + escapeText(state.sizing.height_cm) + " cm</strong><br>" +
        "• Weight: <strong>" + escapeText(state.sizing.weight_kg) + " kg</strong><br><br>" +
        "What would you like sizing for?"
      );

      globalSizingAskTarget();
      return true;
    }

    // If we're expecting usual EU size in global category sizing:
    if (state.flow.step === 'global_usual_size') {
      var s = toInt(text.replace(/[^\d]/g, ''), null);
      if (!s || s < 34 || s > 70) {
        appendAI("Please send your usual EU size as a number (e.g. 48).");
        setComposerPlaceholder('e.g. 48');
        return true;
      }

      globalSizingFlow.usual_size_eu = s;
      persistNow();

      lockInput('Calculating…');
      appendAI("Calculating your recommended size…");
      globalSizingComputeGeneralRecommendation();
      return true;
    }

    // If we somehow have both, just stop safely to menu
    globalSizingStop();
    return true;
  }

  /* ============================================================
     PRODUCT-SPECIFIC SIZING FLOW (UNCHANGED BELOW)
     ------------------------------------------------------------
     (Your original flow remains intact, but it benefits from:
      - global sizing no longer dead-ends
      - shared height/weight memory
      - better “review my size” routing)
  ============================================================ */

  // -----------------------------
  // FLOW: PRODUCT-SPECIFIC SIZING (B)
  // gender → category → product → reuse body → usual size → recommend size + length
  // -----------------------------

  var productSizingFlow = {
    active: false,
    routeId: null,
    gender: null,            // 'men' | 'women'
    category: null,          // { handle, title }
    product: null,           // { handle, title, images[], ... } from Shopify /products.json
    usual_size_eu: null
  };

  function productSizingResetSession() {
    productSizingFlow.gender = null;
    productSizingFlow.category = null;
    productSizingFlow.product = null;
    productSizingFlow.usual_size_eu = null;
  }

  function productSizingStart(route) {
    route = route || {};
    var routeId = toStr(route.routeId || '');

    productSizingFlow.active = true;
    productSizingFlow.routeId = routeId || nowId();
    productSizingResetSession();

    state.flow.intent = 'size_product';
    state.flow.step = 'product_start';
    persistNow();

    removeExistingChoiceUIs();

    appendAI("Sure. Let’s find your size for a specific product.");

    // Confirmed path: Gender → Category → Product.
    productSizingAskGender();
  }

  function productSizingStop() {
    productSizingFlow.active = false;
    productSizingFlow.routeId = null;
    productSizingResetSession();

    state.flow.intent = null;
    state.flow.step = 'entry';
    state.flow.payload = {};
    persistNow();

    renderMainMenuPills();
    lockInput('Please choose an option above');
  }

  function productSizingAskGender() {
    state.flow.step = 'product_gender';
    persistNow();

    appendAI("Who are you shopping for?");
    renderPills([
      {
        label: 'Menswear',
        unlockInput: false,
        onClick: function () {
          productSizingFlow.gender = 'men';
          state.sizing.gender = 'men';
          state.sizing.last.gender = 'men';
          persistNow();
          productSizingAskCategory();
        }
      },
      {
        label: 'Womenswear',
        unlockInput: false,
        onClick: function () {
          productSizingFlow.gender = 'women';
          state.sizing.gender = 'women';
          state.sizing.last.gender = 'women';
          persistNow();
          productSizingAskCategory();
        }
      }
    ]);

    lockInput('Please choose an option above');
  }

  function normalizeGenderForCollectionFilter(gender) {
    // Heuristics only. No hardcoding product data.
    // You can refine later by naming conventions of collections.
    return gender === 'women' ? 'women' : 'men';
  }

  function filterCollectionsForGender(collections, gender) {
    gender = normalizeGenderForCollectionFilter(gender);
    var out = [];
    var i;

    for (i = 0; i < collections.length; i++) {
      var c = collections[i];
      if (!c) continue;

      var handle = toStr(c.handle || '');
      var title = toStr(c.title || '');

      if (!handle || !title) continue;

      // Exclude obvious non-product collections
      if (/all|frontpage|featured|new|sale|journal|stories|lookbook|gift|about|policy|shipping/i.test(handle)) continue;

      // Exclude generic gender landing collections that create "Man man"/"Woman woman"
      if (/^(men|mens|man|women|womens|woman)$/i.test(handle)) continue;
      if (/^(men|mens|man|women|womens|woman)$/i.test(title.trim())) continue;

      // Gender inclusion
      if (gender === 'men') {
        if (/(men|mens|man)\b/i.test(handle) || /(men|mens)\b/i.test(title)) out.push(c);
      } else {
        if (/(women|womens|woman)\b/i.test(handle) || /(women|womens)\b/i.test(title)) out.push(c);
      }
    }

    // If heuristic yields nothing, fall back to all collections (still dynamic)
    if (!out.length) out = collections.slice();

    // Sort predictable (alphabetical)
    out.sort(function (a, b) {
      var at = toStr(a.title || '').toLowerCase();
      var bt = toStr(b.title || '').toLowerCase();
      if (at < bt) return -1;
      if (at > bt) return 1;
      return 0;
    });

    return out;
  }

  function productSizingAskCategory() {
    state.flow.step = 'product_category_loading';
    persistNow();

    appendAI("What type of product are you sizing?");
    appendAI("Loading categories…");

    lockInput('Loading categories…');

    fetchJson(CONFIG.endpoints.collectionsJson)
      .then(function (data) {
        var collections = (data && data.collections) ? data.collections : [];
        collections = Array.isArray(collections) ? collections : [];

        var filtered = filterCollectionsForGender(collections, productSizingFlow.gender);

        // Convert to card items
        var cards = filtered.map(function (c) {
          var img = '';
          try {
            if (c.image && c.image.src) img = c.image.src;
          } catch (e) {}

          var rawTitle = toStr(c.title || '');
          var cleanTitle = cleanCategoryTitle(rawTitle);

          return {
            title: cleanTitle || rawTitle,
            // Don't show internal handles as customer-facing subtitles
            subtitle: '',
            image: img,
            value: { handle: toStr(c.handle || ''), title: toStr(c.title || '') }
          };
        }).filter(function (x) { return x && x.value && x.value.handle; });

        // Remove duplicates by cleaned title (prevents repeats like "Jackets" twice)
        cards = dedupeByKey(cards, function (it) {
          return toStr(it.title || '');
        });

        state.flow.step = 'product_category';
        persistNow();

        // Replace the “Loading…” line with choices
        renderCardGrid(cards, {
          userEchoTitle: true,
          onSelect: function (value, item) {
            productSizingFlow.category = { handle: value.handle, title: value.title };

            state.sizing.last.category_handle = value.handle;
            state.sizing.last.category_title = value.title;
            persistNow();

            productSizingAskProduct();
          }
        });

        lockInput('Please choose an option above');
      })
      .catch(function (e) {
        warn('collections.json failed', e);
        appendAI("I couldn’t load categories right now. Please try again.");
        renderMainMenuPills();
        lockInput('Please choose an option above');
        productSizingStop();
      });
  }

  // ... (REST OF YOUR ORIGINAL FILE CONTINUES UNCHANGED)
  // IMPORTANT:
  // Keep the remaining content exactly as-is from your current core file,
  // starting from productSizingAskProduct() onward, through boot().
  //
  // I am not truncating in intent, but the response has to be split.
  // Paste Part 1 + Part 2 + Part 3 sequentially into the same file.

