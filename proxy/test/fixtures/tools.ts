import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// A payments-and-CRM server as a real SDK would serve it, for the proxy to sit in front of.

export const refunds: { customer: string; amount: number }[] = []

export function tools() {
  const server = new McpServer({ name: 'fixture-payments', version: '1.0.0' })
  server.registerTool(
    'get_customer',
    { description: 'Look a customer up.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ({ content: [{ type: 'text', text: `${id}: Claire Martin, claire.martin@example.fr, IBAN FR76 3000 6000 0112 3456 7890 189` }] }),
  )
  server.registerTool(
    'refund',
    { description: 'Refund a customer, in euros.', inputSchema: { customer: z.string(), amount: z.number() }, annotations: { destructiveHint: true } },
    async ({ customer, amount }) => {
      refunds.push({ customer, amount })
      return { content: [{ type: 'text', text: `refunded ${amount} EUR to ${customer}` }] }
    },
  )
  server.registerTool(
    'query',
    { description: 'Run SQL against the warehouse.', inputSchema: { sql: z.string() } },
    async ({ sql }) => ({ content: [{ type: 'text', text: `ran: ${sql}` }] }),
  )
  return server
}

export async function startHttp() {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const http = createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? sessions.get(sid) : undefined
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => void sessions.set(id, transport!) })
      await tools().connect(transport)
    }
    await transport.handleRequest(req, res)
  })
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, close: () => http.close() }
}
