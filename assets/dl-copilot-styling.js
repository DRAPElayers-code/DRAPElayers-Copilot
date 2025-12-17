/* ============================================================
   DL CO-PILOT — STYLING MODULE
   ------------------------------------------------------------
   Intent: styling_advice

   Fixes included:
   - De-dupe flow start using routeId (prevents repeated messages)
   - Never “double start” on both intent:select and flow:route
   - Keeps input locked when pills are required
   - Explicitly releases flow ownership before routing away
   - Defensive recovery from stale active state after refresh
============================================================ */

(function () {
  'use strict';

  if (!window.DLCopilot || !window.DLCopilot.__coreInitialized) {
    throw new Error('dl-copilot-core.js must be loaded before dl-copilot-styling.js');
  }

  window.DLCopilot.registerModule('styling', function (api) {
    /* ============================================================
       MODULE CONSTANTS
    ============================================================ */

    var MODULE_ID = 'styling';
    var INTENT = 'styling_advice';

    var CONFIG = {
      MAX_OUTFITS_TO_SHOW: 6,
      MAX_PRODUCTS_PER_OUTFIT_TO_RENDER: 8
    };

    /* ============================================================
       MODULE STATE (persisted via core state.modules)
    ============================================================ */

    if (!api.state.modules) api.state.modules = {};
    if (!api.state.modules[MODULE_ID]) api.state.modules[MODULE_ID] = {};

    var STORE = api.state.modules[MODULE_ID];

    var STATE = {
      active: false,
      step: 'idle',

      context: null,
      formality: null,

      outfits: [],
      resolvedOutfits: [],
      selectedIndex: null,

      busy: false,

      // De-dupe guard
      lastHandledRouteId: null,

      // Explicit ownership flag (ADDED — additive)
      ownsFlow: false
    };

    // Hydrate from STORE if present
    hydrateFromStore();

    function hydrateFromStore() {
      try {
        if (STORE && STORE.__stylingState && typeof STORE.__stylingState === 'object') {
          var s = STORE.__stylingState;

          STATE.active = !!s.active;
          STATE.step = s.step || 'idle';
          STATE.context = s.context || null;
          STATE.formality = s.formality || null;
          STATE.outfits = Array.isArray(s.outfits) ? s.outfits : [];
          STATE.resolvedOutfits = Array.isArray(s.resolvedOutfits) ? s.resolvedOutfits : [];
          STATE.selectedIndex = typeof s.selectedIndex === 'number' ? s.selectedIndex : null;
          STATE.busy = !!s.busy;
          STATE.lastHandledRouteId = s.lastHandledRouteId || null;
          STATE.ownsFlow = !!s.ownsFlow;
        }
      } catch (e) {}
    }

    function persistToStore() {
      try {
        STORE.__stylingState = {
          active: !!STATE.active,
          step: STATE.step,
          context: STATE.context,
          formality: STATE.formality,
          outfits: STATE.outfits,
          resolvedOutfits: STATE.resolvedOutfits,
          selectedIndex: STATE.selectedIndex,
          busy: !!STATE.busy,
          lastHandledRouteId: STATE.lastHandledRouteId,
          ownsFlow: STATE.ownsFlow
        };
        if (typeof api.persist === 'function') api.persist();
      } catch (e) {}
    }

    /* ============================================================
       UTILS
    ============================================================ */

    function toStr(v) { return String(v == null ? '' : v); }

    function uniq(arr) {
      var out = [];
      var seen = {};
      for (var i = 0; i < (arr || []).length; i++) {
        var x = toStr(arr[i]).trim();
        if (!x) continue;
        if (seen[x]) continue;
        seen[x] = true;
        out.push(x);
      }
      return out;
    }

    function safeGet(obj, path, fallback) {
      try {
        var parts = path.split('.');
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
          if (!cur) return fallback;
          cur = cur[parts[i]];
        }
        return cur == null ? fallback : cur;
      } catch (e) {
        return fallback;
      }
    }

    function escHtml(text) {
      if (api && api.utils && typeof api.utils.escapeText === 'function') {
        return api.utils.escapeText(text);
      }
      return toStr(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function pill(label, onClick, opts) {
      opts = opts || {};
      return {
        label: label,
        unlockInput: !!opts.unlockInput,
        onClick: onClick
      };
    }

    function setFlow(intent, step, payload) {
      if (!api || !api.state) return;
      if (!api.state.flow) api.state.flow = {};
      api.state.flow.intent = intent || null;
      api.state.flow.step = step || null;
      api.state.flow.payload = payload || {};
      api.state.flow.activeModule = MODULE_ID;
      STATE.ownsFlow = true;
      persistToStore();
    }

    function clearForNewRun() {
      STATE.active = true;
      STATE.step = 'idle';
      STATE.context = null;
      STATE.formality = null;
      STATE.outfits = [];
      STATE.resolvedOutfits = [];
      STATE.selectedIndex = null;
      STATE.busy = false;
      STATE.ownsFlow = true;
      persistToStore();
    }
    function releaseFlowOwnership() {
      STATE.active = false;
      STATE.ownsFlow = false;
      STATE.step = 'idle';
      persistToStore();

      if (api && api.state && api.state.flow) {
        api.state.flow.activeModule = null;
      }
    }

    function shouldHandleRoute(routeId) {
      if (!routeId) return true;
      if (STATE.lastHandledRouteId === routeId) return false;
      STATE.lastHandledRouteId = routeId;
      persistToStore();
      return true;
    }

    /* ============================================================
       DEPENDENCY CHECKS
    ============================================================ */

    function ensureDependencies() {
      if (!window.DLCopilotJournal) {
        api.appendAI('Styling is unavailable because journal data is missing.');
        exitToEntry();
        return false;
      }
      if (!window.DLCopilotProducts) {
        api.appendAI('Styling is unavailable because product data is missing.');
        exitToEntry();
        return false;
      }
      return true;
    }

    /* ============================================================
       EXIT + RECOVERY
    ============================================================ */

    function exitToEntry() {
      releaseFlowOwnership();
      if (api && typeof api.renderEntryIfAvailable === 'function') {
        api.renderEntryIfAvailable();
      }
    }

    // Defensive recovery on refresh: active but no UI
    function recoverIfStale() {
      try {
        if (
          STATE.active &&
          STATE.ownsFlow &&
          api &&
          api.state &&
          api.state.inputLocked &&
          !document.querySelector('.dl-copilot-pillgroup')
        ) {
          releaseFlowOwnership();
          if (typeof api.renderEntryIfAvailable === 'function') {
            api.renderEntryIfAvailable();
          }
        }
      } catch (e) {}
    }

    recoverIfStale();

    /* ============================================================
       JOURNAL → OUTFITS
    ============================================================ */

    async function getJournalOutfits(context, formality) {
      try {
        if (window.DLCopilotJournal.resolveOutfits) {
          return await window.DLCopilotJournal.resolveOutfits({
            context: context,
            formality: formality
          }) || [];
        }
      } catch (e) {}
      return [];
    }

    async function resolveProducts(outfits) {
      var out = [];
      for (var i = 0; i < outfits.length; i++) {
        var o = outfits[i];
        var handles = uniq(o.handles || []);
        var products = [];

        for (var h = 0; h < handles.length; h++) {
          try {
            var p = await window.DLCopilotProducts.getProduct(handles[h]);
            products.push(p || { handle: handles[h], title: handles[h] });
          } catch (e) {
            products.push({ handle: handles[h], title: handles[h] });
          }
        }

        out.push({
          image: o.image || null,
          handles: handles,
          products: products
        });
      }
      return out;
    }

    /* ============================================================
       RENDER: CONTEXT SELECTION
    ============================================================ */

    function renderContextStep() {
      STATE.step = 'context';
      persistToStore();

      api.appendAI('What are you dressing for?');

      api.renderPills([
        pill('Everyday', function () { chooseContext('everyday'); }),
        pill('Work', function () { chooseContext('work'); }),
        pill('Social Evening', function () { chooseContext('social_evening'); }),
        pill('Sunday Stroll', function () { chooseContext('sunday_stroll'); }),
        pill('Smart Casual', function () { chooseContext('smart_casual'); })
      ]);

      api.lockInput('Please choose an option above');
    }

    function chooseContext(ctx) {
      STATE.context = ctx;
      STATE.formality = null;
      persistToStore();

      api.appendAI('Great.');

      if (ctx === 'everyday' || ctx === 'work') {
        renderFormalityStep();
      } else {
        curateOutfits();
      }
    }

    /* ============================================================
       RENDER: FORMALITY
    ============================================================ */

    function renderFormalityStep() {
      STATE.step = 'formality';
      persistToStore();

      api.appendAI('How formal should it feel?');

      api.renderPills([
        pill('Relaxed', function () { chooseFormality('relaxed'); }),
        pill('Balanced', function () { chooseFormality('balanced'); }),
        pill('Sharp', function () { chooseFormality('sharp'); }),
        pill('Back', function () { renderContextStep(); })
      ]);

      api.lockInput('Please choose an option above');
    }

    function chooseFormality(formality) {
      STATE.formality = formality;
      persistToStore();

      api.appendAI('Perfect.');
      curateOutfits();
    }

    /* ============================================================
       CURATION
    ============================================================ */

    async function curateOutfits() {
      if (STATE.busy) return;
      if (!ensureDependencies()) return;

      STATE.busy = true;
      persistToStore();

      api.appendAI('Curating outfits from our journal…');
      api.lockInput('Curating…');

      try {
        var outfits = await getJournalOutfits(STATE.context, STATE.formality);

        if (!outfits.length) {
          api.appendAI('I couldn’t find a suitable editorial outfit.');
          exitToEntry();
          return;
        }

        STATE.outfits = outfits;
        STATE.resolvedOutfits = await resolveProducts(outfits);
        persistToStore();

        renderOutfitList();
      } finally {
        STATE.busy = false;
        persistToStore();
      }
    }

    /* ============================================================
       RENDER: OUTFIT LIST
    ============================================================ */

    function renderOutfitList() {
      STATE.step = 'list';
      persistToStore();

      api.appendAI('Here are some outfit options:');

      var pills = [];
      var max = Math.min(CONFIG.MAX_OUTFITS_TO_SHOW, STATE.resolvedOutfits.length);

      for (var i = 0; i < max; i++) {
        (function (idx) {
          pills.push(
            pill('Outfit ' + (idx + 1), function () {
              renderOutfitDetail(idx);
            })
          );
        })(i);
      }

      pills.push(pill('Back to start', exitToEntry));

      api.renderPills(pills);
      api.lockInput('Please choose an option above');
    }

    /* ============================================================
       RENDER: OUTFIT DETAIL
    ============================================================ */

    function renderOutfitDetail(index) {
      var outfit = STATE.resolvedOutfits[index];
      if (!outfit) return;

      STATE.selectedIndex = index;
      STATE.step = 'detail';
      persistToStore();

      if (outfit.image && outfit.image.src) {
        api.appendAI(
          '<img src="' +
            escHtml(outfit.image.src) +
            '" style="width:100%;border-radius:12px" />'
        );
      }

      api.appendAI('Pieces in this outfit:');

      var html = '<ul>';
      for (var i = 0; i < outfit.products.length; i++) {
        var p = outfit.products[i];
        html +=
          '<li><a href="/products/' +
          escHtml(p.handle) +
          '">' +
          escHtml(p.title || p.handle) +
          '</a></li>';
      }
      html += '</ul>';

      api.appendAI(html);

      api.appendAI('What would you like to do next?');

      api.renderPills([
        pill('Recommend my size', function () {
          exitStylingThenRoute('size_guidance', { from: 'styling', handles: outfit.handles });
        }),
        pill('Another outfit', function () {
          renderOutfitList();
        }),
        pill('Back to start', exitToEntry)
      ]);

      api.lockInput('Please choose an option above');
    }
    /* ============================================================
       ROUTE OUT OF STYLING (CRITICAL FIX)
       - Release ownership before emitting intent so pills don’t die
    ============================================================ */

    function exitStylingThenRoute(intent, payload) {
      // Ensure we release any internal ownership and stop “active” loops
      releaseFlowOwnership();

      // Also ensure core flow metadata is not pinned to this module
      try {
        if (api && api.state && api.state.flow) {
          api.state.flow.activeModule = null;
        }
      } catch (e) {}

      // Now route cleanly
      api.emit('intent:select', {
        intent: intent,
        payload: payload || {},
        routeId: (payload && payload.routeId) ? payload.routeId : null
      });
    }

    /* ============================================================
       FLOW ROUTING — SINGLE ENTRY POINT
       - Only react to flow:route
       - Dedupe using routeId
       - Ensure we mark ownership in state.flow.activeModule
    ============================================================ */

    function onFlowRoute(evt) {
      if (!evt || evt.intent !== INTENT) return;

      // De-dupe to prevent repeat messages (theme editor re-renders can double-fire)
      if (!shouldHandleRoute(evt.routeId)) return;

      // Start fresh, and claim flow ownership
      clearForNewRun();
      setFlow(INTENT, 'context', evt.payload || {});

      // Make sure the user sees the first step
      renderContextStep();
    }

    api.on('flow:route', onFlowRoute);

    /* ============================================================
       OPTIONAL: INTENT SELECT LISTENER (SAFE NO-OP)
       ------------------------------------------------------------
       We intentionally do NOT start the flow here because core
       already routes intent → flow:route. This prevents double-start.
    ============================================================ */

    function onIntentSelect(evt) {
      // No-op by design, but kept to match older architecture safely.
      // If older code emitted intent:select without core routing, we can still respond:
      // We only react if flow:route is not emitted (rare).
      try {
        if (!evt || evt.intent !== INTENT) return;

        // If core will route, do nothing
        // If somehow flow.intent is not set, route ourselves:
        if (!api.state || !api.state.flow || api.state.flow.intent !== INTENT) {
          api.emit('flow:route', {
            intent: INTENT,
            payload: evt.payload || {},
            routeId: evt.routeId || null,
            source: 'styling-fallback'
          });
        }
      } catch (e) {}
    }

    api.on('intent:select', onIntentSelect);

    /* ============================================================
       RESUME GUARD
       ------------------------------------------------------------
       If the module is marked active but the user returns later,
       we do NOT auto-resume mid-step. We ensure the entry is visible.
    ============================================================ */

    function resumeGuard() {
      try {
        // If styling is active but not currently the routed intent, release ownership.
        if (STATE.active && api && api.state && api.state.flow && api.state.flow.intent !== INTENT) {
          releaseFlowOwnership();
          persistToStore();
        }

        // If styling is the active intent but UI is missing, re-render context step.
        if (
          STATE.active &&
          api &&
          api.state &&
          api.state.flow &&
          api.state.flow.intent === INTENT &&
          api.state.inputLocked &&
          !document.querySelector('.dl-copilot-pillgroup')
        ) {
          // Safe re-entry: reset and render context.
          clearForNewRun();
          setFlow(INTENT, 'context', api.state.flow.payload || {});
          renderContextStep();
        }
      } catch (e) {}
    }

    resumeGuard();

    /* ============================================================
       END MODULE
    ============================================================ */
  });

})();

