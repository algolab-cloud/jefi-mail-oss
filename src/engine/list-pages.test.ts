import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { seedAccount, seedMailbox } from './testing/seed'
import { listRevision, loadView, type ViewCursor, type ViewPage } from './threads'
import { storeBatch, updateFlags } from './mail-store'
import { gmailLabelId, queueLabels } from './pending-ops'
import { uiThreadId } from './threading'
import { setScreener } from './screener'

// ---------------------------------------------------------------------------
// Keyset pages of a view (lume-2vz): each page continues below the last one's cursor, so paging
// deep costs one page, not the whole prefix, and what changed in between can't shift a page.
// ---------------------------------------------------------------------------

const cleanups: Array<() => unknown> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const ACCOUNT = seedAccount('acct-pages')
const who = { account: { name: ACCOUNT.name, email: ACCOUNT.email } }

function setup(count: number) {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  const ids = seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count, subject: 'Inbox' })
  seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'Archive', specialUse: '\\Archive' }, { count: 1, subject: 'Filed', minutesAgo: 100_000 })
  return { db, ids }
}

const page = (db: MailDatabase, limit: number, after?: ViewCursor | null, since?: number) =>
  loadView(db, ACCOUNT.id, 'inbox', { ...who, limit, after, ...(since === undefined ? {} : { since }) })!
const idOf = (messageId: number) => `${ACCOUNT.id}:t${messageId}`
const ids = (result: ViewPage) => result.threads.map((t) => t.id)

/** Every page of the inbox, walked by cursor. */
function walk(db: MailDatabase, limit: number) {
  const seen: string[] = []
  let cursor: ViewCursor | null = null
  for (let n = 0; n < 1000; n++) {
    const result = page(db, limit, cursor)
    seen.push(...ids(result))
    if (!result.hasMore) {
      expect(result.nextCursor).toBeNull()
      return seen
    }
    cursor = result.nextCursor
  }
  throw new Error('paging never ended')
}

test('pages walk the whole view once, in a stable order, even when every date is the same', () => {
  const { db } = setup(30)
  db.run("UPDATE messages SET date = 1700000000000 WHERE account_id = ? AND subject LIKE 'Inbox%'", [ACCOUNT.id])
  const all = ids(page(db, 1000))
  expect(all.length).toBe(30)
  const walked = walk(db, 7)
  expect(walked).toEqual(all)
  expect(new Set(walked).size).toBe(30)
})

test('hasMore comes from one row past the page: an exact multiple ends without an empty page', () => {
  const { db } = setup(20)
  const first = page(db, 10)
  expect(first.hasMore).toBe(true)
  expect(first.threads.length).toBe(10)
  const second = page(db, 10, first.nextCursor)
  expect(second.threads.length).toBe(10)
  expect(second.hasMore).toBe(false)
  expect(second.nextCursor).toBeNull()
  // Newest first, across the boundary.
  expect([...first.threads, ...second.threads].map((t) => t.subject)).toEqual(Array.from({ length: 20 }, (_, i) => `Inbox ${i + 1}`))
})

test('a conversation that moves out of the view between pages is skipped, and reported as changed', () => {
  const { db, ids: messages } = setup(20)
  const first = page(db, 10)
  const moved = messages[14]!
  const archive = (db.query("SELECT id FROM mailboxes WHERE path = 'Archive'").get() as { id: number }).id
  db.run("DELETE FROM message_mailboxes WHERE message_id = ? AND mailbox_id = (SELECT id FROM mailboxes WHERE path = 'INBOX')", [moved])
  db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, 99, ?)', [archive, moved])

  const second = page(db, 10, first.nextCursor)
  expect(ids(second)).not.toContain(idOf(moved))
  expect(second.threads.length).toBe(9)
  expect(second.hasMore).toBe(false)

  const refreshed = page(db, 10, null, first.revision)
  const changes = refreshed.changes
  if (!changes || changes === 'reset') throw new Error('expected changes')
  expect(changes.threads.map((t) => [t.id, t.folder])).toEqual([[idOf(moved), 'archive']])
  expect(changes.removed).toEqual([])
})

test('new mail while paged lands above the first page and leaves the next page alone', () => {
  const { db } = setup(20)
  const first = page(db, 10)
  const [fresh] = seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 1, subject: 'Brand new', minutesAgo: 0 })

  // The cursor pins the next page: no row of the first page repeats, none is skipped.
  const second = page(db, 10, first.nextCursor)
  expect(second.threads.map((t) => t.subject)).toEqual(Array.from({ length: 10 }, (_, i) => `Inbox ${i + 11}`))

  const refreshed = page(db, 10, null, first.revision)
  expect(refreshed.threads[0]!.id).toBe(idOf(fresh!))
  expect(refreshed.revision).toBeGreaterThan(first.revision)
  const changes = refreshed.changes
  if (!changes || changes === 'reset') throw new Error('expected changes')
  expect(changes.threads.map((t) => t.id)).toEqual([idOf(fresh!)])
})

