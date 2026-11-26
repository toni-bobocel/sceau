import '@fontsource-variable/archivo/wdth.css'
import '@fontsource-variable/geist-mono'
import '../shared/base.css'
import './site.css'
import Lenis from 'lenis'
import { holdToSeal } from '../shared/hold'
import { engrave, gsap, MOTION, ScrollTrigger, sha256 } from '../shared/motion'
import { buildSeal } from '../shared/seal'

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)]

/** Fills a box with a grid of square cells, `cols` across. */
function pixels(host: HTMLElement, cols: number, rows = Math.max(1, Math.round((host.clientHeight / host.clientWidth) * cols))) {
  host.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  host.style.gridTemplateRows = `repeat(${rows}, 1fr)`
  host.innerHTML = '<i></i>'.repeat(cols * rows)
  return [...host.children] as HTMLElement[]
}

let lenis: Lenis | undefined
if (MOTION) {
  lenis = new Lenis({ lerp: 0.11 })
  lenis.on('scroll', ScrollTrigger.update)
  gsap.ticker.add(t => lenis!.raf(t * 1000))
  gsap.ticker.lagSmoothing(0)
  for (const a of $$<HTMLAnchorElement>('a[href^="#"]')) {
    a.addEventListener('click', e => {
      e.preventDefault()
      lenis!.scrollTo(a.getAttribute('href')!, { duration: 1.6 })
    })
  }
}

// -- loading: the screen is all pixels, which give way at random -------------

const loader = $('.loader')
if (MOTION) {
  document.documentElement.classList.add('is-loading')
  lenis?.stop()
  const cells = pixels($('.loader__px', loader), innerWidth > 860 ? 12 : 6)
  const count = $('.loader__count', loader)
  const n = { v: 0 }
  gsap
    .timeline({ delay: 0.15 })
    .to(n, { v: 2291, duration: 1.1, ease: 'power2.inOut', onUpdate: () => (count.textContent = String(Math.round(n.v)).padStart(4, '0')) })
    .add(() => document.fonts.ready)
    .to('.loader__label', { opacity: 0, duration: 0.01 }, '+=0.15')
    .to(cells, { opacity: 0, duration: 0.01, stagger: { amount: 0.75, from: 'random' } })
    .add(() => {
      loader.remove()
      document.documentElement.classList.remove('is-loading')
      lenis?.start()
    })
    .from('.hero__meta, .hero__foot', { opacity: 0, y: 14, duration: 0.8, ease: 'power3.out', stagger: 0.08 }, '-=0.45')
    .from('.hero__line', { yPercent: 40, opacity: 0, duration: 1, ease: 'expo.out', stagger: 0.1 }, '<')
} else {
  loader.remove()
}

// -- the clock in the corner ---------------------------------------------------

