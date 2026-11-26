import { gsap, MOTION } from './motion'

// Sealing a payment is not a click. The press has to be held for 0.8 s while a
// ring closes around the control; letting go early lets it fall back. Space or
// Enter held down does the same, for a keyboard.

const HOLD = 0.8
const R = 34
const LEN = 2 * Math.PI * R

export function holdToSeal(root: HTMLElement, onSeal: () => void) {
  root.classList.add('hold')
  root.setAttribute('role', 'button')
  root.tabIndex = 0
  root.innerHTML = `
    <span class="hold__dial">
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <circle class="hold__track" cx="38" cy="38" r="${R}"/>
        <circle class="hold__core" cx="38" cy="38" r="24"/>
        <path class="hold__mark" d="M31 38.5l5 5 9-11"/>
        <circle class="hold__fill" cx="38" cy="38" r="${R}" transform="rotate(-90 38 38)" stroke-dasharray="${LEN}" stroke-dashoffset="${LEN}"/>
      </svg>
    </span>
    <span class="hold__text"><b>${root.dataset.label ?? 'Hold to seal'}</b><span>${root.dataset.hint ?? 'Press and hold'}</span></span>`
  root.setAttribute('aria-label', `${root.dataset.label ?? 'Hold to seal'}: press and hold`)

  const fill = root.querySelector<SVGCircleElement>('.hold__fill')!
  const dial = root.querySelector<HTMLElement>('.hold__dial')!
  let done = false
  const charge = gsap.to(fill, {
    strokeDashoffset: 0,
    duration: HOLD,
    ease: 'power1.in',
    paused: true,
    onComplete: () => {
      done = true
      root.setAttribute('aria-disabled', 'true')
      if (MOTION) gsap.fromTo(dial, { scale: 0.94 }, { scale: 1, duration: 0.5, ease: 'latch' })
      onSeal()
    },
  })
  // tension: the dial tightens while it charges
  const squeeze = gsap.to(dial, { scale: 0.94, duration: HOLD, ease: 'power2.in', paused: true })

  const press = () => {
    if (done) return
    charge.timeScale(1).play()
    if (MOTION) squeeze.timeScale(1).play()
  }
  const release = () => {
    if (done) return
    charge.timeScale(3).reverse()
    squeeze.timeScale(3).reverse()
  }
  root.addEventListener('pointerdown', e => {
    root.setPointerCapture(e.pointerId)
    press()
  })
  root.addEventListener('pointerup', release)
  root.addEventListener('pointercancel', release)
  root.addEventListener('keydown', e => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault()
      press()
    }
  })
  root.addEventListener('keyup', e => {
    if (e.key === ' ' || e.key === 'Enter') release()
  })
  root.addEventListener('contextmenu', e => e.preventDefault())

  return {
    reset() {
      done = false
      root.removeAttribute('aria-disabled')
      charge.pause(0)
      squeeze.pause(0)
    },
  }
}
