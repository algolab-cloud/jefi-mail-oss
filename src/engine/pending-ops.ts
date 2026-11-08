import type { ImapFlow } from 'imapflow'
import type { FolderId } from '../data'
import { searchUids } from './connection'
import type { MailDatabase } from './db'
import { deleteOrphanMessages, labelsOf, setMessageLabels } from './mail-store'
import { threadMessageIds } from './threading'

// ---------------------------------------------------------------------------
// Local changes to real mail (read, star, move, delete). Each one is applied to SQLite straight away,
// so the UI and later syncs agree with it, and queued in pending_ops with the message's server
// location. The queue replays in order, by itself soon after a change (the engine's pushChanges) and
// before every sync. The server wins conflicts: an op whose message no longer exists is dropped; a
// network failure stops the replay and keeps the queue.
// ---------------------------------------------------------------------------

type Location = { mailboxId: number; path: string; uid: number }

export type PendingOp =
  | { kind: 'flags'; messageId: number; locations: Location[]; add: string[]; remove: string[] }
  | { kind: 'move'; messageId: number; locations: Location[]; target: { mailboxId: number; path: string } }
  | { kind: 'delete'; messageId: number; locations: Location[] }
  | { kind: 'labels'; messageId: number; locations: Location[]; add: string[]; remove: string[] }

const MAX_ATTEMPTS = 5

/** Server folder for a UI folder, by special-use. Gmail has no \Archive: archiving means All Mail. */
const TARGET_USES: Partial<Record<FolderId, string[]>> = {
  inbox: ['\\Inbox'],
  archive: ['\\Archive', '\\All'],
  trash: ['\\Trash'],
  spam: ['\\Junk'],
  sent: ['\\Sent'],
  drafts: ['\\Drafts'],
}

const locationsOf = (db: MailDatabase, messageId: number): Location[] =>
  (
    db
      .query('SELECT mm.mailbox_id, mb.path, mm.uid FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = ? AND mm.uid > 0')
      .all(messageId) as Array<{ mailbox_id: number; path: string; uid: number }>
  ).map((r) => ({ mailboxId: r.mailbox_id, path: r.path, uid: r.uid }))

/**
 * Where the server still has the message. If an unsent move is queued for it, the local links are
 * placeholders, so take that move's locations and supersede it (the new op carries the intent).
 */
const serverLocations = (db: MailDatabase, accountId: string, messageId: number): Location[] => {
  const earlier = (
    db.query("SELECT id, payload_json FROM pending_ops WHERE account_id = ? AND kind = 'move' ORDER BY id DESC").all(accountId) as Array<{ id: number; payload_json: string }>
  ).find((row) => (JSON.parse(row.payload_json) as PendingOp).messageId === messageId)
  if (!earlier) return locationsOf(db, messageId)
  db.run('DELETE FROM pending_ops WHERE id = ?', [earlier.id])
  return (JSON.parse(earlier.payload_json) as Extract<PendingOp, { kind: 'move' }>).locations
}

const enqueue = (db: MailDatabase, accountId: string, op: PendingOp) =>
  db.run('INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)', [accountId, op.kind, JSON.stringify(op), Date.now()])

export function pendingCount(db: MailDatabase, accountId: string) {
  return (db.query('SELECT count(*) n FROM pending_ops WHERE account_id = ?').get(accountId) as { n: number }).n
}

/**
 * UIDs in this mailbox that a queued move or delete already committed to taking out of it. The
 * server still shows them under the old UID until the op replays, so a sync must not relink them
 * here in the meantime (lume-75z.7 gap-fill would otherwise resurrect a message mid-move).
 */
export function pendingAwayUids(db: MailDatabase, accountId: string, mailboxId: number): Set<number> {
  const rows = db.query("SELECT payload_json FROM pending_ops WHERE account_id = ? AND kind IN ('move', 'delete')").all(accountId) as Array<{ payload_json: string }>
  const uids = new Set<number>()
  for (const row of rows) {
    const op = JSON.parse(row.payload_json) as Extract<PendingOp, { kind: 'move' | 'delete' }>
    for (const location of op.locations) if (location.mailboxId === mailboxId) uids.add(location.uid)
  }
  return uids
}

