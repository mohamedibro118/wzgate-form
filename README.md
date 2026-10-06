# wzgate-form.js

The drop-in browser script that powers the [landing-page form integration](../docs/integrations/landing-page-form/).
It captures UTM / first-touch / last-touch / click-IDs and POSTs form submissions to the public
ingestion endpoint. Since v1.1.0 it also carries **WhatsApp click codes** (below). Zero
dependencies, one file (~38 KB source, ~15 KB minified, ~5 KB gzipped).

- Source: `wzgate-form.js`
- Tests: `wzgate-form.test.js` (forms) and `wzgate-whatsapp.test.js` (click codes), jsdom — `npm test`
- Reference behavior also mirrored in `landing-form-demo/src/api/mock/utm-capture.ts`.

## How it's wired

The CRM emits a snippet (`GET /integrations/website-form/:id/snippet`) like:

```html
<script src="https://cdn.wzgate.com/wzgate-form.js"
        data-token="pk_..."
        data-endpoint="https://api.example.com/public/forms/pk_..."
        defer></script>
<form data-wzgate-form> … <input name="_gotcha" hidden> … </form>
```

The script reads `data-token` + `data-endpoint`, captures attribution from the page URL, binds to
every `form[data-wzgate-form]`, and on submit POSTs JSON to `data-endpoint`. See
[snippet-reference.md](../docs/integrations/landing-page-form/snippet-reference.md) for the body shape.

## WhatsApp click codes

A short code ties a web visit to the WhatsApp message that follows it, so a WhatsApp lead keeps its
real source (Google Ads, Meta, organic…) and Google can be told about a conversion only when a
message actually arrives. The CRM issues the code; this script puts it in the pre-filled message
of the page's WhatsApp links, e.g. `Hello, I would like to know more. (ref: K7Q2M)`.

### Install — landing pages

The Website Forms snippet is the install snippet. With `data-api` on it, WhatsApp tracking needs
nothing else:

```html
<script src="https://cdn.jsdelivr.net/gh/mohamedibro118/wzgate-form@stable/wzgate-form.js"
        data-token="pk_..."
        data-endpoint="https://integrations.example.com/public/forms/pk_..."
        data-api="https://crm.example.com/api"
        defer></script>
```

| Attribute | What it is |
|---|---|
| `data-token` | The Website Forms token. It also identifies the landing page to the CRM: the script sends it as `formToken` with both click-code calls, and the CRM applies that page's own templates and consent setting. |
| `data-endpoint` | Where forms post (the integration service). Unchanged. |
| `data-api` | The CRM's public base URL — `https://crm.example.com`, `…/api` and `…/api/` all work. Without it the click-code feature does not run at all. |
| `data-locale` | Optional, `ar` or `en`: the language of the pre-filled message. Defaults to the page's `<html lang>`, then to the CRM's default. |

Two things must be true in the CRM (Marketing → Integrations → the Website Forms connection):
WhatsApp tracking is switched on for that landing page, and **the landing page's domain is the
one saved on the connection** — the CRM refuses the token from any other origin. An unknown or
switched-off token is answered "off", and every link stays as the page wrote it.

### Install — a page on a WzState website's own domain

Only for a page served from one of a WzState website's own domains that loads this script by hand
(the WzState public site itself already has it built in). There is no forms token; the CRM
recognises the site by the page's origin:

```html
<script src="https://cdn.jsdelivr.net/gh/mohamedibro118/wzgate-form@stable/wzgate-form.js"
        data-api="https://crm.example.com/api"
        data-site="my-site"
        data-key="pk_site_..."
        defer></script>
```

- `data-site` — optional. The site key (CRM → Settings → Websites), sent as `X-Site`; needed only
  when the origin alone does not say which of the organization's sites this is.
- `data-key` — the site's **publishable** API key, sent as `X-Api-Key`; required once the CRM
  enforces public API keys. It is not the forms token.

If a tag carries both a forms token and `data-site` / `data-key`, all of them are sent and the
CRM goes by the token.

### What it does

1. **On load** it reads `gclid`, `gbraid`, `wbraid`, `fbclid` and the five `utm_*` values from the
   landing URL and gives the visitor a random id. A later visit with a *different* click id is a
   new ad click and replaces them. Nothing is sent yet.
2. **On the first real interaction** (scroll, pointer, key, touch, or hovering a WhatsApp link) it
   asks the CRM once: `POST {data-api}/public/click-codes`.
