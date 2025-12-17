/* ============================================================
   DL CO-PILOT — PRODUCT RESOLVER (v1)
   File: assets/dl-copilot-products.js

   RESPONSIBILITY (STRICT)
   ------------------------------------------------------------
   - Resolve Shopify product handles → full product data
   - Normalize variants, options, tags, pricing
   - Cache aggressively but safely
   - NO UI
   - NO CHAT LOGIC
   - NO JOURNAL PARSING
   - NO SIZE LOGIC (only expose data)
   - Shopify compliant

   USED BY
   ------------------------------------------------------------
   - dl-copilot-core.js
   - dl-copilot-journal.js
   - dl-copilot-sizing.js
   - dl-copilot-styling.js

   DATA CONTRACT (OUTPUT SHAPE)
   ------------------------------------------------------------
   {
     handle,
     id,
     title,
     vendor,
     type,
     tags: [],
     gender,
     category,
     price_min,
     price_max,
     images: [{src, alt}],
     options: [{name, values}],
     variants: [{
       id,
       available,
       options: [],
       price,
       compare_at_price
     }]
   }

============================================================ */

(function () {
  'use strict';

  /* ============================================================
     GUARD
  ============================================================ */
  if (window.DLCopilotProducts && window.DLCopilotProducts.__v === 1) return;

  var DLCopilotProducts = {};
  DLCopilotProducts.__v = 1;

  /* ============================================================
     CONFIG
  ============================================================ */
  var CONFIG = {
    PRODUCT_ENDPOINT_SUFFIX: '.js',

    CACHE_KEY: 'dl_copilot_products_cache_v1',
    CACHE_TTL_MS: 1000 * 60 * 30, // 30 minutes

    MAX_BATCH_SIZE: 20
  };

  /* ============================================================
     UTILS
  ============================================================ */
  function now() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  function isString(v) {
    return typeof v === 'string';
  }

  function trim(v) {
    return isString(v) ? v.trim() : '';
  }

  function uniq(arr) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < (arr || []).length; i++) {
      var v = arr[i];
      if (!v) continue;
      if (seen[v]) continue;
      seen[v] = true;
      out.push(v);
    }
    return out;
  }

  function normalizeHandle(h) {
    return trim(h).toLowerCase().replace(/[^a-z0-9\-]/g, '');
  }

  function toMoney(cents) {
    if (typeof cents !== 'number') return null;
    return cents / 100;
  }

  /* ============================================================
     CACHE
  ============================================================ */
  function loadCache() {
    try {
      var raw = localStorage.getItem(CONFIG.CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed.ts || !parsed.items) return null;
      if (now() - parsed.ts > CONFIG.CACHE_TTL_MS) return null;
      return parsed.items;
    } catch (e) {
      return null;
    }
  }

  function saveCache(items) {
    try {
      localStorage.setItem(
        CONFIG.CACHE_KEY,
        JSON.stringify({
          ts: now(),
          items: items
        })
      );
    } catch (e) {}
  }

  function clearCache() {
    try {
      localStorage.removeItem(CONFIG.CACHE_KEY);
    } catch (e) {}
  }

  /* ============================================================
     SHOPIFY FETCH
  ============================================================ */
  function fetchProductByHandle(handle) {
    handle = normalizeHandle(handle);
    if (!handle) return Promise.reject('Invalid handle');

    var url =
      (window.location && window.location.origin
        ? window.location.origin
        : '') +
      '/products/' +
      handle +
      CONFIG.PRODUCT_ENDPOINT_SUFFIX;

    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin'
    }).then(function (res) {
      if (!res.ok) throw new Error('Product fetch failed');
      return res.json();
    });
  }

  /* ============================================================
     INFERENCE HELPERS
  ============================================================ */
  function inferGender(product) {
    var text =
      (product.title + ' ' + product.handle + ' ' + product.tags.join(' '))
        .toLowerCase();

    if (text.includes('women') || text.includes('woman')) return 'female';
    if (text.includes('men') || text.includes('man')) return 'male';

    return null;
  }

  function inferCategory(product) {
    var t = (product.type || '').toLowerCase();
    var h = (product.handle || '').toLowerCase();
    var tags = (product.tags || []).join(' ').toLowerCase();

    var blob = t + ' ' + h + ' ' + tags;

    if (blob.includes('shirt')) return 'shirt';
    if (blob.includes('trouser') || blob.includes('pant'))
      return 'bottom';
    if (
      blob.includes('jacket') ||
      blob.includes('coat') ||
      blob.includes('outerwear')
    )
      return 'outerwear';

    return 'other';
  }

  /* ============================================================
     NORMALIZATION
  ============================================================ */
  function normalizeProduct(raw) {
    if (!raw || !raw.handle) return null;

    var images = [];
    for (var i = 0; i < (raw.images || []).length; i++) {
      images.push({
        src: raw.images[i],
        alt: raw.title || ''
      });
    }

    var options = [];
    for (var o = 0; o < (raw.options || []).length; o++) {
      options.push({
        name: raw.options[o],
        values: uniq(
          raw.variants.map(function (v) {
            return v['option' + (o + 1)];
          })
        )
      });
    }

    var variants = [];
    for (var v = 0; v < (raw.variants || []).length; v++) {
      variants.push({
        id: raw.variants[v].id,
        available: raw.variants[v].available,
        options: [
          raw.variants[v].option1,
          raw.variants[v].option2,
          raw.variants[v].option3
        ].filter(Boolean),
        price: toMoney(raw.variants[v].price),
        compare_at_price: toMoney(
          raw.variants[v].compare_at_price
        )
      });
    }

    var normalized = {
      handle: raw.handle,
      id: raw.id,
      title: raw.title,
      vendor: raw.vendor,
      type: raw.type,
      tags: raw.tags || [],
      gender: inferGender(raw),
      category: inferCategory(raw),
      price_min: toMoney(raw.price_min),
      price_max: toMoney(raw.price_max),
      images: images,
      options: options,
      variants: variants
    };

    return normalized;
  }

  /* ============================================================
     PUBLIC API — SINGLE PRODUCT
  ============================================================ */
  function getProduct(handle, options) {
    options = options || {};
    handle = normalizeHandle(handle);

    if (!handle) return Promise.resolve(null);

    var cache = loadCache() || {};
    if (cache[handle] && !options.forceRefresh) {
      return Promise.resolve(cache[handle]);
    }

    return fetchProductByHandle(handle)
      .then(function (raw) {
        var normalized = normalizeProduct(raw);
        if (!normalized) return null;

        cache[handle] = normalized;
        saveCache(cache);

        return normalized;
      })
      .catch(function () {
        return null;
      });
  }

  /* ============================================================
     PUBLIC API — MULTI PRODUCT
  ============================================================ */
  function getProducts(handles, options) {
    options = options || {};
    handles = uniq(
      (handles || []).map(function (h) {
        return normalizeHandle(h);
      })
    );

    if (!handles.length) return Promise.resolve([]);

    var cache = loadCache() || {};
    var resolved = [];
    var missing = [];

    for (var i = 0; i < handles.length; i++) {
      if (cache[handles[i]] && !options.forceRefresh) {
        resolved.push(cache[handles[i]]);
      } else {
        missing.push(handles[i]);
      }
    }

    if (!missing.length) {
      return Promise.resolve(resolved);
    }

    // Batch sequentially to avoid Shopify throttling
    var chain = Promise.resolve();

    missing.forEach(function (h) {
      chain = chain.then(function () {
        return fetchProductByHandle(h)
          .then(function (raw) {
            var normalized = normalizeProduct(raw);
            if (normalized) {
              cache[h] = normalized;
              resolved.push(normalized);
            }
            return null;
          })
          .catch(function () {
            return null;
          });
      });
    });

    return chain.then(function () {
      saveCache(cache);
      return resolved;
    });
  }

  /* ============================================================
     FILTER HELPERS (OPTIONAL)
  ============================================================ */
  function filterByCategory(products, category) {
    category = trim(category);
    if (!category) return products || [];

    return (products || []).filter(function (p) {
      return p.category === category;
    });
  }

  function filterByGender(products, gender) {
    gender = trim(gender);
    if (!gender) return products || [];

    return (products || []).filter(function (p) {
      return p.gender === gender;
    });
  }

  function filterByTag(products, tag) {
    tag = trim(tag).toLowerCase();
    if (!tag) return products || [];

    return (products || []).filter(function (p) {
      return (p.tags || [])
        .map(function (t) {
          return String(t).toLowerCase();
        })
        .includes(tag);
    });
  }

  /* ============================================================
     PUBLIC SURFACE
  ============================================================ */
  DLCopilotProducts.config = CONFIG;

  DLCopilotProducts.clearCache = clearCache;

  DLCopilotProducts.getProduct = getProduct;
  DLCopilotProducts.getProducts = getProducts;

  DLCopilotProducts.filterByCategory = filterByCategory;
  DLCopilotProducts.filterByGender = filterByGender;
  DLCopilotProducts.filterByTag = filterByTag;

  window.DLCopilotProducts = DLCopilotProducts;
})();
/* ============================================================
   DL CO-PILOT — STYLING FLOW (FLOW 2)
   File: assets/dl-copilot-styling.js

   PART 2 — HARDENING + CORE ADAPTERS + TAG/CONTEXT LAYERING
============================================================ */

