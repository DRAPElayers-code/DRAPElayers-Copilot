/* assets/dl-copilot-sizing.js
   DL Co-Pilot — Sizing Module (Both Menswear + Womenswear)
   - Pure logic module (NO DOM, NO CTA, NO panel UI)
   - Shopify-safe (no external deps)
   - Dynamic: derives schema from product when available, else from category intent
   - Supports:
     • EU numeric (mens jackets/trousers, womens 34–46)
     • Shirts collar sizes (EU 37–46)
     • Alpha (XS–XL) fallback
     • Waist (W28–W40) fallback
*/

(function () {
  'use strict';

  // Prevent double-loading (Theme Editor can re-render)
  if (window.DLCopilotSizing && window.DLCopilotSizing.__loaded__) return;

  /* ============================================================
     PUBLIC MODULE SHELL
  ============================================================ */
  var Mod = {
    __loaded__: true,
    version: 'dl-sz-1.0.0'
  };

  /* ============================================================
     UTILS — SAFE HELPERS
  ============================================================ */
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function toStr(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function lower(v) {
    return toStr(v).toLowerCase();
  }

  function uniq(arr) {
    var out = [];
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) { seen[k] = true; out.push(arr[i]); }
    }
    return out;
  }

  function clamp(n, min, max) {
    if (!isNum(n)) return n;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function roundToStep(value, step) {
    if (!isNum(value) || !isNum(step) || step <= 0) return value;
    return Math.round(value / step) * step;
  }

  function normalizeWhitespace(s) {
    return toStr(s).replace(/\s+/g, ' ').trim();
  }

  function normalizeHandle(s) {
    return lower(s).replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').trim();
  }

  function containsAny(haystack, needles) {
    var h = lower(haystack);
    for (var i = 0; i < needles.length; i++) {
      if (h.indexOf(lower(needles[i])) !== -1) return true;
    }
    return false;
  }

  function getProductText(product) {
    if (!product) return '';
    var parts = [];
    if (product.title) parts.push(product.title);
    if (product.handle) parts.push(product.handle);
    if (product.type) parts.push(product.type);
    if (product.vendor) parts.push(product.vendor);
    if (product.tags && Array.isArray(product.tags)) parts.push(product.tags.join(' '));
    if (product.options && Array.isArray(product.options)) parts.push(product.options.join(' '));
    return lower(parts.join(' '));
  }

  function getProductOptions(product) {
    if (!product || !Array.isArray(product.options)) return [];
    return product.options.map(function (o) { return toStr(o); });
  }

  function getProductVariants(product) {
    if (!product || !Array.isArray(product.variants)) return [];
    return product.variants;
  }

  function getOptionIndexByName(product, nameMatchers) {
    var options = getProductOptions(product);
    for (var i = 0; i < options.length; i++) {
      var optName = lower(options[i]);
      for (var j = 0; j < nameMatchers.length; j++) {
        var m = nameMatchers[j];
        if (typeof m === 'string') {
          if (optName.indexOf(lower(m)) !== -1) return i;
        } else if (m && m.test && m.test(optName)) {
          return i;
        }
      }
    }
    return -1;
  }

  function collectOptionValues(product, optionIndex) {
    var variants = getProductVariants(product);
    if (optionIndex < 0) return [];
    var values = [];
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var key = 'option' + (optionIndex + 1);
      var val = v && v[key];
      if (val) values.push(toStr(val));
    }
    return uniq(values);
  }

  function parseIntSafe(x) {
    var n = parseInt(x, 10);
    return isFinite(n) ? n : null;
  }

  /* ============================================================
     SIZE SYSTEMS
     - eu_numeric: EU 34–60
     - shirt_collar_eu: EU collar sizes 37–46
     - alpha: XS–XL
     - waist_inch: W28–W40 etc
  ============================================================ */
  var SIZE_SYSTEMS = {
    EU_NUMERIC: 'eu_numeric',
    SHIRT_COLLAR_EU: 'shirt_collar_eu',
    ALPHA: 'alpha',
    WAIST_INCH: 'waist_inch'
  };

  var ALPHA_ORDER = ['xxs','xs','s','m','l','xl','xxl','xxxl'];
  function normalizeAlphaSize(val) {
    var v = lower(val).replace(/\./g, '').trim();
    if (!v) return null;

    // Common aliases
    if (v === 'extra small') v = 'xs';
    if (v === 'small') v = 's';
    if (v === 'medium') v = 'm';
    if (v === 'large') v = 'l';
    if (v === 'extra large') v = 'xl';
    if (v === '2xl' || v === 'xxl') v = 'xxl';
    if (v === '3xl' || v === 'xxxl') v = 'xxxl';

    // Accept "x-small" style
    v = v.replace(/-/g, '');

    // Only allow known
    if (ALPHA_ORDER.indexOf(v) !== -1) return v.toUpperCase();
    return null;
  }

  function alphaToIndex(alpha) {
    var a = lower(alpha);
    a = a.replace(/-/g,'');
    if (a === 'xxs') return 0;
    if (a === 'xs') return 1;
    if (a === 's') return 2;
    if (a === 'm') return 3;
    if (a === 'l') return 4;
    if (a === 'xl') return 5;
    if (a === 'xxl') return 6;
    if (a === 'xxxl') return 7;
    return null;
  }

  /* ============================================================
     CATEGORIES (Drape Layers context)
     - We keep it simple but extensible.
  ============================================================ */
  var CATEGORIES = {
    UNKNOWN: 'unknown',
    TOP: 'top',
    BOTTOM: 'bottom',
    OUTERWEAR: 'outerwear',
    SHIRT: 'shirt',
    KNIT: 'knit',
    TSHIRT: 'tshirt',
    TROUSER: 'trouser',
    COAT: 'coat',
    JACKET: 'jacket',
    DRESS: 'dress',
    SKIRT: 'skirt',
    BLOUSE: 'blouse'
  };

  /* ============================================================
     GENDER (menswear / womenswear)
  ============================================================ */
  function inferGenderFromProduct(product) {
    var t = getProductText(product);
    if (!t) return null;

    // Strong tokens
    if (containsAny(t, ['women', 'woman', 'womenswear', 'ladies', 'female'])) return 'female';
    if (containsAny(t, ['men', 'man', 'menswear', 'male', 'gentlemen'])) return 'male';

    // Handle convention (your store used woman- / man-)
    if (product && product.handle) {
      var h = lower(product.handle);
      if (h.indexOf('woman-') === 0 || h.indexOf('women-') === 0) return 'female';
      if (h.indexOf('man-') === 0 || h.indexOf('men-') === 0) return 'male';
    }

    return null;
  }

  function inferCategoryFromProduct(product) {
    var t = getProductText(product);
    if (!t) return CATEGORIES.UNKNOWN;

    // Specific first
    if (containsAny(t, ['overshirt'])) return CATEGORIES.SHIRT;
    if (containsAny(t, ['shirt'])) return CATEGORIES.SHIRT;

    if (containsAny(t, ['t-shirt', 'tee', 'tshirt'])) return CATEGORIES.TSHIRT;
    if (containsAny(t, ['knit', 'sweater', 'jumper', 'cardigan'])) return CATEGORIES.KNIT;

    if (containsAny(t, ['trouser', 'trousers', 'pants', 'pant', 'slack', 'slacks'])) return CATEGORIES.TROUSER;
    if (containsAny(t, ['skirt'])) return CATEGORIES.SKIRT;

    if (containsAny(t, ['coat', 'overcoat'])) return CATEGORIES.COAT;
    if (containsAny(t, ['jacket', 'blouson', 'outerwear'])) return CATEGORIES.JACKET;

    if (containsAny(t, ['dress'])) return CATEGORIES.DRESS;
    if (containsAny(t, ['blouse'])) return CATEGORIES.BLOUSE;

    // Broad
    if (containsAny(t, ['top', 'tops'])) return CATEGORIES.TOP;
    if (containsAny(t, ['bottom', 'bottoms'])) return CATEGORIES.BOTTOM;

    return CATEGORIES.UNKNOWN;
  }

  /* ============================================================
     SIZE SCHEMA — DYNAMIC CONTRACT
     - This is what the CORE should rely on.
     - schema.askUsual = boolean (whether we ask user for usual size)
     - schema.system = one of SIZE_SYSTEMS
     - schema.category = one of CATEGORIES
     - schema.gender = 'male'|'female'|null
     - schema.required = array of atomic inputs to complete recommendation
       atoms:
         - height_cm
         - weight_kg
         - usual_size_eu
         - shirt_size_eu
         - alpha_size
         - waist_inch
  ============================================================ */
  function createSchema(base) {
    var s = {
      gender: null,
      category: CATEGORIES.UNKNOWN,
      system: SIZE_SYSTEMS.EU_NUMERIC,
      askUsual: true,
      required: ['height_cm', 'weight_kg', 'usual_size_eu'],
      notes: []
    };
    if (isObj(base)) {
      for (var k in base) s[k] = base[k];
    }
    return s;
  }

  function schemaForMenswear(category) {
    // Default menswear: EU numeric for tailoring pieces, ask usual size for category.
    if (category === CATEGORIES.SHIRT) {
      return createSchema({
        gender: 'male',
        category: CATEGORIES.SHIRT,
        system: SIZE_SYSTEMS.SHIRT_COLLAR_EU,
        askUsual: true,
        required: ['height_cm', 'weight_kg', 'shirt_size_eu'],
        notes: ['mens_shirt_requires_collar_size']
      });
    }

    if (category === CATEGORIES.TROUSER || category === CATEGORIES.BOTTOM) {
      // trousers can be EU numeric or waist inch; keep EU numeric as primary
      return createSchema({
        gender: 'male',
        category: CATEGORIES.TROUSER,
        system: SIZE_SYSTEMS.EU_NUMERIC,
        askUsual: true,
        required: ['height_cm', 'weight_kg', 'usual_size_eu'],
        notes: ['mens_trouser_eu_numeric']
      });
    }

    // Jackets / coats / tops
    return createSchema({
      gender: 'male',
      category: category || CATEGORIES.TOP,
      system: SIZE_SYSTEMS.EU_NUMERIC,
      askUsual: true,
      required: ['height_cm', 'weight_kg', 'usual_size_eu'],
      notes: ['mens_eu_numeric_default']
    });
  }

  function schemaForWomenswear(category) {
    // Default womenswear: EU numeric 34–46, ask usual size for category (tops/bottoms).
    // Shirts/blouses still usually EU numeric (not collar sizing).
    if (category === CATEGORIES.SHIRT || category === CATEGORIES.BLOUSE) {
      return createSchema({
        gender: 'female',
        category: category,
        system: SIZE_SYSTEMS.EU_NUMERIC,
        askUsual: true,
        required: ['height_cm', 'weight_kg', 'usual_size_eu'],
        notes: ['womens_top_eu_numeric']
      });
    }

    if (category === CATEGORIES.TROUSER || category === CATEGORIES.BOTTOM || category === CATEGORIES.SKIRT) {
      return createSchema({
        gender: 'female',
        category: category,
        system: SIZE_SYSTEMS.EU_NUMERIC,
        askUsual: true,
        required: ['height_cm', 'weight_kg', 'usual_size_eu'],
        notes: ['womens_bottom_eu_numeric']
      });
    }

    // Dresses / jackets / coats / knits / tees
    return createSchema({
      gender: 'female',
      category: category || CATEGORIES.TOP,
      system: SIZE_SYSTEMS.EU_NUMERIC,
      askUsual: true,
      required: ['height_cm', 'weight_kg', 'usual_size_eu'],
      notes: ['womens_eu_numeric_default']
    });
  }

  function schemaForGeneral(category, gender) {
    if (gender === 'male') return schemaForMenswear(category);
    if (gender === 'female') return schemaForWomenswear(category);

    // Unknown gender: still ask usual size EU numeric, can be overridden later
    return createSchema({
      gender: null,
      category: category || CATEGORIES.UNKNOWN,
      system: SIZE_SYSTEMS.EU_NUMERIC,
      askUsual: true,
      required: ['height_cm', 'weight_kg', 'usual_size_eu'],
      notes: ['gender_unknown_general_schema']
    });
  }

  /* ============================================================
     PRODUCT-BASED SCHEMA DETECTION
     - Detect if product actually uses:
       • collar sizes (shirt)
       • alpha sizes (XS/S/M/L)
       • waist inch (W30 etc)
       • EU numeric (34, 36, 48, 50)
  ============================================================ */
  function detectSystemFromVariantValues(values) {
    // values: array of strings from size-like option
    // Decide strongest signal.
    var hasAlpha = false;
    var hasCollar = false;
    var hasEuNumeric = false;
    var hasWaist = false;

    for (var i = 0; i < values.length; i++) {
      var v = lower(values[i]);

      // Alpha tokens
      if (normalizeAlphaSize(v)) hasAlpha = true;

      // Waist tokens like "W30", "30W", "Waist 30"
      if (/(\bw\d{2}\b|\b\d{2}\s*w\b|\bwaist\s*\d{2}\b)/i.test(values[i])) hasWaist = true;

      // Collar sizes: typically 37–46 and often plain numbers or "39"
      var n = parseIntSafe(v);
      if (n !== null) {
        // Shirt collar range is 37–46
        if (n >= 37 && n <= 46) hasCollar = true;

        // EU numeric often 34–60
        if (n >= 34 && n <= 60) hasEuNumeric = true;
      }
    }

    // Priority:
    // If it has waist patterns -> waist
    if (hasWaist) return SIZE_SYSTEMS.WAIST_INCH;
    // If collar sizes dominate -> collar
    // We consider collar if we have collar + NOT clearly EU tailoring sizes (48–56 etc),
    // but collar and EU overlap. We'll resolve with category: shirts -> collar.
    if (hasCollar && !hasAlpha) return SIZE_SYSTEMS.SHIRT_COLLAR_EU;
    if (hasAlpha) return SIZE_SYSTEMS.ALPHA;
    if (hasEuNumeric) return SIZE_SYSTEMS.EU_NUMERIC;

    return SIZE_SYSTEMS.EU_NUMERIC;
  }

  function extractAvailableSizes(product, schema) {
    if (!product) return { raw: [], numeric: [], alpha: [], waist: [] };

    var idxSize = getOptionIndexByName(product, [
      'size',
      /taglia/i,
      /talla/i,
      /größe/i,
      /taille/i
    ]);

    var sizeValues = collectOptionValues(product, idxSize);
    var out = { raw: sizeValues.slice(), numeric: [], alpha: [], waist: [] };

    for (var i = 0; i < sizeValues.length; i++) {
      var v = sizeValues[i];

      var a = normalizeAlphaSize(v);
      if (a) out.alpha.push(a);

      // Numeric
      var n = parseIntSafe(lower(v));
      if (n !== null) out.numeric.push(n);

      // Waist parse: W30 etc
      var m = lower(v).match(/\bw(\d{2})\b/);
      if (m && m[1]) {
        var wn = parseIntSafe(m[1]);
        if (wn !== null) out.waist.push(wn);
      } else {
        // "30 W"
        var m2 = lower(v).match(/\b(\d{2})\s*w\b/);
        if (m2 && m2[1]) {
          var wn2 = parseIntSafe(m2[1]);
          if (wn2 !== null) out.waist.push(wn2);
        }
      }
    }

    out.numeric = uniq(out.numeric).sort(function (a,b){ return a-b; });
    out.alpha = uniq(out.alpha).sort(function (a,b){ return alphaToIndex(a) - alphaToIndex(b); });
    out.waist = uniq(out.waist).sort(function (a,b){ return a-b; });

    // If schema says collar sizing, numeric list may include EU sizes too.
    // We'll keep raw lists; caller clamps based on schema.system.
    return out;
  }

  function detectSizeSchemaFromProduct(product) {
    // Returns schema OR null if product invalid
    if (!product || !isObj(product)) return null;

    var gender = inferGenderFromProduct(product);
    var category = inferCategoryFromProduct(product);

    // Base schema based on gender/category
    var schema = schemaForGeneral(category, gender);

    // If product has explicit size options, refine system
    var idxSize = getOptionIndexByName(product, ['size', /taglia/i, /talla/i, /größe/i, /taille/i]);
    var sizeValues = collectOptionValues(product, idxSize);

    if (sizeValues && sizeValues.length) {
      var detectedSystem = detectSystemFromVariantValues(sizeValues);

      // If category says SHIRT and we see numeric sizes 37–46, force collar sizing
      if (schema.category === CATEGORIES.SHIRT && detectedSystem === SIZE_SYSTEMS.SHIRT_COLLAR_EU) {
        schema.system = SIZE_SYSTEMS.SHIRT_COLLAR_EU;
        schema.required = ['height_cm', 'weight_kg', 'shirt_size_eu'];
        schema.askUsual = true;
        schema.notes.push('product_forces_collar_sizing');
      } else if (detectedSystem === SIZE_SYSTEMS.ALPHA) {
        schema.system = SIZE_SYSTEMS.ALPHA;
        schema.required = ['height_cm', 'weight_kg', 'alpha_size'];
        schema.askUsual = true;
        schema.notes.push('product_uses_alpha_sizing');
      } else if (detectedSystem === SIZE_SYSTEMS.WAIST_INCH) {
        schema.system = SIZE_SYSTEMS.WAIST_INCH;
        schema.required = ['height_cm', 'weight_kg', 'waist_inch'];
        schema.askUsual = true;
        schema.notes.push('product_uses_waist_sizing');
      } else {
        schema.system = SIZE_SYSTEMS.EU_NUMERIC;

        // Menswear shirts: still collar if it’s a real shirt
        if (schema.gender === 'male' && schema.category === CATEGORIES.SHIRT) {
          // If variants are EU tailoring sizes (44–56) then treat as EU numeric;
          // else collar.
          var hasTailoring = false;
          for (var i = 0; i < sizeValues.length; i++) {
            var n = parseIntSafe(lower(sizeValues[i]));
            if (n !== null && n >= 44 && n <= 60) { hasTailoring = true; break; }
          }
          if (!hasTailoring) {
            schema.system = SIZE_SYSTEMS.SHIRT_COLLAR_EU;
            schema.required = ['height_cm', 'weight_kg', 'shirt_size_eu'];
            schema.notes.push('mens_shirt_defaulted_to_collar');
          }
        } else {
          schema.required = ['height_cm', 'weight_kg', 'usual_size_eu'];
          schema.notes.push('product_uses_eu_numeric');
        }
      }
    } else {
      schema.notes.push('no_product_size_option_detected');
    }

    // Attach availability info for clamping later (optional)
    schema.available = extractAvailableSizes(product, schema);

    return schema;
  }

  /* ============================================================
     REQUIRED INPUTS / MISSING INPUTS
  ============================================================ */
  function getRequiredInputs(schema) {
    if (!schema || !Array.isArray(schema.required)) return ['height_cm', 'weight_kg', 'usual_size_eu'];
    return schema.required.slice();
  }

  function getMissingInputs(schema, user) {
    var required = getRequiredInputs(schema);
    var missing = [];
    user = user || {};

    for (var i = 0; i < required.length; i++) {
      var k = required[i];
      if (k === 'height_cm' && !user.height_cm) missing.push('height_cm');
      if (k === 'weight_kg' && !user.weight_kg) missing.push('weight_kg');
      if (k === 'usual_size_eu' && !user.usual_size_eu) missing.push('usual_size_eu');
      if (k === 'shirt_size_eu' && !user.shirt_size_eu) missing.push('shirt_size_eu');
      if (k === 'alpha_size' && !user.alpha_size) missing.push('alpha_size');
      if (k === 'waist_inch' && !user.waist_inch) missing.push('waist_inch');
    }

    return missing;
  }

  /* ============================================================
     USER INPUT PARSERS
     - Parses free text like:
       "178 cm 75 kg EU 48"
       "165/55/36"
       "I’m 180, 82, size 50"
       "shirt 40"
       "W32"
       "M"
  ============================================================ */
  function parseUserInput(text, schema) {
    var t = lower(text);
    var out = {
      height_cm: null,
      weight_kg: null,
      usual_size_eu: null,
      shirt_size_eu: null,
      alpha_size: null,
      waist_inch: null,
      ambiguous_numbers: []
    };

    if (!t) return out;

    // Alpha sizing tokens
    // Capture standalone alpha sizes
    var alphaMatch = t.match(/\b(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)\b/i);
    if (alphaMatch && alphaMatch[1]) {
      var alphaNorm = normalizeAlphaSize(alphaMatch[1]);
      if (alphaNorm) out.alpha_size = alphaNorm;
    }

    // Waist sizing tokens (W30, w32, 32w)
    var wMatch = t.match(/\bw(\d{2})\b/i);
    if (wMatch && wMatch[1]) {
      var wn = parseIntSafe(wMatch[1]);
      if (wn !== null) out.waist_inch = wn;
    } else {
      var wMatch2 = t.match(/\b(\d{2})\s*w\b/i);
      if (wMatch2 && wMatch2[1]) {
        var wn2 = parseIntSafe(wMatch2[1]);
        if (wn2 !== null) out.waist_inch = wn2;
      }
    }

    // Extract explicit units for height/weight
    // Height:
    var hm = t.match(/(\d{2,3})\s*cm\b/);
    if (hm && hm[1]) out.height_cm = parseIntSafe(hm[1]);

    // Weight:
    var wm = t.match(/(\d{2,3})\s*kg\b/);
    if (wm && wm[1]) out.weight_kg = parseIntSafe(wm[1]);

    // Explicit "EU 48" / "size 48"
    var eum = t.match(/\beu\s*(\d{2})\b/);
    if (eum && eum[1]) out.usual_size_eu = parseIntSafe(eum[1]);

    var sizeWordMatch = t.match(/\bsize\s*(\d{2})\b/);
    if (!out.usual_size_eu && sizeWordMatch && sizeWordMatch[1]) out.usual_size_eu = parseIntSafe(sizeWordMatch[1]);

    // Shirts: "shirt 40" "collar 39"
    var shirtMatch = t.match(/\b(shirt|collar)\s*(\d{2})\b/);
    if (shirtMatch && shirtMatch[2]) out.shirt_size_eu = parseIntSafe(shirtMatch[2]);

    // Now parse remaining bare numbers (2–3 digits)
    var nums = t.match(/\b\d{2,3}\b/g) || [];
    var used = {};

    function markUsed(n) { used[String(n)] = (used[String(n)] || 0) + 1; }

    if (out.height_cm) markUsed(out.height_cm);
    if (out.weight_kg) markUsed(out.weight_kg);
    if (out.usual_size_eu) markUsed(out.usual_size_eu);
    if (out.shirt_size_eu) markUsed(out.shirt_size_eu);
    if (out.waist_inch) markUsed(out.waist_inch);

    // Assign bare numbers by schema/system preference
    for (var i = 0; i < nums.length; i++) {
      var n = parseIntSafe(nums[i]);
      if (n === null) continue;

      // If already used enough times, skip
      if (used[String(n)]) {
        used[String(n)] = used[String(n)] - 1;
        continue;
      }

      // Height dominance
      if (!out.height_cm && n >= 140 && n <= 210) { out.height_cm = n; continue; }

      // System-directed:
      if (schema && schema.system === SIZE_SYSTEMS.SHIRT_COLLAR_EU) {
        // collar size 37–46
        if (!out.shirt_size_eu && n >= 37 && n <= 46) { out.shirt_size_eu = n; continue; }
      }

      if (schema && schema.system === SIZE_SYSTEMS.WAIST_INCH) {
        // waist 26–44 typical
        if (!out.waist_inch && n >= 24 && n <= 48) { out.waist_inch = n; continue; }
      }

      if (schema && schema.system === SIZE_SYSTEMS.EU_NUMERIC) {
        if (!out.usual_size_eu && n >= 34 && n <= 60) { out.usual_size_eu = n; continue; }
      }

      // Weight range:
      if (!out.weight_kg && n >= 40 && n <= 180) { out.weight_kg = n; continue; }

      out.ambiguous_numbers.push(n);
    }

    // If schema expects shirt size but user typed EU size, allow reuse within collar range
    if (schema && schema.system === SIZE_SYSTEMS.SHIRT_COLLAR_EU) {
      if (!out.shirt_size_eu && out.usual_size_eu && out.usual_size_eu >= 37 && out.usual_size_eu <= 46) {
        out.shirt_size_eu = out.usual_size_eu;
        out.usual_size_eu = null;
      }
    }

    return out;
  }

  /* ============================================================
     VALIDATION (LIGHT GUARDRAILS)
  ============================================================ */
  function validateAtomic(schema, user) {
    var issues = [];
    user = user || {};

    // Height
    if (user.height_cm && (user.height_cm < 145 || user.height_cm > 205)) issues.push('height_cm');

    // Weight
    if (user.weight_kg && (user.weight_kg < 40 || user.weight_kg > 180)) issues.push('weight_kg');

    // BMI-ish guardrail if both
    if (user.height_cm && user.weight_kg) {
      var h = user.height_cm / 100;
      var bmi = user.weight_kg / (h * h);
      if (bmi < 15 || bmi > 60) issues.push('height_weight_mismatch');
    }

    // EU sizes by gender if known
    if (schema && schema.system === SIZE_SYSTEMS.EU_NUMERIC && user.usual_size_eu) {
      if (schema.gender === 'female') {
        if (user.usual_size_eu < 32 || user.usual_size_eu > 48) issues.push('usual_size_eu');
      } else if (schema.gender === 'male') {
        if (user.usual_size_eu < 42 || user.usual_size_eu > 60) issues.push('usual_size_eu');
      } else {
        if (user.usual_size_eu < 32 || user.usual_size_eu > 60) issues.push('usual_size_eu');
      }
    }

    if (schema && schema.system === SIZE_SYSTEMS.SHIRT_COLLAR_EU && user.shirt_size_eu) {
      if (user.shirt_size_eu < 35 || user.shirt_size_eu > 47) issues.push('shirt_size_eu');
    }

    if (schema && schema.system === SIZE_SYSTEMS.WAIST_INCH && user.waist_inch) {
      if (user.waist_inch < 24 || user.waist_inch > 48) issues.push('waist_inch');
    }

    if (schema && schema.system === SIZE_SYSTEMS.ALPHA && user.alpha_size) {
      if (!normalizeAlphaSize(user.alpha_size)) issues.push('alpha_size');
    }

    return issues;
  }

  /* ============================================================
     RECOMMENDATION ENGINE (HEURISTICS)
     - Uses height/weight + usual size as anchor
     - If usual size missing, derives from proportions
     - Always clamps to product availability when provided
  ============================================================ */
  function resolveLength(height_cm, gender) {
    if (!height_cm) return 'standard';

    if (gender === 'male') {
      if (height_cm < 170) return 'short';
      if (height_cm <= 184) return 'standard';
      return 'long';
    }

    if (gender === 'female') {
      if (height_cm < 162) return 'short';
      if (height_cm <= 172) return 'standard';
      return 'long';
    }

    // unknown gender: conservative
    if (height_cm < 166) return 'short';
    if (height_cm <= 180) return 'standard';
    return 'long';
  }

  function deriveEuSizeFromProportions(height_cm, weight_kg, gender) {
    if (!height_cm || !weight_kg) return null;

    // frameIndex (simple)
    var frameIndex = weight_kg / (height_cm / 100);

    if (gender === 'male') {
      var baseM;
      if (frameIndex < 43) baseM = 46;
      else if (frameIndex < 47) baseM = 48;
      else if (frameIndex < 51) baseM = 50;
      else if (frameIndex < 55) baseM = 52;
      else baseM = 54;

      if (height_cm >= 195) baseM += 2;
      if (height_cm >= 205) baseM += 2;

      return clamp(baseM, 44, 60);
    }

    if (gender === 'female') {
      var baseW;
      if (frameIndex < 34) baseW = 34;
      else if (frameIndex < 38) baseW = 36;
      else if (frameIndex < 42) baseW = 38;
      else if (frameIndex < 46) baseW = 40;
      else if (frameIndex < 50) baseW = 42;
      else if (frameIndex < 54) baseW = 44;
      else baseW = 46;

      if (height_cm >= 175) baseW += 2;
      if (height_cm >= 182) baseW += 2;

      return clamp(baseW, 32, 48);
    }

    // unknown: neutral band
    var neutral;
    if (frameIndex < 38) neutral = 36;
    else if (frameIndex < 44) neutral = 40;
    else if (frameIndex < 50) neutral = 44;
    else neutral = 48;
    return clamp(neutral, 34, 58);
  }

  function deriveShirtCollarFromProportions(height_cm, weight_kg) {
    if (!height_cm || !weight_kg) return null;

    // Gentle bias:
    // under 70kg tends to 38–40, 70–85 to 40–42, above 85 to 42–44
    var collar;
    if (weight_kg < 65) collar = 38;
    else if (weight_kg < 72) collar = 39;
    else if (weight_kg < 80) collar = 40;
    else if (weight_kg < 88) collar = 41;
    else if (weight_kg < 96) collar = 42;
    else collar = 43;

    // Height adjustment
    if (height_cm >= 190) collar += 1;
    if (height_cm <= 168) collar -= 1;

    return clamp(collar, 37, 46);
  }

  function deriveAlphaFromProportions(height_cm, weight_kg, gender) {
    if (!height_cm || !weight_kg) return null;

    // Convert to rough "frame"
    var frameIndex = weight_kg / (height_cm / 100);

    // Use gender to shift
    var idx;
    if (gender === 'female') {
      if (frameIndex < 30) idx = 1;       // XS
      else if (frameIndex < 34) idx = 2;  // S
      else if (frameIndex < 38) idx = 3;  // M
      else if (frameIndex < 42) idx = 4;  // L
      else idx = 5;                        // XL
    } else {
      if (frameIndex < 40) idx = 2;       // S
      else if (frameIndex < 46) idx = 3;  // M
      else if (frameIndex < 52) idx = 4;  // L
      else if (frameIndex < 58) idx = 5;  // XL
      else idx = 6;                        // XXL
    }

    var a = ALPHA_ORDER[idx] || 'm';
    return a.toUpperCase();
  }

  function deriveWaistFromProportions(height_cm, weight_kg, gender) {
    if (!height_cm || !weight_kg) return null;

    // Very rough. Prefer using user-provided waist if possible.
    // Map weight ranges to waist inch
    var w;
    if (gender === 'female') {
      if (weight_kg < 55) w = 26;
      else if (weight_kg < 62) w = 27;
      else if (weight_kg < 70) w = 28;
      else if (weight_kg < 78) w = 30;
      else if (weight_kg < 86) w = 32;
      else w = 34;
    } else {
      if (weight_kg < 65) w = 29;
      else if (weight_kg < 73) w = 30;
      else if (weight_kg < 82) w = 32;
      else if (weight_kg < 92) w = 34;
      else if (weight_kg < 104) w = 36;
      else w = 38;
    }

    // Height tweak
    if (height_cm >= 190) w += 1;
    if (height_cm <= 168) w -= 1;

    return clamp(w, 24, 48);
  }

  function closestNumeric(target, list) {
    if (!isNum(target) || !list || !list.length) return target;
    var best = list[0];
    var bestDiff = Math.abs(best - target);
    for (var i = 1; i < list.length; i++) {
      var d = Math.abs(list[i] - target);
      if (d < bestDiff) { best = list[i]; bestDiff = d; }
    }
    return best;
  }

  function closestAlpha(targetAlpha, list) {
    if (!targetAlpha || !list || !list.length) return targetAlpha;
    var t = alphaToIndex(targetAlpha);
    if (t === null) return targetAlpha;
    var best = list[0];
    var bestDiff = Math.abs(alphaToIndex(best) - t);

    for (var i = 1; i < list.length; i++) {
      var d = Math.abs(alphaToIndex(list[i]) - t);
      if (d < bestDiff) { best = list[i]; bestDiff = d; }
    }
    return best;
  }

  function clampRecommendationToProduct(schema, recommendation) {
    if (!schema || !schema.available) return recommendation;
    var avail = schema.available;

    if (schema.system === SIZE_SYSTEMS.EU_NUMERIC) {
      if (recommendation && isNum(recommendation.size_eu) && avail.numeric && avail.numeric.length) {
        recommendation.size_eu = closestNumeric(recommendation.size_eu, avail.numeric);
      }
    }

    if (schema.system === SIZE_SYSTEMS.SHIRT_COLLAR_EU) {
      if (recommendation && isNum(recommendation.shirt_size_eu) && avail.numeric && avail.numeric.length) {
        // collar values are numeric too, but we want the nearest within available
        recommendation.shirt_size_eu = closestNumeric(recommendation.shirt_size_eu, avail.numeric);
      }
    }

    if (schema.system === SIZE_SYSTEMS.ALPHA) {
      if (recommendation && recommendation.alpha_size && avail.alpha && avail.alpha.length) {
        recommendation.alpha_size = closestAlpha(recommendation.alpha_size, avail.alpha);
      }
    }

    if (schema.system === SIZE_SYSTEMS.WAIST_INCH) {
      if (recommendation && isNum(recommendation.waist_inch) && avail.waist && avail.waist.length) {
        recommendation.waist_inch = closestNumeric(recommendation.waist_inch, avail.waist);
      }
    }

    return recommendation;
  }

  function recommend(schema, user) {
    user = user || {};
    schema = schema || schemaForGeneral(CATEGORIES.UNKNOWN, null);

    var rec = {
      system: schema.system,
      gender: schema.gender || null,
      category: schema.category || CATEGORIES.UNKNOWN,
      length: resolveLength(user.height_cm, schema.gender),
      size_eu: null,
      shirt_size_eu: null,
      alpha_size: null,
      waist_inch: null,
      used_usual_as_anchor: false
    };

    // EU numeric system
    if (schema.system === SIZE_SYSTEMS.EU_NUMERIC) {
      if (user.usual_size_eu) {
        rec.size_eu = user.usual_size_eu;
        rec.used_usual_as_anchor = true;
      } else {
        rec.size_eu = deriveEuSizeFromProportions(user.height_cm, user.weight_kg, schema.gender);
      }
    }

    // Shirt collar
    if (schema.system === SIZE_SYSTEMS.SHIRT_COLLAR_EU) {
      if (user.shirt_size_eu) {
        rec.shirt_size_eu = user.shirt_size_eu;
        rec.used_usual_as_anchor = true;
      } else {
        rec.shirt_size_eu = deriveShirtCollarFromProportions(user.height_cm, user.weight_kg);
      }
    }

    // Alpha
    if (schema.system === SIZE_SYSTEMS.ALPHA) {
      if (user.alpha_size) {
        rec.alpha_size = normalizeAlphaSize(user.alpha_size) || user.alpha_size;
        rec.used_usual_as_anchor = true;
      } else {
        rec.alpha_size = deriveAlphaFromProportions(user.height_cm, user.weight_kg, schema.gender);
      }
    }

    // Waist
    if (schema.system === SIZE_SYSTEMS.WAIST_INCH) {
      if (user.waist_inch) {
        rec.waist_inch = user.waist_inch;
        rec.used_usual_as_anchor = true;
      } else {
        rec.waist_inch = deriveWaistFromProportions(user.height_cm, user.weight_kg, schema.gender);
      }
    }

    // Clamp to product availability if we have it
    rec = clampRecommendationToProduct(schema, rec);

    return rec;
  }

  /* ============================================================
     CATEGORY-AWARE "USUAL SIZE" ASK
     - You wanted: ask usual size of the category user is looking at.
     - This function returns the label prompt key the CORE can use.
  ============================================================ */
  function usualSizePromptKey(schema) {
    if (!schema) return 'usual_size_eu';

    // Shirt collar
    if (schema.system === SIZE_SYSTEMS.SHIRT_COLLAR_EU) return 'shirt_size_eu';

    // Alpha sizes
    if (schema.system === SIZE_SYSTEMS.ALPHA) return 'alpha_size';

    // Waist
    if (schema.system === SIZE_SYSTEMS.WAIST_INCH) return 'waist_inch';

    // EU numeric: vary by gender/category for wording
    return 'usual_size_eu';
  }

  /* ============================================================
     PUBLIC API — what CORE can call
  ============================================================ */
  Mod.SIZE_SYSTEMS = SIZE_SYSTEMS;
  Mod.CATEGORIES = CATEGORIES;

  Mod.inferGenderFromProduct = inferGenderFromProduct;
  Mod.inferCategoryFromProduct = inferCategoryFromProduct;

  Mod.schemaForMenswear = schemaForMenswear;
  Mod.schemaForWomenswear = schemaForWomenswear;
  Mod.schemaForGeneral = schemaForGeneral;

  Mod.detectSizeSchemaFromProduct = detectSizeSchemaFromProduct;
  Mod.extractAvailableSizes = extractAvailableSizes;

  Mod.getRequiredInputs = getRequiredInputs;
  Mod.getMissingInputs = getMissingInputs;

  Mod.parseUserInput = parseUserInput;
  Mod.validateAtomic = validateAtomic;

  Mod.resolveLength = resolveLength;
  Mod.recommend = recommend;

  Mod.usualSizePromptKey = usualSizePromptKey;

    /* ============================================================
     DLCOPILOT ADDITION — PRODUCT-AWARE ENTRY POINT
     ------------------------------------------------------------
     This function is REQUIRED by dl-copilot-core.js
     It does NOT change any existing logic.
     It simply wires together:
       - product → schema detection
       - user inputs
       - recommendation (EU size + length + system)
  ============================================================ */
  Mod.recommendForProduct = function (ctx) {
    if (!ctx || !ctx.user) return null;

    var product = ctx.product || null;
    var user = ctx.user || {};

    // 1. Detect schema directly from product (variants + category + gender)
    var schema = null;
    if (product) {
      schema = detectSizeSchemaFromProduct(product);
    }

    // 2. Fallback if product schema cannot be detected
    if (!schema) {
      schema = schemaForGeneral(
        inferCategoryFromProduct(product),
        ctx.gender || inferGenderFromProduct(product)
      );
    }

    if (!schema) return null;

    // 3. Build normalized user input payload
    var normalizedUser = {
      height_cm: user.height_cm || null,
      weight_kg: user.weight_kg || null,
      usual_size_eu: user.usual_size_eu || null,
      shirt_size_eu: user.shirt_size_eu || null,
      alpha_size: user.alpha_size || null,
      waist_inch: user.waist_inch || null
    };

    // 4. Run recommendation engine
    var rec = recommend(schema, normalizedUser);
    if (!rec) return null;

    // 5. Normalize output for CORE
    return {
      system: rec.system,
      category: rec.category,
      gender: rec.gender,
      size_eu: rec.size_eu || null,
      shirt_size_eu: rec.shirt_size_eu || null,
      alpha_size: rec.alpha_size || null,
      waist_inch: rec.waist_inch || null,
      length: rec.length || 'standard',
      used_usual_as_anchor: !!rec.used_usual_as_anchor
    };
  };

  // Expose globally (CORE loads this file before using it)
  window.DLCopilotSizing = Mod;

})();

