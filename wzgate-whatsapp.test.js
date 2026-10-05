// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = readFileSync(join(__dirname, 'wzgate-form.js'), 'utf8')

/**
 * The CRM's matcher, copied verbatim from
 * CRM-MMS-BACKEND/src/applications/marketing/click-attribution/click-code.extractor.ts
 * (`REF_TOKEN`). Nothing is imported from the backend; if that pattern changes,
 * this copy must change with it — every text this script produces is asserted
 * against it.
 */
const SERVER_REF_TOKEN = /(?<![A-Za-z0-9])ref\s*[:：\-–=#]?\s*([A-Za-z0-9]{5})(?![A-Za-z0-9])/gi

/** The codes the server would read out of a message, upper-cased. */
function serverCodes(text) {
  return [...text.matchAll(SERVER_REF_TOKEN)].map((m) => m[1].toUpperCase())
}

const API = 'https://crm.test/api'
const TEMPLATE_EN = 'Hello, I would like to know more. (ref: {code})'
const TEMPLATE_AR = 'مرحباً، أود معرفة المزيد. (ref: {code})'

const tag = (attrs = `data-api="${API}"`) => `<script ${attrs}></script>`

function loadScript(url, dom) {
  window.history.replaceState({}, '', url)
  document.body.innerHTML = dom
  // currentScript is null under eval, so the script falls back to querySelector.
  // eslint-disable-next-line no-eval
  ;(0, eval)(SCRIPT)
  return window.WzgateForm.whatsapp
}

const issued = (over = {}) => ({
  success: true,
  data: {
    enabled: true,
    requireConsent: false,
    code: 'K7Q2M',
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    whatsappNumber: '201000000000',
    messageTemplate: TEMPLATE_EN,
    ...over,
  },
})
const OFF = { success: true, data: { enabled: false, code: null, expiresAt: null, whatsappNumber: null, messageTemplate: null } }
const NEEDS_CONSENT = {
  success: true,
  data: { enabled: true, requireConsent: true, code: null, expiresAt: null, whatsappNumber: '201000000000', messageTemplate: null },
}

const ok = (json) => ({ ok: true, status: 200, json: async () => json })

/** fetch mock: `answers` are used in order for the issue call; the clicked call always answers 204. */
function mockFetch(...answers) {
  let i = 0
  const fn = vi.fn((url) => {
    if (String(url).endsWith('/clicked')) return Promise.resolve({ ok: true, status: 204 })
    const answer = answers[Math.min(i++, answers.length - 1)]
    return typeof answer === 'function' ? answer() : Promise.resolve(ok(answer))
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const issueCalls = (fn) => fn.mock.calls.filter(([url]) => String(url).endsWith('/public/click-codes'))
const clickedCalls = (fn) => fn.mock.calls.filter(([url]) => String(url).endsWith('/clicked'))
const bodyOf = (call) => JSON.parse(call[1].body)

const interact = () => window.dispatchEvent(new Event('scroll'))
/** Let the fetch promise chain and the debounced re-scan run. */
const settle = () => vi.advanceTimersByTimeAsync(100)
const textOf = (el) => new URL(el.getAttribute('href').replace(/^whatsapp:/, 'https:')).searchParams.get('text')

/**
 * Dispatch a click and report whether the SCRIPT prevented it. The answer is
 * read in the bubble phase (the script listens in capture), and the event is
 * then cancelled so jsdom does not try to navigate.
 */
function click(el, init = {}) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  let defaultPrevented = null
  const probe = (e) => {
    defaultPrevented = e.defaultPrevented
    e.preventDefault()
  }
  window.addEventListener('click', probe, { once: true })
  el.dispatchEvent(event)
  window.removeEventListener('click', probe)
  return { defaultPrevented }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('lang')
  delete window.WzgateForm
  delete window.wzstate
})

afterEach(() => {
  window.WzgateForm?.whatsapp?.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('configuration', () => {
  it('stays completely inert without data-api', async () => {
    const fetchMock = mockFetch(issued())
    const wa = loadScript('https://lp.test/p?gclid=G1', `
      <script data-token="pk_1" data-endpoint="https://is.test/public/forms/pk_1"></script>
      <a id="w" href="https://wa.me/201000000000">WhatsApp</a>`)
    interact()
    await settle()
    click(document.getElementById('w'))
    await settle()

    expect(wa.state().started).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(document.getElementById('w').getAttribute('href')).toBe('https://wa.me/201000000000')
    expect(localStorage.getItem('wz_wa')).toBeNull()
  })

  it('normalises data-api with or without /api and a trailing slash', () => {
    const wa = loadScript('https://lp.test/', '')
    expect(wa.apiBase('https://crm.test')).toBe('https://crm.test/api')
    expect(wa.apiBase('https://crm.test/')).toBe('https://crm.test/api')
    expect(wa.apiBase('https://crm.test/api')).toBe('https://crm.test/api')
    expect(wa.apiBase('https://crm.test/api/')).toBe('https://crm.test/api')
    expect(wa.apiBase('')).toBe('')
  })

  it('identifies the site with X-Site and X-Api-Key from data-site / data-key, on both calls', async () => {
    const fetchMock = mockFetch(issued())
    loadScript('https://lp.test/', `${tag('data-api="https://crm.test/" data-site="my-site" data-key="pk_live_1" data-locale="ar"')}
      <a id="w" href="https://wa.me/201000000000">WhatsApp</a>`)
    interact()
    await settle()
    click(document.getElementById('w'))

    const [url, opts] = issueCalls(fetchMock)[0]
    expect(url).toBe('https://crm.test/api/public/click-codes')
    expect(opts.method).toBe('POST')
    expect(opts.headers).toEqual({ 'X-Site': 'my-site', 'X-Api-Key': 'pk_live_1', 'Content-Type': 'application/json' })
    expect(bodyOf(issueCalls(fetchMock)[0]).locale).toBe('ar')
    expect(clickedCalls(fetchMock)[0][1].headers).toEqual({ 'X-Site': 'my-site', 'X-Api-Key': 'pk_live_1' })
  })

  it('sends no identity header when the tag has none (the Origin identifies the site)', async () => {
    const fetchMock = mockFetch(issued())
    loadScript('https://lp.test/', tag())
    interact()
    await settle()
    expect(issueCalls(fetchMock)[0][1].headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('a click-codes-only tag writes no form attribution and warns about nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch(issued())
    loadScript('https://lp.test/?utm_source=google&gclid=G1', tag())
    expect(warn).not.toHaveBeenCalled()
    expect(localStorage.getItem('wz_ft')).toBeNull()
    expect(localStorage.getItem('wz_ci')).toBeNull()
  })

  it('does nothing the second time the script is included', async () => {
    const fetchMock = mockFetch(issued())
    loadScript('https://lp.test/', `${tag()}<a id="w" href="https://wa.me/201000000000?text=Hi">WhatsApp</a>`)
    const first = window.WzgateForm
    ;(0, eval)(SCRIPT)
    expect(window.WzgateForm).toBe(first)

    interact()
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(1)
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)')
    click(document.getElementById('w'))
    expect(clickedCalls(fetchMock)).toHaveLength(1)
  })
})

describe('the visit: click ids, UTMs and the visitor id', () => {
  it('asks for a code on the first interaction — not on load — with what the landing URL carried', async () => {
    const fetchMock = mockFetch(issued())
    document.documentElement.setAttribute('lang', 'en-GB')
    loadScript(
      'https://lp.test/villas?gclid=G1&gbraid=GB1&wbraid=WB1&fbclid=FB1&utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_term=villa&utm_content=ad1&email=a@b.c',
      tag(),
    )
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()

    interact()
    window.dispatchEvent(new Event('keydown'))
    window.dispatchEvent(new Event('pointerdown'))
    await settle()

    expect(issueCalls(fetchMock)).toHaveLength(1)
    const body = bodyOf(issueCalls(fetchMock)[0])
    expect(body).toEqual({
      anonymousVisitorId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
      gclid: 'G1', gbraid: 'GB1', wbraid: 'WB1', fbclid: 'FB1',
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'spring', utmTerm: 'villa', utmContent: 'ad1',
      landingUrl: 'https://lp.test/villas',
      locale: 'en',
    })
  })

  it('keeps the first sight across pages and re-uses the code without asking again', async () => {
    const fetchMock = mockFetch(issued())
    loadScript('https://lp.test/?gclid=G1&utm_source=google', tag())
    interact()
    await settle()
    const visitor = bodyOf(issueCalls(fetchMock)[0]).anonymousVisitorId
    window.WzgateForm.whatsapp.stop()
    delete window.WzgateForm

    // Next page of the same visit: no click id in the URL.
    const wa = loadScript('https://lp.test/contact?utm_source=internal', `${tag()}<a id="w" href="https://wa.me/201000000000">WhatsApp</a>`)
    // The cached code is on the link before any interaction, with no request.
    expect(textOf(document.getElementById('w'))).toBe('Hello, I would like to know more. (ref: K7Q2M)')
    interact()
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(1)
    expect(wa.state()).toMatchObject({ code: 'K7Q2M', anonymousVisitorId: visitor, clickIds: { gclid: 'G1' }, utm: { utmSource: 'google' } })
  })

  it('a new ad click replaces the stored click ids and gets the code the server answers with', async () => {
    const fetchMock = mockFetch(issued(), issued({ code: 'P9RST' }))
    loadScript('https://lp.test/?gclid=G1&utm_campaign=one', tag())
    interact()
    await settle()
    window.WzgateForm.whatsapp.stop()
    delete window.WzgateForm

    const wa = loadScript('https://lp.test/?fbclid=FB2&utm_campaign=two', `${tag()}<a id="w" href="https://wa.me/201000000000?text=Hi">WhatsApp</a>`)
    // The old code belongs to the old click: it is not put on the links.
    expect(textOf(document.getElementById('w'))).toBe('Hi')
    interact()
    await settle()

    const body = bodyOf(issueCalls(fetchMock)[1])
    expect(body.code).toBe('K7Q2M') // sent, so the server can decide
    expect(body.fbclid).toBe('FB2')
    expect(body.gclid).toBeUndefined()
    expect(body.utmCampaign).toBe('two')
    expect(wa.state().code).toBe('P9RST')
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: P9RST)')
    expect(JSON.parse(localStorage.getItem('wz_wa')).c).toBe('P9RST')
  })

  it('caps values at the lengths the server accepts', async () => {
    const fetchMock = mockFetch(issued())
    loadScript(`https://lp.test/?gclid=${'g'.repeat(600)}&utm_source=${'s'.repeat(300)}`, tag())
    interact()
    await settle()
    const body = bodyOf(issueCalls(fetchMock)[0])
    expect(body.gclid).toHaveLength(512)
    expect(body.utmSource).toHaveLength(255)
  })

  it('works when storage throws: the visit lives in memory', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    const fetchMock = mockFetch(issued())
    const wa = loadScript('https://lp.test/?gclid=G1', `${tag()}<a id="w" href="https://wa.me/201000000000?text=Hi">WhatsApp</a>`)
    interact()
    await settle()

    expect(bodyOf(issueCalls(fetchMock)[0]).gclid).toBe('G1')
    expect(wa.state().code).toBe('K7Q2M')
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)')
  })
})

describe('link rewriting', () => {
  const LINKS = `
    <a id="bare" href="https://wa.me/201000000000">1</a>
    <a id="text" href="https://wa.me/201000000000?text=Hello%20there">2</a>
    <a id="api" href="https://api.whatsapp.com/send?phone=201000000000&text=I+want+a+villa&type=phone_number&app_absent=0#top">3</a>
    <a id="apiBare" href="https://api.whatsapp.com/send/?phone=%2B201000000000">4</a>
    <a id="web" href="https://web.whatsapp.com/send?phone=201000000000&text=Hi">5</a>
    <a id="scheme" href="whatsapp://send?phone=201000000000&text=Hi">6</a>
    <a id="arabic" href="https://wa.me/201000000000?text=${encodeURIComponent('مرحباً، أريد فيلا\nhttps://lp.test/فيلا')}">7</a>
    <a id="share" href="https://api.whatsapp.com/send?text=Look%20at%20this">share</a>
    <a id="short" href="https://wa.me/message/ABCDEF123">short</a>
    <a id="other" href="https://example.com/?text=Hi">other</a>
    <a id="marked" data-wz-whatsapp>marked</a>
    <a id="markedOwn" data-wz-whatsapp="+20 111 222 3333">own</a>
    <button id="button" data-wz-whatsapp>button</button>
    <a id="off" data-wz-whatsapp="off" href="https://wa.me/201000000000?text=Hi">off</a>`
  const $ = (id) => document.getElementById(id)

  async function ready(answer = issued()) {
    const fetchMock = mockFetch(answer)
    const wa = loadScript('https://lp.test/', tag() + LINKS)
    interact()
    await settle()
    return { fetchMock, wa }
  }

  it('fills the site template into a link with no text', async () => {
    await ready()
    expect($('bare').getAttribute('href')).toBe(
      `https://wa.me/201000000000?text=${encodeURIComponent('Hello, I would like to know more. (ref: K7Q2M)')}`,
    )
    expect(textOf($('apiBare'))).toBe('Hello, I would like to know more. (ref: K7Q2M)')
    expect($('apiBare').getAttribute('href').startsWith('https://api.whatsapp.com/send/?phone=%2B201000000000&text=')).toBe(true)
  })

  it('appends the code to a link that has its own text, keeping number, params and hash', async () => {
    await ready()
    expect(textOf($('text'))).toBe('Hello there (ref: K7Q2M)')
    expect($('api').getAttribute('href')).toBe(
      `https://api.whatsapp.com/send?phone=201000000000&text=${encodeURIComponent('I want a villa (ref: K7Q2M)')}&type=phone_number&app_absent=0#top`,
    )
    expect(textOf($('web'))).toBe('Hi (ref: K7Q2M)')
    expect($('scheme').getAttribute('href')).toBe(`whatsapp://send?phone=201000000000&text=${encodeURIComponent('Hi (ref: K7Q2M)')}`)
  })

  it('encodes Arabic text correctly and puts the code on its own line under a URL', async () => {
    await ready(issued({ messageTemplate: TEMPLATE_AR }))
    const href = $('arabic').getAttribute('href')
    expect(href).not.toMatch(/[^\x20-\x7E]/) // fully percent-encoded
    expect(textOf($('arabic'))).toBe('مرحباً، أريد فيلا\nhttps://lp.test/فيلا\n(ref: K7Q2M)')
    expect(textOf($('bare'))).toBe('مرحباً، أود معرفة المزيد. (ref: K7Q2M)')
  })

  it('every text it produces is readable by the server matcher', async () => {
    await ready(issued({ messageTemplate: TEMPLATE_AR }))
    for (const id of ['bare', 'text', 'api', 'apiBare', 'web', 'scheme', 'arabic', 'marked', 'markedOwn']) {
      expect(serverCodes(textOf($(id))), id).toEqual(['K7Q2M'])
    }
  })

  it('makes a template that lost its code matchable anyway', () => {
    const wa = loadScript('https://lp.test/', '')
    expect(serverCodes(wa.compose('', 'K7Q2M', 'Hello {code}'))).toEqual(['K7Q2M'])
    expect(serverCodes(wa.compose('', 'K7Q2M', 'Hello'))).toEqual(['K7Q2M'])
    expect(serverCodes(wa.compose('', 'K7Q2M', null))).toEqual(['K7Q2M'])
    // A page that already wrote this code in its own way is left alone.
    expect(wa.compose('Hi [REF K7Q2M]', 'K7Q2M', TEMPLATE_EN)).toBe('Hi [REF K7Q2M]')
  })

  it('leaves share links, short links, other sites and opted-out links alone', async () => {
    await ready()
    expect($('share').getAttribute('href')).toBe('https://api.whatsapp.com/send?text=Look%20at%20this')
    expect($('short').getAttribute('href')).toBe('https://wa.me/message/ABCDEF123')
    expect($('other').getAttribute('href')).toBe('https://example.com/?text=Hi')
    expect($('off').getAttribute('href')).toBe('https://wa.me/201000000000?text=Hi')
  })

  it('builds data-wz-whatsapp elements from the server number, or from their own', async () => {
    const { wa } = await ready()
    expect($('marked').getAttribute('href')).toBe(
      `https://wa.me/201000000000?text=${encodeURIComponent('Hello, I would like to know more. (ref: K7Q2M)')}`,
    )
    expect($('markedOwn').getAttribute('href').startsWith('https://wa.me/201112223333?text=')).toBe(true)
    expect($('button').hasAttribute('href')).toBe(false)

    const open = vi.spyOn(wa._nav, 'open').mockImplementation(() => {})
    const event = click($('button'))
    expect(event.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith(
      `https://wa.me/201000000000?text=${encodeURIComponent('Hello, I would like to know more. (ref: K7Q2M)')}`,
      '_blank',
    )
  })

  it('never appends twice on a re-scan', async () => {
    const { wa } = await ready()
    const before = $('text').getAttribute('href')
    wa.rescan()
    wa.rescan()
    document.body.appendChild(document.createElement('p'))
    await settle()
    expect($('text').getAttribute('href')).toBe(before)
    expect(serverCodes(textOf($('text')))).toEqual(['K7Q2M'])
  })

  it('replaces an older code of ours, including one a server-rendered link already carried', () => {
    const wa = loadScript('https://lp.test/', '')
    const once = wa.rewriteHref('https://wa.me/201000000000?text=Hi', 'K7Q2M', TEMPLATE_EN)
    const twice = wa.rewriteHref(once, 'P9RST', TEMPLATE_EN)
    expect(new URL(twice).searchParams.get('text')).toBe('Hi (ref: P9RST)')
    expect(wa.rewriteHref(once, 'K7Q2M', TEMPLATE_EN)).toBe(once)
  })

  it('puts the links back exactly as the page wrote them when stopped', async () => {
    const { wa } = await ready()
    wa.stop()
    expect($('text').getAttribute('href')).toBe('https://wa.me/201000000000?text=Hello%20there')
    expect($('bare').getAttribute('href')).toBe('https://wa.me/201000000000')
    expect($('marked').hasAttribute('href')).toBe(false)
  })
})

describe('when there is no code to add', () => {
  const LINK = `<a id="w" href="https://wa.me/201000000000?text=Hi" target="_blank">WhatsApp</a>`
  const href = () => document.getElementById('w').getAttribute('href')

  it('leaves links untouched and unblocked when the endpoint fails', async () => {
    for (const failure of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
      () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json') } }),
      () => { throw new Error('sync') },
    ]) {
      const fetchMock = mockFetch(failure)
      const wa = loadScript('https://lp.test/?gclid=G1', tag() + LINK)
      const open = vi.spyOn(wa._nav, 'open').mockImplementation(() => {})
      interact()
      await settle()

      expect(href()).toBe('https://wa.me/201000000000?text=Hi')
      const event = click(document.getElementById('w'))
      expect(event.defaultPrevented).toBe(false) // the browser opens it natively
      expect(open).not.toHaveBeenCalled()
      expect(clickedCalls(fetchMock)).toHaveLength(0)
      wa.stop()
      delete window.WzgateForm
    }
  })

  it('leaves links untouched and stores nothing when tracking is off', async () => {
    const fetchMock = mockFetch(OFF)
    const wa = loadScript('https://lp.test/?gclid=G1', tag() + LINK + '<a id="m" data-wz-whatsapp>x</a>')
    interact()
    await settle()

    expect(wa.state()).toMatchObject({ off: true, code: null })
    expect(href()).toBe('https://wa.me/201000000000?text=Hi')
    expect(document.getElementById('m').hasAttribute('href')).toBe(false)
    expect(localStorage.getItem('wz_wa')).toBeNull()
    expect(click(document.getElementById('w')).defaultPrevented).toBe(false)
    expect(clickedCalls(fetchMock)).toHaveLength(0)
  })

  it('removes a cached code from the links when the site switches tracking off', async () => {
    mockFetch(issued())
    loadScript('https://lp.test/', tag() + LINK)
    interact()
    await settle()
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)')
    window.WzgateForm.whatsapp.stop()
    delete window.WzgateForm

    mockFetch(OFF)
    vi.setSystemTime(Date.now() + 11 * 60 * 1000) // the cached answer is no longer fresh
    loadScript('https://lp.test/', tag() + LINK)
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)') // cached, until asked
    interact()
    await settle()
    expect(href()).toBe('https://wa.me/201000000000?text=Hi')
    expect(localStorage.getItem('wz_wa')).toBeNull()
  })
})

