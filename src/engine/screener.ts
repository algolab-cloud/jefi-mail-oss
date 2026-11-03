import type { MailDatabase } from './db'

// ---------------------------------------------------------------------------
// Screener: once on, mail from someone new — never seen before it was switched on, never written
// to, never allowed — waits outside the Inbox until the person allows or blocks the sender.
// Screening is a view over local data (nothing moves on the server); blocking moves mail to Trash.
// ---------------------------------------------------------------------------

export function screenerEnabledAt(db: MailDatabase, accountId: string): number | null {
  return (db.query('SELECT enabled_at FROM screener WHERE account_id = ?').get(accountId) as { enabled_at: number } | null)?.enabled_at ?? null
}

export function setScreener(db: MailDatabase, accountId: string, on: boolean) {
  if (on) db.run('INSERT INTO screener (account_id, enabled_at) VALUES (?, ?) ON CONFLICT (account_id) DO NOTHING', [accountId, Date.now()])
  else db.run('DELETE FROM screener WHERE account_id = ?', [accountId])
}

export function setVerdict(db: MailDatabase, accountId: string, email: string, verdict: 'allow' | 'block') {
  db.run(
    `INSERT INTO sender_verdicts (account_id, email, verdict) VALUES (?, ?, ?)
     ON CONFLICT (account_id, email) DO UPDATE SET verdict = excluded.verdict`,
    [accountId, email.toLowerCase(), verdict],
  )
}

export const blockedSenders = (db: MailDatabase, accountId: string) =>
  new Set((db.query("SELECT email FROM sender_verdicts WHERE account_id = ? AND verdict = 'block'").all(accountId) as Array<{ email: string }>).map((r) => r.email))

/**
 * Senders whose mail is waiting in the Screener: first heard from after the Screener was switched
 * on, with no verdict, and never written to from this account.
 */
export function screenedSenders(db: MailDatabase, accountId: string, self: string): Set<string> {
  const since = screenerEnabledAt(db, accountId)
  if (since === null) return new Set()
  const rows = db
    .query(
      `SELECT lower(m.from_email) AS email FROM messages m
        WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?3
        GROUP BY lower(m.from_email)
       HAVING min(m.date) >= ?2
          AND lower(m.from_email) NOT IN (SELECT email FROM sender_verdicts WHERE account_id = ?1)`,
    )
    // Date headers have second precision and senders' clocks drift: allow a few minutes' slack.
    .all(accountId, since - 5 * 60_000, self.toLowerCase()) as Array<{ email: string }>
  if (!rows.length) return new Set()
  // Anyone we've written to is known, even if they're new in the Inbox.
  const sentTo = db.prepare(
    `SELECT 1 FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id JOIN mailboxes mb ON mb.id = mm.mailbox_id
      WHERE m.account_id = ? AND mb.special_use = '\\Sent' AND (lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?) LIMIT 1`,
  )
  return new Set(rows.map((r) => r.email).filter((email) => !sentTo.get(accountId, `%"${email}"%`, `%"${email}"%`)))
}
