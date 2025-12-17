/* ============================================================
   DL CO-PILOT — ORDER FLOW (FLOW 3)
   File: assets/dl-copilot-order.js

   Responsibilities:
   - Order status
   - Track shipment
   - Shipping policy
   - Returns / refunds (MTO-aware)
   - No exchanges
   - Shopify-compliant, no external APIs (v1)
============================================================ */

(function () {
  'use strict';

  /* ============================================================
     PUBLIC GUARD
  ============================================================ */

  if (window.DLCopilotOrder && window.DLCopilotOrder.__v === 1) {
    return;
  }

  window.DLCopilotOrder = {
    __v: 1,
    start: startOrderFlow
  };

  /* ============================================================
     HARD DEPENDENCIES (FAIL FAST)
  ============================================================ */

  function assertDeps() {
    if (!window.DLCopilotCore) {
      throw new Error('DLCopilotCore missing');
    }
    if (!window.DLCopilotPolicies) {
      throw new Error('DLCopilotPolicies missing');
    }
  }

  /* ============================================================
     INTERNAL STATE (ISOLATED)
  ============================================================ */

  var state = {
    step: 'idle',
    order_number: null
  };

  function resetState() {
    state.step = 'idle';
    state.order_number = null;
  }

  /* ============================================================
     ENTRY POINT
  ============================================================ */

  function startOrderFlow() {
    assertDeps();
    resetState();
    state.step = 'entry';

    return {
      type: 'pills',
      message: 'How can I help with your order?',
      options: [
        {
          label: 'Order status',
          onSelect: function () {
            return askForOrderNumber();
          }
        },
        {
          label: 'Track my order',
          onSelect: function () {
            return askForOrderNumber();
          }
        },
        {
          label: 'Shipping information',
          onSelect: function () {
            return showShippingPolicy();
          }
        },
        {
          label: 'Returns & refunds',
          onSelect: function () {
            return showReturnPolicy();
          }
        },
        {
          label: 'Back to main options',
          onSelect: function () {
            return window.DLCopilotCore.restart();
          }
        }
      ]
    };
  }

  /* ============================================================
     ORDER NUMBER FLOW
  ============================================================ */

  function askForOrderNumber() {
    state.step = 'await_order_number';

    return {
      type: 'input',
      message:
        'Please enter your order number.<br>' +
        '<span style="opacity:.7">You can find it in your confirmation email.</span>',
      placeholder: 'e.g. DL-10234',
      onSubmit: function (value) {
        return handleOrderNumber(value);
      },
      actions: [
        {
          label: 'Back',
          onClick: function () {
            return startOrderFlow();
          }
        }
      ]
    };
  }

  function handleOrderNumber(value) {
    var v = safeString(value).trim();

    if (!v) {
      return {
        type: 'message',
        message: 'Please enter a valid order number.',
        next: function () {
          return askForOrderNumber();
        }
      };
    }

    state.order_number = v;
    state.step = 'order_entered';

    // v1: no API lookup — guide user instead
    return {
      type: 'message',
      message:
        'Thanks. I’ve noted order <strong>' +
        escapeHtml(v) +
        '</strong>.<br><br>' +
        'Here’s what I can help you with:',
      actions: [
        {
          label: 'View order status',
          onClick: function () {
            return showOrderStatusInfo();
          }
        },
        {
          label: 'Track shipment',
          onClick: function () {
            return showTrackingInfo();
          }
        },
        {
          label: 'Shipping information',
          onClick: function () {
            return showShippingPolicy();
          }
        },
        {
          label: 'Returns & refunds',
          onClick: function () {
            return showReturnPolicy();
          }
        },
        {
          label: 'Back to main options',
          onClick: function () {
            return window.DLCopilotCore.restart();
          }
        }
      ]
    };
  }

  /* ============================================================
     ORDER STATUS (NO API)
  ============================================================ */

  function showOrderStatusInfo() {
    state.step = 'order_status';

    return {
      type: 'message',
      message:
        '<strong>Order status</strong><br><br>' +
        'All Drape Layers pieces are made to order.<br>' +
        'This means your order goes through the following stages:' +
        '<ul>' +
        '<li>Order confirmed</li>' +
        '<li>Pattern & material allocation</li>' +
        '<li>Production</li>' +
        '<li>Final quality control</li>' +
        '<li>Shipment</li>' +
        '</ul>' +
        'You will receive email updates as your order progresses.',
      actions: [
        {
          label: 'Track shipment',
          onClick: function () {
            return showTrackingInfo();
          }
        },
        {
          label: 'Shipping information',
          onClick: function () {
            return showShippingPolicy();
          }
        },
        {
          label: 'Back',
          onClick: function () {
            return startOrderFlow();
          }
        }
      ]
    };
  }

  /* ============================================================
     TRACKING (NO API)
  ============================================================ */

  function showTrackingInfo() {
    state.step = 'tracking';

    return {
      type: 'message',
      message:
        '<strong>Tracking your order</strong><br><br>' +
        'Once your order has shipped, you will receive a shipping confirmation email with:' +
        '<ul>' +
        '<li>Your tracking number</li>' +
        '<li>The courier used</li>' +
        '<li>A direct tracking link</li>' +
        '</ul>' +
        'If you haven’t received this yet, your order is still in production.',
      actions: [
        {
          label: 'Shipping information',
          onClick: function () {
            return showShippingPolicy();
          }
        },
        {
          label: 'Back',
          onClick: function () {
            return startOrderFlow();
          }
        }
      ]
    };
  }

  /* ============================================================
     SHIPPING POLICY (FROM SHOPIFY POLICIES)
  ============================================================ */

  function showShippingPolicy() {
    state.step = 'shipping_policy';

    var policy = window.DLCopilotPolicies.getShippingPolicy();

    return {
      type: 'policy',
      title: 'Shipping information',
      content: policy || defaultShippingFallback(),
      actions: [
        {
          label: 'Back',
          onClick: function () {
            return startOrderFlow();
          }
        }
      ]
    };
  }

  function defaultShippingFallback() {
    return (
      '<p>Delivery times vary depending on product and destination.</p>' +
      '<p>All orders are shipped once production is completed.</p>'
    );
  }

  /* ============================================================
     RETURNS & REFUNDS (MTO)
  ============================================================ */

  function showReturnPolicy() {
    state.step = 'return_policy';

    var policy = window.DLCopilotPolicies.getReturnPolicy();

    return {
      type: 'policy',
      title: 'Returns & refunds',
      content:
        policy ||
        defaultReturnFallback(),
      actions: [
        {
          label: 'How to request a refund',
          onClick: function () {
            return showRefundInstructions();
          }
        },
        {
          label: 'Back',
          onClick: function () {
            return startOrderFlow();
          }
        }
      ]
    };
  }

  function defaultReturnFallback() {
    return (
      '<p>All Drape Layers garments are made to order.</p>' +
      '<p>We do not offer exchanges.</p>' +
      '<p>Refund requests can be submitted in accordance with our return policy.</p>'
    );
  }

  function showRefundInstructions() {
    state.step = 'refund_instructions';

    return {
      type: 'message',
      message:
        '<strong>Requesting a refund</strong><br><br>' +
        'To request a refund, please contact our support team and include:' +
        '<ul>' +
        '<li>Your order number</li>' +
        '<li>The reason for the request</li>' +
        '</ul>' +
        'Each request is reviewed individually.',
      actions: [
        {
          label: 'Back to returns',
          onClick: function () {
            return showReturnPolicy();
          }
        },
        {
          label: 'Back to main options',
          onClick: function () {
            return window.DLCopilotCore.restart();
          }
        }
      ]
    };
  }

  /* ============================================================
     UTILITIES
  ============================================================ */

  function safeString(v) {
    return typeof v === 'string' ? v : '';
  }

  function escapeHtml(str) {
    return safeString(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
})();
/* ============================================================
   DL CO-PILOT — ORDER FLOW (FLOW 3)
   PART 2 — POLICY ADAPTERS, AI HOOKS, SAFETY, DEBUG
============================================================ */

(function () {
  'use strict';

  /* ============================================================
     HARD GUARD — PART 2 MUST LOAD AFTER PART 1
  ============================================================ */

  if (!window.DLCopilotOrder || window.DLCopilotOrder.__v !== 1) {
    throw new Error('DLCopilotOrder Part 1 must be loaded first');
  }

  /* ============================================================
     POLICY ADAPTER (SHOPIFY-SAFE)
     This layer isolates Shopify policy access
     so logic never breaks if policies are empty.
  ============================================================ */

  if (!window.DLCopilotPolicies) {
    window.DLCopilotPolicies = {};
  }

  /* ------------------------------------------------------------
     SHIPPING POLICY
  ------------------------------------------------------------ */

  window.DLCopilotPolicies.getShippingPolicy = function () {
    var el = document.getElementById('DLCopilotShippingPolicy');

    if (el && el.innerHTML.trim().length) {
      return el.innerHTML;
    }

    return null;
  };

  /* ------------------------------------------------------------
     RETURN / REFUND POLICY
  ------------------------------------------------------------ */

  window.DLCopilotPolicies.getReturnPolicy = function () {
    var el = document.getElementById('DLCopilotReturnPolicy');

    if (el && el.innerHTML.trim().length) {
      return el.innerHTML;
    }

    return null;
  };

  /* ============================================================
     AI HANDOFF CONTRACT (FUTURE)
     — NO API CALLS
     — JUST CONTEXT PAYLOAD
  ============================================================ */

  window.DLCopilotOrder.exportContext = function () {
    return {
      flow: 'order',
      step: getInternalStep(),
      order_number: getOrderNumber(),
      timestamp: Date.now()
    };
  };

  function getInternalStep() {
    try {
      return window.DLCopilotCore.getState().step || null;
    } catch (e) {
      return null;
    }
  }

  function getOrderNumber() {
    try {
      return window.DLCopilotCore.getState().order_number || null;
    } catch (e) {
      return null;
    }
  }

  /* ============================================================
     CORE REGISTRATION
     Makes flow discoverable by the core router
  ============================================================ */

  if (window.DLCopilotCore && typeof window.DLCopilotCore.registerFlow === 'function') {
    window.DLCopilotCore.registerFlow('order_support', {
      label: 'Help with my order',
      start: window.DLCopilotOrder.start,
      priority: 30
    });
  }

  /* ============================================================
     SAFETY — HARD EXIT GUARANTEE
     Ensures user can ALWAYS escape the flow
  ============================================================ */

  window.DLCopilotOrder.forceExit = function () {
    return window.DLCopilotCore.restart();
  };

  /* ============================================================
     DEBUG MODE (NON-PRODUCTION)
     Toggle via: window.DL_COPILOT_DEBUG = true
  ============================================================ */

  function debugLog() {
    if (!window.DL_COPILOT_DEBUG) return;
    try {
      console.log.apply(console, arguments);
    } catch (e) {}
  }

  debugLog('[DL Copilot] Order flow loaded');

  /* ============================================================
     FALLBACK UI — IF CORE FAILS
     (Never breaks storefront)
  ============================================================ */

  if (!window.DLCopilotCore) {
    document.addEventListener('DOMContentLoaded', function () {
      var fallback = document.createElement('div');
      fallback.style.display = 'none';
      fallback.innerHTML = 'Copilot unavailable';
      document.body.appendChild(fallback);
    });
  }

})();

