import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ticket } from './agent.ts'

// `pnpm demo`: the tool servers, Sceau in front of them, and an agent working
// a ticket every half minute, so the console has something to watch.

const root = join(import.meta.dirname, '../..')
const password = process.env.SCEAU_ADMIN_PASSWORD ?? 'seal-it-yourself'
const base = 'http://127.0.0.1:7325'

const run = (args: string[], env: Record<string, string> = {}) =>
  spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })

const children = [
  run(['demo/src/servers.ts']),
  run(['proxy/src/cli.ts', 'serve', '-c', 'deploy/demo.yaml'], { SCEAU_ADMIN_PASSWORD: password }),
]
const stop = () => {
  for (const c of children) c.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

for (let i = 0; i < 50; i++) {
  if (await fetch(`${base}/healthz`).then(r => r.ok, () => false)) break
  await new Promise(r => setTimeout(r, 200))
}
console.log(`\nconsole: http://localhost:7325  (admin / ${password})`)
console.log('the agent works a ticket every 30 s; seal or decline its refund in the console\n')

for (;;) {
  await ticket(base, s => console.log(s)).catch(e => console.error(`agent: ${(e as Error).message}`))
  await new Promise(r => setTimeout(r, 30_000))
}