const clock = $('.hero__clock')
const showTime = () => (clock.textContent = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`)
showTime()
setInterval(showTime, 1000)

// -- the entries the page is about -------------------------------------------

const entries = [
  { seq: 2289, kind: 'call', at: '2026-11-26T09:41:07.212Z', data: { agent: 'support-agent', tool: 'payments/refund', args: { order: 88104, amount: 340 }, rule: 'refunds above 200 EUR wait for finance', action: 'hold' } },
  { seq: 2290, kind: 'approval', at: '2026-11-26T09:43:12.590Z', data: { call: 2289, outcome: 'approved', by: 'm.durand', waited_ms: 125378 } },
  { seq: 2291, kind: 'result', at: '2026-11-26T09:43:12.641Z', data: { call: 2289, ms: 48, masked: { iban: 1 }, content: 'refund re_88104 issued to [IBAN_7b8c8bfb]' } },
  { seq: 2292, kind: 'call', at: '2026-11-26T09:43:20.004Z', data: { agent: 'support-agent', tool: 'crm/query', args: { sql: 'select 1; delete from orders' }, rule: 'nothing is ever deleted', action: 'deny' } },
]

// a real chain: each hash covers the entry and the hash before it
const chain = (async () => {
  let prev = 'a41c09f2e3b7d6c58e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d9e07'
  const out = []
  for (const e of entries) {
    const line = JSON.stringify({ ...e, prev })
    const h = await sha256(line)
    out.push({ ...e, prev, hash: h })
    prev = h
  }
  return out
})()

// -- the seal closes ----------------------------------------------------------

const seal = buildSeal($('.hero__seal'), { cells: 44 })
const hash = $('.hero__hash')

// what the seal stamps: the approval entry the ledger below shows
const approval = entries[1]!
const digest = chain.then(c => c[1]!.hash)

if (MOTION) {
  let stamped = false
  gsap
    .timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: '.hero__pin', pin: true, start: 'top top', end: '+=220%', scrub: 0.5,
        onUpdate: async self => {
          if (self.progress > 0.78 && !stamped) {
            stamped = true
            engrave(hash, await digest, 1.1)
          } else if (self.progress < 0.7 && stamped) {
            stamped = false
            gsap.killTweensOf(hash)
            hash.textContent = ' '
          }
        },
      },
    })
    .to('.hero__line--l', { xPercent: -112, duration: 0.45, ease: 'power2.in' }, 0)
    .to('.hero__line--r', { xPercent: 112, duration: 0.45, ease: 'power2.in' }, 0)
    .to(['.hero__foot', '.hero__cue'], { opacity: 0, duration: 0.15 }, 0)
    .to(seal.alignment, { value: 1, duration: 0.6, ease: 'power2.inOut' }, 0.05)
    .to(seal.cells, { value: 150, duration: 0.62, ease: 'power1.in' }, 0.05)
    .to('.hero__seal', { scale: 1.32, top: '50%', duration: 0.62, ease: 'power2.inOut' }, 0.05)
    // the press: the seal gives a little, then the wax runs into the core
    .to('.hero__seal', { scale: 1.27, duration: 0.03, ease: 'power3.in' }, 0.7)
    .to(seal.fill, { value: 1, duration: 0.06, ease: 'power2.out' }, 0.72)
    .to('.hero__seal', { scale: 1.32, duration: 0.06, ease: 'power3.out' }, 0.73)
    .to('.hero__sealed', { opacity: 1, duration: 0.06 }, 0.76)
    .to({}, { duration: 0.16 })
} else {
  seal.alignment.value = 1
  seal.cells.value = 150
  seal.fill.value = 1
  gsap.set('.hero__sealed', { opacity: 1 })
  digest.then(d => (hash.textContent = d))
}

// -- the policy at work ---------------------------------------------------------

const rows = $$('.feed li')
const rules = $$('.yaml span[data-rule]')
const hit = (rule?: string) => {
  for (const r of rules) r.classList.toggle('is-hit', r.dataset.rule === rule)
}
if (MOTION) {
  gsap.set(rows, { opacity: 0 })
  const tl = gsap.timeline({ paused: true })
  rows.forEach((row, i) => {
    tl.set(row, { opacity: 1 }, i * 1.1)
      .from(row.children, { opacity: 0, duration: 0.01, stagger: 0.07 }, i * 1.1)
      .call(() => hit(row.dataset.rule), [], i * 1.1 + 0.2)
  })
  ScrollTrigger.create({ trigger: '.feed', start: 'top 72%', once: true, onEnter: () => tl.play() })
}
for (const row of rows) row.addEventListener('pointerenter', () => hit(row.dataset.rule))

// -- the data goes under pixels ----------------------------------------------

const pii = $$('.pii')
const record = $('.record')
const masks = pii.map(p => {
  const box = document.createElement('span')
  box.className = 'pii__px'
  box.setAttribute('aria-hidden', 'true')
  p.append(box)
  const cols = Math.max(6, Math.round(p.offsetWidth / 7))
  box.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  box.style.gridTemplateRows = 'repeat(3, 1fr)'
  box.innerHTML = '<i></i>'.repeat(cols * 3)
  return [...box.children]
})
const sig = $('[data-engrave]')
if (MOTION) {
  const tl = gsap.timeline({ scrollTrigger: { trigger: record, start: 'top 70%', end: 'center 40%', scrub: 0.4 } })
  masks.forEach((cells, i) => {
    tl.to(cells, { opacity: 1, duration: 0.01, stagger: { amount: 0.7, from: 'random' } }, i * 0.6).to(pii[i]!, { '--t': 1, duration: 0.01 }, i * 0.6 + 0.8)
  })
  ScrollTrigger.create({
    trigger: record, start: 'center 50%', once: true,
    onEnter: async () => engrave(sig, await sha256($('.record__body').textContent ?? ''), 1.4),
  })
} else {
  gsap.set(masks.flat(), { opacity: 1 })
  gsap.set(pii, { '--t': 1 })
  sha256($('.record__body').textContent ?? '').then(d => (sig.textContent = d))
}

// -- hold to seal ------------------------------------------------------------

const card = $('.held')
const status = $('.held__status', card)
const state = $('.held__state', card)
const waitEl = $('.held__wait', card)
const decline = $<HTMLButtonElement>('.held__decline', card)
let waited = 47
let ticking: number | undefined
const showWait = () => (waitEl.textContent = `${Math.floor(waited / 60)}:${String(waited % 60).padStart(2, '0')}`)
showWait()
ScrollTrigger.create({
  trigger: card, start: 'top bottom', end: 'bottom top',
  onToggle: self => {
    clearInterval(ticking)
    if (self.isActive && !card.matches('.is-sealed, .is-declined')) {
      ticking = window.setInterval(() => {
        waited++
        showWait()
      }, 1000)
    }
  },
})

const finish = (sealed: boolean) => {
  clearInterval(ticking)
  card.classList.add(sealed ? 'is-sealed' : 'is-declined')
  state.textContent = sealed ? 'Sealed' : 'Declined'
  decline.textContent = 'Again'
}

const control = holdToSeal($('.held__hold', card), async () => {
  finish(true)
  status.textContent = 'sealed, verified'
  engrave($('.held__digest', card), await sha256(JSON.stringify({ ...approval, at: new Date().toISOString(), waited_ms: waited * 1000 })), 1)
})

decline.addEventListener('click', () => {
  if (card.matches('.is-sealed, .is-declined')) {
    card.classList.remove('is-sealed', 'is-declined')
    state.textContent = 'Held'
    status.textContent = 'approval pending'
    $('.held__digest', card).textContent = ''
    decline.textContent = 'Decline'
    waited = 0
    showWait()
    control.reset()
    return
  }
  finish(false)
  status.textContent = 'declined: the agent is told not to retry'
})

// -- the quote: wax wherever the pointer passes ---------------------------------

const law = $('.law')
const cols = innerWidth > 860 ? 28 : 12
const lawCells = pixels($('.law__px'), cols)
if (MOTION) {
  const rowsN = lawCells.length / cols
  law.addEventListener('pointermove', e => {
    const r = law.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * cols)
    const y = Math.floor(((e.clientY - r.top) / r.height) * rowsN)
    const cell = lawCells[y * cols + x]
    if (!cell) return
    gsap.killTweensOf(cell)
    gsap.fromTo(cell, { opacity: 1 }, { opacity: 0, duration: 0.9, delay: 0.15, ease: 'steps(4)' })
  })
}

const seqEl = $('.entry__seq')
seqEl.innerHTML = [...'2289']
  .map(() => `<span class="digit"><span>${[...'0123456789'].map(d => `<b>${d}</b>`).join('')}</span></span>`)
  .join('')
const strips = $$('.digit > span', seqEl)
const kindEl = $('.entry__kind')
const bodyEl = $('.entry__body')
const prevEl = $('.entry__prev')
const hashEl = $('.entry__hash')
const dots = $$('.entry__progress i')
const entryCells = pixels($('.entry__px'), 16, 8)

let shown = -1
async function show(i: number, animate = MOTION) {
  if (i === shown) return
  shown = i
  const e = (await chain)[i]!
  const digits = String(e.seq).split('').map(Number)
  gsap.to(strips, { yPercent: k => -digits[k]! * 10, duration: animate ? 0.7 : 0, ease: 'expo.inOut', stagger: 0.04 })
  for (const [k, d] of dots.entries()) d.classList.toggle('is-on', k <= i)
  const fill = () => {
    kindEl.textContent = e.kind
    bodyEl.textContent = JSON.stringify({ at: e.at, data: e.data }, null, 2)
    prevEl.textContent = e.prev
    hashEl.textContent = e.hash
  }
  if (!animate) return fill()
  gsap.killTweensOf(entryCells)
  gsap
    .timeline()
    .to(entryCells, { opacity: 1, duration: 0.01, stagger: { amount: 0.22, from: 'random' } })
    .add(fill)
    .to(entryCells, { opacity: 0, duration: 0.01, stagger: { amount: 0.28, from: 'random' } }, '+=0.04')
}
show(0, false)

if (MOTION && innerWidth > 860) {
  ScrollTrigger.create({
    trigger: '.ledger__pin', pin: true, start: 'top top', end: `+=${entries.length * 70}%`,
    onUpdate: self => show(Math.min(entries.length - 1, Math.floor(self.progress * entries.length))),
  })
} else {
  let i = 0
  setInterval(() => {
    i = (i + 1) % entries.length
    show(i)
  }, 3200)
}

// -- pixel edges between the paper and the ink -------------------------------

for (const edge of $$('.px-edge')) {
  const cells = pixels(edge, 24, 2)
  if (!MOTION) {
    gsap.set(cells, { opacity: 0 })
    continue
  }
  // the row against the next section goes first, so the edge reads as a staircase while it dissolves
  const order = cells.map((c, k) => ({ c, w: (k < 24 ? 0.45 : 0) + Math.random() * 0.55 })).sort((a, b) => a.w - b.w)
  gsap.to(order.map(o => o.c), {
    opacity: 0, duration: 0.01, stagger: 0.02, ease: 'none',
    scrollTrigger: { trigger: edge, start: 'top 85%', end: 'bottom 35%', scrub: true },
  })
}

// -- section heads ------------------------------------------------------------

if (MOTION) {
  for (const head of $$('section:not(.hero) .head, .ledger__head')) {
    gsap.from(head.children, {
      y: 40, opacity: 0, duration: 1.1, ease: 'expo.out', stagger: 0.07,
      scrollTrigger: { trigger: head, start: 'top 82%', once: true },
    })
  }
  gsap.from('.verbs li', {
    opacity: 0, y: 30, duration: 0.9, ease: 'expo.out', stagger: 0.08,
    scrollTrigger: { trigger: '.verbs', start: 'top 80%', once: true },
  })
  gsap.from('.foot__word', {
    yPercent: 30, duration: 1, ease: 'none',
    scrollTrigger: { trigger: '.foot', start: 'top bottom', end: 'bottom bottom', scrub: true },
  })
}

addEventListener('load', () => ScrollTrigger.refresh())
