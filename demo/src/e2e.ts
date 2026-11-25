import assert from 'node:assert/strict'
import { checkPack } from '../../proxy/src/pack.ts'
import { readEvents } from '../../proxy/src/sse.ts'
import { ticket } from './agent.ts'

// Plays the demo ticket against a running stack, seals the refund as an
// approver would, then checks the ledger and an evidence pack. CI runs it
// against `docker compose up`.

const base = process.env.SCEAU_URL ?? 'http://127.0.0.1:7325'
const password = process.env.SCEAU_ADMIN_PASSWORD ?? 'seal-it-yourself'

for (let i = 0; i < 100; i++) {
  if (await fetch(`${base}/healthz`).then(r => r.ok, () => false)) break
  await new Promise(r => setTimeout(r, 300))
}

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin', password }) })
assert.equal(login.status, 200, 'admin can sign in')
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
const api = (path: string, init: RequestInit = {}) => fetch(`${base}/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...init.headers } })

// the approver: seals whatever is held, the way a person would from the console
const events = await api('/events')
const sealed: string[] = []
void (async () => {
  for await (const ev of readEvents(events.body!)) {
    if (ev.event !== 'hold') continue
    const h = JSON.parse(ev.data) as { id: string; server: string; tool: string }
    sealed.push(`${h.server}/${h.tool}`)
    await api(`/holds/${h.id}`, { method: 'POST', body: JSON.stringify({ outcome: 'approved', note: 'e2e' }) })
  }
})().catch(() => {})

const steps = await ticket(base, s => console.log(s))
const at = (tool: string, n = 0) => steps.filter(s => s.tool === tool)[n]!

assert.ok(at('crm/get_customer').ok)
assert.doesNotMatch(at('crm/get_customer').text, /claire\.martin@example\.fr|FR76 3000/, 'personal data is masked')
assert.ok(at('payments/refund').ok, 'the held refund went through once sealed')
assert.deepEqual(sealed, ['payments/refund'])
assert.ok(at('mail/send_email').ok, 'mail to the customer from the CRM is allowed')
assert.ok(!at('crm/query').ok && at('crm/query').text.includes('nothing is ever deleted'))
assert.ok(!at('files/read_file', 1).ok && at('files/read_file', 1).text.includes('withheld'), 'the poisoned invoice never reached the agent')
assert.match(at('crm/query', 1).text, /\[IBAN_[0-9a-f]{8}\]/)
assert.ok(!at('mail/send_email', 1).ok && at('mail/send_email', 1).text.includes('bank details never leave by mail'))

const verify = (await (await api('/verify')).json()) as { ok: boolean; count: number }
assert.equal(verify.ok, true, 'the ledger verifies')
const pack = await api('/pack')
assert.equal(pack.status, 200)
const check = checkPack(Buffer.from(await pack.arrayBuffer()))
assert.equal(check.ok, true, `the pack verifies: ${JSON.stringify(check)}`)

console.log(`\ne2e: ${steps.length} calls, ledger valid to entry ${verify.count}, pack valid`)
process.exit(0)
