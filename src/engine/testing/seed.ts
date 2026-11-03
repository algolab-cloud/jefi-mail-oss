import type { Account } from '../../accounts'
import type { MailDatabase } from '../db'
import { ensureAccount } from '../mail-store'

// ---------------------------------------------------------------------------
// Mailboxes built straight in SQLite, for tests about how much of a mailbox the list shows. Going
// through IMAP for thousands of conversations would test the server, not the window.
// ---------------------------------------------------------------------------

/** An account for a seeded database. Its servers are never reached: these tests don't sync. */
export const seedAccount = (id: string): Account => ({
  id,
  name: 'Me',
  email: 'me@example.com',
  provider: 'imap',
  face: { letter: 'M' },
  servers: { imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' },
})

export type SeedMailbox = {
  path: string
  /** \\Inbox, \\Sent, \\Archive, \\All, \\Junk, \\Trash. Left out for a plain folder. */
  specialUse?: string
}

export type SeedMessages = {
  count: number
  /** `${subject} ${n}`, n counting from 1. */
  subject: string
  /** Age of the newest of them, in minutes; each next one is a minute older. */
  minutesAgo?: number
  flagged?: boolean
  /** Gmail labels, as stored on the message. */
  labels?: string[]
}

/** Puts `count` single-message conversations in a mailbox, newest first. Returns their message ids. */
export function seedMailbox(db: MailDatabase, accountId: string, email: string, mailbox: SeedMailbox, messages: SeedMessages): number[] {
  ensureAccount(db, accountId, email)
  db.run('INSERT OR IGNORE INTO mailboxes (account_id, path, special_use, last_uid) VALUES (?, ?, ?, 0)', [accountId, mailbox.path, mailbox.specialUse ?? null])
  const box = db.query('SELECT id, last_uid FROM mailboxes WHERE account_id = ? AND path = ?').get(accountId, mailbox.path) as { id: number; last_uid: number }
  const insert = db.prepare(
    `INSERT INTO messages (account_id, message_id, subject, from_name, from_email, date, snippet, seen, flagged)
     VALUES (?1, ?2, ?3, 'Ada Lovelace', 'ada@example.com', ?4, 'Body', 1, ?5)`,
  )
  const link = db.prepare('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?1, ?2, ?3)')
  const label = db.prepare('INSERT INTO message_labels (message_id, label) VALUES (?1, ?2)')
  const now = Date.now()
  const ids: number[] = []
  db.transaction(() => {
    for (let n = 1; n <= messages.count; n++) {
      const subject = `${messages.subject} ${n}`
      insert.run(accountId, `<${mailbox.path}-${n}@example.com>`, subject, now - ((messages.minutesAgo ?? 1) + n - 1) * 60_000, messages.flagged ? 1 : 0)
      const id = (db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
      link.run(box.id, box.last_uid + n, id)
      for (const name of messages.labels ?? []) label.run(id, name)
      ids.push(id)
    }
    db.run('UPDATE mailboxes SET last_uid = ? WHERE id = ?', [box.last_uid + messages.count, box.id])
  })()
  return ids
}
