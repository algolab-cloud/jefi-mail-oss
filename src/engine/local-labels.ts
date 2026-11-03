import type { Label, LabelTone } from '../data'
import type { MailDatabase } from './db'
import { threadMessageIds } from './threading'

// ---------------------------------------------------------------------------
// Labels Jefi keeps itself (migration 26), for accounts whose server has no labels: every account but
// Gmail, whose labels are real X-GM-LABELS (pending-ops.ts). Local only, never sent to the server. A
// label is put on messages by Message-ID, so it outlives the message being moved or downloaded again.
// ---------------------------------------------------------------------------

/** Label ids the UI uses for Jefi's own labels: `lb:<account>:<random>`. */
export const localLabelId = (accountId: string, key: string = crypto.randomUUID().slice(0, 8)) => `lb:${accountId}:${key}`
export const isLocalLabelOf = (accountId: string, id: string) => id.startsWith(`lb:${accountId}:`)

/** A message's key in local_label_links, as SQL over a `messages` row aliased `alias`. */
export const messageKeySql = (alias: string) => `COALESCE(${alias}.message_id, '#' || ${alias}.id)`

const TONES: LabelTone[] = ['purple', 'green', 'blue', 'amber', 'pink', 'teal']
const tone = (color: string): LabelTone => (TONES.includes(color as LabelTone) ? (color as LabelTone) : 'purple')

type LabelRow = { id: string; name: string; color: string }
const toLabel = (row: LabelRow): Label => ({ id: row.id, label: row.name, color: tone(row.color) })

/** The account's own labels, by name. */
export function listLocalLabels(db: MailDatabase, accountId: string): Label[] {
  return (db.query('SELECT id, name, color FROM local_labels WHERE account_id = ? ORDER BY name COLLATE NOCASE, id').all(accountId) as LabelRow[]).map(toLabel)
}

/**
 * Creates a label (the UI picks its id, so it can use it straight away). A label with the same name
 * already there is returned instead, and so is the one with this id, so a repeat does nothing.
 */
export function createLocalLabel(db: MailDatabase, accountId: string, input: { id?: string; name: string; color?: LabelTone }): Label | null {
  const name = input.name.trim()
  if (!name) return null
  const id = input.id && isLocalLabelOf(accountId, input.id) ? input.id : localLabelId(accountId)
  return db.transaction(() => {
    const existing = db.query('SELECT id, name, color FROM local_labels WHERE account_id = ? AND (id = ? OR lower(name) = lower(?)) ORDER BY id = ? DESC LIMIT 1').get(accountId, id, name, id) as LabelRow | null
    if (existing) return toLabel(existing)
    db.run('INSERT INTO local_labels (id, account_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', [id, accountId, name, tone(input.color ?? 'purple'), Date.now()])
    return { id, label: name, color: tone(input.color ?? 'purple') }
  })()
}

/** Renames a label (and recolours it, given a colour). False when there is no such label or the name is taken. */
export function updateLocalLabel(db: MailDatabase, accountId: string, id: string, change: { name?: string; color?: LabelTone }): boolean {
  const name = change.name?.trim()
  if (change.name !== undefined && !name) return false
  return db.transaction(() => {
    const current = db.query('SELECT id, name, color FROM local_labels WHERE account_id = ? AND id = ?').get(accountId, id) as LabelRow | null
    if (!current) return false
    if (name && db.query('SELECT 1 FROM local_labels WHERE account_id = ? AND id <> ? AND lower(name) = lower(?)').get(accountId, id, name)) return false
    db.run('UPDATE local_labels SET name = ?, color = ? WHERE id = ?', [name ?? current.name, change.color ? tone(change.color) : current.color, id])
    return true
  })()
}

/** Deletes a label and takes it off every message. */
export function deleteLocalLabel(db: MailDatabase, accountId: string, id: string): boolean {
  return db.transaction(() => {
    // Explicitly, not only by cascade: foreign keys can be off on a connection that didn't turn them on.
    db.run('DELETE FROM local_label_links WHERE account_id = ? AND label_id = ?', [accountId, id])
    return db.run('DELETE FROM local_labels WHERE account_id = ? AND id = ?', [accountId, id]).changes > 0
  })()
}

/** The local label ids on any message of a conversation. */
export function threadLocalLabels(db: MailDatabase, accountId: string, threadId: string): string[] {
  const ids = threadMessageIds(db, accountId, threadId)
  if (!ids.length) return []
  return (
    db
      .query(
        `SELECT DISTINCT ll.label_id FROM messages m JOIN local_label_links ll ON ll.account_id = m.account_id AND ll.message_key = ${messageKeySql('m')}
          WHERE m.id IN (SELECT value FROM json_each(?)) ORDER BY ll.label_id`,
      )
      .all(JSON.stringify(ids)) as Array<{ label_id: string }>
  ).map((r) => r.label_id)
}

/**
 * Sets a conversation's local labels to exactly those of `labelIds` that are this account's own
 * labels (others, like Gmail ids, are ignored). A label taken off comes off every message; one put on
 * goes on every message. Returns whether anything changed.
 */
export function setThreadLocalLabels(db: MailDatabase, accountId: string, threadId: string, labelIds: string[]): boolean {
  const ids = threadMessageIds(db, accountId, threadId)
  if (!ids.length) return false
  const known = new Set(listLocalLabels(db, accountId).map((l) => l.id))
  const wanted = new Set(labelIds.filter((id) => isLocalLabelOf(accountId, id) && known.has(id)))
  let changed = false
  db.transaction(() => {
    const keys = (
      db.query(`SELECT ${messageKeySql('m')} AS key FROM messages m WHERE m.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Array<{ key: string }>
    ).map((r) => r.key)
    const has = db.prepare('SELECT label_id FROM local_label_links WHERE account_id = ? AND message_key = ?')
    const add = db.prepare('INSERT OR IGNORE INTO local_label_links (label_id, account_id, message_key) VALUES (?, ?, ?)')
    const remove = db.prepare('DELETE FROM local_label_links WHERE label_id = ? AND message_key = ?')
    for (const key of new Set(keys)) {
      const current = new Set((has.all(accountId, key) as Array<{ label_id: string }>).map((r) => r.label_id))
      for (const id of wanted) if (!current.has(id) && add.run(id, accountId, key).changes > 0) changed = true
      for (const id of current) if (!wanted.has(id) && remove.run(id, key).changes > 0) changed = true
    }
  })()
  return changed
}
