import { relative } from 'node:path'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Gate, Hold, Id, Message, Session } from './gate.ts'
import { slackAction } from './notify.ts'
import { buildPack } from './pack.ts'
import { frame, readEvents } from './sse.ts'
import type { Users } from './users.ts'

// headers that belong to this hop, or to the console, and must not reach a tool server
const DROP = new Set(['host', 'connection', 'content-length', 'cookie', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade', 'origin', 'referer'])
const KEEP_ALIVE = 15_000

const enc = new TextEncoder()

function view(s: Session) {
  const { pending, ...rest } = s
  return { ...rest, waiting: pending.size }
}

const viewHold = ({ settle, ...h }: Hold & { settle?: unknown }) => h

export function app(gate: Gate, users: Users, opts: { consoleDir?: string; version: string }) {
  const { config, ledger } = gate
  const api = new Hono()

  const peer = (c: Context) => {
    try {
      return getConnInfo(c).remote.address
    } catch {
      return undefined
    }
  }

  // -- MCP over Streamable HTTP ---------------------------------------------

  const byId = new Map<string, Session>()
  const anon = new Map<string, Session>()

  function sessionFor(c: Context, server: string, initialize: boolean) {
    const sid = c.req.header('mcp-session-id')
    if (sid) {
      const known = byId.get(`${server}\n${sid}`)
      if (known) return known
      // a session that predates a restart of the proxy: pick it up as it is
      const s = gate.open(server, 'http', peer(c))
      byId.set(`${server}\n${sid}`, s)
      return s
    }
    if (initialize) return gate.open(server, 'http', peer(c))
    // servers that keep no session at all: one per agent address
    const k = `${server}\n${peer(c)}`
    const s = anon.get(k) ?? gate.open(server, 'http', peer(c))
    anon.set(k, s)
    return s
  }

  const remember = (server: string, s: Session, res: Response) => {
    const sid = res.headers.get('mcp-session-id')
    if (sid) byId.set(`${server}\n${sid}`, s)
  }

  const upstreamHeaders = (req: Request, extra?: Record<string, string>) => {
    const h = new Headers()
    for (const [k, v] of req.headers) if (!DROP.has(k) && !k.startsWith('x-forwarded') && !k.startsWith('sec-')) h.set(k, v)
    for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v)
    return h
  }

  const passthrough = (res: Response) => {
    const h = new Headers()
    for (const k of ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control']) {
      const v = res.headers.get(k)
      if (v) h.set(k, v)
    }
    return new Response(res.body, { status: res.status, headers: h })
  }

  api.post('/mcp/:server', async c => {
    const name = c.req.param('server')
    const url = config.servers[name]?.url
    if (!url) return c.json({ error: `no server called ${name} in sceau.yaml` }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    }
    const batch = Array.isArray(body)
    const messages = (batch ? body : [body]) as Message[]
    const requests = messages.filter(m => m.method && m.id !== undefined)
    const s = sessionFor(c, name, messages.some(m => m.method === 'initialize'))
    const signal = c.req.raw.signal
    const headers = upstreamHeaders(c.req.raw, config.servers[name]!.headers)
    const answered = new Set<Id>()

    // runs the messages through the gate and the server; `out` gets everything for the client
    const run = async (out: (m: Message) => void, upstream: (res: Response) => boolean) => {
      const forwards: Message[] = []
      for (const m of messages) {
        const r = await gate.fromClient(s, m, signal)
        if (r.reply) out(r.reply)
        if (r.forward) forwards.push(r.forward)
      }
      if (!forwards.length) return
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(batch ? forwards : forwards[0]), signal })
      remember(name, s, res)
      if (!upstream(res) || res.status === 202 || res.status === 204) return
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream')) {
        for await (const ev of readEvents(res.body!)) out(gate.fromServer(s, JSON.parse(ev.data)))
      } else {
        for (const m of [await res.json()].flat() as Message[]) out(gate.fromServer(s, m))
      }
    }
    const note = (m: Message) => {
      if (m.id !== undefined && !m.method) answered.add(m.id)
    }
    const unanswered = (why: string) =>
      requests.filter(r => !answered.has(r.id!)).map(r => ({ jsonrpc: '2.0' as const, id: r.id, error: { code: -32603, message: `Sceau could not reach ${name}: ${why}` } }))

    if (!requests.length) {
      let status = 202
      let res: Response | undefined
      await run(() => {}, r => {
        res = r
        status = r.status
        return false
      })
      return res && !res.ok ? passthrough(res) : new Response(null, { status })
    }

    // a client that only takes JSON waits for the whole answer, holds included
    if (!(c.req.header('accept') ?? '').includes('text/event-stream')) {
      const out: Message[] = []
      let failed: Response | undefined
      try {
        await run(
          m => {
            note(m)
            if (m.id !== undefined && !m.method) out.push(m)
          },
          r => {
            if (r.ok) return true
            failed = r
            return false
          },
        )
      } catch (e) {
        out.push(...unanswered((e as Error).message))
      }
      if (failed) return passthrough(failed)
      out.push(...unanswered('no answer'))
      return c.json(batch ? out : out[0])
    }

    // otherwise answer as a stream, opened early if a person has to decide first
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(x) {
        ctl = x
      },
    })
    const ready = Promise.withResolvers<Response>()
    const open = (sid?: string | null) => {
      const h = new Headers({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const id = sid ?? c.req.header('mcp-session-id')
      if (id) h.set('mcp-session-id', id)
      ready.resolve(new Response(stream, { headers: h }))
    }
    let opened = false
    const early = setTimeout(() => {
      opened = true
      open()
    }, 300)
    // the SDKs time a request out after a minute unless progress keeps arriving
    const tokens = requests.map(r => r.params?._meta?.progressToken).filter(t => t !== undefined)
    let tick = 0
    const alive = setInterval(() => {
      tick++
      ctl.enqueue(enc.encode(': waiting for a decision\n\n'))
      for (const progressToken of tokens) {
        ctl.enqueue(enc.encode(frame({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: tick, message: 'Held by Sceau until a person decides' } }, { event: 'message' })))
      }
    }, KEEP_ALIVE)
    const send = (m: Message) => {
      note(m)
      ctl.enqueue(enc.encode(frame(m, { event: 'message' })))
    }

    run(send, r => {
      if (!r.ok && !opened) {
        clearTimeout(early)
        opened = true
        ready.resolve(passthrough(r))
        return false
      }
      if (!opened) {
        clearTimeout(early)
        opened = true
        open(r.headers.get('mcp-session-id'))
      }
      return true
    })
      .catch(e => {
        if (!signal.aborted) for (const m of unanswered((e as Error).message)) send(m)
      })
      .finally(() => {
        clearTimeout(early)
        clearInterval(alive)
        if (!signal.aborted) for (const m of unanswered('no answer')) send(m)
        if (!opened) open()
        try {
          ctl.close()
        } catch {
          // the client already went away
        }
      })
    return ready.promise
  })

  api.get('/mcp/:server', async c => {
    const name = c.req.param('server')
    const url = config.servers[name]?.url
    if (!url) return c.json({ error: `no server called ${name} in sceau.yaml` }, 404)
    const res = await fetch(url, { headers: upstreamHeaders(c.req.raw, config.servers[name]!.headers), signal: c.req.raw.signal })
    const sid = c.req.header('mcp-session-id')
    const s = sid && byId.get(`${name}\n${sid}`)
    if (!s || !res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return passthrough(res)
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        try {
          for await (const ev of readEvents(res.body!)) ctl.enqueue(enc.encode(frame(gate.fromServer(s, JSON.parse(ev.data)), { event: 'message', id: ev.id })))
        } catch {
          // upstream or client closed the stream
        }
        ctl.close()
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': sid } })
  })

  api.delete('/mcp/:server', async c => {
    const name = c.req.param('server')
    const url = config.servers[name]?.url
    if (!url) return c.json({ error: `no server called ${name} in sceau.yaml` }, 404)
    const sid = c.req.header('mcp-session-id')
    const s = sid && byId.get(`${name}\n${sid}`)
    if (s) {
      byId.delete(`${name}\n${sid}`)
      gate.close(s)
    }
    return passthrough(await fetch(url, { method: 'DELETE', headers: upstreamHeaders(c.req.raw, config.servers[name]!.headers) }))
  })

  // -- stdio servers, through `sceau wrap` ----------------------------------

  const relay = new Hono()
  relay.use(async (c, next) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer(c) ?? '')
    const token = config.relayToken
    if (token ? c.req.header('authorization') !== `Bearer ${token}` : !local) {
      return c.json({ error: token ? 'bad relay token' : 'set relay_token to accept wrappers from another host' }, 401)
    }
    await next()
  })
  const wrapped = new Map<string, Session>()
  relay.post('/open', async c => {
    const { server } = await c.req.json<{ server: string }>()
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(server ?? '')) return c.json({ error: 'name the server with letters, digits, - and _' }, 400)
    const s = gate.open(server, 'stdio', peer(c))
    wrapped.set(s.id, s)
    return c.json({ session: s.id })
  })
  relay.post('/:id/in', async c => {
    const s = wrapped.get(c.req.param('id'))
    if (!s) return c.json({ error: 'unknown session' }, 404)
    return c.json(await gate.fromClient(s, await c.req.json<Message>(), c.req.raw.signal))
  })
  relay.post('/:id/out', async c => {
    const s = wrapped.get(c.req.param('id'))
    if (!s) return c.json({ error: 'unknown session' }, 404)
    return c.json(gate.fromServer(s, await c.req.json<Message>()))
  })
  relay.post('/:id/close', c => {
    const s = wrapped.get(c.req.param('id'))
    if (s) {
      wrapped.delete(s.id)
      gate.close(s)
    }
    return c.body(null, 204)
  })
  api.route('/relay', relay)

  // -- the console ----------------------------------------------------------

  const secure = config.publicUrl.startsWith('https:')
  const failures = new Map<string, { n: number; until: number }>()

  api.post('/api/login', async c => {
    const ip = peer(c) ?? '?'
    const f = failures.get(ip)
    if (f && f.n >= 8 && f.until > Date.now()) return c.json({ error: 'too many attempts, try again in a few minutes' }, 429)
    const { name, password } = await c.req.json<{ name: string; password: string }>()
    if (!users.check(String(name), String(password))) {
      failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60e3 })
      return c.json({ error: 'wrong name or password' }, 401)
    }
    failures.delete(ip)
    setCookie(c, 'sceau', users.issue(name), { httpOnly: true, sameSite: 'Strict', secure, path: '/', maxAge: 7 * 86400 })
    return c.json({ name })
  })
  api.post('/api/logout', c => {
    deleteCookie(c, 'sceau', { path: '/' })
    return c.body(null, 204)
  })

  const console = new Hono<{ Variables: { user: string } }>()
  console.use(async (c, next) => {
    const user = users.read(getCookie(c, 'sceau'))
    if (!user) return c.json({ error: users.count ? 'sign in' : 'no accounts yet: run `sceau user add <name>`' }, 401)
    // the cookie is SameSite=Strict; requiring JSON on writes closes the last form-post route
    if (c.req.method === 'POST' && !c.req.header('content-type')?.includes('application/json')) return c.json({ error: 'JSON only' }, 415)
    c.set('user', user)
    await next()
  })

  console.get('/me', c => c.json({ name: c.get('user') }))

  console.get('/state', c =>
    c.json({
      version: opts.version,
      head: ledger.head,
      servers: Object.fromEntries(Object.entries(config.servers).map(([k, v]) => [k, v.url ? 'http' : 'stdio'])),
      sessions: [...gate.sessions.values()].map(view),
      catalogue: Object.fromEntries([...gate.catalogue].map(([k, tools]) => [k, [...tools.values()]])),
      holds: [...gate.holds.values()].map(viewHold),
      policy: { digest: config.policyDigest, rules: config.policy.rules.map(({ name, match, action }) => ({ name, match, action })), default: config.policy.default },
      injection: config.injection,
      redact: config.redact,
    }),
  )

  console.get('/policy', c => c.text(config.policySource))

  console.get('/ledger', c => {
    const head = ledger.head.seq
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000)
    const before = Number(c.req.query('before') ?? head + 1)
    return c.json(ledger.read(Math.max(1, before - limit), before - 1).reverse())
  })

  console.get('/verify', c => c.json(ledger.verify()))

  console.get('/pack', c => {
    const from = Number(c.req.query('from') ?? 1)
    const to = c.req.query('to') ? Number(c.req.query('to')) : undefined
    try {
      const zip = buildPack(ledger, config.data, { from, to, generator: `sceau ${opts.version}`, policySource: config.policySource })
      ledger.append('pack', { from, to: to ?? ledger.head.seq, by: c.get('user') })
      const day = new Date().toISOString().slice(0, 10)
      return c.body(new Uint8Array(zip), 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="sceau-evidence-${day}.zip"` })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  console.post('/holds/:id', async c => {
    const { outcome, note } = await c.req.json<{ outcome: 'approved' | 'rejected'; note?: string }>()
    if (outcome !== 'approved' && outcome !== 'rejected') return c.json({ error: 'outcome is approved or rejected' }, 400)
    return gate.settle(c.req.param('id'), outcome, c.get('user'), note?.slice(0, 500)) ? c.json({ ok: true, head: ledger.head }) : c.json({ error: 'already settled' }, 409)
  })

  console.get('/events', c => {
    const out: [string, (...a: any[]) => void][] = []
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    const push = (event: string, data: unknown) => {
      try {
        ctl.enqueue(enc.encode(frame(data, { event })))
      } catch {
        stop()
      }
    }
    const on = (event: string, map: (x: any) => unknown = x => x) => {
      const fn = (x: unknown) => push(event, map(x))
      gate.on(event, fn)
      out.push([event, fn])
    }
    const ping = setInterval(() => push('ping', Date.now()), 20_000)
    const stop = () => {
      clearInterval(ping)
      for (const [e, fn] of out) gate.off(e, fn)
    }
    c.req.raw.signal.addEventListener('abort', stop)
    const body = new ReadableStream<Uint8Array>({
      start: x => {
        ctl = x
        on('entry')
        on('hold', viewHold)
        on('settled')
        on('session', view)
        on('catalogue', server => ({ server, tools: [...(gate.catalogue.get(server)?.values() ?? [])] }))
      },
      cancel: stop,
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  })

  api.route('/api', console)

  api.post('/slack/actions', async c => {
    const r = slackAction(config, gate, await c.req.text(), c.req.raw.headers)
    return r.status === 200 ? c.json({ replace_original: !!r.text, text: r.text }) : c.text(r.text, r.status as 401)
  })

  api.get('/healthz', c => c.json({ ok: true, head: ledger.head.seq }))

  if (opts.consoleDir) {
    const root = relative(process.cwd(), opts.consoleDir) || '.'
    api.use('/*', serveStatic({ root, rewriteRequestPath: p => (p === '/' ? '/console.html' : p) }))
  }
  return api
}
