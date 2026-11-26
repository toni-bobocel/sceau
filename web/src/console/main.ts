import '@fontsource/instrument-serif'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import '../shared/base.css'
import './console.css'
import { holdToSeal } from '../shared/hold'
import { engrave, gsap, MOTION } from '../shared/motion'
import { buildSeal } from '../shared/seal'

interface Entry {
  seq: number
  at: string
  kind: string
  session?: string
  data: any
  hash: string
}
interface Hold {
  id: string
  session: string
  server: string
  tool: string
  args: unknown
  rule?: string
  seq: number
  at: string
  expires: string
}
interface Session {
  id: string
  server: string
  transport: string
  client: { name: string; version?: string }
  calls: number
}
interface Tool {
  name: string
  access: 'read' | 'write' | 'unknown'
  calls: number
  held: number
  denied: number
  withheld?: unknown[]
}
interface State {
  head: { seq: number; hash: string }
  servers: Record<string, string>
  sessions: Session[]
  catalogue: Record<string, Tool[]>
  holds: Hold[]
  policy: { digest: string; rules: { name: string; match: string; action: string }[]; default: { read: string; write: string } }
}

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const short = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  if (r.status === 401) {
    showLogin((await r.json().catch(() => ({}))).error)
    throw new Error('signed out')
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText)
  return r.headers.get('content-type')?.includes('json') ? r.json() : (r.text() as Promise<T>)
}

// -- sign in -----------------------------------------------------------------

const login = $('.login')
const shell = $('.shell')
let loginSeal = false

function showLogin(reason?: string) {
  shell.hidden = true
  login.hidden = false
  if (!loginSeal) buildSeal($('.login__seal'), { words: 'SCEAU · SIGN IN · ' })
  loginSeal = true
  if (reason && reason !== 'sign in') $('.login__error').textContent = reason
}

$<HTMLFormElement>('.login__form').addEventListener('submit', async e => {
  e.preventDefault()
  const f = new FormData(e.target as HTMLFormElement)
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(f)) })
  if (!r.ok) {
    $('.login__error').textContent = (await r.json().catch(() => ({}))).error ?? 'could not sign in'
    return
  }
  login.hidden = true
  start()
})

$('[data-logout]').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.reload()
})

// -- views ---------------------------------------------------------------------

function show(view = location.hash.slice(1) || 'holds') {
  const name = view.startsWith('hold-') ? 'holds' : view
  for (const v of document.querySelectorAll<HTMLElement>('.view')) v.hidden = v.dataset.view !== name
  for (const a of document.querySelectorAll<HTMLElement>('.rail__nav a')) a.classList.toggle('is-on', a.dataset.view === name)
  if (name === 'map') drawLinks()
  if (name === 'policy') loadPolicy()
  if (view.startsWith('hold-')) {
    const card = document.getElementById(view)
    card?.classList.add('is-target')
    card?.scrollIntoView({ block: 'center' })
  }
}
addEventListener('hashchange', () => show())

// -- state -----------------------------------------------------------------

let state: State
const agents = new Map<string, Session>()

function updateHead(head: { seq: number; hash: string }) {
  $('.rail__head').textContent = `${head.seq} · ${short(head.hash)}`
}

// -- held calls --------------------------------------------------------------

const holdsEl = $('.holds')
const cards = new Map<string, { el: HTMLElement; timer: number }>()

