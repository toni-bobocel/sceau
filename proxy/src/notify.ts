import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Config } from './config.ts'
import type { Gate, Hold, Outcome } from './gate.ts'

// Holds go where the approvers already are. Slack gets buttons when Sceau has
// a bot token and a public URL to receive the click; an incoming webhook only
// gets a link to the console. Any other system can take the plain webhook.

export function notify(config: Config, gate: Gate) {
  const posted = new Map<string, { channel: string; ts: string }>()
  const slack = config.slack
  const consoleUrl = (h: Hold) => `${config.publicUrl}/#hold-${h.id}`

  const send = async (url: string, body: unknown, token?: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
    return res.headers.get('content-type')?.includes('json') ? ((await res.json()) as Record<string, any>) : {}
  }
  const fail = (what: string) => (e: Error) => console.error(`sceau: could not ${what}: ${e.message}`)

  gate.on('hold', (h: Hold) => {
    if (config.webhook) send(config.webhook, { event: 'hold', hold: h, url: consoleUrl(h) }).catch(fail('call the approvals webhook'))
    if (slack?.botToken && slack.channel) {
      send('https://slack.com/api/chat.postMessage', { channel: slack.channel, text: summary(h), blocks: blocks(h, consoleUrl(h), !!slack.signingSecret) }, slack.botToken)
        .then(r => {
          if (!r.ok) throw new Error(r.error)
          posted.set(h.id, { channel: r.channel, ts: r.ts })
        })
        .catch(fail('post the hold to Slack'))
    } else if (slack?.webhookUrl) {
      send(slack.webhookUrl, { text: summary(h), blocks: blocks(h, consoleUrl(h), false) }).catch(fail('post the hold to Slack'))
    }
  })

  gate.on('settled', ({ id, outcome, by }: { id: string; outcome: Outcome; by?: string }) => {
    const p = posted.get(id)
    if (!p || !slack?.botToken) return
    posted.delete(id)
    send('https://slack.com/api/chat.update', { channel: p.channel, ts: p.ts, text: closed(outcome, by), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: closed(outcome, by) } }] }, slack.botToken).catch(
      fail('update the Slack message'),
    )
  })
}

const summary = (h: Hold) => `Held: ${h.server}/${h.tool}${h.rule ? `, under "${h.rule}"` : ''}`

const closed = (outcome: Outcome, by?: string) =>
  ({ approved: `Sealed by ${by}.`, rejected: `Declined by ${by}.`, expired: 'Expired: nobody answered in time.', abandoned: 'The agent hung up before anyone answered.' })[outcome]

function blocks(h: Hold, url: string, buttons: boolean) {
  const args = JSON.stringify(h.args, null, 2)
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${summary(h)}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${args.length > 1500 ? `${args.slice(0, 1500)}…` : args}\`\`\`` } },
    {
      type: 'actions',
      elements: [
        ...(buttons
          ? [
              {
                type: 'button', action_id: 'approve', value: h.id, style: 'primary', text: { type: 'plain_text', text: 'Seal' },
                confirm: { title: { type: 'plain_text', text: 'Seal this call?' }, text: { type: 'plain_text', text: `${h.server}/${h.tool} will run as shown.` }, confirm: { type: 'plain_text', text: 'Seal' }, deny: { type: 'plain_text', text: 'Back' } },
              },
              { type: 'button', action_id: 'reject', value: h.id, style: 'danger', text: { type: 'plain_text', text: 'Decline' } },
            ]
          : []),
        { type: 'button', action_id: 'open', url, text: { type: 'plain_text', text: 'Open in Sceau' } },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Expires ${h.expires.replace('T', ' ').slice(0, 16)} UTC` }] },
  ]
}

/** Slack's signed interactivity request; answers with the text that replaces the message. */
export function slackAction(config: Config, gate: Gate, body: string, headers: Headers): { status: number; text: string } {
  const secret = config.slack?.signingSecret
  if (!secret) return { status: 404, text: 'Slack actions are not configured' }
  const ts = Number(headers.get('x-slack-request-timestamp'))
  if (!ts || Math.abs(Date.now() / 1e3 - ts) > 300) return { status: 401, text: 'stale request' }
  const want = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`)
  const got = Buffer.from(headers.get('x-slack-signature') ?? '')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, text: 'bad signature' }

  const payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '{}')
  const action = payload.actions?.[0]
  if (!action || action.action_id === 'open') return { status: 200, text: '' }
  const outcome = action.action_id === 'approve' ? 'approved' : 'rejected'
  const by = `slack:${payload.user?.username ?? payload.user?.id}`
  return { status: 200, text: gate.settle(action.value, outcome, by) ? closed(outcome, by) : 'Already settled.' }
}
