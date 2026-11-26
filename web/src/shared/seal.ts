import { gsap, MOTION } from './motion'

// The seal: graduated rings, each carrying one brass index. At rest every ring
// turns at its own pace; `alignment` brings all the indices onto the vertical
// axis, where the seal can close.

const NS = 'http://www.w3.org/2000/svg'
const C = 500

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  parent?.append(e)
  return e
}

const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const
}

function ticks(g: SVGGElement, r: number, count: number, len: (i: number) => number, cls = 'seal__tick') {
  let d = ''
  for (let i = 0; i < count; i++) {
    const deg = (360 / count) * i
    const [x1, y1] = polar(r, deg)
    const [x2, y2] = polar(r - len(i), deg)
    d += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`
  }
  el('path', { d, class: cls }, g)
}

function index(g: SVGGElement, r: number) {
  const [x, y] = polar(r, 0)
  el('path', { d: `M${x} ${y + 2}l-7 -14h14z`, class: 'seal__index' }, g)
}

export interface Seal {
  svg: SVGSVGElement
  core: SVGGElement
  fill: SVGCircleElement
  flash: SVGCircleElement
  /** 0: the rings turn freely; 1: every index sits on the axis */
  alignment: { value: number }
  dispose: () => void
}

export function buildSeal(host: HTMLElement, opts: { words?: string } = {}): Seal {
  const svg = el('svg', { viewBox: '0 0 1000 1000', class: 'seal', 'aria-hidden': 'true' })
  const rings: { g: SVGGElement; base: number; speed: number }[] = []
  const ring = (speed: number) => {
    const g = el('g', {}, svg)
    rings.push({ g, base: 40 + Math.random() * 280, speed })
    return g
  }

  // the fixed axis everything aligns on
  el('path', { d: 'M500 -22V8', class: 'seal__axis' }, svg)

  const a = ring(1.2)
  el('circle', { cx: C, cy: C, r: 488, class: 'seal__line' }, a)
  ticks(a, 488, 180, i => (i % 15 === 0 ? 22 : i % 5 === 0 ? 13 : 6))
  index(a, 476)

  const b = ring(-2.1)
  el('circle', { cx: C, cy: C, r: 428, class: 'seal__line seal__line--faint' }, b)
  for (let i = 0; i < 16; i++) {
    const [x, y] = polar(402, i * 22.5)
    const t = el('text', { x, y, class: 'seal__hex', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(${i * 22.5} ${x} ${y})` }, b)
    t.textContent = '0123456789abcdef'[i]!
  }
  ticks(b, 428, 64, () => 5)
  index(b, 420)

  const c = ring(3.4)
  el('circle', { cx: C, cy: C, r: 368, class: 'seal__line seal__line--dash' }, c)
  for (const deg of [45, 135, 225, 315]) {
    const [x, y] = polar(368, deg)
    el('rect', { x: x - 4, y: y - 4, width: 8, height: 8, class: 'seal__stud', transform: `rotate(${deg} ${x} ${y})` }, c)
  }
  index(c, 360)

  const d = ring(-4.6)
  for (const [from, to] of [[18, 102], [138, 214], [250, 334]] as const) {
    const [x1, y1] = polar(312, from)
    const [x2, y2] = polar(312, to)
    el('path', { d: `M${x1} ${y1}A312 312 0 0 1 ${x2} ${y2}`, class: 'seal__line seal__line--strong' }, d)
    for (const deg of [from, to]) {
      const [p1, q1] = polar(326, deg)
      const [p2, q2] = polar(298, deg)
      el('path', { d: `M${p1} ${q1}L${p2} ${q2}`, class: 'seal__line seal__line--strong' }, d)
    }
  }
  index(d, 300)

  const e = ring(6.2)
  const pathId = `seal-words-${Math.random().toString(36).slice(2, 7)}`
  el('path', { id: pathId, d: `M${C} ${C - 252}a252 252 0 1 1 -0.1 0`, fill: 'none' }, e)
  const words = el('text', { class: 'seal__words' }, e)
  const tp = el('textPath', { href: `#${pathId}`, startOffset: '0' }, words)
  tp.textContent = (opts.words ?? 'SHA-256 · ED25519 · MODEL CONTEXT PROTOCOL · HUMAN OVERSIGHT · ').repeat(2)
  ticks(e, 230, 120, i => (i % 10 === 0 ? 9 : 4))
  index(e, 222)

  const core = el('g', { class: 'seal__core' }, svg)
  el('circle', { cx: C, cy: C, r: 200, class: 'seal__line seal__line--strong' }, core)
  const fill = el('circle', { cx: C, cy: C, r: 196, class: 'seal__fill' }, core)
  el('path', { d: 'M500 470V530M470 500H530', class: 'seal__cross' }, core)
  const mono = el('text', { x: C, y: C + 6, class: 'seal__mono', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, core)
  mono.textContent = 'S'
  const flash = el('circle', { cx: C, cy: C, r: 196, class: 'seal__flash' }, svg)

  host.append(svg)

  const alignment = { value: 0 }
  let t = 0
  let visible = true
  const io = new IntersectionObserver(([en]) => (visible = !!en?.isIntersecting))
  io.observe(host)
  const tick = (_: number, dt: number) => {
    if (!visible) return
    // slower still as it aligns: the mechanism settles rather than stops
    t += (dt / 1000) * (1 - alignment.value) * (MOTION ? 1 : 0)
    for (const r of rings) {
      const angle = ((r.base + t * r.speed) % 360) * (1 - alignment.value)
      r.g.setAttribute('transform', `rotate(${angle.toFixed(3)} ${C} ${C})`)
    }
  }
  gsap.ticker.add(tick)
  tick(0, 0)

  return {
    svg, core, fill, flash, alignment,
    dispose: () => {
      gsap.ticker.remove(tick)
      io.disconnect()
    },
  }
}
