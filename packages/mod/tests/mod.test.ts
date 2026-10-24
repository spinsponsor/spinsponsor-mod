import { expect, mock, test } from 'claude-code/testing'
import { allowedApi, BACKGROUND_HOLD_MS, bandPropsOk, cardRows, cells, FETCH_GAP_MS, FLUSH_EVERY_MS, LINK_POLL_MS, MARKER_WAIT_MS, OPEN_TEXT, p95, PERMIT_MS, RECHECK_MS, REQUEST_TIMEOUT_MS, SLOT_MS, SNAPSHOT_GRACE_MS, toAd, versionAtLeast, wrapRows } from '../hooks/register'

const KEY = { install_key: 'ss_test', api_url: 'http://localhost:8787' }
const SPINNER = {
  plugin: 'spinsponsor',
  component: 'Spinner',
  requestId: 'main',
  viewport: { columns: 120, rows: 40 },
  props: { word: 'Percolating', message: null, suffix: '…', mode: 'responding' },
} as const

// The spinner line is the terminal's; the Desktop app gets the ad card (its own tests below)
const surface = 'terminal' as const
const line = (_surface: 'terminal', text: string) => `Sponsored: ${text}`

// The band above the prompt on the Desktop app, while Claude works
const BAND = {
  plugin: 'spinsponsor',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 106, rows: 38, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 95, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

// The card's headline (its second text, after "Sponsored"), or undefined when no card is drawn
const headline = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' }))[1]?.text

const LINKED_KEY = 'ss_L' + 'k'.repeat(42)
const API = 'http://localhost:8787'
const NO_KEY = { install_key: '', api_url: API }

const token = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const serverAd = (n: number, text = `Ad number ${n}`, card: Record<string, unknown> = {}) => ({
  id: token(900 + n),
  text,
  deliveryToken: token(n),
  clickUrl: `http://localhost:8787/c/${token(n)}`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  ...card,
})

type Opts = { toolResult?: unknown; resultFor?: (e: { tool: string; tool_use_id?: string; run_in_background?: boolean }) => unknown; check?: 'ask' | 'allow'; loopCheckAllows?: boolean; started?: boolean; markerSetMs?: number; markerSetFails?: boolean; markerRace?: boolean; toolThrows?: boolean; toolDenies?: boolean; slowFirstStateSetMs?: number; stateGetFails?: boolean; firstStateSetFails?: boolean; hookAnswersDialog?: boolean; answerCommand?: string; dialogHookMs?: number; toolMs?: number; dialogs?: Record<string, string>; ads?: unknown[]; perFetch?: (n: number) => unknown[]; adsDelayMs?: number; adsStatuses?: number[]; eventsStatus?: number; stored?: Record<string, unknown>; slowAds?: boolean; stopped?: string[]; renderThrows?: boolean; adsRejects?: string; engine?: string | null; permission?: { serve?: boolean; reason?: string; blocked?: string[]; status?: number; slowMs?: number; rejects?: string }; link?: { approved: boolean; claimStatus?: number; slowClaimMs?: number }; slowSaveMs?: number; term?: string; ssh?: boolean; openExit?: number }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Stubs Claude Code and a fake SpinSponsor API that enforces the real contract; returns what the mod sent and drew
function engine(on: Parameters<Parameters<typeof test>[1]>[1], o: Opts = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-04T12:00:00Z') })
  const seen = { invalidations: 0, message: null as string | null, fetches: [] as string[], auth: [] as string[], toasts: [] as string[], opened: [] as string[][], events: [] as { deliveryToken: string; durationMs: number }[], bad: [] as string[], stops: [] as string[] }
  const store = new Map<string, unknown>(Object.entries(o.stored ?? {}))
  const issued = new Set<string>()
  const accepted = new Set<string>()
  const adsStatuses = [...(o.adsStatuses ?? [])]
  let served = false
  let fetchNo = 0
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    if (e.key === 'machine_key' && o.slowSaveMs) return clock.sleep(o.slowSaveMs).then(() => (store.set(e.key, e.value), { value: undefined }))
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', () => ({ value: undefined }))
  // The terminal Claude Code runs in (never the one running these tests), and the browser `open` hands a link to
  on('env.get', ($, e) => ({ value: e.name === 'TERM_PROGRAM' ? o.term : e.name === 'SSH_CONNECTION' && o.ssh ? '10.0.0.2 50000 10.0.0.3 22' : undefined }))
  on('process.run', ($, e) => {
    seen.opened.push([...e.argv])
    return { value: { exitCode: o.openExit ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Counted, then passed on so the engine redraws as usual
  on('ui.invalidate', ($, e, next) => {
    seen.invalidations++
    return next(e)
  })
  on('session.version', () => ({ value: { version: o.engine ?? '2.1.295', base: o.engine === undefined ? '2.1.295' : (o.engine ?? undefined), builtAt: '' } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // What the engine's decider says about a call: ask, or (a sandboxed command, an auto-approved tool) allow (o.check).
  // o.loopCheckAllows: a check raised inside a subagent's call (it carries the agent's id) passes, as an earlier
  // allow would. Since 2.1.309 the kit's $.tool.call raises that check itself and refuses an ask no hook answers,
  // so a test that opens the call's dialog by hand needs it to pass (a $.tool.check query carries no agent)
  on('tool.check', ($, e) => ({ decision: o.loopCheckAllows && e.agentId ? 'allow' : (o.check ?? 'ask') }))
  // Bottom of the PermissionRequest hooks: nobody answers, so the dialog opens (unless a settings hook allows it)
  on('classic.PermissionRequest', async ($, e) => {
    if (o.dialogHookMs) await clock.sleep(o.dialogHookMs)
    const answered = o.hookAnswersDialog || (o.answerCommand !== undefined && (e.tool_input as { command?: string })?.command === o.answerCommand)
    return answered ? { decision: { behavior: 'allow' as const } } : {}
  })
  on('classic.Elicitation', ($, e) => (e.message === 'blocked' ? { block: 'not allowed' } : {}))
  on('classic.ElicitationResult', () => ({}))
  on('tool.call', async ($, e) => {
    if (o.toolMs) await clock.sleep(o.toolMs)
    if (o.toolThrows) throw new Error('tool failed')
    if (o.toolDenies) return { deny: 'refused' }
    return { result: o.resultFor ? o.resultFor(e) : (o.toolResult ?? 'ok') }
  })
  // Bottom of the Stop hooks: nobody blocks the stop. What each carried is kept for the tests that check the Mod passes it on
  on('classic.Stop', ($, e) => (seen.stops.push('main'), {}))
  on('classic.SubagentStop', ($, e) => (seen.stops.push(e.agent_id), {}))
  // The session's state ($.state): open dialogs saved there survive a reload (o.dialogs: what an earlier load left)
  // (o.started: the "session started" marker an earlier load wrote, so this load is a reload)
  const state = new Map<string, unknown>([...(o.dialogs ? [['dialogs', o.dialogs] as const] : []), ...(o.started ? [['started', true] as const] : [])])
  on('state.get', ($, e) => {
    if (o.stateGetFails) return { deny: 'state unavailable' }
    return { value: { value: state.get(e.key), version: state.has(e.key) ? 1 : 0 } }
  })
  // The first-save knobs are for the dialogs' save; the session marker has its own (o.markerSetMs, o.markerSetFails)
  let dialogSets = 0
  // What each write of the session marker asked for (a conditional write: only while it was never written)
  const markerWrites: (number | undefined)[] = []
  on('state.set', async ($, e) => {
    if (e.key === 'dialogs' && dialogSets++ === 0) {
      if (o.slowFirstStateSetMs) await clock.sleep(o.slowFirstStateSetMs)
      if (o.firstStateSetFails) return { deny: 'state unavailable' }
    }
    if (e.key === 'started') {
      markerWrites.push(e.ifVersion)
      if (o.markerSetMs) await clock.sleep(o.markerSetMs)
      if (o.markerSetFails) return { deny: 'state unavailable' }
      // Another load wrote it between this one's read and its write
      if (o.markerRace) return { value: { isSet: false, version: 1 } }
    }
    // A conditional write lands only while the value stands at that version (0: never written)
    if (e.ifVersion !== undefined && e.ifVersion !== (state.has(e.key) ? 1 : 0)) return { value: { isSet: false, version: 1 } }
    state.set(e.key, e.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('http.fetch', async ($, e) => {
    seen.fetches.push(e.url)
    const bearer = (e.init?.headers as Record<string, string> | undefined)?.authorization
    if (bearer) seen.auth.push(bearer)
    // Permission to show ads for the next 2 minutes (o.permission can change as the test goes)
    if (e.url.endsWith('/v1/mod/permission')) {
      const p = o.permission ?? {}
      if (p.slowMs) await clock.sleep(p.slowMs)
      if (p.rejects && bearer === `Bearer ${p.rejects}`) return { value: { status: 401, ok: false, headers: {}, text: '{}' } }
      if (p.status && p.status !== 200) return { value: { status: p.status, ok: false, headers: {}, text: '{}' } }
      const body = { serve: p.serve ?? true, ...(p.reason ? { reason: p.reason } : {}), until: '2099-01-01T00:00:00.000Z', minModVersion: '0.0.0', blockedEngineVersions: p.blocked ?? [] }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    }
    // The sign-in flow: a code to approve, then this machine's key once
    if (e.url.endsWith('/v1/link/start')) {
      return { value: { status: 201, ok: true, headers: {}, text: JSON.stringify({ code: 'ABCD-2345', pollToken: LINKED_KEY.replace('L', 'P'), approveUrl: 'http://localhost:3000/link?code=ABCD-2345' }) } }
    }
    if (e.url.endsWith('/v1/link/claim')) {
      if (o.link?.slowClaimMs) await clock.sleep(o.link.slowClaimMs)
      const status = o.link?.claimStatus ?? 200
      if (status !== 200) return { value: { status, ok: false, headers: {}, text: '{}' } }
      const body = o.link?.approved ? { status: 'linked', key: LINKED_KEY, name: 'Desktop' } : { status: 'pending' }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    }
    // Delivery tokens the server says may no longer be shown (the test sets o.stopped as it goes)
    if (e.url.endsWith('/v1/mod/ads/stopped')) {
      // Like the server: only the tokens the Mod says it holds are answered
      const held = JSON.parse(e.init!.body!).tokens as string[]
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ stopped: (o.stopped ?? []).filter((t) => held.includes(t)) }) } }
    }
    if (e.url.endsWith('/v1/mod/ads')) {
      if (o.slowAds) await clock.sleep(3_600_000)
      if (o.adsDelayMs) await clock.sleep(o.adsDelayMs)
      if (o.adsRejects && bearer === `Bearer ${o.adsRejects}`) return { value: { status: 401, ok: false, headers: {}, text: '{}' } }
      const status = adsStatuses.shift() ?? 200
      if (status === 429) return { value: { status, ok: false, headers: { 'retry-after': '7' }, text: '{}' } }
      if (status !== 200) return { value: { status, ok: false, headers: {}, text: '{}' } }
      // The fake server hands out its ads once, then has none (or, with perFetch, a new batch every time)
      const ads = o.perFetch ? o.perFetch(++fetchNo) : served ? [] : (o.ads ?? [serverAd(1), serverAd(2), serverAd(3), serverAd(4)])
      served = true
      for (const a of ads as { deliveryToken?: string }[]) if (a.deliveryToken) issued.add(a.deliveryToken)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ads }) } }
    }
    const status = o.eventsStatus ?? 200
    if (status !== 200) return { value: { status, ok: false, headers: {}, text: '{}' } }
    const batch = JSON.parse(e.init!.body!).events as { clientEventId: string; deliveryToken: string; shownAt: string; durationMs: number }[]
    const results = batch.map((ev) => {
      if (!UUID.test(ev.clientEventId) || !ISO.test(ev.shownAt) || !Number.isInteger(ev.durationMs)) seen.bad.push('format')
      if (!issued.has(ev.deliveryToken)) seen.bad.push('unknown delivery')
      if (accepted.has(ev.clientEventId)) return { clientEventId: ev.clientEventId, status: 'duplicate' }
      accepted.add(ev.clientEventId)
      seen.events.push(ev)
      return { clientEventId: ev.clientEventId, status: 'accepted' }
    })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ results }) } }
  })
  on('ui.render', ($, e) => {
    if (e.component === 'Spinner' && o.renderThrows) throw new Error('renderer failed')
    if (e.component === 'Spinner') seen.message = e.props.message
    return { type: 'Text', props: {}, children: [String(e.props.text ?? e.props.message)] }
  })
  return { clock, seen, store, issued, state, markerWrites }
}
// A permission dialog: the call needs asking, then its dialog opens
const dialog = async ($: any, id = 'u1') => {
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: id })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } })
}
const shards = (store: Map<string, unknown>) => [...store.entries()].filter(([k]) => k.startsWith('queue:'))
const queued = (store: Map<string, unknown>) => shards(store).flatMap(([, v]) => (v as { events: unknown[] }).events)
const done = ($: any, turnId = 't1') => $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null })

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}
async function ads($: any, args: string) {
  return (await $.command.run({ command: 'ads', args })).text as string
}

test('signed out: no network at all and the stock spinner', async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(FLUSH_EVERY_MS * 2)
  expect(seen.fetches).toEqual([])
  expect(seen.message).toBe(null)
  expect(await ads($, 'status')).toContain('not signed in')
})

test('a key with a non-allowed API address counts as signed out', { options: { install_key: 'ss_test', api_url: 'http://evil.example' } }, async ($, on) => {
  const { seen } = engine(on)
  await start($)
  expect(seen.fetches).toEqual([])
})

// The manifest's default is production; an api_url set in the settings (staging, local) still wins
for (const [options, api] of [
  [{ install_key: 'ss_test' }, 'https://api.spinsponsor.com'],
  [{ install_key: 'ss_test', api_url: 'https://staging-api.spinsponsor.com/' }, 'https://staging-api.spinsponsor.com'],
] as const) test(`${'api_url' in options ? 'a set api_url' : 'the default api_url'} sends the startup calls to ${api}`, { options }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await clock.settle()
  expect(seen.fetches.length).toBeGreaterThan(0)
  expect(seen.fetches.filter((u) => !u.startsWith(`${api}/v1/`))).toEqual([])
})

test(`shows server ads, counts a full slot and reports it on the next flush`, { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface })
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: SLOT_MS, isAborted: false, reason: 'answer', usage: null })
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => [e.deliveryToken, e.durationMs])).toEqual([[token(1), SLOT_MS]])
  expect(seen.bad).toEqual([])
  expect(queued(store)).toEqual([])
  expect(await ads($, 'status')).toContain('1 views counted')
})