describe('consent', () => {
  const LINK = `<a id="w" href="https://wa.me/201000000000?text=Hi">WhatsApp</a>`
  const href = () => document.getElementById('w').getAttribute('href')

  it('keeps an existing window.wzstate object and adds consent to it', () => {
    const mine = { other: 1 }
    window.wzstate = mine
    loadScript('https://lp.test/', tag())
    expect(window.wzstate).toBe(mine)
    expect(window.wzstate.other).toBe(1)
    expect(typeof window.wzstate.consent).toBe('function')
  })

  it('does nothing until wzstate.consent(true), then asks with consent:true', async () => {
    const fetchMock = mockFetch(NEEDS_CONSENT, issued({ requireConsent: true }))
    const wa = loadScript('https://lp.test/?gclid=G1', tag() + LINK)
    interact()
    await settle()

    expect(bodyOf(issueCalls(fetchMock)[0]).consent).toBeUndefined()
    expect(wa.state()).toMatchObject({ awaitingConsent: true, code: null })
    expect(href()).toBe('https://wa.me/201000000000?text=Hi')
    expect(localStorage.getItem('wz_wa')).toBeNull() // nothing stored before consent

    // More interaction does not ask again.
    window.dispatchEvent(new Event('keydown'))
    expect(click(document.getElementById('w')).defaultPrevented).toBe(false)
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(1)

    window.wzstate.consent(true)
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(2)
    expect(bodyOf(issueCalls(fetchMock)[1])).toMatchObject({ consent: true, gclid: 'G1' })
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)')
    expect(JSON.parse(localStorage.getItem('wz_wa'))).toMatchObject({ c: 'K7Q2M', k: true })
  })

  it('a consent given before the script loaded (stub queue) is sent with the first request', async () => {
    window.wzstate = { q: [], consent(v) { this.q.push(v) } }
    window.wzstate.consent(true)
    const fetchMock = mockFetch(issued({ requireConsent: true }))
    loadScript('https://lp.test/', tag() + LINK)
    await settle()
    expect(fetchMock).not.toHaveBeenCalled() // a replayed "yes" is not an interaction

    interact()
    await settle()
    expect(bodyOf(issueCalls(fetchMock)[0]).consent).toBe(true)
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)')
  })

  it('consent(true) while the first request is in the air asks once more, with consent', async () => {
    let release
    const fetchMock = mockFetch(() => new Promise((resolve) => { release = () => resolve(ok(NEEDS_CONSENT)) }), issued({ requireConsent: true }))
    loadScript('https://lp.test/', tag() + LINK)
    interact()
    window.wzstate.consent(true)
    release()
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(2)
    expect(bodyOf(issueCalls(fetchMock)[1]).consent).toBe(true)
    expect(textOf(document.getElementById('w'))).toBe('Hi (ref: K7Q2M)')
  })

  it('consent(false) clears what was stored, restores the links and asks for nothing more', async () => {
    const fetchMock = mockFetch(issued())
    const wa = loadScript('https://lp.test/?gclid=G1', tag() + LINK)
    interact()
    await settle()
    expect(localStorage.getItem('wz_wa')).not.toBeNull()

    window.wzstate.consent(false)
    expect(localStorage.getItem('wz_wa')).toBeNull()
    expect(href()).toBe('https://wa.me/201000000000?text=Hi')
    expect(wa.state()).toMatchObject({ refused: true, code: null, anonymousVisitorId: null, clickIds: {} })

    const event = click(document.getElementById('w'))
    window.dispatchEvent(new Event('keydown'))
    await settle()
    expect(event.defaultPrevented).toBe(false)
    expect(issueCalls(fetchMock)).toHaveLength(1)
    expect(clickedCalls(fetchMock)).toHaveLength(0)
  })
})

