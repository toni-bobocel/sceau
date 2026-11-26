import gsap from 'gsap'
import { CustomEase } from 'gsap/CustomEase'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger, CustomEase, ScrambleTextPlugin, DrawSVGPlugin)

// A bolt: it travels with weight, then stops dead. No overshoot, ever.
CustomEase.create('latch', 'M0,0 C0.22,0.62 0.38,0.92 0.7,0.985 0.82,1 0.9,1 1,1')
// the slow sweep of a mechanism at rest
CustomEase.create('heavy', 'M0,0 C0.45,0 0.2,1 1,1')

export const MOTION = matchMedia('(prefers-reduced-motion: no-preference)').matches
export const HEX = '0123456789abcdef'

export { gsap, ScrollTrigger }

export async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Engraves a hash character by character, out of hex noise. */
export function engrave(el: HTMLElement, text: string, duration = 1.4) {
  if (!MOTION) {
    el.textContent = text
    return gsap.timeline()
  }
  return gsap.timeline().to(el, { duration, ease: 'none', scrambleText: { text, chars: HEX, revealDelay: 0.2, speed: 0.6 } })
}