test(`an interrupted slot is not reported and its ad is not wasted`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface })
  await clock.advance(SLOT_MS - 1)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 4999, isAborted: true, reason: 'aborted', usage: null })
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
  expect(await ads($, 'status')).toContain('(1 partial)')
})

test(`an ad queued but never drawn goes back to the cache`, { options: KEY }, async ($, on) => {
  const { seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 10, isAborted: false, reason: 'answer', usage: null })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.ui.mount({ ...SPINNER, surface })
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
})

test(`nothing counts while a permission prompt is open`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface })
  await clock.advance(2000)
  await dialog($)
  await clock.advance(SLOT_MS * 2)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test(`an engine status replacing the ad mid-slot voids it`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await $.ui.mount({ ...SPINNER, surface })
  await clock.advance(2000)
  await ui.unmount()
  await $.ui.mount({ ...SPINNER, surface, props: { ...SPINNER.props, message: 'Compacting conversation' } })
  expect(seen.message).toBe('Compacting conversation')
  await clock.advance(3000 + FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test(`narrow or unmeasured screens get the stock spinner`, { options: KEY }, async ($, on) => {
  const { seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 40, rows: 20 } })
  expect(seen.message).toBe(null)
  await ui.unmount()
  const { viewport, ...unmeasured } = SPINNER
  await $.ui.mount({ ...unmeasured, surface })
  expect(seen.message).toBe(null)
})


test(`pause brings the stock spinner back and survives a restart`, { options: KEY }, async ($, on) => {
  const { seen, store } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await $.ui.mount({ ...SPINNER, surface })
  expect(seen.message).toContain('Sponsored: ')
  expect(await ads($, 'pause')).toContain('paused')
  await ui.unmount()
  await $.ui.mount({ ...SPINNER, surface })
  expect(seen.message).toBe(null)
  expect(store.get('paused')).toBe(true)
  expect(await ads($, 'resume')).toContain('resumed')
})

test('unsafe or oversized ads from the server are never drawn', () => {
  expect(toAd(serverAd(1))).toBeDefined()
  expect(toAd(serverAd(1, 'Evil \u001b[2J clear'))).toBe(null)
  expect(toAd(serverAd(1, 'line\nbreak'))).toBe(null)
  expect(toAd(serverAd(1, 'bidi \u202e trick'))).toBe(null)
  expect(toAd(serverAd(1, 'x'.repeat(61)))).toBe(null)
  expect(toAd({ ...serverAd(1), clickUrl: 'javascript:alert(1)' })).toBe(null)
  expect(toAd({ ...serverAd(1), deliveryToken: 'nope' })).toBe(null)
  expect(allowedApi('https://api.spinsponsor.test')).toBe(true)
  expect(allowedApi('http://example.com')).toBe(false)
})

test('an ad’s click address must be exactly the one the server builds for that delivery', { options: KEY }, async ($, on) => {
  // Nothing a browser would normalise away from /c/, and no other delivery's address
  const ads = [{ ...serverAd(1), clickUrl: 'http://localhost:8787/c/%2e%2e/elsewhere' }, { ...serverAd(2), clickUrl: `http://localhost:8787/c/${token(3)}` }, serverAd(3)]
  engine(on, { ads })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await card($)
  expect(await headline(ui)).toBe('Ad number 3')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(`http://localhost:8787/c/${token(3)}`)
})

test('command text never carries ad text, links or the key; /ads open draws the link on screen', { options: KEY }, async ($, on) => {
  const { clock } = engine(on)
  await start($)
  expect(await ads($, 'open')).toBe('No sponsored line has been shown yet.')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(SLOT_MS)
  for (const arg of ['status', 'open', 'pause', 'resume', 'login', '']) {
    const text = await ads($, arg)
    expect(text).not.toContain('Ad number')
    expect(text).not.toMatch(/https?:/)
    expect(text).not.toContain('ss_test')
  }
  const out = await $.ui.mount({
    plugin: 'spinsponsor',
    component: 'CommandOutput',
    requestId: 'm1',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { command: 'ads', args: 'open', text: OPEN_TEXT, isErrored: false },
  })
  // The first slot ended and the next ad is on screen, so that is the last one shown
  const link = await out.find({ type: 'Link' })
  expect(link?.props.href).toBe(`http://localhost:8787/c/${token(2)}`)
  const logout = await ads($, 'logout')
  expect(logout).not.toMatch(/https?:|Ad number|ss_test/)
})

test('p95 picks the 95th percentile', () => {
  expect(p95([])).toBe(0)
  expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95)
})

test(`a long turn rotates ads every 5 seconds and reports each once`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface })
  await clock.advance(SLOT_MS * 3)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: SLOT_MS * 3, isAborted: false, reason: 'answer', usage: null })
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => e.deliveryToken)).toEqual([token(1), token(2), token(3)])
})

test('startup never waits for the ad server', { options: KEY }, async ($, on) => {
  engine(on, { slowAds: true })
  // Would hang for an hour of mock time if session.start awaited the fetch
  await start($)
  expect(await ads($, 'status')).toContain('signed in')
})

test('a rejected key stops all network calls and is remembered without storing the key', { options: KEY }, async ($, on) => {
  // The first call (the permission check) is the one that finds the key rejected
  const { clock, seen, store } = engine(on, { permission: { status: 401 } })
  await start($)
  await clock.settle()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(FLUSH_EVERY_MS * 30)
  expect(seen.fetches.length).toBe(1)
  expect(await ads($, 'status')).toContain('install key rejected')
  expect(typeof store.get('rejected')).toBe('string')
  expect(JSON.stringify([...store.values()])).not.toContain('ss_test')
})

test('a key rejected in an earlier session is not retried', { options: KEY }, async ($, on) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('http://localhost:8787 ss_test'))
  const fp = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  const { clock, seen } = engine(on, { stored: { rejected: fp } })
  await start($)
  await clock.advance(FLUSH_EVERY_MS * 2)
  expect(seen.fetches).toEqual([])
})

test('after a failed fetch it retries at the backoff deadline and recovers mid-turn', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { adsStatuses: [503] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toBe(null)
  await ui.unmount()
  await clock.advance(30_000)
  expect(seen.fetches.filter((u) => u.endsWith('/ads')).length).toBe(2)
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toBe('Sponsored: Ad number 1')
})

test('views survive a failed send and go out once the server is back', { options: KEY }, async ($, on) => {
  const failing = { eventsStatus: 503 }
  const { clock, seen, store } = engine(on, failing)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(queued(store).length).toBe(1)
  failing.eventsStatus = 200
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => e.deliveryToken)).toEqual([token(1)])
  expect(queued(store)).toEqual([])
})

test('views left by a session that ended are adopted; a live session’s queue and another API’s views are left alone', { options: KEY }, async ($, on) => {
  const now = Date.parse('2026-10-04T12:00:00Z')
  const view = (n: number) => ({ clientEventId: token(700 + n), deliveryToken: token(n), shownAt: '2026-10-04T11:59:00.000Z', durationMs: 5000 })
  const { clock, seen, store, issued } = engine(on, {
    stored: {
      'queue:dead': { updatedAt: now - 10 * 60_000, events: [view(1)] },
      'queue:live': { updatedAt: now - 30_000, events: [view(2)] },
      'queue:dead-tagged': { updatedAt: now - 10 * 60_000, events: [view(5)], api: API },
      'queue:staging': { updatedAt: now - 10 * 60_000, events: [view(3)], api: 'https://staging-api.spinsponsor.com' },
      'queue:old-staging': { updatedAt: now - 25 * 3600_000, events: [view(4)], api: 'https://staging-api.spinsponsor.com' },
    },
  })
  await start($)
  issued.add(token(1))
  issued.add(token(5))
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => e.deliveryToken).sort()).toEqual([token(1), token(5)])
  expect(store.has('queue:dead')).toBe(false)
  expect(store.has('queue:dead-tagged')).toBe(false)
  // This session's own queue records its API, so another API never adopts it
  expect([...store].filter(([k, v]) => k.startsWith('queue:') && (v as { api?: string }).api === API).length).toBe(1)
  expect(store.has('queue:live')).toBe(true)
  expect(store.has('queue:staging')).toBe(true)
  expect(store.has('queue:old-staging')).toBe(false)
})

test('nothing counts after /ads pause, even for a slot that was already running', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(2000)
  await ads($, 'pause')
  await clock.advance(SLOT_MS * 3)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test('/ads logout stops all network calls at once', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await clock.settle()
  const before = seen.fetches.length
  await ads($, 'logout')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(FLUSH_EVERY_MS * 3)
  expect(seen.fetches.length).toBe(before)
  expect(seen.message).toBe(null)
  expect(await ads($, 'status')).toContain('signed out for this session')
})

test('/ads login links the machine once approved: its own key, kept for this API only, and ads start', { options: NO_KEY }, async ($, on) => {
  const link = { approved: false }
  const { clock, seen, store } = engine(on, { link })
  await start($)
  expect(seen.fetches).toEqual([])
  const text = await ads($, 'login')
  expect(text).toContain('http://localhost:3000/link?code=ABCD-2345')
  expect(text).toContain('ABCD-2345')
  expect(text).not.toContain('ss_')
  await clock.advance(LINK_POLL_MS * 2)
  expect(store.has('machine_key')).toBe(false)
  link.approved = true
  await clock.advance(LINK_POLL_MS)
  expect(store.get('machine_key')).toEqual({ key: LINKED_KEY, apiUrl: API })
  expect(seen.toasts.at(-1)).toContain('linked')
  // Polling stopped; ads come with the new key
  const claims = seen.fetches.filter((u) => u.endsWith('/claim')).length
  await clock.advance(LINK_POLL_MS * 3)
  expect(seen.fetches.filter((u) => u.endsWith('/claim')).length).toBe(claims)
  // Linking hashes the key with real crypto, outside the test clock: give it real time (it failed about 1 run in 25)
  for (let i = 0; i < 100 && !seen.auth.includes(`Bearer ${LINKED_KEY}`); i++) {
    await new Promise((r) => setTimeout(r, 5))
    await clock.settle()
  }
  expect(seen.auth).toContain(`Bearer ${LINKED_KEY}`)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const card = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await headline(card)).toBe('Ad number 1')
  expect(await ads($, 'login')).toContain('already signed in')
})

test('a linked key is used on the next start, but never sent to a different API', { options: NO_KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { stored: { machine_key: { key: LINKED_KEY, apiUrl: API } } })
  await start($)
  await clock.settle()
  expect(seen.auth[0]).toBe(`Bearer ${LINKED_KEY}`)
  expect(await ads($, 'status')).toContain('signed in')
})

test('a key linked for another API is ignored', { options: { install_key: '', api_url: 'https://api.other.test' } }, async ($, on) => {
  const { clock, seen } = engine(on, { stored: { machine_key: { key: LINKED_KEY, apiUrl: API } } })
  await start($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.fetches).toEqual([])
  expect(await ads($, 'status')).toContain('not signed in')
})

test('/ads logout forgets a linked key for good', { options: NO_KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { stored: { machine_key: { key: LINKED_KEY, apiUrl: API } } })
  await start($)
  await clock.settle()
  expect(await ads($, 'logout')).toContain('forgot')
  expect(store.has('machine_key')).toBe(false)
  const before = seen.fetches.length
  await clock.advance(FLUSH_EVERY_MS * 2)
  expect(seen.fetches.length).toBe(before)
})

for (const claimStatus of [410, 409]) test(`a sign-in the server ends (${claimStatus}) stops asking and says why`, { options: NO_KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { link: { approved: true, claimStatus } })
  await start($)
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS * 4)
  expect(seen.fetches.filter((u) => u.endsWith('/claim')).length).toBe(1)
  expect(seen.toasts.at(-1)).toContain(claimStatus === 410 ? 'expired' : 'limit of 3')
  expect(store.has('machine_key')).toBe(false)
})

test('an approval that arrives after /ads logout is ignored: no key is kept', { options: NO_KEY }, async ($, on) => {
  // The answer is still on its way when the person logs out
  const link = { approved: false, slowClaimMs: 3000 }
  const { clock, seen, store } = engine(on, { link })
  await start($)
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS)
  await ads($, 'logout')
  link.approved = true
  await clock.advance(LINK_POLL_MS * 3)
  expect(store.has('machine_key')).toBe(false)
  expect(seen.toasts.some((t) => t.includes('linked'))).toBe(false)
  expect(await ads($, 'status')).not.toContain(': signed in')
})

test('a sign-in claim slower than the request deadline still links the machine (its key is handed out only once)', { options: NO_KEY }, async ($, on) => {
  const { clock, store } = engine(on, { link: { approved: true, slowClaimMs: REQUEST_TIMEOUT_MS + 10_000 } })
  await start($)
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS + REQUEST_TIMEOUT_MS + 10_000)
  expect(store.get('machine_key')).toEqual({ key: LINKED_KEY, apiUrl: API })
  expect(await ads($, 'status')).toContain(': signed in')
})

test('a late answer to an old /ads login cannot cancel a newer one', { options: NO_KEY }, async ($, on) => {
  const link: { approved: boolean; claimStatus?: number; slowClaimMs?: number } = { approved: false, claimStatus: 410, slowClaimMs: 3000 }
  const { clock, store } = engine(on, { link })
  await start($)
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS) // the first attempt's claim is on its way, and will say "expired"
  await ads($, 'logout')
  await ads($, 'login')
  await clock.advance(3000) // the old "expired" arrives
  Object.assign(link, { approved: true, claimStatus: undefined, slowClaimMs: 0 })
  await clock.advance(LINK_POLL_MS)
  expect(store.get('machine_key')).toEqual({ key: LINKED_KEY, apiUrl: API })
})

test('logging out while a linked key is being saved forgets it', { options: NO_KEY }, async ($, on) => {
  const { clock, store } = engine(on, { link: { approved: true }, slowSaveMs: 3000 })
  await start($)
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS) // approved: the key is being saved
  await ads($, 'logout')
  await clock.advance(3000)
  expect(store.has('machine_key')).toBe(false)
  expect(await ads($, 'status')).not.toContain(': signed in')
})

test('with a key pasted in the settings, /ads login explains instead of linking', { options: KEY }, async ($, on) => {
  const { seen } = engine(on)
  await start($)
  await ads($, 'logout')
  expect(await ads($, 'login')).toContain('Install key')
  expect(seen.fetches.some((u) => u.includes('/v1/link/'))).toBe(false)
})

test('an unapproved code stops being asked about after 10 minutes', { options: NO_KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { link: { approved: false } })
  await start($)
  await ads($, 'login')
  await clock.advance(11 * 60_000)
  const claims = seen.fetches.filter((u) => u.endsWith('/claim')).length
  await clock.advance(LINK_POLL_MS * 10)
  expect(seen.fetches.filter((u) => u.endsWith('/claim')).length).toBe(claims)
  expect(seen.toasts.at(-1)).toContain('expired')
})

