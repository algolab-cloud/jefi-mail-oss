import type { Account } from '../accounts'
import type { DraftFields, MailThread } from '../data'
import type { ImapFlow } from 'imapflow'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, statSync } from 'node:fs'
import { configDir } from '../paths'
import { appConnectOptions, appendMessage, checkAccount, classify, createImapClient, createSmtpTransport, deleteMessages, searchUids, type ConnectOptions } from './connection'
import { buildOutgoing, newMessageId, replyReferences, replySubject, type OutgoingMessage } from './mime'
import {
  appendToSent,
  cancelOutgoing,
  classifySmtpError,
  dueOutgoing,
  enqueueOutgoing,
  getOutgoing,
  markBodySent,
  markConfirmedSent,
  markFailed,
  markSending,
  markSent,
  markUnconfirmed,
  nextAutomaticRetryAt,
  sendOutcomeUnknown,
  watchBodySent,
  unreadableAttachment,
  unreadableAttachmentError,
  nodemailerFields,
  recoverInterrupted,
  reconcileSentCopies,
  renderRaw,
  requeue,
  serverFilesSentMail,
  type OutboxEntry,
} from './outbox'
import { openDatabase, type MailDatabase } from './db'
import * as calendar from './calendar/store'
import * as notes from './calendar/notes'
import * as tasks from './calendar/tasks'
import * as invites from './calendar/invites'
import { createReminderScheduler, type ReminderClock } from './calendar/reminders'
import {
  clearDraftRemoval,
  deleteAccountData,
  deleteDraftRow,
  draftAccountOf,
  dirtyDrafts,
  draftMessageId,
  draftRemovals,
  ensureAccount,
  knownUids,
  listMailboxes,
  markDraftPushed,
  bodilessIds,
  messagesMissingBodies,
  messagesMissingBodiesInMailbox,
  saveDraftRow,
  storedAccountIds,
  updateFlags,
  type MailboxRow,
} from './mail-store'
import { pendingCount, queueDelete, queueDeleteMessages, queueFlags, queueLabels, queueMove, queueMoves, replayPendingOps, type ReplayResult } from './pending-ops'
import { credentialsFor, credentialsFromSecret, oauthSecret } from './credentials'
import { OAuthError, signIn } from './oauth'
import { MissingSecretError, keychainSecrets, type SecretStore } from './secrets'
import { downloadAttachment, fetchBodiesOf, headerValue, syncAccount, syncMailbox } from './sync'
import { parseUnsubscribe, scrubMessageIds, scrubReport, scrubStats, scrubTargets, senderProfiles, senderThreads, spamThreads, unsubscribeOptions } from './scrub'
import { searchThreads } from './search'
import { applyRules, countRuleMatches, deleteRule, isEmptyMatch, listRules, newInboxMessageIds, saveRule } from './rules'
import { blockedSenders, screenerEnabledAt, setScreener, setVerdict } from './screener'
import { snoozeThread, takeDueSnoozes, unsnoozeThread } from './snooze'
import { threadMessageIds, uiThreadId } from './threading'
import { loadContacts } from './contacts'
import { createLocalLabel, deleteLocalLabel, setThreadLocalLabels, updateLocalLabel } from './local-labels'
import { countInboxUnread, hasOlderThreads, isGmailAccount, listRevision, loadFolders, loadLabels, loadThread, loadThreads, loadView, pruneListRemovals, unreadAcrossAccounts } from './threads'
import type { DeliveryState, EngineEvent, EngineListener, GetAttachmentResult, GetOriginalResult, MailEngine, ScrubMove } from './types'
import { detectWake } from './wake'
import { watchInbox, type InboxWatcher } from './watch'
import { clearAttachmentCache, hasReadableCachedAttachment, resolveAttachmentTarget, sameAttachmentTarget, settleAttachmentSize } from './attachment-cache'
import { clearOriginalCache, downloadOriginalMessage, hasReadableOriginal, resolveOriginalTarget } from './original-message'

// ---------------------------------------------------------------------------
// The real engine for real accounts: IMAP → SQLite → MailThread events. Mail already in SQLite is
// published as soon as an account is known, so it shows up offline and before the first sync.
// After a successful sync each account keeps an IDLE connection on its inbox: new mail triggers a
// sync, dropped connections reconnect with backoff, and waking from sleep reconnects everything.
// Syncs and on-demand fetches share one kept command connection per account, and the engine polls on
// its own once the store allows it (setAutoSync): slowly while push is up, the inbox often while down.
// Syncs store headers only; message bodies come down afterwards in a background backfill that steps
// aside whenever a sync or an opened conversation needs the account, so old mail never delays new.
// Read/star/move/delete apply to SQLite at once and replay to the server before each sync
// (pending-ops.ts). Sending goes through the persistent outbox (outbox.ts): queued → sending →
// sent | failed, with a copy appended to Sent unless the provider files it.
// ---------------------------------------------------------------------------

export type ImapEngineOptions = {
  database?: () => MailDatabase
  secrets?: SecretStore
  connectOptions?: ConnectOptions
  /** Bodies one background backfill run downloads, newest first (default 500); runs chain until none are left. */
  bodyLimit?: number
  /** Bodies per backfill round trip (default 25): the list updates after each, and a sync can cut in between. */
  backfillBatch?: number
  /** Breather between chained backfill runs (default 500ms). */
  backfillPauseMs?: number
  /** Waits before retrying a backfill whose connection failed, one per failure in a row; the last repeats. */
  backfillRetryMs?: number[]
  /** Messages fetched per round trip; smaller batches publish sooner (tests use this to interrupt one). */
  batchSize?: number
  /** Keep an IDLE connection per account for push (default true). */
  watch?: boolean
  reconnectBackoffMs?: number[]
  /** Coalesces bursts of new-mail notifications into one sync. */
  newMailDebounceMs?: number
  /** How long after the last draft edit its copy goes to the server's Drafts mailbox (default 15s). */
  draftSyncDelayMs?: number
  /** How often snoozes and scheduled sends are checked (default 30s). */
  schedulerMs?: number
  /** Opens a downloaded attachment; defaults to macOS `open`. Tests capture the path instead. */
  openFile?: (path: string) => void
  /** Sleep detection; false turns it off. */
  wake?: { intervalMs?: number; toleranceMs?: number } | false
  /** The reminder scheduler's clock and timers; tests drive a fake one. */
  reminderClock?: Partial<ReminderClock>
  /** Background sync cadence; see POLL. Tests shrink it. */
  poll?: Partial<PollCadence>
}

type PollCadence = {
  /** How often the poller looks at each account. */
  tickMs: number
  /** Full (STATUS-skipping) sync this often, push or not. */
  fullMs: number
  /** Inbox-only sync this often while push is down. */
  inboxMs: number
  /** A full sync that skips no folder at least this often. */
  reconcileMs: number
  /** Coming back to the app syncs when the last sync is older than this. */
  activatedMs: number
}

/**
 * Push tells us about new inbox mail within seconds, so while it's up polling only has to catch what
 * IDLE can't see (other folders, flags on servers that don't push them): a cheap full sync every two
 * minutes. While push is down the inbox is polled every 30s instead, so new mail is never far behind.
 */
const POLL: PollCadence = { tickMs: 5_000, fullMs: 2 * 60_000, inboxMs: 30_000, reconcileMs: 15 * 60_000, activatedMs: 30_000 }

/** 'inbox' is the fast path a push notification takes; 'all' is the full account sync. */
type SyncScope = 'all' | 'inbox'

const MAX_ANNOUNCED = 3
const SNAPSHOT_INTERVAL_MS = 1000
/** Gap-fill repair (lume-75z.7) the inbox fast path does per push, newest UIDs first; the rest waits for a full sync. */
const INBOX_REPAIR_LIMIT = 200
/** Conversations in an account's first list snapshot, and how many more each `loadMore` adds. */
const LIST_PAGE = 500

