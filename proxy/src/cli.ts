#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { request as requestTls } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { loadConfig } from './config.ts'
import { Gate, type Message } from './gate.ts'
import { Ledger, parseLines, verifyEntries } from './ledger.ts'
import { notify } from './notify.ts'
import { buildPack, checkPack } from './pack.ts'
import { Vault } from './redact.ts'
import { app } from './server.ts'
import { Users } from './users.ts'

const here = import.meta.dirname
const version = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version ?? 'dev'
const [command, ...rest] = process.argv.slice(2)

const HELP = `sceau: a firewall and flight recorder for AI agents' tool calls

  sceau serve [-c sceau.yaml]                  run the proxy and its console
  sceau wrap --server NAME [--daemon URL] -- COMMAND ARGS...
                                               put a stdio MCP server behind the proxy
  sceau verify FILE [--key sceau.pub]          check a ledger.jsonl or an evidence pack
  sceau pack [-c sceau.yaml] [--from N] [--to N] [-o FILE]
                                               write an evidence pack without the server
  sceau user add NAME [-c sceau.yaml]          create or reset an approver (password from
                                               SCEAU_PASSWORD, or asked for)
`

const configPath = (p?: string) => resolve(p ?? process.env.SCEAU_CONFIG ?? 'sceau.yaml')

function fingerprint(pem: string) {
  return createHash('sha256').update(pem).digest('hex').slice(0, 16).replace(/(.{4})(?!$)/g, '$1 ')
}

async function main() {
  switch (command) {
    case 'serve':
      return serveCmd()
    case 'wrap':
      return wrapCmd()
    case 'verify':
      return verifyCmd()
    case 'pack':
      return packCmd()
    case 'user':
      return userCmd()
    default:
      process.stdout.write(HELP)
      process.exitCode = command && command !== 'help' && command !== '--help' ? 2 : 0
  }
}

function serveCmd() {
  const { values } = parseArgs({ args: rest, options: { config: { type: 'string', short: 'c' } } })
  const config = loadConfig(configPath(values.config))
  const ledger = new Ledger(config.data)

  // appending to a chain that no longer verifies would bless whatever was done to it
  const check = ledger.verify()
  if (!check.ok) {
    console.error(`sceau: the ledger in ${config.data} fails at entry ${check.seq}: ${check.reason}.`)
    console.error('Move ledger.jsonl aside and keep it for whoever investigates; Sceau starts a new one.')
    process.exit(1)
  }

  const users = new Users(config.data)
  if (!users.count && process.env.SCEAU_ADMIN_PASSWORD) users.set('admin', process.env.SCEAU_ADMIN_PASSWORD)

  // a fresh key per run: tokens handed to a model die with the process, by design
  const gate = new Gate(config, ledger, new Vault(randomBytes(32), config.redact))
  notify(config, gate)

  const consoleDir = process.env.SCEAU_CONSOLE ?? resolve(here, '../../web/dist')
  const server = serve({
    fetch: app(gate, users, { consoleDir: existsSync(join(consoleDir, 'console.html')) ? consoleDir : undefined, version }).fetch,
    hostname: config.host,
    port: config.port,
  })
  const servers = Object.entries(config.servers).map(([k, v]) => (v.url ? `${k} -> ${v.url}` : `${k} (stdio, through sceau wrap)`))
  console.log(`sceau ${version} on http://${config.host}:${config.port}`)
  for (const s of servers) console.log(`  /mcp/${s}`)
  console.log(`  ledger ${config.data}, ${ledger.head.seq} entries, key ${fingerprint(ledger.publicKey)}`)
  console.log(`  ${config.policy.rules.length} rules, default read: ${config.policy.default.read}, write: ${config.policy.default.write}`)
  if (!users.count) console.log('  no approvers yet: run `sceau user add <name>` to open the console')

  const stop = () => {
    server.close()
    ledger.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** A tiny JSON client without a response timeout: a held call can wait for a person for minutes. */
function relayClient(base: string, token?: string) {
  const url = new URL(base)
  const send = url.protocol === 'https:' ? requestTls : request
  return <T>(path: string, body?: unknown) =>
    new Promise<T>((ok, fail) => {
      const data = body === undefined ? '' : JSON.stringify(body)
      const req = send(new URL(path, url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', d => (text += d))
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 300) return fail(new Error(`${res.statusCode} ${text}`))
          ok(text ? JSON.parse(text) : (undefined as T))
        })
      })
      req.on('error', fail)
      req.end(data)
    })
}

