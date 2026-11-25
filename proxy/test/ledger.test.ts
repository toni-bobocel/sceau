import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonical, Ledger, parseLines, verifyEntries } from '../src/ledger.ts'

const fresh = () => new Ledger(mkdtempSync(join(tmpdir(), 'sceau-')))

describe('ledger', () => {
  it('hashes the same object the same way whatever its key order', () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }))
  })

  it('chains, signs and verifies', () => {
    const l = fresh()
    l.append('session', { client: 'support-bot' }, 's1')
    l.append('call', { tool: 'refund', amount: 450 }, 's1')
    l.append('approval', { by: 'alice' }, 's1')
    const v = l.verify()
    expect(v).toMatchObject({ ok: true, count: 3 })
    expect(l.read()[1]!.prev).toBe(l.read()[0]!.hash)
  })

  it('picks up where it stopped after a restart', () => {
    const l = fresh()
    l.append('call', { n: 1 })
    l.close()
    const again = new Ledger(l.dir)
    again.append('call', { n: 2 })
    expect(again.verify()).toMatchObject({ ok: true, count: 2 })
  })

  it('points at the first entry someone edited', () => {
    const l = fresh()
    for (let i = 0; i < 5; i++) l.append('call', { amount: i * 100 })
    const lines = readFileSync(l.path, 'utf8').split('\n')
    lines[2] = lines[2]!.replace('"amount":200', '"amount":20')
    writeFileSync(l.path, lines.join('\n'))
    expect(l.verify()).toEqual({ ok: false, seq: 3, reason: 'content does not match its hash' })
  })

  it('notices a removed entry and a re-hashed forgery', () => {
    const l = fresh()
    for (let i = 0; i < 4; i++) l.append('call', { i })
    const entries = parseLines(readFileSync(l.path, 'utf8'))
    expect(verifyEntries([entries[0]!, entries[2]!], l.publicKey)).toMatchObject({ ok: false, seq: 3 })

    // a well-formed entry written with somebody else's key
    const forged = fresh().append('call', { i: 99 })
    expect(verifyEntries([forged], l.publicKey)).toEqual({ ok: false, seq: 1, reason: 'signature does not match the key' })
  })
})
