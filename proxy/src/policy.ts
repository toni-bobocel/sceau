import { statementKinds } from './sql.ts'

export type Verdict = 'allow' | 'deny' | 'hold'
export type Access = 'read' | 'write' | 'unknown'

export interface Condition {
  arg?: string
  eq?: unknown
  ne?: unknown
  gt?: number
  gte?: number
  lt?: number
  lte?: number
  in?: unknown[]
  not_in?: unknown[]
  matches?: string
  domain_in?: string[]
  domain_not?: string[]
  sql?: string[]
  sql_only?: string[]
  carries?: string[]
}

export interface Rule {
  name: string
  match: string
  if?: Condition[]
  action: Verdict
}

export interface Policy {
  rules: Rule[]
  default: { read: Verdict; write: Verdict }
}

export interface Call {
  server: string
  tool: string
  args: Record<string, unknown>
  access: Access
  /** kinds of personal data the agent sent back as tokens, restored for this call */
  carries: string[]
}

export interface Decision {
  verdict: Verdict
  rule?: string
}

const VERDICTS = new Set(['allow', 'deny', 'hold'])
const OPS = new Set(['arg', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'matches', 'domain_in', 'domain_not', 'sql', 'sql_only', 'carries'])

/** Fails loudly on anything it does not understand: a typo in a firewall rule must not become "allow". */
export function checkPolicy(raw: { rules?: unknown; default?: unknown }): Policy {
  // written `then:` in YAML, which reads well there and nowhere else: a JS object with a `then` looks like a promise
  const written = (raw.rules ?? []) as (Omit<Rule, 'action'> & { then: Verdict })[]
  if (!Array.isArray(written)) throw new Error('rules: expected a list')
  const rules: Rule[] = []
  for (const [i, r] of written.entries()) {
    const where = `rules[${i}]${r?.name ? ` (${r.name})` : ''}`
    if (!r || typeof r.match !== 'string') throw new Error(`${where}: "match" is required, e.g. "payments/refund" or "*/send_email"`)
    if (!VERDICTS.has(r.then)) throw new Error(`${where}: "then" must be allow, deny or hold`)
    for (const c of r.if ?? []) {
      const unknown = Object.keys(c).filter(k => !OPS.has(k))
      if (unknown.length) throw new Error(`${where}: unknown condition ${unknown.join(', ')}`)
      if (c.matches) new RegExp(c.matches)
    }
    rules.push({ name: r.name ?? `${r.then} ${r.match}`, match: r.match, if: r.if, action: r.then })
  }
  const d = (raw.default ?? {}) as Partial<Policy['default']>
  const def = { read: d.read ?? 'allow', write: d.write ?? 'hold' }
  if (!VERDICTS.has(def.read) || !VERDICTS.has(def.write)) throw new Error('default: read and write must be allow, deny or hold')
  return { rules, default: def }
}

const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value)

export function matches(pattern: string, server: string, tool: string) {
  const [s, t] = pattern.includes('/') ? pattern.split('/', 2) : ['*', pattern]
  return glob(s!, server) && glob(t!, tool)
}

function pick(args: Record<string, unknown>, path: string): unknown {
  let v: unknown = args
  for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
  return v
}

const domains = (v: unknown): string[] =>
  [v]
    .flat(2)
    .filter((x): x is string => typeof x === 'string')
    .flatMap(s => s.match(/[^\s<>@,;"']+@([a-z0-9.-]+\.[a-z]{2,})/gi) ?? [])
    .map(a => a.split('@')[1]!.toLowerCase())

const within = (domain: string, list: string[]) => list.some(d => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`))

function holds(c: Condition, call: Call): boolean {
  if (c.carries) return c.carries.some(k => call.carries.includes(k))

  // with no arg named, SQL conditions look at every string argument
  const values = c.arg ? [pick(call.args, c.arg)] : Object.values(call.args)
  const v = values[0]
  if (c.sql || c.sql_only) {
    const kinds = values.filter((x): x is string => typeof x === 'string').flatMap(statementKinds)
    if (!kinds.length) return false
    if (c.sql) return kinds.some(k => c.sql!.includes(k))
    return kinds.every(k => c.sql_only!.includes(k))
  }
  if (c.domain_in || c.domain_not) {
    const found = domains(v)
    if (!found.length) return false
    return c.domain_in ? found.every(d => within(d, c.domain_in!)) : found.some(d => !within(d, c.domain_not!))
  }
  if (v === undefined) return false
  const n = Number(v)
  if (c.gt !== undefined) return n > c.gt
  if (c.gte !== undefined) return n >= c.gte
  if (c.lt !== undefined) return n < c.lt
  if (c.lte !== undefined) return n <= c.lte
  if (c.eq !== undefined) return v === c.eq
  if (c.ne !== undefined) return v !== c.ne
  if (c.in) return c.in.includes(v)
  if (c.not_in) return !c.not_in.includes(v)
  if (c.matches) return new RegExp(c.matches, 'i').test(String(v))
  return true
}

export function decide(policy: Policy, call: Call): Decision {
  for (const r of policy.rules) {
    if (matches(r.match, call.server, call.tool) && (r.if ?? []).every(c => holds(c, call))) return { verdict: r.action, rule: r.name }
  }
  return { verdict: call.access === 'read' ? policy.default.read : policy.default.write }
}
