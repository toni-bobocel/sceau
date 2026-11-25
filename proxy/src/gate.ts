import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Config } from './config.ts'
import { type Finding, scan, strip } from './injection.ts'
import { canonical, type Entry, type Ledger, sha256 } from './ledger.ts'
import { type Access, decide } from './policy.ts'
import { type Counts, type Kind, type Vault, walk } from './redact.ts'

export type Id = string | number

export interface Message {
  jsonrpc: '2.0'
  id?: Id
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

export interface Tool {
  name: string
  access: Access
  description: string
  digest: string
  calls: number
  held: number
  denied: number
  withheld?: Finding[]
}

export interface Session {
  id: string
  server: string
  transport: 'http' | 'stdio'
  client: { name: string; version?: string }
  protocol?: string
  peer?: string
  opened: string
  seen: string
  calls: number
  pending: Map<string, { method: string; seq?: number; at: number }>
}

export interface Hold {
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

export type Outcome = 'approved' | 'rejected' | 'expired' | 'abandoned'

const key = (id: Id) => `${typeof id}:${id}`
const newId = () => randomBytes(6).toString('base64url')

const refusal = (id: Id, text: string): Message => ({
  jsonrpc: '2.0',
  id,
  result: { isError: true, content: [{ type: 'text', text }] },
})

// MCP's own hints, read conservatively: only a tool that says it is read-only is one
function accessOf(tool: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): Access {
  if (tool.annotations?.readOnlyHint === true) return 'read'
  if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint) return 'write'
  return 'unknown'
}

const texts = (v: unknown) => {
  const out: string[] = []
  walk(v, s => {
    out.push(s)
    return s
  })
  return out.join('\n')
}

const preview = (v: unknown) => {
  const s = texts(v)
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s
}

/**
 * Everything between agents and their tools goes through here, whichever
 * transport brought it. A message from a client comes back as something to
 * forward, something to answer directly, or both withheld until a person
 * decides.
 */
export class Gate extends EventEmitter {
  readonly sessions = new Map<string, Session>()
  readonly catalogue = new Map<string, Map<string, Tool>>()
  readonly holds = new Map<string, Hold & { settle: (o: Outcome, by?: string, note?: string) => void }>()
  readonly config: Config
  readonly ledger: Ledger
  readonly vault: Vault

  constructor(config: Config, ledger: Ledger, vault: Vault) {
    super()
    this.config = config
    this.ledger = ledger
    this.vault = vault
    ledger.subscribe(e => this.emit('entry', e))
    ledger.append('policy', { digest: config.policyDigest, rules: config.policy.rules.map(r => r.name), default: config.policy.default })
  }

  open(server: string, transport: Session['transport'], peer?: string): Session {
    const now = new Date().toISOString()
    const s: Session = { id: newId(), server, transport, peer, client: { name: 'unknown' }, opened: now, seen: now, calls: 0, pending: new Map() }
    this.sessions.set(s.id, s)
    return s
  }

  close(s: Session) {
    if (!this.sessions.delete(s.id)) return
    for (const h of this.holds.values()) if (h.session === s.id) h.settle('abandoned')
    this.ledger.append('session.closed', { server: s.server, calls: s.calls }, s.id)
    this.emit('session', s)
  }

  async fromClient(s: Session, msg: Message, signal?: AbortSignal): Promise<{ forward?: Message; reply?: Message }> {
    s.seen = new Date().toISOString()
    if (msg.method === 'initialize') {
      s.client = { name: String(msg.params?.clientInfo?.name ?? 'unknown'), version: msg.params?.clientInfo?.version }
      s.protocol = msg.params?.protocolVersion
      this.ledger.append('session', { server: s.server, transport: s.transport, client: s.client, protocol: s.protocol, peer: s.peer }, s.id)
      this.emit('session', s)
    }
    if (msg.method === 'tools/call' && msg.id !== undefined) return this.#call(s, msg as Message & { id: Id }, signal)
    if (msg.method && msg.id !== undefined) s.pending.set(key(msg.id), { method: msg.method, at: Date.now() })
    return { forward: msg }
  }

  async #call(s: Session, msg: Message & { id: Id }, signal?: AbortSignal) {
    const name = String(msg.params?.name ?? '')
    const sent = msg.params?.arguments ?? {}
    const carried = new Set<Kind>()
    const args = this.vault.restore(sent, carried)
    const tool = this.#tool(s.server, name)
    const d = decide(this.config.policy, { server: s.server, tool: name, args, access: tool.access, carries: [...carried] })

    s.calls++
    tool.calls++
    const call = this.ledger.append(
      'call',
      { rpc: msg.id, server: s.server, tool: name, args: this.vault.redact(sent), carries: [...carried], verdict: d.verdict, rule: d.rule },
      s.id,
    )
    const because = d.rule ? `the rule "${d.rule}"` : `the default for ${tool.access} tools`

    if (d.verdict === 'deny') {
      tool.denied++
      return { reply: refusal(msg.id, `Sceau blocked this call under ${because}. Do not retry it; tell the user it needs a person's decision.`) }
    }
    if (d.verdict === 'hold') {
      tool.held++
      const outcome = await this.#hold(s, name, sent, d.rule, call, signal)
      if (outcome !== 'approved') {
        const why = outcome === 'expired' ? 'no one approved it in time' : 'a person declined it'
        return { reply: refusal(msg.id, `Sceau held this call under ${because}, and ${why}. Do not retry it.`) }
      }
    }
    s.pending.set(key(msg.id), { method: 'tools/call', seq: call.seq, at: Date.now() })
    return { forward: { ...msg, params: { ...msg.params, arguments: args } } }
  }

