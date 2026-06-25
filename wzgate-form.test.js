// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = readFileSync(join(__dirname, 'wzgate-form.js'), 'utf8')

/** Load the IIFE into the current jsdom window with a given URL + DOM. */
function loadScript(url, dom) {
  window.history.replaceState({}, '', url)
  document.body.innerHTML = dom
  // currentScript is null under eval, so the script falls back to querySelector.
  // eslint-disable-next-line no-eval
  ;(0, eval)(SCRIPT)
}

const SNIPPET = (token, endpoint) => `
  <script data-token="${token}" data-endpoint="${endpoint}"></script>
  <form data-wzgate-form>
    <input name="firstName" value="Mona">
    <input name="email" value="mona@example.com">
    <input name="phone" value="01000000000">
    <input name="_gotcha" value="">
    <button type="submit">Send</button>
  </form>
`

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  document.body.innerHTML = ''
  delete window.WzgateForm
  vi.restoreAllMocks()
})

describe('wzgate-form.js', () => {
  it('captures first-touch (write-once) and last-touch (refreshes) across visits', () => {
    loadScript('https://lp.test/p?utm_source=facebook&utm_campaign=spring-newcairo&fbclid=FB1', SNIPPET('pk_1', 'https://api.test/public/forms/pk_1'))
    const first = window.WzgateForm.captureAttribution('https://lp.test/p?utm_source=facebook&utm_campaign=spring-newcairo&fbclid=FB1', '2026-06-22T10:00:00.000Z')
    expect(first.firstTouch.utmSource).toBe('facebook')
    expect(first.lastTouch.utmSource).toBe('facebook')
    expect(first.clickIds.fbclid).toBe('FB1')

    const second = window.WzgateForm.captureAttribution('https://lp.test/p?utm_source=google&utm_campaign=fb-remarketing&gclid=G1', '2026-06-22T12:00:00.000Z')
    expect(second.firstTouch.utmSource).toBe('facebook')        // unchanged
    expect(second.lastTouch.utmSource).toBe('google')           // refreshed
    expect(second.clickIds).toEqual({ fbclid: 'FB1', gclid: 'G1' }) // merged
  })

  it('POSTs the form fields + attribution to data-endpoint on submit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    loadScript('https://lp.test/lp?utm_source=google&utm_medium=cpc&utm_campaign=fb-remarketing&gclid=G1', SNIPPET('pk_1', 'https://api.test/public/forms/pk_1'))

    const form = document.querySelector('form[data-wzgate-form]')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve(); await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/public/forms/pk_1')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(opts.body)
    expect(body.firstName).toBe('Mona')
    expect(body.email).toBe('mona@example.com')
    expect(body.lastTouch.utmSource).toBe('google')
    expect(body.lastTouch.utmCampaign).toBe('fb-remarketing')
    expect(body.clickIds.gclid).toBe('G1')
    expect(body.landingPage).toBe('https://lp.test/lp')
    expect(body._gotcha).toBe('')
  })

  it('does not POST (lets native submit proceed) when data-endpoint is missing', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    loadScript('https://lp.test/lp', `
      <script data-token="pk_1"></script>
      <form data-wzgate-form><input name="email" value="a@b.com"><button type="submit">Send</button></form>
    `)
    const form = document.querySelector('form[data-wzgate-form]')
    const evt = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(evt)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(evt.defaultPrevented).toBe(false) // native submit not blocked
  })
})
