import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto'
import { closeSync, existsSync, fdatasyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface Entry {
  seq: number
  at: string
  kind: string
  session?: string
  data: unknown
  prev: string
  hash: string
  sig: string
}

export const GENESIS = '0'.repeat(64)

// Keys sorted at every level: the hash must not depend on the order a
// JavaScript object happened to be built in, or on the language re-checking it.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter(k => o[k] !== undefined)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

const digest = (e: Omit<Entry, 'hash' | 'sig'>) =>
  sha256(canonical({ seq: e.seq, at: e.at, kind: e.kind, session: e.session, data: e.data, prev: e.prev }))

export type Verdict = { ok: true; count: number; head: string } | { ok: false; seq: number; reason: string }

export function verifyEntries(entries: Entry[], publicKey: string | KeyObject, from = { seq: 1, prev: GENESIS }): Verdict {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey
  let { seq, prev } = from
  for (const e of entries) {
    if (e.seq !== seq) return { ok: false, seq: e.seq, reason: `expected entry ${seq}, found ${e.seq}` }
    if (e.prev !== prev) return { ok: false, seq: e.seq, reason: 'does not follow the previous entry' }
    if (digest(e) !== e.hash) return { ok: false, seq: e.seq, reason: 'content does not match its hash' }
    if (!verify(null, Buffer.from(e.hash, 'hex'), key, Buffer.from(e.sig, 'base64'))) {
      return { ok: false, seq: e.seq, reason: 'signature does not match the key' }
    }
    prev = e.hash
    seq++
  }
  return { ok: true, count: entries.length, head: prev }
}

export function parseLines(text: string): Entry[] {
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry)
}

/**
 * Append-only, one JSON line per entry, each one chained to the last and
 * signed. Written with fdatasync: an approval that was shown as sealed must
 * still be there after a power cut.
 */
export class Ledger {
  readonly dir: string
  readonly publicKey: string
  readonly path: string
  #key: KeyObject
  #fd: number
  #seq = 0
  #head = GENESIS
  #listeners = new Set<(e: Entry) => void>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    const keyFile = join(dir, 'sceau.key')
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519')
      writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    }
    this.#key = createPrivateKey(readFileSync(keyFile))
    this.publicKey = createPublicKey(this.#key).export({ type: 'spki', format: 'pem' }).toString()
    writeFileSync(join(dir, 'sceau.pub'), this.publicKey)

    this.path = join(dir, 'ledger.jsonl')
    if (existsSync(this.path)) {
      const last = parseLines(readFileSync(this.path, 'utf8')).at(-1)
      if (last) {
        this.#seq = last.seq
        this.#head = last.hash
      }
    }
    this.#fd = openSync(this.path, 'a')
  }

  get head() {
    return { seq: this.#seq, hash: this.#head }
  }

  append(kind: string, data: unknown, session?: string): Entry {
    const body = { seq: this.#seq + 1, at: new Date().toISOString(), kind, session, data, prev: this.#head }
    const hash = digest(body)
    const entry: Entry = { ...body, hash, sig: sign(null, Buffer.from(hash, 'hex'), this.#key).toString('base64') }
    writeSync(this.#fd, `${JSON.stringify(entry)}\n`)
    fdatasyncSync(this.#fd)
    this.#seq = entry.seq
    this.#head = hash
    for (const fn of this.#listeners) fn(entry)
    return entry
  }

  read(from = 1, to = Number.POSITIVE_INFINITY): Entry[] {
    return parseLines(readFileSync(this.path, 'utf8')).filter(e => e.seq >= from && e.seq <= to)
  }

  verify(): Verdict {
    return verifyEntries(this.read(), this.publicKey)
  }

  subscribe(fn: (e: Entry) => void) {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  close() {
    closeSync(this.#fd)
  }
}