  #hold(s: Session, tool: string, args: unknown, rule: string | undefined, call: Entry, signal?: AbortSignal) {
    const now = Date.now()
    const id = newId()
    return new Promise<Outcome>(resolve => {
      const timer = setTimeout(() => settle('expired'), this.config.holdTimeout)
      const settle = (outcome: Outcome, by?: string, note?: string) => {
        if (!this.holds.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abandon)
        this.ledger.append('approval', { call: call.seq, hold: id, outcome, by, note, waited_ms: Date.now() - now }, s.id)
        this.emit('settled', { id, outcome, by })
        resolve(outcome)
      }
      const abandon = () => settle('abandoned')
      signal?.addEventListener('abort', abandon, { once: true })
      const hold = {
        id, session: s.id, server: s.server, tool, args: this.vault.redact(args), rule, seq: call.seq,
        at: new Date(now).toISOString(), expires: new Date(now + this.config.holdTimeout).toISOString(), settle,
      }
      this.holds.set(id, hold)
      this.emit('hold', hold)
    })
  }

  /** Returns false when the hold was already settled, by someone else or by the clock. */
  settle(id: string, outcome: 'approved' | 'rejected', by: string, note?: string) {
    const h = this.holds.get(id)
    if (!h) return false
    h.settle(outcome, by, note)
    return true
  }

  fromServer(s: Session, msg: Message): Message {
    s.seen = new Date().toISOString()
    if (msg.id !== undefined && !msg.method) {
      const p = s.pending.get(key(msg.id))
      if (!p) return msg
      s.pending.delete(key(msg.id))
      if (msg.error) {
        if (p.seq) this.ledger.append('result', { call: p.seq, error: msg.error, ms: Date.now() - p.at }, s.id)
        return msg
      }
      if (p.method === 'tools/list') return this.#list(s, msg)
      if (p.method === 'tools/call' || p.method === 'resources/read' || p.method === 'prompts/get') return this.#content(s, msg, p)
      return msg
    }
    // the server asking the client's model: this is the one prompt that crosses MCP
    if (msg.method === 'sampling/createMessage') {
      const counts: Counts = {}
      const params = this.vault.redact(msg.params, counts)
      this.ledger.append('sampling', { messages: params?.messages, system: params?.systemPrompt, redacted: counts, findings: scan(texts(msg.params)) }, s.id)
      return { ...msg, params }
    }
    if (msg.method === 'notifications/tools/list_changed') this.ledger.append('catalogue.stale', { server: s.server }, s.id)
    return msg
  }

  #tool(server: string, name: string): Tool {
    const tools = this.catalogue.get(server) ?? new Map<string, Tool>()
    this.catalogue.set(server, tools)
    const t = tools.get(name) ?? { name, access: 'unknown', description: '', digest: '', calls: 0, held: 0, denied: 0 }
    tools.set(name, t)
    return t
  }

  #list(s: Session, msg: Message): Message {
    const listed: any[] = msg.result?.tools ?? []
    const kept: any[] = []
    const changed: string[] = []
    for (const def of listed) {
      const t = this.#tool(s.server, String(def.name))
      const digest = sha256(canonical({ description: def.description, inputSchema: def.inputSchema, annotations: def.annotations }))
      // a tool that rewrites its own description after it was trusted is the classic rug pull
      if (t.digest && t.digest !== digest) changed.push(t.name)
      t.digest = digest
      t.access = accessOf(def)
      t.description = String(def.description ?? '')
      const findings = scan(texts([def.description, def.inputSchema]))
      t.withheld = findings.length && this.config.injection === 'block' ? findings : undefined
      if (!t.withheld) kept.push(def)
    }
    const tools = [...(this.catalogue.get(s.server)?.values() ?? [])].filter(t => listed.some(d => d.name === t.name))
    this.ledger.append(
      'catalogue',
      { server: s.server, tools: tools.map(t => ({ name: t.name, access: t.access, digest: t.digest, withheld: t.withheld })), changed },
      s.id,
    )
    this.emit('catalogue', s.server)
    return kept.length === listed.length ? msg : { ...msg, result: { ...msg.result, tools: kept } }
  }

  #content(s: Session, msg: Message, p: { method: string; seq?: number; at: number }): Message {
    let result = msg.result
    const findings = scan(texts(result))
    let action: 'withheld' | 'stripped' | 'flagged' | undefined
    if (findings.length) {
      const mode = this.config.injection
      const serious = findings.some(f => f.severity === 'high')
      if (mode === 'block' && serious) {
        action = 'withheld'
        result = {
          isError: true,
          content: [{ type: 'text', text: `Sceau withheld this result: it carries instructions aimed at the agent (${[...new Set(findings.map(f => f.kind))].join(', ')}). Tell the user.` }],
        }
      } else if (mode === 'flag' || !serious) {
        action = 'flagged'
      } else {
        action = 'stripped'
        result = walk(result, strip)
      }
    }
    const counts: Counts = {}
    const redacted = this.vault.redact(result, counts)
    this.ledger.append(
      'result',
      {
        call: p.seq, method: p.method, digest: sha256(canonical(msg.result)), error: redacted?.isError === true || undefined,
        redacted: counts, findings: findings.length ? findings : undefined, action, preview: preview(redacted), ms: Date.now() - p.at,
      },
      s.id,
    )
    return { ...msg, result: redacted }
  }
}
