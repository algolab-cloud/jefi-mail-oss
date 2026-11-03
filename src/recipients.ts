// ---------------------------------------------------------------------------
// Recipient text as people type and paste it: "a@x.com, b@y.com", "Nora Hale <nora@harbor.io>",
// "\"Hale, Nora\" <nora@harbor.io>; mailto:c@z.com", one address per line, or a contact's name.
// Pure so the composer's field and its tests share one reading of it.
// ---------------------------------------------------------------------------

const ADDRESS = /^[^@\s<>(),;:"[\]]+@[^@\s<>(),;:"[\]]+\.[^@\s<>(),;:"[\]]+$/

export const isEmailAddress = (value: string) => ADDRESS.test(value)

const bare = (token: string) =>
  token
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<("'[]+|[>)"'\],.]+$/g, '')

/** Splits at commas, semicolons and line breaks that aren't inside a quoted name or an <address>. */
export function splitAddressList(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (const ch of raw) {
    if (ch === '"' && !angle) quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if (!quoted && !angle && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r')) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * The addresses in typed or pasted text. A part with an <address> gives that address; a part with
 * bare addresses gives each of them; anything else is a name, resolved through `resolve` (contacts)
 * and otherwise kept as typed so the field can show it as not-an-address.
 */
export function parseRecipients(raw: string, resolve: (name: string) => string | undefined = () => undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const key = value.toLowerCase()
    if (!value || seen.has(key)) return
    seen.add(key)
    out.push(value)
  }
  for (const part of splitAddressList(raw)) {
    const angled = [...part.matchAll(/<([^<>]*)>/g)].map((m) => bare(m[1]!)).filter(isEmailAddress)
    if (angled.length) {
      angled.forEach(add)
      continue
    }
    const tokens = part.split(/\s+/).map(bare).filter(Boolean)
    const addresses = tokens.filter(isEmailAddress)
    if (addresses.length) {
      addresses.forEach(add)
      continue
    }
    const name = part.replace(/^["']|["']$/g, '').trim()
    add(resolve(name) ?? name)
  }
  return out
}

/**
 * What of the field's text is finished and becomes tags now, and what stays in the field. A
 * separator finishes everything before it; a space finishes only a complete address (typing a
 * contact's full name, "Kenji Ito", keeps searching).
 */
export function completedRecipients(value: string): { done: string; rest: string } | null {
  let quoted = false
  let angle = false
  let last = -1
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch === '"' && !angle) quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    else if (!quoted && !angle && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r')) last = i
  }
  if (last >= 0) return { done: value.slice(0, last), rest: value.slice(last + 1).replace(/^\s+/, '') }
  if (!/\s$/.test(value) || quoted || angle) return null
  const text = value.trim()
  if (isEmailAddress(bare(text)) || (/>$/.test(text) && /<[^<>]+@[^<>]+>$/.test(text))) return { done: text, rest: '' }
  return null
}