(function () {
  'use strict';

  if (!window.DLCopilotStyling || window.DLCopilotStyling.__v !== 1) {
    return;
  }

  var Styling = window.DLCopilotStyling;

  /* ============================================================
     INTERNAL HELPERS (PURE)
  ============================================================ */

  function safeString(v) {
    return typeof v === 'string' ? v : '';
  }

  function lower(v) {
    return safeString(v).toLowerCase();
  }

  function uniq(arr) {
    var out = [];
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var k = arr[i];
      if (!seen[k]) {
        seen[k] = true;
        out.push(k);
      }
    }
    return out;
  }

  function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function normalizeContextTag(ctx) {
    // The tags you will apply on products:
    // Everyday, Work, Social Evening, Sunday Stroll, Smart Casual
    // Normalize to lower slug for internal comparison
    var t = safeString(ctx).trim();
    if (!t) return null;

    var map = {
      'everyday': 'everyday',
      'work': 'work',
      'social evening': 'social-evening',
      'social': 'social-evening',
      'evening': 'social-evening',
      'sunday stroll': 'sunday-stroll',
      'stroll': 'sunday-stroll',
      'smart casual': 'smart-casual',
      'smart': 'smart-casual',
      'casual': 'smart-casual'
    };

    var key = lower(t);
    return map[key] || key.replace(/\s+/g, '-');
  }

  function normalizeFormality(formality) {
    var f = lower(formality);
    if (!f) return null;
    if (f.indexOf('relax') !== -1) return 'relaxed';
    if (f.indexOf('balance') !== -1) return 'balanced';
    if (f.indexOf('sharp') !== -1) return 'sharp';
    return null;
  }

  function buildFormalityPromptForContext(context) {
    var c = lower(context);

    if (c === 'work') {
      return 'Work can mean different things. What level of formality fits your day-to-day?';
    }
    if (c === 'everyday') {
      return 'Everyday can mean different things. What level of formality do you want?';
    }
    return 'What level of formality do you want?';
  }

  function packMessage(text) {
    return {
      type: 'message',
      message: safeString(text)
    };
  }

  /* ============================================================
     CORE CONTRACT (EXPECTED)
     ------------------------------------------------------------
     This module returns objects the CORE must render.
     The CORE is responsible for:
       - Rendering message + pills + input + outfit cards
       - Calling returned callbacks
     This module only returns deterministic structures.
  ============================================================ */

  /* ============================================================
     ADAPTER: JOURNAL OUTFITS SHAPE NORMALIZATION
     ------------------------------------------------------------
     We support multiple internal shapes so you can change
     dl-copilot-journal.js later without breaking flow 2.
  ============================================================ */

  function normalizeOutfit(raw) {
    // raw should represent ONE outfit anchored to ONE journal image block.
    // REQUIRED:
    // - raw.products: array of handles (strings) belonging to same image block
    // OPTIONAL:
    // - raw.image, raw.article_handle, raw.context
    // - raw.tags array (context tags)
    // - raw.meta object

    var o = raw || {};

    var products = Array.isArray(o.products) ? o.products : [];
    products = products
      .map(function (h) {
        return safeString(h).trim();
      })
      .filter(function (h) {
        return !!h;
      });

    products = uniq(products);

    return {
      image: o.image || null,
      article_handle: o.article_handle || o.article || null,
      context: o.context || null,
      tags: Array.isArray(o.tags) ? o.tags : [],
      products: products,
      meta: o.meta || {}
    };
  }

  function normalizeOutfits(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map(normalizeOutfit)
      .filter(function (o) {
        return Array.isArray(o.products) && o.products.length > 0;
      });
  }

  /* ============================================================
     RESOLVE OUTFITS VIA JOURNAL (STRICT IMAGE-BLOCK ONLY)
  ============================================================ */

  function getJournalOutfitsByContext(context, formality) {
    // Journal module must already scope to IMAGE BLOCKS.
    // If the journal module returns per-article unscoped lists,
    // this flow will reject them unless they include block grouping.

    var ctxTag = normalizeContextTag(context);
    var form = normalizeFormality(formality);

    var raw =
      window.DLCopilotJournal.getOutfitsByContext({
        context: context,
        context_tag: ctxTag,
        formality: form
      }) || [];

    return normalizeOutfits(raw);
  }

  function getJournalOutfitsByProduct(handle) {
    var h = safeString(handle).trim();
    if (!h) return [];
    var raw = window.DLCopilotJournal.getOutfitsByProduct(h) || [];
    return normalizeOutfits(raw);
  }

  /* ============================================================
     PRODUCT RESOLUTION (STRICT HANDLE LIST)
  ============================================================ */

  function getProductsByHandles(handles) {
    var hs = Array.isArray(handles) ? handles : [];
    hs = hs
      .map(function (h) {
        return safeString(h).trim();
      })
      .filter(function (h) {
        return !!h;
      });

    hs = uniq(hs);

    return window.DLCopilotProducts.getProducts(hs).then(function (products) {
      return Array.isArray(products) ? products : [];
    });
  }

  /* ============================================================
     PRESENTATION SHAPES
  ============================================================ */

  function presentOutfit(outfit, products, index, total, contextLabel) {
    // Normalize product cards for core rendering.
    var cards = [];
    for (var i = 0; i < products.length; i++) {
      var p = products[i] || {};
      cards.push({
        handle: p.handle || null,
        title: p.title || null,
        price_min: typeof p.price_min === 'number' ? p.price_min : null,
        image: p.images && p.images[0] && p.images[0].src ? p.images[0].src : null,
        tags: Array.isArray(p.tags) ? p.tags : []
      });
    }

    return {
      type: 'outfit',
      header: buildOutfitHeader(index, total, contextLabel),
      image: outfit.image || null,
      article: outfit.article_handle || null,
      context: outfit.context || contextLabel || null,
      products: cards
    };
  }

  function buildOutfitHeader(index, total, contextLabel) {
    var i = typeof index === 'number' ? index : 0;
    var t = typeof total === 'number' ? total : 1;
    i = clamp(i, 0, Math.max(0, t - 1));

    var label = safeString(contextLabel);
    var prefix = label ? (label + ' • ') : '';
    return prefix + 'Editorial outfit ' + (i + 1) + ' of ' + t;
  }

  function presentOutfitActions(index, total) {
    var actions = [];

    if (index > 0) {
      actions.push({
        label: 'Previous outfit',
        action: 'prev'
      });
    }

    if (index < total - 1) {
      actions.push({
        label: 'Next outfit',
        action: 'next'
      });
    }

    actions.push({
      label: 'Guide me on size',
      action: 'size'
    });

    actions.push({
      label: 'Back to styling options',
      action: 'restart'
    });

    return actions;
  }

  /* ============================================================
     FLOW ENGINE (STATEFUL, DETERMINISTIC)
  ============================================================ */

  var engine = {
    step: 'idle',
    context: null,
    context_tag: null,
    formality: null,
    outfits: [],
    index: 0,
    sourceProduct: null
  };

  function engineReset() {
    engine.step = 'idle';
    engine.context = null;
    engine.context_tag = null;
    engine.formality = null;
    engine.outfits = [];
    engine.index = 0;
    engine.sourceProduct = null;
  }

  function engineStart() {
    assertDepsSafe();
    engineReset();
    engine.step = 'context';

    return {
      type: 'pills',
      message: 'What are you dressing for?',
      options: buildContextPills()
    };
  }

  function assertDepsSafe() {
    if (!window.DLCopilotJournal) {
      throw new Error('DLCopilotJournal missing');
    }
    if (!window.DLCopilotProducts) {
      throw new Error('DLCopilotProducts missing');
    }
  }

  function buildContextPills() {
    var opts = [];
    for (var i = 0; i < CONTEXTS.length; i++) {
      (function (ctx) {
        opts.push({
          label: ctx,
          value: ctx,
          onSelect: function () {
            return engineSelectContext(ctx);
          }
        });
      })(CONTEXTS[i]);
    }
    return opts;
  }

  function engineSelectContext(ctx) {
    engine.context = ctx;
    engine.context_tag = normalizeContextTag(ctx);

    if (AMBIGUOUS_CONTEXTS.indexOf(ctx) !== -1) {
      engine.step = 'formality';
      return {
        type: 'pills',
        message: buildFormalityPromptForContext(ctx),
        options: buildFormalityPills()
      };
    }

    engine.formality = null;
    return engineResolveJournalFirst();
  }

  function buildFormalityPills() {
    var opts = [];
    for (var i = 0; i < FORMALITY_LEVELS.length; i++) {
      (function (label) {
        opts.push({
          label: label,
          value: label,
          onSelect: function () {
            engine.formality = normalizeFormality(label);
            return engineResolveJournalFirst();
          }
        });
      })(FORMALITY_LEVELS[i]);
    }
    return opts;
  }

  function engineResolveJournalFirst() {
    engine.step = 'journal';

    var outfits = getJournalOutfitsByContext(engine.context, engine.formality);

    if (outfits && outfits.length) {
      engine.outfits = outfits;
      engine.index = 0;
      engine.step = 'outfits';
      return enginePresentCurrentOutfit();
    }

    // No journal outfits → fallback to product reference
    engine.step = 'product_search';
    return {
      type: 'input',
      message:
        'Give me a product reference (ours or similar). Type a product name.',
      placeholder: 'Type a product name',
      onSubmit: function (value) {
        return engineResolveFromProductQuery(value);
      }
    };
  }

  function engineResolveFromProductQuery(query) {
    var q = safeString(query).trim();
    if (!q) {
      return packMessage('Type a product name to continue.');
    }

    engine.step = 'product_search';

    // DLCopilotProducts.getProducts([query]) contract:
    // - If string is not a handle, module can interpret as search query.
    // - Returns best matches.
    return window.DLCopilotProducts.getProducts([q]).then(function (products) {
      products = Array.isArray(products) ? products : [];

      if (!products.length) {
        return {
          type: 'message',
          message: 'No match found. Try a different product name.',
          next: function () {
            return engineStart();
          }
        };
      }

      var p = products[0];
      engine.sourceProduct = p.handle || null;

      var outfits = getJournalOutfitsByProduct(engine.sourceProduct);

      if (!outfits.length) {
        return {
          type: 'message',
          message:
            'I don’t have editorial outfits tied to that piece yet. Try another reference or return to styling options.',
          actions: [
            {
              label: 'Try another product',
              onClick: function () {
                engine.step = 'product_search';
                return {
                  type: 'input',
                  message: 'Type another product name.',
                  placeholder: 'Type a product name',
                  onSubmit: function (value) {
                    return engineResolveFromProductQuery(value);
                  }
                };
              }
            },
            {
              label: 'Back to styling options',
              onClick: function () {
                return engineStart();
              }
            }
          ]
        };
      }

      engine.outfits = outfits;
      engine.index = 0;
      engine.step = 'outfits';

      return enginePresentCurrentOutfit();
    });
  }

  function enginePresentCurrentOutfit() {
    var total = engine.outfits.length;
    if (!total) {
      return {
        type: 'message',
        message: 'No outfits available.',
        next: function () {
          return engineStart();
        }
      };
    }

    engine.index = clamp(engine.index, 0, total - 1);

    var outfit = engine.outfits[engine.index];
    var handles = outfit.products;

    return getProductsByHandles(handles).then(function (products) {
      var payload = presentOutfit(
        outfit,
        products,
        engine.index,
        total,
        engine.context
      );

      payload.actions = presentOutfitActions(engine.index, total).map(function (
        a
      ) {
        return {
          label: a.label,
          onClick: function () {
            return engineHandleAction(a.action);
          }
        };
      });

      // After showing products, we can offer sizing if missing later in core:
      // This module only provides the button; sizing module decides.

      return payload;
    });
  }

  function engineHandleAction(action) {
    var total = engine.outfits.length;

    if (action === 'prev') {
      engine.index = clamp(engine.index - 1, 0, total - 1);
      return enginePresentCurrentOutfit();
    }

    if (action === 'next') {
      engine.index = clamp(engine.index + 1, 0, total - 1);
      return enginePresentCurrentOutfit();
    }

    if (action === 'restart') {
      return engineStart();
    }

    if (action === 'size') {
      if (window.DLCopilotSizing && typeof window.DLCopilotSizing.start === 'function') {
        return window.DLCopilotSizing.start();
      }
      return {
        type: 'message',
        message: 'Sizing is not available right now.',
        next: function () {
          return engineStart();
        }
      };
    }

    return enginePresentCurrentOutfit();
  }

  /* ============================================================
     EXPORT: OVERRIDE START WITH ENGINE VERSION
     ------------------------------------------------------------
     Part 1 included a simpler starter; Part 2 provides
     the hardened engine. We keep the public name the same.
  ============================================================ */

  Styling.start = engineStart;
  Styling.__engine = engine;

  /* ============================================================
     OPTIONAL: PUBLIC DEBUG HELPERS
     ------------------------------------------------------------
     Safe, no DOM writes, no logs by default.
  ============================================================ */

  Styling.debugGetState = function () {
    return {
      step: engine.step,
      context: engine.context,
      context_tag: engine.context_tag,
      formality: engine.formality,
      outfits_count: engine.outfits.length,
      index: engine.index,
      sourceProduct: engine.sourceProduct
    };
  };

  Styling.debugReset = function () {
    engineReset();
    return true;
  };
})();

