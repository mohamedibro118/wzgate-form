# wzgate-form.js

The drop-in browser script that powers the [landing-page form integration](../docs/integrations/landing-page-form/).
It captures UTM / first-touch / last-touch / click-IDs and POSTs form submissions to the public
ingestion endpoint. Zero dependencies, ~5 KB.

- Source: `wzgate-form.js`
- Tests: `wzgate-form.test.js` (jsdom) — `npm test`
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

## Subresource Integrity (SRI)

Production snippets should pin the script with SRI so a compromised CDN can't serve altered JS.
Compute the hash for the exact file you deploy:

```bash
npm run sri
# → sha384-…   (also saved in wzgate-form.js.sri)
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
