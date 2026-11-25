import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { tools } from './tools.ts'

await tools().connect(new StdioServerTransport())
