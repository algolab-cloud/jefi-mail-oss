import { deferConversations, type MailDatabase } from './db'

// ---------------------------------------------------------------------------
// Conversations. Each message gets a persistent thread_id, assigned after sync in date order:
//   1. the thread of any message it references (In-Reply-To, References);
//   2. the thread of any message that already replied to it (a reply can sync before its parent);
//   3. for replies whose headers were dropped, the latest message with the same normalized subject
//      within 30 days;
//   4. otherwise a new thread.
// A message that links two existing threads merges them.
// ---------------------------------------------------------------------------

const SUBJECT_WINDOW_MS = 30 * 86_400_000
const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|sv|vs|antw)(\[\d+\])?\s*:\s*)+/i

export const normalizeSubject = (subject: string) => subject.replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase()
const isReplySubject = (subject: string) => REPLY_PREFIX.test(subject)

// `+thread_id` keeps SQLite (no ANALYZE stats) off messages_thread: with it, every lookup walked all
// of the account's threaded messages, which made threading a first sync quadratic. assignThreads takes
// the lowest thread id, and replies' thread ids in ascending order, as that index walk returned them,
// so a merge still picks the same target.
export const THREAD_OF_MESSAGE_ID = 'SELECT thread_id FROM messages WHERE account_id = ? AND message_id = ? AND +thread_id IS NOT NULL'
export const THREAD_OF_REPLIES = 'SELECT thread_id FROM messages WHERE account_id = ? AND in_reply_to = ? AND +thread_id IS NOT NULL'

type Unthreaded = { id: number; message_id: string | null; in_reply_to: string | null; references_json: string; subject: string; date: number }

export function assignThreads(db: MailDatabase, accountId: string): number {
  const pending = db
    .query('SELECT id, message_id, in_reply_to, references_json, subject, date FROM messages WHERE account_id = ? AND thread_id IS NULL ORDER BY date, id')
    .all(accountId) as Unthreaded[]
  if (pending.length === 0) return 0

  const threadOfMessageId = db.prepare(THREAD_OF_MESSAGE_ID)
  const threadOfReplies = db.prepare(THREAD_OF_REPLIES)
  const bySubject = db.prepare(
    `SELECT thread_id, subject FROM messages WHERE account_id = ? AND thread_id IS NOT NULL AND date BETWEEN ? AND ?
     ORDER BY date DESC LIMIT 200`,
  )
  const setThread = db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
  const merge = db.prepare('UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id = ?')

  deferConversations(db, () => {
    for (const m of pending) {
      const refs = [...new Set([...(JSON.parse(m.references_json) as string[]), ...(m.in_reply_to ? [m.in_reply_to] : [])])]
      const found = new Set<string>()
      for (const ref of refs) {
        const rows = threadOfMessageId.all(accountId, ref) as Array<{ thread_id: string }>
        if (rows.length) found.add(rows.reduce((low, row) => (row.thread_id < low ? row.thread_id : low), rows[0]!.thread_id))
      }
      if (m.message_id) {
        const replies = new Set((threadOfReplies.all(accountId, m.message_id) as Array<{ thread_id: string }>).map((row) => row.thread_id))
        for (const thread of [...replies].sort()) found.add(thread)
      }

      let target: string | undefined = [...found][0]
      if (!target && (isReplySubject(m.subject) || refs.length > 0)) {
        const key = normalizeSubject(m.subject)
        if (key.length >= 3) {
          const candidates = bySubject.all(accountId, m.date - SUBJECT_WINDOW_MS, m.date) as Array<{ thread_id: string; subject: string }>
          target = candidates.find((c) => normalizeSubject(c.subject) === key)?.thread_id
        }
      }
      const thread = target ?? `t${m.id}`
      setThread.run(thread, m.id)
      for (const other of found) if (other !== thread) merge.run(thread, accountId, other)
    }
  })
  return pending.length
}

/** Message ids behind a UI thread id: `${accountId}:${threadId}`, or `${accountId}:m${id}` for one message. */
export function threadMessageIds(db: MailDatabase, accountId: string, uiThreadId: string): number[] {
  const prefix = `${accountId}:`
  if (!uiThreadId.startsWith(prefix)) return []
  const key = uiThreadId.slice(prefix.length)
  const single = key.match(/^m(\d+)$/)
  if (single) return [Number(single[1])]
  return (db.query('SELECT id FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date').all(accountId, key) as Array<{ id: number }>).map((r) => r.id)
}

export const uiThreadId = (accountId: string, threadId: string | null, messageId: number) => `${accountId}:${threadId ?? `m${messageId}`}`
