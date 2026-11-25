import { createHmac } from 'node:crypto'

export const KINDS = ['iban', 'card', 'api_key', 'email', 'phone'] as const
export type Kind = (typeof KINDS)[number]

const PATTERNS: Record<Kind, RegExp> = {
  iban: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
  card: /\b\d(?:[ -]?\d){12,18}\b/g,
  api_key:
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|xox[abpors]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /(?<![\w+])(?:\+|00)[1-9](?:[ .-]?\d){7,14}\b/g,
}

// ISO 13616 lengths: with them an IBAN followed by a capitalised word is cut
// where it ends, not where the checksum happens to work out
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27,
  GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31,
  NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TR: 26, UA: 29, VA: 22,
}

function ibanCut(m: string) {
  const want = IBAN_LENGTH[m.slice(0, 2)]
  if (!want) return m
  let n = 0
  for (let i = 0; i < m.length; i++) if (m[i] !== ' ' && ++n === want) return m.slice(0, i + 1)
  return m
}

// the checksums keep order numbers and timestamps out of the vault
function ibanValid(raw: string) {
  const s = raw.replace(/ /g, '')
  const moved = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const ch of moved) {
    const n = Number.parseInt(ch, 36)
    rest = n > 9 ? (rest * 100 + n) % 97 : (rest * 10 + n) % 97
  }
  return s.length >= 15 && rest === 1
}

function luhn(raw: string) {
  const d = raw.replace(/\D/g, '')
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2
    sum += n
  }
  return sum % 10 === 0
}

const VALID: Partial<Record<Kind, (s: string) => boolean>> = { iban: ibanValid, card: luhn }
const TOKEN = /\[(IBAN|CARD|API_KEY|EMAIL|PHONE)_([0-9a-f]{8})\]/g

export type Counts = Partial<Record<Kind, number>>

/**
 * Swaps personal data for stable tokens on the way to the model, and puts the
 * real value back when the agent hands a token to a tool. The model can still
 * say "refund the customer at [EMAIL_3fa1c2d0]" without ever reading it.
 *
 * The map lives in memory only: the ledger and the model see tokens, nothing
 * on disk can be turned back into the data.
 */
export class Vault {
  readonly kinds: Kind[]
  #secret: Buffer
  #values = new Map<string, { kind: Kind; value: string }>()

  constructor(secret: Buffer, kinds: readonly Kind[] = KINDS) {
    this.#secret = secret
    this.kinds = KINDS.filter(k => kinds.includes(k))
  }

  token(kind: Kind, value: string) {
    const id = createHmac('sha256', this.#secret).update(`${kind}:${value}`).digest('hex').slice(0, 8)
    const t = `[${kind.toUpperCase()}_${id}]`
    // a proxy that runs for months must not grow for months: the oldest tokens go first
    if (this.#values.size >= 200_000) this.#values.delete(this.#values.keys().next().value!)
    this.#values.set(t, { kind, value })
    return t
  }

  redactText(text: string, counts: Counts = {}) {
    let out = text
    // order matters: an IBAN's digits would otherwise read as a card number
    for (const kind of this.kinds) {
      out = out.replace(PATTERNS[kind], m => {
        const valid = VALID[kind]
        const hit = kind === 'iban' ? ibanCut(m) : m
        if (valid && !valid(hit)) return m
        counts[kind] = (counts[kind] ?? 0) + 1
        return this.token(kind, hit) + m.slice(hit.length)
      })
    }
    return out
  }

  redact<T>(value: T, counts: Counts = {}): T {
    return walk(value, s => this.redactText(s, counts)) as T
  }

  /** Puts the values back; tokens the vault never issued are left as they are. */
  restore<T>(value: T, carried = new Set<Kind>()): T {
    return walk(value, s =>
      s.replace(TOKEN, t => {
        const v = this.#values.get(t)
        if (!v) return t
        carried.add(v.kind)
        return v.value
      }),
    ) as T
  }
}

export function walk(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map(x => walk(x, fn))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, fn)]))
  return v
}