/** Mailboxes a queued op still has to touch (its sources, and a move's target). */
export function pendingMailboxIds(db: MailDatabase, accountId: string): Set<number> {
  const rows = db.query('SELECT payload_json FROM pending_ops WHERE account_id = ?').all(accountId) as Array<{ payload_json: string }>
  const ids = new Set<number>()
  for (const row of rows) {
    const op = JSON.parse(row.payload_json) as PendingOp
    for (const location of op.locations) ids.add(location.mailboxId)
    if (op.kind === 'move') ids.add(op.target.mailboxId)
  }
  return ids
}

// --- Local apply + enqueue ---------------------------------------------------------------------

export function queueFlags(db: MailDatabase, accountId: string, threadId: string, flags: { unread?: boolean; starred?: boolean }): boolean {
  const messageIds = threadMessageIds(db, accountId, threadId)
  if (messageIds.length === 0) return false
  const add: string[] = []
  const remove: string[] = []
  if (flags.unread !== undefined) (flags.unread ? remove : add).push('\\Seen')
  if (flags.starred !== undefined) (flags.starred ? add : remove).push('\\Flagged')
  db.transaction(() => {
    for (const messageId of messageIds) {
      if (flags.unread !== undefined) db.run('UPDATE messages SET seen = ? WHERE id = ?', [flags.unread ? 0 : 1, messageId])
      if (flags.starred !== undefined) db.run('UPDATE messages SET flagged = ? WHERE id = ?', [flags.starred ? 1 : 0, messageId])
      enqueue(db, accountId, { kind: 'flags', messageId, locations: locationsOf(db, messageId), add, remove })
    }
  })()
  return true
}

/**
 * Move a conversation. Your own copies in Sent and Drafts stay where they are (archiving a thread
 * shouldn't move your replies out of Sent), unless the conversation has nothing else to move.
 * Returns false when the folder has no server counterpart (the UI keeps the change local).
 */
export function queueMove(db: MailDatabase, accountId: string, threadId: string, folder: FolderId): boolean {
  const uses = TARGET_USES[folder]
  const all = threadMessageIds(db, accountId, threadId)
  if (all.length === 0 || !uses) return false
  const boxes = db.query('SELECT id, path, special_use FROM mailboxes WHERE account_id = ?').all(accountId) as Array<{ id: number; path: string; special_use: string | null }>
  const target = uses.map((use) => boxes.find((b) => b.special_use === use)).find(Boolean)
  if (!target) return false

  const ownCopy = db.prepare(
    `SELECT NOT EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id
      WHERE mm.message_id = ? AND COALESCE(mb.special_use, '') NOT IN ('\\Sent', '\\Drafts')) AS own`,
  )
  const movable = all.filter((id) => !(ownCopy.get(id) as { own: number }).own)
  const messageIds = movable.length > 0 ? movable : all

  db.transaction(() => {
    for (const messageId of messageIds) {
      const locations = serverLocations(db, accountId, messageId)
      enqueue(db, accountId, { kind: 'move', messageId, locations, target: { mailboxId: target.id, path: target.path } })
      // Show it in the target folder now, under a placeholder UID until the server assigns one.
      db.run('DELETE FROM message_mailboxes WHERE message_id = ?', [messageId])
      db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, ?, ?)', [target.id, -messageId, messageId])
    }
  })()
  return true
}

/** Label ids the UI uses for Gmail labels: `gm:<account>:<label name>`. */
export const gmailLabelId = (accountId: string, name: string) => `gm:${accountId}:${name}`
export const gmailLabelName = (accountId: string, id: string) => (id.startsWith(`gm:${accountId}:`) ? id.slice(`gm:${accountId}:`.length) : null)

/**
 * Set a conversation's Gmail labels to exactly `labelIds` (non-Gmail ids are ignored). Applied
 * locally now; queued as X-GM-LABELS changes. Returns false when nothing changed.
 */
