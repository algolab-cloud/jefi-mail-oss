import type { MailDatabase } from './db'

// Snoozed conversations: archived on the server until `until`, then returned to the Inbox unread
// by the engine's scheduler. The row is what makes it "snoozed" rather than merely archived.

export const snoozeThread = (db: MailDatabase, accountId: string, threadId: string, until: number) =>
  void db.run(
    'INSERT INTO snoozes (account_id, thread_id, until) VALUES (?, ?, ?) ON CONFLICT (account_id, thread_id) DO UPDATE SET until = excluded.until',
    [accountId, threadId, until],
  )

export const unsnoozeThread = (db: MailDatabase, accountId: string, threadId: string) =>
  db.run('DELETE FROM snoozes WHERE account_id = ? AND thread_id = ?', [accountId, threadId]).changes > 0

export function snoozedThreads(db: MailDatabase, accountId: string): Map<string, number> {
  const rows = db.query('SELECT thread_id, until FROM snoozes WHERE account_id = ?').all(accountId) as Array<{ thread_id: string; until: number }>
  return new Map(rows.map((r) => [r.thread_id, r.until]))
}

/** Snoozes that are due, removed as they're returned. */
export function takeDueSnoozes(db: MailDatabase, accountId: string, now = Date.now()): string[] {
  const due = (db.query('SELECT thread_id FROM snoozes WHERE account_id = ? AND until <= ?').all(accountId, now) as Array<{ thread_id: string }>).map((r) => r.thread_id)
  if (due.length) db.run('DELETE FROM snoozes WHERE account_id = ? AND until <= ?', [accountId, now])
  return due
}

/** "Tomorrow, 8:00" style label for when a snooze ends. */
export function snoozeLabel(until: number, now = new Date()) {
  const date = new Date(until)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) return `today, ${time}`
  if (days === 1) return `tomorrow, ${time}`
  if (days < 7) return `${date.toLocaleDateString([], { weekday: 'long' })}, ${time}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
