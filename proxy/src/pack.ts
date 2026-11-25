import { createPrivateKey, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { type Entry, GENESIS, type Ledger, parseLines, sha256, verifyEntries } from './ledger.ts'
import { report } from './report.ts'

// A plain zip, so an auditor opens it with whatever they have. Node ships
// deflate and crc32 but no archive format; this is the 70 lines it takes.

interface File {
  name: string
  data: Buffer
}

export function zip(files: File[], date = new Date()): Buffer {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const packed = deflateRawSync(f.data, { level: 9 })
    const crc = crc32(f.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // names are UTF-8
    head.writeUInt16LE(8, 8)
    head.writeUInt16LE(dosTime, 10)
    head.writeUInt16LE(dosDate, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(f.data.length, 22)
    head.writeUInt16LE(name.length, 26)
    local.push(head, name, packed)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    head.copy(dir, 8, 6, 30)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)
    offset += head.length + name.length + packed.length
  }
  const size = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

export function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10)
    const packedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const at = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
    const raw = buf.subarray(start, start + packedSize)
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    p += 46 + nameLen + extra + comment
  }
  return out
}

export interface Manifest {
  generator: string
  generated: string
  range: { from: number; to: number; count: number }
  /** the hash the first entry chains from, so a slice of the ledger verifies on its own */
  anchor: string
  head: string
  policy?: string
  files: Record<string, string>
}

const VERIFY = (from: number, to: number) => `How to check this pack

Every action an AI agent took through Sceau between entries ${from} and ${to}
is in ledger.jsonl, one JSON object per line. Each entry carries the SHA-256
of its content and of the entry before it, and an Ed25519 signature by the
key in sceau.pub.

1. The manifest is signed. With OpenSSL 3, nothing else needed:

   openssl pkeyutl -verify -pubin -inkey sceau.pub -rawin -in manifest.json -sigfile manifest.sig

2. The manifest lists the SHA-256 of every file in the pack:

   sha256sum ledger.jsonl policy.yaml report.html

3. To check every entry, its chain and its signature:

   node proxy/src/cli.ts verify this-pack.zip      (from the Sceau repository)

Personal data in the ledger was replaced by tokens before it was written.
`

/** Sign over the exact bytes of manifest.json, so OpenSSL can check them as they are. */
export function buildPack(ledger: Ledger, dir: string, opts: { from?: number; to?: number; generator: string; policySource?: string }) {
  const all = ledger.read()
  const from = Math.max(1, opts.from ?? 1)
  const to = Math.min(opts.to ?? Number.POSITIVE_INFINITY, all.at(-1)?.seq ?? 0)
  const entries = all.filter(e => e.seq >= from && e.seq <= to)
  if (!entries.length) throw new Error('no entries in that range')
  const lines = Buffer.from(`${entries.map(e => JSON.stringify(e)).join('\n')}\n`)
  const anchor = from === 1 ? GENESIS : entries[0]!.prev

  const files: File[] = [
    { name: 'ledger.jsonl', data: lines },
    { name: 'sceau.pub', data: Buffer.from(ledger.publicKey) },
    { name: 'report.html', data: Buffer.from(report(entries, { from, to })) },
    { name: 'VERIFY.txt', data: Buffer.from(VERIFY(from, to)) },
  ]
  if (opts.policySource) files.push({ name: 'policy.yaml', data: Buffer.from(opts.policySource) })

  const manifest: Manifest = {
    generator: opts.generator,
    generated: new Date().toISOString(),
    range: { from, to, count: entries.length },
    anchor,
    head: entries.at(-1)!.hash,
    policy: (entries.findLast(e => e.kind === 'policy')?.data as { digest: string } | undefined)?.digest,
    files: Object.fromEntries(files.map(f => [f.name, sha256(f.data)])),
  }
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const key = createPrivateKey(readFileSync(join(dir, 'sceau.key')))
  files.push({ name: 'manifest.json', data: body }, { name: 'manifest.sig', data: sign(null, body, key) })
  return zip(files)
}

export type PackCheck =
  | { ok: true; count: number; from: number; to: number; head: string }
  | { ok: false; reason: string }

export function checkPack(buf: Buffer, trusted?: string): PackCheck {
  const f = unzip(buf)
  const need = (n: string) => {
    const b = f.get(n)
    if (!b) throw new Error(`${n} is missing from the pack`)
    return b
  }
  try {
    const pub = trusted ?? need('sceau.pub').toString()
    const body = need('manifest.json')
    if (!verify(null, body, pub, need('manifest.sig'))) return { ok: false, reason: 'the manifest signature does not match the key' }
    const m = JSON.parse(body.toString()) as Manifest
    for (const [name, digest] of Object.entries(m.files)) {
      if (sha256(need(name)) !== digest) return { ok: false, reason: `${name} was changed after the pack was signed` }
    }
    const entries: Entry[] = parseLines(need('ledger.jsonl').toString())
    const v = verifyEntries(entries, pub, { seq: m.range.from, prev: m.anchor })
    if (!v.ok) return { ok: false, reason: `entry ${v.seq}: ${v.reason}` }
    if (v.head !== m.head || v.count !== m.range.count) return { ok: false, reason: 'the ledger does not end where the manifest says' }
    return { ok: true, count: v.count, from: m.range.from, to: m.range.to, head: v.head }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}