3. **It rewrites the WhatsApp links** — `wa.me/<number>`, `api.whatsapp.com/send`,
   `web.whatsapp.com/send`, `whatsapp://send`, and anything marked `data-wz-whatsapp`:
   - a link with its own text gets ` (ref: CODE)` appended (on its own line when the text is
     multi-line), never twice, and an older code of ours is replaced;
   - a link with no text gets the site's message template from the CRM;
   - the link's own number, other parameters and `#hash` are kept as written;
   - links added later (client-rendered pages) are picked up by a debounced `MutationObserver`.
   WhatsApp links with **no phone number** (share buttons) and `wa.me/message/…` short links are
   left alone.
   **Only links to the inbox number are coded:** when the CRM's answer names the WhatsApp number
   connected to the inbox, a link (or a `data-wz-whatsapp="<number>"`) that opens any other
   number — an advisor's own phone — is left exactly as written and its taps are not reported,
   because a message sent there could never be matched (`+20…`, `0020…` and the local `0…` form
   of the same number all count as the same).
4. **On the tap** it tells the CRM (`POST …/click-codes/CODE/clicked`, a `keepalive` fetch that is
   never awaited) and the browser follows the link as usual.

The link always opens. If the CRM is slow, down, or tracking is off, links stay exactly as the
page wrote them. With storage blocked the visit is kept in memory for that page.

**A tap that is the visitor's very first action.** The request starts on `pointerdown` /
`touchstart` / hover, which usually precede the click by long enough. If the code still has not
arrived when the click fires, the tap is held for **at most 300 ms**, then the chat is opened by
the script — with the code if it came, as the page wrote it if not. Clicks with Ctrl/⌘/Shift or
the middle button are never held.

### `data-wz-whatsapp`

```html
<!-- a button with no link of its own: opens the number configured in the CRM -->
<button data-wz-whatsapp>Chat on WhatsApp</button>

<!-- same, with a number of its own (also works when the CRM is unreachable) -->
<a data-wz-whatsapp="201001234567">Chat on WhatsApp</a>

<!-- a WhatsApp link the script must not touch -->
<a href="https://wa.me/201001234567" data-wz-whatsapp="off">Call centre</a>
```

An `<a>` gets a real `href`; any other element is opened by the script on click (new tab, or
`data-wz-target="_self"`). An element with no number of its own does nothing until the CRM has
answered, so give it one if it is the page's only WhatsApp button.

### Visitor consent

