import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { sha256 } from './ledger.ts'
import { checkPolicy, type Policy } from './policy.ts'
import { KINDS, type Kind } from './redact.ts'

export interface Upstream {
  /** Streamable HTTP endpoint; absent for servers reached through `sceau wrap` */
  url?: string
  headers?: Record<string, string>
}

export interface Config {
  host: string
  port: number
  data: string
  publicUrl: string
  servers: Record<string, Upstream>
  holdTimeout: number
  slack?: { webhookUrl?: string; botToken?: string; channel?: string; signingSecret?: string }
  webhook?: string
  redact: Kind[]
  injection: 'block' | 'strip' | 'flag'
  relayToken?: string
  policy: Policy
  policySource: string
  policyDigest: string
}

const ms = (v: unknown, fallback: number) => {
  if (v === undefined) return fallback
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(v).trim())
  if (!m) throw new Error(`approvals.timeout: "${v}" is not a duration like 90s, 10m or 1h`)
  return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[m[2] as 'ms']
}

// ${NAME} and ${NAME:-fallback}, so secrets stay in the environment and out of the file
const interpolate = (text: string, env: NodeJS.ProcessEnv) =>
  text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? '')

export function loadConfig(path: string, env = process.env): Config {
  const source = readFileSync(path, 'utf8')
  const raw = (parse(interpolate(source, env)) ?? {}) as Record<string, any>
  const [host, port] = String(raw.listen ?? '127.0.0.1:7325').split(':')

  const servers: Record<string, Upstream> = {}
  for (const [name, s] of Object.entries((raw.servers ?? {}) as Record<string, Upstream | null>)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`servers.${name}: use letters, digits, - and _`)
    if (s?.url) new URL(s.url)
    servers[name] = { url: s?.url, headers: s?.headers }
  }

  const redact = raw.redact === false ? [] : ((raw.redact ?? KINDS) as Kind[])
  for (const k of redact) if (!KINDS.includes(k)) throw new Error(`redact: unknown kind "${k}" (${KINDS.join(', ')})`)
  const injection = raw.injection ?? 'block'
  if (!['block', 'strip', 'flag'].includes(injection)) throw new Error('injection: block, strip or flag')

  const slack = raw.approvals?.slack
  const listen = { host: host || '127.0.0.1', port: Number(port ?? 7325) }
  return {
    ...listen,
    data: resolve(dirname(path), raw.data ?? 'data'),
    publicUrl: String(raw.public_url ?? `http://localhost:${listen.port}`).replace(/\/$/, ''),
    servers,
    holdTimeout: ms(raw.approvals?.timeout, 10 * 60e3),
    slack: slack && {
      webhookUrl: slack.webhook_url || undefined,
      botToken: slack.bot_token || undefined,
      channel: slack.channel || undefined,
      signingSecret: slack.signing_secret || undefined,
    },
    webhook: raw.approvals?.webhook || undefined,
    redact,
    injection,
    relayToken: raw.relay_token || env.SCEAU_RELAY_TOKEN || undefined,
    policy: checkPolicy(raw),
    policySource: source,
    policyDigest: sha256(source),
  }
}