export function queueLabels(db: MailDatabase, accountId: string, threadId: string, labelIds: string[]): boolean {
  const wanted = new Set(labelIds.map((id) => gmailLabelName(accountId, id)).filter((n): n is string => n != null))
  const messageIds = threadMessageIds(db, accountId, threadId)
  let queued = false
  db.transaction(() => {
    const threadLabels = new Set(messageIds.flatMap((id) => labelsOf(db, id)))
    for (const messageId of messageIds) {
      const current = new Set(labelsOf(db, messageId))
      // Only labels the conversation had can be removed; newly wanted labels go on every message.
      const add = [...wanted].filter((l) => !current.has(l))
      const remove = [...current].filter((l) => threadLabels.has(l) && !wanted.has(l))
      if (add.length === 0 && remove.length === 0) continue
      setMessageLabels(db, accountId, messageId, [...[...current].filter((l) => !remove.includes(l)), ...add], { force: true })
      enqueue(db, accountId, { kind: 'labels', messageId, locations: locationsOf(db, messageId), add, remove })
      queued = true
    }
  })()
  return queued
}

export function queueDelete(db: MailDatabase, accountId: string, threadId: string): boolean {
  const messageIds = threadMessageIds(db, accountId, threadId)
  if (messageIds.length === 0) return false
  db.transaction(() => {
    for (const messageId of messageIds) {
      enqueue(db, accountId, { kind: 'delete', messageId, locations: serverLocations(db, accountId, messageId) })
      db.run('DELETE FROM messages WHERE id = ?', [messageId])
    }
  })()
  return true
}

// --- Replay ------------------------------------------------------------------------------------

/**
 * What a replay did, and what it left for a sync to find out. `resync`: folders to sync because a
 * move's new UID didn't come back (no UIDPLUS: the target folder has to link the real copy) or it left
 * copies of the message behind in other folders. `gone`: moves whose message was no longer on the
 * server (the server wins; a full sync finds where it went). `labels`: Gmail label changes sent.
 */
export type ReplayResult = { applied: number; dropped: number; remaining: number; resync: Set<number>; gone: number; labels: number }
type Applied = { resync?: number[]; gone?: boolean }

/** Is this failure about the connection (keep the op) rather than the op itself (drop it)? */
const isConnectionError = (err: unknown) => {
  const e = err as { code?: string; message?: string }
  return /^E(CONNRESET|PIPE|TIMEDOUT|CONNREFUSED|HOSTUNREACH|NETUNREACH)$|^NoConnection$/.test(String(e?.code)) || /closed|connection|socket|timed? ?out/i.test(String(e?.message))
}

/** Moves sent to the server in one command at most: big enough to clear a mass clean-up fast, small enough for one IMAP line. */
const MOVE_BATCH = 200

type Row = { id: number; payload_json: string; attempts: number }
type MoveOp = Extract<PendingOp, { kind: 'move' }>

/** The folder a queued move comes from, or null when it has nothing to move (already there, or no UID yet). */
const moveSource = (op: PendingOp) => (op.kind === 'move' && op.locations.length ? (op.locations.find((l) => l.path !== op.target.path) ?? null) : null)

