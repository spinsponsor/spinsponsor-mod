import type { EngineInterface, Register } from 'claude-code'

export const VERSION = '0.2.37'
// One impression = one ad drawn for 5 continuous seconds while Claude works
export const SLOT_MS = 5000
export const FLUSH_EVERY_MS = 60_000
// A command left running in the background (run_in_background, Monitor) can raise a sandbox prompt at any later moment. The engine
// names the ones it tracks and says when they end (bgTasks below); for any other background sign, and for an engine that sends no
// list of them, no ad is shown or counted for this long after the start (founder, 2026-10-23).
// Not fail closed: a prompt raised after it can still be billed (SANDBOX-PROMPT-VIEWS-PLAN, "reduced, not closed").
export const BACKGROUND_HOLD_MS = 120_000
// How long the first load waits for its "session started" marker to be saved before giving up (ads then stay off)
export const MARKER_WAIT_MS = 5000
const FLUSH_AT = 50
const MAX_QUEUE = 2000
const MAX_EVENT_AGE_MS = 24 * 3600_000
// A session's queue shard not touched for this long belongs to a session that has ended
export const ORPHAN_AFTER_MS = 3 * FLUSH_EVERY_MS
const REFETCH_BELOW = 3
const REFETCH_BEFORE_EXPIRY_MS = 10 * 60_000
// At most one ad fetch this often (the server allows a burst, then one every 5 seconds), and never more cached ads than
// this (a screen too small for them all would otherwise keep fetching)
export const FETCH_GAP_MS = 5000
const MAX_CACHE = 30
const MAX_RETRY_AFTER_MS = 5 * 60_000
const MIN_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 15 * 60_000
// $.http.fetch has no deadline of its own: an answer that never comes would keep its path's busy flag (fetching,
// flushing, checking) set for the rest of the session. Given up after this, through the caller's usual error path
export const REQUEST_TIMEOUT_MS = 30_000
const MAX_AD_CHARS = 60
const PREFIX = 'Sponsored: '
// Room the spinner needs beside our text (glyph, elapsed time, tokens)
export const SPINNER_CHROME = 30
// The Desktop app shows an ad card in the band above the prompt instead (its spinner row keeps Claude's step text).
// Preset themes only: the server sends an id, the colours live here and in apps/web/lib/card.ts (a test keeps them equal).
export const THEMES: Record<string, { border: string; background: string; headline: string }> = {
  violet: { border: '#7C3AED', background: '#1E1B2E', headline: '#C4B5FD' },
  ocean: { border: '#0EA5E9', background: '#0B1E2D', headline: '#7DD3FC' },
  forest: { border: '#10B981', background: '#0B2419', headline: '#6EE7B7' },
  sunset: { border: '#F97316', background: '#2A160B', headline: '#FDBA74' },
  rose: { border: '#EC4899', background: '#2A0F1E', headline: '#F9A8D4' },
  slate: { border: '#64748B', background: '#111827', headline: '#E5E7EB' },
}
const CARD_BODY = '#E5E7EB'
const CARD_LABEL = '#9CA3AF'
// Narrower than this, the card would wrap into a mess: no card
const MIN_CARD_COLUMNS = 40
const MAX_DESCRIPTION_CHARS = 90
const MAX_CTA_CHARS = 20
// The oldest Claude Code this Mod has been tested on (RELEASE-PLAN §3). Older, unknown or blocked versions show no ads.
// ponytail: raise it when a release is tested on an older engine; there's no manifest field for it
export const MIN_ENGINE = '2.1.295'
// Showing ads needs the server's permission, renewed every minute: an off switch, a "please update" or a lost
// connection stops ads on screen within this long, cached ads included (RELEASE-PLAN §2)
export const PERMIT_MS = 2 * 60_000
// While refused, ask again this often (and at every new prompt), so ads come back soon after a switch back on.
// ponytail: refused machines ask 4× as often; lengthen it if that ever loads the server
export const RECHECK_MS = 15_000
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
// Command text is read by the model, so this carries no link; the ad's link is drawn on screen by the CommandOutput hook
export const OPEN_TEXT = 'Here is the link for the last sponsored line shown.'
// /ads login: how often to ask whether the person approved the code, and for how long (the server's link lasts 10 minutes)
export const LINK_POLL_MS = 5000
const LINK_WAIT_MS = 10 * 60_000
const KEY_RE = /^ss_[A-Za-z0-9_-]{43}$/
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/
const LINK_FAILED = 'SpinSponsor could not start signing in (the server did not answer). Try /ads login again in a minute.'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Control and formatting characters (terminal escapes, newlines, bidi tricks) are never drawn
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/

type Ad = { text: string; clickUrl: string; deliveryToken: string; expiresAt: number; description: string | null; ctaLabel: string; theme: string }
type Format = 'line' | 'card'
type Slot = { ad: Ad; clean: boolean; timer: { cancel: () => void } | null; shownAt: number | null; format: Format }
type QueuedEvent = { clientEventId: string; deliveryToken: string; shownAt: string; durationMs: number; format?: Format }
// `api`: where the views were shown (missing before 0.2.33); they only ever go back there
type Shard = { updatedAt: number; events: QueuedEvent[]; api?: string }

