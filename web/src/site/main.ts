import '@fontsource/instrument-serif'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import '../shared/base.css'
import './site.css'
import { holdToSeal } from '../shared/hold'
import { engrave, gsap, MOTION, ScrollTrigger, sha256 } from '../shared/motion'
import { buildSeal } from '../shared/seal'

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)]

// -- the seal closes ----------------------------------------------------------

const pin = $('.hero__pin')
const seal = buildSeal($('.hero__seal'))
const wire = $$('.hero__wire code')
const hash = $('.hero__hash')

// the payloads stand in two loose columns either side of the seal
for (const [side, lines] of [['l', wire.filter(w => w.dataset.side === 'l')], ['r', wire.filter(w => w.dataset.side === 'r')]] as const) {
  lines.forEach((w, i) => {
    w.style.top = `${18 + i * 17 + (side === 'r' ? 7 : 0)}%`
    w.style[side === 'l' ? 'left' : 'right'] = `${3 + (i % 2) * 4}vw`
  })
}

// what the seal stamps: the approval entry the demo below produces, hashed here, now
const entry = { seq: 2290, kind: 'approval', data: { call: 2289, outcome: 'approved', by: 'm.durand' }, prev: 'a41c…9e07' }
const digest = sha256(JSON.stringify(entry))

if (MOTION) {
  gsap.from(seal.svg, { opacity: 0, scale: 0.94, duration: 2.4, ease: 'latch', transformOrigin: '50% 50%' })
  gsap.from([...$$('.hero__copy > *'), ...$$('.hero__side > *')], { y: 26, opacity: 0, duration: 1.5, ease: 'latch', stagger: 0.09, delay: 0.35 })

  let stamped = false
  const toCentre = (axis: 'x' | 'y') => (_: number, el: HTMLElement) =>
    axis === 'x' ? pin.clientWidth / 2 - (el.offsetLeft + el.offsetWidth / 2) : pin.clientHeight * 0.47 - (el.offsetTop + el.offsetHeight / 2)

  gsap
    .timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: pin, pin: true, start: 'top top', end: '+=230%', scrub: 0.6, invalidateOnRefresh: true,
        onUpdate: async self => {
          if (self.progress > 0.8 && !stamped) {
            stamped = true
            engrave(hash, await digest, 1.2)
          } else if (self.progress < 0.72 && stamped) {
            stamped = false
            gsap.killTweensOf(hash)
            hash.textContent = ' '
          }
        },
      },
    })
    .to(['.hero__copy', '.hero__side', '.hero__cue'], { opacity: 0, y: -34, duration: 0.12, ease: 'power2.in' }, 0)
    .to(wire, { opacity: 1, duration: 0.07, stagger: 0.012 }, 0.03)
    .to(seal.alignment, { value: 1, duration: 0.58, ease: 'heavy' }, 0.1)
    .to('.hero__seal', { top: '47%', scale: 1.14, duration: 0.5, ease: 'power2.inOut' }, 0.08)
    .to(wire, { x: toCentre('x'), y: toCentre('y'), scale: 0.25, opacity: 0, duration: 0.5, ease: 'power3.in', stagger: 0.02 }, 0.2)
    // the bolt: the core gives under the press, then everything is still
    .to(seal.core, { scale: 0.962, svgOrigin: '500 500', duration: 0.03, ease: 'power2.in' }, 0.72)
    .to(seal.fill, { opacity: 0.94, duration: 0.02 }, 0.75)
    .to($('.seal__mono', seal.svg), { opacity: 1, duration: 0.02 }, 0.75)
    .fromTo(seal.flash, { opacity: 0 }, { opacity: 0.55, duration: 0.012 }, 0.75)
    .to(seal.flash, { opacity: 0, duration: 0.12, ease: 'power2.out' }, 0.762)
    .to(seal.core, { scale: 1, svgOrigin: '500 500', duration: 0.05, ease: 'latch' }, 0.75)
    .to('.hero__sealed', { opacity: 1, duration: 0.1 }, 0.8)
    .to({}, { duration: 0.12 })
} else {
  digest.then(d => (hash.textContent = d))
}