export async function replayPendingOps(client: ImapFlow, db: MailDatabase, accountId: string): Promise<ReplayResult> {
  const rows = db.query('SELECT id, payload_json, attempts FROM pending_ops WHERE account_id = ? ORDER BY id').all(accountId) as Row[]
  const ops = rows.map((row) => JSON.parse(row.payload_json) as PendingOp)
  let applied = 0
  let dropped = 0
  let gone = 0
  let labels = 0
  const resync = new Set<number>()
  const done = (row: Row, op: PendingOp, result: Applied | undefined) => {
    db.run('DELETE FROM pending_ops WHERE id = ?', [row.id])
    applied++
    if (result?.gone) gone++
    for (const id of result?.resync ?? []) resync.add(id)
    if (op.kind === 'labels') labels++
  }
  /** False when the connection failed and the replay has to stop. */
  const failed = (row: Row, err: unknown) => {
    if (isConnectionError(err) || !client.usable) {
      db.run('UPDATE pending_ops SET attempts = attempts + 1, last_error = ? WHERE id = ?', [String((err as Error)?.message ?? err), row.id])
      return false
    }
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      db.run('DELETE FROM pending_ops WHERE id = ?', [row.id])
      dropped++
    } else {
      db.run('UPDATE pending_ops SET attempts = attempts + 1, last_error = ? WHERE id = ?', [String((err as Error)?.message ?? err), row.id])
    }
    return true
  }
  const single = async (index: number) => {
    try {
      done(rows[index]!, ops[index]!, await apply(client, db, ops[index]!))
      return true
    } catch (err) {
      return failed(rows[index]!, err)
    }
  }

  for (let i = 0; i < rows.length; ) {
    // A run of moves between the same two folders goes up as one MOVE (a mass archive or clean-up
    // queues thousands); anything else, one at a time, in order.
    const source = moveSource(ops[i]!)
    let end = i + 1
    if (source) {
      const target = (ops[i] as MoveOp).target.path
      const seen = new Set([source.uid])
      while (end < rows.length && end - i < MOVE_BATCH) {
        const next = ops[end]!
        const from = moveSource(next)
        if (!from || from.path !== source.path || (next as MoveOp).target.path !== target || seen.has(from.uid)) break
        seen.add(from.uid)
        end++
      }
    }
    if (end - i === 1) {
      if (!(await single(i))) break
      i = end
      continue
    }
    try {
      const batch = ops.slice(i, end) as MoveOp[]
      const results = await applyMoves(client, db, batch, batch.map((op) => moveSource(op)!))
      results.forEach((result, k) => done(rows[i + k]!, batch[k]!, result))
    } catch (err) {
      if (isConnectionError(err) || !client.usable) {
        failed(rows[i]!, err)
        break
      }
      // Something about one of them: send them one by one, so only that one is held back.
      let stop = false
      for (let k = i; k < end && !stop; k++) stop = !(await single(k))
      if (stop) break
    }
    i = end
  }
  return { applied, dropped, remaining: pendingCount(db, accountId), resync, gone, labels }
}

/**
 * Several moves from one folder to another, as one UID SEARCH and one UID MOVE. Each is settled as
 * `apply` would settle it alone: gone when the server no longer has it, else linked to its new UID.
 */
async function applyMoves(client: ImapFlow, db: MailDatabase, batch: MoveOp[], sources: Location[]): Promise<Applied[]> {
  const gmail = client.capabilities.has('X-GM-EXT-1')
  const lock = await client.getMailboxLock(sources[0]!.path)
  try {
    const uids = sources.map((s) => s.uid)
    const existing = new Set(await searchUids(client, { uid: uids.join(',') }))
    const present = uids.filter((uid) => existing.has(uid))
    const result = present.length ? await client.messageMove(present.join(','), batch[0]!.target.path, { uid: true }) : undefined
    // In source-UID order, which is the order the server hands out the new UIDs: settleMove keeps the
    // target's checkpoint moving forward one at a time.
    const order = batch.map((_, k) => k).sort((a, b) => sources[a]!.uid - sources[b]!.uid)
    const results: Applied[] = new Array(batch.length)
    for (const k of order) {
      const op = batch[k]!
      const source = sources[k]!
      if (!existing.has(source.uid)) {
        settleMove(db, op, 'gone')
        results[k] = { gone: true }
        continue
      }
      const leftBehind = gmail ? [] : op.locations.filter((l) => l !== source && l.path !== op.target.path).map((l) => l.mailboxId)
      const uid = result ? result.uidMap?.get(source.uid) : undefined
      settleMove(db, op, uid ?? 'unknown', source)
      results[k] = { resync: uid == null ? [op.target.mailboxId, ...leftBehind] : leftBehind }
    }
    return results
  } finally {
    lock.release()
  }
}

