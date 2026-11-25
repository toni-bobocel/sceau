import type { Entry } from './ledger.ts'

// The page an auditor or a client's security team actually reads. It is
// derived from the ledger in the same pack and claims nothing the ledger
// does not show.

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const time = (iso: string) => iso.replace('T', ' ').slice(0, 19)
const dur = (ms: number) => (ms < 60e3 ? `${Math.round(ms / 1e3)} s` : `${Math.round(ms / 60e3)} min`)

type D = Record<string, any>

export function report(entries: Entry[], range: { from: number; to: number }): string {
  const sessions = new Map<string, D>()
  const calls = new Map<number, Entry>()
  const approvals: { call: Entry; a: D }[] = []
  const denied: Entry[] = []
  const withheld: { e: Entry; call?: Entry }[] = []
  const changed: Entry[] = []
  const policies: Entry[] = []
  const redacted: Record<string, number> = {}
  let held = 0

  for (const e of entries) {
    const d = e.data as D
    if (e.kind === 'session' && e.session) sessions.set(e.session, d)
    if (e.kind === 'policy') policies.push(e)
    if (e.kind === 'catalogue' && d.changed?.length) changed.push(e)
    if (e.kind === 'call') {
      calls.set(e.seq, e)
      if (d.verdict === 'deny') denied.push(e)
      if (d.verdict === 'hold') held++
    }
    if (e.kind === 'approval') approvals.push({ call: calls.get(d.call)!, a: d })
    if (e.kind === 'result' || e.kind === 'sampling') {
      for (const [k, n] of Object.entries((d.redacted ?? {}) as Record<string, number>)) redacted[k] = (redacted[k] ?? 0) + n
      if (d.action === 'withheld') withheld.push({ e, call: calls.get(d.call) })
    }
  }

  const agent = (e?: Entry) => {
    const s = e?.session && sessions.get(e.session)
    return s ? `${esc(s.client?.name)} <span>${esc(s.transport)}</span>` : '<span>unknown</span>'
  }
  const tool = (e?: Entry) => (e ? `${esc((e.data as D).server)}/${esc((e.data as D).tool)}` : '')
  const outcomes: Record<string, number> = {}
  for (const { a } of approvals) outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1
  const first = entries[0]!
  const last = entries.at(-1)!

  const table = (head: string[], rows: string[][]) =>
    rows.length
      ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '<p class="none">None in this period.</p>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sceau record, entries ${range.from} to ${range.to}</title>
<style>
body{margin:0;background:#f4f1ea;color:#16171a;font:15px/1.55 Georgia,'Times New Roman',serif}
main{max-width:860px;margin:0 auto;padding:64px 28px 96px}
h1{font-weight:400;font-size:40px;line-height:1.1;margin:0 0 8px}
h2{font-weight:400;font-size:22px;margin:56px 0 12px;padding-top:14px;border-top:1px solid #16171a}
p{max-width:62ch}
code,td,th,.meta,dt{font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace}
.meta{color:#5d5a53;margin-bottom:40px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 28px;margin:20px 0}
dt{color:#5d5a53}dd{margin:0}
table{width:100%;border-collapse:collapse;margin:12px 0}
th{text-align:left;font-weight:400;color:#5d5a53;border-bottom:1px solid #16171a;padding:6px 8px 6px 0}
td{border-bottom:1px solid #d8d3c7;padding:7px 8px 7px 0;vertical-align:top}
td span{color:#5d5a53}
.none{color:#5d5a53;font-style:italic}
.seal{color:#8a6d2f}.stop{color:#a12a16}
</style></head><body><main>
<h1>Record of agent activity</h1>
<p class="meta">Entries ${range.from} to ${range.to} &middot; ${time(first.at)} to ${time(last.at)} UTC<br>Last entry ${esc(last.hash)}</p>

<p>This record was produced by Sceau, a proxy that sits between AI agents and the tools they call over the Model Context Protocol. It lists what the agents asked for, what the policy decided, which calls waited for a person and what that person decided. It covers what crossed MCP; the conversation between an application and its model does not, except where a tool server asked that model for a completion, which is recorded too.</p>

<h2>In this period</h2>
<dl>
<dt>Agent sessions</dt><dd>${sessions.size}</dd>
<dt>Tool calls</dt><dd>${calls.size}</dd>
<dt>Blocked by policy</dt><dd class="stop">${denied.length}</dd>
<dt>Held for a person</dt><dd>${held}${approvals.length ? ` &middot; ${Object.entries(outcomes).map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}</dd>
<dt>Results withheld</dt><dd>${withheld.length}</dd>
<dt>Personal data masked</dt><dd>${Object.entries(redacted).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}</dd>
</dl>

<h2>Decisions taken by a person</h2>
<p>EU AI Act, Article 14: the people overseeing a system must be able to decide not to use its output and to intervene in its operation. Each line is a call the policy would not let through alone.</p>
${table(
  ['When', 'Agent', 'Tool', 'Rule', 'Outcome', 'By', 'Waited'],
  approvals.map(({ call, a }) => [
    time(call?.at ?? ''), agent(call), tool(call), esc((call?.data as D)?.rule ?? 'default'),
    `<span class="${a.outcome === 'approved' ? 'seal' : 'stop'}">${esc(a.outcome)}</span>`, esc(a.by ?? '—'), dur(a.waited_ms),
  ]),
)}

<h2>Calls the policy refused</h2>
${table(['When', 'Agent', 'Tool', 'Rule'], denied.map(e => [time(e.at), agent(e), tool(e), esc((e.data as D).rule ?? 'default')]))}

<h2>Results withheld from the agent</h2>
<p>Text a tool returned that carried instructions aimed at the model: hidden characters, planted directives, links built to carry data out.</p>
${table(
  ['When', 'Agent', 'Tool', 'What was found'],
  withheld.map(({ e, call }) => [time(e.at), agent(call), tool(call), ((e.data as D).findings ?? []).map((f: D) => `${esc(f.kind)}: <code>${esc(f.excerpt)}</code>`).join('<br>')]),
)}

<h2>Tools that changed after they were trusted</h2>
${table(['When', 'Server', 'Tools'], changed.map(e => [time(e.at), esc((e.data as D).server), esc((e.data as D).changed.join(', '))]))}

<h2>Policy in force</h2>
${table(['From', 'Digest', 'Rules'], policies.map(e => [time(e.at), `<code>${esc((e.data as D).digest)}</code>`, esc(((e.data as D).rules ?? []).join(' · '))]))}

<h2>How this record holds</h2>
<p>EU AI Act, Article 12: events are recorded automatically over the system's lifetime. Each entry carries the SHA-256 of its content and of the entry before it, and an Ed25519 signature; removing, reordering or editing one breaks every check after it. VERIFY.txt in this pack explains how to check it without Sceau.</p>
<p>GDPR, Articles 5 and 32: IBANs, card numbers, keys, email addresses and phone numbers were replaced by tokens before the agent's model saw them and before this record was written. The table that turns a token back into the value stays in the proxy's memory and is never written down.</p>
<p>A record shows what happened; it does not by itself make a system compliant. Keep packs for as long as your obligations require, six months at least under Article 19.</p>
</main></body></html>
`
}