// ponytail: module state resets on reload; unsent views (per-session shards) and pause/rejection flags live in $.store
let apiUrl = ''
let key = ''
// True when the key came from /ads login (kept in $.store), not from the plugin's "Install key" setting
let linked = false
let ticking = false
let linking: { cancel: () => void } | null = null
let claiming = false
// Each /ads login is one attempt; logout or a new login moves this on, so a late answer to an old attempt is ignored
let linkAttempt = 0
// A key pasted in the plugin settings: /ads login stays off so a reload can't silently switch back to it
let pastedKey = false
let keyFingerprint = ''
// Each loaded copy of the mod owns one queue shard, so sessions sharing $.store never overwrite each other
const shardKey = `queue:${crypto.randomUUID()}`
let cache: Ad[] = []
let queue: QueuedEvent[] = []
let paused = false
let authFailed = false
let loggedOut = false
let fetching = false
let flushing = false
// The last send of views failed (offline or a server error)
let flushFailing = false
let backoffMs = 0
let nextFetchAt = 0
let retry: { cancel: () => void } | null = null
let lastShown: Ad | null = null
// macOS Terminal draws no clickable links (Claude Code shows a Link there as its label, then the raw URL, and a click only
// copies it), so there the ad's link is a Button that opens it in the browser (founder, 2026-10-15 and 2026-10-18)
let appleTerminal = false
let lastSync: number | null = null
let impressions = 0
let discarded = 0
// Main-agent turns only: subagents raise turn.complete (with agentId) but no turn.start
const turns = new Set<string>()
// Dialogs on screen (or about to be) that hide the ad, each with the agent it belongs to ('main' for the main loop):
// AskUserQuestion (by call id), a permission dialog (`perm:`, one per request) or an MCP server's question (`elicit:`).
// A main turn's end clears only the main loop's; a background agent's stay until they close or that agent's turn ends
// (Codex reviews of 0.2.23 and 0.2.24). Saved in the session's state: after a reload of this Mod, any dialog still open
// before it turns ads off for the session (Codex reviews of 0.2.25 and 0.2.26: no earlier release can be made safe).
// Nothing is saved until startup has read that state (no ad can start before startup anyway).
const pendingAsks = new Map<string, string>()
// Commands running (Bash, Monitor), by call id, each with the agent it belongs to. A sandbox network prompt can cover the ad with no
// signal to this Mod (Claude Code 2.1.309 raises no PermissionRequest for it), so a command holds ads from its tool.call to its end.
// A map of its own and never saved: saveDialogs writes all of pendingAsks to the session state, and a reload turns ads off anyway.
const commandHolds = new Map<string, string>()
// Background commands the engine tracks, by the task id its result named (Bash: backgroundTaskId, Monitor: taskId): no ad shown or
// counted while one runs. Each leaves only on the engine's word that it ended: a Stop or SubagentStop snapshot (`background_tasks`)
// that no longer lists it, or its completion notice. Never on a timer, a call's end, an agent's end or a turn's end; never saved
// (a reload turns ads off anyway). Probe on engine 2.1.310: SANDBOX-PROMPT-VIEWS-PLAN, "Decided" 7.
// The value says whether the task is old enough for a snapshot's silence to count (SNAPSHOT_GRACE_MS after it was recorded).
const bgTasks = new Map<string, boolean>()
// A snapshot is built a moment before this Mod gets it, so one built before a task was registered can still arrive after the Mod
// recorded the task (Codex review, 2026-10-24): its silence says nothing of a task this young. A completion notice has no such delay.
export const SNAPSHOT_GRACE_MS = 5000
// Some snapshot with a readable list has arrived this session: the engine sends lists, so a Stop without one is a lapse, not a
// missing feature, and tracked tasks stay tracked through it
let listSeen = false
// Tasks a Stop without a list handed to the window (before any list had been read), each with its "old enough" flag: a later list that
// still shows one tracks it again, flag kept (Codex round 3: recovery must not skip the grace)
const lapsed = new Map<string, boolean>()
// Tasks the engine's notice has said ended, so a result that names one afterwards (the notice was drawn first) does not hold
const noticed = new Set<string>()
// What a notice's `task.status` says of a task that ended (stopped is `killed`); any other word is not taken as an ending
const ENDED = new Set(['completed', 'failed', 'killed'])
// For BACKGROUND_HOLD_MS after a background start the engine did not name (or when it sends no list): no ad shown or counted. One
// window per start, each ending by its own timer; no call's end, agent's end or turn's end clears one
let windowSeq = 0
const windows = new Map<number, { cancel: () => void }>()
// What the holds cost, for /ads status: slots a command cut short, and the time any command (or the window) held ads back
let cutShort = 0
let heldMs = 0
let heldSince: number | null = null
// Anything that keeps an ad off the screen: a dialog, a running command, a tracked background command, the window after a background
// start. Every place that asks whether an ad may show or start reads this, never one of the maps, or a hold would silently not apply there.
const onHold = () => pendingAsks.size > 0 || commandHolds.size > 0 || bgTasks.size > 0 || windows.size > 0
let restored = false
// Saves run one after another, each writing the newest map, so a slow write can't land over a newer one
let saving: Promise<unknown> = Promise.resolve()
const DIALOGS = { plugin: 'spinsponsor', key: 'dialogs' } as const
// Each permission request's asking calls (same tool and agent): it closes once they have all settled
const permCalls = new Map<string, Set<string>>()
// MCP questions without an id, oldest first, per agent and server: an answer without an id closes the oldest
const elicitQueue = new Map<string, string[]>()
// Tool calls put to the mode's decider ("ask"), with their tool and agent. Only those whose permission dialog then opens
// hide the ad: in auto mode a classifier approves most without any dialog (founder test of 0.2.22).
const asked = new Map<string, { tool: string; owner: string }>()
// Which agent each running tool call belongs to (tool.check carries no agent)
const callOwner = new Map<string, string>()
let blockerSeq = 0
const ownerOf = (agentId: string | undefined) => agentId ?? 'main'
// The dialog may draw before its hooks finish: hide the ad at once. The ad on screen is void; it goes back to the cache
// for a fresh 5 seconds once every dialog has closed.
function saveDialogs($: EngineInterface) {
  // Before startup has read what an earlier load saved, writing would overwrite it
  if (!restored) return
  // A failed save is tried again with the newest map a few seconds later
  // ponytail: a save that never answers holds up every later one; the engine is trusted to answer or fail
  saving = saving.then(() => $.state.set(DIALOGS, Object.fromEntries(pendingAsks))).catch(() => void $.clock.after(3000, () => saveDialogs($)))
}
function hideFor($: EngineInterface, keys: string[], owner: string) {
  for (const k of keys) pendingAsks.set(k, owner)
  saveDialogs($)
  if (slot) {
    dropSlot(true)
    $.ui.invalidate('ui.render')
  }
}
// Dialogs closed (or never opened): ads may start again
function unhide($: EngineInterface, keys: string[]) {
  let removed = false
  for (const k of keys) removed = pendingAsks.delete(k) || removed
  if (!removed) return
  saveDialogs($)
  if (!onHold() && turns.size > 0) void startSlot($)
}
// An MCP question that won't show (blocked, or its hooks failed): its marker and its place in the queue go
function closeQuestion($: EngineInterface, where: string, key: string) {
  const q = elicitQueue.get(where)
  if (q) elicitQueue.set(where, q.filter((k) => k !== key))
  unhide($, [key])
}
// Forgets everything one agent's ended turn left behind
function forgetOwner($: EngineInterface, owner: string) {
  let removed = false
  for (const [k, o] of pendingAsks) {
    if (o !== owner) continue
    pendingAsks.delete(k)
    permCalls.delete(k)
    removed = true
  }
  for (const [k, q] of elicitQueue) if (k.startsWith(`${owner}|`)) elicitQueue.delete(k)
  if (removed) saveDialogs($)
  for (const [k, a] of asked) if (a.owner === owner) asked.delete(k)
  for (const [k, o] of callOwner) if (o === owner) callOwner.delete(k)
  let freed = false
  for (const [k, o] of commandHolds) if (o === owner && commandHolds.delete(k)) freed = true
  if (freed) tallyHeld($)
}
// A command starts: the ad on screen is void (it goes back to the cache for a fresh 5 seconds), and none starts until it ends.
// A startSlot waiting on the clock needs no nudge: it checks onHold() when it resumes, and a command that has ended by then
// started a newer one.
function holdCommand($: EngineInterface, hold: string, owner: string) {
  commandHolds.set(hold, owner)
  if (slot) {
    if (slot.timer) cutShort++
    dropSlot(true)
    $.ui.invalidate('ui.render')
  }
  tallyHeld($)
}
function releaseCommand($: EngineInterface, hold: string) {
  if (!commandHolds.delete(hold)) return
  tallyHeld($)
  if (!onHold() && turns.size > 0) void startSlot($)
}
// A background start the engine did not name opens a window of its own; it ends by itself, whatever else ends
function openWindow($: EngineInterface) {
  const w = ++windowSeq
  windows.set(
    w,
    $.clock.after(BACKGROUND_HOLD_MS, () => {
      windows.delete(w)
      tallyHeld($)
      if (!onHold() && turns.size > 0 && !slot) void startSlot($)
    }),
  )
  return w
}
// The start turned out to be named by the engine: the task holds, so this start's window is not needed. Only its own
function closeWindow(w: number) {
  windows.get(w)?.cancel()
  windows.delete(w)
}
// The name the engine gave a command that went to the background: a Bash result's `backgroundTaskId`, a Monitor result's `taskId`
function taskIdOf(tool: string, result: unknown) {
  const out = (result as { result?: unknown } | undefined)?.result
  if (typeof out !== 'object' || out === null) return null
  const id = (out as Record<string, unknown>)[tool === 'Monitor' ? 'taskId' : 'backgroundTaskId']
  return typeof id === 'string' && id !== '' ? id : null
}
// The ids of a Stop snapshot's `background_tasks`, or null when it is not a list this Mod can read (absent is not empty)
function runningIn(list: unknown) {
  if (!Array.isArray(list)) return null
  const ids = new Set<string>()
  for (const t of list) {
    const id = (t as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return null
    ids.add(id)
  }
  return ids
}
// A tracked task ended, by the engine's word: ads may start again once nothing else holds
function freeTasks($: EngineInterface, ended: string[]) {
  let freed = false
  for (const id of ended) {
    lapsed.delete(id)
    freed = bgTasks.delete(id) || freed
  }
  if (!freed) return
  tallyHeld($)
  if (!onHold() && turns.size > 0) void startSlot($)
}
// A Stop (main loop or subagent) lists what the session still runs. A tracked task it no longer lists has ended, once the task is
// old enough for that to count. A list this Mod cannot read says nothing of any task. On an engine that has never sent a readable
// list, the main loop's Stop hands what is tracked to the old window, from now (the engine cannot say when they end); once any
// list has been read, a Stop without one is ignored, as is a subagent's.
function settleTasks($: EngineInterface, list: unknown, main: boolean) {
  const running = runningIn(list)
  if (running !== null) {
    listSeen = true
    // The engine's list still shows a task the window was holding: tracked again, and what is on screen is void. One it does not
    // show is forgotten, once old enough for that to count
    const back = [...lapsed].filter(([id]) => running.has(id))
    for (const [id, old] of [...lapsed]) if (old || running.has(id)) lapsed.delete(id)
    for (const [id, old] of back) bgTasks.set(id, old)
    if (back.length > 0) {
      if (slot) {
        dropSlot(true)
        $.ui.invalidate('ui.render')
      }
      tallyHeld($)
    }
  }
  if (bgTasks.size === 0) return
  if (running !== null) return freeTasks($, [...bgTasks].filter(([id, old]) => old && !running.has(id)).map(([id]) => id))
  if (!main || listSeen) return
  openWindow($)
  for (const [id, old] of bgTasks) lapsed.set(id, old)
  bgTasks.clear()
}
// What a Bash result says of a command that went on running after its call returned (the engine's Bash output). Any of its
// signs counts, and so does an unexpected shape: not recognised as background means a window is missed, so each is checked.
function wentToBackground(result: unknown) {
  const out = (result as { result?: unknown } | undefined)?.result
  if (typeof out !== 'object' || out === null) return false
  const o = out as Record<string, unknown>
  return !!(o.backgroundTaskId || o.backgroundedByUser || o.backgroundedByTurnAbort || o.backgroundedToDeliverMessage || o.timedOutAfterMs != null)
}
// Time with any command hold in force, for /ads status. ponytail: approximate (the clock is read a moment after each change);
// it counts the window's whole 120 s even when Claude is idle in it
function tallyHeld($: EngineInterface) {
  void $.clock.now().then((t) => {
    const holding = commandHolds.size > 0 || bgTasks.size > 0 || windows.size > 0
    if (holding && heldSince === null) heldSince = t
    else if (!holding && heldSince !== null) {
      heldMs += t - heldSince
      heldSince = null
    }
  })
}
let slot: Slot | null = null
// Cells left for the ad text at the last spinner draw (null = not measured yet). ponytail: one value for the session;
// a session drawn on two surfaces at once keeps the last one's, and a draw that doesn't fit voids the slot, so the
// error only hides ads
let room: number | null = null
let lastSurface = ''
// Cells on screen, counted on the safe side: anything beyond plain ASCII takes two. Over-counting only hides an ad;
// under-counting could bill a clipped one. ponytail: accented letters (é) count two, so such ads need a few more columns
export const cells = (text: string) => [...text].reduce((n, ch) => n + (ch.codePointAt(0)! < 0x7f ? 1 : 2), 0)
const fitsIn = (ad: Ad) => room !== null && cells(PREFIX + ad.text) <= room
// The band above the prompt at its last draw (null = not drawn yet). ponytail: one value for the session, like `room`.
// `working`: it last drew while Claude worked. Each turn's end clears it, so a band remembered from the last turn never
// holds an ad back from the spinner while this turn's band hasn't drawn. (Cleared at the end, not the start: the band can
// draw this turn's "working" a moment before the turn's start reaches this Mod; founder test of 0.2.21.)
type Band = { surface: string; bodyColumns: number; maxRows: number; hasSurvey: boolean; working: boolean }
let band: Band | null = null
// Rows a Text takes when the terminal wraps it to `width` (it wraps like wrap-ansi: whole words move down, a word wider
// than the row is split, character by character: a two-cell character that doesn't fit leaves the cell empty). Counted
// on the safe side: a split word always starts a new row, and `cells` over-counts, so this is never fewer rows than
// drawn. Paid text must never scroll out of the band.
export function wrapRows(text: string, width: number) {
  let rows = 1
  let col = 0
  for (const word of text.split(' ')) {
    const n = cells(word)
    if (n > width) {
      if (col > 0) {
        rows++
        col = 0
      }
      for (const ch of word) {
        const w = cells(ch)
        if (col + w > width) {
          rows++
          col = 0
        }
        col += w
      }
    } else if (col === 0 || col + 1 + n <= width) col = col === 0 ? n : col + 1 + n
    else {
      rows++
      col = n
    }
  }
  return rows
}
// Rows the terminal card takes in a band `columns` wide: border and padding take 4 columns and 2 rows. The link counts as
// a terminal without clickable links draws it: its label, then the address; macOS Terminal's button as `[ label → ]`.
export const cardRows = (ad: Ad, columns: number, button = appleTerminal) => {
  const inner = columns - 4
  const cta = button ? `[ ${ad.ctaLabel} → ]` : `${ad.ctaLabel} → ${ad.clickUrl}`
  return 2 + wrapRows(`Sponsored ${ad.text}`, inner) + (ad.description ? wrapRows(ad.description, inner) : 0) + wrapRows(cta, inner)
}
// The Desktop app's card (unchanged): wide enough, no survey. The terminal's must also show whole, never scroll.
const cardFits = (ad: Ad) =>
  band !== null && band.working && !band.hasSurvey && band.bodyColumns >= MIN_CARD_COLUMNS && (band.surface === 'desktop' || cardRows(ad, band.bodyColumns) <= band.maxRows)
// An ad's format on this screen: the card whenever it fits, else the spinner line, else none
const choose = (ad: Ad): Format | null => (cardFits(ad) ? 'card' : fitsIn(ad) ? 'line' : null)
// Nothing measured yet: neither the spinner nor the band has drawn
const unmeasured = () => room === null && band === null
// Ads this screen can draw (any, while nothing is measured)
const usable = (ads: Ad[]) => ads.filter((a) => unmeasured() || choose(a) !== null)
// Bumped on every slot change; an async step that finds it changed gives up instead of acting on stale state
let gen = 0
// Startup work runs once per loaded module, from session.start or, if a reload skipped that, the first turn or /ads command.
// Every caller awaits the same promise, so nothing runs before startup has finished; a failed startup is retried.
let booting: Promise<void> | null = null
const renderMs: number[] = []

export function p95(samples: number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

// Our API only: https, or http on localhost for development
export function allowedApi(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

// Server ads are checked again here: an ad we can't draw safely is dropped, never shown
export function toAd(raw: unknown): Ad | null {
  const a = raw as Record<string, unknown>
  if (typeof a?.text !== 'string' || a.text.length === 0 || a.text.length > MAX_AD_CHARS || UNSAFE.test(a.text)) return null
  if (typeof a.deliveryToken !== 'string' || !UUID.test(a.deliveryToken)) return null
  if (typeof a.clickUrl !== 'string' || !allowedApi(a.clickUrl)) return null
  // Clicks go through our own redirect only: it counts them, checks them for fraud and sends the person on. Exactly the
  // address the server builds, so nothing a browser would normalise (`/c/%2e%2e/x`) can lead elsewhere (Codex review)
  if (apiUrl !== '' && a.clickUrl !== `${apiUrl}/c/${a.deliveryToken}`) return null
  const expiresAt = typeof a.expiresAt === 'string' ? Date.parse(a.expiresAt) : NaN
  if (Number.isNaN(expiresAt)) return null
  // Card fields are optional extras: a bad one falls back to the default, never drops the ad
  const plain = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.length <= max && !UNSAFE.test(v) ? v.trim() : null)
  const description = plain(a.description, MAX_DESCRIPTION_CHARS)
  const ctaLabel = plain(a.ctaLabel, MAX_CTA_CHARS) ?? 'Learn more'
  const theme = typeof a.theme === 'string' && a.theme in THEMES ? a.theme : 'violet'
  return { text: a.text, clickUrl: a.clickUrl, deliveryToken: a.deliveryToken, expiresAt, description, ctaLabel, theme }
}

// x.y.z compared part by part (0.10 is newer than 0.2); anything else is never "at least"
export function versionAtLeast(v: string | null, min: string) {
  if (!v || !VERSION_RE.test(v)) return false
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

// Why no ads may show right now (beyond sign-in and pause), or null
let refusal: null | 'waiting' | 'off' | 'update' | 'terms' | 'offline' = 'waiting'
let permitTimer: { cancel: () => void } | null = null
let engineBase: string | null = null
let blockedEngines: string[] = []
// Claude Code handed a render hook something this Mod doesn't recognise: no ads for the rest of the session
let unexpectedProps = false
let compatNoticeShown = false
// Its own latch: the "ads paused, restart" message must never be swallowed by another compatibility message
let pausedNoticeShown = false
// Dialogs saved as open by an earlier load (or saved state that can't be read): no ads until Claude Code restarts
let offForSession = false
// B4: this load wrote the session's "started" marker and the write landed. Until then no ad can be shown.
let started = false
let claim: Promise<void> | null = null
const STARTED = { plugin: 'spinsponsor', key: 'started' } as const
const engineOk = () => versionAtLeast(engineBase, MIN_ENGINE) && !blockedEngines.includes(engineBase!) && !unexpectedProps

const signedIn = () => key !== '' && !authFailed && !loggedOut
const active = () => signedIn() && !paused && refusal === null && engineOk() && !offForSession && started
const headers = () => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-client-version': VERSION })
const nextBackoff = () => Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, backoffMs * 2))

// Every API call goes through here, except the sign-in claim (claimLink)
async function request($: EngineInterface, url: string, init?: Parameters<EngineInterface['http']['fetch']>[1]) {
  const settled = new AbortController()
  const deadline = $.clock.sleep(REQUEST_TIMEOUT_MS, { signal: settled.signal }).then(() => {
    throw new Error('no answer')
  })
  // Rejects when the request settles first (the abort below): nothing to report
  deadline.catch(() => {})
  try {
    return await Promise.race([$.http.fetch(url, init), deadline])
  } finally {
    settled.abort()
  }
}

// Remembers a rejected key (by fingerprint, never the key) so a reload doesn't retry it
// `sent` is the key the rejected request carried: a late 401 for a key since replaced (logout, /ads login) is ignored
async function rejectKey($: EngineInterface, sent: string) {
  if (sent !== key) return
  authFailed = true
  await $.store.set('rejected', keyFingerprint)
}

// Background ad fetch: keeps 3 fresh spares this screen can show, one fetch at a time and at most one every 5 seconds.
// Backs off on errors and empty batches (retrying at the deadline), waits as long as the server asks (429), stops for
// good on 401. Ads that don't fit the screen right now are kept (a resize may show them) and are no reason to back off.
async function refill($: EngineInterface) {
  if (!active() || fetching) return
  fetching = true
  let now = 0
  // When to try again (0: no retry needed)
  let wait = 0
  let landed = false
  try {
    now = await $.clock.now()
    cache = cache.filter((a) => a.expiresAt - now > SLOT_MS * 2)
    const fresh = usable(cache).filter((a) => a.expiresAt - now > REFETCH_BEFORE_EXPIRY_MS)
    if (fresh.length >= REFETCH_BELOW || cache.length >= MAX_CACHE || !active()) return
    // Too soon after the last fetch, and spares are low: fetch as soon as allowed while an ad is on screen or could show
    // (Codex: a resize inside the gap had no retry, and the next ad found no spare). With nothing this screen can show,
    // don't: that would fetch every 5 seconds for ads that fit nothing.
    if (now < nextFetchAt) {
      if (slot || usable(cache).length > 0) wait = nextFetchAt - now
      return
    }
    const sent = key
    const res = await request($, `${apiUrl}/v1/mod/ads`, { headers: headers() })
    // Waits below count from the answer, as the retry timer does (a slow answer can't shorten them)
    now = await $.clock.now()
    if (res.status === 401) return await rejectKey($, sent)
    if (res.status === 429) {
      const asked = Number(res.headers['retry-after']) * 1000
      wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(FETCH_GAP_MS, Number.isFinite(asked) ? asked : 0))
      nextFetchAt = now + wait
      return
    }
    if (!res.ok) throw new Error(`ads ${res.status}`)
    const fetched = ((JSON.parse(res.text) as { ads?: unknown[] }).ads ?? []).map(toAd).filter((a) => a !== null)
    // Signed out or paused while the request was out: drop the answer
    if (!active()) return
    cache.push(...fetched)
    capCache()
    lastSync = now
    landed = true
    if (fetched.length === 0) {
      backoffMs = nextBackoff()
      nextFetchAt = now + backoffMs
      wait = backoffMs
    } else {
      backoffMs = 0
      nextFetchAt = now + FETCH_GAP_MS
      // Some this screen can show: top up towards 3 spares (the next try stops once there are)
      if (usable(fetched).length > 0) wait = FETCH_GAP_MS
    }
  } catch {
    backoffMs = nextBackoff()
    nextFetchAt = now + backoffMs
    wait = backoffMs
  } finally {
    fetching = false
    if (wait > 0) {
      retry?.cancel()
      retry = $.clock.after(wait, () => {
        void refill($)
      })
    }
  }
  if (landed && turns.size > 0 && !slot && !onHold()) await startSlot($)
}