async function apply(client: ImapFlow, db: MailDatabase, op: PendingOp): Promise<Applied | undefined> {
  if (op.kind === 'labels') {
    // Gmail labels belong to the message, not a folder copy: one STORE on any copy is enough.
    const [location] = locationsOf(db, op.messageId).sort((a, b) => Number(b.path.includes('All Mail')) - Number(a.path.includes('All Mail')))
    if (!location) return
    const lock = await client.getMailboxLock(location.path)
    try {
      if (op.add.length) await client.messageFlagsAdd(String(location.uid), op.add, { uid: true, useLabels: true })
      if (op.remove.length) await client.messageFlagsRemove(String(location.uid), op.remove, { uid: true, useLabels: true })
    } finally {
      lock.release()
    }
    return
  }

  if (op.kind === 'flags') {
    // Resolve where the message is now: an earlier op in this replay (a move) may have relocated it.
    const current = locationsOf(db, op.messageId)
    for (const location of current.length ? current : op.locations) {
      const lock = await client.getMailboxLock(location.path)
      try {
        // STORE on a UID that no longer exists is a no-op on the server: the server wins.
        if (op.add.length) await client.messageFlagsAdd(String(location.uid), op.add, { uid: true })
        if (op.remove.length) await client.messageFlagsRemove(String(location.uid), op.remove, { uid: true })
      } finally {
        lock.release()
      }
    }
    return
  }

  // An op captured before its message had a server UID (e.g. still syncing) has nothing to do.
  if (op.locations.length === 0) return

  if (op.kind === 'delete') {
    for (const location of op.locations) {
      const lock = await client.getMailboxLock(location.path)
      try {
        await client.messageDelete(String(location.uid), { uid: true })
      } finally {
        lock.release()
      }
    }
    return
  }

  // move: from the first location that isn't already the target.
  const source = op.locations.find((l) => l.path !== op.target.path)
  if (!source) {
    // Already where it's going (a move undone before it went up): the server never moved it, so its
    // UID there still holds.
    settleMove(db, op, op.locations.find((l) => l.path === op.target.path)!.uid)
    return
  }
  // Copies in other folders stay on the server; their folders' next sync links them again. On Gmail
  // those folders are labels on the one message, which the move doesn't touch.
  const leftBehind = client.capabilities.has('X-GM-EXT-1') ? [] : op.locations.filter((l) => l !== source && l.path !== op.target.path).map((l) => l.mailboxId)
  const lock = await client.getMailboxLock(source.path)
  try {
    // A failed search (dropped connection, NO/BAD) is not the same as "the server doesn't have it":
    // treating it as gone here would drop this message's only link and delete it locally. Let the op
    // stay queued and retry instead.
    const exists = await searchUids(client, { uid: String(source.uid) })
    if (exists.length === 0) {
      settleMove(db, op, 'gone')
      return { gone: true }
    }
    const result = await client.messageMove(String(source.uid), op.target.path, { uid: true })
    const uid = result ? result.uidMap?.get(source.uid) : undefined
    settleMove(db, op, uid ?? 'unknown', source)
    return { resync: uid == null ? [op.target.mailboxId, ...leftBehind] : leftBehind }
  } finally {
    lock.release()
  }
}

/**
 * After a move reaches the server: swap the placeholder link for the server's UID when UIDPLUS gave
 * one; otherwise keep the placeholder until the target folder's sync links the real copy (storeBatch
 * replaces it). If the message was already gone on the server, the server wins and it's removed.
 *
 * A move made here (`source`) also keeps both folders' checkpoints in step with the server, so the
 * next sync's STATUS check sees nothing it doesn't already have and can skip them rather than re-read
 * every UID and flag: the source holds one message fewer, and the target, when the new UID is exactly
 * the one it expected next after a complete sync (a count stored), one more with the checkpoint past
 * it. Anything else that changed on the server still shows as a count or UIDNEXT mismatch.
 */
function settleMove(db: MailDatabase, op: Extract<PendingOp, { kind: 'move' }>, outcome: number | 'unknown' | 'gone', source?: Location) {
  if (outcome === 'unknown') return
  db.transaction(() => {
    const account = db.query('SELECT account_id FROM messages WHERE id = ?').get(op.messageId) as { account_id: string } | null
    db.run('DELETE FROM message_mailboxes WHERE message_id = ? AND uid = ?', [op.messageId, -op.messageId])
    if (outcome !== 'gone') db.run('INSERT OR REPLACE INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, ?, ?)', [op.target.mailboxId, outcome, op.messageId])
    if (outcome !== 'gone' && source) {
      db.run('UPDATE mailboxes SET exists_count = exists_count - 1 WHERE id = ? AND exists_count > 0', [source.mailboxId])
      db.run('UPDATE mailboxes SET last_uid = ?1, uidnext = ?1 + 1, exists_count = exists_count + 1 WHERE id = ?2 AND uidnext = ?1 AND last_uid < ?1 AND exists_count IS NOT NULL', [outcome, op.target.mailboxId])
    }
    if (account) deleteOrphanMessages(db, account.account_id)
  })()
}