test('if a reload skipped session.start, the first turn still starts fetching and sending', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  // No session.start: straight into a turn, as after some plugin reloads
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toBe('Sponsored: Ad number 1')
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => e.deliveryToken)).toEqual([token(1)])
})

test(`an ad too wide for the terminal is skipped for one that fits, not left blocking the rest`, { options: KEY }, async ($, on) => {
  // 11 + 40 + 30 = 81 columns needed: one too many for an 80-column terminal
  const { clock, seen } = engine(on, { ads: [serverAd(1, 'x'.repeat(40)), serverAd(2, 'Fits fine')] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 80, rows: 24 } })
  // The mod swaps the too-wide ad and redraws by itself
  await clock.advance(1)
  expect(seen.message).toBe(line(surface, 'Fits fine'))
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => e.deliveryToken)).toEqual([token(2)])
})

test('anything beyond plain ASCII counts as two cells, so width is never under-counted', () => {
  expect(cells('Try Acme')).toBe(8)
  expect(cells('界界')).toBe(4)
  expect(cells('Hi 🚀')).toBe(5)
  expect(cells('⌚')).toBe(2)
  expect(cells('é')).toBe(2)
})

test(`an ad whose draw fails never counts`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { renderThrows: true })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface }).catch(() => {})
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test(`losing the reported width mid-slot voids it`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await $.ui.mount({ ...SPINNER, surface })
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(2000)
  await ui.unmount()
  const { viewport, ...unmeasured } = SPINNER
  await $.ui.mount({ ...unmeasured, surface })
  expect(seen.message).toBe(null)
  await clock.advance(3000)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test(`with only too-wide ads cached, the mod fetches more instead of stalling, and widening the terminal starts one`, { options: KEY }, async ($, on) => {
  const wide = (n: number) => serverAd(n, '界'.repeat(30)) // 11 + 60 + 30 = 101 cells
  const { clock, seen } = engine(on, { ads: [wide(1), wide(2), wide(3), wide(4), serverAd(5, 'Fits fine')] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 80, rows: 24 } })
  await clock.advance(1)
  expect(seen.message).toBe(line(surface, 'Fits fine'))
  // After the one ad that fits, the four wide ones don't count as stock: it asks the server again
  await clock.advance(SLOT_MS)
  expect(seen.message).toBe(null)
  expect(seen.fetches.filter((u) => u.endsWith('/v1/mod/ads')).length).toBeGreaterThan(1)
  // A wider terminal can draw them: the next draw starts one
  await ui.unmount()
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 120, rows: 40 } })
  await clock.advance(1)
  expect(seen.message).toBe(line(surface, '界'.repeat(30)))
})

test(`an ad edited or stopped on the server leaves the screen within a minute and is never reported`, { options: KEY }, async ($, on) => {
  const o: Opts = { stopped: [] }
  const { clock, seen } = engine(on, o)
  await start($)
  // The minute check runs on the flush timer; start the turn just before it
  await clock.advance(FLUSH_EVERY_MS - 2000)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface })
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  // Ad 1 (on screen) and ad 2 (cached) were edited away on the server
  o.stopped = [token(1), token(2)]
  await clock.advance(2000)
  expect(seen.message).toBe(line(surface, 'Ad number 3'))
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e) => e.deliveryToken)).toEqual([token(3)])
})

// --- The Desktop ad card ---
// Draws the band again with these props (one band per surface: the last drawing is taken down first)
let band: any = null
const card = async ($: any, props: Record<string, unknown> = {}) => {
  await band?.unmount().catch(() => {})
  band = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, ...props } })
  return band
}

test('desktop: a styled card with the ad’s fields, counted once as a card after 5 seconds; the spinner row is left alone', { options: KEY }, async ($, on) => {
  const ads = [serverAd(1, '🚀 Try Acme DB', { description: 'Free for open source', ctaLabel: 'Try it free', theme: 'ocean' }), serverAd(2)]
  const { clock, seen } = engine(on, { ads })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'desktop' })
  expect(seen.message).toBe(null)
  const ui = await card($)
  const box = await ui.find({ type: 'Box' })
  expect([box?.props.borderColor, box?.props.backgroundColor]).toEqual(['#0EA5E9', '#0B1E2D'])
  expect((await ui.findAll({ type: 'Text' })).map((t: { text?: string }) => t.text)).toEqual(['Sponsored', '🚀 Try Acme DB', 'Free for open source'])
  const link = await ui.find({ type: 'Link' })
  expect([link?.props.href, link?.props.label]).toEqual([`http://localhost:8787/c/${token(1)}`, 'Try it free →'])
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e: any) => [e.deliveryToken, e.format])).toEqual([[token(1), 'card']])
})

test('desktop: the next ad’s card follows every 5 seconds, each counted once', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await card($)
  await clock.advance(SLOT_MS)
  expect(await headline(await card($))).toBe('Ad number 2')
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e: any) => e.deliveryToken)).toEqual([token(1), token(2)])
})

for (const [name, interrupt] of [
  ['a survey taking the band', async ($: any) => card($, { hasSurvey: true })],
  ['a permission prompt', async ($: any) => dialog($)],
] as const) test(`desktop: ${name} mid-slot voids the card’s view`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await card($)
  await clock.advance(2000)
  await interrupt($)
  await clock.advance(3000)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test('desktop: no card while Claude is idle, in a band too narrow, or with a survey', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (const props of [{ isWorking: false }, { bodyColumns: 30 }, { hasSurvey: true }]) expect(await headline(await card($, props))).toBe(undefined)
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test('desktop: bad card fields fall back to the defaults; an ad whose click link is not ours is dropped', { options: KEY }, async ($, on) => {
  const ads = [
    { ...serverAd(1, 'Elsewhere'), clickUrl: 'https://tracker.example/c/x' },
    serverAd(2, 'Plain', { theme: 'neon', description: 'flip \u202e this', ctaLabel: 'x'.repeat(21) }),
  ]
  const { seen } = engine(on, { ads })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await card($)
  expect(await headline(ui)).toBe('Plain')
  expect((await ui.find({ type: 'Box' }))?.props.borderColor).toBe('#7C3AED')
  expect((await ui.findAll({ type: 'Text' })).length).toBe(2)
  expect((await ui.find({ type: 'Link' }))?.props.label).toBe('Learn more →')
  expect(seen.fetches.some((u: string) => u.includes('tracker'))).toBe(false)
})


test('desktop: going idle mid-slot voids the card’s view, even before the turn ends', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await card($)
  await clock.advance(2000)
  await card($, { isWorking: false })
  await clock.advance(3000 + FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

for (const first of ['line', 'card'] as const) test(`a ${first} on screen is left alone by the other hook's draws, and counted once as a ${first}`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const spin = () => $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: `s${Math.random()}` })
  if (first === 'line') await spin()
  else await card($)
  for (let i = 0; i < 4; i++) {
    await clock.advance(1000)
    // A band too narrow for the card, changing size: the line still fits, so it carries on
    if (first === 'line') await card($, { bodyColumns: 30 - i })
    else await spin()
  }
  await clock.advance(1000)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e: any) => [e.deliveryToken, e.format])).toEqual([[token(1), first]])
})

// --- Safety: the server's permission, the Claude Code version, and what Claude Code hands the hooks ---
const adFetches = (seen: { fetches: string[] }) => seen.fetches.filter((u) => u.endsWith('/v1/mod/ads')).length
// Enough ads for a minute of 5-second slots
const MANY = Array.from({ length: 20 }, (_, i) => serverAd(i + 1))

test('versions compare part by part', () => {
  expect(versionAtLeast('2.1.295', '2.1.295')).toBe(true)
  expect(versionAtLeast('2.10.0', '2.9.9')).toBe(true)
  expect(versionAtLeast('2.1.294', '2.1.295')).toBe(false)
  expect(versionAtLeast(null, '0.0.0')).toBe(false)
  expect(versionAtLeast('2.1.295-dev', '2.1.295')).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) test(`switched off mid-turn: the ad goes within a minute, cached ads are cleared, the slot is void (${surface})`, { options: KEY }, async ($, on) => {
  const permission: { serve?: boolean; reason?: string } = {}
  const { clock, seen } = engine(on, { permission, ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  const draw = async () => (surface === 'terminal' ? (await $.ui.mount({ ...SPINNER, surface, requestId: `s${Math.random()}` }), seen.message) : headline(await card($)))
  expect(await draw()).toContain('Ad number 1')
  await clock.advance(FLUSH_EVERY_MS - 2000)
  // The next ad is on screen when the minute's check says "off"
  Object.assign(permission, { serve: false, reason: 'off' })
  await clock.advance(2000)
  expect(await draw()).toBeFalsy()
  expect(await ads($, 'status')).toContain('switched ads off')
  expect(await ads($, 'status')).toContain('0 ads ready')
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  // Only the slots that finished before the switch-off count
  expect(seen.events.length).toBe(Math.floor((FLUSH_EVERY_MS - 2000) / SLOT_MS))
})

test('without word from the server, ads stop when the permission runs out and come back with it', { options: KEY }, async ($, on) => {
  const permission: { status?: number } = {}
  const { clock, seen } = engine(on, { permission, ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toContain('Sponsored')
  await done($)
  permission.status = 503
  await clock.advance(PERMIT_MS + FLUSH_EVERY_MS)
  // Cached ads are still there, but without permission none shows
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: 'again' })
  expect(seen.message).toBe(null)
  expect(await ads($, 'status')).toContain('no word from the SpinSponsor server')
  permission.status = undefined
  await clock.advance(FLUSH_EVERY_MS)
  await $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: 'back' })
  expect(seen.message).toContain('Sponsored')
})

test('a Mod too old for the server: no ads, one "please update" message, and its queued views still go out', { options: KEY }, async ($, on) => {
  const permission: { serve?: boolean; reason?: string } = {}
  const { clock, seen } = engine(on, { permission, ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(SLOT_MS)
  Object.assign(permission, { serve: false, reason: 'update' })
  await clock.advance(FLUSH_EVERY_MS * 3)
  // The views shown before the refusal still went out
  expect(seen.events.length).toBeGreaterThanOrEqual(1)
  const sent = seen.events.length
  await clock.advance(FLUSH_EVERY_MS * 3)
  expect(seen.events.length).toBe(sent)
  expect(seen.toasts.filter((t) => t.includes('please update')).length).toBe(1)
  expect(await ads($, 'status')).toContain('please update')
})

test('a developer who must accept new terms: no ads, one message pointing to the dashboard, and status says why', { options: KEY }, async ($, on) => {
  const permission: { serve?: boolean; reason?: string } = {}
  const { clock, seen } = engine(on, { permission, ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(SLOT_MS)
  expect(seen.message).toContain('Sponsored')
  Object.assign(permission, { serve: false, reason: 'terms' })
  await clock.advance(FLUSH_EVERY_MS * 3)
  await $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: 'after' })
  expect(seen.message).toBe(null)
  expect(seen.toasts.filter((t) => t.includes('accept the updated terms or consent on your SpinSponsor dashboard')).length).toBe(1)
  expect(await ads($, 'status')).toContain('paused: accept the updated terms or consent')
})

for (const [name, engineVersion, blocked] of [
  ['an older Claude Code', '2.1.200', []],
  ['a Claude Code with no release version', null, []],
  ['a Claude Code version we blocked', '2.1.295', ['2.1.295']],
] as const) test(`${name}: no ads, no ad fetches, one message`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { engine: engineVersion, permission: { blocked: [...blocked] } })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(FLUSH_EVERY_MS * 2)
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toBe(null)
  expect(adFetches(seen)).toBe(0)
  expect(seen.toasts.filter((t) => t.includes('ads are off on Claude Code')).length).toBe(1)
  expect(await ads($, 'status')).toContain('ads off')
})

for (const [where, bad] of [
  ['spinner', async ($: any) => $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: `odd${Math.random()}`, props: { ...SPINNER.props, mode: 'dancing' } })],
  ['band', async ($: any) => card($, { isWorking: 'yes' })],
] as const) test(`unexpected ${where} props: the slot is void and ads stay off for the session, with one message`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(2000)
  await bad($)
  await bad($)
  await clock.advance(3000)
  await $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: 'later' })
  expect(seen.message).toBe(null)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
  expect(seen.toasts.filter((t) => t.includes('draws differently')).length).toBe(1)
})

test('a permission answer slower than the permission itself grants nothing', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { permission: { slowMs: PERMIT_MS + 1000 } })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(PERMIT_MS + 2000)
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toBe(null)
  expect(await ads($, 'status')).toContain('waiting for the server')
})

test('one permission check at a time, and one that never answers is given up so the next can go out', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { permission: { slowMs: 3_600_000 } })
  await start($)
  const checks = () => seen.fetches.filter((u) => u.endsWith('/v1/mod/permission')).length
  // Still waiting: the 15-second rechecks don't overtake it
  await clock.advance(REQUEST_TIMEOUT_MS - 1000)
  expect(checks()).toBe(1)
  // Given up at the deadline: the next recheck goes out (without the deadline, ads stayed off for the session)
  await clock.advance(RECHECK_MS + 2000)
  expect(checks()).toBe(2)
})

test('while the server refuses views, a full queue waits for the minute’s retry instead of sending after every view', { options: KEY }, async ($, on) => {
  const o = { eventsStatus: 503, perFetch: (n: number) => Array.from({ length: 10 }, (_, i) => serverAd(n * 10 + i)) }
  const { clock, seen } = engine(on, o)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const sends = () => seen.fetches.filter((u) => u.endsWith('/v1/mod/events')).length
  // Past the 50 views that send at once, then 30 seconds more: at most the minute's retry
  await clock.advance(SLOT_MS * 55)
  const before = sends()
  await clock.advance(SLOT_MS * 6)
  expect(sends() - before).toBeLessThanOrEqual(1)
  // Back: everything queued goes out, 50 per send
  o.eventsStatus = 200
  await clock.advance(FLUSH_EVERY_MS * 2)
  expect(seen.events.length).toBeGreaterThanOrEqual(55)
})

test('after /ads logout and a new /ads login, nothing shows until the server answers for the new key', { options: NO_KEY }, async ($, on) => {
  // Every permission answer takes 20 seconds (within the request deadline)
  const { clock, seen } = engine(on, { link: { approved: true }, permission: { slowMs: 20_000 }, ads: MANY, stored: { machine_key: { key: LINKED_KEY.replace('L', 'M'), apiUrl: API } } })
  await start($)
  await ads($, 'logout')
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toBe(null)
  // The old key's answer is ignored; the new key's comes with the next minute's check
  await clock.advance(FLUSH_EVERY_MS + 30_000)
  await $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: 'later' })
  expect(seen.message).toContain('Sponsored')
})

