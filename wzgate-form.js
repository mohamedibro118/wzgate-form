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
 * WhatsApp click codes (v1.1.0, optional — needs data-api on the tag):
 *   <script src=".../wzgate-form.js" data-api="https://crm.example.com/api"
 *           data-site="my-site" data-key="pk_..." defer></script>
 *   - Keeps the visit's click ids (gclid, gbraid, wbraid, fbclid) and UTMs,
 *     asks the CRM for a short code on the visitor's first interaction, and
 *     appends it to the pre-filled text of every WhatsApp link on the page.
 *   - Without data-api none of this runs and the form behaviour is unchanged.
 *   See README.md, "WhatsApp click codes".
 *
 * Zero dependencies. Safe to load with defer or async, and safe to include twice.
 */
(function () {
  'use strict';

  var VERSION = '1.1.0';
  // Included twice (two snippets, a tag manager and a theme): the first copy
  // owns the page. A v1 copy has no `version`, so this one takes over from it.
  if (window.WzgateForm && window.WzgateForm.version) return;

  // Only valid while the script itself is executing, so it is read here and
  // not inside init(), which may run later on DOMContentLoaded.
  var CURRENT_SCRIPT = document.currentScript || null;

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

  // Reading `window.localStorage` itself throws when site data is blocked, so
  // the stores are looked up inside a try and may be null.
  function getStore(name) {
    try {
      return window[name] || null;
    } catch (e) {
      return null;
    }
  }
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
    var localStorage = getStore('localStorage');
    var sessionStorage = getStore('sessionStorage');
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
    var el = CURRENT_SCRIPT ||
      document.querySelector('script[data-token][data-endpoint]') ||
      document.querySelector('script[data-token]') ||
      document.querySelector('script[data-api]');
    if (!el) return { token: null, endpoint: null, api: null, forms: false };
    return {
      token: el.getAttribute('data-token'),
      endpoint: el.getAttribute('data-endpoint'),
      // WhatsApp click codes — all optional, see createWhatsApp().
      api: el.getAttribute('data-api'),
      site: el.getAttribute('data-site'),
      key: el.getAttribute('data-key'),
      locale: el.getAttribute('data-locale'),
      // The tag was evidently meant to capture forms.
      forms: el.hasAttribute('data-token') || el.hasAttribute('data-endpoint')
    };
  }

  function nowIso() {
    // Date is fine in the browser at runtime.
    return new Date().toISOString();
  }

  /* ------------------------------------------------------------------ *
   * WhatsApp click codes
   *
   * A short code ties this web visit to the WhatsApp message that follows
   * it. The CRM issues the code (POST {api}/public/click-codes); this part
   * puts it into the pre-filled text of the page's WhatsApp links and tells
   * the CRM when one of them is pressed.
   *
   * Rules it keeps:
   *   - nothing is requested on load — only on the first real interaction;
   *   - the link always opens: a slow, failing or disabled endpoint leaves
   *     every link exactly as the page wrote it;
   *   - nothing is written to storage until the CRM has said tracking is on
   *     and, where the site asks for it, the visitor has consented.
   * ------------------------------------------------------------------ */

  var WA_KEY = 'wz_wa';                       // localStorage: the visit (see `data` below)
  var WA_CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid'];
  var WA_CODE = /^[A-Za-z0-9]{5}$/;
  var WA_VISITOR = /^[A-Za-z0-9_-]{16,64}$/;  // the CRM's own rule for anonymousVisitorId
  // What we append, and therefore what we may remove again.
  var WA_OUR_SUFFIX = /\s*\(ref: [A-Za-z0-9]{5}\)\s*$/;
  // The CRM's matcher (click-code.extractor.ts REF_TOKEN) without its
  // lookbehind, which older Safari cannot even parse.
  var WA_REF_TOKEN = /(^|[^A-Za-z0-9])ref\s*[:：\-–=#]?\s*([A-Za-z0-9]{5})(?![A-Za-z0-9])/gi;
  var WA_PATH_LINK = /^(?:https?:)?\/\/(?:www\.)?wa\.me\/(?:\+|%2B)?\d{5,}\/?$/i;
  var WA_SEND_LINK = /^(?:(?:https?:)?\/\/(?:api|web|www)\.whatsapp\.com|whatsapp:\/\/)\/?send\/?$/i;
  var WA_HOLD_MS = 300;                       // the longest a tap may wait for its code
  var WA_FRESH_MS = 10 * 60 * 1000;           // a cached answer younger than this is not re-asked
  var WA_RESCAN_MS = 80;                      // MutationObserver debounce
  var WA_LIMITS = { id: 512, utm: 255, url: 2048 };

  function waCap(value, max) {
    return typeof value === 'string' && value ? value.slice(0, max) : '';
  }

  /** `https://crm.example.com`, `…/api`, `…/api/` → `https://crm.example.com/api`. */
  function waApiBase(raw) {
    var base = String(raw || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    if (!base) return '';
    return /\/api$/i.test(base) ? base : base + '/api';
  }

  /** Click ids + UTMs of a URL, capped to what the CRM accepts. */
  function waParseLanding(href) {
    var ids = {};
    var utm = {};
    try {
      var u = new URL(href);
      WA_CLICK_IDS.forEach(function (name) {
        var v = waCap(u.searchParams.get(name), WA_LIMITS.id);
        if (v) ids[name] = v;
      });
      Object.keys(UTM_PARAMS).forEach(function (param) {
        var v = waCap(u.searchParams.get(param), WA_LIMITS.utm);
        if (v) utm[UTM_PARAMS[param]] = v;
      });
    } catch (e) {
      /* malformed URL → nothing captured */
    }
    return { ids: ids, utm: utm };
  }

  function waNewVisitorId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var bytes = null;
    try {
      bytes = new Uint8Array(24);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
    } catch (e) {
      bytes = null;
    }
    var out = '';
    for (var i = 0; i < 24; i++) {
      out += chars.charAt((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % chars.length);
    }
    return out;
  }

  function waDigits(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
  }

  function waDecode(value) {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  }

  /**
   * A WhatsApp CHAT link, split so its text can be replaced and everything
   * else kept byte for byte. Null for anything else — including WhatsApp
   * links with no phone number (`api.whatsapp.com/send?text=…` is a "share
   * with a friend" link; a code there would go to the wrong person) and
   * `wa.me/message/…` / `wa.me/qr/…` short links, which take no text.
   */
  function waSplitHref(href) {
    if (typeof href !== 'string' || !href) return null;
    var hashAt = href.indexOf('#');
    var hash = hashAt >= 0 ? href.slice(hashAt) : '';
    var rest = hashAt >= 0 ? href.slice(0, hashAt) : href;
    var queryAt = rest.indexOf('?');
    var head = (queryAt >= 0 ? rest.slice(0, queryAt) : rest).replace(/^\s+/, '');
    var params = queryAt >= 0 && rest.length > queryAt + 1 ? rest.slice(queryAt + 1).split('&') : [];

    var inPath = WA_PATH_LINK.test(head);
    if (!inPath && !WA_SEND_LINK.test(head)) return null;

    var textAt = -1;
    var text = '';
    var hasPhone = inPath;
    try {
      for (var i = 0; i < params.length; i++) {
        var eq = params[i].indexOf('=');
        var name = waDecode(eq >= 0 ? params[i].slice(0, eq) : params[i]).toLowerCase();
        var value = eq >= 0 ? params[i].slice(eq + 1) : '';
        if (name === 'text' && textAt < 0) {
          textAt = i;
          text = waDecode(value);
        } else if (name === 'phone' && waDigits(waDecode(value)).length >= 5) {
          hasPhone = true;
        }
      }
    } catch (e) {
      return null; // malformed escapes — leave the link alone
    }
    if (!hasPhone) return null;
    return { head: head, params: params, textAt: textAt, text: text, hash: hash };
  }

  function waIsChatHref(href) {
    return waSplitHref(href) !== null;
  }

  /** True when the CRM's matcher would read `code` out of `text`. */
  function waCarries(text, code) {
    var wanted = String(code).toUpperCase();
    var match;
    WA_REF_TOKEN.lastIndex = 0;
    while ((match = WA_REF_TOKEN.exec(text))) {
      if (match[2].toUpperCase() === wanted) return true;
    }
    return false;
  }

  /**
   * The message a link should pre-fill.
   *   - the link's own text, with ` (ref: CODE)` after it (an older code of
   *     ours is replaced, the same code is never added twice);
   *   - or, with no text of its own, the site's template.
   */
  function waCompose(text, code, template) {
    var own = String(text || '').replace(WA_OUR_SUFFIX, '').replace(/\s+$/, '');
    var tag = '(ref: ' + code + ')';
    if (!own) {
      var filled = typeof template === 'string' && template ? template.split('{code}').join(code) : tag;
      // A template without a readable code would be a message nobody can match.
      return waCarries(filled, code) ? filled : filled.replace(/\s+$/, '') + ' ' + tag;
    }
    if (waCarries(own, code)) return own;
    return own + (own.indexOf('\n') >= 0 ? '\n' : ' ') + tag;
  }

  /** `href` with the code in its text; `href` itself when it is not a chat link. */
  function waRewriteHref(href, code, template) {
    var parts = waSplitHref(href);
    if (!parts || !WA_CODE.test(String(code || ''))) return href;
    var param = 'text=' + encodeURIComponent(waCompose(parts.text, code, template));
    var params = parts.params.slice();
    if (parts.textAt >= 0) params[parts.textAt] = param;
    else params.push(param);
    return parts.head + '?' + params.join('&') + parts.hash;
  }

  function createWhatsApp() {
    var cfg = null;          // { api, headers, locale, onState, seed }
    var started = false;
    // The visit. Persisted (WA_KEY) only once that is allowed — see canPersist().
    //   v visitor id · ids click ids · utm · lu landing URL · rf referrer · seen
    //   c code · x expiresAt · n whatsappNumber · t messageTemplate · l its locale
    //   at when the CRM last answered · rc the CRM's requireConsent · k consent given
    var data = {};
    var ready = false;       // a live code is on (or ready to go on) the links
    var off = false;         // the CRM said tracking is off for this site
    var refused = false;     // the visitor said no: wzstate.consent(false)
    var awaiting = false;    // the CRM wants consent first
    var failed = false;      // the request failed: asked once, not again on this page
    var interacted = false;
    var inflight = null;
    var lastSentConsent = false;
    var clickedFor = null;   // the code whose click was already reported on this page
    var observer = null;
    var rescanTimer = null;
    var halted = false;      // stop() is putting the page back
    var listeners = [];
    // Navigation goes through here so it can be observed in tests.
    var nav = {
      open: function (url, target) {
        if (!target || target === '_self') {
          window.location.href = url;
          return;
        }
        var win = null;
        try {
          win = window.open(url, target);
        } catch (e) {
          win = null;
        }
        if (win) {
          try { win.opener = null; } catch (e) { /* cross-origin already */ }
        } else {
          window.location.href = url; // pop-up blocked — the chat still opens
        }
      }
    };

    function now() {
      return new Date().getTime();
    }

    function canPersist() {
      return !refused && (data.k === true || data.rc === false);
    }
    function persist() {
      if (canPersist()) safeSet(getStore('localStorage'), WA_KEY, data);
    }
    function forget() {
      try {
        getStore('localStorage').removeItem(WA_KEY);
      } catch (e) {
        /* nothing stored, or storage blocked */
      }
    }

    function notify(reason) {
      if (!cfg || typeof cfg.onState !== 'function') return;
      try {
        cfg.onState({ code: data.c || null, anonymousVisitorId: data.v || null, expiresAt: data.x || null }, reason);
      } catch (e) {
        /* the host's callback is the host's problem */
      }
    }

    function locale() {
      var raw = (cfg && cfg.locale) || '';
      if (!raw) {
        try { raw = document.documentElement.getAttribute('lang') || ''; } catch (e) { raw = ''; }
      }
      raw = String(raw).toLowerCase();
      if (raw.indexOf('ar') === 0) return 'ar';
      if (raw.indexOf('en') === 0) return 'en';
      return '';
    }

    function liveCode() {
      if (!WA_CODE.test(String(data.c || ''))) return false;
      var expires = Date.parse(data.x);
      return !isNaN(expires) && expires > now();
    }

    /** First sight of the visit, or a new ad click: keep what the URL says. */
    function capture() {
      var parsed = waParseLanding(location.href);
      var stored = data.ids || {};
      var newAdClick = WA_CLICK_IDS.some(function (name) {
        return parsed.ids[name] && parsed.ids[name] !== stored[name];
      });
      if (data.seen && !newAdClick) return false;
      data.ids = parsed.ids;
      data.utm = parsed.utm;
      data.lu = waCap(baseUrl(location.href), WA_LIMITS.url);
      data.rf = waCap(document.referrer || '', WA_LIMITS.url);
      data.seen = 1;
      return newAdClick;
    }

    function load() {
      var stored = safeGet(getStore('localStorage'), WA_KEY);
      data = stored && typeof stored === 'object' ? stored : {};
      if (refused) data.k = false;
      else if (pendingConsent) data.k = true;

      // The host may know the code better than script-written storage does
      // (a first-party cookie its own server set).
      var seed = cfg && cfg.seed;
      if (!WA_VISITOR.test(String(data.v || '')) && seed && WA_VISITOR.test(String(seed.anonymousVisitorId || ''))) {
        data.v = seed.anonymousVisitorId;
        if (WA_CODE.test(String(seed.code || ''))) data.c = seed.code;
      }
      if (!WA_VISITOR.test(String(data.v || ''))) data.v = waNewVisitorId();

      var newAdClick = capture();
      ready = !newAdClick && liveCode() && typeof data.t === 'string';
      if (newAdClick || (data.l || '') !== locale()) data.at = 0; // ask again
      persist();
    }

    /* ---------------- links ---------------- */

    function isLinkElement(el) {
      return el.tagName === 'A' || el.tagName === 'AREA';
    }

    /** What `el` should point at now; `base` (its own value) when we have nothing to add. */
    function compute(el, base) {
      var mark = el.getAttribute('data-wz-whatsapp');
      if (halted || (mark !== null && mark.toLowerCase() === 'off')) return base;
      var target = base;
      if (!waIsChatHref(base)) {
        if (mark === null) return base;
        // A marked element with no WhatsApp link of its own: build one.
        var number = waDigits(mark) || waDigits(data.n);
        if (number.length < 5) return base;
        target = 'https://wa.me/' + number;
      }
      return ready ? waRewriteHref(target, data.c, data.t) : target;
    }

    function applyTo(el) {
      var link = isLinkElement(el);
      var current = link ? el.getAttribute('href') : null;
      var rec = el.__wzWa;
      // The page (or its framework) rewrote the link since we last did: what
      // is there now is the new original.
      if (!rec || (link && current !== rec.applied)) rec = el.__wzWa = { orig: current, applied: current, url: null };
      var next = compute(el, rec.orig);
      if (!link) {
        rec.url = next;
        return;
      }
      if (next !== current) {
        if (next === null) el.removeAttribute('href');
        else el.setAttribute('href', next);
      }
      rec.applied = next;
      rec.url = next;
    }

    function scan() {
      if (!started) return;
      try {
        var nodes = document.querySelectorAll('a[href], area[href], [data-wz-whatsapp]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          if (el.__wzWa || el.hasAttribute('data-wz-whatsapp') || waIsChatHref(el.getAttribute('href'))) applyTo(el);
        }
      } catch (e) {
        /* a hostile DOM must not break the page */
      }
      // Our own edits are not news: drop them so the observer cannot loop.
      if (observer) {
        try { observer.takeRecords(); } catch (e) { /* ignore */ }
      }
    }

    function scheduleScan() {
      if (rescanTimer) return;
      rescanTimer = setTimeout(function () {
        rescanTimer = null;
        scan();
      }, WA_RESCAN_MS);
    }

    function observe() {
      if (observer || typeof MutationObserver !== 'function') return;
      try {
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['href', 'data-wz-whatsapp']
        });
      } catch (e) {
        observer = null;
      }
    }

    /* ---------------- the CRM ---------------- */

    function headers(json) {
      var out = {};
      var extra = (cfg && cfg.headers) || {};
      Object.keys(extra).forEach(function (name) {
        if (extra[name]) out[name] = extra[name];
      });
      if (json) out['Content-Type'] = 'application/json';
      return out;
    }

    function body() {
      var out = { anonymousVisitorId: data.v };
      if (WA_CODE.test(String(data.c || ''))) out.code = data.c;
      var ids = data.ids || {};
      WA_CLICK_IDS.forEach(function (name) {
        var v = waCap(ids[name], WA_LIMITS.id);
        if (v) out[name] = v;
      });
      var utm = data.utm || {};
      Object.keys(UTM_PARAMS).forEach(function (param) {
        var v = waCap(utm[UTM_PARAMS[param]], WA_LIMITS.utm);
        if (v) out[UTM_PARAMS[param]] = v;
      });
      if (data.lu) out.landingUrl = waCap(data.lu, WA_LIMITS.url);
      if (data.rf) out.referrer = waCap(data.rf, WA_LIMITS.url);
      var lang = locale();
      if (lang) out.locale = lang;
      if (data.k === true) out.consent = true;
      return out;
    }

    function turnOff() {
      off = true;
      ready = false;
      awaiting = false;
      data.c = null;
      data.x = null;
      data.n = null;
      data.t = null;
      forget();
      scan();
      notify('cleared');
    }

    function handle(answer) {
      var d = answer && typeof answer === 'object' && answer.data && typeof answer.data === 'object' ? answer.data : answer;
      if (refused) return;
      if (!d || d.enabled !== true) {
        turnOff();
        return;
      }
      off = false;
      data.rc = d.requireConsent === true;
      data.n = typeof d.whatsappNumber === 'string' ? d.whatsappNumber : null;

      if (typeof d.code === 'string' && WA_CODE.test(d.code)) {
        awaiting = false;
        data.c = d.code; // always the answer's code: the CRM may have issued a new one
        data.x = d.expiresAt || null;
        data.t = typeof d.messageTemplate === 'string' ? d.messageTemplate : '';
        data.l = locale();
        data.at = now();
        ready = true;
        persist();
        scan();
        notify('issued');
        return;
      }

      // Tracking is on but the site waits for the visitor's consent: nothing
      // was stored on the server, and nothing is kept here either.
      ready = false;
      awaiting = true;
      data.c = null;
      data.x = null;
      data.t = null;
      if (!canPersist()) forget();
      scan();
    }

    function request() {
      if (inflight || refused || !started || typeof fetch !== 'function') return inflight;
      var sentConsent = data.k === true;
      lastSentConsent = sentConsent;
      var call;
      try {
        call = fetch(cfg.api + '/public/click-codes', {
          method: 'POST',
          headers: headers(true),
          body: JSON.stringify(body())
        });
      } catch (e) {
        call = Promise.reject(e);
      }
      inflight = Promise.resolve(call)
        .then(function (res) {
          if (!res || !res.ok) throw new Error('click-codes ' + (res && res.status));
          return res.json();
        })
        .then(handle)
        .catch(function () {
          // Endpoint down or refusing: the links stay as they are, and the
          // next tap is not made to wait for a second attempt.
          failed = true;
        })
        .then(function () {
          inflight = null;
          // Consent arrived while the unconsented request was in the air.
          if (awaiting && data.k === true && !sentConsent && !refused) request();
        });
      return inflight;
    }

    /** The first real interaction (or a tap that came first). */
    function kick() {
      if (!started || refused) return;
      if (!interacted) {
        interacted = true;
        unlisten('interaction');
      }
      if (inflight || off || awaiting || failed) return;
      if (ready && now() - (data.at || 0) < WA_FRESH_MS) return;
      request();
    }

    function reportClick() {
      if (!ready || !data.c || clickedFor === data.c) return;
      clickedFor = data.c;
      try {
        // Not awaited, and `keepalive` so it survives the page being left.
        // (sendBeacon cannot carry the X-Api-Key header.)
        var sent = fetch(cfg.api + '/public/click-codes/' + encodeURIComponent(data.c) + '/clicked', {
          method: 'POST',
          keepalive: true,
          headers: headers(false)
        });
        if (sent && typeof sent.catch === 'function') sent.catch(function () {});
      } catch (e) {
        /* never in the way of the tap */
      }
      notify('clicked');
    }

    /* ---------------- events ---------------- */

    function listen(group, target, type, handler, options) {
      try {
        target.addEventListener(type, handler, options);
        listeners.push({ group: group, target: target, type: type, handler: handler, options: options });
      } catch (e) {
        /* ignore */
      }
    }
    function unlisten(group) {
      listeners = listeners.filter(function (l) {
        if (group && l.group !== group) return true;
        try { l.target.removeEventListener(l.type, l.handler, l.options); } catch (e) { /* ignore */ }
        return false;
      });
    }

    function whatsappTarget(node) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!el || typeof el.closest !== 'function') return null;
      el = el.closest('a[href], area[href], [data-wz-whatsapp]');
      if (!el) return null;
      var mark = el.getAttribute('data-wz-whatsapp');
      if (mark !== null) return mark.toLowerCase() === 'off' ? null : el;
      return waIsChatHref(el.getAttribute('href')) ? el : null;
    }

    function openFor(el) {
      applyTo(el);
      var rec = el.__wzWa;
      if (!rec || !rec.url) return false;
      // A link keeps its own target; a button or div has none, so a new tab.
      nav.open(rec.url, isLinkElement(el) ? el.getAttribute('target') : el.getAttribute('data-wz-target') || '_blank');
      return true;
    }

    function onClick(event) {
      var el = null;
      var held = false;
      try {
        if (event.type === 'auxclick' && event.button !== 1) return; // only a middle click opens a link
        el = whatsappTarget(event.target);
        if (!el) return;
        kick(); // the tap may be the visitor's very first action

        var plain = event.type === 'click' && !event.button &&
          !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
        // An element with no href of its own has nothing native to fall back
        // on: this script is what opens it.
        var scripted = !isLinkElement(el) || !el.getAttribute('href');
        var waitable = plain && !ready && !off && !awaiting && !!inflight;

        if (!waitable) {
          reportClick();
          if (scripted && plain && openFor(el)) event.preventDefault();
          return; // a real link opens natively, untouched by us
        }

        // The code is on its way. Hold the tap for at most WA_HOLD_MS, then
        // open the chat — with the code if it arrived, without it if not.
        event.preventDefault();
        held = true;
        var done = false;
        var go = function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            reportClick();
            openFor(el);
          } catch (e) {
            /* nothing more we can do */
          }
        };
        var timer = setTimeout(function () {
          // Out of patience. Only an element that has nowhere to go without
          // the CRM's number keeps waiting for the answer itself.
          applyTo(el);
          if (!scripted || (el.__wzWa && el.__wzWa.url)) go();
        }, WA_HOLD_MS);
        inflight.then(go, go);
      } catch (e) {
        if (held && el) {
          try { openFor(el); } catch (e2) { /* ignore */ }
        }
      }
    }

    function onHover(event) {
      try {
        if (whatsappTarget(event.target)) kick(); // about to tap: ask now
      } catch (e) {
        /* ignore */
      }
    }

    /* ---------------- public ---------------- */

    var pendingConsent = false; // consent(true) called before start()

    function start(config) {
      try {
        var api = waApiBase(config && config.api);
        if (!api) return false;
        var extra = {};
        if (config.site) extra['X-Site'] = config.site;
        if (config.key) extra['X-Api-Key'] = config.key;
        Object.keys(config.headers || {}).forEach(function (name) { extra[name] = config.headers[name]; });
        var next = { api: api, headers: extra, locale: config.locale || '', onState: config.onState, seed: config.seed };

        if (started) {
          // Called again (a re-render, a locale switch): same visit, new settings.
          var changed = (next.locale || '') !== (cfg.locale || '');
          cfg = next;
          if (changed) {
            data.at = 0;
            if (interacted && !inflight && !off && !awaiting && !refused) request();
          }
          return true;
        }

        cfg = next;
        started = true;
        load();
        observe();
        if (ready) scan(); // a code from an earlier page of this visit: no request needed

        var passive = { capture: true, passive: true };
        ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'scroll'].forEach(function (type) {
          listen('interaction', window, type, kick, passive);
        });
        listen('interaction', document, 'mouseover', onHover, passive);
        listen('click', document, 'click', onClick, true);
        listen('click', document, 'auxclick', onClick, true);
        return true;
      } catch (e) {
        return false;
      }
    }

    /** Undo everything: links back to how the page wrote them, listeners gone. */
    function stop() {
      try {
        halted = true;
        scan();
        var nodes = document.querySelectorAll('a, area, [data-wz-whatsapp]');
        for (var i = 0; i < nodes.length; i++) {
          try { delete nodes[i].__wzWa; } catch (e) { nodes[i].__wzWa = undefined; }
        }
      } catch (e) {
        /* ignore */
      }
      unlisten();
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        observer = null;
      }
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = null;
      started = false;
      halted = false;
      cfg = null;
      data = {};
      off = refused = awaiting = failed = interacted = lastSentConsent = pendingConsent = false;
      inflight = null;
      clickedFor = null;
    }

    /**
     * `wzstate.consent(true)`  — the visitor agreed: ask for the code (with
     *                            `consent: true`) and keep the visit.
     * `wzstate.consent(false)` — the visitor declined: forget everything
     *                            stored, restore the links, ask for nothing.
     */
    function consent(value) {
      try {
        if (value === true) {
          refused = false;
          pendingConsent = true;
          data.k = true;
          if (!started) return;
          if (!WA_VISITOR.test(String(data.v || ''))) {
            data.v = waNewVisitorId();
            capture();
          }
          persist();
          // Agreeing to a banner is an interaction, but a banner tool also
          // replays a stored "yes" on every load — which is not. So this asks
          // only when the visitor has already interacted.
          if (!inflight && !off && (awaiting || (interacted && !ready))) {
            awaiting = false;
            request();
          }
        } else if (value === false) {
          refused = true;
          pendingConsent = false;
          awaiting = false;
          ready = false;
          data = { k: false, n: data.n || null }; // the number is the site's, not the visitor's
          forget();
          if (!started) return;
          scan();
          notify('cleared');
        }
      } catch (e) {
        /* ignore */
      }
    }

    return {
      start: start,
      stop: stop,
      consent: consent,
      rescan: scan,
      isWhatsAppHref: waIsChatHref,
      rewriteHref: waRewriteHref,
      compose: waCompose,
      apiBase: waApiBase,
      state: function () {
        return {
          started: started, ready: ready, off: off, refused: refused, awaitingConsent: awaiting,
          code: data.c || null, anonymousVisitorId: data.v || null, clickIds: data.ids || {}, utm: data.utm || {}
        };
      },
      _nav: nav
    };
  }

  function init() {
    var cfg = readScriptConfig();
    try {
      var attribution = captureAttribution(location.href, nowIso());
      var config = { token: cfg.token, endpoint: cfg.endpoint, attribution: attribution };

      var forms = document.querySelectorAll('form[data-wzgate-form]');
      for (var i = 0; i < forms.length; i++) bindForm(forms[i], config);

      if ((!cfg.token || !cfg.endpoint) && (forms.length || cfg.forms)) {
        // Misconfigured snippet — surface it for the developer, but don't throw.
        if (window.console) console.warn('[wzgate-form] missing data-token or data-endpoint; forms will not be captured.');
      }
    } catch (e) {
      /* never let form capture take the page (or the click codes below) down */
    }

    // WhatsApp click codes: inert without data-api.
    if (cfg.api) whatsapp.start({ api: cfg.api, site: cfg.site, key: cfg.key, locale: cfg.locale });
  }

  var whatsapp = createWhatsApp();

  // Expose internals for testing / advanced use.
  window.WzgateForm = {
    version: VERSION,
    parseUrl: parseUrl,
    captureAttribution: captureAttribution,
    collectFields: collectFields,
    buildBody: buildBody,
    bindForm: bindForm,
    init: init,
    whatsapp: whatsapp
  };

  // `wzstate.consent(true|false)` — the page's cookie banner calls it. An
  // existing `window.wzstate` object is kept; only `consent` is (re)defined.
  // Calls made before this script loaded are replayed from the stub's queue:
  //   window.wzstate = window.wzstate || { q: [], consent: function (v) { this.q.push(v); } };
  try {
    var ns = window.wzstate;
    if (!ns || (typeof ns !== 'object' && typeof ns !== 'function')) ns = window.wzstate = {};
    var queued = Object.prototype.toString.call(ns.q) === '[object Array]' ? ns.q.slice() : [];
    ns.consent = whatsapp.consent;
    if (queued.length) whatsapp.consent(queued[queued.length - 1]);
  } catch (e) {
    /* a frozen or hostile global: the feature simply has no consent switch */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