test('a deleted conversation, even the one a cursor points at, neither breaks paging nor lingers', () => {
  const { db, ids: messages } = setup(20)
  const first = page(db, 10)
  // The last conversation of the first page: the cursor's own row.
  const gone = messages[9]!
  db.run('DELETE FROM messages WHERE id = ?', [gone])
  const second = page(db, 10, first.nextCursor)
  expect(second.threads.map((t) => t.subject)).toEqual(Array.from({ length: 10 }, (_, i) => `Inbox ${i + 11}`))

  const changes = page(db, 10, null, first.revision).changes
  if (!changes || changes === 'reset') throw new Error('expected changes')
  expect(changes.removed).toEqual([idOf(gone)])
})

test('the revision moves with what the list shows, not with rewrites of the same flags', () => {
  const { db, ids: messages } = setup(3)
  const inbox = (db.query("SELECT id FROM mailboxes WHERE path = 'INBOX'").get() as { id: number }).id
  // The first page threads the mail, which is a change of its own.
  const before = page(db, 10).revision
  expect(listRevision(db, ACCOUNT.id).rev).toBe(before)
  // Sync reads back the flags every pass; unchanged ones must not look like news.
  updateFlags(db, ACCOUNT.id, inbox, [{ uid: 1, flags: ['\\Seen'] }])
  expect(listRevision(db, ACCOUNT.id).rev).toBe(before)
  expect(updateFlags(db, ACCOUNT.id, inbox, [{ uid: 1, flags: [] }])).toBe(1)
  const after = listRevision(db, ACCOUNT.id).rev
  expect(after).toBeGreaterThan(before)
  const changes = page(db, 10, null, before).changes
  if (!changes || changes === 'reset') throw new Error('expected changes')
  expect(changes.threads.map((t) => [t.id, t.unread])).toEqual([[idOf(messages[0]!), true]])
  // Nothing since: nothing to patch.
  expect(page(db, 10, null, after).changes).toEqual({ threads: [], removed: [] })
})

test('Gmail labels read back unchanged leave the revision alone; a changed one moves it', () => {
  const { db } = setup(2)
  const inbox = (db.query("SELECT id FROM mailboxes WHERE path = 'INBOX'").get() as { id: number }).id
  const flags = (db.query('SELECT seen FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id WHERE mm.mailbox_id = ? AND mm.uid = 1').get(inbox) as { seen: number }).seen ? ['\\Seen'] : []
  expect(updateFlags(db, ACCOUNT.id, inbox, [{ uid: 1, flags, labels: ['Work', 'Travel'] }])).toBe(1)
  const before = listRevision(db, ACCOUNT.id).rev
  expect(updateFlags(db, ACCOUNT.id, inbox, [{ uid: 1, flags, labels: ['Travel', 'Work', '\\Inbox'] }])).toBe(0)
  expect(listRevision(db, ACCOUNT.id).rev).toBe(before)
  expect(updateFlags(db, ACCOUNT.id, inbox, [{ uid: 1, flags, labels: ['Work'] }])).toBe(1)
  expect(listRevision(db, ACCOUNT.id).rev).toBeGreaterThan(before)
  expect(db.query('SELECT label FROM message_labels ORDER BY label').all()).toEqual([{ label: 'Work' }])
})

test('labels read back from the server leave a queued local label change alone', () => {
  const { db, ids: messages } = setup(2)
  const inbox = (db.query("SELECT id FROM mailboxes WHERE path = 'INBOX'").get() as { id: number }).id
  const [mine, other] = messages as [number, number]
  expect(queueLabels(db, ACCOUNT.id, uiThreadId(ACCOUNT.id, null, mine), [gmailLabelId(ACCOUNT.id, 'Mine')])).toBe(true)
  const labels = (id: number) => (db.query('SELECT label FROM message_labels WHERE message_id = ? ORDER BY label').all(id) as Array<{ label: string }>).map((r) => r.label)
  const uidOf = (id: number) => (db.query('SELECT uid FROM message_mailboxes WHERE message_id = ?').get(id) as { uid: number }).uid
  const seenOf = (id: number) => ((db.query('SELECT seen FROM messages WHERE id = ?').get(id) as { seen: number }).seen ? ['\\Seen'] : [])
  expect(updateFlags(db, ACCOUNT.id, inbox, [mine, other].map((id) => ({ uid: uidOf(id), flags: seenOf(id), labels: ['Server'] })))).toBe(1)
  expect([labels(mine), labels(other)]).toEqual([['Mine'], ['Server']])
  const header = (id: number) => db.query('SELECT message_id AS messageId, subject, date FROM messages WHERE id = ?').get(id) as { messageId: string; subject: string; date: number }
  const again = (id: number) => ({ uid: uidOf(id), ...header(id), to: [], cc: [], bcc: [], replyTo: [], references: [], flags: seenOf(id), labels: ['Again'] })
  storeBatch(db, ACCOUNT.id, { id: inbox, uidvalidity: 1 }, [again(mine), again(other)], { lastUid: 10 })
  expect([labels(mine), labels(other)]).toEqual([['Mine'], ['Again']])
})

test('a change too broad to stamp tells a paged list to reload', () => {
  const { db } = setup(3)
  const first = page(db, 10)
  setScreener(db, ACCOUNT.id, true)
  expect(page(db, 10, null, first.revision).changes).toBe('reset')
})
