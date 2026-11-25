import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The people who may seal a held call. A file next to the ledger rather than
// a database: there are a handful of them and the proxy already owns that folder.

interface Account {
  salt: string
  hash: string
  created: string
}

const DAY = 24 * 3600e3

export class Users {
  #file: string
  #secret: Buffer
  #accounts: Record<string, Account>

  constructor(dir: string) {
    this.#file = join(dir, 'users.json')
    this.#accounts = existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, 'utf8')) : {}
    const secretFile = join(dir, 'cookie.key')
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32), { mode: 0o600 })
    this.#secret = readFileSync(secretFile)
  }

  get count() {
    return Object.keys(this.#accounts).length
  }

  set(name: string, password: string) {
    if (!/^[a-z0-9._-]{2,32}$/i.test(name)) throw new Error('names are 2 to 32 letters, digits, dots, dashes or underscores')
    if (password.length < 12) throw new Error('passwords are 12 characters at least: this account seals payments')
    const salt = randomBytes(16)
    this.#accounts[name] = { salt: salt.toString('hex'), hash: scryptSync(password, salt, 32).toString('hex'), created: new Date().toISOString() }
    writeFileSync(this.#file, `${JSON.stringify(this.#accounts, null, 2)}\n`, { mode: 0o600 })
  }

  check(name: string, password: string) {
    const a = this.#accounts[name]
    // same work whether the name exists or not, so timing does not list the accounts
    const salt = a ? Buffer.from(a.salt, 'hex') : randomBytes(16)
    const got = scryptSync(password, salt, 32)
    return !!a && timingSafeEqual(got, Buffer.from(a.hash, 'hex'))
  }

  issue(name: string, days = 7) {
    const body = `${name}.${Date.now() + days * DAY}`
    return `${body}.${createHmac('sha256', this.#secret).update(body).digest('base64url')}`
  }

  /** The account name a cookie was issued to, if it is genuine, current, and the account still exists. */
  read(cookie: string | undefined) {
    if (!cookie) return undefined
    const i = cookie.lastIndexOf('.')
    const body = cookie.slice(0, i)
    const want = createHmac('sha256', this.#secret).update(body).digest()
    const sig = Buffer.from(cookie.slice(i + 1), 'base64url')
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return undefined
    const j = body.lastIndexOf('.')
    const name = body.slice(0, j)
    if (Number(body.slice(j + 1)) < Date.now() || !this.#accounts[name]) return undefined
    return name
  }
}
