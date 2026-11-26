import { gsap, MOTION } from './motion'

// The seal, drawn small and blown up as hard square pixels. `cells` is how many
// pixels span its width: few and it is a blocky stamp, many and the engraving
// reads. Rings turn at their own pace until `alignment` brings every wax index
// onto the axis at the top, where the seal can close.

const INK = '#1b1b1a'
const WAX = '#ef4a1b'

export interface Seal {
  canvas: HTMLCanvasElement
  alignment: { value: number }
  cells: { value: number }
  /** 0..1: wax floods the core */
  fill: { value: number }
  dispose: () => void
}

export function buildSeal(host: HTMLElement, opts: { words?: string; cells?: number } = {}): Seal {
  const canvas = document.createElement('canvas')
  canvas.className = 'seal'
  canvas.setAttribute('aria-hidden', 'true')
  host.append(canvas)
  const ctx = canvas.getContext('2d')!
  const src = document.createElement('canvas')
  const sctx = src.getContext('2d', { willReadFrequently: true })!

  const words = opts.words ?? 'SHA-256 · ED25519 · MODEL CONTEXT PROTOCOL · HUMAN OVERSIGHT · '
  const rings = [1.2, -2.1, 3.4, -4.6, 6.2].map(speed => ({ base: 40 + Math.random() * 280, speed }))
  const alignment = { value: 0 }
  const cells = { value: opts.cells ?? 56 }
  const fill = { value: 0 }

  // drawn in a 1000-unit square; strokes never thinner than one pixel of the grid
  function paint(n: number, angles: number[]) {
    src.width = src.height = n
    const s = sctx
    s.setTransform(n / 1000, 0, 0, n / 1000, 0, 0)
    const px = 1000 / n
    const line = (w: number) => (s.lineWidth = Math.max(w, px * 0.85))
    s.strokeStyle = s.fillStyle = INK

    const turn = (deg: number, draw: () => void) => {
      s.save()
      s.translate(500, 500)
      s.rotate((deg * Math.PI) / 180)
      draw()
      s.restore()
    }
    const circle = (r: number, w: number) => {
      line(w)
      s.beginPath()
      s.arc(0, 0, r, 0, Math.PI * 2)
      s.stroke()
    }
    const ticks = (r: number, count: number, len: (i: number) => number, w = 2.4) => {
      line(w)
      s.beginPath()
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2
        s.moveTo(Math.sin(a) * r, -Math.cos(a) * r)
        s.lineTo(Math.sin(a) * (r - len(i)), -Math.cos(a) * (r - len(i)))
      }
      s.stroke()
    }
    const index = (r: number) => {
      s.fillStyle = WAX
      s.beginPath()
      const h = Math.max(30, px * 1.6)
      s.moveTo(0, -r + h * 0.15)
      s.lineTo(-h * 0.55, -r - h)
      s.lineTo(h * 0.55, -r - h)
      s.fill()
      s.fillStyle = INK
    }

    turn(angles[0]!, () => {
      circle(488, 3)
      ticks(488, 120, i => (i % 10 === 0 ? 34 : i % 5 === 0 ? 20 : 10))
      index(470)
    })
    turn(angles[1]!, () => {
      circle(420, 2.4)
      s.font = '500 30px monospace'
      s.textAlign = 'center'
      s.textBaseline = 'middle'
      for (let i = 0; i < 16; i++) {
        s.save()
        s.rotate((i / 16) * Math.PI * 2)
        s.fillText('0123456789abcdef'[i]!, 0, -392)
        s.restore()
      }
      index(410)
    })
    turn(angles[2]!, () => {
      line(3)
      s.setLineDash([4, 22])
      s.beginPath()
      s.arc(0, 0, 356, 0, Math.PI * 2)
      s.stroke()
      s.setLineDash([])
      for (let i = 0; i < 4; i++) {
        s.save()
        s.rotate(Math.PI / 4 + (i * Math.PI) / 2)
        s.fillRect(-10, -366, 20, 20)
        s.restore()
      }
      index(346)
    })
    turn(angles[3]!, () => {
      line(14)
      for (const [from, to] of [[18, 102], [138, 214], [250, 334]] as const) {
        s.beginPath()
        s.arc(0, 0, 300, ((from - 90) * Math.PI) / 180, ((to - 90) * Math.PI) / 180)
        s.stroke()
      }
      index(286)
    })
    turn(angles[4]!, () => {
      s.font = '600 28px monospace'
      s.textAlign = 'center'
      s.textBaseline = 'middle'
      const chars = [...words.repeat(2)]
      const step = (Math.PI * 2) / chars.length
      chars.forEach((c, i) => {
        s.save()
        s.rotate(i * step)
        s.fillText(c, 0, -244)
        s.restore()
      })
      ticks(216, 90, i => (i % 9 === 0 ? 14 : 6), 2)
      index(206)
    })

    // the core does not turn
    s.save()
    s.translate(500, 500)
    circle(180, 6)
    if (fill.value > 0) {
      s.fillStyle = WAX
      s.beginPath()
      s.arc(0, 0, 172 * fill.value, 0, Math.PI * 2)
      s.fill()
      s.globalCompositeOperation = 'destination-out'
      s.globalAlpha = fill.value
      s.font = '800 250px "Archivo Variable", "Arial Black", sans-serif'
      s.textAlign = 'center'
      s.textBaseline = 'middle'
      s.fillText('S', 0, 14)
      s.globalAlpha = 1
      s.globalCompositeOperation = 'source-over'
    } else {
      line(4)
      s.beginPath()
      s.moveTo(0, -36)
      s.lineTo(0, 36)
      s.moveTo(-36, 0)
      s.lineTo(36, 0)
      s.stroke()
    }
    s.restore()

    // the fixed axis everything lines up under
    s.fillStyle = WAX
    s.fillRect(500 - Math.max(5, px * 0.5), 0, Math.max(10, px), 20)
  }

  let size = 0
  const resize = () => {
    size = host.clientWidth
    const dpr = Math.min(devicePixelRatio, 2)
    canvas.width = canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  resize()

  let t = 0
  let visible = true
  const io = new IntersectionObserver(([en]) => (visible = !!en?.isIntersecting))
  io.observe(host)

  const tick = (_: number, dt: number) => {
    if (!visible || !size) return
    // slower still as it aligns: the mechanism settles rather than stops
    t += (dt / 1000) * (1 - alignment.value) * (MOTION ? 1 : 0)
    const angles = rings.map(r => ((r.base + t * r.speed) % 360) * (1 - alignment.value))
    const n = Math.max(12, Math.round(cells.value))
    paint(n, angles)
    const data = sctx.getImageData(0, 0, n, n).data
    const c = size / n
    ctx.clearRect(0, 0, size, size)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4
        if (data[i + 3]! < 92) continue
        ctx.fillStyle = data[i]! > 120 && data[i + 1]! < 120 ? WAX : INK
        // a hair of overlap so neighbouring squares never show a seam
        ctx.fillRect(Math.floor(x * c), Math.floor(y * c), Math.ceil(c) + 0.5, Math.ceil(c) + 0.5)
      }
    }
  }
  gsap.ticker.add(tick)
  tick(0, 0)

  return {
    canvas, alignment, cells, fill,
    dispose: () => {
      gsap.ticker.remove(tick)
      io.disconnect()
      ro.disconnect()
    },
  }
}