function renderHold(h: Hold) {
  if (cards.has(h.id)) return
  const who = agents.get(h.session)
  const el = document.createElement('article')
  el.className = 'hcard surface crosses crosses--wax'
  el.id = `hold-${h.id}`
  el.innerHTML = `
    <div class="hcard__bar"><span class="hcard__state label">Held</span><span class="label">${esc(h.rule ?? 'default for unknown tools')}</span></div>
    <dl class="hcard__facts">
      <dt>Agent</dt><dd>${esc(who ? `${who.client.name} ${who.client.version ?? ''}` : 'unknown')}, over ${esc(who?.transport ?? 'MCP')}</dd>
      <dt>Tool</dt><dd>${esc(h.server)}/${esc(h.tool)}</dd>
      <dt>Arguments</dt><dd><pre>${esc(JSON.stringify(h.args, null, 2))}</pre></dd>
      <dt>Decide within</dt><dd><code class="hcard__left"></code></dd>
    </dl>
    <div class="hcard__actions"><div class="hcard__hold" data-label="Hold to seal" data-hint="0.8 s, or hold space"></div><button class="action action--wax" type="button">Decline</button></div>
    <p class="hcard__log">#${h.seq} <span class="hcard__status">waiting for a decision</span> <span class="hcard__digest"></span></p>`
  const left = $('.hcard__left', el)
  const tick = () => {
    const s = Math.max(0, Math.round((Date.parse(h.expires) - Date.now()) / 1000))
    left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  tick()
  const timer = window.setInterval(tick, 1000)
  const decide = (outcome: 'approved' | 'rejected') =>
    api(`/holds/${h.id}`, { method: 'POST', body: JSON.stringify({ outcome }) }).catch(e => ($('.hcard__status', el).textContent = (e as Error).message))
  holdToSeal($('.hcard__hold', el), () => decide('approved'))
  $('button', el).addEventListener('click', () => decide('rejected'))
  holdsEl.prepend(el)
  cards.set(h.id, { el, timer })
  if (MOTION) gsap.from(el, { opacity: 0, y: -24, duration: 0.9, ease: 'latch' })
  countHolds()
}

function settle(id: string, outcome: string, by?: string, entry?: Entry) {
  const c = cards.get(id)
  if (!c) return
  cards.delete(id)
  clearInterval(c.timer)
  const sealed = outcome === 'approved'
  c.el.classList.add(sealed ? 'is-sealed' : 'is-declined')
  $('.hcard__state', c.el).textContent = sealed ? 'Sealed' : outcome
  $('.hcard__status', c.el).textContent = sealed ? `sealed // verified by ${by}` : `${outcome}${by ? ` by ${by}` : ''}`
  $('.hcard__hold', c.el).setAttribute('aria-disabled', 'true')
  if (entry) engrave($('.hcard__digest', c.el), entry.hash, 1)
  gsap.to(c.el, {
    height: 0, opacity: 0, marginBottom: -40, duration: 0.7, ease: 'latch', delay: 2.4,
    onComplete: () => {
      c.el.remove()
      countHolds()
    },
  })
  countHolds()
}

let idleSeal = false
function countHolds() {
  const n = cards.size
  $('.rail__count').textContent = n ? String(n) : ''
  document.title = n ? `(${n}) Sceau` : 'Sceau'
  const empty = $('.empty')
  empty.hidden = n > 0 || holdsEl.children.length > 0
  if (!empty.hidden && !idleSeal) {
    buildSeal($('.empty__seal'))
    idleSeal = true
  }
}

// -- ledger -------------------------------------------------------------------

const entriesEl = $('.entries')

function summary(e: Entry): string {
  const d = e.data
  switch (e.kind) {
    case 'session':
      return `${d.client?.name} opened ${d.server} over ${d.transport}`
    case 'session.closed':
      return `${d.server} closed after ${d.calls} calls`
    case 'call':
      return `${d.server}/${d.tool} <span class="${d.verdict}">${d.verdict}</span>${d.rule ? ` · ${esc(d.rule)}` : ''}`
    case 'approval':
      return `<span class="${d.outcome === 'approved' ? 'sealed' : 'deny'}">${d.outcome}</span>${d.by ? ` by ${esc(d.by)}` : ''} after ${Math.round(d.waited_ms / 1000)} s`
    case 'result': {
      const masked = Object.entries(d.redacted ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')
      return `${d.method ?? 'result'}${d.error ? ' · error' : ''}${masked ? ` · masked ${masked}` : ''}${d.action ? ` · <span class="${d.action}">${d.action}</span>` : ''}${d.ms !== undefined ? ` · ${d.ms} ms` : ''}`
    }
    case 'catalogue':
      return `${d.server}: ${d.tools.length} tools${d.changed?.length ? ` · <span class="deny">changed: ${esc(d.changed.join(', '))}</span>` : ''}`
    case 'policy':
      return `${d.rules.length} rules · ${d.digest.slice(0, 12)}`
    case 'sampling':
      return `the server asked the client's model${d.findings?.length ? ' · <span class="deny">flagged</span>' : ''}`
    case 'pack':
      return `evidence pack ${d.from} to ${d.to} by ${esc(d.by)}`
    default:
      return esc(JSON.stringify(d)).slice(0, 120)
  }
}

function entryRow(e: Entry) {
  const li = document.createElement('li')
  const who = e.session ? agents.get(e.session)?.client.name : ''
  li.innerHTML = `<code>${e.seq}</code><code>${clock(e.at)}</code><span class="e__kind">${esc(e.kind)}</span><span class="e__what">${summary(e)}</span><code>${esc(who ?? '')}</code><code class="e__hash">${short(e.hash)}</code>`
  li.title = e.hash
  return li
}

function addEntry(e: Entry) {
  if (e.kind === 'session') agents.set(e.session!, { id: e.session!, server: e.data.server, transport: e.data.transport, client: e.data.client, calls: 0 })
  const li = entryRow(e)
  entriesEl.prepend(li)
  if (entriesEl.children.length > 400) entriesEl.lastElementChild?.remove()
  if (MOTION && !entriesEl.closest('[hidden]')) gsap.from(li, { opacity: 0, x: -16, duration: 0.6, ease: 'latch' })
  updateHead({ seq: e.seq, hash: e.hash })
}

$('[data-verify]').addEventListener('click', async () => {
  const chain = $('.rail__chain')
  chain.className = 'rail__chain'
  chain.textContent = 'checking…'
  const v = await api<{ ok: boolean; count?: number; seq?: number; reason?: string }>('/verify')
  chain.classList.add(v.ok ? 'is-ok' : 'is-broken')
  chain.textContent = v.ok ? `Chain intact, ${v.count} entries` : `Broken at entry ${v.seq}: ${v.reason}`
})

$<HTMLFormElement>('.export').addEventListener('submit', e => {
  e.preventDefault()
  const f = new FormData(e.target as HTMLFormElement)
  const q = new URLSearchParams()
  for (const k of ['from', 'to']) if (String(f.get(k) ?? '').trim()) q.set(k, String(f.get(k)).trim())
  location.href = `/api/pack?${q}`
})

// -- map ------------------------------------------------------------------------

function renderMap() {
  const sessions = [...agents.values()].filter(s => state.sessions.some(x => x.id === s.id))
  const byAgent = new Map<string, Set<string>>()
  for (const s of sessions) byAgent.set(s.client.name, (byAgent.get(s.client.name) ?? new Set()).add(s.server))
  const servers = new Set([...Object.keys(state.servers), ...Object.keys(state.catalogue)])

  $('[data-col="agents"] ul').innerHTML = [...byAgent].map(([name, srv]) => `<li data-agent="${esc(name)}" data-to="${esc([...srv].join(' '))}"><b>${esc(name)}</b><span>${srv.size} server${srv.size > 1 ? 's' : ''}</span></li>`).join('') || '<li><span>No agent connected yet</span></li>'
  $('[data-col="servers"] ul').innerHTML = [...servers]
    .map(s => `<li data-server="${esc(s)}"><b>${esc(s)}</b><span>${esc(state.servers[s] ?? 'not in sceau.yaml')} · ${(state.catalogue[s] ?? []).length} tools</span></li>`)
    .join('')
  $('[data-col="tools"] ul').innerHTML = Object.entries(state.catalogue)
    .flatMap(([s, tools]) =>
      tools.map(
        t => `<li data-tool="${esc(s)}" data-access="${t.access}" class="${t.withheld ? 'is-flagged' : ''}"><b>${esc(t.name)}</b><span><i class="${t.access}">${t.access}</i> · ${t.calls} calls${t.held ? ` · ${t.held} held` : ''}${t.denied ? ` · ${t.denied} blocked` : ''}${t.withheld ? ' · withheld from agents' : ''}</span></li>`,
      ),
    )
    .join('')
  drawLinks()
}

function drawLinks() {
  const map = $('.map')
  const svg = $<SVGSVGElement>('.map__links')
  if (map.closest('[hidden]')) return
  const box = map.getBoundingClientRect()
  const edge = (el: Element, side: 'l' | 'r') => {
    const r = el.getBoundingClientRect()
    return [side === 'r' ? r.right - box.left : r.left - box.left, r.top + r.height / 2 - box.top] as const
  }
  const curve = (a: readonly [number, number], b: readonly [number, number], cls = '') => {
    const mid = (a[0] + b[0]) / 2
    return `<path class="${cls}" d="M${a[0]} ${a[1]}C${mid} ${a[1]} ${mid} ${b[1]} ${b[0]} ${b[1]}"/>`
  }
  let d = ''
  for (const a of map.querySelectorAll<HTMLElement>('[data-agent]')) {
    for (const s of a.dataset.to!.split(' ')) {
      const srv = map.querySelector(`[data-server="${CSS.escape(s)}"]`)
      if (srv) d += curve(edge(a, 'r'), edge(srv, 'l'))
    }
  }
  for (const t of map.querySelectorAll<HTMLElement>('[data-tool]')) {
    const srv = map.querySelector(`[data-server="${CSS.escape(t.dataset.tool!)}"]`)
    if (srv) d += curve(edge(srv, 'r'), edge(t, 'l'), t.dataset.access === 'write' ? 'is-write' : '')
  }
  svg.innerHTML = d
}
addEventListener('resize', drawLinks)

// -- policy ------------------------------------------------------------------

async function loadPolicy() {
  $('.rules').innerHTML =
    state.policy.rules.map(r => `<li><b>${esc(r.name)}</b><code>${esc(r.match)}</code><span class="label is-${r.action}">${r.action}</span></li>`).join('') +
    `<li><b>Anything else</b><code>read-only tools: ${state.policy.default.read}, others: ${state.policy.default.write}</code><span class="label">default</span></li>`
  $('.policy__source').textContent = await api<string>('/policy')
}

// -- live --------------------------------------------------------------------

let refreshMap = 0
const soon = () => {
  clearTimeout(refreshMap)
  refreshMap = window.setTimeout(async () => {
    state = await api<State>('/state')
    renderMap()
  }, 300)
}

async function start() {
  const me = await api<{ name: string }>('/me')
  login.hidden = true
  shell.hidden = false
  $('.rail__user span').textContent = me.name
  state = await api<State>('/state')
  const history = await api<Entry[]>('/ledger?limit=300')
  for (const e of [...history].reverse()) addEntry(e)
  for (const s of state.sessions) agents.set(s.id, s)
  updateHead(state.head)
  for (const h of state.holds) renderHold(h)
  countHolds()
  renderMap()
  show()

  const pendingApprovals = new Map<number, Entry>()
  const events = new EventSource('/api/events')
  events.addEventListener('entry', e => {
    const entry = JSON.parse(e.data) as Entry
    addEntry(entry)
    if (entry.kind === 'approval') pendingApprovals.set(entry.data.call, entry)
    if (['session', 'catalogue', 'call', 'session.closed'].includes(entry.kind)) soon()
  })
  events.addEventListener('hold', e => renderHold(JSON.parse(e.data)))
  events.addEventListener('settled', e => {
    const { id, outcome, by } = JSON.parse(e.data)
    const card = cards.get(id)
    const seq = card && Number($('.hcard__log', card.el).textContent?.match(/#(\d+)/)?.[1])
    settle(id, outcome, by, seq ? pendingApprovals.get(seq) : undefined)
  })
  events.addEventListener('session', e => {
    const s = JSON.parse(e.data) as Session
    agents.set(s.id, s)
  })
  events.onerror = () => ($('.rail__chain').textContent = 'reconnecting…')
  events.onopen = () => ($('.rail__chain').textContent = '')
}

start().catch(() => {})