async function saveQueue($: EngineInterface) {
  const now = await $.clock.now()
  const shard: Shard = { updatedAt: now, events: queue, api: apiUrl }
  await $.store.set(shardKey, shard)
}

// Takes over queue shards left by sessions that ended. Two sessions adopting the same shard only cause duplicates,
// which the server ignores (it dedupes on clientEventId).
async function adoptOrphans($: EngineInterface) {
  const now = await $.clock.now()
  for (const k of await $.store.keys()) {
    if (!k.startsWith('queue:') || k === shardKey) continue
    const shard = (await $.store.get(k)) as Shard | undefined
    if (shard && now - shard.updatedAt < ORPHAN_AFTER_MS) continue
    // Another API's views stay for a session on that API, until they are too old to send
    if (shard && shard.api !== undefined && shard.api !== apiUrl) {
      if (now - shard.updatedAt >= MAX_EVENT_AGE_MS) await $.store.delete(k)
      continue
    }
    if (shard && Array.isArray(shard.events)) queue.push(...shard.events)
    await $.store.delete(k)
  }
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  await saveQueue($)
}

// Sends queued views, at most 50 at a time. Every per-event answer is final; network and server errors keep the queue.
async function flush($: EngineInterface) {
  if (flushing) return
  flushing = true
  try {
    const now = await $.clock.now()
    queue = queue.filter((e) => now - Date.parse(e.shownAt) < MAX_EVENT_AGE_MS)
    const batch = queue.slice(0, FLUSH_AT)
    // Re-checked after the await: never send while signed out
    if (batch.length === 0 || !signedIn()) return
    const sent = key
    const res = await request($, `${apiUrl}/v1/mod/events`, { method: 'POST', headers: headers(), body: JSON.stringify({ events: batch }) })
    if (res.status === 401) return await rejectKey($, sent)
    if (!res.ok) throw new Error(`events ${res.status}`)
    const answered = new Set(((JSON.parse(res.text) as { results?: { clientEventId?: string }[] }).results ?? []).map((r) => r.clientEventId))
    queue = queue.filter((e) => !answered.has(e.clientEventId))
    lastSync = now
    flushFailing = false
  } catch {
    // Offline or a bad reply: try again on the next tick
    flushFailing = true
  } finally {
    flushing = false
    // Also the shard's heartbeat, so other sessions know it is still owned
    await saveQueue($)
  }
}

