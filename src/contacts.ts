import type { Contact } from './data'

// ---------------------------------------------------------------------------
// The people the UI can suggest and @mention: whoever the active account has corresponded with,
// published by the engine after each sync. Held in a module so the composer, the reading pane and
// markdown rendering can look people up without threading the list through every component.
// ---------------------------------------------------------------------------

let current: Contact[] = []
let mentionRe: RegExp | null = null

export const contacts = () => current

export function setContacts(next: Contact[]) {
  current = next
  mentionRe = null
}

export function findContact(value: string): Contact | undefined {
  const clean = value.toLowerCase().trim()
  if (!clean) return undefined
  return current.find((c) => c.email.toLowerCase() === clean || c.name.toLowerCase() === clean)
}

export function searchContacts(query: string, exclude: string[] = [], limit = 5): Contact[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return current.filter((c) => !exclude.includes(c.email) && (c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))).slice(0, limit)
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches "@Name" for known contacts, longest name first so the fuller match wins. */
export function mentionPattern(): RegExp | null {
  if (mentionRe === null) {
    const names = [...current]
      .map((c) => c.name)
      .filter((name) => name.length > 1)
      .sort((a, b) => b.length - a.length)
    mentionRe = names.length ? new RegExp(`@(${names.map(escapeRegex).join('|')})\\b`, 'g') : null
  }
  return mentionRe
}