test('a late "key rejected" for a key since replaced does not reject the new one', { options: NO_KEY }, async ($, on) => {
  const old = LINKED_KEY.replace('L', 'M')
  const { clock } = engine(on, { link: { approved: true }, permission: { slowMs: 20_000, rejects: old }, stored: { machine_key: { key: old, apiUrl: API } } })
  await start($)
  // The old key's permission check is still out when the person signs out and links again
  await ads($, 'logout')
  await ads($, 'login')
  await clock.advance(60_000)
  expect(await ads($, 'status')).toContain(': signed in')
})

test('unexpected props redraw once, not on every draw', { options: KEY }, async ($, on) => {
  const { seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const odd = () => $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: `odd${Math.random()}`, props: { ...SPINNER.props, mode: 'dancing' } })
  await odd()
  const after = seen.invalidations
  await odd()
  await odd()
  expect(seen.invalidations).toBe(after)
})

test('after /ads logout and a new /ads login, the old key’s permission does not carry over', { options: NO_KEY }, async ($, on) => {
  const permission: { slowMs?: number } = {}
  const { clock } = engine(on, { link: { approved: true }, permission, stored: { machine_key: { key: LINKED_KEY.replace('L', 'M'), apiUrl: API } } })
  await start($)
  await clock.settle()
  expect(await ads($, 'status')).toContain('· ads on')
  await ads($, 'logout')
  permission.slowMs = 30_000
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS)
  expect(await ads($, 'status')).toContain('waiting for the server')
})

test('a late "key rejected" from an old key’s ad fetch does not reject the new key', { options: NO_KEY }, async ($, on) => {
  const old = LINKED_KEY.replace('L', 'M')
  const { clock } = engine(on, { link: { approved: true }, slowAds: true, adsRejects: old, stored: { machine_key: { key: old, apiUrl: API } } })
  await start($)
  await clock.settle()
  // The old key's ad fetch is still out
  await ads($, 'logout')
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS)
  await clock.advance(3_600_000)
  expect(await ads($, 'status')).toContain(': signed in')
})

test('switched back on: ads return within 15 seconds, or at once with the next prompt', { options: KEY }, async ($, on) => {
  const permission: { serve?: boolean; reason?: string } = { serve: false, reason: 'off' }
  const { clock } = engine(on, { permission, ads: MANY })
  await start($)
  await clock.settle()
  expect(await ads($, 'status')).toContain('switched ads off')
  delete permission.serve
  await clock.advance(RECHECK_MS)
  expect(await ads($, 'status')).toContain('· ads on')
})

test('switched back on: the next prompt asks again straight away', { options: KEY }, async ($, on) => {
  const permission: { serve?: boolean; reason?: string } = { serve: false, reason: 'off' }
  const { clock, seen } = engine(on, { permission, ads: MANY })
  await start($)
  await clock.settle()
  delete permission.serve
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(seen.message).toContain('Sponsored')
})

// --- The terminal ad card: in the band above the prompt whenever the whole card fits, else the spinner line ---
let tband: any = null
const tcard = async ($: any, props: Record<string, unknown> = {}) => {
  await tband?.unmount().catch(() => {})
  tband = await $.ui.mount({ ...BAND, surface: 'terminal', requestId: 'tband', viewport: { columns: 100, rows: 40 }, props: { ...BAND.props, ...props } })
  return tband
}
const spin = ($: any) => $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: `s${Math.random()}` })
const formats = (seen: { events: unknown[] }) => seen.events.map((e: any) => [e.deliveryToken, e.format])
type CardAd = Parameters<typeof cardRows>[0]
const cardAd = (text: string, description: string | null, ctaLabel: string, clickUrl: string) => ({ text, description, ctaLabel, clickUrl }) as CardAd

test('terminal: a card that fits is drawn with the ad’s fields and counted once as a card; the spinner stays stock', { options: KEY }, async ($, on) => {
  const ads = [serverAd(1, '🚀 Try Acme DB', { description: 'Free for open source', ctaLabel: 'Try it free', theme: 'ocean' }), serverAd(2)]
  const { clock, seen } = engine(on, { ads })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await tcard($)
  await spin($)
  expect(seen.message).toBe(null)
  expect(await headline(ui)).toBe('🚀 Try Acme DB')
  expect((await ui.find({ type: 'Box' }))?.props.borderColor).toBe('#0EA5E9')
  expect((await ui.find({ type: 'Link' }))?.props.label).toBe('Try it free →')
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'card']])
})

for (const order of [['band', 'spinner'], ['spinner', 'band']] as const) test(`terminal: drawn ${order.join(' then ')}, one ad shows in one format`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  let ui: any
  for (const which of order) which === 'band' ? (ui = await tcard($)) : await spin($)
  // Redrawn as the engine would after the first draws
  await clock.advance(1)
  await spin($)
  ui = await tcard($)
  const shown = [seen.message, await headline(ui)].filter(Boolean)
  expect(shown.length).toBe(1)
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  // Drawn first as a line, the same ad switches to the card the moment the band says it fits
  expect(formats(seen)).toEqual([[token(1), 'card']])
})

for (const columns of [95, 39]) test(`terminal: an ad too long for the spinner line is ${columns > 39 ? 'shown as a card' : 'skipped in a narrow band, never cut short as a line'}`, { options: KEY }, async ($, on) => {
  // 11 + 55 + 30 = 96 cells: too wide for the line in 80 columns
  const { clock, seen } = engine(on, { ads: [serverAd(1, 'x'.repeat(55))] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 80, rows: 24 } })
  const ui = await tcard($, { bodyColumns: columns })
  await clock.advance(1)
  expect(seen.message).toBe(null)
  expect(await headline(await tcard($, { bodyColumns: columns }))).toBe(columns > 39 ? 'x'.repeat(55) : undefined)
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual(columns > 39 ? [[token(1), 'card']] : [])
  void ui
})

test('terminal: the card needs 40 columns and every one of its rows; else the line', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const rows = cardRows(toAd(serverAd(1))!, 40)
  expect(rows).toBeGreaterThan(3)
  // The band changes size, the ad on screen runs out, and the next one takes the format that fits the new size
  const shownAs = async (props: Record<string, unknown>) => {
    await tcard($, props)
    await clock.advance(SLOT_MS)
    await spin($)
    const card = await headline(await tcard($, props))
    return card ? 'card' : seen.message ? 'line' : 'none'
  }
  expect(await shownAs({ bodyColumns: 39, maxRows: 40 })).toBe('line')
  expect(await shownAs({ bodyColumns: 40, maxRows: rows - 1 })).toBe('line')
  expect(await shownAs({ bodyColumns: 40, maxRows: rows })).toBe('card')
})

test('rows are counted the way the terminal wraps, never fewer', () => {
  expect(wrapRows('aa bb', 5)).toBe(1)
  expect(wrapRows('aa bbb', 5)).toBe(2)
  expect(wrapRows('x'.repeat(12), 5)).toBe(3)
  // A word too long for the row starts a new one here; the terminal may start it on this row: never fewer rows
  expect(wrapRows('a ' + 'x'.repeat(12), 5)).toBe(4)
  // Real terminal output (Claude Code 2.1.296): 8 rows at 49 columns, 12 at 40 columns
  const plain = cardAd('Ship faster with Acme CI — 10x quicker builds for your monor', 'Cache every step, run tests in parallel, and see flaky ones flagged before they hit main.', 'Start free trial now', 'http://localhost:8787/c/abcdefghijklmnopqrstuvwxyz0123456789')
  expect(cardRows(plain, 49)).toBeGreaterThanOrEqual(8)
  const wide = cardAd('🚀 构建更快的应用程序 Acme CI ✨ supercalifragilisticexpialidocious-builds', 'café naïve résumé 日本語のテキストを折り返す ' + 'a'.repeat(55) + ' end', 'Start free trial now', 'http://localhost:8787/c/abcdefghijklmnopqrstuvwxyz0123456789')
  expect(cardRows(wide, 40)).toBeGreaterThanOrEqual(12)
  // Wide characters on an odd-width row leave its last cell empty (Codex review): 18 a row, so 37 take 3 rows
  expect(wrapRows('界'.repeat(37), 37)).toBe(3)
  expect(cardRows(cardAd('Test', '界'.repeat(37), 'Start free trial now', `http://localhost:8787/c/${token(1)}`), 41)).toBe(9)
  // Every field at its longest, in wide characters: 2 borders + 5 + 5 + 4
  expect(cardRows(cardAd('界'.repeat(60), '界'.repeat(90), '界'.repeat(20), `http://localhost:8787/c/${token(1)}`), 40)).toBe(16)
})

const MAC = { term: 'Apple_Terminal' }
test('macOS Terminal: the card’s link is a button that opens the ad’s click address in the browser; still counted once as a card', { options: KEY }, async ($, on) => {
  const ads = [serverAd(1, '🚀 Try Acme DB', { description: 'Free for open source', ctaLabel: 'Try it free', theme: 'ocean' }), serverAd(2)]
  const { clock, seen } = engine(on, { ads, ...MAC })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await tcard($)
  expect(await ui.find({ type: 'Link' })).toBe(undefined)
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('Try it free →')
  expect(seen.opened).toEqual([])
  await ui.press({ key: 'cta' })
  // Through the server's /c/ address only: that is where a click is counted
  expect(seen.opened).toEqual([['open', `http://localhost:8787/c/${token(1)}`]])
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'card']])
})

test('macOS Terminal: a link the browser could not open says so', { options: KEY }, async ($, on) => {
  const { seen } = engine(on, { ...MAC, openExit: 1 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await (await tcard($)).press({ key: 'cta' })
  expect(seen.toasts).toContain('SpinSponsor could not open the link in your browser.')
})

for (const o of [{ term: 'iTerm.app' }, { ...MAC, ssh: true }]) test(`${o.term}${o.ssh ? ' over SSH' : ''} keeps the link; only macOS Terminal on this machine gets the button`, { options: KEY }, async ($, on) => {
  engine(on, o)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await tcard($)
  expect([(await ui.find({ type: 'Link' }))?.props.label, await ui.find({ type: 'Button' })]).toEqual(['Learn more →', undefined])
})

test('macOS Terminal: the Desktop app’s card keeps its link', { options: KEY }, async ($, on) => {
  engine(on, MAC)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await card($)
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(`http://localhost:8787/c/${token(1)}`)
})

test('macOS Terminal: /ads open draws a button that opens the last ad shown', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, MAC)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await clock.advance(SLOT_MS)
  expect(await ads($, 'open')).toBe(OPEN_TEXT)
  const out = await $.ui.mount({
    plugin: 'spinsponsor',
    component: 'CommandOutput',
    requestId: 'm1',
    surface: 'terminal',
    viewport: { columns: 80, rows: 24 },
    props: { command: 'ads', args: 'open', text: OPEN_TEXT, isErrored: false },
  })
  expect(await out.find({ type: 'Link' })).toBe(undefined)
  expect((await out.find({ type: 'Button' }))?.props.label).toBe('Sponsored: Ad number 2')
  await out.press({ key: 'open' })
  expect(seen.opened).toEqual([['open', `http://localhost:8787/c/${token(2)}`]])
})

test('macOS Terminal: the card counts its button as one row, not the wrapped address', () => {
  const ad = cardAd('Test', null, 'Start free trial now', `https://staging-api.spinsponsor.com/c/${token(1)}`)
  // 80-column terminal: the label and the address take 3 rows; the button one
  expect(cardRows(ad, 76, false)).toBe(6)
  expect(cardRows(ad, 76, true)).toBe(4)
})

for (const [what, props] of [['a resize', { bodyColumns: 39 }], ['a survey arriving', { hasSurvey: true }]] as const) for (const at of [2000, SLOT_MS - 1]) test(`terminal: ${what} at ${at} ms voids the card; the same ad starts again at once as a line`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await tcard($)
  await spin($)
  await clock.advance(at)
  await tcard($, props)
  await clock.advance(1)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'line']])
})

test('terminal: a band that first draws mid-line turns the same ad into a card at once', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(2000)
  await tcard($)
  await clock.advance(1)
  expect(await headline(await tcard($))).toBe('Ad number 1')
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'card']])
})

test('terminal: with one ad, big → short → narrow → big switches card → line → stock → card, counting only the last', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: [serverAd(1, 'get your Nvidia dgx sparks now')] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // A resize redraws the spinner (its width) and the band (5 columns less; in fullscreen, the rows it has left)
  // One spinner on screen, like the terminal
  let shown: any = null
  const resize = async (columns: number, maxRows: number) => {
    const spinner = async () => {
      await shown?.unmount()
      shown = await $.ui.mount({ ...SPINNER, surface, requestId: 'spinner', viewport: { columns, rows: 20 } })
    }
    await spinner()
    await tcard($, { bodyColumns: columns - 5, maxRows })
    await clock.advance(1)
    await spinner()
    return (await headline(await tcard($, { bodyColumns: columns - 5, maxRows }))) ?? seen.message
  }
  const text = 'get your Nvidia dgx sparks now'
  expect(await resize(104, 12)).toBe(text)
  await clock.advance(2000)
  // Too short for the card's 4 rows: the line (11 + 30 + 30 = 71 columns)
  expect(await resize(104, 3)).toBe(line(surface, text))
  await clock.advance(2000)
  // Too narrow for either: the stock spinner, and the ad waits
  expect(await resize(60, 3)).toBe(null)
  await clock.advance(2000)
  expect(await resize(104, 12)).toBe(text)
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  // One view, as a card (the switches in between, including a line drawn for a moment before the band redraws, count none)
  expect(formats(seen)).toEqual([[token(1), 'card']])
})

test('terminal: no card while idle; one starts once Claude works; a turn ending at 4,999 ms counts nothing', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await headline(await tcard($, { isWorking: false }))).toBe(undefined)
  expect(await headline(await tcard($))).toBe('Ad number 1')
  await clock.advance(SLOT_MS - 1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
  expect(await ads($, 'status')).toContain('(1 partial)')
})

test('terminal: pause and logout take a card down at once and count nothing', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await tcard($)
  await clock.advance(2000)
  await ads($, 'pause')
  expect(await headline(await tcard($))).toBe(undefined)
  await ads($, 'resume')
  await clock.advance(1)
  expect(await headline(await tcard($))).toBe('Ad number 2')
  await clock.advance(2000)
  await ads($, 'logout')
  expect(await headline(await tcard($))).toBe(undefined)
  await clock.advance(SLOT_MS + FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test('band props without a usable row count turn ads off', () => {
  expect(bandPropsOk({ ...BAND.props })).toBe(true)
  expect(bandPropsOk({ ...BAND.props, maxRows: undefined })).toBe(false)
  expect(bandPropsOk({ ...BAND.props, maxRows: Infinity })).toBe(false)
})

test('terminal: a card one row too tall for the band is never shown or billed as a card (odd width, wide characters)', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: [serverAd(1, 'Test', { description: '界'.repeat(37), ctaLabel: 'Start free trial now' })] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // It needs 9 rows at 41 columns
  const ui = await tcard($, { bodyColumns: 41, maxRows: 8 })
  await spin($)
  expect(await headline(ui)).toBe(undefined)
  expect(seen.message).toBe(line(surface, 'Test'))
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'line']])
})