describe('the tap', () => {
  const LINK = `<a id="w" href="https://wa.me/201000000000?text=Hi" target="_blank"><span id="inner">WhatsApp</span></a>`

  it('reports the click with a keepalive fetch it does not wait for, once per code', async () => {
    let resolveClicked
    const fetchMock = vi.fn((url) =>
      String(url).endsWith('/clicked')
        ? new Promise((resolve) => { resolveClicked = resolve }) // never answers during the test
        : Promise.resolve(ok(issued())),
    )
    vi.stubGlobal('fetch', fetchMock)
    const wa = loadScript('https://lp.test/', tag('data-api="https://crm.test" data-key="pk_1"') + LINK)
    const open = vi.spyOn(wa._nav, 'open').mockImplementation(() => {})
    interact()
    await settle()

    const event = click(document.getElementById('inner'))
    // Synchronously after the tap: the call is out, and the browser is free
    // to follow the (already coded) link — nothing was prevented or awaited.
    expect(event.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
    const [url, opts] = clickedCalls(fetchMock)[0]
    expect(url).toBe('https://crm.test/api/public/click-codes/K7Q2M/clicked')
    expect(opts).toEqual({ method: 'POST', keepalive: true, headers: { 'X-Api-Key': 'pk_1' } })
    expect(opts.body).toBeUndefined()

    click(document.getElementById('w'))
    expect(clickedCalls(fetchMock)).toHaveLength(1)
    expect(typeof resolveClicked).toBe('function')
  })

  it('a failing clicked call never reaches the page', async () => {
    const fetchMock = vi.fn((url) => {
      if (String(url).endsWith('/clicked')) throw new Error('keepalive not supported')
      return Promise.resolve(ok(issued()))
    })
    vi.stubGlobal('fetch', fetchMock)
    loadScript('https://lp.test/', tag() + LINK)
    interact()
    await settle()
    expect(() => click(document.getElementById('w'))).not.toThrow()
  })

  it('a tap that is the very first action waits briefly and opens the coded link', async () => {
    let release
    const fetchMock = mockFetch(() => new Promise((resolve) => { release = () => resolve(ok(issued())) }))
    const wa = loadScript('https://lp.test/?gclid=G1', tag() + LINK)
    const open = vi.spyOn(wa._nav, 'open').mockImplementation(() => {})

    const event = click(document.getElementById('w')) // no scroll, no key: the tap starts the request
    expect(issueCalls(fetchMock)).toHaveLength(1)
    expect(event.defaultPrevented).toBe(true)
    expect(open).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120)
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(`https://wa.me/201000000000?text=${encodeURIComponent('Hi (ref: K7Q2M)')}`, '_blank')
    expect(clickedCalls(fetchMock)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(open).toHaveBeenCalledTimes(1) // the timeout does not open it a second time
  })

  it('opens the link as the page wrote it when the code is slower than 300 ms', async () => {
    const fetchMock = mockFetch(() => new Promise(() => {})) // never answers
    const wa = loadScript('https://lp.test/', tag() + LINK)
    const open = vi.spyOn(wa._nav, 'open').mockImplementation(() => {})

    click(document.getElementById('w'))
    await vi.advanceTimersByTimeAsync(299)
    expect(open).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledWith('https://wa.me/201000000000?text=Hi', '_blank')
    expect(clickedCalls(fetchMock)).toHaveLength(0)
  })

  it('never holds a modified or middle click', async () => {
    mockFetch(() => new Promise(() => {}))
    const wa = loadScript('https://lp.test/', tag() + LINK)
    const open = vi.spyOn(wa._nav, 'open').mockImplementation(() => {})
    expect(click(document.getElementById('w'), { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(click(document.getElementById('w'), { metaKey: true }).defaultPrevented).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to the same tab when the pop-up is blocked', () => {
    const wa = loadScript('https://lp.test/', tag())
    vi.stubGlobal('open', vi.fn(() => null))
    const hrefSet = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { get href() { return original.href }, set href(v) { hrefSet(v) }, pathname: original.pathname, search: original.search, origin: original.origin },
    })
    try {
      wa._nav.open('https://wa.me/201000000000', '_blank')
      expect(window.open).toHaveBeenCalledWith('https://wa.me/201000000000', '_blank')
      expect(hrefSet).toHaveBeenCalledWith('https://wa.me/201000000000')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })
})

describe('pages that change after load', () => {
  it('codes a link added later, re-codes one the page rewrote, and settles', async () => {
    mockFetch(issued())
    loadScript('https://lp.test/', tag() + '<div id="root"></div>')
    interact()
    await settle()

    const link = document.createElement('a')
    link.id = 'late'
    link.setAttribute('href', 'https://wa.me/201000000000?text=Hi')
    document.getElementById('root').appendChild(link)
    await settle()
    expect(textOf(link)).toBe('Hi (ref: K7Q2M)')

    // A framework re-render writes its own href back.
    link.setAttribute('href', 'https://wa.me/201000000000?text=About%20villa%20A')
    await settle()
    expect(textOf(link)).toBe('About villa A (ref: K7Q2M)')

    // Our own edits must not feed the observer: after it settles, no more writes.
    const write = vi.spyOn(Element.prototype, 'setAttribute')
    await vi.advanceTimersByTimeAsync(2000)
    expect(write).not.toHaveBeenCalled()
  })

  it('debounces a burst of mutations into one scan', async () => {
    mockFetch(issued())
    loadScript('https://lp.test/', tag() + '<div id="root"></div>')
    interact()
    await settle()

    const query = vi.spyOn(document, 'querySelectorAll')
    for (let i = 0; i < 25; i++) {
      const a = document.createElement('a')
      a.setAttribute('href', `https://wa.me/20100000000${i % 10}?text=Hi`)
      document.getElementById('root').appendChild(a)
    }
    await settle()
    expect(query).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll('#root a')].every((a) => textOf(a) === 'Hi (ref: K7Q2M)')).toBe(true)
  })
})

describe('host integration (the public site)', () => {
  it('adopts a seeded code + visitor id, and reports issued / clicked / cleared', async () => {
    const fetchMock = mockFetch(issued({ code: 'SEED5' }))
    const wa = loadScript('https://lp.test/', '<a id="w" href="https://wa.me/201000000000?text=Hi">WhatsApp</a>')
    const onState = vi.fn()
    expect(wa.start({
      api: 'https://crm.test/api',
      headers: { 'X-Site': 'niche', 'X-Subdomain': 'niche', 'X-Api-Key': '' },
      locale: 'ar',
      seed: { code: 'SEED5', anonymousVisitorId: 'visitor_from_cookie_01' },
      onState,
    })).toBe(true)
    interact()
    await settle()

    expect(issueCalls(fetchMock)[0][1].headers).toEqual({ 'X-Site': 'niche', 'X-Subdomain': 'niche', 'Content-Type': 'application/json' })
    expect(bodyOf(issueCalls(fetchMock)[0])).toMatchObject({ code: 'SEED5', anonymousVisitorId: 'visitor_from_cookie_01', locale: 'ar' })
    expect(onState).toHaveBeenLastCalledWith(
      { code: 'SEED5', anonymousVisitorId: 'visitor_from_cookie_01', expiresAt: expect.any(String) }, 'issued',
    )

    click(document.getElementById('w'))
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'SEED5' }), 'clicked')

    wa.consent(false)
    expect(onState).toHaveBeenLastCalledWith({ code: null, anonymousVisitorId: null, expiresAt: null }, 'cleared')
  })

  it('start() is idempotent, and a locale change asks again', async () => {
    const fetchMock = mockFetch(issued(), issued({ messageTemplate: TEMPLATE_AR }))
    const wa = loadScript('https://lp.test/', '<a id="w" href="https://wa.me/201000000000">WhatsApp</a>')
    wa.start({ api: API, locale: 'en' })
    wa.start({ api: API, locale: 'en' })
    interact()
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(1)

    wa.start({ api: API, locale: 'ar' })
    await settle()
    expect(issueCalls(fetchMock)).toHaveLength(2)
    expect(bodyOf(issueCalls(fetchMock)[1]).locale).toBe('ar')
    expect(textOf(document.getElementById('w'))).toBe('مرحباً، أود معرفة المزيد. (ref: K7Q2M)')
  })
})
