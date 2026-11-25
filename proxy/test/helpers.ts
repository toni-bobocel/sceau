import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { Gate } from '../src/gate.ts'
import { Ledger } from '../src/ledger.ts'
import { Vault } from '../src/redact.ts'

export const POLICY = `
servers:
  payments: {}
approvals:
  timeout: 400ms
rules:
  - name: no deletes, ever
    match: "*/query"
    if: [{ sql: [delete, drop, truncate] }]
    then: deny
  - name: refunds above 200 EUR wait for a person
    match: payments/refund
    if: [{ arg: amount, gt: 200 }]
    then: hold
  - match: payments/refund
    then: allow
  - name: an IBAN never leaves by mail
    match: send_email
    if: [{ carries: [iban] }]
    then: deny
default:
  read: allow
  write: hold
`

export function setup(yaml = POLICY, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'sceau-'))
  writeFileSync(join(dir, 'sceau.yaml'), `data: ${JSON.stringify(join(dir, 'data'))}\n${extra}\n${yaml}`)
  const config = loadConfig(join(dir, 'sceau.yaml'))
  const ledger = new Ledger(config.data)
  const gate = new Gate(config, ledger, new Vault(randomBytes(32), config.redact))
  return { dir, config, ledger, gate }
}