test('terminal: shrunk before its card first draws, an ad that fits neither way makes room for one that does', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: [serverAd(1, 'x'.repeat(55)), serverAd(2, 'Hi')] })
  await start($)
  // The wide band is measured, then taken down: the ad is chosen as a card for it but never drawn
  await (await tcard($)).unmount()
  tband = null
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 44, rows: 24 } })
  await tcard($, { bodyColumns: 39 })
  await clock.advance(1)
  expect(seen.message).toBe(line(surface, 'Hi'))
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(2), 'line']])
})

test('terminal without a band: a line too wide after a resize waits and comes back when the window widens', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: [serverAd(1, 'get your Nvidia dgx sparks now')] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  let shown: any = null
  const resize = async (columns: number) => {
    await shown?.unmount()
    shown = await $.ui.mount({ ...SPINNER, surface, requestId: 'spinner', viewport: { columns, rows: 20 } })
    await clock.advance(1)
    return seen.message
  }
  expect(await resize(120)).toBe(line(surface, 'get your Nvidia dgx sparks now'))
  await clock.advance(2000)
  expect(await resize(60)).toBe(null)
  await clock.advance(2000)
  expect(await resize(120)).toBe(line(surface, 'get your Nvidia dgx sparks now'))
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'line']])
})

for (const to of ['line', 'card'] as const) test(`terminal: the same ad restarted as a ${to} after a resize needs its own full 5 seconds`, { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // Card → line: a band too small after a resize. Line → card: the band first measured mid-line.
  if (to === 'line') await tcard($)
  await spin($)
  await clock.advance(3000)
  await tcard($, to === 'line' ? { bodyColumns: 39 } : {})
  // The replacement is first drawn at once, on the redraw this resize asked for
  if (to === 'card') await tcard($)
  else await spin($)
  expect(await ads($, 'status')).toContain('(1 partial)')
  await clock.advance(SLOT_MS - 1)
  expect(queued(store)).toEqual([])
  // Ending the turn now counts nothing
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
  expect(await ads($, 'status')).toContain('0 views counted')
})

test('terminal: a band remembered from the last turn never holds the ad back; the line shows until this turn’s band draws', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await tcard($)
  await clock.advance(SLOT_MS)
  await done($)
  await tband.unmount()
  tband = null
  // Next turn: the spinner draws first, this turn's band not yet
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.settle()
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 2'))
  await clock.advance(1000)
  // The band draws: the same ad becomes the card, with its own 5 seconds
  await tcard($)
  await clock.advance(1)
  expect(await headline(await tcard($))).toBe('Ad number 2')
  await clock.advance(SLOT_MS - 2)
  expect(queued(store).length).toBe(1)
  await clock.advance(1)
  expect(queued(store).length).toBe(2)
  await done($, 't2')
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'card'], [token(2), 'card']])
})

test('fast turns never count and never use up the ad: it comes back for a fresh 5 seconds', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: [serverAd(1)] })
  await start($)
  for (const id of ['a', 'b', 'c']) {
    await $.turn.start({ text: 'hi', turnId: id })
    await spin($)
    await clock.advance(2000)
    await done($, id)
  }
  await $.turn.start({ text: 'long', turnId: 'd' })
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS)
  await done($, 'd')
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'line']])
})

test('a permission prompt that never reaches the tool does not hold ads back in the next turn', { options: KEY }, async ($, on) => {
  const { seen } = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await dialog($)
  // Denied: no tool.call follows, and the turn ends
  await done($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('switched back on: a cached ad shows at the next draw, without waiting for a fetch', { options: KEY }, async ($, on) => {
  const permission: { status?: number } = {}
  // Two cached ads: fewer than the spares it keeps, so switching back on also fetches more
  const o: Opts = { permission, ads: [serverAd(1), serverAd(2)] }
  const { clock, seen } = engine(on, o)
  await start($)
  await clock.settle()
  // Ads are cached; then the server goes quiet and the permission runs out (cached ads are kept)
  permission.status = 503
  await clock.advance(PERMIT_MS + FLUSH_EVERY_MS)
  expect(await ads($, 'status')).toContain('no word from')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // Back, but ad fetches now hang
  o.slowAds = true
  permission.status = undefined
  await clock.advance(RECHECK_MS)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('cached ads close to expiring are replaced in time: starting an ad fetches more', { options: KEY }, async ($, on) => {
  // Four ads that expire in 5 minutes: plenty in number, but none fresh
  const soon = (n: number) => ({ ...serverAd(n), expiresAt: '2026-10-04T12:05:00.000Z' })
  const { clock, seen } = engine(on, { ads: [soon(1), soon(2), soon(3), soon(4)] })
  await start($)
  await clock.settle()
  expect(adFetches(seen)).toBe(1)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  // Fetches are at least FETCH_GAP_MS apart
  await clock.advance(FETCH_GAP_MS)
  expect(adFetches(seen)).toBe(2)
})

// --- Keeping spare ads ---
test('ads fetched while the window was too small cause no back-off: after a resize the next one is ready in time', { options: KEY }, async ($, on) => {
  // One new copy per fetch, as with a single ad left
  const { clock, seen } = engine(on, { perFetch: (n) => [serverAd(n, 'get your Nvidia dgx sparks now')] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  let shown: any = null
  const resize = async (columns: number) => {
    await shown?.unmount()
    shown = await $.ui.mount({ ...SPINNER, surface, requestId: 'spinner', viewport: { columns, rows: 20 } })
    await clock.advance(1)
    return seen.message
  }
  // Too narrow for the line (71 columns): nothing shows, but the fetched copies are kept
  expect(await resize(60)).toBe(null)
  await clock.advance(10_000)
  expect(await resize(120)).toContain('Nvidia')
  // Its 5 seconds end: another copy is already there
  await clock.advance(SLOT_MS)
  expect(seen.message).toContain('Nvidia')
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.length).toBe(2)
})

test('"too many fetches" (429) waits as long as the server asks, not the 30-second back-off', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { adsStatuses: [429], perFetch: (n) => [serverAd(n)] })
  await start($)
  await clock.settle()
  expect(adFetches(seen)).toBe(1)
  await clock.advance(6999)
  expect(adFetches(seen)).toBe(1)
  await clock.advance(1)
  expect(adFetches(seen)).toBe(2)
})

test('spares are topped up to three, one fetch every 5 seconds, then fetching stops', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { perFetch: (n) => [serverAd(n)] })
  await start($)
  await clock.settle()
  expect(adFetches(seen)).toBe(1)
  await clock.advance(FETCH_GAP_MS)
  expect(adFetches(seen)).toBe(2)
  await clock.advance(FETCH_GAP_MS)
  expect(adFetches(seen)).toBe(3)
  await clock.advance(FLUSH_EVERY_MS * 2)
  expect(adFetches(seen)).toBe(3)
  expect(await ads($, 'status')).toContain('3 ads ready')
})

test('a screen too small for every ad never fetches without limit', { options: KEY }, async ($, on) => {
  // Ten long ads per fetch, none of which fits the line in 80 columns, and no band
  const { clock, seen } = engine(on, { perFetch: (n) => Array.from({ length: 10 }, (_, i) => serverAd(n * 10 + i, 'x'.repeat(55))) })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (let i = 0; i < 60; i++) {
    await $.ui.mount({ ...SPINNER, surface, requestId: `s${i}`, viewport: { columns: 79 + (i % 2), rows: 24 } })
    await clock.advance(2000)
  }
  expect(seen.message).toBe(null)
  // At most 30 cached: 3 fetches of 10
  expect(adFetches(seen)).toBeLessThanOrEqual(3)
})

test('resizing never fetches more than once every 5 seconds', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { perFetch: (n) => [serverAd(n)] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(adFetches(seen)).toBe(1)
  // Every resize restarts the ad, and each start asks whether more ads are needed
  for (let i = 0; i < 8; i++) {
    await $.ui.mount({ ...SPINNER, surface, requestId: `s${i}`, viewport: { columns: i % 2 ? 120 : 60, rows: 24 } })
    await clock.advance(500)
  }
  expect(adFetches(seen)).toBe(1)
})

test('ads that fit nothing on this screen are not topped up', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { perFetch: (n) => [serverAd(n, 'x'.repeat(55))] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 80, rows: 24 } })
  await clock.advance(60_000)
  expect(seen.message).toBe(null)
  expect(adFetches(seen)).toBeLessThanOrEqual(2)
})

test('a resize inside the 5-second fetch gap still gets the next ad ready before this one ends', { options: KEY }, async ($, on) => {
  // The first fetch brings an ad too wide for a narrow window; later ones a copy that fits; every answer takes 0.5 s
  const ad = (n: number) => serverAd(n, 'get your Nvidia dgx sparks now')
  const { clock, seen } = engine(on, { adsDelayMs: 500, perFetch: (n) => [ad(n)] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  let shown: any = null
  const resize = async (columns: number) => {
    await shown?.unmount()
    shown = await $.ui.mount({ ...SPINNER, surface, requestId: 'spinner', viewport: { columns, rows: 20 } })
  }
  await resize(60)
  await clock.advance(1000)
  // Wider, 1.5 s after the fetch: the cached ad shows; the next fetch is due 5 s after the first answer
  await resize(120)
  await clock.advance(1)
  expect(seen.message).toContain('Nvidia')
  await clock.advance(SLOT_MS + 100)
  // The first ended and was counted; the second fetch had already brought the next copy, now on screen
  expect(adFetches(seen)).toBe(2)
  expect(seen.message).toBe(line(surface, 'get your Nvidia dgx sparks now'))
  expect(await ads($, 'status')).toContain('1 views counted')
})

test('a slow "too many fetches" answer still waits the full Retry-After from when it arrived', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { adsStatuses: [429], adsDelayMs: 4000, perFetch: (n) => [serverAd(n)] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(4000)
  expect(adFetches(seen)).toBe(1)
  // New turns meanwhile (each asks whether to fetch) can't cut the wait short
  for (let i = 0; i < 6; i++) {
    await done($, i === 0 ? 't1' : `q${i}`)
    await $.turn.start({ text: 'next', turnId: `q${i + 1}` })
    await clock.advance(1000)
  }
  // 4 s for the answer + 7 s asked = 11 s
  expect(adFetches(seen)).toBe(1)
  await clock.advance(1000)
  expect(adFetches(seen)).toBe(2)
})

test('the cache never holds more than 30 ads, whatever arrives', { options: KEY }, async ($, on) => {
  // 29 ads that fit nothing, then 10 more
  const wide = (n: number) => serverAd(n, 'x'.repeat(55))
  const { clock } = engine(on, { perFetch: (n) => (n === 1 ? Array.from({ length: 29 }, (_, i) => wide(100 + i)) : Array.from({ length: 10 }, (_, i) => wide(200 + n * 10 + i))) })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 80, rows: 24 } })
  // New turns ask for more each time
  for (let i = 0; i < 6; i++) {
    await clock.advance(FETCH_GAP_MS)
    await done($, i === 0 ? 't1' : `r${i}`)
    await $.turn.start({ text: 'next', turnId: `r${i + 1}` })
    await clock.settle()
  }
  expect(await ads($, 'status')).toMatch(/· 30 ads ready/)
})

test('an ad put back at a turn’s end never takes the cache past 30', { options: KEY }, async ($, on) => {
  // First: one ad, then 29 that fit nothing; later fetches: 10 more that fit nothing
  const wide = (n: number) => serverAd(n, 'x'.repeat(55))
  const { clock } = engine(on, { perFetch: (n) => (n === 1 ? [serverAd(1), ...Array.from({ length: 29 }, (_, i) => wide(100 + i))] : Array.from({ length: 10 }, (_, i) => wide(200 + n * 10 + i))) })
  await start($)
  await clock.settle()
  // The screen is measured (80 columns), then the spinner is gone
  await (await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 80, rows: 24 } })).unmount()
  // The first ad is taken for this turn (never drawn); spares are low, so the next fetch fills the cache to 30
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(FETCH_GAP_MS + 1000)
  expect(await ads($, 'status')).toContain('· 30 ads ready')
  // The turn ends: its ad goes back to the front, and the newest beyond 30 goes
  await done($)
  expect(await ads($, 'status')).toContain('· 30 ads ready')
})

test('terminal: the band drawing this turn’s “working” just before the turn starts still gets the card at once', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY })
  await start($)
  await clock.settle()
  // Too narrow for the line; the band says Claude works before the turn's start reaches the Mod
  await $.ui.mount({ ...SPINNER, surface, viewport: { columns: 52, rows: 27 } })
  // ...and doesn't draw again until later (taken down here so nothing can redraw it meanwhile)
  await (await tcard($, { bodyColumns: 47, maxRows: 27 })).unmount()
  tband = null
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  // The ad is already chosen as the card, ready for the band's next draw
  expect(await ads($, 'status')).toContain('· ad now: card, waiting to draw')
  expect(await headline(await tcard($, { bodyColumns: 47, maxRows: 27 }))).toBe('Ad number 1')
  expect(await ads($, 'status')).toContain('· ad now: card, on screen')
  await clock.advance(SLOT_MS)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(formats(seen)).toEqual([[token(1), 'card']])
})

test('after a turn ends, a band remembered as working no longer claims the next ad', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await tcard($)
  await done($)
  await tband.unmount()
  tband = null
  expect(await ads($, 'status')).not.toContain(', working')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.settle()
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a call the auto-mode classifier approves (no dialog) never hides the ad while the tool runs', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  // Needs asking, but no dialog opens; the tool then runs for 8 seconds
  await $.tool.check({ tool: 'WebFetch', input: { url: 'https://example.com' }, tool_use_id: 'w1' })
  await clock.advance(SLOT_MS)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
  await clock.advance(3000)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.length).toBe(1)
})

test('a dialog voids the ad on screen and holds ads back until the tool is answered', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(2000)
  await dialog($)
  await clock.advance(SLOT_MS)
  await spin($)
  expect(seen.message).toBe(null)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

test('a permission request a hook answers opens no dialog and never hides the ad', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, hookAnswersDialog: true })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await dialog($)
  await clock.advance(SLOT_MS)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.length).toBe(1)
})