// Drops cached copies the server says may no longer be shown (edited, stopped, paused, held or ended), so an edit or
// "Stop now" reaches the screen within a minute. One on screen is replaced at once and doesn't count.
async function prune($: EngineInterface) {
  const held = [...(slot ? [slot.ad] : []), ...cache].map((a) => a.deliveryToken).slice(0, 200)
  if (!active() || held.length === 0) return
  try {
    // Only the copies this machine holds are checked: the answer is small, can't miss the one on screen, and can't name a
    // copy still on its way in a refill (the server never issues a delivery twice)
    const sent = key
    const res = await request($, `${apiUrl}/v1/mod/ads/stopped`, { method: 'POST', headers: headers(), body: JSON.stringify({ tokens: held }) })
    if (res.status === 401) return await rejectKey($, sent)
    if (!res.ok) return
    const stopped = new Set((JSON.parse(res.text) as { stopped?: unknown[] }).stopped?.filter((t): t is string => typeof t === 'string') ?? [])
    if (stopped.size === 0) return
    cache = cache.filter((a) => !stopped.has(a.deliveryToken))
    if (slot && stopped.has(slot.ad.deliveryToken)) {
      if (slot.timer) {
        slot.timer.cancel()
        discarded++
      }
      slot = null
      gen++
      $.ui.invalidate('ui.render')
      if (turns.size > 0 && !onHold()) await startSlot($)
    }
  } catch {
    // The next minute's check tries again
  }
}

