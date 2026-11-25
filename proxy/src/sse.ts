export interface Event {
  event?: string
  data: string
  id?: string
}

export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
    let end = buf.indexOf('\n\n')
    while (end >= 0) {
      const block = buf.slice(0, end)
      buf = buf.slice(end + 2)
      end = buf.indexOf('\n\n')
      const ev: Event = { data: '' }
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const i = line.indexOf(':')
        const field = i < 0 ? line : line.slice(0, i)
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
        if (field === 'data') data.push(value)
        else if (field === 'event') ev.event = value
        else if (field === 'id') ev.id = value
      }
      ev.data = data.join('\n')
      if (data.length) yield ev
    }
  }
}

export const frame = (data: unknown, extra: { event?: string; id?: string } = {}) =>
  `${extra.event ? `event: ${extra.event}\n` : ''}${extra.id ? `id: ${extra.id}\n` : ''}data: ${JSON.stringify(data)}\n\n`