export function createImapEngine(options: ImapEngineOptions = {}): MailEngine {
  const secrets = options.secrets ?? keychainSecrets()
  const connectOptions = options.connectOptions ?? appConnectOptions()
  const watchEnabled = options.watch ?? true
  const poll: PollCadence = { ...POLL, ...options.poll }
  const debounceMs = options.newMailDebounceMs ?? 400
  const listeners = new Set<EngineListener>()
  const syncing = new Set<string>()
  /** Accounts with local changes going up on their own (see pushChanges); a sync waits for them. */
  const pushing = new Set<string>()
  /**
   * Syncs requested while one was running; they run again right after. 'all' outranks 'inbox'.
   * `quick`: an inbox sync only IDLE asked for (see inboxUnchanged), until anything else joins it.
   */
  const requeued = new Map<string, { manual: boolean; scope: SyncScope; quick: boolean }>()
  const published = new Set<string>()
  const watchers = new Map<string, InboxWatcher>()
  const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Conversations each account's list holds. Only ever grows (`loadMore`), and every later snapshot
   * honours it: a routine publish must not shrink the list back to a page and yank rows from under
   * someone who scrolled into last year's mail.
   */
  const listLimits = new Map<string, number>()
  /** Accounts whose pending snapshot must be emitted even if the list fingerprint is unchanged. */
  const forcedSnapshots = new Set<string>()
  const debounces = new Map<string, ReturnType<typeof setTimeout>>()
  /** Accounts that had push running when we went offline, to resume when back online. */
  let resumeOnline = new Set<string>()
  let accounts: Account[] = []
  /**
   * Accounts removed this run. Ids are never reused, so these stay out for good: a stale account list
   * or work already in flight for one (a sync waiting on its connection, a requeued sync) must not
   * bring its row back and fill it with mail again.
   */
  const removed = new Set<string>()
  let offline = false
  let disposed = false
  /** Off until the store allows it (onboarding done): no account is polled before. */
  let autoSync = false
  /** When each account's last sync of any scope, and last full one, started. */
  const lastSync = new Map<string, number>()
  const lastFull = new Map<string, number>()
  /** When each account last had a full sync that skipped nothing (see syncFull). */
  const lastReconcile = new Map<string, number>()
  let db: MailDatabase | null = null

  /**
   * Publishes the list at most once a second; bursts (sync + push + local changes) collapse into one.
   * `ifChanged` skips the snapshot when the list fingerprint is the same, for the one caller that
   * fires per stored batch. Everything else publishes regardless: a local change the fingerprint
   * can't see (a move, a snooze, a screener verdict) must still reach the list.
   */
  const publishSoon = (accountId: string, ifChanged = false) => {
    if (removed.has(accountId)) return
    if (!ifChanged) forcedSnapshots.add(accountId)
    if (snapshotTimers.has(accountId)) return
    snapshotTimers.set(
      accountId,
      setTimeout(() => {
        snapshotTimers.delete(accountId)
        publishNow(accountId, !forcedSnapshots.delete(accountId))
      }, SNAPSHOT_INTERVAL_MS),
    )
  }

  const publishNow = (accountId: string, ifChanged = false) => {
    if (disposed) return
    const version = listVersion(accountId)
    if (ifChanged && publishedVersion.get(accountId) === version) return
    publishedVersion.set(accountId, version)
    emit(snapshot(accountId))
  }

  const database = () => {
    if (db) return db
    db = (options.database ?? openDatabase)()
    // Sends cut off by a crash or quit go back to the queue.
    recoverInterrupted(db)
    return db
  }
  /** The sign-in waiting on the provider's page, if any. */
  let signInAbort: AbortController | null = null
  const emit = (...events: EngineEvent[]) => {
    if (disposed) return
    // Every calendar or task change can move a reminder, whoever made it (a save, an invite, an account removed).
    if (events.some((e) => e.type === 'calendarChanged' || e.type === 'tasksChanged')) reminders.replan()
    for (const listener of listeners) listener(events)
  }
  /** The account's label list, after Jefi's own labels changed. */
  const labelsChanged = (accountId: string) =>
    emit({ type: 'labelsChanged', accountId, labels: loadLabels(database(), accountId), gmail: isGmailAccount(database(), accountId) })
  const reminders = createReminderScheduler({
    db: () => database(),
    onDue: (reminder) => emit({ type: 'reminderDue', reminder }),
    clock: options.reminderClock,
  })
  const accountById = (id: string) => accounts.find((a) => a.id === id)
  const calendarChanged = (calendarIds: string[]) => emit({ type: 'calendarChanged', ...(calendarIds.length ? { calendarIds } : {}) })
  const notesChanged = (noteIds: string[]) => emit({ type: 'notesChanged', noteIds })
  const tasksChanged = (taskIds: string[]) => emit({ type: 'tasksChanged', taskIds })
  /**
   * Cheap marker of what the list shows, to skip snapshots that would change nothing: the account's
   * list revision, which triggers bump in the same transaction as every change the list can show.
   */
  const listVersion = (accountId: string) => String(listRevision(database(), accountId).rev)
  const publishedVersion = new Map<string, string>()
  /**
   * The last snapshot per account and what it was built from. A publish the revision can't tell
   * apart (a forced one, a second listener) reuses it instead of rebuilding the window and counting
   * past it again. The day is part of it: list dates read "Today" and "Yesterday".
   */
  const snapshotCache = new Map<string, { basis: string; upserts: MailThread[]; hasMore: boolean; inboxUnread?: number }>()

  /**
   * The account window: the newest `listLimits` conversations of the whole account, for the unread
   * badges, the switcher, announcements and the views SQL can't narrow. Views that can be are paged
   * by the store on their own (loadView).
   */
  const snapshot = (accountId: string): EngineEvent => {
    const account = accountById(accountId)
    const limit = listLimits.get(accountId) ?? LIST_PAGE
    const now = new Date()
    // The Outbox has no revision trigger (see migration 15); its few rows are fingerprinted here.
    const outbox = database().query('SELECT count(*) c, max(updated_at) u FROM outbound_queue WHERE account_id = ?').get(accountId) as { c: number; u: number | null }
    const basis = [listVersion(accountId), outbox.c, outbox.u, limit, now.toDateString(), account?.name, account?.email, JSON.stringify(account?.face ?? null)].join('\u0000')
    let cached = snapshotCache.get(accountId)
    if (cached?.basis !== basis) {
      const db = database()
      pruneListRemovals(db, accountId)
      cached = {
        basis,
        upserts: loadThreads(db, accountId, { limit, now, ...(account ? { account: { name: account.name, email: account.email, face: account.face } } : {}) }),
        hasMore: hasOlderThreads(db, accountId, limit),
        // The window holds the newest conversations only; badges need the whole Inbox's count.
        inboxUnread: account ? countInboxUnread(db, account) : undefined,
      }
      snapshotCache.set(accountId, cached)
    }
    return { type: 'threadsChanged', accountId, upserts: cached.upserts, replaceAll: true, hasMore: cached.hasMore, inboxUnread: cached.inboxUnread }
  }

  const connect = async (accountId: string) => {
    const account = accountById(accountId)
    if (!account) throw new Error('Account removed')
    const client = createImapClient(account, await credentialsFor(secrets, accountId), connectOptions)
    client.on('error', () => {})
    await client.connect()
    return client
  }

  // --- Command connection ----------------------------------------------------------------------
  //
  // One signed-in connection per account, opened on first use and kept, for full syncs, the inbox
  // poll when push is down, and on-demand work (opening old mail, attachments, the original source).
  // A poll then costs a few commands instead of a TCP + TLS + login round trip. Every user takes a
  // mailbox lock, so imapflow keeps them from selecting folders under each other. Between uses it
  // stays alive through polling and imapflow's auto-IDLE on whatever folder was last selected;
  // anything that looks dead (sleep, offline, removal) drops it, and the next use opens a new one
  // through connect(), so OAuth accounts sign in again with a freshly refreshed token.
  // The body backfill keeps its own connection (see the backfill section for when it's closed).

  const commands = new Map<string, ImapFlow>()
  const opening = new Map<string, Promise<ImapFlow>>()
  /** Bumped by every drop, so a connection that finishes opening after one is thrown away. */
  const commandGeneration = new Map<string, number>()

  /** connect() failed: carries the original error so the caller can say what to fix. */
  class ConnectFailed extends Error {
    constructor(readonly reason: unknown) {
      super(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const commandClient = (accountId: string): Promise<ImapFlow> => {
    const live = commands.get(accountId)
    if (live?.usable) return Promise.resolve(live)
    if (live) commands.delete(accountId)
    const pending = opening.get(accountId)
    if (pending) return pending
    const generation = commandGeneration.get(accountId) ?? 0
    const next = connect(accountId)
      .catch((err) => {
        throw new ConnectFailed(err)
      })
      .then((client) => {
        if ((commandGeneration.get(accountId) ?? 0) !== generation || disposed || removed.has(accountId)) {
          client.close()
          throw new ConnectFailed(new Error(removed.has(accountId) ? 'Account removed' : 'Connection dropped'))
        }
        commands.set(accountId, client)
        client.on('close', () => {
          if (commands.get(accountId) === client) commands.delete(accountId)
        })
        return client
      })
      .finally(() => {
        if (opening.get(accountId) === next) opening.delete(accountId)
      })
    opening.set(accountId, next)
    return next
  }

  const dropCommand = (accountId: string) => {
    commandGeneration.set(accountId, (commandGeneration.get(accountId) ?? 0) + 1)
    opening.delete(accountId)
    const client = commands.get(accountId)
    commands.delete(accountId)
    if (client) client.logout().catch(() => client.close())
  }

  /**
   * Selects the folder a kept connection was left in again. Locking a folder that's already selected
   * doesn't re-select it, so its UIDVALIDITY, UIDNEXT and MODSEQ would be whatever they were minutes
   * ago; a fresh EXAMINE brings them up to date, as a new connection's would be. (Not CLOSE: that
   * expunges.) It's also the round trip that finds out whether the socket is still alive.
   */
  const reselect = async (client: ImapFlow) => {
    const box = client.mailbox
    if (!box) return
    const lock = await client.getMailboxLock(box.path, { readOnly: box.readOnly })
    try {
      await client.mailboxOpen(box.path, { readOnly: box.readOnly })
    } finally {
      lock.release()
    }
  }

  /**
   * Runs `work` on the account's command connection. A reused connection can turn out to be dead
   * (the server timed it out, the network changed): that's no reason to fail, so when the work fails
   * and the connection is gone with it, the work runs once more on a fresh one. Connect failures
   * reject with ConnectFailed.
   */
  const withCommand = async <T>(accountId: string, work: (client: ImapFlow) => Promise<T>): Promise<T> => {
    const reused = !!commands.get(accountId)?.usable
    const client = await commandClient(accountId)
    try {
      if (reused) await reselect(client)
      return await work(client)
    } catch (err) {
      // Connection-level: the socket is gone (imapflow may not have noticed the close yet, so the error
      // itself counts too). A NO from the server, or a local failure, is not worth a second try.
      const account = accountById(accountId)
      const dead = !client.usable || (!!account && ['network', 'timeout'].includes(classify(err, 'imap', account).kind))
      if (!reused || !dead || disposed || offline || !account) throw err
      if (commands.get(accountId) === client) commands.delete(accountId)
      client.close()
      return work(await commandClient(accountId))
    }
  }

  /**
   * On-demand work (opening a conversation, an attachment) shares the command connection, except
   * while a full sync is on it: then it gets a connection of its own rather than waiting behind a
   * folder download.
   */
  const withConnection = async <T>(accountId: string, work: (client: ImapFlow) => Promise<T>): Promise<T> => {
    if (!syncing.has(accountId)) return withCommand(accountId, work)
    const client = await connect(accountId)
    try {
      return await work(client)
    } finally {
      void client.logout().catch(() => client.close())
    }
  }

  // --- Sync ------------------------------------------------------------------------------------

  const finish = (accountId: string) => {
    syncing.delete(accountId)
    const next = requeued.get(accountId)
    if (!next) return resumeBackfill(accountId)
    requeued.delete(accountId)
    setTimeout(() => void sync(accountId, next.manual, next.scope, next.quick), 0)
  }

  const failSync = (accountId: string, manual: boolean, error: string, status: 'offline' | 'error' = 'error', needsSignIn = false) => {
    emit({ type: 'connection', accountId, status, error, needsSignIn }, { type: 'syncState', accountId, manual, state: { status: 'error', phase: undefined, error } })
    finish(accountId)
  }

  /** A connect() failure, translated into what the UI shows and whether it means signing in again. */
  const connectFailure = (err: unknown, account: Account) => {
    const failure = classify(err, 'imap', account)
    // A missing Keychain entry, a revoked or expired OAuth grant, or a rejected login.
    const needsSignIn = err instanceof MissingSecretError || err instanceof OAuthError || failure.kind === 'auth'
    const message =
      err instanceof MissingSecretError
        ? err.message
        : err instanceof OAuthError
          ? `${account.email} needs you to sign in again`
        : err instanceof Error && err.message === 'Account removed'
          ? err.message
          : failure.message
    return { message, needsSignIn }
  }

  const sync = async (accountId: string, manual: boolean, scope: SyncScope = 'all', quick = false) => {
    const account = accountById(accountId)
    if (!account || disposed) return
    // An inbox sync also waits for changes about to go up (pushSoon): run now, it would find them
    // still queued and turn into a full sync.
    if (syncing.has(accountId) || pushing.has(accountId) || (scope === 'inbox' && pushTimers.has(accountId))) {
      const prior = requeued.get(accountId)
      requeued.set(accountId, { manual: manual || (prior?.manual ?? false), scope: prior?.scope === 'all' ? 'all' : scope, quick: prior ? prior.quick && quick : quick })
      return
    }

    // A push only wants the inbox, but that's only safe with a checkpoint to diff against and nothing
    // local still waiting to go up (replaying those needs a connection that can reach every mailbox).
    const db = database()
    ensureAccount(db, accountId, account.email)
    const inboxBefore = listMailboxes(db, accountId).find((b) => b.special_use === '\\Inbox')
    const runInboxOnly = scope === 'inbox' && !!inboxBefore && inboxBefore.last_uid > 0 && pendingCount(db, accountId) === 0

    syncing.add(accountId)
    const started = Date.now()
    lastSync.set(accountId, started)
    if (!runInboxOnly) lastFull.set(accountId, started)
    pauseBackfill(accountId)
    const syncingState = () => emit({ type: 'syncState', accountId, manual, state: { status: 'syncing', phase: runInboxOnly ? 'Inbox' : 'Connecting', done: 0, total: 1, error: undefined } })
    // A quick check says so only once it finds something to sync: the echo of our own change is silent.
    const checkFirst = runInboxOnly && quick && !manual
    if (!checkFirst || offline) syncingState()
    if (offline) return failSync(accountId, manual, `Couldn't reach ${account.servers.imapHost}`, 'offline')

    if (runInboxOnly) return void syncInbox(accountId, manual, account, inboxBefore!, checkFirst ? syncingState : null)
    return void syncFull(accountId, manual, account)
  }

  const syncFull = async (accountId: string, manual: boolean, account: Account) => {
    const db = database()
    const inboxBefore = listMailboxes(db, accountId).find((b) => b.special_use === '\\Inbox')
    // Every so often skip nothing: STATUS can't see everything (flags without CONDSTORE, a server that
    // lies), and a pass that opens every folder puts right whatever the skips let drift.
    const reconcile = Date.now() - (lastReconcile.get(accountId) ?? 0) >= poll.reconcileMs
    let result
    try {
      result = await withCommand(accountId, async (client) => {
        // Removed while connecting: stop here rather than store mail for it (sync() made its row).
        if (!accountById(accountId)) return null
        // Local changes go up before anything comes down, so the sync sees the server as we left it.
        if (pendingCount(db, accountId) > 0) {
          emit({ type: 'syncState', accountId, manual, state: { phase: 'Saving changes' } })
          reportDropped(accountId, await replayPendingOps(client, db, accountId))
        }
        await pushDrafts(client, accountId)

        const synced = await syncAccount(client, db, accountId, {
          batchSize: options.batchSize,
          reconcile,
          onProgress: (p) => emit({ type: 'syncState', accountId, manual, state: { phase: p.phase, done: p.done, total: Math.max(p.total, 1) } }),
          // Stream the list while a big sync runs; publishing is coalesced, so this stays cheap.
          onBatch: () => publishSoon(accountId, true),
        })
        // SMTP can succeed just before the app loses its response. A synced server copy carrying the
        // immutable Message-ID is delivery evidence, so do not show or send the pending copy again.
        reconcileSentCopies(db, accountId)
        // Rules act on what just arrived in the Inbox (not on the first download of a mailbox).
        const ruled = inboxBefore && inboxBefore.last_uid > 0 ? applyInboxRules(db, accountId, inboxBefore.id, inboxBefore.last_uid) : 0
        if (ruled && pendingCount(db, accountId) > 0) reportDropped(accountId, await replayPendingOps(client, db, accountId))
        return synced
      })
    } catch (err) {
      // Removed while connecting or mid-sync (its secret and rows went with it): nothing to report.
      if (!accountById(accountId)) return finish(accountId)
      if (err instanceof ConnectFailed) {
        const { message, needsSignIn } = connectFailure(err.reason, account)
        return failSync(accountId, manual, message, offline ? 'offline' : 'error', needsSignIn)
      }
      // Whatever broke may have left the connection mid-command: the next sync starts on a fresh one.
      dropCommand(accountId)
      // A local database failure isn't a mail-server problem: say so plainly.
      const local = (err as { name?: string })?.name === 'SQLiteError'
      return failSync(accountId, manual, local ? `Couldn't save mail on this Mac: ${(err as Error).message}` : classify(err, 'imap', account).message)
    }
    if (disposed) return
    if (!result || !accountById(accountId)) return finish(accountId)
    if (reconcile) lastReconcile.set(accountId, Date.now())

    // One list build per sync, reused for the snapshot and for announcing new mail.
    const list = snapshot(accountId)
    publishedVersion.set(accountId, listVersion(accountId))
    const events: EngineEvent[] = [
      { type: 'connection', accountId, status: 'online' },
      { type: 'labelsChanged', accountId, labels: loadLabels(db, accountId), gmail: isGmailAccount(db, accountId) },
      { type: 'foldersChanged', accountId, folders: loadFolders(db, accountId) },
      { type: 'contactsChanged', accountId, contacts: loadContacts(db, accountId) },
      list,
    ]
    // Announce new inbox mail only on later syncs, not the first download of an existing mailbox.
    if (inboxBefore && inboxBefore.last_uid > 0) {
      const announcement = announceInboxMail(db, accountId, inboxBefore.id, inboxBefore.last_uid, list)
      if (announcement) events.push(announcement)
    }
    const total = Math.max(result.mailboxes.length, 1)
    events.push({ type: 'syncState', accountId, manual, state: { status: 'idle', phase: undefined, done: total, total, lastSyncedAt: Date.now(), error: undefined } })
    emit(...events)
    startWatching(accountId)
    backfillWanted.add(accountId)
    finish(accountId)
    // The server is reachable: send anything queued or due for a retry.
    void drain(accountId)
  }

  /**
   * Push's fast path, and the inbox poll while push is down: sync just the inbox, reusing the
   * watcher's own IDLE connection when it has one (else the command connection), and publish the
   * instant that folder (and only its new bodies) lands — not after every other folder catches up
   * too. Everything else (drafts, other folders, pending ops) still waits for the next full sync.
   */
  const syncInbox = async (accountId: string, manual: boolean, account: Account, inboxBefore: MailboxRow, quick: (() => void) | null = null) => {
    const db = database()
    const afterUid = inboxBefore.last_uid
    const borrowed = watchers.get(accountId)?.client() ?? null

    // Only the inbox — never lock or select anything else on a connection the watcher owns. Gap-fill
    // repair (lume-75z.7) is capped here so a damaged folder (thousands of missing UIDs) can't turn
    // a push into a slow sync; whatever's left over is picked up by the next full sync, uncapped.
    const pass = async (client: ImapFlow) => {
      if (quick) {
        if (await inboxUnchanged(client, db, accountId, inboxBefore)) return null
        quick()
      }
      const result = await syncMailbox(client, db, accountId, inboxBefore, { batchSize: options.batchSize, repairLimit: INBOX_REPAIR_LIMIT })
      const fresh = messagesMissingBodiesInMailbox(db, inboxBefore.id, afterUid)
      if (fresh.length && (await fetchBodiesOf(client, db, fresh))) invitesArrived(accountId)
      // Rules run here, inside the failure handling below: a database error must still free the account.
      return { result, ruled: applyInboxRules(db, accountId, inboxBefore.id, afterUid) }
    }

    let outcome
    try {
      if (borrowed) {
        outcome = await pass(borrowed)
        borrowed.idle().catch(() => {}) // imapflow broke IDLE to run our commands; resume it
      } else outcome = await withCommand(accountId, pass)
    } catch (err) {
      if (borrowed) {
        // The watcher owns this connection's lifecycle (it reconnects on 'close'); leave it be and let
        // a full sync, on the command connection, pick up whatever didn't make it in.
        finish(accountId)
        return syncSoon(accountId)
      }
      if (!accountById(accountId)) return finish(accountId)
      if (err instanceof ConnectFailed) {
        const { message, needsSignIn } = connectFailure(err.reason, account)
        return failSync(accountId, manual, message, offline ? 'offline' : 'error', needsSignIn)
      }
      dropCommand(accountId)
      const local = (err as { name?: string })?.name === 'SQLiteError'
      return failSync(accountId, manual, local ? `Couldn't save mail on this Mac: ${(err as Error).message}` : classify(err, 'imap', account).message)
    }
    if (disposed) return
    if (!accountById(accountId)) return finish(accountId)
    if (!outcome) return finish(accountId)

    const { result, ruled } = outcome
    // A queued move or label change needs a connection that can reach other mailboxes; the borrowed
    // one only ever touches the inbox, so a full sync replays it instead. Same if this run repaired
    // anything: there may be more gap than the cap allowed, and the full sync repairs without a cap.
    const needsFullSync = (ruled > 0 && pendingCount(db, accountId) > 0) || result.repaired > 0

    const list = snapshot(accountId)
    publishedVersion.set(accountId, listVersion(accountId))
    const events: EngineEvent[] = [
      { type: 'connection', accountId, status: 'online' },
      { type: 'contactsChanged', accountId, contacts: loadContacts(db, accountId) },
      list,
    ]
    const announcement = announceInboxMail(db, accountId, inboxBefore.id, afterUid, list)
    if (announcement) events.push(announcement)
    events.push({ type: 'syncState', accountId, manual, state: { status: 'idle', phase: undefined, done: 1, total: 1, lastSyncedAt: Date.now(), error: undefined } })
    emit(...events)
    backfillWanted.add(accountId)
    finish(accountId)
    if (needsFullSync) syncSoon(accountId)
    void drain(accountId)
  }

  /**
   * Whether the Inbox on the server holds exactly the UIDs linked here — as it does after the echo of
   * our own move or delete, which IDLE reports as an EXPUNGE or EXISTS like anyone else's change. One
   * UID SEARCH answers that, instead of the sync re-reading every UID and flag (without CONDSTORE) for
   * a change SQLite already has. Only IDLE's EXPUNGE/EXISTS ask for it: a flag change elsewhere or a
   * poll still gets the full read. When it holds, the checkpoint is marked caught up (count, last UID)
   * but not synced_at: no flags were read, so the periodic flag refresh stays due as before.
   */
  const inboxUnchanged = async (client: ImapFlow, db: MailDatabase, accountId: string, box: MailboxRow) => {
    if (pendingCount(db, accountId) > 0) return false
    const lock = await client.getMailboxLock(box.path, { readOnly: true })
    try {
      const status = client.mailbox
      if (!status || Number(status.uidValidity) !== box.uidvalidity) return false
      const onServer = status.exists === 0 ? [] : await searchUids(client, { uid: '1:*' })
      const known = new Set(knownUids(db, box.id, Number.MAX_SAFE_INTEGER).map((k) => k.uid))
      if (onServer.length !== known.size || onServer.some((uid) => !known.has(uid))) return false
      const top = onServer.reduce((a, b) => Math.max(a, b), 0)
      db.run('UPDATE mailboxes SET last_uid = MAX(last_uid, ?1), uidnext = MAX(COALESCE(uidnext, 0), ?1 + 1), exists_count = ?2 WHERE id = ?3', [top, onServer.length, box.id])
      // Mail moved in here is linked under its real UID now, at or below the checkpoint: never new.
      forgetSettledMoves(db, accountId, box.id)
      return true
    } finally {
      lock.release()
    }
  }

  // Messages the person moved into the Inbox themselves (Move to Inbox, Undo of an archive, a Clean up
  // undone). Their new inbox UIDs aren't arrivals: they're neither announced as new mail nor put
  // through blocked senders and rules again. Kept until the move has settled into a real inbox UID.
  const movedIn = new Map<string, Set<number>>()
  /**
   * Changes the replay gave up on (refused five times, or their folder rebuilt on the server) were
   * undone locally: say so, rather than let the mail quietly jump back on the next sync.
   */
  const reportDropped = (accountId: string, result: ReplayResult) => {
    if (!result.lost.length) return
    emit({ type: 'changesDropped', accountId, changes: result.lost })
    publishSoon(accountId)
  }
  const noteMovedIn = (accountId: string, threadId: string) => {
    const ids = movedIn.get(accountId) ?? new Set<number>()
    for (const id of threadMessageIds(database(), accountId, threadId)) ids.add(id)
    movedIn.set(accountId, ids)
  }
  const arrivals = (accountId: string, ids: number[]) => {
    const moved = movedIn.get(accountId)
    return moved?.size ? ids.filter((id) => !moved.has(id)) : ids
  }
  /** Forgets moves that reached the server (or went elsewhere): only a pending placeholder link stays. */
  const forgetSettledMoves = (db: MailDatabase, accountId: string, inboxId: number) => {
    const moved = movedIn.get(accountId)
    if (!moved?.size) return
    const pending = db.prepare('SELECT 1 FROM message_mailboxes WHERE mailbox_id = ? AND message_id = ? AND uid < 0')
    for (const id of moved) if (!pending.get(inboxId, id)) moved.delete(id)
  }

  /** Conversations that gained an inbox message past this UID, other than mail moved there here. */
  const newInboxThreadIds = (db: MailDatabase, accountId: string, mailboxId: number, afterUid: number): Set<string> => {
    const rows = db
      .query('SELECT m.id, m.thread_id FROM message_mailboxes mm JOIN messages m ON m.id = mm.message_id WHERE mm.mailbox_id = ? AND mm.uid > ?')
      .all(mailboxId, afterUid) as Array<{ id: number; thread_id: string | null }>
    const arrived = new Set(arrivals(accountId, rows.map((r) => r.id)))
    return new Set(rows.filter((r) => arrived.has(r.id)).map((r) => uiThreadId(accountId, r.thread_id, r.id)))
  }

  /**
   * Blocked senders to Trash, then mail rules, against inbox mail past `afterUid`. Shared by the full
   * and inbox-only sync paths. Returns how many conversations a block or a rule queued a change for.
   */
  const applyInboxRules = (db: MailDatabase, accountId: string, inboxId: number, afterUid: number): number => {
    let ruled = 0
    const blocked = blockedSenders(db, accountId)
    if (blocked.size) {
      const fresh = new Set(arrivals(accountId, newInboxMessageIds(db, inboxId, afterUid)))
      for (const email of fresh.size ? blocked : []) {
        for (const target of scrubTargets(db, accountId, { sender: email })) {
          if (threadMessageIds(db, accountId, target.threadId).some((id) => fresh.has(id)) && queueMove(db, accountId, target.threadId, 'trash')) ruled++
        }
      }
    }
    const rules = listRules(db, accountId)
    if (rules.length) {
      const touched = applyRules(db, accountId, rules, arrivals(accountId, newInboxMessageIds(db, inboxId, afterUid)))
      ruled = [...touched.values()].reduce((a, b) => a + b, 0)
    }
    return ruled
  }

  /** New inbox mail past `afterUid`, as an `incoming` threadsChanged event (capped), or null for none. */
  const announceInboxMail = (db: MailDatabase, accountId: string, inboxId: number, afterUid: number, list: EngineEvent): EngineEvent | null => {
    if (list.type !== 'threadsChanged') return null
    const fresh = newInboxThreadIds(db, accountId, inboxId, afterUid)
    const upserts = list.upserts.filter((t) => fresh.has(t.id)).slice(0, MAX_ANNOUNCED)
    forgetSettledMoves(db, accountId, inboxId)
    return upserts.length ? { type: 'threadsChanged', accountId, upserts, incoming: true } : null
  }

  // --- Body backfill ---------------------------------------------------------------------------
  //
  // Runs of up to `bodyLimit` bodies chain on their own (a short breather apart) until nothing is
  // missing, on one kept connection. A sync or an opened conversation pauses it: during a breather or
  // while connecting that costs nothing and the connection stays, but a batch in flight gets its
  // socket closed rather than waited out. Batches are small text-only fetches, yet one can fall back to whole messages with
  // attachments (megabytes), and new mail shouldn't queue behind that bandwidth. Reconnecting after
  // such a cut is the exception; chained runs and pauses between batches no longer pay for one.
  // Bodies the server won't give (gone, unparsable) are skipped for the session after a few tries,
  // and a failing connection is retried on a backoff instead of waiting for the next sync.

  /** Accounts with bodies still to download, set by each successful sync; cleared once none are left. */
  const backfillWanted = new Set<string>()
  /** The running backfill per account — never more than one. */
  const backfills = new Map<string, AbortController>()
  /** The backfill's kept connection per account, reused across runs and between-batch pauses. */
  const backfillClients = new Map<string, ImapFlow>()
  /** The next run, waiting out a breather (chain) or a connection failure (retry). */
  const backfillTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; retry: boolean }>()
  /** Connection failures in a row per account: picks the retry wait, and only the first one is logged. */
  const backfillErrors = new Map<string, number>()
  /** Failed body fetches per message id this session; at BODY_ATTEMPTS the backfill leaves it alone. */
  const bodyFailures = new Map<number, number>()
  const BODY_ATTEMPTS = 2
  /** Conversations being opened per account; their on-demand body fetch goes first. */
  const threadLoads = new Map<string, number>()

  const dropBackfillClient = (accountId: string) => {
    const client = backfillClients.get(accountId)
    backfillClients.delete(accountId)
    client?.close()
  }
  const clearBackfillTimer = (accountId: string) => {
    const pending = backfillTimers.get(accountId)
    if (pending) clearTimeout(pending.timer)
    backfillTimers.delete(accountId)
  }

  /** One batch; whatever comes back without a body counts against those messages. */
  const fetchBatch = async (client: ImapFlow, db: MailDatabase, items: Array<{ id: number; path: string; uid: number }>, signal: AbortSignal): Promise<number> => {
    let stored = 0
    try {
      stored = await fetchBodiesOf(client, db, items, signal)
    } catch (err) {
      if (signal.aborted || !client.usable) throw err
      // The server answered but something in the batch broke it (a parse, a vanished folder): one at
      // a time, so a bad message can't sink its batch-mates.
      if (items.length > 1) {
        for (const item of items) stored += await fetchBatch(client, db, [item], signal)
        return stored
      }
    }
    if (signal.aborted) return stored
    for (const id of bodilessIds(db, items.map((item) => item.id))) bodyFailures.set(id, (bodyFailures.get(id) ?? 0) + 1)
    return stored
  }

  /**
   * One run: up to `bodyLimit` missing bodies, newest first, `backfillBatch` at a time, updating the
   * list after each batch. 'done' when nothing fetchable is left, 'more' when there may be.
   */
  const backfill = async (accountId: string, signal: AbortSignal): Promise<'done' | 'more' | 'paused'> => {
    const db = database()
    const limit = options.bodyLimit ?? 500
    if (limit <= 0) return 'done'
    let skipped = 0
    for (const n of bodyFailures.values()) if (n >= BODY_ATTEMPTS) skipped++
    // Over-ask by the skipped count so a run is never all skipped messages while fetchable ones remain.
    const pending = messagesMissingBodies(db, accountId, limit + skipped)
      .filter((m) => (bodyFailures.get(m.id) ?? 0) < BODY_ATTEMPTS)
      .slice(0, limit)
    if (!pending.length) return 'done'
    const batch = Math.max(1, options.backfillBatch ?? 25)
    let client = backfillClients.get(accountId)
    if (!client?.usable) {
      if (client) dropBackfillClient(accountId)
      client = await connect(accountId)
      if (disposed || removed.has(accountId) || offline) {
        client.close()
        return 'paused'
      }
      backfillClients.set(accountId, client)
    }
    const live = client
    let inFlight = false
    // Only a batch in flight is cut; a pause that lands anywhere else leaves the connection be.
    const cut = () => {
      if (inFlight) dropBackfillClient(accountId)
    }
    signal.addEventListener('abort', cut)
    try {
      for (let start = 0; start < pending.length; start += batch) {
        if (signal.aborted) return 'paused'
        inFlight = true
        const stored = await fetchBatch(live, db, pending.slice(start, start + batch), signal)
        inFlight = false
        if (stored) {
          invitesArrived(accountId)
          publishSoon(accountId, true)
        }
      }
      return signal.aborted ? 'paused' : 'more'
    } catch (err) {
      if (signal.aborted) return 'paused'
      dropBackfillClient(accountId)
      throw err
    } finally {
      inFlight = false
      signal.removeEventListener('abort', cut)
    }
  }

  /** Starts (or continues) an account's backfill when it's wanted and nothing else needs the account. */
  const resumeBackfill = (accountId: string) => {
    if (!backfillWanted.has(accountId) || backfills.has(accountId) || syncing.has(accountId) || threadLoads.get(accountId) || offline || disposed) return
    // A failing server gets its full wait; a chain breather can be cut short.
    if (backfillTimers.get(accountId)?.retry) return
    clearBackfillTimer(accountId)
    const abort = new AbortController()
    backfills.set(accountId, abort)
    const later = (ms: number, retry: boolean) => {
      const timer = setTimeout(() => {
        backfillTimers.delete(accountId)
        resumeBackfill(accountId)
      }, ms)
      backfillTimers.set(accountId, { timer, retry })
    }
    void backfill(accountId, abort.signal)
      .then(
        (outcome) => {
          if (outcome === 'paused') return
          backfillErrors.delete(accountId)
          if (outcome === 'more') {
            if (backfillWanted.has(accountId)) later(options.backfillPauseMs ?? 500, false)
            return
          }
          backfillWanted.delete(accountId)
          const client = backfillClients.get(accountId)
          backfillClients.delete(accountId)
          void client?.logout().catch(() => client.close())
        },
        (err) => {
          // Stopped underneath it (offline, removed, disposed): nothing went wrong worth saying.
          if (!backfillWanted.has(accountId) || disposed || offline) return
          const streak = (backfillErrors.get(accountId) ?? 0) + 1
          backfillErrors.set(accountId, streak)
          if (streak === 1) console.warn(`backfill: ${accountId}: ${(err as Error)?.message ?? err}`)
          const waits = options.backfillRetryMs ?? [30_000, 120_000]
          later(waits[Math.min(streak, waits.length) - 1] ?? 120_000, true)
        },
      )
      .finally(() => {
        backfills.delete(accountId)
        if (!disposed && accountById(accountId)) publishSoon(accountId, true)
        // A pause that has already passed (a quick sync) picks up where this run stopped.
        if (!backfillTimers.has(accountId)) resumeBackfill(accountId)
      })
  }

  /** Steps aside for a sync or an opened conversation; resumeBackfill carries on later. */
  const pauseBackfill = (accountId: string) => backfills.get(accountId)?.abort()
  /** Offline: nothing to wait for, and the connection is as good as gone. Still wanted once back. */
  const haltBackfill = (accountId: string) => {
    clearBackfillTimer(accountId)
    backfillErrors.delete(accountId)
    pauseBackfill(accountId)
    dropBackfillClient(accountId)
  }
  const stopBackfill = (accountId: string) => {
    backfillWanted.delete(accountId)
    haltBackfill(accountId)
  }

  // --- Remote Drafts ---------------------------------------------------------------------------

  /** Every copy of one draft in the server's Drafts mailbox (normally one; more after a lost APPEND reply). */
  const removeRemoteDraft = async (client: ImapFlow, path: string, messageId: string) => {
    const lock = await client.getMailboxLock(path)
    try {
      // A failed search must not read as "no copies to remove": pushDrafts' callers only clear the
      // removal (or mark the draft pushed) once this resolves without throwing, so a search failure
      // here has to fail the whole call and leave the work queued for the next sync (lume-75z.7).
      const uids = await searchUids(client, { header: { 'message-id': messageId } })
      // A refused EXPUNGE throws too: the old copy is still there, so the caller must not APPEND a new one.
      if (uids.length) await deleteMessages(client, uids.join(','))
    } finally {
      lock.release()
    }
  }

  /**
   * Mirrors drafts into the server's Drafts mailbox so other mail apps see them. Best effort: the local
   * draft is already saved, so any failure here just leaves the draft to try again on the next sync.
   */
  const pushDrafts = async (client: ImapFlow, accountId: string) => {
    const db = database()
    const account = accountById(accountId)
    const box = listMailboxes(db, accountId).find((b) => b.special_use === '\\Drafts')
    if (!account || !box) return
    for (const messageId of draftRemovals(db, accountId)) {
      try {
        await removeRemoteDraft(client, box.path, messageId)
        clearDraftRemoval(db, accountId, messageId)
      } catch {}
    }
    for (const row of dirtyDrafts(db, accountId)) {
      if (disposed) return
      try {
        const mail = JSON.parse(row.mail_json) as DraftFields
        // An untouched composer isn't worth a copy on the server.
        if (!mail.subject.trim() && !mail.body.trim() && !mail.to.length && !mail.cc.length && !mail.bcc.length) {
          markDraftPushed(db, row.id, row.updated_at)
          continue
        }
        const messageId = draftMessageId(db, row.id, newMessageId(account))
        const date = new Date(row.updated_at)
        // A reply's copy threads like the reply will, so another mail app shows it in its conversation.
        const reply = replyHeadersOf(accountId, mail)
        const outgoing = buildOutgoing(account, mail, { messageId, date, ...(reply ? { reply } : {}) })
        // A draft whose attachment can't be read can't be rendered: leave it dirty and try again later
        // rather than failing the whole sync over a mirror copy.
        if (unreadableAttachment(outgoing)) continue
        const raw = await renderRaw(outgoing)
        await removeRemoteDraft(client, box.path, messageId)
        await appendMessage(client, box.path, raw, ['\\Draft', '\\Seen'], date)
        markDraftPushed(db, row.id, row.updated_at)
      } catch {}
    }
  }

  /** Drafts are autosaved every few seconds while typing: push them once the typing has settled. */
  const draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const syncDraftsSoon = (accountId: string) => {
    const pending = draftTimers.get(accountId)
    if (pending) clearTimeout(pending)
    draftTimers.set(
      accountId,
      setTimeout(() => {
        draftTimers.delete(accountId)
        syncSoon(accountId)
      }, options.draftSyncDelayMs ?? 15_000),
    )
  }

  // --- Push ------------------------------------------------------------------------------------

  /** Debounced scope pending for each account; 'all' always wins over 'inbox' when they merge. */
  const debounceScope = new Map<string, SyncScope>()
  /** Whether everything behind an account's debounced inbox sync allows the quick check (inboxUnchanged). */
  const debounceQuick = new Map<string, boolean>()

  const scheduleSync = (accountId: string, scope: SyncScope, quick = false) => {
    if (offline || disposed) return
    debounceQuick.set(accountId, (debounces.has(accountId) ? (debounceQuick.get(accountId) ?? false) : true) && quick)
    debounceScope.set(accountId, debounceScope.get(accountId) === 'all' ? 'all' : scope)
    const pending = debounces.get(accountId)
    if (pending) clearTimeout(pending)
    debounces.set(
      accountId,
      setTimeout(() => {
        debounces.delete(accountId)
        const requested = debounceScope.get(accountId) ?? 'all'
        const checkFirst = debounceQuick.get(accountId) ?? false
        debounceScope.delete(accountId)
        debounceQuick.delete(accountId)
        void sync(accountId, false, requested, checkFirst)
      }, debounceMs),
    )
  }

  /** Changes to more than the inbox that aren't the person's own (drafts, rules, snoozes coming back…). */
  const syncSoon = (accountId: string) => scheduleSync(accountId, 'all')
  /**
   * A push notification: try the fast inbox-only path first (sync() falls back to full when it can't).
   * `quick` when all IDLE said was that messages came or went, which may be just our own change's echo.
   */
  const inboxSoon = (accountId: string, quick = false) => scheduleSync(accountId, 'inbox', quick)

  /**
   * The person's own changes (read, star, move, delete, Gmail labels) go up by themselves on the
   * command connection, instead of each asking for a full sync that reopened every folder (and, on a
   * server without CONDSTORE, re-read every UID and flag of the Inbox) and rebuilt and republished the
   * whole list. SQLite and the UI already have the change. A move is settled by the server's answer
   * (UIDPLUS COPYUID gives its new UID); only when that's missing is its target folder synced to link
   * the real copy, and a move into the Inbox that way takes an inbox sync, which also minds rules and
   * new mail arriving alongside. The server's echo over IDLE is answered by inboxUnchanged. An op that
   * failed or was dropped, or a message already gone on the server, hands over to a full sync as before.
   */
  const pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pushSoon = (accountId: string) => {
    if (offline || disposed) return
    const pending = pushTimers.get(accountId)
    if (pending) clearTimeout(pending)
    pushTimers.set(
      accountId,
      setTimeout(() => {
        pushTimers.delete(accountId)
        void pushChanges(accountId)
      }, debounceMs),
    )
  }
  const pushChanges = async (accountId: string) => {
    if (disposed || offline || !accountById(accountId)) return
    // Changes made while the last push (or a sync) was on the wire go up after it.
    if (pushing.has(accountId) || syncing.has(accountId)) return pushSoon(accountId)
    // A full sync on its way replays the queue itself.
    if (debounceScope.get(accountId) === 'all') return
    const db = database()
    let settled = true
    let inboxToSync = false
    if (pendingCount(db, accountId) > 0) {
      pushing.add(accountId)
      settled = false
      let labels = 0
      let folders = 0
      try {
        settled = await withCommand(accountId, async (client) => {
          const result = await replayPendingOps(client, db, accountId)
          reportDropped(accountId, result)
          labels = result.labels
          if (result.remaining > 0 || result.dropped > 0 || result.gone > 0) return false
          for (const box of listMailboxes(db, accountId).filter((b) => result.resync.has(b.id))) {
            if (box.special_use === '\\Inbox') inboxToSync = true
            else {
              await syncMailbox(client, db, accountId, box, { batchSize: options.batchSize })
              folders++
            }
          }
          return true
        })
      } catch (err) {
        // Whatever broke may have left the connection mid-command: the full sync starts on a fresh one.
        if (!(err instanceof ConnectFailed)) dropCommand(accountId)
      } finally {
        pushing.delete(accountId)
      }
      if (disposed || !accountById(accountId)) return
      if (labels) labelsChanged(accountId)
      if (folders) publishSoon(accountId, true)
    }
    const next = requeued.get(accountId)
    if (next && !syncing.has(accountId)) {
      requeued.delete(accountId)
      void sync(accountId, next.manual, settled ? next.scope : 'all', settled && next.quick && !inboxToSync)
    } else if (!settled) syncSoon(accountId)
    else if (inboxToSync) void sync(accountId, false, 'inbox')
  }

  const startWatching = (accountId: string) => {
    if (!watchEnabled || offline || disposed || watchers.has(accountId) || !accountById(accountId)) return
    watchers.set(
      accountId,
      watchInbox({
        connect: () => connect(accountId),
        mailbox: listMailboxes(database(), accountId).find((b) => b.special_use === '\\Inbox')?.path ?? 'INBOX',
        backoffMs: options.reconnectBackoffMs,
        onNewMail: (reason) => inboxSoon(accountId, reason === 'exists' || reason === 'expunge'),
        onFlags: (updates) => {
          const db = database()
          const inboxBox = listMailboxes(db, accountId).find((b) => b.special_use === '\\Inbox')
          if (!inboxBox) return
          // The echo of our own writes (replayPendingOps pushes FLAGS back over IDLE) lands here too,
          // and updateFlags already no-ops on messages with pending ops — so that echo costs nothing.
          if (updateFlags(db, accountId, inboxBox.id, updates) > 0) publishSoon(accountId)
        },
        onResumed: () => {
          emit({ type: 'connection', accountId, status: 'online' })
          syncSoon(accountId)
        },
        onDisconnected: (error) => emit({ type: 'connection', accountId, status: 'offline', error }),
      }),
    )
  }

  const stopWatching = (accountId: string) => {
    watchers.get(accountId)?.stop()
    watchers.delete(accountId)
    const pending = debounces.get(accountId)
    if (pending) clearTimeout(pending)
    debounces.delete(accountId)
    debounceScope.delete(accountId)
    debounceQuick.delete(accountId)
  }

  const stopWake =
    options.wake === false
      ? () => {}
      : detectWake(() => {
          // Timers slept too: fire what just came due, drop what went stale overnight.
          reminders.replan()
          if (offline) return
          for (const watcher of watchers.values()) watcher.restart()
          // Its sockets are as dead as the watchers': the next use opens fresh ones.
          for (const id of [...commands.keys(), ...opening.keys()]) dropCommand(id)
        }, options.wake ?? {})

  // --- Sending ---------------------------------------------------------------------------------

  const deliveryEvent = (
    entry: OutboxEntry,
    state: DeliveryState,
    error?: string,
    progress: Pick<OutboxEntry, 'attempts' | 'permanent' | 'retryStopped'> & { nextRetryAt: number | null; unconfirmed?: boolean } = {
      attempts: entry.attempts,
      nextRetryAt: entry.nextAttemptAt,
      permanent: entry.permanent,
      retryStopped: entry.retryStopped,
      unconfirmed: entry.unconfirmed,
    },
  ): EngineEvent =>
    entry.kind === 'reply'
      ? { type: 'replyState', accountId: entry.accountId, threadId: entry.threadId, messageId: entry.id, state, error, ...progress }
      : { type: 'outboxState', accountId: entry.accountId, threadId: entry.threadId, state, error, ...progress }

  /** One delivery pass per account at a time; a request during a pass chains after it. */
  const draining = new Map<string, Promise<void>>()
  const drain = (accountId: string) => {
    const next = (draining.get(accountId) ?? Promise.resolve()).then(() => deliverDue(accountId)).catch(() => {})
    draining.set(accountId, next)
    return next
  }

  /** An iTIP mail (invitation, cancellation, answer) into the outbox, like any message: same retries, undo and Outbox. */
  const queueItip = (account: Account, itip: invites.ItipMail, sendAt?: number) => {
    const id = `itip-${crypto.randomUUID()}`
    enqueueOutgoing(database(), { id, accountId: account.id, kind: 'message', threadId: id, mail: itip.mail, messageId: newMessageId(account), reply: itip.reply, calendar: itip.calendar, sendAt })
    if (sendAt === undefined || sendAt <= Date.now()) void drain(account.id)
    else {
      publishSoon(account.id)
      // Out when the undo window closes rather than on the scheduler's next tick.
      setTimeout(() => void drain(account.id), sendAt - Date.now() + 50)
    }
    return id
  }

  /** Stored invites not applied yet go into the calendar (calendar/invites.ts). */
  const invitesArrived = (accountId: string) => {
    if (disposed) return
    try {
      const touched = invites.applyNewInvites(database(), accountId)
      if (touched.length) calendarChanged(touched)
    } catch (err) {
      console.warn(`invites: ${(err as Error)?.message ?? err}`)
    }
  }

  const deliverDue = async (accountId: string) => {
    const account = accountById(accountId)
    if (!account || disposed) return
    const db = database()
    const due = dueOutgoing(db, accountId)
    if (due.length === 0) return

    if (offline) {
      // Due again the moment we're back online.
      for (const entry of due) {
        const error = `${account.servers.smtpHost} is unreachable`
        const nextRetryAt = Date.now()
        markFailed(db, entry.id, error, nextRetryAt, 'temporary')
        emit(deliveryEvent(entry, 'failed', error, { attempts: entry.attempts, nextRetryAt, permanent: false, retryStopped: false }))
      }
      publishSoon(accountId)
      return
    }

    let credentials
    try {
      credentials = await credentialsFor(secrets, accountId)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      for (const entry of due) {
        markFailed(db, entry.id, error, null, 'permanent')
        emit(deliveryEvent(entry, 'failed', error, { attempts: entry.attempts, nextRetryAt: null, permanent: true, retryStopped: false }))
      }
      publishSoon(accountId)
      return
    }

    const transport = createSmtpTransport(account, credentials, connectOptions)
    // The row whose body is streaming now (one message at a time), and whether all of it has gone.
    let current: { id: string; bodySent: boolean } | null = null
    watchBodySent(transport, () => {
      const streaming = current
      return streaming
        ? () => {
            streaming.bodySent = true
            markBodySent(db, streaming.id)
          }
        : null
    })
    const toFile: OutgoingMessage[] = []
    try {
      for (const entry of due) {
        if (disposed || !markSending(db, entry.id)) continue
        const sending = getOutgoing(db, entry.id) ?? entry
        emit(deliveryEvent(sending, 'sending'))
        const message = buildOutgoing(account, entry.mail, { messageId: entry.messageId, reply: entry.reply, calendar: entry.calendar })
        // An attached file the send can't read — moved, or refused by macOS privacy — won't come back
        // on a retry, and sending without it silently would be worse than not sending at all.
        const unreadable = unreadableAttachment(message)
        if (unreadable) {
          const error = unreadableAttachmentError(unreadable)
          markFailed(db, entry.id, error, null, 'permanent')
          emit(deliveryEvent(entry, 'failed', error, { attempts: sending.attempts, nextRetryAt: null, permanent: true, retryStopped: false }))
          continue
        }
        current = { id: entry.id, bodySent: false }
        try {
          await transport.sendMail(nodemailerFields(message))
          markSent(db, entry.id)
          emit(deliveryEvent(sending, 'sent'))
          toFile.push(message)
        } catch (err) {
          const failure = classifySmtpError(err)
          if (sendOutcomeUnknown(err, current.bodySent)) {
            const error = `${account.servers.smtpHost} didn't confirm it was sent (${failure.message})`
            markUnconfirmed(db, entry.id, error)
            emit(deliveryEvent(entry, 'failed', error, { attempts: sending.attempts, nextRetryAt: null, permanent: false, retryStopped: false, unconfirmed: true }))
            continue
          }
          const attempts = (getOutgoing(db, entry.id)?.attempts ?? 1)
          const retryAt = failure.permanent ? null : nextAutomaticRetryAt(attempts)
          const kind = failure.permanent ? 'permanent' : retryAt === null ? 'exhausted' : 'temporary'
          markFailed(db, entry.id, failure.message, retryAt, kind)
          const detail = kind === 'exhausted'
            ? `${account.servers.smtpHost}: ${failure.message}. Automatic retries stopped after ${attempts} attempts.`
            : failure.permanent ? failure.message : `${account.servers.smtpHost}: ${failure.message}`
          emit(deliveryEvent(entry, 'failed', detail, {
            attempts,
            nextRetryAt: retryAt,
            permanent: kind === 'permanent',
            retryStopped: kind === 'exhausted',
          }))
        }
      }
    } finally {
      transport.close()
    }

    // Outbox rows carry attempt count, next retry, and terminal failure kind. Publish even when no
    // message was sent so the restored Outbox and its reader status stay authoritative.
    publishSoon(accountId)

    if (toFile.length === 0) return
    await fileInSent(account, toFile)
  }

  /** Gmail files mail sent through its SMTP server; everyone else needs the copy appended to Sent. */
  const fileInSent = async (account: Account, messages: OutgoingMessage[]) => {
    const sent = listMailboxes(database(), account.id).find((b) => b.special_use === '\\Sent')
    if (sent && !serverFilesSentMail(account)) {
      try {
        await withConnection(account.id, async (client) => {
          for (const message of messages) await appendToSent(client, sent.path, await renderRaw(message), message.date)
        })
      } catch (err) {
        // The message went out; a missing Sent copy isn't worth failing the send over. A refused
        // APPEND lands here as well (appendToSent throws on it), so it is noted, not lost silently.
        console.warn(`sent copy: ${account.id}: ${(err as Error)?.message ?? err}`)
      }
    }
    syncSoon(account.id)
  }

  /** A reply answers the explicitly selected message; legacy callers without one use the latest. */
  /**
   * In-Reply-To and References for a message that answers a conversation (`mail.replying`). The
   * conversation can be another account's, when the reply is sent from a different From.
   */
  const replyHeadersOf = (accountId: string, mail: DraftFields) => {
    if (!mail.replying) return undefined
    const parent = replyContext(threadOwner(mail.replying.threadId) ?? accountId, mail.replying.threadId, mail.replying.messageId)
    return parent?.message_id ? { inReplyTo: parent.message_id, references: replyReferences(JSON.parse(parent.references_json) as string[], parent.message_id) } : undefined
  }
  /** The account a UI thread id (`<account>:<key>`) belongs to. */
  const threadOwner = (threadId: string) => accounts.find((a) => threadId.startsWith(`${a.id}:`))?.id
  const replyContext = (accountId: string, threadId: string, selectedMessageId?: string) => {
    if (selectedMessageId !== undefined) {
      const selectedRowId = threadMessageIds(database(), accountId, threadId).find((rowId) => `${threadId}-${rowId}` === selectedMessageId)
      if (selectedRowId == null) return null
      const selected = database().query('SELECT id, subject, message_id, references_json FROM messages WHERE account_id = ? AND id = ? LIMIT 1').get(accountId, selectedRowId) as {
        id: number
        subject: string
        message_id: string | null
        references_json: string
      } | null
      return selected ?? null
    }
    const parentId = threadMessageIds(database(), accountId, threadId).at(-1)
    if (parentId == null) return null
    return database().query('SELECT subject, message_id, references_json FROM messages WHERE id = ?').get(parentId) as {
      subject: string
      message_id: string | null
      references_json: string
    } | null
  }

  const attachmentRoot = () => join(configDir() ?? tmpdir(), 'attachments')
  const originalRoot = () => join(configDir() ?? tmpdir(), 'originals')
  const getAttachment = async (accountId: string, messageId: string, index: number): Promise<GetAttachmentResult> => {
    try {
      const target = resolveAttachmentTarget(database(), attachmentRoot(), accountId, messageId, index)
      if (!target) return { ok: false, error: 'Attachment not found' }
      if (hasReadableCachedAttachment(target)) return { ok: true, path: target.path }
      if (offline) return { ok: false, error: "You're offline" }

      const path = await withConnection(accountId, (client) => downloadAttachment(client, target))
      const current = resolveAttachmentTarget(database(), attachmentRoot(), accountId, messageId, index)
      if (!current || !sameAttachmentTarget(current, target)) {
        rmSync(target.path, { force: true })
        return { ok: false, error: 'Attachment not found' }
      }
      if (!hasReadableCachedAttachment(target)) throw new Error('Attachment download could not be verified')
      if (target.size === null) settleAttachmentSize(database(), target, statSync(path).size)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const getOriginalMessage = async (accountId: string, messageId: string): Promise<GetOriginalResult> => {
    try {
      const target = resolveOriginalTarget(database(), originalRoot(), accountId, messageId)
      if (!target) return { ok: false, error: 'Message source not found' }
      if (hasReadableOriginal(target)) return { ok: true, path: target.path, size: statSync(target.path).size }
      if (offline) return { ok: false, error: "You're offline" }
      const result = await withConnection(accountId, (client) => downloadOriginalMessage(client, target))
      const current = resolveOriginalTarget(database(), originalRoot(), accountId, messageId)
      if (!current || current.rowId !== target.rowId || current.mailbox !== target.mailbox || current.uid !== target.uid || current.uidvalidity !== target.uidvalidity || current.path !== target.path) {
        rmSync(target.path, { force: true })
        return { ok: false, error: 'Message source not found' }
      }
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Drops an account and everything kept for it. It leaves the served list first, so nothing that
   * runs afterwards (a sync already connecting, a requeued one, the scheduler) can recreate its row.
   */
  const forget = async (accountId: string) => {
    removed.add(accountId)
    accounts = accounts.filter((a) => a.id !== accountId)
    stopWatching(accountId)
    stopBackfill(accountId)
    dropCommand(accountId)
    requeued.delete(accountId)
    published.delete(accountId)
    lastSync.delete(accountId)
    lastFull.delete(accountId)
    lastReconcile.delete(accountId)
    publishedVersion.delete(accountId)
    listLimits.delete(accountId)
    snapshotCache.delete(accountId)
    const snapshotTimer = snapshotTimers.get(accountId)
    if (snapshotTimer) clearTimeout(snapshotTimer)
    snapshotTimers.delete(accountId)
    forcedSnapshots.delete(accountId)
    const draftTimer = draftTimers.get(accountId)
    if (draftTimer) clearTimeout(draftTimer)
    draftTimers.delete(accountId)
    deleteAccountData(database(), accountId)
    // Its calendars went with it, and links from notes, tasks and local events to its mail are snapshots now.
    emit({ type: 'calendarChanged' }, { type: 'notesChanged' }, { type: 'tasksChanged' })
    clearAttachmentCache(attachmentRoot(), accountId)
    clearOriginalCache(originalRoot(), accountId)
    await secrets.delete(accountId)
  }

  // Scheduler: bring snoozed conversations back and send scheduled mail when due.
  const scheduler = setInterval(() => {
    if (disposed || offline) return
    for (const account of accounts) {
      const due = takeDueSnoozes(database(), account.id)
      for (const threadId of due) {
        queueMove(database(), account.id, threadId, 'inbox')
        queueFlags(database(), account.id, threadId, { unread: true })
      }
      if (due.length) {
        publishSoon(account.id)
        syncSoon(account.id)
      }
      if (dueOutgoing(database(), account.id).length) void drain(account.id)
    }
  }, options.schedulerMs ?? 30_000)

  // Poller: the background cadence (POLL). Push being up is the watcher having its inbox selected.
  const pushUp = (accountId: string) => !!watchers.get(accountId)?.client()
  const poller = setInterval(() => {
    if (!autoSync || disposed || offline) return
    const now = Date.now()
    for (const account of accounts) {
      if (syncing.has(account.id) || debounces.has(account.id)) continue
      if (now - (lastFull.get(account.id) ?? 0) >= poll.fullMs) void sync(account.id, false, 'all')
      else if (!pushUp(account.id) && now - (lastSync.get(account.id) ?? 0) >= poll.inboxMs) void sync(account.id, false, 'inbox')
    }
  }, poll.tickMs)

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setAccounts(next) {
      accounts = next.filter((a) => !removed.has(a.id))
      const ids = new Set(next.map((a) => a.id))
      for (const id of [...watchers.keys()]) if (!ids.has(id)) stopWatching(id)
      for (const id of [...backfillWanted, ...backfills.keys(), ...backfillClients.keys()]) if (!ids.has(id)) stopBackfill(id)
      for (const id of [...commands.keys(), ...opening.keys()]) if (!ids.has(id)) dropCommand(id)
      // Publish what's already stored for accounts we haven't shown yet (offline, before first sync).
      for (const account of accounts) {
        if (published.has(account.id)) continue
        published.add(account.id)
        // The first sync of a run can skip unchanged folders like any other; a skip-nothing pass follows later.
        lastReconcile.set(account.id, Date.now())
        // Rows that reference the account (queued sends, local changes) can exist before its first sync.
        ensureAccount(database(), account.id, account.email)
        const event = snapshot(account.id)
        if (event.type === 'threadsChanged' && event.upserts.length) {
          emit(
            { type: 'labelsChanged', accountId: account.id, labels: loadLabels(database(), account.id), gmail: isGmailAccount(database(), account.id) },
            { type: 'foldersChanged', accountId: account.id, folders: loadFolders(database(), account.id) },
            { type: 'contactsChanged', accountId: account.id, contacts: loadContacts(database(), account.id) },
            event,
          )
        }
        if (!offline && dueOutgoing(database(), account.id).length) void drain(account.id)
      }
    },
    setOffline(next) {
      if (next === offline) return
      offline = next
      if (next) {
        resumeOnline = new Set(watchers.keys())
        for (const id of [...watchers.keys()]) stopWatching(id)
        for (const id of new Set([...backfills.keys(), ...backfillClients.keys(), ...backfillTimers.keys()])) haltBackfill(id)
        for (const id of [...commands.keys(), ...opening.keys()]) dropCommand(id)
      } else {
        for (const id of resumeOnline) void sync(id, false)
        resumeOnline = new Set()
        // After the syncs above have claimed their accounts: those resume backfill when they finish.
        for (const id of [...backfillWanted]) resumeBackfill(id)
        for (const account of accounts) if (dueOutgoing(database(), account.id).length) void drain(account.id)
      }
    },
    syncNow: (accountId, manual) => void sync(accountId, manual),
    setAutoSync(on) {
      autoSync = on
    },
    appActivated() {
      if (!autoSync || disposed || offline) return
      const now = Date.now()
      for (const account of accounts) if (now - (lastSync.get(account.id) ?? 0) >= poll.activatedMs) void sync(account.id, false)
    },
    snooze(accountId, threadId, until) {
      if (queueMove(database(), accountId, threadId, 'archive')) pushSoon(accountId)
      snoozeThread(database(), accountId, threadId, until)
      publishSoon(accountId)
    },
    unsnooze(accountId, threadId) {
      if (!unsnoozeThread(database(), accountId, threadId)) return
      if (queueMove(database(), accountId, threadId, 'inbox')) syncSoon(accountId)
      publishSoon(accountId)
    },

    async screenerEnabled(accountId) {
      return screenerEnabledAt(database(), accountId) !== null
    },
    async setScreener(accountId, on) {
      setScreener(database(), accountId, on)
      publishSoon(accountId)
    },
    async screenSender(accountId, email, verdict) {
      setVerdict(database(), accountId, email, verdict)
      let moved = 0
      if (verdict === 'block') {
        moved = queueMoves(database(), accountId, scrubTargets(database(), accountId, { sender: email }).map((t) => t.threadId), 'trash').length
        if (moved) syncSoon(accountId)
      }
      publishSoon(accountId)
      return moved
    },

    async listRules(accountId) {
      return listRules(database(), accountId)
    },
    async saveRule(accountId, rule) {
      if (isEmptyMatch(rule.match)) throw new Error('Add at least one condition')
      saveRule(database(), accountId, rule)
      return listRules(database(), accountId)
    },
    async deleteRule(accountId, id) {
      deleteRule(database(), accountId, id)
      return listRules(database(), accountId)
    },
    async countRuleMatches(accountId, match) {
      return countRuleMatches(database(), accountId, match)
    },
    async runRule(accountId, id) {
      const rule = listRules(database(), accountId).find((r) => r.id === id)
      if (!rule) return 0
      const count = applyRules(database(), accountId, [{ ...rule, enabled: true }], null).get(id) ?? 0
      if (count) {
        publishSoon(accountId)
        syncSoon(accountId)
      }
      return count
    },

    async search(accountId, query) {
      const account = accountById(accountId)
      return searchThreads(database(), accountId, query, account ? { account: { name: account.name, email: account.email, face: account.face } } : {})
    },

    async scrubStats(accountId) {
      const account = accountById(accountId)
      return account ? scrubStats(database(), accountId, account.email) : null
    },
    async scrubReport(accountId, by) {
      const account = accountById(accountId)
      return account ? scrubReport(database(), accountId, by, account.email) : []
    },
    async senderProfiles(accountId) {
      const account = accountById(accountId)
      return account ? senderProfiles(database(), accountId, account.email) : []
    },
    async senderThreads(accountId, senders) {
      return senderThreads(database(), accountId, senders)
    },
    async spamThreads(accountId) {
      return spamThreads(database(), accountId)
    },

    async scrub(accountId, selector, action, keepLatest, except) {
      const db = database()
      // Purge deletes on the server and drops the local copy: nothing to undo, so nothing is returned.
      // It erases exactly the messages the selector matches (what the report counted and the
      // confirmation said), never the rest of their conversations, and never your Sent or Drafts copies.
      if (action === 'purge') {
        const ids = scrubMessageIds(db, accountId, selector, keepLatest, new Set(except ?? []))
        if (queueDeleteMessages(db, accountId, ids, { spareOwnCopies: true })) {
          publishSoon(accountId)
          syncSoon(accountId)
        }
        return []
      }
      const targets = scrubTargets(db, accountId, selector, keepLatest, new Set(except ?? []))
      // One transaction for the lot: a clean-up can queue thousands of moves.
      const moved = new Set(queueMoves(db, accountId, targets.map((t) => t.threadId), action))
      const moves: ScrubMove[] = targets.filter((t) => moved.has(t.threadId)).map((t) => ({ threadId: t.threadId, back: t.inInbox ? 'inbox' : 'archive' }))
      if (moves.length) {
        publishSoon(accountId)
        syncSoon(accountId)
      }
      return moves
    },

    unscrub(accountId, moves) {
      const db = database()
      db.transaction(() => {
        for (const back of new Set(moves.map((m) => m.back))) {
          const moved = queueMoves(db, accountId, moves.filter((m) => m.back === back).map((m) => m.threadId), back)
          if (back === 'inbox') for (const threadId of moved) noteMovedIn(accountId, threadId)
        }
      })()
      publishSoon(accountId)
      syncSoon(accountId)
    },

    async unsubscribe(accountId, sender) {
      let options = unsubscribeOptions(database(), accountId, sender)
      if (!options && !offline) {
        // Mail synced before Jefi kept this header: read it from the sender's newest message.
        const latest = database()
          .query(
            `SELECT m.id, mb.path, mm.uid FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id JOIN mailboxes mb ON mb.id = mm.mailbox_id
              WHERE m.account_id = ? AND lower(m.from_email) = ? AND mm.uid > 0 ORDER BY m.date DESC LIMIT 1`,
          )
          .get(accountId, sender.toLowerCase()) as { id: number; path: string; uid: number } | null
        if (latest) {
          try {
            await withConnection(accountId, async (client) => {
              const lock = await client.getMailboxLock(latest.path, { readOnly: true })
              try {
                const message = await client.fetchOne(String(latest.uid), { headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true })
                const headers = message && message.headers ? message.headers.toString('utf8') : ''
                const value = headerValue(headers, 'list-unsubscribe')
                if (value) {
                  const post = /one-click/i.test(headerValue(headers, 'list-unsubscribe-post') ?? '')
                  database().run('UPDATE messages SET list_unsubscribe = ?, list_unsubscribe_post = ? WHERE id = ?', [value, post ? 1 : 0, latest.id])
                  options = parseUnsubscribe(value, post)
                }
              } finally {
                lock.release()
              }
            })
          } catch {
            // Fall through to "no unsubscribe offered".
          }
        }
      }
      if (!options) return { ok: false, error: "This sender doesn't offer an unsubscribe link" }
      if (options.oneClick) {
        try {
          const response = await fetch(options.oneClick, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
            redirect: 'follow',
            // A sender's server that never answers mustn't leave Unsubscribe spinning.
            signal: AbortSignal.timeout(15_000),
          })
          if (response.ok) return { ok: true, done: true }
        } catch {
          // Try the other ways below.
        }
      }
      if (options.mailto) return { ok: true, done: false, mailto: options.mailto }
      if (options.link) return { ok: true, done: false, link: options.link }
      return { ok: false, error: "Couldn't reach the sender's unsubscribe page" }
    },

    getAttachment,
    getOriginalMessage,

    async openAttachment(accountId, messageId, index) {
      const result = await getAttachment(accountId, messageId, index)
      if (!result.ok) return result
      try {
        ;(options.openFile ?? openFile)(result.path)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async loadView(accountId, view, page) {
      const account = accountById(accountId)
      return loadView(database(), accountId, view, { ...page, ...(account ? { account: { name: account.name, email: account.email, face: account.face } } : {}) })
    },

    async unreadAcrossAccounts(limit) {
      return unreadAcrossAccounts(database(), accounts, Math.min(Math.max(1, Math.floor(limit)), 100))
    },

    loadMore(accountId) {
      listLimits.set(accountId, (listLimits.get(accountId) ?? LIST_PAGE) + LIST_PAGE)
      // Someone asked for this: publish at once, and regardless of the fingerprint (nothing changed
      // in the database, only how much of it the list is allowed to show).
      publishNow(accountId)
    },

    async loadThread(accountId, threadId) {
      const account = accountById(accountId)
      const options = account ? { account: { name: account.name, email: account.email, face: account.face } } : {}
      const thread = loadThread(database(), accountId, threadId, options)
      if (!thread?.messages.some((m) => m.bodyMissing)) return thread
      // The background backfill hasn't reached this conversation yet; fetch its bodies now that it's open.
      const missing = messagesMissingBodies(database(), accountId, 100, threadId.replace(`${accountId}:`, ''))
      if (offline || !missing.length) return unreachable(thread)
      // Someone is waiting on this one: the background backfill steps aside until it's in.
      threadLoads.set(accountId, (threadLoads.get(accountId) ?? 0) + 1)
      pauseBackfill(accountId)
      try {
        await withConnection(accountId, (client) => fetchBodiesOf(client, database(), missing))
        invitesArrived(accountId)
      } catch {
        return unreachable(thread)
      } finally {
        const loads = (threadLoads.get(accountId) ?? 1) - 1
        if (loads) threadLoads.set(accountId, loads)
        else threadLoads.delete(accountId)
        resumeBackfill(accountId)
      }
      const loaded = loadThread(database(), accountId, threadId, options)
      return loaded && unreachable(loaded)
    },

    async checkConnection(account, secret) {
      let credentials
      try {
        credentials = await credentialsFromSecret(secret)
      } catch (err) {
        // Refreshing a browser sign-in failed before any server was tried: report it as a sign-in
        // problem (the wizard sends the person back to sign in), in words rather than a fetch error.
        const message = err instanceof OAuthError ? err.message : 'Couldn’t finish signing in — sign in again'
        const failed = { ok: false as const, kind: 'auth' as const, message }
        return { imap: failed, smtp: failed }
      }
      return checkAccount(account, credentials, connectOptions)
    },
    async signIn(provider, loginHint) {
      signInAbort?.abort()
      const abort = (signInAbort = new AbortController())
      try {
        const tokens = await signIn(provider, { loginHint, signal: abort.signal, openUrl: (url) => emit({ type: 'signInPage', url }) })
        return { email: tokens.email, secret: oauthSecret(provider, tokens) }
      } finally {
        if (signInAbort === abort) {
          signInAbort = null
          emit({ type: 'signInPage', url: null })
        }
      }
    },
    cancelSignIn: () => signInAbort?.abort(),
    setSecret: (accountId, secret) => secrets.set(accountId, secret),
    forgetAccount: forget,
    async purgeAccountsExcept(keep) {
      // An empty list is what a failed load looks like, never a reason to delete everything.
      if (!keep.length) return []
      const kept = new Set([...keep, ...accounts.map((a) => a.id)])
      const orphans = storedAccountIds(database()).filter((id) => !kept.has(id))
      for (const id of orphans) await forget(id).catch((err) => console.warn(`purge: ${id}: ${(err as Error)?.message ?? err}`))
      return orphans
    },

    send(accountId, threadId, mail, sendAt) {
      const account = accountById(accountId)
      if (!account) return
      // A reply sent later, or from a reopened draft, still carries In-Reply-To and References.
      const reply = replyHeadersOf(accountId, mail)
      enqueueOutgoing(database(), { id: threadId, accountId, kind: 'message', threadId, mail, messageId: newMessageId(account), sendAt, reply })
      // Sending a draft consumes it; the outbox snapshot is what gets delivered now. A draft saved
      // under another account (its From changed) has a server copy there to take away.
      const draftOwner = draftAccountOf(database(), threadId)
      deleteDraftRow(database(), threadId)
      if (draftOwner && draftOwner !== accountId) syncDraftsSoon(draftOwner)
      void drain(accountId)
    },
    sendReply(accountId, threadId, messageId, reply, sendAt) {
      const account = accountById(accountId)
      if (!account) return
      const parent = replyContext(accountId, threadId, reply.parentMessageId)
      if (reply.parentMessageId !== undefined && !parent) {
        emit({ type: 'replyState', accountId, threadId, messageId, state: 'failed', error: 'The selected message is no longer available' })
        return
      }
      const references = parent?.message_id ? replyReferences(JSON.parse(parent.references_json) as string[], parent.message_id) : undefined
      enqueueOutgoing(database(), {
        id: messageId,
        accountId,
        kind: 'reply',
        threadId,
        mail: { to: reply.to, cc: reply.cc, bcc: reply.bcc ?? [], subject: reply.subject?.trim() || replySubject(parent?.subject ?? ''), body: reply.body, attachments: reply.attachments },
        messageId: newMessageId(account),
        reply: parent?.message_id && references ? { inReplyTo: parent.message_id, references } : undefined,
        sendAt,
      })
      if (sendAt === undefined || sendAt <= Date.now()) void drain(accountId)
      else {
        publishSoon(accountId)
        // Out when the undo window closes rather than on the scheduler's next tick.
        setTimeout(() => void drain(accountId), sendAt - Date.now() + 50)
      }
    },
    retry(accountId, threadId, messageId) {
      // A reply shown inside its conversation supplies both ids and must still belong to that
      // parent. A standalone Outbox fallback supplies only its authorized queue-row id.
      if (requeue(database(), accountId, messageId ?? threadId, messageId === undefined ? undefined : threadId)) {
        publishSoon(accountId)
        void drain(accountId)
      }
    },
    confirmSent(accountId, threadId, messageId) {
      const account = accountById(accountId)
      const entry = account && markConfirmedSent(database(), accountId, messageId ?? threadId, messageId === undefined ? undefined : threadId)
      if (!account || !entry) return
      emit(deliveryEvent(entry, 'sent'))
      publishSoon(accountId)
      // It went out, so it belongs in Sent like any other message.
      void fileInSent(account, [buildOutgoing(account, entry.mail, { messageId: entry.messageId, reply: entry.reply, calendar: entry.calendar })])
    },
    cancelSend: async (accountId, threadId) => cancelOutgoing(database(), accountId, threadId),

    // Applied to SQLite now and queued for the server; pushChanges sends the queue soon after.
    setFlags(accountId, threadId, flags) {
      if (queueFlags(database(), accountId, threadId, flags)) pushSoon(accountId)
    },
    move(accountId, threadId, folder) {
      // Moving a snoozed conversation anywhere (Unsnooze, archive, delete) ends the snooze: left in
      // place, the next publish would put it back under Snoozed and the scheduler would return it later.
      const unsnoozed = unsnoozeThread(database(), accountId, threadId)
      if (queueMove(database(), accountId, threadId, folder)) {
        if (folder === 'inbox') noteMovedIn(accountId, threadId)
        pushSoon(accountId)
      }
      if (unsnoozed) publishSoon(accountId)
    },
    deleteForever(accountId, threadId) {
      unsnoozeThread(database(), accountId, threadId)
      // A draft is deleted here (its server copy, if any, goes on the next sync); anything else is a queued server delete.
      if (deleteDraftRow(database(), threadId)) {
        publishSoon(accountId)
        syncDraftsSoon(accountId)
      } else if (queueDelete(database(), accountId, threadId)) pushSoon(accountId)
    },
    saveDraft(accountId, threadId, mail) {
      // Its From changed: it leaves the other account's Drafts (and server) for this one's.
      const before = draftAccountOf(database(), threadId)
      if (before && before !== accountId) {
        deleteDraftRow(database(), threadId)
        publishSoon(before)
        syncDraftsSoon(before)
      }
      saveDraftRow(database(), accountId, threadId, mail)
      publishSoon(accountId)
      syncDraftsSoon(accountId)
    },
    // Gmail labels go to the server (X-GM-LABELS); Jefi's own labels stay local.
    setLabels(accountId, threadId, labels) {
      const local = setThreadLocalLabels(database(), accountId, threadId, labels)
      if (queueLabels(database(), accountId, threadId, labels)) pushSoon(accountId)
      else if (local) publishSoon(accountId)
    },
    createLabel(accountId, label) {
      const account = accountById(accountId)
      if (!account) return
      ensureAccount(database(), accountId, account.email)
      if (createLocalLabel(database(), accountId, { id: label.id, name: label.label, color: label.color })) labelsChanged(accountId)
    },
    renameLabel(accountId, labelId, name) {
      if (updateLocalLabel(database(), accountId, labelId, { name })) labelsChanged(accountId)
    },
    deleteLabel(accountId, labelId) {
      if (!deleteLocalLabel(database(), accountId, labelId)) return
      labelsChanged(accountId)
      publishSoon(accountId)
    },

    // --- Calendar and notes: local data, answered from mail.db; see docs/calendar-notes-architecture.md.
    setReminderDefaults(defaults) {
      reminders.start(defaults)
    },
    async listCalendars() {
      return calendar.listCalendars(database())
    },
    async createLocalCalendar(input) {
      const created = calendar.createLocalCalendar(database(), input)
      calendarChanged([created.id])
      return created
    },
    async updateCalendar(id, patch) {
      const updated = calendar.updateCalendar(database(), id, patch)
      calendarChanged(patch.isDefault ? [] : [id])
      return updated
    },
    async deleteCalendar(id) {
      calendar.deleteCalendar(database(), id)
      calendarChanged([])
    },
    async listEvents(from, to, calendarIds) {
      return calendar.listEvents(database(), from, to, calendarIds)
    },
    async getEvent(id) {
      return calendar.getEvent(database(), id)
    },
    async eventByUid(uid, recurrenceId) {
      return calendar.eventByUid(database(), uid, recurrenceId)
    },
    async saveEvent(input, options) {
      // A move touches the calendar it left, too.
      const before = input.id ? calendar.getEvent(database(), input.id)?.calendarId : undefined
      const saved = calendar.saveEvent(database(), input, options)
      calendarChanged([...new Set([before ?? saved.calendarId, saved.calendarId])])
      return saved
    },
    async deleteEvent(id, scope, occurrenceStart) {
      const calendarId = calendar.getEvent(database(), id)?.calendarId
      const deleted = calendar.deleteEvent(database(), id, scope, occurrenceStart)
      if (deleted && calendarId) calendarChanged([calendarId])
      return deleted
    },
    async eventLinks(eventId) {
      return calendar.eventLinks(database(), eventId)
    },
    async linkEvent(eventId, target) {
      const link = calendar.linkEvent(database(), eventId, target)
      calendarChanged([calendar.getEvent(database(), eventId)!.calendarId])
      return link
    },
    async unlinkEvent(linkId) {
      const owner = calendar.eventOfLink(database(), linkId)
      const unlinked = calendar.unlinkEvent(database(), linkId)
      if (unlinked && owner) calendarChanged([owner.calendar_id])
      return unlinked
    },
    async eventsForThread(accountId, threadId) {
      return calendar.eventsForThread(database(), accountId, threadId)
    },
    async invitesForMessage(accountId, messageId) {
      return calendar.invitesForMessage(database(), accountId, messageId)
    },
    async inviteForMessage(accountId, messageId) {
      // The card may open before the next sync pass got to this message.
      invitesArrived(accountId)
      return invites.inviteView(database(), accountId, messageId)
    },
    async pendingInvites(now) {
      return invites.pendingInvites(database(), now)
    },
    async respondToInvite(accountId, messageId, response, comment, options) {
      const account = accountById(accountId)
      if (!account) throw new Error('That account isn’t signed in')
      const { event, mail } = invites.respondToInvite(database(), accountId, messageId, response, { name: account.name, email: account.email }, comment)
      calendarChanged([event.calendarId])
      const outboxId = mail ? queueItip(account, mail, options?.sendAt) : null
      return { event, outboxId }
    },
    async sendEventInvites(eventId, kind, options) {
      const accountId = calendar.getEvent(database(), eventId)?.accountId
      const account = accountId ? accountById(accountId) : undefined
      if (!account) throw new Error('Choose the account this event is sent from')
      const { event, mail } = invites.eventInvites(database(), eventId, kind, { name: account.name, email: account.email })
      calendarChanged([event.calendarId])
      return { outboxId: queueItip(account, mail, options?.sendAt), recipients: mail.mail.to }
    },

    async listNotes(query) {
      return notes.listNotes(database(), query)
    },
    async getNote(id) {
      return notes.getNote(database(), id)
    },
    async saveNote(input) {
      const saved = notes.saveNote(database(), input)
      notesChanged([saved.id])
      return saved
    },
    async deleteNote(id) {
      const deleted = notes.deleteNote(database(), id)
      if (deleted) notesChanged([id])
      return deleted
    },
    async linkNote(noteId, target) {
      const link = notes.linkNote(database(), noteId, target)
      notesChanged([noteId])
      return link
    },
    async unlinkNote(linkId) {
      const row = database().query('SELECT note_id FROM note_links WHERE id = ?').get(linkId) as { note_id: string } | null
      const unlinked = notes.unlinkNote(database(), linkId)
      if (unlinked && row) notesChanged([row.note_id])
      return unlinked
    },
    async notesForThread(accountId, threadId) {
      return notes.notesForThread(database(), accountId, threadId)
    },
    async notesForEvent(eventId) {
      return notes.notesForEvent(database(), eventId)
    },

    async listTasks(query) {
      return tasks.listTasks(database(), query)
    },
    async getTask(id) {
      return tasks.getTask(database(), id)
    },
    async saveTask(input) {
      const saved = tasks.saveTask(database(), input)
      tasksChanged([saved.id])
      return saved
    },
    async setTaskDone(id, done) {
      const task = tasks.setTaskDone(database(), id, done)
      tasksChanged([id])
      return task
    },
    async deleteTask(id) {
      const deleted = tasks.deleteTask(database(), id)
      if (deleted) tasksChanged([id])
      return deleted
    },
    async linkTask(taskId, target) {
      const link = tasks.linkTask(database(), taskId, target)
      tasksChanged([taskId])
      return link
    },
    async unlinkTask(linkId) {
      const taskId = tasks.taskOfLink(database(), linkId)
      const unlinked = tasks.unlinkTask(database(), linkId)
      if (unlinked && taskId) tasksChanged([taskId])
      return unlinked
    },
    async tasksForThread(accountId, threadId) {
      return tasks.tasksForThread(database(), accountId, threadId)
    },
    async listTaskProjects() {
      return tasks.listTaskProjects(database())
    },
    async saveTaskProject(input) {
      const saved = tasks.saveTaskProject(database(), input)
      emit({ type: 'tasksChanged' })
      return saved
    },
    async deleteTaskProject(id) {
      const deleted = tasks.deleteTaskProject(database(), id)
      if (deleted) emit({ type: 'tasksChanged' })
      return deleted
    },
    async listTaskLabels() {
      return tasks.listTaskLabels(database())
    },
    async saveTaskLabel(input) {
      const saved = tasks.saveTaskLabel(database(), input)
      emit({ type: 'tasksChanged' })
      return saved
    },
    async deleteTaskLabel(id) {
      const deleted = tasks.deleteTaskLabel(database(), id)
      if (deleted) emit({ type: 'tasksChanged' })
      return deleted
    },

    dispose() {
      disposed = true
      reminders.stop()
      clearInterval(scheduler)
      clearInterval(poller)
      stopWake()
      for (const id of [...watchers.keys()]) stopWatching(id)
      for (const id of new Set([...backfillWanted, ...backfills.keys(), ...backfillClients.keys(), ...backfillTimers.keys()])) stopBackfill(id)
      backfillWanted.clear()
      for (const id of [...commands.keys(), ...opening.keys()]) dropCommand(id)
      for (const timer of snapshotTimers.values()) clearTimeout(timer)
      snapshotTimers.clear()
      for (const timer of draftTimers.values()) clearTimeout(timer)
      draftTimers.clear()
      for (const timer of pushTimers.values()) clearTimeout(timer)
      pushTimers.clear()
      listeners.clear()
      // Close only a database this engine opened; an injected one belongs to the caller.
      if (!options.database) db?.close()
      db = null
    },
  }
}

/**
 * Messages still without a body after trying the server get a clear note instead of a blank. The
 * flag is dropped with it: the reader shows a skeleton while a body is on its way, and waiting
 * forever would be a worse lie than saying the download failed.
 */
function unreachable(thread: MailThread): MailThread {
  return {
    ...thread,
    messages: thread.messages.map(({ bodyMissing, ...m }) =>
      bodyMissing ? { ...m, paragraphs: [...m.paragraphs, "Couldn't download the rest of this message. Check your connection and open it again."] } : { ...m, bodyMissing },
    ),
  }
}

/** Hands a downloaded file to macOS, which opens it in the person's default app for that type. */
const openFile = (path: string) => void Bun.spawn(['open', path], { stdout: 'ignore', stderr: 'ignore' })