async function enqueue($: EngineInterface, e: QueuedEvent) {
  queue.push(e)
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  await saveQueue($)
  // While sends are failing, only the minute's tick retries (not every new view)
  if (queue.length >= FLUSH_AT && !flushFailing) await flush($)
}

// Drop the current slot. One already on screen counts as discarded. Its ad goes back to the front of the cache if it was
// never drawn, or with `keepAd` (a resize: the same ad starts afresh, and its one view is counted at most once).
// Never more than MAX_CACHE cached ads: the newest beyond it go (an ad put back at the front stays)
function capCache() {
  if (cache.length > MAX_CACHE) cache.length = MAX_CACHE
}

function dropSlot(keepAd = false) {
  gen++
  if (!slot) return
  const shown = slot.timer !== null
  if (shown) {
    slot.timer!.cancel()
    discarded++
  }
  if (!shown || keepAd) {
    cache.unshift(slot.ad)
    capCache()
  }
  slot = null
}

// The screen changed size, or a survey came or went. A slot never drawn takes the format that fits now. One whose format
// no longer matches what fits (a card the window got too small for, a line now wide enough for the card, a line too wide
// for the spinner) starts again at once with the same ad in the format that fits, or makes way for an ad that does; the
// ad waits at the front of the cache otherwise. A view on screen is void: each format needs its own 5 seconds.
function reconsider($: EngineInterface) {
  const s = slot
  if (!s || !active()) return
  const f = choose(s.ad)
  if (f === s.format) return
  if (!s.timer && f) {
    s.format = f
    return
  }
  dropSlot(true)
  if (turns.size > 0 && !onHold()) void startSlot($)
}

// Queue the next ad; its 5 seconds start when the spinner first draws it
async function startSlot($: EngineInterface) {
  dropSlot()
  const mine = gen
  if (!active()) return
  const now = await $.clock.now()
  // Anything may have happened during the await: pause, logout, turn end, a prompt, or a newer slot
  if (mine !== gen || !active() || turns.size === 0 || onHold()) return
  cache = cache.filter((a) => a.expiresAt - now > SLOT_MS * 2)
  // The first ad this screen can draw, and its format with it; one too big waits for a bigger screen instead of blocking
  // the rest. With none, take no slot (the stock spinner shows); a bigger screen or new ads start one from a render hook.
  // With nothing measured yet, take the first: its format is settled when a hook first draws it.
  const i = cache.findIndex((a) => choose(a) !== null)
  const ad = i >= 0 ? cache.splice(i, 1)[0] : unmeasured() ? cache.shift() : undefined
  // It checks for itself whether spares are running low (or close to expiring)
  void refill($)
  // Nothing to show: redraw so the previous ad doesn't stay on screen past its slot
  if (!ad) return $.ui.invalidate('ui.render')
  slot = { ad, clean: true, timer: null, shownAt: null, format: choose(ad) ?? 'line' }
  $.ui.invalidate('ui.render')
}

function armSlot($: EngineInterface, s: Slot) {
  void $.clock.now().then((t) => {
    s.shownAt = t
  })
  s.timer = $.clock.after(SLOT_MS, () => {
    if (slot !== s) return
    slot = null
    s.timer = null
    if (s.clean && active() && !onHold() && s.shownAt !== null) {
      impressions++
      void enqueue($, { clientEventId: crypto.randomUUID(), deliveryToken: s.ad.deliveryToken, shownAt: new Date(s.shownAt).toISOString(), durationMs: SLOT_MS, format: s.format })
    } else {
      discarded++
    }
    void startSlot($)
  })
}

function statusText(now: number) {
  const sync = lastSync === null ? 'never' : new Date(lastSync).toISOString().slice(11, 19) + ' UTC'
  const state =
    key === '' ? 'not signed in (see /ads login)'
    : loggedOut ? 'signed out for this session'
    : authFailed ? 'install key rejected (add a new key, see /ads login)'
    : 'signed in'
  const why =
    offForSession ? 'off for this session: restart Claude Code to see ads again'
    : unexpectedProps ? 'off: this Claude Code draws differently than expected'
    : !versionAtLeast(engineBase, MIN_ENGINE) ? `off: Claude Code ${engineBase ?? '(unknown version)'} is not supported (${MIN_ENGINE} or newer)`
    : blockedEngines.includes(engineBase!) ? `off: Claude Code ${engineBase} is blocked for now`
    : refusal === 'off' ? 'off: SpinSponsor has switched ads off for now'
    : refusal === 'update' ? 'off: please update (claude plugin update spinsponsor@spinsponsor)'
    : refusal === 'terms' ? 'paused: accept the updated terms or consent on your SpinSponsor dashboard'
    : refusal === 'offline' ? 'off: no word from the SpinSponsor server'
    : refusal === 'waiting' ? 'waiting for the server'
    : paused ? 'paused' : 'on'
  return [
    `SpinSponsor ${VERSION}: ${state}`,
    `· ads ${why}`,
    `· ${cache.length} ads ready · ${queue.length} views waiting to send`,
    `· ${impressions} views counted this session (${discarded} partial) · last sync ${sync}`,
    `· last spinner: ${lastSurface || 'not drawn yet'}${lastSurface ? (room === null ? ', width not reported' : `, ${room} cells for the ad`) : ''}`,
    `· last band: ${band ? `${band.surface}, ${band.bodyColumns} columns × ${band.maxRows} rows${band.hasSurvey ? ', survey' : ''}${band.working ? ', working' : ''}` : 'not drawn yet'}`,
    `· ad now: ${slot ? `${slot.format}, ${slot.timer ? 'on screen' : 'waiting to draw'}` : 'none'}${pendingAsks.size > 0 ? ` · dialogs open: ${pendingAsks.size}` : ''}`,
    // What the command holds cost on this machine: the figure to judge them by (docs/SANDBOX-PROMPT-VIEWS-PLAN.md)
    `· commands running: ${commandHolds.size} · held back by commands: ${Math.round((heldMs + (heldSince === null ? 0 : now - heldSince)) / 1000)} s · ad slots cut short: ${cutShort} · background commands tracked: ${bgTasks.size}${windows.size > 0 ? ' · background window open' : ''}`,
    `· render p95 ${p95(renderMs).toFixed(2)} ms`,
  ].join(' ')
}

function boot($: EngineInterface) {
  booting ??= startup($).catch((err) => {
    booting = null
    throw err
  })
  return booting
}

// B4: the first load of a Claude Code session writes this marker and shows ads only once the write has landed. A load that finds it is
// a reload, and the engine gives no barrier (a dialog may have opened that this load never heard of), so ads stay off until Claude
// Code restarts, which starts with empty state. A read that fails, a write that fails, is refused (another load got there first;
// the write is conditional on the marker never having been written) or takes longer than MARKER_WAIT_MS counts as a reload too:
// it can't be told apart, and off only costs earnings.
async function claimSession($: EngineInterface) {
  const settled = new AbortController()
  const deadline = $.clock.sleep(MARKER_WAIT_MS, { signal: settled.signal }).then(() => false, () => false)
  const write = (async () => {
    const { value, version } = await $.state.get(STARTED)
    if (value !== undefined || version !== 0) return false
    return (await $.state.set(STARTED, true, { ifVersion: 0 })).isSet
  })().catch(() => false)
  try {
    started = await Promise.race([write, deadline])
  } finally {
    settled.abort()
  }
  if (!started) offForSession = true
}