// --- Dialogs (Codex review of 0.2.23) ---
test('the ad is hidden as soon as a permission request starts, even while slow hooks run before the dialog', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, dialogHookMs: 4000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(2000)
  // The dialog opens while the PermissionRequest hooks are still running (4 s)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'u1' })
  void $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } }).catch(() => {})
  await clock.advance(3000)
  // The ad that was on screen 2 s before never counts
  expect(queued(store)).toEqual([])
  await spin($)
  expect(seen.message).toBe(null)
  expect(await ads($, 'status')).toContain('dialogs open: 1')
  // The request's slow hook ends inside the test, not after it (a request still running at the end made the suite fail on a loaded machine)
  await clock.advance(1000)
  await clock.settle()
})

test('an MCP server’s question hides the ad until it is answered; the ad then starts afresh', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(2000)
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which repo?', elicitation_id: 'e1' })
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(SLOT_MS)
  expect(queued(store)).toEqual([])
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', elicitation_id: 'e1', action: 'accept' })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
})

test('a background agent’s dialog outlives the main turn, and ends with that agent’s turn', { options: KEY }, async ($, on) => {
  const { seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'deploy' }, agent_id: 'bg1' })
  await done($)
  // The next main turn: the background agent's dialog is still open
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toBe(null)
  // The background agent finishes
  await $.turn.complete({ turnId: 'bg-turn', agentId: 'bg1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a dialog for one tool doesn’t also hold back an unrelated tool still being decided', { options: KEY }, async ($, on) => {
  engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.check({ tool: 'WebFetch', input: { url: 'https://example.com' }, tool_use_id: 'w1' })
  await dialog($, 'u2')
  expect(await ads($, 'status')).toContain('dialogs open: 1')
})

test('an ad cut short by a dialog is not used up: it shows again, afresh, once the dialog closes', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: [serverAd(1)] })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(2000)
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which repo?', elicitation_id: 'e1' })
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', elicitation_id: 'e1', action: 'accept' })
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  // A fresh 5 seconds: nothing at 4,999 ms, one view at 5,000
  await clock.advance(SLOT_MS - 1)
  expect(queued(store)).toEqual([])
  await clock.advance(1)
  expect(queued(store).length).toBe(1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.length).toBe(1)
})

const dialogsOpen = async ($: any) => Number((await ads($, 'status')).match(/dialogs open: (\d+)/)?.[1] ?? 0)

test('two MCP questions without ids each need their own answer', { options: KEY }, async ($, on) => {
  engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which repo?' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which branch?' })
  expect(await dialogsOpen($)).toBe(2)
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', action: 'accept' })
  expect(await dialogsOpen($)).toBe(1)
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', action: 'accept' })
  expect(await dialogsOpen($)).toBe(0)
})

test('a hook answering one permission request doesn’t release another dialog still open', { options: KEY }, async ($, on) => {
  const { seen } = engine(on, { ads: MANY, answerCommand: 'ls' })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'a' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'b' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } })
  // Answered by a hook: no dialog for this one
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(await dialogsOpen($)).toBe(1)
  await spin($)
  expect(seen.message).toBe(null)
})

test('a background agent’s dialog closes when its own tool call settles, not when the main turn ends', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, toolMs: 10_000, loopCheckAllows: true })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // The background agent's Bash call runs for 10 s; its permission dialog opens inside it (as in a real session:
  // the call starts, its check asks, the dialog opens; the kit can't hold a dialog open, so the test opens it)
  const call = $.tool.call({ tool: 'Bash', command: 'deploy', tool_use_id: 'c1', agentId: 'bg1' } as any)
  await clock.advance(1)
  await $.tool.check({ tool: 'Bash', input: { command: 'deploy' }, tool_use_id: 'c1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'deploy' }, agent_id: 'bg1' })
  await done($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(10_000)
  await call
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('an MCP question left open when its agent’s turn ends is released then', { options: KEY }, async ($, on) => {
  const { seen } = engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which repo?', elicitation_id: 'q', agent_id: 'bg1' })
  await $.turn.complete({ turnId: 'bg-turn', agentId: 'bg1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted', usage: null })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('after a reload with dialogs saved as open, ads are off for the session, with one message', { options: KEY }, async ($, on) => {
  // What an earlier load of the Mod saved: a background agent's dialog
  const { seen, state } = engine(on, { ads: MANY, dialogs: { 'perm:7': 'bg1' } })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
  // Kept as saved, so a later reload in this session stays off too
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: '?', elicitation_id: 'e9' })
  expect(state.get('dialogs')).toEqual({ 'perm:7': 'bg1' })
  // Neither the main turn's end nor that agent's releases it
  await done($)
  await $.turn.complete({ turnId: 'bg-turn', agentId: 'bg1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toBe(null)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
  expect(await ads($, 'status')).toContain('restart Claude Code')
})

test('saved state that can’t be read turns ads off for the session, with one message', { options: KEY }, async ($, on) => {
  const { seen } = engine(on, { ads: MANY, stateGetFails: true })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
})

test('a failed save is tried again with the open dialog', { options: KEY }, async ($, on) => {
  const { clock, state } = engine(on, { ads: MANY, firstStateSetFails: true })
  // Opened before startup, so the one save that carries it is startup's, which fails
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: '?', elicitation_id: 'b' })
  await start($)
  expect(state.has('dialogs')).toBe(false)
  await clock.advance(10_000)
  await clock.settle()
  expect(Object.keys(state.get('dialogs') as Record<string, string>)).toEqual(['elicit:main|hf|b'])
})

test('dialogs opened and closed before startup has read the saved state don’t overwrite it', { options: KEY }, async ($, on) => {
  const { seen } = engine(on, { ads: MANY, dialogs: { 'perm:7': 'bg1' } })
  // No session.start yet (as after some reloads): a question opens and closes first
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: '?', elicitation_id: 'e1' })
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', elicitation_id: 'e1', action: 'accept' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
})

test('a slow save can’t land over a newer one', { options: KEY }, async ($, on) => {
  const { clock, state } = engine(on, { ads: MANY, slowFirstStateSetMs: 3000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: '?', elicitation_id: 'a' })
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', elicitation_id: 'a', action: 'accept' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: '?', elicitation_id: 'b' })
  await clock.advance(3000)
  await clock.settle()
  expect(Object.keys(state.get('dialogs') as Record<string, string>)).toEqual(['elicit:main|hf|b'])
})

test('an MCP question a hook blocks leaves no stale place in the queue', { options: KEY }, async ($, on) => {
  engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'blocked' })
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which repo?' })
  expect(await dialogsOpen($)).toBe(1)
  await $.classic.ElicitationResult({ mcp_server_name: 'hf', action: 'accept' })
  expect(await dialogsOpen($)).toBe(0)
})

test('a background agent’s dialog is not closed by a main-loop call of the same tool finishing', { options: KEY }, async ($, on) => {
  engine(on, { ads: MANY })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'm1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'deploy' }, agent_id: 'bg1' })
  // The main loop's Bash call finishes; the background agent's dialog is still open
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'm1' } as any)
  expect(await dialogsOpen($)).toBe(1)
})

test('signed out: a session paused by a reload shows no message about earning, until the machine is linked', { options: NO_KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, dialogs: { 'perm:7': 'bg1' }, link: { approved: true } })
  await start($)
  await clock.settle()
  expect(seen.toasts.some((t) => t.includes('Restart Claude Code'))).toBe(false)
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
})

test('a failed read of the saved state is written down, so a later reload stays off too', { options: KEY }, async ($, on) => {
  const { state } = engine(on, { ads: MANY, stateGetFails: true })
  await start($)
  expect(Object.keys((state.get('dialogs') as Record<string, string>) ?? {}).length).toBeGreaterThan(0)
})

test('the "restart" message is never swallowed by another message, and status names it first', { options: NO_KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, dialogs: { 'perm:7': 'bg1' }, link: { approved: true } })
  await start($)
  await clock.settle()
  // Another compatibility message first: this Claude Code draws differently
  await $.ui.mount({ ...SPINNER, surface: 'terminal', requestId: 'odd', props: { ...SPINNER.props, mode: 'dancing' } })
  await ads($, 'login')
  await clock.advance(LINK_POLL_MS)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
  expect(await ads($, 'status')).toContain('restart Claude Code to see ads again')
})

// --- Commands: no ad is shown or counted while Claude runs one (docs/SANDBOX-PROMPT-VIEWS-PLAN.md) ---
// Claude Code gives a Mod no signal for a sandbox network prompt, which covers the ad while a command runs. So a Bash or Monitor
// call holds ads from its tool.call to its end (a sandboxed command is `allow`, with no dialog: the hold cannot wait for one), and a
// command left running in the background holds them for BACKGROUND_HOLD_MS after it starts. Every test goes through $.tool.call.
const run = ($: any, id: string, o: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command: 'curl -sI https://example.org', tool_use_id: id, ...o } as any)
const background = ($: any, id: string, o: Record<string, unknown> = {}) => run($, id, { run_in_background: true, ...o })
const watch = ($: any, id: string) => $.tool.call({ tool: 'Monitor', command: 'tail -f log', description: 'watch', timeout_ms: 60_000, tool_use_id: id } as any)
// A command's whole run, from start to answer
const during = async (clock: { advance: (ms: number) => Promise<unknown> }, call: Promise<unknown>, ms: number) => {
  await clock.advance(ms)
  await call
}
const finished = ($: any, agentId: string) => $.turn.complete({ turnId: `${agentId}-turn`, agentId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null })
const cmdStatus = async ($: any) => (await ads($, 'status')).match(/commands running: \d+ · held back by commands: \d+ s · ad slots cut short: \d+/)?.[0]

test('a command that starts while an ad is on screen voids it; after the call the ad starts afresh and counts once', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 8000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(2000)
  const call = run($, 'c1')
  await clock.advance(SLOT_MS)
  await spin($)
  expect(seen.message).toBe(null)
  expect(queued(store)).toEqual([])
  await during(clock, call, 3000)
  await spin($)
  // The ad cut short comes back, afresh: nothing at 4,999 ms, one view at 5,000
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS - 1)
  expect(queued(store)).toEqual([])
  await clock.advance(1)
  expect(queued(store).length).toBe(1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.length).toBe(1)
  expect(seen.bad).toEqual([])
})

test('a short command ends before the slot would; with nothing redrawing, only the hold can stop that view', { options: KEY }, async ($, on) => {
  // Nothing redraws after the unmount, so no render hook can void the slot and the timer's own check sees no command
  // at second 5: only the hold's own voiding (at second 2) stands between this slot and a billed view
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 1000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const ui = await spin($)
  await ui.unmount()
  await clock.advance(2000)
  const call = run($, 'c1')
  await during(clock, call, 1000)
  await clock.advance(SLOT_MS * 2)
  expect(queued(store)).toEqual([])
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events).toEqual([])
})

// startSlot waits on a clock read before it takes an ad. A wildcard hook holds that read back (the kit's own clock owns clock.now),
// as a busy engine could, so a command can start, and end, while it is suspended.
function gatedClock(on: Parameters<Parameters<typeof test>[1]>[1]) {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let closed = false
  on('*', async ($, e, next) => {
    if (closed && next.is('clock.now', e)) await gate
    return next(e)
  })
  return { close: () => (closed = true), open }
}
const adNow = async ($: any) => (await ads($, 'status')).match(/ad now: [^·]*/)?.[0].trim()

test('a command that starts while the next ad is being queued, and is still running when that resumes: no slot is taken', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 3000 })
  const g = gatedClock(on)
  await start($)
  // Startup's own permission check and ad fetch finish first: with them held back too, startSlot would return before its clock read
  await clock.settle()
  g.close()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = run($, 'c1')
  await clock.advance(1000)
  g.open()
  await clock.settle()
  // The suspended startSlot has resumed into a running command: nothing is queued, nothing drawn
  expect(await adNow($)).toBe('ad now: none')
  await spin($)
  expect(seen.message).toBe(null)
  await during(clock, call, 2000)
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
})

test('a command that starts and ends while the next ad is being queued: one slot afterwards, counted once', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 1000 })
  const g = gatedClock(on)
  await start($)
  // Startup's own permission check and ad fetch finish first: with them held back too, startSlot would return before its clock read
  await clock.settle()
  g.close()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = run($, 'c1')
  await during(clock, call, 1000)
  // Both the turn's and the command's end's waiting reads resume now; only the newer may take an ad
  g.open()
  await clock.settle()
  expect(await adNow($)).toBe('ad now: line, waiting to draw')
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e: any) => e.deliveryToken)).toEqual([token(1)])
})

for (const order of ['the dialog first', 'the command first'] as const) test(`a dialog and a command overlap: the ad returns only when both are gone (${order})`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 4000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(1000)
  const call = run($, 'c1')
  await clock.advance(1000)
  await $.classic.Elicitation({ mcp_server_name: 'hf', message: 'Which repo?', elicitation_id: 'e1' })
  const answer = () => $.classic.ElicitationResult({ mcp_server_name: 'hf', elicitation_id: 'e1', action: 'accept' })
  if (order === 'the dialog first') {
    await answer()
    await spin($)
    expect(seen.message).toBe(null)
    await during(clock, call, 4000)
  } else {
    await during(clock, call, 4000)
    await spin($)
    expect(seen.message).toBe(null)
    await answer()
  }
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a subagent’s command keeps holding after the main turn completes, and ends with its call', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 20_000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = run($, 'c1', { agentId: 'bg1' })
  await clock.advance(1)
  await done($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toBe(null)
  await during(clock, call, 20_000)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('an auto-approved Bash call holds (no dialog needed); a WebFetch call does not', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 8000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  const fetching = $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x', tool_use_id: 'w1' } as any)
  await clock.advance(SLOT_MS)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
  expect(queued(store).length).toBe(1)
  await during(clock, fetching, 3000)
  const call = run($, 'c1')
  await clock.advance(1)
  await spin($)
  expect(seen.message).toBe(null)
  expect(await dialogsOpen($)).toBe(0)
  await during(clock, call, 8000)
})

test('Monitor holds like a command', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 3000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(2000)
  const call = watch($, 'm1')
  await clock.advance(1)
  await spin($)
  expect(seen.message).toBe(null)
  await during(clock, call, 2999)
  await clock.advance(SLOT_MS)
  expect(queued(store)).toEqual([])
})

// --- Boundaries ---
test('a command that starts 1 ms before the slot’s end voids it', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 100 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(SLOT_MS - 1)
  const call = run($, 'c1')
  await clock.advance(1)
  expect(queued(store)).toEqual([])
  await during(clock, call, 99)
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS - 1)
  expect(queued(store)).toEqual([])
  await clock.advance(1)
  expect(queued(store).length).toBe(1)
})

