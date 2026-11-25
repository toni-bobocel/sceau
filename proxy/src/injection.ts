// Instructions planted in what an agent reads: a web page, a ticket, a PDF, a
// tool description. Heuristics only, and they are not the line of defence; the
// policy is. What they buy is a refusal before the model reads the text, and
// an entry in the ledger saying where it came from.

export type Severity = 'high' | 'medium'

export interface Finding {
  kind: 'hidden_text' | 'instruction' | 'role_marker' | 'exfiltration'
  severity: Severity
  excerpt: string
}

// Unicode tag characters carry ASCII that renders as nothing; zero-width and
// bidi controls hide or reorder text a reviewer would otherwise see.
const TAGS = /[\u{E0000}-\u{E007F}]+/gu
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

const INSTRUCTIONS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|of|these)\s+)*(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|rules|guidelines|messages|directions)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:new|updated|real|actual) (?:system )?instructions?\s*[:-]/i,
  /\b(?:do not|don't|never) (?:tell|inform|mention|reveal)[^.\n]{0,20}\b(?:the )?(?:user|human|operator)\b/i,
  /\b(?:reveal|print|output|repeat)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|your instructions)\b/i,
  /\b(?:ignorez|oubliez)\b[^.\n]{0,40}\b(?:instructions|consignes|règles)\b/i,
  /\bas an ai (?:assistant|agent)\b[^.\n]{0,30}\byou must\b/i,
]

const ROLES = /<\|im_(?:start|end)\|>|<\/?(?:system|assistant)>|\[\/?INST\]|<<\/?SYS>>|^\s*(?:system|assistant)\s*:/im

// a link built to carry data out: a placeholder or a long encoded blob in the query
const EXFIL = /!?\[[^\]]*\]\(https?:\/\/[^)\s]*[?&][^)\s=]*=(?:\{[^}]*\}|[A-Za-z0-9+/=_-]{40,})[^)]*\)/i

const cut = (s: string, at: number) => s.slice(Math.max(0, at - 30), at + 70).replace(/\s+/g, ' ').trim()

/** Decodes tag characters, so the ledger shows what was hidden and not an empty string. */
export const reveal = (s: string) => s.replace(TAGS, t => [...t].map(c => String.fromCharCode(c.codePointAt(0)! - 0xe0000)).join(''))

export function scan(text: string): Finding[] {
  const found: Finding[] = []
  const tags = text.match(TAGS)
  if (tags) found.push({ kind: 'hidden_text', severity: 'high', excerpt: reveal(tags.join(' ')).slice(0, 100) })
  const invisible = text.match(INVISIBLE)?.length ?? 0
  if (invisible >= 3) found.push({ kind: 'hidden_text', severity: 'medium', excerpt: `${invisible} invisible control characters` })

  // read what a person would not see, too: a comment, a revealed tag string
  const plain = `${reveal(text)}\n${[...text.matchAll(/<!--([\s\S]*?)-->/g)].map(m => m[1]).join('\n')}`.replace(INVISIBLE, '')
  for (const re of INSTRUCTIONS) {
    const m = re.exec(plain)
    if (m) found.push({ kind: 'instruction', severity: 'high', excerpt: cut(plain, m.index) })
  }
  const role = ROLES.exec(plain)
  if (role) found.push({ kind: 'role_marker', severity: 'medium', excerpt: cut(plain, role.index) })
  const link = EXFIL.exec(plain)
  if (link) found.push({ kind: 'exfiltration', severity: 'high', excerpt: cut(plain, link.index) })
  return found
}

/** Removes what cannot be seen; the visible text stays as it was. */
export const strip = (s: string) => s.replace(TAGS, '').replace(INVISIBLE, '')
