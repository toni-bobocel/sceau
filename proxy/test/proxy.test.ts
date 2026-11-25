import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hold } from '../src/gate.ts'
import { app } from '../src/server.ts'
import { Users } from '../src/users.ts'
import { refunds, startHttp } from './fixtures/tools.ts'
import { setup } from './helpers.ts'

const POLICY = `
rules:
  - name: no deletes, ever
    match: "*/query"
    if: [{ sql: [delete, drop, truncate] }]
    then: deny
  - name: refunds above 200 EUR wait for a person
    match: "*/refund"
    if: [{ arg: amount, gt: 200 }]
    then: hold
  - match: "*/refund"
    then: allow
default:
  read: allow
  write: hold
`

let upstream: Awaited<ReturnType<typeof startHttp>>
let ctx: ReturnType<typeof setup>
let base: string
let close: () => void

beforeAll(async () => {
  upstream = await startHttp()
  ctx = setup(POLICY, `servers:\n  payments: { url: ${upstream.url} }\n  notes: {}\napprovals: { timeout: 5s }`)
  const users = new Users(ctx.config.data)
  users.set('alice', 'correct horse battery')
  const server = serve({ fetch: app(ctx.gate, users, { version: 'test' }).fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise(ok => server.once('listening', ok))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})

afterAll(() => {
  close()
  upstream.close()
})

const text = (r: any) => r.content[0].text as string

async function agent(transport: StreamableHTTPClientTransport | StdioClientTransport) {
  const client = new Client({ name: 'support-bot', version: '2.1.0' })
  await client.connect(transport)
  return client
}

describe('through the proxy, with the official SDK on both sides', () => {
  it('over Streamable HTTP', async () => {
    const client = await agent(new StreamableHTTPClientTransport(new URL(`${base}/mcp/payments`)))
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['get_customer', 'query', 'refund'])

    const customer = text(await client.callTool({ name: 'get_customer', arguments: { id: 'cus_42' } }))
    expect(customer).not.toContain('claire.martin@example.fr')
    const iban = customer.match(/\[IBAN_[0-9a-f]{8}\]/)![0]

    const denied = await client.callTool({ name: 'query', arguments: { sql: 'delete from customers' } })
    expect(denied.isError).toBe(true)

    expect(text(await client.callTool({ name: 'refund', arguments: { customer: 'cus_42', amount: 40 } }))).toBe('refunded 40 EUR to cus_42')

    // a person seals it from the console while the agent waits on the open request
    ctx.gate.once('hold', async (h: Hold) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: 'correct horse battery' }) })
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const r = await fetch(`${base}/api/holds/${h.id}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ outcome: 'approved' }) })
      expect(r.status).toBe(200)
    })
    // the tool got the real IBAN; the agent reads its answer with the token again
    expect(text(await client.callTool({ name: 'refund', arguments: { customer: iban, amount: 900 } }))).toBe(`refunded 900 EUR to ${iban}`)
    expect(refunds.at(-1)).toEqual({ customer: 'FR76 3000 6000 0112 3456 7890 189', amount: 900 })

    const kinds = ctx.ledger.read().map(e => e.kind)
    expect(kinds).toContain('session')
    expect(kinds).toContain('approval')
    expect(ctx.ledger.verify()).toMatchObject({ ok: true })
    expect(JSON.stringify(ctx.ledger.read())).not.toContain('FR76 3000')
    await client.close()
  })

  it('over stdio, through sceau wrap', async () => {
    const cli = join(import.meta.dirname, '../src/cli.ts')
    const fixture = join(import.meta.dirname, 'fixtures/stdio-server.ts')
    const client = await agent(new StdioClientTransport({ command: process.execPath, args: [cli, 'wrap', '--server', 'notes', '--daemon', base, '--', process.execPath, fixture], stderr: 'pipe' }))
    expect((await client.listTools()).tools).toHaveLength(3)
    expect(text(await client.callTool({ name: 'get_customer', arguments: { id: 'cus_7' } }))).toMatch(/\[EMAIL_[0-9a-f]{8}\]/)
    const denied = await client.callTool({ name: 'query', arguments: { sql: 'drop table customers' } })
    expect(text(denied)).toContain('no deletes, ever')
    expect([...ctx.gate.sessions.values()].some(s => s.transport === 'stdio' && s.client.name === 'support-bot')).toBe(true)
    await client.close()
  })

  it('keeps the console shut without an account', async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401)
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: 'nope' }) })
    expect(bad.status).toBe(401)
  })
})
