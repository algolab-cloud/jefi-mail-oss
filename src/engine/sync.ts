import { createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import type { FetchMessageObject, ImapFlow, ListResponse, MessageAddressObject, MessageStructureObject, StatusObject } from 'imapflow'
import { simpleParser, type Attachment, type ParsedMail } from 'mailparser'
import type { AttachmentTarget } from './attachment-cache'
import { quarantine } from './attachment-safety'
import { searchUids } from './connection'
import type { MailDatabase } from './db'
import { MAX_INVITE_BYTES, type StoredInvite } from './calendar/store'
import { pendingAwayUids, pendingMailboxIds } from './pending-ops'
import { splitQuoted } from '../mail-text'
import {
  deleteOrphanMessages,
  knownUids,
  linkedCount,
  listMailboxes,
  removeLinks,
  updateFlags,
  messagesMissingBodies,
  resetMailbox,
  saveMailboxes,
  setCheckpoint,
  storeBatch,
  storeBody,
  type Address,
  type MailboxRow,
  type StoredBody,
  type SyncedMessage,
} from './mail-store'

// ---------------------------------------------------------------------------
// IMAP → SQLite. Folder discovery, then per-folder sync by UID in batches: each batch commits with
// its checkpoint, so an interrupted sync resumes where it stopped. A UIDVALIDITY change resets the
// folder. Bodies are separate (fetchBodies), newest first: the engine downloads them in the
// background after a sync, so the list is usable before every body arrives.
// ---------------------------------------------------------------------------

export type SyncProgress = { phase: string; done: number; total: number }

export type SyncOptions = {
  batchSize?: number
  onProgress?: (progress: SyncProgress) => void
  /** Called after each stored batch, so the UI can show mail while a big first sync runs. */
  onBatch?: () => void
  /** A folder's first sync stores this many newest messages before the rest (default 300). */
  newestFirst?: number
  /**
   * Caps how many gap-filled messages (lume-75z.7 self-heal, see refreshKnown) a sync repairs, newest
   * first; the rest wait for a sync with no limit. Unset repairs everything found. The inbox fast path
   * sets a small limit so a push stays quick even behind a badly damaged folder.
   */
  repairLimit?: number
  /** syncAccount: how long a folder that looks unchanged may go without a full sync when the server lacks CONDSTORE (default FLAG_REFRESH_MS). */
  flagRefreshMs?: number
  /** syncAccount: open every folder even when STATUS says it's unchanged (the engine's periodic reconcile). */
  reconcile?: boolean
  signal?: AbortSignal
}

export type MailboxSyncResult = { path: string; fetched: number; reset: boolean; removed: number; flagsChanged: number; skipped: number; repaired: number }

/** Sync order: the folders people look at first. */
const PRIORITY = ['\\Inbox', '\\Sent', '\\Drafts', '\\Archive', '\\All', '\\Flagged', '\\Junk', '\\Trash']

export async function discoverMailboxes(client: ImapFlow, db: MailDatabase, accountId: string): Promise<MailboxRow[]> {
  return saveListed(db, accountId, await listFolders(client))
}

const STATUS_QUERY = { messages: true, uidNext: true, uidValidity: true, highestModseq: true }

/**
 * The server's selectable folders, with STATUS when asked and the server can answer it inside the
 * LIST (LIST-STATUS, RFC 5819). Throws rather than returning a list that can't be the whole truth:
 * saveMailboxes drops every folder missing from it, and their mail with them.
 */
async function listFolders(client: ImapFlow, withStatus = false) {
  const listed = (await client.list(withStatus ? { statusQuery: STATUS_QUERY } : {})) as ListResponse[] | false
  // Every account has an INBOX (RFC 3501 §5.1), so a list without one is a failed or cut-short
  // response, not a mailbox emptied of folders.
  if (!Array.isArray(listed) || !listed.some((box) => box.path.toUpperCase() === 'INBOX')) {
    throw new Error(`Folder list came back ${Array.isArray(listed) ? `without an INBOX (${listed.length} folders)` : 'empty'}; keeping the folders we have`)
  }
  return listed.filter((box) => !box.flags?.has('\\Noselect') && !box.flags?.has('\\NonExistent'))
}

const saveListed = (db: MailDatabase, accountId: string, listed: ListResponse[]) =>
  saveMailboxes(
    db,
    accountId,
    listed.map((box) => ({ path: box.path, delimiter: box.delimiter, specialUse: box.specialUse ?? (box.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null) })),
  )

export function syncOrder(mailboxes: MailboxRow[]): MailboxRow[] {
  const rank = (box: MailboxRow) => {
    const index = box.special_use ? PRIORITY.indexOf(box.special_use) : -1
    return index === -1 ? PRIORITY.length : index
  }
  return [...mailboxes].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
}

export async function syncMailbox(client: ImapFlow, db: MailDatabase, accountId: string, box: MailboxRow, options: SyncOptions = {}): Promise<MailboxSyncResult> {
  const batchSize = options.batchSize ?? 500
  const lock = await client.getMailboxLock(box.path, { readOnly: true })
  try {
    const resync = await resyncSince(client, box, options)
    const status = client.mailbox
    if (!status) throw new Error(`Couldn't open ${box.path}`)
    const uidvalidity = Number(status.uidValidity)
    const uidnext = status.uidNext
    const highestmodseq = status.highestModseq != null ? Number(status.highestModseq) : null

    let reset = false
    let lastUid = box.last_uid
    if (box.uidvalidity != null && box.uidvalidity !== uidvalidity) {
      resetMailbox(db, box.id, uidvalidity)
      lastUid = 0
      reset = true
    }

    let fetched = 0
    let skipped = 0
    // Ask the server which UIDs exist past the checkpoint instead of trusting UIDNEXT: on an already
    // selected mailbox imapflow's uidNext is stale (EXISTS updates only the count), and UIDs have gaps.
    // Computed before refreshKnown below so it can tell a real mass-deletion from a bad response (see
    // the EXISTS sanity check there): both searches together must account for the whole mailbox.
    const newUids = status.exists === 0 ? [] : (await searchUids(client, { uid: `${lastUid + 1}:*` })).filter((uid) => uid > lastUid)
    const knownNext = Math.max(uidnext, (newUids.at(-1) ?? 0) + 1)

    const fetchAndStore = async (uids: number[], checkpointUid: number) => {
      const batch: SyncedMessage[] = []
      for await (const message of client.fetch(
        uids.join(','),
        // emailId (X-GM-MSGID / OBJECTID) comes back automatically when the server supports it.
        { uid: true, envelope: true, flags: true, size: true, internalDate: true, headers: ['references', 'list-unsubscribe', 'list-unsubscribe-post'], labels: gmail(client) },
        { uid: true },
      )) {
        // Marked \Deleted and waiting for an expunge (ours, on a server without UIDPLUS: see
        // deleteMessages; or another app's): as good as gone, so not brought back here.
        if (message.flags?.has('\\Deleted')) continue
        batch.push(toSyncedMessage(message))
      }
      const result = storeBatch(db, accountId, { id: box.id, uidvalidity }, batch, { lastUid: checkpointUid, uidnext: knownNext, highestmodseq })
      skipped += result.skipped.length
      for (const problem of result.skipped) console.warn(`sync: skipped ${box.path} uid ${problem.uid}: ${problem.error}`)
      options.onBatch?.()
      return result.stored
    }

    // Changes to mail we already have: deletions (and moves away) and flags set elsewhere, plus
    // (lume-75z.7) self-healing any gap between what the server has under this checkpoint and what's
    // linked locally — the trace of an earlier sync that wrongly unlinked mail after a failed search.
    let removed = 0
    let flagsChanged = 0
    let repaired = 0
    if (lastUid > 0 && !reset) {
      const refreshed =
        (resync && applyResync(db, accountId, box, lastUid, status.exists - newUids.length, resync)) ||
        (await refreshKnown(client, db, accountId, box, lastUid, status.exists, highestmodseq, newUids.length > 0))
      removed = refreshed.removed
      flagsChanged = refreshed.flagsChanged

      const knownUidSet = new Set(refreshed.known.map((k) => k.uid))
      // A queued move/delete already claimed these UIDs are leaving this folder; the server still
      // lists them here until that op replays, but re-linking them now would fight the local intent.
      const away = pendingAwayUids(db, accountId, box.id)
      let missing = [...refreshed.onServer].filter((uid) => !knownUidSet.has(uid) && !away.has(uid)).sort((a, b) => b - a)
      if (options.repairLimit != null) missing = missing.slice(0, options.repairLimit)
      for (let start = 0; start < missing.length; start += batchSize) {
        if (options.signal?.aborted) break
        repaired += await fetchAndStore(missing.slice(start, start + batchSize), lastUid)
      }
    }

    // The message count goes in only once the folder is fully caught up: it's what lets a later
    // syncAccount skip this folder (see `unchanged`), so an interrupted sync must leave it unset.
    if (newUids.length === 0) {
      setCheckpoint(db, box.id, uidvalidity, { lastUid, uidnext: knownNext, highestmodseq, exists: options.signal?.aborted ? null : status.exists })
      return { path: box.path, fetched, reset, removed, flagsChanged, skipped, repaired }
    }

    // A big first sync shows the newest mail right away: store the newest slice first (without
    // moving the checkpoint, so an interruption still resumes from the start), then the rest in order.
    const headSize = options.newestFirst ?? 300
    const head = lastUid === 0 && newUids.length > headSize ? newUids.slice(-headSize) : []
    const rest = head.length ? newUids.slice(0, -headSize) : newUids
    for (let start = head.length; start > 0; start -= batchSize) {
      if (options.signal?.aborted) break
      fetched += await fetchAndStore(head.slice(Math.max(0, start - batchSize), start), lastUid)
    }
    for (let start = 0; start < rest.length; start += batchSize) {
      if (options.signal?.aborted) break
      const uids = rest.slice(start, start + batchSize)
      fetched += await fetchAndStore(uids, uids.at(-1)!)
    }
    // The newest slice was stored first; once everything below it is in, the checkpoint covers it too.
    if (!options.signal?.aborted) setCheckpoint(db, box.id, uidvalidity, { lastUid: newUids.at(-1)!, uidnext: knownNext, highestmodseq, exists: status.exists })
    return { path: box.path, fetched, reset, removed, flagsChanged, skipped, repaired }
  } finally {
    lock.release()
  }
}

export type Resync = { vanished: Set<number>; flags: Map<number, string[]> }

/**
 * QRESYNC (RFC 7162): re-open the folder with the UIDVALIDITY and HIGHESTMODSEQ of our last
 * checkpoint, so the server answers with just what changed since — VANISHED (EARLIER) for UIDs that
 * are gone and a FETCH for each message whose flags changed — instead of us listing every UID.
 * Returns null whenever that answer can't be trusted as the whole story, and the caller takes the
 * UID SEARCH path: no QRESYNC, nothing stored to resync from, Gmail (labels aren't in the answer),
 * the periodic reconcile, a failed SELECT, or imapflow dropping QRESYNC because UIDVALIDITY changed
 * or the folder has no mod-sequences. Always selects afresh, even an already-selected folder: that
 * makes the HIGHESTMODSEQ the caller stores the one the server reported alongside exactly the
 * changes collected here, not a value imapflow bumped from unsolicited FETCHes we never applied.
 */
export async function resyncSince(client: ImapFlow, box: MailboxRow, options: Pick<SyncOptions, 'reconcile'> = {}): Promise<Resync | null> {
  if (options.reconcile || !client.enabled?.has('QRESYNC') || gmail(client)) return null
  if (box.uidvalidity == null || box.highestmodseq == null || box.last_uid <= 0) return null
  const events: Array<{ path: string; uid?: number; flags?: Set<string>; vanished?: boolean }> = []
  let seqOnly = false
  const onExpunge = (event: { path: string; uid?: number; vanished?: boolean }) => {
    if (event.vanished && event.uid) events.push(event)
    else seqOnly = true
  }
  const onFlags = (event: { path: string; uid?: number; flags?: Set<string> }) => {
    if (event.uid) events.push(event)
    else seqOnly = true
  }
  client.on('expunge', onExpunge)
  client.on('flags', onFlags)
  let opened
  try {
    opened = await client.mailboxOpen(box.path, { readOnly: true, uidValidity: BigInt(box.uidvalidity), changedSince: BigInt(box.highestmodseq) } as Parameters<ImapFlow['mailboxOpen']>[1])
  } catch (err) {
    console.warn(`sync: QRESYNC open of ${box.path} failed, listing UIDs instead: ${err instanceof Error ? err.message : String(err)}`)
    // A failed SELECT leaves nothing selected; the caller needs the folder open for the SEARCH path.
    await client.mailboxOpen(box.path, { readOnly: true })
    return null
  } finally {
    client.off('expunge', onExpunge)
    client.off('flags', onFlags)
  }
  const mailbox = opened as (typeof opened & { qresync?: boolean }) | undefined
  if (!mailbox || mailbox.qresync !== true || mailbox !== client.mailbox || mailbox.highestModseq == null || mailbox.noModseq || seqOnly) return null
  const resync: Resync = { vanished: new Set(), flags: new Map() }
  for (const event of events) {
    if (event.path !== mailbox.path) continue
    if (event.vanished) {
      resync.vanished.add(event.uid!)
      resync.flags.delete(event.uid!)
    } else if (event.flags && !resync.vanished.has(event.uid!)) resync.flags.set(event.uid!, [...event.flags])
  }
  return resync
}

/**
 * Applies a QRESYNC answer, or returns null (nothing applied) when the local links don't add up to
 * the server's count afterwards: `expected` is how many messages the server has at or below lastUid
 * (EXISTS minus the UIDs above it). A mismatch is evidence of a gap — an earlier bad sync, a queued
 * move, or a server over-reporting VANISHED — and only the full UID list can sort that out, so the
 * caller falls back to refreshKnown and its self-heal. Checking before unlinking means a wrong
 * VANISHED can never unlink mail by itself.
 */
export function applyResync(db: MailDatabase, accountId: string, box: MailboxRow, lastUid: number, expected: number, resync: Resync) {
  const known = knownUids(db, box.id, lastUid)
  const gone = known.filter((k) => resync.vanished.has(k.uid)).map((k) => k.uid)
  if (known.length - gone.length !== expected) return null
  removeLinks(db, box.id, gone)
  const updates = [...resync.flags].filter(([uid]) => uid <= lastUid).map(([uid, flags]) => ({ uid, flags }))
  const flagsChanged = updateFlags(db, accountId, box.id, updates)
  // No server UID list: nothing to gap-fill, which the count check above just showed is right.
  return { removed: gone.length, flagsChanged, known, onServer: new Set<number>() }
}

/**
 * Reconcile messages this folder already has with the server: UIDs that disappeared (deleted, or
 * moved to another folder) lose their link here, and flags changed by other clients are applied.
 * With CONDSTORE only messages changed since the last checkpoint are read; otherwise all flags.
 *
 * Returns `known` and `onServer` too, so the caller can gap-fill (lume-75z.7): UIDs the server still
 * has at or below this checkpoint that aren't linked locally are the trace of an earlier sync that
 * unlinked mail after a failed search (imapflow's search() returns `false`, not a throw, on any
 * failure — a dropped connection, a NO/BAD, a timeout). `searchUids` below now turns that into a
 * thrown error instead of an empty result, so this can't happen again going forward; the gap-fill
 * exists to repair databases already damaged by the old behavior.
 */
async function refreshKnown(client: ImapFlow, db: MailDatabase, accountId: string, box: MailboxRow, lastUid: number, exists: number, highestmodseq: number | null, hasNewMail: boolean) {
  const known = knownUids(db, box.id, lastUid)
  const onServer = new Set(exists === 0 ? [] : await searchUids(client, { uid: `1:${lastUid}` }))
  // EXISTS says the mailbox isn't empty, yet neither the search below the checkpoint nor the one
  // above it (computed by the caller, `hasNewMail`) turned up a single UID — together those two
  // ranges cover every UID a conforming server could report, so this combination can't happen
  // honestly. Treat it as a bad response rather than "every known message was deleted", which would
  // unlink all of them; only misfires if a server can genuinely report EXISTS > 0 while both ranges
  // are empty, which would itself be a protocol violation.
  if (exists > 0 && onServer.size === 0 && !hasNewMail && known.length > 0) {
    throw new Error(`${box.path}: server reports ${exists} message(s) but UID search found none in 1:${lastUid} or above it; refusing to unlink ${known.length} known message(s)`)
  }
  const gone = known.filter((k) => !onServer.has(k.uid)).map((k) => k.uid)
  removeLinks(db, box.id, gone)

  let flagsChanged = 0
  // Let the server decide what changed (CHANGEDSINCE) rather than comparing HIGHESTMODSEQ here: on a
  // mailbox this connection already has selected, imapflow's value is from the original SELECT.
  const canUseModseq = box.highestmodseq != null && highestmodseq != null
  if (onServer.size > 0) {
    const updates: Array<{ uid: number; flags: string[] }> = []
    for await (const message of client.fetch(
      `1:${lastUid}`,
      { uid: true, flags: true, labels: gmail(client) },
      { uid: true, ...(canUseModseq ? { changedSince: BigInt(box.highestmodseq!) } : {}) },
    )) {
      if (message.uid <= lastUid) updates.push({ uid: message.uid, flags: [...(message.flags ?? [])], ...(gmail(client) ? { labels: [...(message.labels ?? [])] } : {}) })
    }
    flagsChanged = updateFlags(db, accountId, box.id, updates)
  }
  return { removed: gone.length, flagsChanged, known, onServer }
}

/** Download bodies for messages that don't have one yet, newest first. */
export async function fetchBodies(client: ImapFlow, db: MailDatabase, accountId: string, limit: number, signal?: AbortSignal, smallBodyBytes?: number): Promise<number> {
  return fetchBodiesOf(client, db, messagesMissingBodies(db, accountId, limit), signal, smallBodyBytes)
}

/**
 * Messages up to this size (RFC822.SIZE) are fetched whole, a batch in one FETCH: most mail is a few
 * KB to a few tens of KB, where the text-only path's per-message round trips cost far more time than
 * the bytes it saves. 256 KiB still downloads a small attachment or two in passing (about 2 s at
 * 1 Mbit/s for the worst case), while anything with a real attachment stays text-only.
 */
export const SMALL_BODY_BYTES = 256 * 1024
/** At most this many bytes of whole sources in one FETCH, so a batch never becomes one huge response. */
const SOURCE_BATCH_BYTES = 4 * 1024 * 1024

/**
 * Downloads and stores the bodies of the given messages, one mailbox at a time. Small ones (by their
 * stored size) come whole in batched FETCHes; the rest, and any of unknown size, text-only. An abort
 * stops before the next mailbox or batch.
 */
export async function fetchBodiesOf(
  client: ImapFlow,
  db: MailDatabase,
  pending: Array<{ id: number; path: string; uid: number; size?: number | null }>,
  signal?: AbortSignal,
  smallBodyBytes = SMALL_BODY_BYTES,
): Promise<number> {
  const byMailbox = new Map<string, typeof pending>()
  for (const item of pending) {
    const items = byMailbox.get(item.path)
    if (items) items.push(item)
    else byMailbox.set(item.path, [item])
  }

  let stored = 0
  for (const [path, items] of byMailbox) {
    if (signal?.aborted) break
    const lock = await client.getMailboxLock(path, { readOnly: true })
    // Bodies are written a FETCH at a time, in one transaction: a commit per body cost more than the
    // body itself. Whatever arrived before a failure is still written before the error goes up.
    const parsed: Array<{ id: number; body: StoredBody }> = []
    const flush = () => {
      if (!parsed.length) return
      db.transaction(() => {
        for (const { id, body } of parsed) storeBody(db, id, body)
      })()
      stored += parsed.length
      parsed.length = 0
    }
    try {
      const idByUid = new Map(items.map((item) => [item.uid, item.id]))
      const store = (uid: number, body: StoredBody) => {
        const id = idByUid.get(uid)
        if (id) parsed.push({ id, body })
      }
      const small = items.filter((item) => item.size != null && item.size <= smallBodyBytes)
      for (const batch of sourceBatches(small)) {
        if (signal?.aborted) break
        await fetchWholeBodies(client, batch, store)
        flush()
      }
      if (signal?.aborted) break
      const rest = items.filter((item) => !small.includes(item)).map((item) => item.uid)
      const whole = rest.length ? await fetchTextBodies(client, rest, store) : []
      flush()
      if (whole.length) await fetchWholeBodies(client, whole, store)
      flush()
    } catch (err) {
      try {
        flush()
      } catch {
        // The fetch's own error is the one to report.
      }
      throw err
    } finally {
      lock.release()
    }
  }
  return stored
}

/** UIDs split so no one FETCH asks for more than SOURCE_BATCH_BYTES of sources. */
function sourceBatches(items: Array<{ uid: number; size?: number | null }>): number[][] {
  const batches: number[][] = []
  let batch: number[] = []
  let bytes = 0
  for (const item of items) {
    if (batch.length && bytes + item.size! > SOURCE_BATCH_BYTES) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(item.uid)
    bytes += item.size!
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** The whole message, attachments and all, parsed as is: for small mail, and what the text-only path can't reproduce. */
async function fetchWholeBodies(client: ImapFlow, uids: number[], store: (uid: number, body: StoredBody) => void) {
  for await (const message of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
    if (message.source) store(message.uid, storedBody(await simpleParser(message.source)))
  }
}

/** What gets stored for a parsed message; `attachment` supplies each listed attachment's part and size. */
export function storedBody(parsed: ParsedMail, attachment: (a: Attachment) => Partial<StoredBody['attachments'][number]> = (a) => ({ size: a.size })): StoredBody {
  const text = parsed.text ?? null
  const html = typeof parsed.html === 'string' ? parsed.html : null
  return {
    text,
    html,
    snippet: snippetOf(text ?? (html !== null ? stripTags(html) : '')),
    attachments: listedAttachments(parsed.attachments).map((a) => ({ filename: a.filename, contentType: a.contentType, contentId: a.contentId, ...attachment(a) })),
    invites: invitesOf(parsed),
  }
}

const isInviteType = (type: string) => /^(text\/calendar|application\/ics)$/i.test(type)

/**
 * The message's calendar parts (meeting invites, replies, cancellations), raw, for date detection
 * to parse later. Parts over MAX_INVITE_BYTES are left out; the text-only path fetches only those
 * under it, so a bigger one never has content here anyway.
 */
function invitesOf(parsed: ParsedMail): StoredInvite[] {
  return parsed.attachments.flatMap((a) => {
    if (!isInviteType(a.contentType) || !a.content?.length || a.content.length > MAX_INVITE_BYTES) return []
    const ics = a.content.toString('utf8')
    const method = parseMethod(a) ?? ics.match(/^METHOD:(.+?)\r?$/im)?.[1]?.trim() ?? null
    return [{ method: method?.toUpperCase() ?? null, filename: a.filename ?? null, ics }]
  })
}

/** The Content-Type's method= parameter, which mailparser keeps in the part's headers. */
const parseMethod = (a: Attachment): string | null => {
  const header = a.headers.get('content-type') as { params?: Record<string, string> } | string | undefined
  return typeof header === 'object' ? (header.params?.method ?? null) : null
}

// ---------------------------------------------------------------------------
// Bodies without their attachments. BODYSTRUCTURE first; then only each message's text parts and
// the MIME headers of its other parts. Those are put back together as a skeleton of the message
// (multipart headers rewritten, attachment bodies left empty) that simpleParser reads exactly as it
// reads the whole message: same text, html and snippet, and the same attachment list in the same
// order, which matters because downloadAttachment later finds an attachment by its index in a full
// parse. simpleParser turns cid: images the HTML shows into data: URIs, so those images (and only
// those) are fetched too, in a second round. Anything the skeleton can't reproduce falls back to the
// whole source: no BODYSTRUCTURE, an inline forwarded message (simpleParser renders its headers and
// text into the body), a section the server left out, or a skeleton that won't parse.
// ---------------------------------------------------------------------------

type Plan = {
  uid: number
  root: MessageStructureObject
  /** Non-multipart parts by the section that fetches their body: TEXT for a single-part message. */
  leaves: Map<string, MessageStructureObject>
  sections: string[]
  images: string[]
  /** Fetched sections, by lowercased name ('header' for the message header). */
  fetched: Map<string, Buffer>
}

// Tags each part in the skeleton, so an attachment simpleParser reports can be traced to its part.
const PART_HEADER = 'X-Jefi-Part'
// What simpleParser reads as body text rather than an attachment, unless marked as an attachment.
const TEXT_TYPES = ['text/plain', 'text/html', 'message/delivery-status']

const isMultipart = (node: MessageStructureObject) => node.type.toLowerCase().startsWith('multipart/')
const isText = (node: MessageStructureObject) => TEXT_TYPES.includes(node.type.toLowerCase()) && node.disposition?.toLowerCase() !== 'attachment'
const sectionOf = (attachment: Attachment) => {
  const value = attachment.headers.get(PART_HEADER.toLowerCase())
  return typeof value === 'string' ? value : undefined
}

/**
 * Downloads text-only bodies for the given UIDs; returns those that need the whole source instead.
 * Exported for scripts/testing/compare-text-bodies.ts, which checks it against whole-source parses.
 */
export async function fetchTextBodies(client: ImapFlow, uids: number[], store: (uid: number, body: StoredBody) => void): Promise<number[]> {
  const plans: Plan[] = []
  const whole: number[] = []
  for await (const message of client.fetch(uids.join(','), { uid: true, bodyStructure: true }, { uid: true })) {
    const plan = message.bodyStructure ? planOf(message.uid, message.bodyStructure) : null
    if (plan) plans.push(plan)
    else whole.push(message.uid)
  }
  await fetchSections(client, plans, (plan) => plan.sections)

  const withImages: Plan[] = []
  for (const plan of plans) {
    const parsed = await parseSkeleton(plan, { keepCidLinks: true })
    const images = parsed && cidImages(parsed)
    const body = parsed && images && !images.length ? textBody(plan, parsed) : null
    if (body) store(plan.uid, body)
    else if (images?.length) withImages.push(Object.assign(plan, { images }))
    else whole.push(plan.uid)
  }
  if (!withImages.length) return whole

  await fetchSections(client, withImages, (plan) => plan.images)
  for (const plan of withImages) {
    const parsed = await parseSkeleton(plan)
    const body = parsed && textBody(plan, parsed)
    if (body) store(plan.uid, body)
    else whole.push(plan.uid)
  }
  return whole
}

/** What to fetch for one message, or null when its structure needs the whole source. */
function planOf(uid: number, root: MessageStructureObject): Plan | null {
  const leaves = new Map<string, MessageStructureObject>()
  const walk = (node: MessageStructureObject): boolean => {
    if (!node.type) return false
    if (isMultipart(node)) return !!node.childNodes?.length && node.childNodes.every(walk)
    if (node.type.toLowerCase() === 'message/rfc822' && node.disposition?.toLowerCase() === 'inline') return false
    const section = node === root ? 'TEXT' : node.part
    if (!section || leaves.has(section)) return false
    leaves.set(section, node)
    return true
  }
  if (!walk(root)) return null
  const sections: string[] = []
  for (const [section, leaf] of leaves) {
    sections.push(leaf === root ? 'HEADER' : `${section}.MIME`)
    // Invites come with the text: they're small, and date detection reads them offline.
    if (isText(leaf) || (isInviteType(leaf.type) && (leaf.size ?? Infinity) <= MAX_INVITE_BYTES)) sections.push(section)
  }
  return { uid, root, leaves, sections, images: [], fetched: new Map() }
}

/**
 * Fetches each plan's sections, one FETCH per distinct list of them: asking one message for
 * another's sections could pull in an attachment.
 */
async function fetchSections(client: ImapFlow, plans: Plan[], sectionsOf: (plan: Plan) => string[]) {
  const groups = new Map<string, Plan[]>()
  for (const plan of plans) {
    const key = sectionsOf(plan).join(' ')
    if (key) groups.set(key, [...(groups.get(key) ?? []), plan])
  }
  for (const [key, group] of groups) {
    const byUid = new Map(group.map((plan) => [plan.uid, plan]))
    for await (const message of client.fetch(group.map((plan) => plan.uid).join(','), { uid: true, bodyParts: key.split(' ') }, { uid: true })) {
      const plan = byUid.get(message.uid)
      if (!plan) continue
      // imapflow hands BODY[HEADER] back as `headers`, the rest by lowercased section.
      if (message.headers) plan.fetched.set('header', message.headers)
      for (const [section, value] of message.bodyParts ?? []) if (value) plan.fetched.set(section.toLowerCase(), value)
    }
  }
}

async function parseSkeleton(plan: Plan, options?: { keepCidLinks: boolean }) {
  const skeleton = skeletonOf(plan)
  return skeleton ? simpleParser(skeleton, options).catch(() => null) : null
}

/** The message rebuilt from what was fetched, or null if the server left out a section it needs. */
function skeletonOf(plan: Plan): Buffer | null {
  const chunks: Buffer[] = []
  const add = (value: string | Buffer) => chunks.push(typeof value === 'string' ? Buffer.from(value) : value)
  const boundary = `jefi-${randomUUID()}`
  const build = (node: MessageStructureObject): boolean => {
    if (isMultipart(node)) {
      // simpleParser only reads a multipart's type, and a boundary of our own can't clash with the text.
      const own = `${boundary}-${node.part ?? '0'}`
      add(`Content-Type: ${node.type}; boundary="${own}"\r\n\r\n`)
      for (const child of node.childNodes ?? []) {
        add(`--${own}\r\n`)
        if (!build(child)) return false
        add('\r\n')
      }
      add(`--${own}--\r\n`)
      return true
    }
    const section = node === plan.root ? 'TEXT' : node.part!
    const header = plan.fetched.get(node === plan.root ? 'header' : `${section}.mime`.toLowerCase())
    if (!header) return false
    add(`${PART_HEADER}: ${section}\r\n`)
    const lines = withoutTrailingNewlines(header)
    if (lines.length) add(Buffer.concat([lines, Buffer.from('\r\n')]))
    add('\r\n')
    const body = plan.fetched.get(section.toLowerCase())
    // A single-part message has no boundary after its TEXT, so only parts get the trim.
    if (body) add(node === plan.root ? body : withoutBoundaryCrlf(body, node.size))
    else if (isText(node)) return false
    return true
  }
  return build(plan.root) ? Buffer.concat(chunks) : null
}

/**
 * A part body without the CRLF Exchange sends with it, which belongs to the next boundary line
 * (RFC 2046). Only when the body is exactly two bytes over BODYSTRUCTURE's size: other servers send
 * `size` bytes, and a CRLF there is the part's own.
 */
const withoutBoundaryCrlf = (value: Buffer, size?: number) =>
  size != null && value.length === size + 2 && value[size] === 0x0d && value[size + 1] === 0x0a ? value.subarray(0, size) : value

const withoutTrailingNewlines = (value: Buffer) => {
  let end = value.length
  while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d)) end--
  return value.subarray(0, end)
}

/**
 * Sections of the images the HTML shows by cid:, matched as simpleParser's own cid: → data: rewrite
 * matches them; null if one can't be traced to its part.
 */
function cidImages(parsed: ParsedMail): string[] | null {
  if (typeof parsed.html !== 'string') return []
  const sections = new Set<string | undefined>()
  for (const [, cid] of parsed.html.matchAll(/\bcid:([^'"\s]{1,256})/g)) {
    const image = parsed.attachments.find((a) => a.cid === cid && /^image\/[\w]+$/i.test(a.contentType))
    if (image) sections.add(sectionOf(image))
  }
  return sections.has(undefined) ? null : ([...sections] as string[])
}

/** The body to store, with each attachment's part and size taken from BODYSTRUCTURE; null if a part can't be traced. */
function textBody(plan: Plan, parsed: ParsedMail): StoredBody | null {
  let traced = true
  const body = storedBody(parsed, (a) => {
    const section = sectionOf(a)
    const leaf = section ? plan.leaves.get(section) : undefined
    if (!section || !leaf) {
      traced = false
      return {}
    }
    return { part: leaf.part ?? '1', ...(plan.fetched.has(section.toLowerCase()) ? { size: a.size } : attachmentSize(leaf)) }
  })
  return traced ? body : null
}

/**
 * An attachment's decoded size without downloading it, estimated from the encoded size BODYSTRUCTURE
 * gives. Only an estimate even for 7bit parts (servers don't all count line endings the way the
 * source has them), so it is flagged and never checked against downloaded bytes.
 */
function attachmentSize(leaf: MessageStructureObject): { size: number | null; sizeEstimated?: boolean } {
  if (leaf.size == null) return { size: null }
  // Base64 carries 3 bytes in 4 characters, in lines of 76 and a CRLF.
  return { size: leaf.encoding?.toLowerCase() === 'base64' ? Math.round((leaf.size * 57) / 78) : leaf.size, sizeEstimated: true }
}

export const gmail = (client: ImapFlow) => client.capabilities.has('X-GM-EXT-1')

/**
 * Folders to download. On Gmail, user labels are views of All Mail: every message is fetched once
 * from the special-use folders (Inbox, Sent, All Mail…) and its labels come from X-GM-LABELS.
 */
export const foldersToSync = (client: ImapFlow, mailboxes: MailboxRow[]) =>
  gmail(client) ? mailboxes.filter((b) => b.special_use && !['\\Important', '\\Flagged'].includes(b.special_use)) : mailboxes

/** Without CONDSTORE a folder that looks unchanged is still fully synced this often, for its flags. */
export const FLAG_REFRESH_MS = 10 * 60_000

/**
 * Full pass for one account: folders, then every folder's new messages. Headers only: bodies are the
 * engine's background backfill, so a big body download never holds up a sync (or the push behind it).
 */
export async function syncAccount(client: ImapFlow, db: MailDatabase, accountId: string, options: SyncOptions = {}) {
  options.onProgress?.({ phase: 'Folders', done: 0, total: 1 })
  // LIST-STATUS answers every folder's STATUS inside the LIST. Without it, ask per folder below, and
  // only for the folders we sync: imapflow's own fallback would also STATUS every Gmail label.
  const listed = await listFolders(client, client.capabilities.has('LIST-STATUS'))
  const statuses = new Map(listed.map((box) => [box.path, box.status]))
  const mailboxes = syncOrder(foldersToSync(client, saveListed(db, accountId, listed)))
  const busy = pendingMailboxIds(db, accountId)
  const now = Date.now()
  const results: MailboxSyncResult[] = []
  let foldersSkipped = 0
  for (const [index, box] of mailboxes.entries()) {
    if (options.signal?.aborted) break
    options.onProgress?.({ phase: displayName(box), done: index, total: mailboxes.length })
    // The Inbox gets no special treatment: push already watches it, and when STATUS proves it
    // unchanged, re-reading its (usually largest) UID list every minute buys nothing.
    if (!busy.has(box.id) && !options.reconcile) {
      const status = statuses.get(box.path) ?? (await client.status(box.path, STATUS_QUERY).catch(() => false as const))
      if (unchanged(box, status, linkedCount(db, box.id), now - (options.flagRefreshMs ?? FLAG_REFRESH_MS))) {
        foldersSkipped++
        continue
      }
    }
    results.push(await syncMailbox(client, db, accountId, box, options))
  }
  // Only now: a message moved between folders was unlinked in one and relinked in another above.
  deleteOrphanMessages(db, accountId)
  options.onProgress?.({ phase: 'Messages', done: mailboxes.length, total: mailboxes.length })
  return { mailboxes: listMailboxes(db, accountId), results, foldersSkipped }
}

/**
 * Whether STATUS proves a folder is exactly as its last completed sync left it, so opening it would
 * find nothing: same UIDVALIDITY, no new UID handed out, same message count (catches deletions and
 * moves away) and, with CONDSTORE, the same HIGHESTMODSEQ (catches flag changes). Without CONDSTORE
 * flag changes don't show in STATUS at all, so the skip only holds until `fullSyncAfter` (a time).
 * A folder whose local links don't add up to the server's count is never skipped: that gap is for
 * syncMailbox's self-heal to repair.
 */
function unchanged(box: MailboxRow, status: StatusObject | { error: unknown } | false | undefined, linked: number, fullSyncAfter: number) {
  if (!status || !('messages' in status) || status.messages == null || status.uidNext == null || status.uidValidity == null) return false
  // exists_count is only set by a sync that finished, so this also covers never-synced folders.
  if (box.exists_count == null || box.synced_at == null) return false
  if (Number(status.uidValidity) !== box.uidvalidity || status.uidNext !== box.uidnext || status.messages !== box.exists_count) return false
  if (linked !== status.messages) return false
  if (status.highestModseq != null) return box.highestmodseq != null && Number(status.highestModseq) === box.highestmodseq
  return box.synced_at > fullSyncAfter
}

export function displayName(box: Pick<MailboxRow, 'path' | 'delimiter'>) {
  if (box.path.toUpperCase() === 'INBOX') return 'Inbox'
  return box.delimiter ? box.path.split(box.delimiter).at(-1)! : box.path
}

function toSyncedMessage(message: FetchMessageObject): SyncedMessage {
  const envelope = message.envelope
  const headers = message.headers ? message.headers.toString('utf8') : ''
  const references = headers ? parseReferences(headers) : []
  const unsubscribe = headerValue(headers, 'list-unsubscribe')
  return {
    uid: message.uid,
    modseq: message.modseq != null ? Number(message.modseq) : null,
    messageId: envelope?.messageId ?? null,
    gmMsgId: message.emailId ?? null,
    subject: envelope?.subject ?? '',
    from: addresses(envelope?.from)[0] ?? null,
    to: addresses(envelope?.to),
    cc: addresses(envelope?.cc),
    bcc: addresses(envelope?.bcc),
    replyTo: addresses(envelope?.replyTo),
    inReplyTo: envelope?.inReplyTo ?? null,
    references,
    date: toTime(envelope?.date) ?? toTime(message.internalDate) ?? Date.now(),
    size: message.size ?? null,
    flags: [...(message.flags ?? [])],
    ...(message.labels ? { labels: [...message.labels] } : {}),
    ...(unsubscribe ? { listUnsubscribe: unsubscribe, listUnsubscribePost: /one-click/i.test(headerValue(headers, 'list-unsubscribe-post') ?? '') } : {}),
  }
}

/** One header's value from a raw header block (continuation lines unfolded). */
export const headerValue = (headers: string, name: string) =>
  headers.replace(/\r?\n[ \t]+/g, ' ').match(new RegExp(`^${name}:(.*)$`, 'im'))?.[1]?.trim() || null

const toTime = (value?: Date | string | null) => {
  if (!value) return null
  const time = (value instanceof Date ? value : new Date(value)).getTime()
  return Number.isNaN(time) ? null : time
}

const addresses = (list?: MessageAddressObject[]): Address[] =>
  (list ?? []).filter((a) => a.address).map((a) => (a.name ? { name: a.name, email: a.address! } : { email: a.address! }))

export const parseReferences = (headers: string) => {
  const value = headers.replace(/\r?\n[ \t]+/g, ' ').match(/^references:(.*)$/im)?.[1] ?? ''
  return value.match(/<[^<>\s]+>/g) ?? []
}

const stripTags = (html: string) => html.replace(/<style\b[\s\S]*?<\/style[^>]*>|<script\b[\s\S]*?<\/script[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ')

/** The list preview: what's new in the message, without the quoted history (or its "On … wrote:"). */
export const snippetOf = (text: string) =>
  splitQuoted(text.replace(/\r\n?/g, '\n')).body
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    // Don't end on half an emoji.
    .replace(/[\ud800-\udbff]$/, '')

/** Attachments as the reader lists them: inline images referenced by the HTML are left out. */
export const listedAttachments = <T extends { contentDisposition?: string; contentId?: string }>(all: T[]) =>
  all.filter((a) => a.contentDisposition !== 'inline' || !a.contentId)

/**
 * Downloads one attachment by its stable reader index. The caller supplies an authorized target
 * bound to mailbox UIDVALIDITY and UID. Source bytes are streamed through a bounded temporary file;
 * the attachment becomes visible only after the complete source and indexed part are verified.
 */
const MAX_ATTACHMENT_SOURCE_BYTES = 100 * 1024 * 1024

export async function downloadAttachment(client: ImapFlow, target: AttachmentTarget, maximumBytes = MAX_ATTACHMENT_SOURCE_BYTES): Promise<string> {
  const lock = await client.getMailboxLock(target.mailbox, { readOnly: true })
  let content: Readable | undefined
  let sourcePath: string | undefined
  try {
    if (!client.mailbox || Number(client.mailbox.uidValidity) !== target.uidvalidity) throw new Error('This message changed on the server; sync and try again')
    const downloaded = await client.download(String(target.uid), undefined, { uid: true, maxBytes: maximumBytes + 1, chunkSize: 64 * 1024 })
    if (!downloaded?.content) throw new Error('This message is no longer on the server')
    content = downloaded.content
    if (downloaded.meta.expectedSize && downloaded.meta.expectedSize > maximumBytes) {
      downloaded.content.destroy()
      throw new Error('This message is too large to download its attachment')
    }

    mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 })
    sourcePath = `${target.path}.${randomUUID()}.source.tmp`
    const sourceFile = await open(sourcePath, 'wx', 0o600)
    let sourceSize = 0
    try {
      for await (const value of downloaded.content) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        sourceSize += chunk.byteLength
        if (sourceSize > maximumBytes) {
          downloaded.content.destroy()
          throw new Error('This message is too large to download its attachment')
        }
        await sourceFile.writeFile(chunk)
      }
      if (downloaded.meta.expectedSize && sourceSize !== downloaded.meta.expectedSize) throw new Error('The server returned an incomplete message; try again')
      await sourceFile.sync()
    } finally {
      await sourceFile.close().catch(() => {})
    }

    if (!client.mailbox || Number(client.mailbox.uidValidity) !== target.uidvalidity) throw new Error('This message changed on the server; sync and try again')
    const attachment = listedAttachments((await simpleParser(createReadStream(sourcePath))).attachments)[target.index]
    if (!attachment) throw new Error('Attachment not found')
    if (target.size !== null && attachment.content.byteLength !== target.size) throw new Error('Attachment changed on the server')
    const temporaryPath = `${target.path}.${randomUUID()}.tmp`
    const attachmentFile = await open(temporaryPath, 'wx', 0o600)
    try {
      await attachmentFile.writeFile(attachment.content)
      await attachmentFile.sync()
      await attachmentFile.close()
      // Marked as downloaded before it's visible under its own name, so nothing ever opens it
      // unmarked (the attribute moves with the rename). Never fails the download.
      await quarantine(temporaryPath)
      renameSync(temporaryPath, target.path)
    } catch (error) {
      await attachmentFile.close().catch(() => {})
      rmSync(temporaryPath, { force: true })
      throw error
    }
    return target.path
  } finally {
    if (content && !content.destroyed) content.destroy()
    if (sourcePath) rmSync(sourcePath, { force: true })
    lock.release()
  }
}
