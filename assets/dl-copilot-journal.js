/* ============================================================
   DL CO-PILOT — JOURNAL / OUTFIT RESOLVER (v1)
   File: assets/dl-copilot-journal.js

   PURPOSE
   - Extract "outfits" from Journal/Blog HTML by grouping product handles
     ONLY within the same image block (no cross-image mixing).
   - Works on:
     1) Current article page (parse DOM)
     2) Non-article pages (fetch blog article URLs, fetch HTML, parse)

   HARD RULES (locked)
   - Outfit proposals must be scoped to ONE image block.
   - No mixing handles from multiple image blocks.
   - Journal is priority datasource.

   DEPENDENCIES
   - None required.
   - (Optional later) dl-copilot-products.js can enrich handles into products.

   EXPECTED MARKUP SIGNALS (your existing system)
   - Any element with: data-product-handle="handle"
   - Common DL blocks (supported):
       .dl-full-image + adjacent .dl-product-list
       .dl-two-col with .dl-two-col__item containing image + .dl-product-list
       Any container where handles live inside the same block

   SAFE DEFAULT
   - If we cannot confidently bind handles to an image block, we still create
     a block keyed by the nearest containing "block-like" wrapper, but we DO NOT
     merge across blocks.

============================================================ */

(function () {
  'use strict';

  /* ============================================================
     GLOBAL ATTACH
  ============================================================ */
  if (window.DLCopilotJournal && window.DLCopilotJournal.__v === 1) return;

  var DLCopilotJournal = {};
  DLCopilotJournal.__v = 1;

  /* ============================================================
     CONFIG
  ============================================================ */
  var CONFIG = {
    // Change if your blog handle is not "journal"
    BLOG_HANDLE: 'journal',

    // Hard limits for network usage
    MAX_ARTICLES_TO_SCAN: 10,
    MAX_OUTFITS_TO_RETURN: 18,

    // Cache (localStorage)
    LS_KEY: 'dl_copilot_journal_cache_v1',
    LS_TTL_MS: 1000 * 60 * 30, // 30 minutes

    // Parsing heuristics
    HANDLE_ATTR: 'data-product-handle',
    HANDLES_ATTR: 'data-product-handles', // optional: comma-separated list on container

    // We only trust outfits that have at least 1 product handle
    MIN_HANDLES_PER_OUTFIT: 1
  };

  /* ============================================================
     UTIL: SAFE STRING
  ============================================================ */
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
    h = trim(h).toLowerCase();
    // Shopify handles are typically lowercase with hyphens
    // Keep only allowed-ish chars (defensive)
    h = h.replace(/[^a-z0-9\-]/g, '');
    return h;
  }

  function safeText(el) {
    try {
      return trim((el && el.textContent) || '');
    } catch (e) {
      return '';
    }
  }

  function safeGetAttr(el, name) {
    try {
      if (!el || !el.getAttribute) return '';
      return trim(el.getAttribute(name) || '');
    } catch (e) {
      return '';
    }
  }

  function safeQueryAll(root, selector) {
    try {
      if (!root || !root.querySelectorAll) return [];
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (e) {
      return [];
    }
  }

  function safeQuery(root, selector) {
    try {
      if (!root || !root.querySelector) return null;
      return root.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function nowMs() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  /* ============================================================
     UTIL: URL HELPERS
  ============================================================ */
  function toAbsUrl(url, baseUrl) {
    url = trim(url);
    if (!url) return '';
    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) return url;

    // Protocol-relative
    if (url.indexOf('//') === 0) {
      return (window.location && window.location.protocol ? window.location.protocol : 'https:') + url;
    }

    // Root-relative
    if (url.charAt(0) === '/') {
      return (window.location && window.location.origin ? window.location.origin : '') + url;
    }

    // Relative
    try {
      var base = baseUrl || (window.location ? window.location.href : '');
      return new URL(url, base).toString();
    } catch (e) {
      return url;
    }
  }

  function stripHash(url) {
    url = trim(url);
    if (!url) return '';
    var i = url.indexOf('#');
    if (i === -1) return url;
    return url.slice(0, i);
  }

  /* ============================================================
     CACHE (LOCAL STORAGE)
  ============================================================ */
  function loadCache() {
    try {
      var raw = localStorage.getItem(CONFIG.LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.ts || !parsed.data) return null;
      if (nowMs() - parsed.ts > CONFIG.LS_TTL_MS) return null;
      return parsed.data;
    } catch (e) {
      return null;
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CONFIG.LS_KEY, JSON.stringify({ ts: nowMs(), data: data }));
    } catch (e) {
      // ignore
    }
  }

  function clearCache() {
    try {
      localStorage.removeItem(CONFIG.LS_KEY);
    } catch (e) {
      // ignore
    }
  }

  /* ============================================================
     DETECT: IS THIS A BLOG ARTICLE PAGE?
  ============================================================ */
  function isLikelyArticleDocument(doc) {
    doc = doc || document;

    // Shopify blog article templates often include:
    // - <article> element
    // - or meta property="og:type" content="article"
    // We'll use multiple signals.
    var ogType = safeQuery(doc, 'meta[property="og:type"]');
    var ogTypeVal = ogType ? safeGetAttr(ogType, 'content') : '';
    if (ogTypeVal.toLowerCase() === 'article') return true;

    // Presence of article tags + blog content often
    var hasArticleTag = !!safeQuery(doc, 'article');
    var hasRte = !!safeQuery(doc, '.rte, .article__content, .blog-article, [data-article-content]');
    if (hasArticleTag && hasRte) return true;

    // If your custom system uses dl blocks, an article is very likely
    var hasDLBlocks = !!safeQuery(doc, '.dl-full-image, .dl-two-col, [data-dl-journal], [data-dl-outfit-block]');
    if (hasDLBlocks) return true;

    return false;
  }

  /* ============================================================
     EXTRACT: PRODUCT HANDLES INSIDE A NODE (STRICT)
  ============================================================ */
  function extractHandlesFromNode(node) {
    var handles = [];

    if (!node) return handles;

    // 1) Individual data-product-handle attributes (your primary system)
    var withHandle = safeQueryAll(node, '[' + CONFIG.HANDLE_ATTR + ']');
    for (var i = 0; i < withHandle.length; i++) {
      var h = safeGetAttr(withHandle[i], CONFIG.HANDLE_ATTR);
      h = normalizeHandle(h);
      if (h) handles.push(h);
    }

    // 2) Optional: data-product-handles="a,b,c" on container
    var withHandlesAttr = safeQueryAll(node, '[' + CONFIG.HANDLES_ATTR + ']');
    for (var j = 0; j < withHandlesAttr.length; j++) {
      var raw = safeGetAttr(withHandlesAttr[j], CONFIG.HANDLES_ATTR);
      if (!raw) continue;
      var parts = raw.split(',');
      for (var k = 0; k < parts.length; k++) {
        var hh = normalizeHandle(parts[k]);
        if (hh) handles.push(hh);
      }
    }

    return uniq(handles);
  }

  /* ============================================================
     EXTRACT: BEST IMAGE FROM A BLOCK
  ============================================================ */
  function pickBestImageFromBlock(block, baseUrl) {
    if (!block) return { src: '', alt: '' };

    // Priority:
    // 1) <img> inside .dl-full-image
    // 2) first <img> inside block
    // 3) background-image in style
    var img =
      safeQuery(block, '.dl-full-image img') ||
      safeQuery(block, 'img');

    if (img) {
      var src = safeGetAttr(img, 'src') || safeGetAttr(img, 'data-src') || '';
      var srcset = safeGetAttr(img, 'srcset') || '';
      var alt = safeGetAttr(img, 'alt') || '';

      // If src is empty but srcset exists, take first srcset URL
      if (!src && srcset) {
        // srcset: "url 300w, url2 600w"
        var first = srcset.split(',')[0] || '';
        src = trim(first.split(' ')[0] || '');
      }

      return {
        src: toAbsUrl(src, baseUrl),
        alt: alt
      };
    }

    // Background-image fallback (inline style)
    var style = safeGetAttr(block, 'style');
    if (style && style.toLowerCase().indexOf('background-image') !== -1) {
      var m = style.match(/background-image\s*:\s*url\(([^)]+)\)/i);
      if (m && m[1]) {
        var rawUrl = trim(m[1]).replace(/^['"]|['"]$/g, '');
        return { src: toAbsUrl(rawUrl, baseUrl), alt: '' };
      }
    }

    return { src: '', alt: '' };
  }

  /* ============================================================
     GROUPING STRATEGY (NO CROSS-IMAGE MIXING)

     We build outfits from "blocks".
     A block is one of:
       A) .dl-two-col__item (each side is its own outfit scope)
       B) .dl-full-image + nearest companion product list
       C) Any element explicitly marked [data-dl-outfit-block]
       D) Fallback: nearest "block-like" wrapper around handles
============================================================ */

  function collectExplicitOutfitBlocks(root) {
    return safeQueryAll(root, '[data-dl-outfit-block]');
  }

  function collectTwoColItems(root) {
    return safeQueryAll(root, '.dl-two-col__item');
  }

  function collectFullImageBlocks(root) {
    // Each .dl-full-image is the anchor; products may be adjacent siblings or within a shared wrapper
    return safeQueryAll(root, '.dl-full-image');
  }

  function isElement(node) {
    return node && node.nodeType === 1;
  }

  function nextElementSibling(el) {
    if (!el) return null;
    var n = el.nextSibling;
    while (n && n.nodeType !== 1) n = n.nextSibling;
    return n;
  }

  function prevElementSibling(el) {
    if (!el) return null;
    var n = el.previousSibling;
    while (n && n.nodeType !== 1) n = n.previousSibling;
    return n;
  }

  function findCompanionProductListForFullImage(fullImageEl) {
    // Typical pattern:
    // <div class="dl-full-image"> ... </div>
    // <div class="dl-product-list"> links ... </div>
    // Also allow:
    // <div class="dl-full-image"> ... </div>
    // <div> ... <div class="dl-product-list"> ... </div> ... </div>

    if (!fullImageEl) return null;

    var sib = nextElementSibling(fullImageEl);
    if (sib && sib.classList && sib.classList.contains('dl-product-list')) return sib;

    if (sib) {
      var nested = safeQuery(sib, '.dl-product-list');
      if (nested) return nested;
    }

    // Sometimes product list comes before the image (less common)
    var prev = prevElementSibling(fullImageEl);
    if (prev && prev.classList && prev.classList.contains('dl-product-list')) return prev;

    return null;
  }

  function findNearestBlockWrapperForHandleNode(handleNode) {
    // We want a wrapper that represents a single "image block".
    // Priority wrappers:
    // - .dl-two-col__item
    // - .dl-full-image parent wrapper
    // - section/article blocks
    // - figure
    // - .rte > div wrappers
    if (!handleNode) return null;

    var el = handleNode;
    while (el && el !== document && el !== document.documentElement) {
      if (!isElement(el)) {
        el = el.parentNode;
        continue;
      }

      if (el.classList) {
        if (el.classList.contains('dl-two-col__item')) return el;
        if (el.classList.contains('dl-full-image')) return el.parentNode || el;
        if (el.classList.contains('dl-two-col')) return el; // acceptable
        if (el.classList.contains('dl-product-list')) return el.parentNode || el;
      }

      if (el.tagName) {
        var t = el.tagName.toLowerCase();
        if (t === 'figure') return el;
        if (t === 'article') return el;
        if (t === 'section') return el;
      }

      // Explicit
      if (safeGetAttr(el, 'data-dl-outfit-block')) return el;

      el = el.parentNode;
    }

    return null;
  }

  /* ============================================================
     BUILD OUTFITS FROM DOM (STRICT BLOCK SCOPING)
  ============================================================ */
  function extractOutfitsFromDocument(doc, sourceMeta) {
    doc = doc || document;
    sourceMeta = sourceMeta || {};

    var root =
      safeQuery(doc, 'article') ||
      safeQuery(doc, '.rte') ||
      doc.body ||
      doc.documentElement;

    // 1) Explicit blocks (highest priority)
    var explicitBlocks = collectExplicitOutfitBlocks(root);
    var outfits = [];
    var usedNodes = new Set();

    for (var i = 0; i < explicitBlocks.length; i++) {
      var b = explicitBlocks[i];
      var handles = extractHandlesFromNode(b);
      if (handles.length < CONFIG.MIN_HANDLES_PER_OUTFIT) continue;

      var img = pickBestImageFromBlock(b, sourceMeta.url || '');
      outfits.push(buildOutfitRecord({
        blockEl: b,
        handles: handles,
        image: img,
        source: sourceMeta,
        kind: 'explicit',
        index: outfits.length
      }));
      usedNodes.add(b);
    }

    // 2) Two-col items (each item is its own outfit scope)
    var twoItems = collectTwoColItems(root);
    for (var j = 0; j < twoItems.length; j++) {
      var item = twoItems[j];
      if (usedNodes.has(item)) continue;

      var itemHandles = extractHandlesFromNode(item);
      if (itemHandles.length < CONFIG.MIN_HANDLES_PER_OUTFIT) continue;

      var itemImg = pickBestImageFromBlock(item, sourceMeta.url || '');
      outfits.push(buildOutfitRecord({
        blockEl: item,
        handles: itemHandles,
        image: itemImg,
        source: sourceMeta,
        kind: 'two_col_item',
        index: outfits.length
      }));
      usedNodes.add(item);
    }

    // 3) Full-image anchors + companion product list (DL system)
    var fullImages = collectFullImageBlocks(root);
    for (var k = 0; k < fullImages.length; k++) {
      var full = fullImages[k];
      if (!full || usedNodes.has(full)) continue;

      var companion = findCompanionProductListForFullImage(full);

      // Handles are ONLY the ones inside that companion list (strict)
      var strictHandles = companion ? extractHandlesFromNode(companion) : [];

      // Fallback: sometimes handles are inside the same wrapper (still same block)
      if (!strictHandles.length) {
        var wrapper = full.parentNode;
        if (wrapper) strictHandles = extractHandlesFromNode(wrapper);
      }

      if (strictHandles.length < CONFIG.MIN_HANDLES_PER_OUTFIT) continue;

      var fullImg = pickBestImageFromBlock(full, sourceMeta.url || '');
      outfits.push(buildOutfitRecord({
        blockEl: full,
        handles: strictHandles,
        image: fullImg,
        source: sourceMeta,
        kind: 'full_image',
        index: outfits.length
      }));
      usedNodes.add(full);
      if (companion) usedNodes.add(companion);
    }

    // 4) Fallback: group by nearest wrapper per handle node (never merge across different wrappers)
    // This is only used if an article doesn't follow DL blocks but still contains data-product-handle attributes.
    var orphanHandleNodes = safeQueryAll(root, '[' + CONFIG.HANDLE_ATTR + ']');
    if (orphanHandleNodes.length) {
      var map = new Map(); // wrapperEl -> handles[]
      for (var n = 0; n < orphanHandleNodes.length; n++) {
        var hn = orphanHandleNodes[n];
        var hVal = normalizeHandle(safeGetAttr(hn, CONFIG.HANDLE_ATTR));
        if (!hVal) continue;

        var wrap = findNearestBlockWrapperForHandleNode(hn);
        if (!wrap) continue;

        // If this wrapper was already captured by a higher-priority method, skip adding fallback record
        // But still allow if the wrapper wasn't used and isn't inside used nodes.
        if (usedNodes.has(wrap)) continue;

        if (!map.has(wrap)) map.set(wrap, []);
        map.get(wrap).push(hVal);
      }

      map.forEach(function (handlesArr, wrapperEl) {
        var finalHandles = uniq(handlesArr);
        if (finalHandles.length < CONFIG.MIN_HANDLES_PER_OUTFIT) return;

        var fallbackImg = pickBestImageFromBlock(wrapperEl, sourceMeta.url || '');
        outfits.push(buildOutfitRecord({
          blockEl: wrapperEl,
          handles: finalHandles,
          image: fallbackImg,
          source: sourceMeta,
          kind: 'fallback_wrapper',
          index: outfits.length
        }));
        usedNodes.add(wrapperEl);
      });
    }

    // Final hard cleanup
    outfits = outfits.filter(function (o) {
      return o && o.handles && o.handles.length >= CONFIG.MIN_HANDLES_PER_OUTFIT;
    });

    // Ensure stable order: DOM order is approximated already, but keep as built.
    return outfits;
  }

  function buildOutfitRecord(opts) {
    opts = opts || {};
    var source = opts.source || {};

    var url = trim(source.url || '');
    var title = trim(source.title || '');
    var kind = trim(opts.kind || '');
    var idx = typeof opts.index === 'number' ? opts.index : 0;

    // Unique ID = url + kind + idx + first handle
    var handles = uniq(opts.handles || []);
    var idSeed = (url || 'current') + '|' + kind + '|' + idx + '|' + (handles[0] || '');
    var id = hashString(idSeed);

    var image = opts.image || { src: '', alt: '' };

    return {
      id: id,
      kind: kind,
      index: idx,
      source: {
        url: url,
        title: title
      },
      image: {
        src: trim(image.src || ''),
        alt: trim(image.alt || '')
      },
      handles: handles,
      // Optional future: occasion tags per outfit block, if you add attributes on the HTML block
      meta: {
        // Keep room for expansion without breaking structure
        extractedAt: nowMs()
      }
    };
  }

  /* ============================================================
     HASH (stable id)
  ============================================================ */
  function hashString(str) {
    str = String(str || '');
    // Simple deterministic hash (not crypto)
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return 'dljo_' + Math.abs(h);
  }

  /* ============================================================
     NETWORK: GET ARTICLE URLS FROM BLOG

     We try multiple strategies (Shopify-friendly):
     1) /blogs/journal?view=dl-copilot-feed  (if you add later)
     2) /blogs/journal.atom (parse links)
     3) /blogs/journal (parse article links from HTML)

     We only need URLs, then we fetch each article HTML and parse outfits.
  ============================================================ */

  function fetchText(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: opts.headers || {}
    }).then(function (res) {
      if (!res.ok) throw new Error('Fetch failed: ' + res.status);
      return res.text();
    });
  }

  function parseArticleUrlsFromAtom(atomXmlText) {
    var urls = [];
    try {
      var parser = new DOMParser();
      var xml = parser.parseFromString(atomXmlText, 'text/xml');
      // Atom: <entry><link rel="alternate" href="..."/></entry>
      var links = xml.getElementsByTagName('link');
      for (var i = 0; i < links.length; i++) {
        var rel = links[i].getAttribute('rel') || '';
        var href = links[i].getAttribute('href') || '';
        if (rel === 'alternate' && href) urls.push(stripHash(href));
      }
    } catch (e) {
      // ignore
    }
    return uniq(urls);
  }

  function parseArticleUrlsFromBlogHtml(html, baseUrl) {
    var urls = [];
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');

      // Common Shopify blog listing patterns:
      // - <a href="/blogs/journal/article-handle">
      // - <a class="article-card__link" href="...">
      var anchors = safeQueryAll(doc, 'a[href*="/blogs/"]');
      for (var i = 0; i < anchors.length; i++) {
        var href = safeGetAttr(anchors[i], 'href');
        if (!href) continue;
        href = toAbsUrl(href, baseUrl);
        if (!href) continue;
        // Must include /blogs/{BLOG_HANDLE}/
        var needle = '/blogs/' + CONFIG.BLOG_HANDLE + '/';
        if (href.indexOf(needle) === -1) continue;
        urls.push(stripHash(href));
      }
    } catch (e) {
      // ignore
    }
    return uniq(urls);
  }

  function getBlogBaseUrl() {
    return (window.location && window.location.origin ? window.location.origin : '') + '/blogs/' + CONFIG.BLOG_HANDLE;
  }

  function fetchBlogArticleUrls(options) {
    options = options || {};
    var max = typeof options.max === 'number' ? options.max : CONFIG.MAX_ARTICLES_TO_SCAN;

    var blogBase = getBlogBaseUrl();
    var feedViewUrl = blogBase + '?view=dl-copilot-feed';
    var atomUrl = blogBase + '.atom';
    var htmlUrl = blogBase;

    // Try view first (fast + controlled if you add it later), fallback to atom, fallback to html
    return fetchText(feedViewUrl).then(function (txt) {
      // If this view exists, we expect it to include direct article URLs in hrefs.
      var urls = parseArticleUrlsFromBlogHtml(txt, feedViewUrl);
      if (urls.length) return urls.slice(0, max);
      // If view exists but empty, fallback
      throw new Error('Empty feed view');
    }).catch(function () {
      return fetchText(atomUrl).then(function (atom) {
        var urls = parseArticleUrlsFromAtom(atom);
        if (urls.length) return urls.slice(0, max);
        throw new Error('Empty atom');
      });
    }).catch(function () {
      return fetchText(htmlUrl).then(function (html) {
        var urls = parseArticleUrlsFromBlogHtml(html, htmlUrl);
        return urls.slice(0, max);
      });
    });
  }

  /* ============================================================
     PARSE: OUTFITS FROM HTML STRING
  ============================================================ */
  function extractOutfitsFromHTML(html, sourceMeta) {
    sourceMeta = sourceMeta || {};
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');
      return extractOutfitsFromDocument(doc, sourceMeta);
    } catch (e) {
      return [];
    }
  }

  /* ============================================================
     PUBLIC: GET JOURNAL OUTFITS (Journal-first strategy)

     options:
       - maxOutfits (default CONFIG.MAX_OUTFITS_TO_RETURN)
       - maxArticles (default CONFIG.MAX_ARTICLES_TO_SCAN)
       - useCache (default true)
       - forceRefresh (default false)
  ============================================================ */
  function getJournalOutfits(options) {
    options = options || {};
    var maxOutfits = typeof options.maxOutfits === 'number' ? options.maxOutfits : CONFIG.MAX_OUTFITS_TO_RETURN;
    var maxArticles = typeof options.maxArticles === 'number' ? options.maxArticles : CONFIG.MAX_ARTICLES_TO_SCAN;
    var useCache = options.useCache !== false;
    var forceRefresh = options.forceRefresh === true;

    // 1) If we are on an article, parse current doc first (Journal priority)
    if (isLikelyArticleDocument(document)) {
      var currentUrl = stripHash(window.location.href || '');
      var currentTitle = trim(document.title || '');
      var outfitsHere = extractOutfitsFromDocument(document, { url: currentUrl, title: currentTitle });
      if (outfitsHere.length) {
        return Promise.resolve(outfitsHere.slice(0, maxOutfits));
      }
      // Even if none found, continue to scan blog index below.
    }

    // 2) Cached scan results (non-article pages)
    if (useCache && !forceRefresh) {
      var cached = loadCache();
      if (cached && cached.outfits && cached.outfits.length) {
        return Promise.resolve(cached.outfits.slice(0, maxOutfits));
      }
    }

    // 3) Fetch articles, parse each, stop when enough outfits gathered
    return fetchBlogArticleUrls({ max: maxArticles }).then(function (urls) {
      urls = (urls || []).slice(0, maxArticles);

      var collected = [];
      var chain = Promise.resolve();

      urls.forEach(function (url) {
        chain = chain.then(function () {
          if (collected.length >= maxOutfits) return null;

          // Fetch full HTML (works without special views)
          return fetchText(url).then(function (html) {
            var outfits = extractOutfitsFromHTML(html, {
              url: url,
              title: '' // title can be extracted but not required; core can display "From Journal"
            });

            // Append outfits, but never exceed maxOutfits
            for (var i = 0; i < outfits.length; i++) {
              collected.push(outfits[i]);
              if (collected.length >= maxOutfits) break;
            }

            return null;
          }).catch(function () {
            return null;
          });
        });
      });

      return chain.then(function () {
        // Cache collected outfits
        if (useCache) {
          saveCache({ outfits: collected, blogHandle: CONFIG.BLOG_HANDLE });
        }
        return collected.slice(0, maxOutfits);
      });
    }).catch(function () {
      return [];
    });
  }

  /* ============================================================
     OPTIONAL: FILTER OUTFITS BY PRODUCT TAGS (WHEN ENRICHED)

     This module DOES NOT fetch product tags.
     But if core passes enriched outfits like:
       outfit.products = [{handle, tags:[...]}]
     we can filter here, without changing grouping logic.

     occasionTag example:
       "Everyday" | "Work" | "Social Evening" | "Sunday Stroll" | "Smart Casual"

     NOTE:
     - Tags are context only.
     - Journal remains priority.
  ============================================================ */
  function filterOutfitsByOccasion(enrichedOutfits, occasionTag) {
    occasionTag = trim(occasionTag);
    if (!occasionTag) return enrichedOutfits || [];

    var tagLower = occasionTag.toLowerCase();

    return (enrichedOutfits || []).filter(function (o) {
      if (!o) return false;

      // If outfit has explicit meta tags later
      if (o.meta && Array.isArray(o.meta.tags) && o.meta.tags.length) {
        for (var i = 0; i < o.meta.tags.length; i++) {
          if (String(o.meta.tags[i] || '').toLowerCase() === tagLower) return true;
        }
      }

      // If core enriches with products + tags
      if (o.products && Array.isArray(o.products)) {
        for (var j = 0; j < o.products.length; j++) {
          var p = o.products[j];
          if (!p || !p.tags || !Array.isArray(p.tags)) continue;
          for (var k = 0; k < p.tags.length; k++) {
            if (String(p.tags[k] || '').toLowerCase() === tagLower) return true;
          }
        }
      }

      // No tag match
      return false;
    });
  }

  /* ============================================================
     DIAGNOSTICS (FOR YOU)
  ============================================================ */
  function debugExtractFromCurrentPage() {
    var url = stripHash(window.location.href || '');
    var title = trim(document.title || '');
    return extractOutfitsFromDocument(document, { url: url, title: title });
  }

  /* ============================================================
     PUBLIC API
  ============================================================ */
  DLCopilotJournal.config = CONFIG;

  DLCopilotJournal.isArticlePage = function () {
    return isLikelyArticleDocument(document);
  };

  DLCopilotJournal.clearCache = function () {
    clearCache();
  };

  DLCopilotJournal.extractOutfitsFromDocument = function (doc, sourceMeta) {
    return extractOutfitsFromDocument(doc, sourceMeta);
  };

  DLCopilotJournal.extractOutfitsFromHTML = function (html, sourceMeta) {
    return extractOutfitsFromHTML(html, sourceMeta);
  };

  DLCopilotJournal.fetchBlogArticleUrls = function (options) {
    return fetchBlogArticleUrls(options);
  };

  DLCopilotJournal.getJournalOutfits = function (options) {
    return getJournalOutfits(options);
  };

  DLCopilotJournal.filterOutfitsByOccasion = function (enrichedOutfits, occasionTag) {
    return filterOutfitsByOccasion(enrichedOutfits, occasionTag);
  };

  DLCopilotJournal.debugExtractFromCurrentPage = function () {
    return debugExtractFromCurrentPage();
  };

  window.DLCopilotJournal = DLCopilotJournal;

})();