async function startup($: EngineInterface) {
  paused = (await $.store.get('paused')) === true
  // Dialogs still open before a reload of this Mod: their close events can't be matched any more, and one may stay open
  // past any turn's end, so ads stay off until Claude Code restarts (which starts with empty state). So does a failed
  // read: it can't rule them out. Nothing is saved while off, so a later reload finds the same map and stays off too.
  // So does anything saved at all (version above 0): every load since 0.2.27 saves a map when it starts, so an earlier
  // load ran in this session, even an empty map from a Mod too old to write the "started" marker (Codex review: 0.2.35
  // knows nothing of background commands, so reloading into this one must not turn ads on).
  if (!restored && !offForSession) {
    try {
      const { version } = await $.state.get(DIALOGS)
      offForSession = version !== 0
    } catch {
      offForSession = true
      // Written down, so a later reload (with the read working again) stays off too (Codex review of 0.2.28)
      void $.state.set(DIALOGS, { 'read-failed': 'main' }).catch(() => {})
    }
    // (Its message waits for a key: someone signed out isn't earning; activate tells them once they are signed in)
    if (!offForSession) {
      restored = true
      saveDialogs($)
    }
  }
  // Once per loaded module, even if a failed startup is retried: its own marker must not read as an earlier load's
  if (!offForSession) await (claim ??= claimSession($))
  // Checked at start-up and on every reload (each reload runs this again)
  try {
    const v = await $.session.version()
    engineBase = typeof v.base === 'string' && VERSION_RE.test(v.base) ? v.base : null
  } catch {
    engineBase = null
  }
  // Over SSH `open` would run on the far machine: keep the link there (Codex review)
  try {
    appleTerminal = (await $.env.get('TERM_PROGRAM')) === 'Apple_Terminal' && !(await $.env.get('SSH_CONNECTION')) && !(await $.env.get('SSH_TTY'))
  } catch {
    appleTerminal = false
  }
  // No key in the settings: a machine linked with /ads login, for this same API only
  if (key === '' && apiUrl !== '') {
    const saved = (await $.store.get('machine_key')) as { key?: unknown; apiUrl?: unknown } | undefined
    if (typeof saved?.key === 'string' && KEY_RE.test(saved.key) && saved.apiUrl === apiUrl) {
      key = saved.key
      linked = true
    }
  }
  await activate($)
}

async function activate($: EngineInterface) {
  if (key === '') return
  if (offForSession && !pausedNoticeShown) {
    pausedNoticeShown = true
    // Long enough to read and act on (the default is 4 s)
    $.ui.toast('SpinSponsor: ads are paused for this session. Restart Claude Code to keep seeing ads and earning.', { timeoutMs: 20_000 })
  }
  keyFingerprint = await fingerprint(`${apiUrl} ${key}`)
  authFailed = (await $.store.get('rejected')) === keyFingerprint
  await adoptOrphans($)
  if (!ticking) {
    ticking = true
    $.clock.every(FLUSH_EVERY_MS, () => {
      void flush($)
      void prune($)
      void checkPermission($)
    })
    $.clock.every(RECHECK_MS, () => {
      if (refusal !== null) void checkPermission($)
    })
  }
  // In the background: Claude Code's startup never waits on the ad server
  void checkPermission($)
}

// Stops ads at once: the slot on screen is void, and the stock spinner comes back
function stopShowing($: EngineInterface, clearCache: boolean) {
  dropSlot()
  if (clearCache) cache = []
  $.ui.invalidate('ui.render')
}

// One message per session for anything that turns ads off on this machine's side
function compatNotice($: EngineInterface, text: string) {
  if (compatNoticeShown) return
  compatNoticeShown = true
  $.ui.toast(`SpinSponsor: ${text}`)
}

// What a render site hands the hook must look the way this Mod was built for; anything else turns ads off for the
// session (no ad, the running slot void, the engine's own drawing, one message)
const MODES = ['requesting', 'responding', 'thinking', 'tool-input', 'tool-use']
export const spinnerPropsOk = (p: Record<string, unknown>) =>
  typeof p.word === 'string' && (p.message === null || typeof p.message === 'string') && typeof p.suffix === 'string' && MODES.includes(p.mode as string)
export const bandPropsOk = (p: Record<string, unknown>) =>
  typeof p.isWorking === 'boolean' && typeof p.hasSurvey === 'boolean' && typeof p.bodyColumns === 'number' && Number.isFinite(p.bodyColumns) && typeof p.maxRows === 'number' && Number.isFinite(p.maxRows)

function unexpected($: EngineInterface) {
  // Once is enough: stopping again would redraw again, every time
  if (unexpectedProps) return
  unexpectedProps = true
  stopShowing($, false)
  compatNotice($, 'ads are off for this session: this Claude Code version draws differently than SpinSponsor expects. An update will fix it.')
}

let checking = false

async function checkPermission($: EngineInterface) {
  // One at a time, so an older answer can never land after a newer one
  if (!signedIn() || checking) return
  checking = true
  try {
    const sent = key
    const asked = await $.clock.now()
    const res = await request($, `${apiUrl}/v1/mod/permission`, { headers: headers() })
    // Signed out, or a different key, since it asked: the answer isn't this key's
    if (sent !== key || !signedIn()) return
    if (res.status === 401) return await rejectKey($, sent)
    // A server error keeps the current permission until it runs out
    if (!res.ok) return
    const p = JSON.parse(res.text) as { serve?: unknown; reason?: unknown; blockedEngineVersions?: unknown }
    blockedEngines = Array.isArray(p.blockedEngineVersions) ? p.blockedEngineVersions.filter((v): v is string => typeof v === 'string') : []
    if (!engineOk()) {
      stopShowing($, false)
      compatNotice($, `ads are off on Claude Code ${engineBase ?? '(unknown version)'}. They come back on a supported version (${MIN_ENGINE} or newer).`)
    }
    if (p.serve !== true) {
      // Switched off, this Mod is too old, or the developer must accept new terms on the dashboard: cached ads go too
      refusal = p.reason === 'update' ? 'update' : p.reason === 'terms' ? 'terms' : 'off'
      permitTimer?.cancel()
      stopShowing($, true)
      if (refusal === 'update') compatNotice($, 'please update to keep showing ads: claude plugin update spinsponsor@spinsponsor, then restart Claude Code.')
      if (refusal === 'terms') compatNotice($, 'ads are paused until you accept the updated terms or consent on your SpinSponsor dashboard.')
      return
    }
    // Good for PERMIT_MS from when it was asked, on this machine's clock (a slow answer or a skewed server clock can't
    // stretch it); an answer that took that long is no answer
    const left = PERMIT_MS - ((await $.clock.now()) - asked)
    if (left <= 0) return
    const was = refusal
    refusal = null
    permitTimer?.cancel()
    permitTimer = $.clock.after(left, () => {
      refusal = 'offline'
      stopShowing($, false)
    })
    if (was !== null) {
      await refill($)
      if (turns.size > 0 && !slot && !onHold()) await startSlot($)
    }
  } catch {
    // Offline: the permission runs out on its own
  } finally {
    checking = false
  }
}

// A new key, or none: nothing may show until the server has answered for it
function resetPermission() {
  permitTimer?.cancel()
  permitTimer = null
  refusal = 'waiting'
}

function stopPolling() {
  linking?.cancel()
  linking = null
}

function stopLinking() {
  stopPolling()
  linkAttempt++
}