Whether the script waits for consent is a **site setting in the CRM** ("wait for the visitor's
consent"), not a tag attribute. When it is on, the CRM issues no code, and the script stores
nothing, until the page says the visitor agreed:

```html
<script>
  // Before the wzgate script tag, so calls made early are queued:
  window.wzstate = window.wzstate || { q: [], consent: function (v) { this.q.push(v); } };

  // In your cookie banner's callbacks:
  onAccept(function () { wzstate.consent(true); });   // ask for the code, keep the visit
  onDecline(function () { wzstate.consent(false); }); // forget everything stored, restore the links
</script>
```

- `wzstate.consent(true)` — remembered for later pages; the request carries `consent: true`.
- `wzstate.consent(false)` — clears `localStorage["wz_wa"]`, removes the code from the links and
  makes no further request on that page. Call it on each page while the answer is "no" (banner
  tools do).
- An existing `window.wzstate` object is kept; the script only defines `consent` on it.

With Google Consent Mode, call `wzstate.consent(granted)` from the same callback that updates
`ad_storage`.

### What is stored

One `localStorage` key, `wz_wa`: the visitor id, the click ids and UTMs, the code and the CRM's
last answer. It is written only after the CRM has said tracking is on and — when the site waits
for consent — after `wzstate.consent(true)`. Until then the visit lives in memory, so on a
consent-waiting site a click id is lost if the visitor leaves the landing page before agreeing.
Safari caps script-written storage at 7 days; the code then simply starts again.

### For a host application

`window.WzgateForm.whatsapp.start({ api, headers, locale, seed, onState })` runs the same logic
without a tag — the WzState public site vendors this file and calls it with its own identity
headers, a `seed` (`{ code, anonymousVisitorId }` read from a first-party cookie) and `onState`
(called with `'issued' | 'clicked' | 'cleared'`). `stop()` undoes everything.

## Releases

- Immutable version tags: `v1` (forms only, the original), `v1.1.0` (click codes).
- A moving `stable` branch that new snippets point to
  (`https://cdn.jsdelivr.net/gh/mohamedibro118/wzgate-form@stable/wzgate-form.js`).
  jsDelivr caches a branch for up to 12 hours; purge with
  `https://purge.jsdelivr.net/gh/mohamedibro118/wzgate-form@stable/wzgate-form.js`.
- SRI needs an exact file, so pin a version tag when you use `integrity` (the hash below is for
  the version in `package.json`); the `stable` channel cannot be pinned.
- Per release: bump `package.json` + `VERSION` in the script, `npm test`, `npm run sri`, commit,
  tag `vX.Y.Z`, fast-forward `stable`.

## Subresource Integrity (SRI)

Production snippets should pin the script with SRI so a compromised CDN can't serve altered JS.
Compute the hash for the exact file you deploy:

```bash
npm run sri
# → sha384-…   (and writes it to wzgate-form.js.sri)
```

Then serve the snippet with:

```html
<script src="https://cdn.wzgate.com/wzgate-form.js" data-token="…" data-endpoint="…"
        integrity="sha384-…" crossorigin="anonymous" defer></script>
```

> SRI + `crossorigin="anonymous"` requires the CDN to send `Access-Control-Allow-Origin` for the
> script. Recompute the hash on every release and version the filename (e.g. `wzgate-form.v1.js`)
> so caches don't serve a stale hash.

## Deploy (S3 + CloudFront example)

```bash
# upload (immutable, versioned filename recommended)
aws s3 cp wzgate-form.js s3://<bucket>/wzgate-form.js \
  --content-type "application/javascript" --cache-control "public, max-age=31536000, immutable"

# invalidate the CDN if you overwrite the same name
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/wzgate-form.js"
```

Then set `WZGATE_FORM_SCRIPT_URL` on crm-server to the deployed URL (default
`https://cdn.wzgate.com/wzgate-form.js`).

---

## Local live test (end-to-end)

This exercises the real flow: real script → real endpoint → real lead. Prereqs: Postgres +
RabbitMQ running, and the `WEBSITE_FORM` integration type seeded in the integration-service DB.

Env already set for local dev (see each service's `.env`):
- crm-server: `WZGATE_FORM_SCRIPT_URL=http://localhost:8088/wzgate-form.js`,
  `INTEGRATION_PUBLIC_BASE_URL=http://localhost:3004`
- crm-integration-service: `PUBLIC_WEBHOOK_BASE_URL=http://localhost:3004`

**1. Serve the script** (so `WZGATE_FORM_SCRIPT_URL` resolves):
```bash
cd wzgate-form
npx serve -l 8088 .          # serves wzgate-form.js at http://localhost:8088/wzgate-form.js
```

**2. Start the backend** (separate terminals):
```bash
cd crm-integration-service && npm run start:dev    # :3004
cd crm-server && npm run start:dev                 # :3000
```

**3. Connect a form** (authenticated). Use the origin you'll serve the page from:
```bash
curl -X POST http://localhost:3000/integrations/website-form/connect \
  -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
  -d '{"allowedOrigins":["http://localhost:5500"]}'
# → note the publicToken (pk_…)
```

**4. Get the snippet** (optional — confirms data-endpoint is absolute):
```bash
curl http://localhost:3000/integrations/website-form/<integrationId>/snippet \
  -H "Authorization: Bearer <jwt>"
```

**5. Point the sample page at your token.** In `sample-landing.html`, replace both
`pk_REPLACE_ME` occurrences with your `publicToken`.

**6. Serve the landing page on the allowed origin and open it with UTMs:**
```bash
npx serve -l 5500 .          # http://localhost:5500/sample-landing.html
# open: http://localhost:5500/sample-landing.html?utm_source=facebook&utm_campaign=spring-newcairo&fbclid=FB1
```

**7. Submit the form.** You should see the success message, and within moments the lead appears in
the CRM with `lifecycleStage = LEAD`, last-touch UTMs in the `ContactSource` columns, first-touch +
click IDs in `ContactSource.metadata`, a resolved campaign, a score, and an assignee.

### No backend handy?

You can still prove the script logic (`npm test`) and the endpoint contract via a direct POST —
see the [integration guide](../docs/integrations/landing-page-form/integration-guide.md) Step 6 —
or click through `landing-form-demo` (`npm run dev`) which mocks the whole journey in-browser.

## What's still a follow-up

- Deploy `wzgate-form.js` to the real CDN and set `WZGATE_FORM_SCRIPT_URL` in production.
- Publish the SRI hash with each release and adopt a versioned filename.

# wzgate-form