// -- the policy at work ---------------------------------------------------------

const rows = $$('.feed li')
const rules = $$('.yaml span[data-rule]')
if (MOTION) {
  gsap.set(rows, { opacity: 0, x: -18 })
  const tl = gsap.timeline({ paused: true })
  rows.forEach((row, i) => {
    tl.to(row, { opacity: 1, x: 0, duration: 0.8, ease: 'latch' }, i * 1.15).call(
      () => {
        for (const r of rules) r.classList.toggle('is-hit', r.dataset.rule === row.dataset.rule)
      },
      [],
      i * 1.15 + 0.25,
    )
  })
  ScrollTrigger.create({ trigger: '.feed', start: 'top 72%', once: true, onEnter: () => tl.play() })
}

// -- tape over the data ------------------------------------------------------

const pii = $$('.pii')
const sig = $('[data-engrave]')
if (MOTION) {
  const tl = gsap.timeline({ scrollTrigger: { trigger: '.record', start: 'top 72%', end: 'center 42%', scrub: 0.6 } })
  pii.forEach((p, i) => {
    tl.to(p, { '--k': 1, duration: 1, ease: 'latch' }, i * 0.7).to(p, { '--t': 1, duration: 0.35 }, i * 0.7 + 0.85)
  })
  ScrollTrigger.create({
    trigger: '.record', start: 'center 50%', once: true,
    onEnter: async () => engrave(sig, await sha256($('.record__body').textContent ?? ''), 1.6),
  })
} else {
  gsap.set(pii, { '--k': 1, '--t': 1 })
}

// -- hold to seal ------------------------------------------------------------

const card = $('.held')
const status = $('.held__status', card)
const state = $('.held__state', card)
const waitEl = $('.held__wait', card)
const decline = $<HTMLButtonElement>('.held__decline', card)
let waited = 47
let clock: number | undefined
const showWait = () => (waitEl.textContent = `${Math.floor(waited / 60)}:${String(waited % 60).padStart(2, '0')}`)
showWait()
ScrollTrigger.create({
  trigger: card, start: 'top bottom', end: 'bottom top',
  onToggle: self => {
    clearInterval(clock)
    if (self.isActive && !card.matches('.is-sealed, .is-declined')) {
      clock = window.setInterval(() => {
        waited++
        showWait()
      }, 1000)
    }
  },
})

const finish = (sealed: boolean) => {
  clearInterval(clock)
  card.classList.add(sealed ? 'is-sealed' : 'is-declined')
  state.textContent = sealed ? 'Sealed' : 'Declined'
  decline.textContent = 'Again'
}

const control = holdToSeal($('.held__hold', card), async () => {
  finish(true)
  status.textContent = 'sealed // verified'
  const log = $('.held__log', card)
  log.classList.remove('is-struck')
  void log.offsetWidth
  log.classList.add('is-struck')
  const at = new Date().toISOString()
  engrave($('.held__digest', card), await sha256(JSON.stringify({ ...entry, at, waited_ms: waited * 1000 })), 1.1)
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

// -- the chain ---------------------------------------------------------------

if (MOTION) {
  gsap.from('.chain li', {
    opacity: 0, x: -20, duration: 0.9, ease: 'latch', stagger: 0.14,
    scrollTrigger: { trigger: '.chain', start: 'top 75%', once: true },
  })
  for (const section of $$('.policy, .mask, .seal-it, .ledger, .run')) {
    gsap.from($$('.head > *', section), {
      y: 22, opacity: 0, duration: 1.1, ease: 'latch', stagger: 0.08,
      scrollTrigger: { trigger: section, start: 'top 78%', once: true },
    })
  }
}

addEventListener('load', () => ScrollTrigger.refresh())