// /ads login: the server hands out a code the person approves on their dashboard, then this machine's own key, once.
// The key is kept in $.store (plugin settings can't be set from the Desktop app), tied to the API it came from.
async function startLink($: EngineInterface): Promise<string> {
  stopLinking()
  try {
    const res = await request($, `${apiUrl}/v1/link/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-version': VERSION } })
    if (!res.ok) return LINK_FAILED
    const { code, pollToken, approveUrl } = JSON.parse(res.text) as Record<string, unknown>
    if (typeof code !== 'string' || !CODE_RE.test(code) || typeof pollToken !== 'string' || !KEY_RE.test(pollToken)) return LINK_FAILED
    if (typeof approveUrl !== 'string' || !allowedApi(approveUrl) || UNSAFE.test(approveUrl)) return LINK_FAILED
    const attempt = linkAttempt
    const until = (await $.clock.now()) + LINK_WAIT_MS
    linking = $.clock.every(LINK_POLL_MS, () => {
      void claimLink($, pollToken, until, attempt)
    })
    // The one command text with a link: the person needs it on every surface, and it holds nothing secret (the code
    // only lets a signed-in person attach this machine to their own account; the poll token never leaves the Mod)
    return `To sign in, open ${approveUrl} and approve the code ${code}. This waits up to 10 minutes and says when this machine is linked.`
  } catch {
    return LINK_FAILED
  }
}

async function claimLink($: EngineInterface, pollToken: string, until: number, attempt: number) {
  if (claiming || attempt !== linkAttempt) return
  claiming = true
  try {
    if ((await $.clock.now()) > until) {
      stopLinking()
      return $.ui.toast('SpinSponsor: the sign-in code expired. Run /ads login again.')
    }
    // No deadline here: the server hands this machine's key out once, so an answer given up on would lose it (and leave an
    // unusable install taking one of the 3 places)
    const res = await $.http.fetch(`${apiUrl}/v1/link/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-version': VERSION }, body: JSON.stringify({ pollToken }) })
    if (attempt !== linkAttempt) return
    if (res.status === 409 || res.status === 410) {
      stopLinking()
      return $.ui.toast(res.status === 409 ? 'SpinSponsor: no machine could be added (limit of 3 machines, the account is not active, or the terms and storage consent are not accepted). See your dashboard.' : 'SpinSponsor: the sign-in code expired. Run /ads login again.')
    }
    const body = res.ok ? (JSON.parse(res.text) as { status?: unknown; key?: unknown }) : {}
    // Still pending, or a passing error: try again on the next tick
    if (body.status !== 'linked' || typeof body.key !== 'string' || !KEY_RE.test(body.key)) return
    stopPolling()
    await $.store.set('machine_key', { key: body.key, apiUrl })
    // Logged out (or started another login) while the key was being saved: forget it
    if (attempt !== linkAttempt) return await $.store.delete('machine_key')
    key = body.key
    linked = true
    authFailed = false
    loggedOut = false
    resetPermission()
    $.ui.toast('SpinSponsor: this machine is linked. Ads start with your next prompt.')
    await activate($)
  } catch {
    // Offline for a moment: the next tick asks again
  } finally {
    claiming = false
  }
}

// Opens an ad's click link (always the server's /c/ address, checked by toAd, so the click is counted there) in the browser
async function openLink($: EngineInterface, url: string) {
  try {
    const { exitCode } = await $.process.run(['open', url])
    if (exitCode === 0) return
  } catch {}
  $.ui.toast('SpinSponsor could not open the link in your browser.')
}

async function fingerprint(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const register: Register = (on, options) => {
  key = typeof options.install_key === 'string' ? options.install_key.trim() : ''
  pastedKey = key !== ''
  apiUrl = typeof options.api_url === 'string' ? options.api_url.replace(/\/+$/, '') : ''
  // A key without an allowed API address is treated as no key: no ads, no network
  if (!allowedApi(apiUrl)) {
    key = ''
    apiUrl = ''
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ads', description: 'SpinSponsor: status, pause, resume, open, login, logout', argumentHint: '[status|pause|resume|open|login|logout]', immediate: true })
    await boot($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await boot($)
    // Ads off for now: a new prompt is a good moment to ask again
    if (refusal !== null) void checkPermission($)
    const result = await next(e)
    turns.add(e.turnId)
    if (turns.size === 1) void startSlot($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      forgetOwner($, e.agentId)
      if (!onHold() && turns.size > 0 && !slot) void startSlot($)
      return next(e)
    }
    turns.delete(e.turnId)
    // A partial slot never counts; its ad goes back to the cache for a fresh 5 seconds next turn (fast turns would
    // otherwise use up ads that were never counted). No question or prompt outlives the turn.
    if (turns.size === 0) {
      dropSlot(true)
      forgetOwner($, 'main')
      if (band) band = { ...band, working: false }
    }
    return next(e)
  })

  // A permission prompt replaces the spinner: the slot on screen can't count. A call that needs asking is noted here...
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (result.decision === 'ask' && e.tool_use_id) asked.set(e.tool_use_id, { tool: e.tool, owner: callOwner.get(e.tool_use_id) ?? 'main' })
    return result
  })

  // ...and is a prompt on screen once its dialog opens: the PermissionRequest hooks run as it opens (they carry no call id,
  // so it is matched to the asking calls of the same tool and agent). The ad is hidden before they run; if one of them
  // answers, no dialog shows and ads come back.
  on('classic.PermissionRequest', async ($, e, next) => {
    const owner = ownerOf(e.agent_id)
    // Its own marker: answering this request releases nothing else. It closes when its asking calls have all settled
    // (several at once can't be told apart, so all of them), or when its agent's turn ends.
    const key = `perm:${++blockerSeq}`
    const calls = [...asked].filter(([, a]) => a.owner === owner && a.tool === e.tool_name).map(([id]) => id)
    if (calls.length > 0) permCalls.set(key, new Set(calls))
    hideFor($, [key], owner)
    let result
    try {
      result = await next(e)
    } catch (err) {
      permCalls.delete(key)
      unhide($, [key])
      throw err
    }
    // Answered by a hook: no dialog
    if (result?.decision) {
      permCalls.delete(key)
      unhide($, [key])
    }
    return result
  })

  // An MCP server's question (form or link) is a dialog too, until it is answered
  on('classic.Elicitation', async ($, e, next) => {
    const owner = ownerOf(e.agent_id)
    const where = `${owner}|${e.mcp_server_name}`
    // One marker per question: with an id, by it; without, queued, so concurrent questions each need their own answer
    const key = e.elicitation_id ? `elicit:${where}|${e.elicitation_id}` : `elicit:${where}|#${++blockerSeq}`
    if (!e.elicitation_id) elicitQueue.set(where, [...(elicitQueue.get(where) ?? []), key])
    hideFor($, [key], owner)
    let result
    try {
      result = await next(e)
    } catch (err) {
      closeQuestion($, where, key)
      throw err
    }
    if (result?.block) closeQuestion($, where, key)
    return result
  })
  on('classic.ElicitationResult', async ($, e, next) => {
    const where = `${ownerOf(e.agent_id)}|${e.mcp_server_name}`
    if (e.elicitation_id) unhide($, [`elicit:${where}|${e.elicitation_id}`])
    else {
      const [oldest, ...rest] = elicitQueue.get(where) ?? []
      elicitQueue.set(where, rest)
      if (oldest) unhide($, [oldest])
    }
    return next(e)
  })

  // AskUserQuestion also hides the spinner; when the last prompt or question closes, queue a fresh slot. A Bash or Monitor call
  // holds ads from here to its end whatever the engine decided about it: a sandboxed command is allowed with no dialog, and the
  // sandbox's network prompt gives this Mod no signal (so this can't wait for one, and never reads `asked`).
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const owner = ownerOf(e.agentId)
    if (id) callOwner.set(id, owner)
    if (e.tool === 'AskUserQuestion' && id) hideFor($, [id], owner)
    // A call without an id still holds (under a marker of its own)
    const command = e.tool === 'Bash' || e.tool === 'Monitor' ? (id ?? `cmd:${++blockerSeq}`) : null
    let startWindow: number | null = null
    if (command) {
      holdCommand($, command, owner)
      // Left running in the background: a window of its own until the result says whether the engine names it. Monitor always is.
      if (e.tool === 'Monitor' || (e.tool === 'Bash' && !!e.run_in_background)) startWindow = openWindow($)
    }
    try {
      const result = await next(e)
      if (command) {
        // The engine names a command it tracks, however it came to run in the background (run_in_background, Ctrl+B, its timeout...):
        // it holds until the engine says it ended, and the start's window is not needed. A foreground Bash can also end up in the
        // background with no name: the call returns while the process lives on, and its result is the only sign. Either is in place
        // before the finally below lets the command's own hold go, so ads are never free in between (Codex review, round 2).
        const task = taskIdOf(e.tool, result)
        if (task !== null) {
          if (!noticed.has(task)) {
            bgTasks.set(task, false)
            void $.clock.after(SNAPSHOT_GRACE_MS, () => (bgTasks.has(task) ? bgTasks.set(task, true) : lapsed.has(task) && lapsed.set(task, true)))
          }
          if (startWindow !== null) closeWindow(startWindow)
        } else if (startWindow === null && wentToBackground(result)) openWindow($)
      }
      return result
    } finally {
      if (command) releaseCommand($, command)
      if (id) {
        asked.delete(id)
        callOwner.delete(id)
        const closed = [id]
        for (const [k, ids] of permCalls) {
          if (!ids.delete(id) || ids.size > 0) continue
          permCalls.delete(k)
          closed.push(k)
        }
        unhide($, closed)
      }
    }
  })

  // What the session still runs, at the end of a turn (and of a subagent's): a tracked background command no longer listed has ended
  on('classic.Stop', async ($, e, next) => {
    settleTasks($, e.background_tasks, true)
    return next(e)
  })
  on('classic.SubagentStop', async ($, e, next) => {
    settleTasks($, e.background_tasks, false)
    return next(e)
  })

  // A background task's completion notice: a faster word than the next Stop that it ended (the wake-up turn draws it as it starts).
  // Only the engine's own notification rows, and only an ending: a task is not released on any other draw.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const task = e.props?.task
    if (e.props?.origin?.kind === 'task-notification' && task?.id && ENDED.has(task.status ?? '')) {
      noticed.add(task.id)
      freeTasks($, [task.id])
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface === 'terminal' && !spinnerPropsOk(e.props as Record<string, unknown>)) {
      unexpected($)
      return next(e)
    }
    const t0 = performance.now()
    let text: string | null = null
    // The terminal only: on the Desktop app the spinner row keeps Claude's step text, and the ad is a card (below)
    const drawn = e.surface === 'terminal'
    if (drawn) {
      lastSurface = e.surface
      const was = room
      room = e.viewport?.columns ? e.viewport.columns - SPINNER_CHROME : null
      if (room !== was) reconsider($)
    }
    const s = slot
    // No slot (nothing fitted before), but the screen is wider now or new ads fit: start one
    if (drawn && !s && active() && turns.size > 0 && !onHold() && room !== null && cache.some((a) => fitsIn(a))) void startSlot($)
    // A card is the band's: this hook leaves it alone (the stock spinner shows beside it)
    if (drawn && s && active() && s.format === 'line') {
      text = PREFIX + s.ad.text
      // Unmeasured width fails closed
      const fits = fitsIn(s.ad)
      if (e.props.message !== null || !fits || onHold()) {
        // The engine's status, a narrow screen, a prompt or a running command replaces the ad: a slot already on screen is void
        if (s.timer) s.clean = false
        text = null
      } else {
        lastShown = s.ad
        if (!s.timer) armSlot($, s)
      }
    }
    renderMs.push(performance.now() - t0)
    if (renderMs.length > 1000) renderMs.shift()
    if (!text) return next(e)
    try {
      return await next({ ...e, props: { ...e.props, message: text } })
    } catch (err) {
      // The ad never reached the screen: the slot can't count
      if (s) s.clean = false
      throw err
    }
  })

  // The ad card, in the band above the prompt while Claude works: always on the Desktop app, and in the terminal whenever
  // the whole card fits (else the spinner line shows the ad, never both). It counts like the line (5 continuous seconds
  // from its first draw), at the card price: it proves the card was shown, not seen (nothing says when the band is
  // collapsed or the window hidden; founder decision 2026-10-10). A survey or a permission prompt voids a running slot.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    if (!bandPropsOk(e.props as Record<string, unknown>)) {
      unexpected($)
      return next(e)
    }
    if (e.surface === 'desktop') lastSurface = 'desktop'
    const { bodyColumns, maxRows, hasSurvey } = e.props
    const working = e.props.isWorking
    const changed =
      band?.surface !== e.surface || band.bodyColumns !== bodyColumns || band.maxRows !== maxRows || band.hasSurvey !== hasSurvey || band.working !== working
    band = { surface: e.surface, bodyColumns, maxRows, hasSurvey, working }
    if (changed) reconsider($)
    const s = slot
    // No slot (nothing fitted before), but the card fits now: start one
    if (!s && active() && turns.size > 0 && !onHold() && cache.some((a) => cardFits(a))) void startSlot($)
    // A line is the spinner's: this hook leaves it alone
    if (!s || !active() || s.format !== 'card') return next(e)
    // Idle, a survey, a permission prompt or too small: no card, and a running one can't count
    if (!e.props.isWorking || onHold() || !cardFits(s.ad)) {
      if (s.timer) s.clean = false
      return next(e)
    }
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const t = THEMES[s.ad.theme] ?? THEMES.violet
    // The terminal draws "Sponsored" and the headline as one Text, so it wraps the way cardRows counts it. The Desktop app
    // keeps its two Texts side by side (nested Text is only proven on the terminal).
    const head =
      e.surface === 'terminal'
        ? Text({ color: CARD_LABEL, children: ['Sponsored ', Text({ bold: true, color: t.headline, children: [s.ad.text] })] })
        : Box({
            flexDirection: 'row',
            gap: 1,
            children: [Text({ color: CARD_LABEL, children: ['Sponsored'] }), Text({ bold: true, color: t.headline, children: [s.ad.text] })],
          })
    // Built before the slot is armed: a card that fails to build never counts
    const tree = Box({
      key: 'spinsponsor-card',
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: t.border,
      backgroundColor: t.background,
      paddingX: 1,
      children: [
        head,
        ...(s.ad.description ? [Text({ color: CARD_BODY, children: [s.ad.description] })] : []),
        e.surface === 'terminal' && appleTerminal
          ? Button({ key: 'cta', label: `${s.ad.ctaLabel} →`, onPress: () => void openLink($, s.ad.clickUrl) })
          : Link({ key: 'cta', href: s.ad.clickUrl, label: `${s.ad.ctaLabel} →` }),
      ],
    })
    lastShown = s.ad
    if (!s.timer) armSlot($, s)
    return tree
  })

  // Command text is read by the model: it never contains ad text, links or the key. Links are drawn below, on screen only.
  on('command.run', { command: 'ads' }, async ($, e) => {
    await boot($)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pause' || arg === 'resume') {
      paused = arg === 'pause'
      await $.store.set('paused', paused)
      if (paused) {
        dropSlot()
        $.ui.invalidate('ui.render')
      } else if (turns.size > 0) await startSlot($)
      return { text: paused ? 'SpinSponsor ads paused. The normal spinner is back.' : 'SpinSponsor ads resumed.' }
    }
    if (arg === 'open') return { text: lastShown ? OPEN_TEXT : 'No sponsored line has been shown yet.' }
    if (arg === 'login') {
      if (pastedKey) return { text: 'SpinSponsor uses the install key in its plugin settings. To sign in with /ads login instead, empty "Install key" (/plugin configure spinsponsor@spinsponsor) and restart.' }
      if (signedIn()) return { text: 'SpinSponsor is already signed in on this machine. To link it again, run /ads logout first.' }
      if (apiUrl === '') return { text: 'SpinSponsor has no valid API address set, so it cannot sign in.' }
      return { text: await startLink($) }
    }
    if (arg === 'logout') {
      // Stops ads and network at once for this session; clearing the key in /plugin configure makes it permanent
      loggedOut = true
      stopLinking()
      dropSlot()
      retry?.cancel()
      cache = []
      queue = []
      lastShown = null
      await saveQueue($)
      $.ui.invalidate('ui.render')
      if (linked) {
        // A linked machine forgets its key for good; the dashboard still lists it until it is revoked there
        await $.store.delete('machine_key')
        key = ''
        linked = false
        return { text: 'SpinSponsor signed out and forgot this machine\'s key, cleared its cached ads and unsent views. Revoke the machine on your dashboard if you won\'t use it again; /ads login links it afresh.' }
      }
      return { text: 'SpinSponsor signed out for this session and cleared its cached ads and unsent views. To stay signed out, run /plugin configure spinsponsor@spinsponsor and empty "Install key".' }
    }
    return { text: statusText(await $.clock.now()) }
  })

  // Draws the clickable link for /ads open on screen only
  on('ui.render', { component: 'CommandOutput', props: { command: 'ads' } }, async ($, e, next) => {
    const ad = lastShown
    if (e.props.text !== OPEN_TEXT || !ad) return next(e)
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const link =
      e.surface === 'terminal' && appleTerminal
        ? Button({ key: 'open', label: PREFIX + ad.text, onPress: () => void openLink($, ad.clickUrl) })
        : Link({ href: ad.clickUrl, label: PREFIX + ad.text })
    return Box({ flexDirection: 'column', children: [Text({ children: [e.props.text] }), link] })
  })
}
