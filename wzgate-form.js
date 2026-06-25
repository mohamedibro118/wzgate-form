/*!
 * wzgate-form.js — drop-in landing-page lead capture for the wzgate CRM.
 *
 * Usage (emitted by GET /integrations/website-form/:id/snippet):
 *   <script src="https://cdn.wzgate.com/wzgate-form.js"
 *           data-token="pk_..." data-endpoint="https://api.example.com/public/forms/pk_..."
 *           defer></script>
 *   <form data-wzgate-form> ... <input name="_gotcha" hidden> ... </form>
 *
 * Behavior:
 *   - On load: capture UTMs + click IDs from the URL. First-touch is written
 *     once to localStorage; last-touch is refreshed in sessionStorage on every
 *     UTM-bearing visit; click IDs merge into localStorage.
 *   - On submit of any <form data-wzgate-form>: prevent the default, gather the
 *     fields + attribution, POST JSON to data-endpoint. Progressive enhancement:
 *     if anything fails, the native submit is allowed to proceed.
 *
 * Zero dependencies. Safe to load with defer or async.
 */
(function () {
  'use strict';

  var UTM_PARAMS = {
    utm_source: 'utmSource',
    utm_medium: 'utmMedium',
    utm_campaign: 'utmCampaign',
    utm_term: 'utmTerm',
    utm_content: 'utmContent'
  };
  var FT_KEY = 'wz_ft';     // first-touch UtmSet (localStorage, write-once)
  var FTS_KEY = 'wz_fts';   // first-touch timestamp (localStorage, write-once)
  var LT_KEY = 'wz_lt';     // last-touch UtmSet (sessionStorage)
  var CI_KEY = 'wz_ci';     // click IDs (localStorage, merged)

  function safeGet(store, key) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function safeSet(store, key, value) {
    try {
      store.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage disabled / full — attribution degrades gracefully */
    }
  }

  function parseUrl(href) {
    var utm = {};
    var clickIds = {};
    try {
      var u = new URL(href);
      Object.keys(UTM_PARAMS).forEach(function (param) {
        var v = u.searchParams.get(param);
        if (v) utm[UTM_PARAMS[param]] = v;
      });
      var gclid = u.searchParams.get('gclid');
      var fbclid = u.searchParams.get('fbclid');
      if (gclid) clickIds.gclid = gclid;
      if (fbclid) clickIds.fbclid = fbclid;
    } catch (e) {
      /* malformed URL → empty capture */
    }
    return { utm: utm, clickIds: clickIds };
  }

  /** Capture attribution for the current page into storage; returns the merged view. */
  function captureAttribution(href, now) {
    var parsed = parseUrl(href);
    var hasUtm = Object.keys(parsed.utm).length > 0;

    // First touch — write once.
    var firstTouch = safeGet(localStorage, FT_KEY);
    var firstSeenAt = safeGet(localStorage, FTS_KEY);
    if (!firstSeenAt) {
      firstTouch = parsed.utm;
      firstSeenAt = now;
      safeSet(localStorage, FT_KEY, firstTouch);
      safeSet(localStorage, FTS_KEY, firstSeenAt);
    }

    // Last touch — refresh only on a UTM-bearing visit.
    var lastTouch = safeGet(sessionStorage, LT_KEY) || {};
    if (hasUtm) {
      lastTouch = parsed.utm;
      safeSet(sessionStorage, LT_KEY, lastTouch);
    }

    // Click IDs — merge.
    var clickIds = safeGet(localStorage, CI_KEY) || {};
    var mergedClickIds = {};
    Object.keys(clickIds).forEach(function (k) { mergedClickIds[k] = clickIds[k]; });
    Object.keys(parsed.clickIds).forEach(function (k) { mergedClickIds[k] = parsed.clickIds[k]; });
    if (Object.keys(parsed.clickIds).length) safeSet(localStorage, CI_KEY, mergedClickIds);

    return {
      firstTouch: firstTouch || {},
      lastTouch: lastTouch || {},
      clickIds: mergedClickIds,
      firstSeenAt: firstSeenAt || now
    };
  }

  function baseUrl(href) {
    try {
      var u = new URL(href);
      return u.origin + u.pathname;
    } catch (e) {
      return href;
    }
  }

  /** Collect named form fields into a plain object. */
  function collectFields(form) {
    var fields = {};
    var els = form.querySelectorAll('input[name], textarea[name], select[name]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name) continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      fields[el.name] = el.value;
    }
    return fields;
  }

  /** Build the JSON body the public endpoint expects. */
  function buildBody(form, attribution, href, referrer) {
    var fields = collectFields(form);
    fields.firstTouch = attribution.firstTouch;
    fields.lastTouch = attribution.lastTouch;
    fields.clickIds = attribution.clickIds;
    fields.landingPage = baseUrl(href);
    fields.referrer = referrer || '';
    return fields;
  }

  function setStatus(form, kind, message) {
    var node = form.querySelector('[data-wzgate-status]');
    if (!node) {
      node = document.createElement('div');
      node.setAttribute('data-wzgate-status', '');
      form.appendChild(node);
    }
    node.setAttribute('data-wzgate-status', kind);
    node.textContent = message;
  }

  function bindForm(form, config) {
    if (form.__wzgateBound) return;
    form.__wzgateBound = true;

    form.addEventListener('submit', function (event) {
      // Without an endpoint we cannot POST — let the native submit proceed.
      if (!config.endpoint || !config.token) return;
      event.preventDefault();

      var submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      var body = buildBody(form, config.attribution, location.href, document.referrer);

      fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (res) {
          if (res.ok) {
            setStatus(form, 'success', 'Thanks! We will be in touch shortly.');
            form.reset();
            form.dispatchEvent(new CustomEvent('wzgate:submitted', { bubbles: true, detail: { ok: true } }));
          } else {
            setStatus(form, 'error', 'Sorry, something went wrong. Please try again.');
            form.dispatchEvent(new CustomEvent('wzgate:error', { bubbles: true, detail: { status: res.status } }));
          }
        })
        .catch(function (err) {
          setStatus(form, 'error', 'Network error. Please try again.');
          form.dispatchEvent(new CustomEvent('wzgate:error', { bubbles: true, detail: { error: String(err) } }));
        })
        .then(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  function readScriptConfig() {
    var el = document.currentScript ||
      document.querySelector('script[data-token][data-endpoint]') ||
      document.querySelector('script[data-token]');
    if (!el) return { token: null, endpoint: null };
    return {
      token: el.getAttribute('data-token'),
      endpoint: el.getAttribute('data-endpoint')
    };
  }

  function nowIso() {
    // Date is fine in the browser at runtime.
    return new Date().toISOString();
  }

  function init() {
    var cfg = readScriptConfig();
    var attribution = captureAttribution(location.href, nowIso());
    var config = { token: cfg.token, endpoint: cfg.endpoint, attribution: attribution };

    var forms = document.querySelectorAll('form[data-wzgate-form]');
    for (var i = 0; i < forms.length; i++) bindForm(forms[i], config);

    if (!cfg.token || !cfg.endpoint) {
      // Misconfigured snippet — surface it for the developer, but don't throw.
      if (window.console) console.warn('[wzgate-form] missing data-token or data-endpoint; forms will not be captured.');
    }
  }

  // Expose internals for testing / advanced use.
  window.WzgateForm = {
    parseUrl: parseUrl,
    captureAttribution: captureAttribution,
    collectFields: collectFields,
    buildBody: buildBody,
    bindForm: bindForm,
    init: init
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