async function wrapCmd() {
  const split = rest.indexOf('--')
  const { values } = parseArgs({
    args: split < 0 ? rest : rest.slice(0, split),
    options: { server: { type: 'string' }, daemon: { type: 'string' } },
  })
  const [cmd, ...args] = split < 0 ? [] : rest.slice(split + 1)
  if (!values.server || !cmd) {
    process.stderr.write('usage: sceau wrap --server NAME [--daemon URL] -- COMMAND ARGS...\n')
    process.exit(2)
  }
  const post = relayClient(values.daemon ?? process.env.SCEAU_URL ?? 'http://127.0.0.1:7325', process.env.SCEAU_RELAY_TOKEN)
  // stdout is the MCP channel: anything else written there would corrupt it
  const say = (m: Message) => process.stdout.write(`${JSON.stringify(m)}\n`)
  const log = (s: string) => process.stderr.write(`sceau wrap: ${s}\n`)

  let session: string | undefined
  try {
    session = (await post<{ session: string }>('/relay/open', { server: values.server })).session
  } catch (e) {
    log(`cannot reach the proxy (${(e as Error).message}); every tool call will be refused until it is back`)
  }

  // npx and friends are .cmd shims on Windows and need a shell; a full path to an executable does not
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' && !/[\\/]/.test(cmd) })
  const toServer = (m: Message) => child.stdin.write(`${JSON.stringify(m)}\n`)

  // messages keep their order, except that a held call must not stall the ones behind it
  let inbound: Promise<unknown> = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return
    const msg = JSON.parse(line) as Message
    const handle = async () => {
      if (!session) {
        if (msg.method === 'tools/call' && msg.id !== undefined) {
          return say({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Sceau is not reachable, so this call was not made.' }] } })
        }
        return toServer(msg)
      }
      const token = msg.params?._meta?.progressToken
      let tick = 0
      const alive = token === undefined ? undefined : setInterval(() => say({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message: 'Held by Sceau until a person decides' } }), 15_000)
      try {
        const r = await post<{ forward?: Message; reply?: Message }>(`/relay/${session}/in`, msg)
        if (r.reply) say(r.reply)
        if (r.forward) toServer(r.forward)
      } catch (e) {
        log((e as Error).message)
        if (msg.method === 'tools/call' && msg.id !== undefined) say({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Sceau could not decide on this call, so it was not made.' }] } })
        else toServer(msg)
      } finally {
        clearInterval(alive)
      }
    }
    if (msg.method === 'tools/call') void inbound.then(handle)
    else inbound = inbound.then(handle)
  })

  let outbound: Promise<unknown> = Promise.resolve()
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return
    const msg = JSON.parse(line) as Message
    outbound = outbound.then(async () => {
      if (!session) {
        // nothing unscanned goes back to the model
        if (msg.id !== undefined && !msg.method) return say({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Sceau is not reachable; the result was withheld.' } })
        return say(msg)
      }
      try {
        say(await post<Message>(`/relay/${session}/out`, msg))
      } catch (e) {
        log((e as Error).message)
        if (msg.id !== undefined && !msg.method) say({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Sceau could not check this result; it was withheld.' } })
      }
    })
  })

  const end = async (code: number) => {
    if (session) await post(`/relay/${session}/close`).catch(() => {})
    process.exit(code)
  }
  child.on('exit', code => void end(code ?? 0))
  process.stdin.on('end', () => child.stdin.end())
}

function verifyCmd() {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { key: { type: 'string' } } })
  const file = positionals[0]
  if (!file) {
    process.stderr.write('usage: sceau verify FILE [--key sceau.pub]\n')
    process.exit(2)
  }
  const key = values.key ? readFileSync(values.key, 'utf8') : undefined
  if (file.endsWith('.zip')) {
    const r = checkPack(readFileSync(file), key)
    if (!r.ok) {
      console.log(`NOT VALID: ${r.reason}`)
      process.exit(1)
    }
    console.log(`valid: entries ${r.from} to ${r.to} (${r.count}), last ${r.head}`)
    if (!key) console.log('checked against the key inside the pack; pass --key with the one you were given to be sure it is theirs')
    return
  }
  const pub = key ?? readFileSync(join(dirname(file), 'sceau.pub'), 'utf8')
  const r = verifyEntries(parseLines(readFileSync(file, 'utf8')), pub)
  if (!r.ok) {
    console.log(`NOT VALID at entry ${r.seq}: ${r.reason}`)
    process.exit(1)
  }
  console.log(`valid: ${r.count} entries, last ${r.head}`)
}

function packCmd() {
  const { values } = parseArgs({
    args: rest,
    options: { config: { type: 'string', short: 'c' }, from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string', short: 'o' } },
  })
  const config = loadConfig(configPath(values.config))
  const ledger = new Ledger(config.data)
  const zip = buildPack(ledger, config.data, {
    from: values.from ? Number(values.from) : undefined,
    to: values.to ? Number(values.to) : undefined,
    generator: `sceau ${version}`,
    policySource: config.policySource,
  })
  const out = values.out ?? `sceau-evidence-${new Date().toISOString().slice(0, 10)}.zip`
  writeFileSync(out, zip)
  console.log(`wrote ${out}`)
}

async function userCmd() {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { config: { type: 'string', short: 'c' } } })
  const [action, name] = positionals
  if (action !== 'add' || !name) {
    process.stderr.write('usage: sceau user add NAME [-c sceau.yaml]\n')
    process.exit(2)
  }
  const config = loadConfig(configPath(values.config))
  const password = process.env.SCEAU_PASSWORD ?? (await ask(`password for ${name}: `))
  new Users(config.data).set(name, password)
  console.log(`${name} can now sign in and seal held calls`)
}

function ask(prompt: string) {
  return new Promise<string>(ok => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    if (!stdin.isTTY) {
      createInterface({ input: stdin }).once('line', ok)
      return
    }
    stdin.setRawMode(true)
    let value = ''
    stdin.on('data', function read(b: Buffer) {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.off('data', read)
          stdin.pause()
          process.stdout.write('\n')
          return ok(value)
        }
        if (ch === '\u0003') process.exit(130)
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch
      }
    })
  })
}

main().catch(e => {
  console.error(`sceau: ${(e as Error).message}`)
  process.exit(1)
})