test('a command that ends exactly as the ad is first drawn doesn’t void it: a fresh 5 seconds from then', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 2000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = run($, 'c1')
  await during(clock, call, 2000)
  await spin($)
  expect(seen.message).toBe(line(surface, 'Ad number 1'))
  await clock.advance(SLOT_MS - 1)
  expect(queued(store)).toEqual([])
  await clock.advance(1)
  expect(queued(store).length).toBe(1)
})

test('a command already running when the ad would first draw: the ad doesn’t start until it ends', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 4000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = run($, 'c1')
  await clock.advance(1000)
  await spin($)
  expect(seen.message).toBe(null)
  // Nothing drawn or counted while it runs (to second 4); the ad starts when it ends, and needs its own 5 seconds from then
  await during(clock, call, 3000)
  expect(queued(store)).toEqual([])
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
  await clock.advance(SLOT_MS - 1)
  expect(queued(store)).toEqual([])
  await clock.advance(1)
  expect(queued(store).length).toBe(1)
})

test('two overlapping commands: the hold lasts until both have ended', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 4000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const first = run($, 'c1')
  await clock.advance(2000)
  const second = run($, 'c2')
  // The first ended at 4 s; the second runs to 6 s
  await clock.advance(2500)
  await first
  await spin($)
  expect(seen.message).toBe(null)
  await during(clock, second, 1500)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a subagent’s command holds the shared screen; an agent that ends with a call never answered releases it', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 3_600_000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  // The call is never answered; the kit ends it with the test, and that must not count as a failure of the file
  void run($, 'c1', { agentId: 'bg1' }).catch(() => {})
  await clock.advance(1)
  await spin($)
  expect(seen.message).toBe(null)
  await finished($, 'bg1')
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

for (const [how, o] of [['throws', { toolThrows: true }], ['is denied', { toolDenies: true }]] as const) test(`a command that ${how} releases its hold, and the next turn is not held`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 1000, ...o })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  const call = run($, 'c1').catch(() => {})
  await during(clock, call, 1000)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
  await done($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a command interrupted with Esc (its call never answers) releases its hold when the turn ends', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 3_600_000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  void run($, 'c1').catch(() => {})
  await clock.advance(1000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: true, reason: 'aborted', usage: null })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a running command is not saved as a dialog: the session state holds no command markers', { options: KEY }, async ($, on) => {
  const { clock, state } = engine(on, { ads: MANY, check: 'allow', toolMs: 8000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = run($, 'c1')
  const bg = background($, 'c2', { agentId: 'bg1' })
  await clock.advance(1000)
  await clock.settle()
  expect(Object.keys((state.get('dialogs') as Record<string, string>) ?? {})).toEqual([])
  // Nothing else of the command is kept either: the session state is the dialogs' and the session marker, no more
  expect([...state.keys()].sort()).toEqual(['dialogs', 'started'])
  expect(JSON.stringify([...state.values()])).not.toMatch(/c1|c2|bg1|curl/)
  await during(clock, Promise.all([call, bg]), 7000)
})

// --- Background commands: a window, because the engine never says when they end ---
test('a command left running in the background holds ads for 120 seconds from its start, just inside and just outside', { options: KEY }, async ($, on) => {
  expect(BACKGROUND_HOLD_MS).toBe(120_000)
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 300 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  await clock.advance(1000)
  const call = background($, 'b1')
  await during(clock, call, 300)
  await clock.advance(60_000)
  await spin($)
  expect(seen.message).toBe(null)
  // 1 s + 120 s from the start; now at 61.3 s
  await clock.advance(BACKGROUND_HOLD_MS - 60_300 - 1)
  await spin($)
  expect(seen.message).toBe(null)
  expect(queued(store)).toEqual([])
  await clock.advance(1)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('the known leftover: after the window ends, a view counts (the P0 is “reduced, not closed”; change this with the window)', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 300 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = background($, 'b1')
  await during(clock, call, 300)
  await clock.advance(BACKGROUND_HOLD_MS - 300)
  await spin($)
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.length).toBe(1)
})

test('each new background start restarts the 120 seconds', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 300 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await during(clock, background($, 'b1'), 300)
  await clock.advance(60_000 - 300)
  await during(clock, background($, 'b2'), 300)
  // 60 s + 120 s from the second start
  await clock.advance(BACKGROUND_HOLD_MS - 300 - 1)
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(1)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('Monitor starts the same window', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 300 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await during(clock, watch($, 'm1'), 300)
  await clock.advance(BACKGROUND_HOLD_MS - 300 - 1)
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(1)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('the window survives its call’s end, a subagent’s end and the turn’s end: the next turn is held too', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 300 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await during(clock, background($, 'b1', { agentId: 'bg1' }), 300)
  await finished($, 'bg1')
  await spin($)
  expect(seen.message).toBe(null)
  await done($)
  await clock.advance(10_000)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(BACKGROUND_HOLD_MS - 10_300)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a foreground command never opens the window: the ad is back as soon as it ends', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 300 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await during(clock, run($, 'c1'), 300)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

// Codex round 2: a Bash call that starts in the foreground can end up in the background (Ctrl+B, its timeout, a message queued for the
// model). It returns while the process lives on, so its result is the only sign: the window starts as the call returns
const bashOut = (extra: Record<string, unknown>) => ({ stdout: '', stderr: '', interrupted: false, ...extra })
// Each sign alone: the engine sets them together, and a window missed is a view that can count under a prompt
for (const [how, extra] of [
  ['the user pressed Ctrl+B', { backgroundedByUser: true }],
  ['it hit its timeout', { timedOutAfterMs: 2000 }],
  ['a message queued for the model moved it', { backgroundedToDeliverMessage: true }],
  ['a turn abort moved it', { backgroundedByTurnAbort: true }],
] as const) test(`a foreground command that went to the background (${how}) opens the window as its call returns`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 3000, toolResult: bashOut(extra) })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  const call = run($, 'c1')
  await during(clock, call, 3000)
  // 120 s from the moment the call returned (3 s in), not from its start
  await clock.advance(BACKGROUND_HOLD_MS - 1)
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(1)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a foreground command that finished (a result with no background task) opens no window', { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, check: 'allow', toolMs: 300, toolResult: bashOut({ exitCode: 0 }) })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await during(clock, run($, 'c1'), 300)
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

// --- Exact tracking (Mod 0.2.37): a background command the engine itself tracks holds ads until the engine says it ended ---
// Claude Code registers each background command and names it in the call's result (Bash: backgroundTaskId, Monitor: taskId). The input
// of classic.Stop and classic.SubagentStop lists what is still running (`background_tasks`, a snapshot of the whole session): a task that
// ended, failed or was stopped is gone from the next one. A completion notice (a UserMessage row with `task`) is a faster hint. The hold
// ends only on that evidence, never on a timer, a call's end, a subagent's end or a turn's end (probe on engine 2.1.310, plan "Decided" 7).
const taskOf = (callId: string) => `task-${callId}`
// What the engine's result says of a call that went to the background: the task's name. A foreground call names none.
const named = (e: { tool: string; tool_use_id?: string; run_in_background?: boolean }) =>
  e.tool === 'Monitor' ? { taskId: taskOf(e.tool_use_id!), timeoutMs: 60_000, persistent: false } : e.run_in_background ? bashOut({ backgroundTaskId: taskOf(e.tool_use_id!) }) : bashOut({ exitCode: 0 })
const listed = (...ids: string[]) => ids.map((id) => ({ id, type: 'shell', status: 'running', description: 'a background command' }))
// `tasks` left out: the Stop input has no background_tasks field at all
const stopWith = ($: any, tasks?: unknown) => $.classic.Stop({ stop_hook_active: false, ...(tasks === undefined ? {} : { background_tasks: tasks }) })
const subStopWith = ($: any, tasks?: unknown, agentId = 'sub1') =>
  $.classic.SubagentStop({ stop_hook_active: false, agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: '/t', ...(tasks === undefined ? {} : { background_tasks: tasks }) })
// `status` null: a notice whose task names no status
const notice = ($: any, id: string, status: string | null = 'completed', kind = 'task-notification') =>
  $.ui.mount({ plugin: 'spinsponsor', component: 'UserMessage', surface: 'terminal', requestId: `n${Math.random()}`, props: { text: 'Background command finished', origin: { kind }, isExpanded: false, task: status === null ? { id } : { id, status } } })
const tracked = async ($: any) => Number((await ads($, 'status')).match(/background commands tracked: (\d+)/)?.[1])
const adShown = async ($: any, seen: { message: string | null }) => {
  await spin($)
  return (seen.message ?? '').startsWith('Sponsored: ')
}
// A session an ad is showing in, ready for the first background call
async function afterStart($: any, on: Parameters<Parameters<typeof test>[1]>[1], o: Opts = {}) {
  const e = engine(on, { ads: MANY, check: 'allow', toolMs: 300, resultFor: named, ...o })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  return e
}

test('a background command the engine tracks holds ads until a Stop snapshot lacks it: not at 120 s, not at 10 minutes, not on a snapshot that still lists it', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  expect(await tracked($)).toBe(1)
  // The old fixed window has long ended
  await clock.advance(BACKGROUND_HOLD_MS)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(10 * 60_000)
  await stopWith($, listed(taskOf('b1')))
  expect(await adShown($, seen)).toBe(false)
  expect(await tracked($)).toBe(1)
  // Nothing was counted in all that time: not waiting to be sent, and not sent either
  expect(queued(store)).toEqual([])
  expect(seen.events).toEqual([])
  // It ends: the next snapshot lacks it. A fresh 5 seconds, then one view
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
  expect(queued(store)).toEqual([])
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
  // Both Stops reached the engine
  expect(seen.stops).toEqual(['main', 'main'])
})

test('a command that ends after 10 seconds gives the ads back at its next snapshot, long before 120 seconds', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(10_000)
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, [])
  expect(await adShown($, seen)).toBe(true)
})

test('on release the next ad is queued at once, without waiting for a redraw', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  expect(await adNow($)).toBe('ad now: none')
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, [])
  await clock.settle()
  // The mounted spinner is redrawn by the slot's invalidate (a real terminal does the same on its next draw)
  expect(await adNow($)).toMatch(/^ad now: line/)
})

test('Monitor: its result names the task (taskId); it holds the same way and ends on the snapshot', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, watch($, 'm1'), 300)
  expect(await tracked($)).toBe(1)
  await clock.advance(10 * 60_000)
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, listed(taskOf('m1')))
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, [])
  expect(await adShown($, seen)).toBe(true)
})

test('several tasks at once: each ends on its own; ads wait for the last', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await during(clock, watch($, 'm1'), 300)
  await during(clock, background($, 'b2'), 300)
  expect(await tracked($)).toBe(3)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, listed(taskOf('b1'), taskOf('m1'), taskOf('b2')))
  expect(await tracked($)).toBe(3)
  // b1 and b2 ended; the Monitor runs on
  await stopWith($, listed(taskOf('m1')))
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
  // A snapshot that lists some other task changes nothing
  await stopWith($, listed('somebody-elses'))
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
})

test('a snapshot that lists a different task releases nothing it does not list, and one that lists the task keeps it', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await during(clock, background($, 'b2'), 300)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, listed(taskOf('b2'), 'other'))
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
})

test('a subagent’s background command holds past its call, its agent’s end and the turn’s end; only a snapshot that lacks it ends it', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1', { agentId: 'bg1' }), 300)
  await finished($, 'bg1')
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
  await done($)
  await clock.advance(10 * 60_000)
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
  // A subagent's own Stop sees the whole session's list: still listed, still held
  await subStopWith($, listed(taskOf('b1')), 'bg1')
  expect(await adShown($, seen)).toBe(false)
  await subStopWith($, [], 'bg1')
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
  expect(seen.stops).toEqual(['bg1', 'bg1'])
})

test('a main Stop releases a task a subagent started', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1', { agentId: 'bg1' }), 300)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, [])
  expect(await adShown($, seen)).toBe(true)
})

// A snapshot is built a moment before the Mod gets it: one built before a task was registered can arrive after the Mod recorded it
test('a snapshot that lacks a task recorded moments ago may predate it: it releases nothing until SNAPSHOT_GRACE_MS has passed', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  // Recorded as its call returns, 300 ms in
  await during(clock, background($, 'b1'), 300)
  await stopWith($, [])
  await subStopWith($, [])
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(SNAPSHOT_GRACE_MS - 1)
  await stopWith($, [])
  expect(await tracked($)).toBe(1)
  await clock.advance(1)
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
})

test('the grace is each task’s own: an old task is released by a snapshot that still keeps a young one', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await during(clock, background($, 'b2'), 300)
  await stopWith($, [])
  expect(await tracked($)).toBe(1)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
})

test('a completion notice is not held to the grace: the engine said the task ended', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await notice($, taskOf('b1'))
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
})

// A Stop with no list, on an engine that has sent one before, is a lapse: the tasks stay tracked, and the next list decides (Codex review)
test('a Stop without a list after a readable one keeps the tracked task; the next list that lacks it releases it', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  // Nothing tracked yet, but the engine has shown it sends lists
  await stopWith($, [])
  await during(clock, background($, 'b1'), 300)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($)
  await stopWith($, null)
  await subStopWith($)
  expect(await tracked($)).toBe(1)
  expect(await ads($, 'status')).not.toContain('background window open')
  await clock.advance(BACKGROUND_HOLD_MS * 2)
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, listed(taskOf('b1')))
  expect(await tracked($)).toBe(1)
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
})

test('a readable list from a subagent’s Stop also shows the engine sends lists', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await subStopWith($, [])
  await during(clock, background($, 'b1'), 300)
  await stopWith($)
  expect(await tracked($)).toBe(1)
})

// A first Stop with no list, before the engine has sent one, hands the task to the window; a later list that still shows it brings it back
test('a task handed to the window by a first Stop without a list is tracked again when a later list still shows it', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(30_000)
  await stopWith($)
  expect(await tracked($)).toBe(0)
  await clock.advance(30_000)
  await stopWith($, listed(taskOf('b1')))
  expect(await tracked($)).toBe(1)
  // Past the window, and the list's word still stands
  await clock.advance(BACKGROUND_HOLD_MS * 2)
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
})

// Codex round 3: the grace travels with the task through the hand-over and back
test('a task handed to the window inside its grace is not forgotten by a stale list; one old enough is', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(1000)
  await stopWith($)
  // Not old enough yet: a list without it is no word on it
  await stopWith($, [])
  await clock.advance(30_000)
  await stopWith($, listed(taskOf('b1')))
  expect(await tracked($)).toBe(1)
  // And once it is old enough, a list without it releases it
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
})

test('a task brought back inside its grace is still held to it', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(1000)
  await stopWith($)
  await stopWith($, listed(taskOf('b1')))
  expect(await tracked($)).toBe(1)
  await stopWith($, [])
  expect(await tracked($)).toBe(1)
  await clock.advance(SNAPSHOT_GRACE_MS)
  // Old enough now, and a list that still shows it must not make it young again
  await stopWith($, listed(taskOf('b1')))
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
})

