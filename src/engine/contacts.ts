import { withDemoFace } from '../demo-faces'
import type { Contact } from '../data'
import type { MailDatabase } from './db'
import type { Address } from './mail-store'

// ---------------------------------------------------------------------------
// The people an account actually corresponds with, taken from synced mail: senders, and everyone
// addressed on a message. Ranked by how often and how recently they appear, so the composer
// suggests the right person first.
// ---------------------------------------------------------------------------

const RECENT_BONUS_MS = 30 * 86_400_000

type Seen = { name?: string; email: string; count: number; last: number; fromSender: boolean }

export function loadContacts(db: MailDatabase, accountId: string, options: { limit?: number; scan?: number; now?: number } = {}): Contact[] {
  const now = options.now ?? Date.now()
  const rows = db
    .query(
      `SELECT from_name, from_email, to_json, cc_json, date FROM messages
        WHERE account_id = ? ORDER BY date DESC LIMIT ?`,
    )
    .all(accountId, options.scan ?? 2000) as Array<{ from_name: string | null; from_email: string | null; to_json: string; cc_json: string; date: number }>

  const own = (db.query('SELECT email FROM accounts WHERE id = ?').get(accountId) as { email: string } | null)?.email?.toLowerCase()
  const people = new Map<string, Seen>()
  const note = (address: Address | null, date: number, fromSender: boolean) => {
    const email = address?.email?.trim()
    if (!address || !email || !email.includes('@') || email.toLowerCase() === own) return
    const key = email.toLowerCase()
    const seen = people.get(key)
    if (!seen) people.set(key, { name: address.name?.trim() || undefined, email, count: 1, last: date, fromSender })
    else {
      seen.count++
      seen.last = Math.max(seen.last, date)
      seen.fromSender ||= fromSender
      // Prefer a name from a message the person sent: it's how they write it themselves.
      if ((!seen.name || (fromSender && !seen.fromSender)) && address.name?.trim()) seen.name = address.name.trim()
    }
  }

  for (const row of rows) {
    note(row.from_email ? { name: row.from_name ?? undefined, email: row.from_email } : null, row.date, true)
    for (const json of [row.to_json, row.cc_json]) {
      for (const address of parse(json)) note(address, row.date, false)
    }
  }

  return [...people.values()]
    .sort((a, b) => score(b, now) - score(a, now) || a.email.localeCompare(b.email))
    .slice(0, options.limit ?? 500)
    .map((p) => ({ name: p.name || p.email.split('@')[0]!, email: p.email, face: withDemoFace(p.email, { letter: initialsOf(p.name || p.email) }) }))
}

/** Frequency, with a boost for people seen in the last month. */
const score = (person: Seen, now: number) => person.count + (now - person.last < RECENT_BONUS_MS ? 5 : 0)

const parse = (json: string): Address[] => {
  try {
    return JSON.parse(json) as Address[]
  } catch {
    return []
  }
}

const initialsOf = (value: string) =>
  value
    .replace(/[<>"@].*$/, '')
    .split(/[\s._-]+/)
    .map((part) => part.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '')
    // Emoji and symbols are skipped: indexing a string could split an emoji in half.
    .filter(Boolean)
    .slice(0, 2)
    .join('') || '?'
