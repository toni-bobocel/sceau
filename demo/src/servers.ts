import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// Three tool servers a small European company might give its support agent:
// the CRM's database, the payment provider, the mail relay. Nothing here knows
// about Sceau; they are ordinary MCP servers.

const db = new DatabaseSync(':memory:')
db.exec(`
  create table customers (id text primary key, name text, email text, iban text, city text, since text);
  create table orders (id integer primary key, customer text, total_eur real, status text, placed text);
  insert into customers values
    ('cus_1042', 'Claire Martin', 'claire.martin@example.fr', 'FR76 3000 6000 0112 3456 7890 189', 'Lyon', '2021-03-14'),
    ('cus_2210', 'Jonas Becker', 'j.becker@example.de', 'DE89 3704 0044 0532 0130 00', 'Köln', '2022-11-02'),
    ('cus_3381', 'Sofia Russo', 'sofia.russo@example.it', 'IT60 X054 2811 1010 0000 0123 456', 'Torino', '2024-06-20');
  insert into orders values
    (88104, 'cus_1042', 340.00, 'delivered', '2026-11-12'),
    (88131, 'cus_1042', 59.90, 'delivered', '2026-11-19'),
    (88140, 'cus_2210', 1290.00, 'disputed', '2026-11-20'),
    (88152, 'cus_3381', 24.50, 'shipped', '2026-11-24');
`)

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

function crm() {
  const s = new McpServer({ name: 'crm', version: '3.4.0' })
  s.registerTool(
    'query',
    { description: 'Run a SQL statement against the customer database (SQLite).', inputSchema: { sql: z.string() } },
    async ({ sql }) => {
      const st = db.prepare(sql)
      if (st.columns().length) return text(JSON.stringify(st.all(), null, 1))
      return text(`${st.run().changes} rows changed`)
    },
  )
  s.registerTool(
    'get_customer',
    { description: 'One customer with their orders.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      const c = db.prepare('select * from customers where id = ?').get(id)
      if (!c) return { ...text(`no customer ${id}`), isError: true }
      return text(JSON.stringify({ ...c, orders: db.prepare('select * from orders where customer = ?').all(id) }, null, 1))
    },
  )
  return s
}

function payments() {
  const s = new McpServer({ name: 'payments', version: '2026.11' })
  s.registerTool(
    'refund',
    {
      description: 'Refund part or all of an order to the card or account it was paid with. Amount in euros.',
      inputSchema: { order: z.number(), amount: z.number(), reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ order, amount }) => text(`Refund re_${randomUUID().slice(0, 8)} of ${amount.toFixed(2)} EUR on order ${order} submitted.`),
  )
  s.registerTool(
    'list_charges',
    { description: 'Charges for an order.', inputSchema: { order: z.number() }, annotations: { readOnlyHint: true } },
    async ({ order }) => {
      const o = db.prepare('select * from orders where id = ?').get(order) as { total_eur: number } | undefined
      return text(o ? `ch_${order}: ${o.total_eur.toFixed(2)} EUR, captured` : 'no charges')
    },
  )
  return s
}

function mail() {
  const s = new McpServer({ name: 'mail', version: '1.9.2' })
  s.registerTool(
    'send_email',
    {
      description: 'Send an email from support@acme.eu.',
      inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
      annotations: { openWorldHint: true, readOnlyHint: false },
    },
    async ({ to, subject }) => text(`Sent "${subject}" to ${to}.`),
  )
  return s
}

const factories: Record<string, () => McpServer> = { crm, payments, mail }
const sessions = new Map<string, StreamableHTTPServerTransport>()

const http = createServer(async (req, res) => {
  const name = req.url?.split('/')[1] ?? ''
  const make = factories[name]
  if (!make) {
    res.writeHead(404).end()
    return
  }
  const sid = req.headers['mcp-session-id'] as string | undefined
  let t = sid ? sessions.get(sid) : undefined
  if (!t) {
    t = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => void sessions.set(id, t!) })
    t.onclose = () => sessions.delete(t!.sessionId!)
    await make().connect(t)
  }
  await t.handleRequest(req, res)
})

const port = Number(process.env.PORT ?? 8400)
http.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`demo tool servers on :${port} (/crm, /payments, /mail)`))
