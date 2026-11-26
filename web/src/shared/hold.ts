import { gsap, MOTION } from './motion'

// Sealing a payment is not a click. The press has to be held for 0.8 s while
// the square fills; letting go early drains it. Space or Enter held down does
// the same, for a keyboard.

const HOLD = 0.8

export function holdToSeal(root: HTMLElement, onSeal: () => void) {
  const label = root.dataset.label ?? 'Hold to seal'
  root.classList.add('hold')
  root.setAttribute('role', 'button')
  root.tabIndex = 0
  root.innerHTML = `<span class="hold__px" aria-hidden="true">${'<i></i>'.repeat(64)}</span>
    <span class="hold__text"><b>${label}</b><span>${root.dataset.hint ?? 'Press and hold'}</span></span>`
  root.setAttribute('aria-label', `${label}: press and hold`)

  let done = false
  const charge = gsap.to(root.querySelectorAll('.hold__px i'), {
    opacity: 1,
    duration: 0.01,
    stagger: { amount: HOLD - 0.01, from: 'random', ease: 'power1.in' },
    paused: true,
    onComplete: () => {
      done = true
      root.setAttribute('aria-disabled', 'true')
      onSeal()
    },
  })

  const press = () => {
    if (!done) charge.timeScale(1).play()
  }
  const release = () => {
    if (!done) charge.timeScale(MOTION ? 3 : 100).reverse()
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
    },
  }
}
