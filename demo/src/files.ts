import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// The shared drive, over stdio as most file servers run. One of the documents
// is a supplier's invoice with something hidden in it.

const root = join(import.meta.dirname, '../documents')
const s = new McpServer({ name: 'files', version: '0.8.0' })

s.registerTool('list_files', { description: 'Files on the support drive.', annotations: { readOnlyHint: true } }, async () => ({
  content: [{ type: 'text', text: readdirSync(root).join('\n') }],
}))

s.registerTool(
  'read_file',
  { description: 'Read a file from the support drive.', inputSchema: { path: z.string() }, annotations: { readOnlyHint: true } },
  async ({ path }) => {
    const name = path.replace(/^.*[\\/]/, '')
    return { content: [{ type: 'text', text: readFileSync(join(root, name), 'utf8') }] }
  },
)

await s.connect(new StdioServerTransport())