test('a task the window held that the next list does not show is forgotten for good', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await stopWith($)
  // Old enough by now for a list's silence to count
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, [])
  await stopWith($, listed(taskOf('b1')))
  expect(await tracked($)).toBe(0)
})

test('a completion notice for a task the window held forgets it too', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await stopWith($)
  await notice($, taskOf('b1'))
  await stopWith($, listed(taskOf('b1')))
  expect(await tracked($)).toBe(0)
})

test('a task brought back after its window ended voids the ad on screen', { options: KEY }, async ($, on) => {
  const { clock, seen, store } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await stopWith($)
  await clock.advance(BACKGROUND_HOLD_MS)
  expect(await adShown($, seen)).toBe(true)
  await clock.advance(2000)
  await stopWith($, listed(taskOf('b1')))
  expect(await adNow($)).toBe('ad now: none')
  await clock.advance(SLOT_MS * 2)
  expect(queued(store)).toEqual([])
  expect(await adShown($, seen)).toBe(false)
  // The time held counts again from the moment it came back: 120.3 s in the window, then the 10 s above
  await stopWith($, [])
  await clock.advance(30_000)
  expect(await cmdStatus($)).toMatch(/held back by commands: 130 s/)
})

// The engine's notice can be drawn before the call that names the task has returned (a notice is delivered into a running turn too)
test('a task whose completion notice was drawn before its call returned is not held', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  const call = background($, 'b1')
  await notice($, taskOf('b1'))
  await during(clock, call, 300)
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
})

test('no call, subagent or turn ending releases a tracked command, however long it all takes', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await during(clock, run($, 'c1', { agentId: 'bg2' }), 300)
  await finished($, 'bg2')
  await done($)
  await clock.advance(60 * 60_000)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await during(clock, run($, 'c2'), 300)
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
})

// An engine that sends no list (or one this Mod cannot read) leaves nothing to end the hold on: the old rule, 120 seconds, from that Stop
for (const [what, tasks] of [['has no background_tasks field', undefined], ['has null for it', null], ['has something that is not a list', 'none'], ['lists entries with no id', [{ type: 'shell', status: 'running' }]], ['lists an entry whose id is not text', [{ id: 7 }]]] as const) test(`a Stop that ${what} is not an empty list: nothing is released at once, and the 120-second rule runs from it`, { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(30_000)
  await stopWith($, tasks)
  expect(await adShown($, seen)).toBe(false)
  expect(await tracked($)).toBe(0)
  expect(await ads($, 'status')).toContain('background window open')
  await clock.advance(BACKGROUND_HOLD_MS - 1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(1)
  expect(await adShown($, seen)).toBe(true)
})

test('a subagent’s Stop without a list is ignored: the tracked command stays tracked', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await subStopWith($)
  await subStopWith($, 'none')
  await clock.advance(BACKGROUND_HOLD_MS * 2)
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
})

test('a Stop while nothing is tracked changes nothing', { options: KEY }, async ($, on) => {
  const { seen } = await afterStart($, on)
  // No list yet on this engine, and nothing tracked: nothing to hand to a window
  await stopWith($)
  expect(await ads($, 'status')).not.toContain('background window open')
  await stopWith($, listed('whatever'))
  expect(await adShown($, seen)).toBe(true)
  expect(await ads($, 'status')).not.toContain('background window open')
})

// The completion notice: a faster hint than the next Stop, for a wake-up turn
for (const status of ['completed', 'failed', 'killed']) test(`a ${status} notice for a tracked task gives the ads back at once, before any Stop`, { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await done($)
  // The command ends; the engine starts a turn of its own and draws the notice
  await clock.advance(60_000)
  await $.turn.start({ text: '', turnId: 't2' })
  expect(await adShown($, seen)).toBe(false)
  const ui = await notice($, taskOf('b1'), status)
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(true)
  // The row is drawn as it was
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('Background command finished')
})

for (const [what, id, status, kind] of [
  ['a notice for another task', 'task-other', 'completed', 'task-notification'],
  ['a notice that is not about an ending (status running)', 'task-b1', 'running', 'task-notification'],
  ['a notice with no status', 'task-b1', null, 'task-notification'],
  ['a row the person typed that looks like a notice', 'task-b1', 'completed', 'composer'],
] as const) test(`${what} does not release a tracked task`, { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await notice($, id, status, kind)
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
})

test('a message row with no task changes nothing', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  const ui = await $.ui.mount({ plugin: 'spinsponsor', component: 'UserMessage', surface: 'terminal', requestId: 'plain', props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false } })
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('hello')
  expect(await tracked($)).toBe(1)
  expect(await adShown($, seen)).toBe(false)
})

// The fallbacks: no task named, nothing the engine will report on, so the old fixed window
test('a background start whose result names no task keeps the 120-second window, which no snapshot ends early', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { resultFor: undefined })
  await during(clock, background($, 'b1'), 300)
  expect(await tracked($)).toBe(0)
  await stopWith($, [])
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(BACKGROUND_HOLD_MS - 300 - 1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(1)
  expect(await adShown($, seen)).toBe(true)
  // The window's whole 120 seconds counted as held back
  expect(await cmdStatus($)).toMatch(/commands running: 0 · held back by commands: 120 s/)
})

for (const [what, result] of [
  ['an empty id', bashOut({ backgroundTaskId: '' })],
  ['an id that is not text', bashOut({ backgroundTaskId: 12 })],
] as const) test(`a background Bash with ${what} is not tracked: the window`, { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { resultFor: () => result })
  await during(clock, background($, 'b1'), 300)
  expect(await tracked($)).toBe(0)
  await clock.advance(BACKGROUND_HOLD_MS - 300 - 1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(1)
  expect(await adShown($, seen)).toBe(true)
})

test('a Monitor whose result has no taskId is not tracked: the window', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { resultFor: () => ({ timeoutMs: 60_000 }) })
  await during(clock, watch($, 'm1'), 300)
  expect(await tracked($)).toBe(0)
  await clock.advance(BACKGROUND_HOLD_MS - 300 - 1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(1)
  expect(await adShown($, seen)).toBe(true)
})

test('a Bash result names its task as backgroundTaskId only: a taskId on a Bash result is not read', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { resultFor: () => bashOut({ taskId: 'x', backgroundedByUser: true }) })
  await during(clock, run($, 'c1'), 300)
  expect(await tracked($)).toBe(0)
  await clock.advance(BACKGROUND_HOLD_MS - 1)
  expect(await adShown($, seen)).toBe(false)
})

test('a background call that throws still opens the window (it may have started the command)', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { toolThrows: true })
  await during(clock, background($, 'b1').catch(() => {}), 300)
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(BACKGROUND_HOLD_MS - 300 - 1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(1)
  expect(await adShown($, seen)).toBe(true)
})

test('a foreground Bash moved to the background that names its task (Ctrl+B) is tracked too, not held for 120 seconds', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { resultFor: () => bashOut({ backgroundedByUser: true, backgroundTaskId: 'x1' }) })
  await during(clock, run($, 'c1'), 300)
  expect(await tracked($)).toBe(1)
  await clock.advance(BACKGROUND_HOLD_MS * 3)
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, listed('x1'))
  expect(await adShown($, seen)).toBe(false)
  await stopWith($, [])
  expect(await adShown($, seen)).toBe(true)
})

test('a tracked start cancels only its own window: an earlier start that named no task keeps its 120 seconds', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on, { resultFor: (e) => (e.tool_use_id === 'b2' ? named(e) : bashOut({})) })
  // b1 names no task: a window of 120 s from its start (time 0)
  await during(clock, background($, 'b1'), 300)
  await clock.advance(1000)
  await during(clock, background($, 'b2'), 300)
  expect(await tracked($)).toBe(1)
  await clock.advance(SNAPSHOT_GRACE_MS)
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
  expect(await adShown($, seen)).toBe(false)
  // 1,600 ms and the grace have passed; b1's window ends at 120,000
  await clock.advance(BACKGROUND_HOLD_MS - 1600 - SNAPSHOT_GRACE_MS - 1)
  expect(await adShown($, seen)).toBe(false)
  await clock.advance(1)
  expect(await adShown($, seen)).toBe(true)
})

test('/ads status counts the tracked commands (never their ids) and keeps counting the time they held ads back', { options: KEY }, async ($, on) => {
  const { clock } = await afterStart($, on)
  expect(await tracked($)).toBe(0)
  await during(clock, background($, 'b1'), 300)
  await during(clock, watch($, 'm1'), 300)
  const status = await ads($, 'status')
  expect(status).toContain('background commands tracked: 2')
  expect(status).not.toMatch(/task-b1|task-m1|Ad number|ss_test/)
  await clock.advance(600_000)
  await stopWith($, [])
  expect(await tracked($)).toBe(0)
  // The time stops counting when the hold ends
  await clock.advance(30_000)
  expect(await cmdStatus($)).toMatch(/commands running: 0 · held back by commands: 60[01] s/)
})

test('tracked commands are never saved: the session state holds only the dialogs and the session marker', { options: KEY }, async ($, on) => {
  const { clock, state } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await during(clock, watch($, 'm1'), 300)
  await clock.settle()
  expect([...state.keys()].sort()).toEqual(['dialogs', 'started'])
  expect(state.get('dialogs')).toEqual({})
  expect(JSON.stringify([...state.values()])).not.toMatch(/b1|m1|task-/)
})

// startSlot checks nothing before it reads the clock, so its own check after the read is all that keeps a new turn from taking an ad
test('a turn that starts while a background command is tracked takes no ad slot', { options: KEY }, async ($, on) => {
  const { clock, seen } = await afterStart($, on)
  await during(clock, background($, 'b1'), 300)
  await done($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.settle()
  expect(await adNow($)).toBe('ad now: none')
  expect(await adShown($, seen)).toBe(false)
})

for (const where of ['terminal line', 'terminal card', 'desktop card'] as const) test(`${where}: a tracked background command keeps the ad off, and nothing counts, until the engine says it ended`, { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 300, resultFor: named })
  const draw = () => (where === 'terminal line' ? spin($) : where === 'terminal card' ? tcard($) : card($))
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await draw()
  await clock.advance(2000)
  await during(clock, background($, 'b1'), 300)
  await draw()
  await clock.advance(10 * 60_000)
  await draw()
  await clock.advance(SLOT_MS)
  expect(queued(store)).toEqual([])
  await stopWith($, [])
  await draw()
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e: any) => e.format)).toEqual([where === 'terminal line' ? 'line' : 'card'])
})

// --- Every surface: the hold is shared state, not one render hook's ---
for (const where of ['terminal line', 'terminal card', 'desktop card'] as const) test(`${where}: a command voids the ad on screen, and nothing counts until it ends`, { options: KEY }, async ($, on) => {
  const { clock, seen, store } = engine(on, { ads: MANY, check: 'allow', toolMs: 8000 })
  const draw = () => (where === 'terminal line' ? spin($) : where === 'terminal card' ? tcard($) : card($))
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await draw()
  await clock.advance(2000)
  const call = run($, 'c1')
  await clock.advance(SLOT_MS)
  expect(queued(store)).toEqual([])
  await during(clock, call, 3000)
  await clock.advance(SLOT_MS)
  expect(queued(store).length).toBe(1)
  await done($)
  await clock.advance(FLUSH_EVERY_MS)
  expect(seen.events.map((e: any) => e.format)).toEqual([where === 'terminal line' ? 'line' : 'card'])
})

// --- /ads status: the counters that size what the hold costs ---
test('/ads status counts commands running, the time they held ads back and the slots they cut short; no ad text, link or key', { options: KEY }, async ($, on) => {
  const { clock } = engine(on, { ads: MANY, check: 'allow', toolMs: 8000 })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(await cmdStatus($)).toBe('commands running: 0 · held back by commands: 0 s · ad slots cut short: 0')
  await clock.advance(2000)
  const call = run($, 'c1')
  await clock.advance(1000)
  const during1 = await ads($, 'status')
  expect(during1).toContain('commands running: 1')
  expect(during1).not.toMatch(/Ad number|localhost:8787\/c\/|ss_test/)
  await during(clock, call, 7000)
  expect(await cmdStatus($)).toBe('commands running: 0 · held back by commands: 8 s · ad slots cut short: 1')
})

// --- Reload (B4): after any reload ads stay off until Claude Code restarts ---
test('a first load writes the session marker before any ad fetch, and ads then show', { options: KEY }, async ($, on) => {
  const { clock, seen, state, markerWrites } = engine(on, { ads: MANY, markerSetMs: 3000 })
  const started = start($)
  await clock.advance(2999)
  // The marker's write hasn't landed: no permission check, no fetch, no ad
  expect(seen.fetches).toEqual([])
  expect(state.has('started')).toBe(false)
  await clock.advance(1)
  await started
  expect(state.get('started')).toBe(true)
  // Written once, and only while nobody had written it (a second load racing this one loses)
  expect(markerWrites).toEqual([0])
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toContain('Sponsored: ')
})

test('a second load finds the marker: ads stay off for the session, with one message', { options: KEY }, async ($, on) => {
  const { clock, seen, state } = engine(on, { ads: MANY, started: true })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
  await clock.advance(FLUSH_EVERY_MS)
  await done($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await spin($)
  expect(seen.message).toBe(null)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
  expect(await ads($, 'status')).toContain('restart Claude Code')
  // Still marked, so a third load stays off too
  expect(state.get('started')).toBe(true)
})

// Codex review: a Claude Code session that was running Mod 0.2.35 (saves an empty dialogs map at start-up, no marker, and never knew
// of background commands) and reloads into this Mod is a reload like any other
test('a reload from Mod 0.2.35 (an empty dialogs map saved, no session marker) turns ads off too', { options: KEY }, async ($, on) => {
  const { seen, state } = engine(on, { ads: MANY, dialogs: {} })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
  // Nothing is written that could make a third load think it was the first
  expect(state.has('started')).toBe(false)
})

for (const [what, o] of [['fails', { markerSetFails: true }], ['is refused (another load wrote it first)', { markerRace: true }], ['never answers', { markerSetMs: 3_600_000 }]] as const) test(`a marker write that ${what} keeps ads off for the session, with one message`, { options: KEY }, async ($, on) => {
  const { clock, seen } = engine(on, { ads: MANY, ...o })
  const started = start($)
  await clock.advance(MARKER_WAIT_MS)
  await started
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await spin($)
  expect(seen.message).toBe(null)
  expect(seen.toasts.filter((t) => t.includes('Restart Claude Code')).length).toBe(1)
  // Never an ad fetch for a session that may be a reload
  await clock.advance(FLUSH_EVERY_MS)
  expect(adFetches(seen)).toBe(0)
})
