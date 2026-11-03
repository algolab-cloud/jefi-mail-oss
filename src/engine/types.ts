import type { Account } from '../accounts'
import type { ConnectionReport } from './connection'
import type { OAuthProviderId } from './oauth'
import type { ScrubGroup, ScrubGroupBy, ScrubSelector, ScrubStats } from './scrub'
import type { MailRule } from './rules'
import type { Contact, DraftFields, FolderId, Label, MailFolder, MailThread } from '../data'
import type { MailboxView } from '../view'
import type { UnreadThread, ViewCursor, ViewPage } from './threads'
import type {
  Calendar,
  CalendarEvent,
  CalendarPatch,
  EventInput,
  EventLink,
  EventOccurrence,
  Invite,
  InviteResponse,
  InviteSummary,
  InviteView,
  LinkTarget,
  MailLinkTarget,
  Note,
  NoteInput,
  NoteLink,
  Reminder,
  ReminderDefaults,
  SaveEventOptions,
  SeriesScope,
  Task,
  TaskInput,
  TaskLabel,
  TaskLink,
  TaskProject,
  TaskQuery,
} from './calendar/types'

export type { UnreadThread, ViewChanges, ViewCursor, ViewPage } from './threads'
export type * from './calendar/types'

// ---------------------------------------------------------------------------
// The contract between the UI store and a mail engine. The store keeps UI state, optimistic
// updates, the undo-send window and toasts; the engine owns the network: sync, SMTP delivery,
// retries and incoming mail. Commands are fire-and-forget (or resolve with a result); everything
// the engine learns comes back as events, delivered in batches so bursts cost one render.
// ---------------------------------------------------------------------------

export type SyncState = {
  status: 'idle' | 'syncing' | 'error'
  /** Folder currently being fetched. */
  phase?: string
  done: number
  total: number
  lastSyncedAt?: number
  error?: string
}

export type ReplyFields = {
  body: string
  to: string[]
  cc: string[]
  bcc?: string[]
  /** The full composer's subject; the inline reply leaves it out and answers with Re: the parent's. */
  subject?: string
  /** Stable UI `Message.id` of the message explicitly selected for Reply/Reply all. */
  parentMessageId?: string
  attachments?: DraftFields['attachments']
}

export type DeliveryState = 'sending' | 'sent' | 'failed'
export type DeliveryProgress = {
  attempts?: number
  nextRetryAt?: number | null
  permanent?: boolean
  retryStopped?: boolean
  /** The server may have accepted it (no reply after the body went out): never retried automatically. */
  unconfirmed?: boolean
}

export type GetAttachmentResult = { ok: true; path: string } | { ok: false; error: string }
export type GetOriginalResult = { ok: true; path: string; size: number } | { ok: false; error: string }

export type EngineEvent =
  /** `manual` echoes the syncNow call, so the UI reports outcomes only for syncs someone asked for. */
  | { type: 'syncState'; accountId: string; manual: boolean; state: Partial<SyncState> }
  /**
   * Threads the engine learned about. `incoming` marks new mail worth announcing. `replaceAll` means
   * `upserts` is the engine's complete list for the account, replacing whatever it published before;
   * `hasMore` then says whether older conversations are stored that this list leaves out (loadMore).
   */
  /** `inboxUnread` (complete lists only): unread Inbox conversations in the whole account, not just the window. */
  | { type: 'threadsChanged'; accountId: string; upserts: MailThread[]; removed?: string[]; incoming?: boolean; replaceAll?: boolean; hasMore?: boolean; inboxUnread?: number }
  | ({ type: 'outboxState'; accountId: string; threadId: string; state: DeliveryState; error?: string } & DeliveryProgress)
  | ({ type: 'replyState'; accountId: string; threadId: string; messageId: string; state: DeliveryState; error?: string } & DeliveryProgress)
  /** `needsSignIn`: the server rejected the credentials (or they're gone): only signing in again helps. */
  | { type: 'connection'; accountId: string; status: 'online' | 'offline' | 'error'; error?: string; needsSignIn?: boolean }
  /** The account's server-side labels (Gmail), replacing any published before. */
  /** `gmail`: labels are the server's (Gmail); a label made in Jefi becomes one of them. */
  | { type: 'labelsChanged'; accountId: string; labels: Label[]; gmail?: boolean }
  /** The account's plain IMAP folders (non-Gmail), replacing any published before. */
  | { type: 'foldersChanged'; accountId: string; folders: MailFolder[] }
  /** People this account corresponds with, for recipient suggestions and @mentions. */
  | { type: 'contactsChanged'; accountId: string; contacts: Contact[] }
  /** Show the provider's sign-in page (the UI hosts it in its own window); `url: null` closes it. */
  | { type: 'signInPage'; accountId?: undefined; url: string | null }
  /**
   * Calendars or events changed (a save, a delete, a provider sync, an account removed). Refetch
   * listCalendars and any listed range. `calendarIds` names the calendars touched, when known.
   */
  | { type: 'calendarChanged'; accountId?: undefined; calendarIds?: string[] }
  /** Notes or their links changed; `noteIds` names them when known. Refetch what's on screen. */
  | { type: 'notesChanged'; accountId?: undefined; noteIds?: string[] }
  /** Tasks or their links changed; `taskIds` names them when known. Refetch what's on screen. */
  | { type: 'tasksChanged'; accountId?: undefined; taskIds?: string[] }
  /** An event's alert is due (calendar/reminders.ts): shown once, while fresh. */
  | { type: 'reminderDue'; accountId?: undefined; reminder: Reminder }

export type EngineListener = (events: EngineEvent[]) => void

export interface MailEngine {
  subscribe(listener: EngineListener): () => void
  /** The accounts the engine should serve; called whenever the list changes. */
  setAccounts(accounts: Account[]): void
  /** Sign in to IMAP and SMTP with these settings without saving anything. */
  checkConnection(account: Account, secret: string): Promise<ConnectionReport>
  /**
   * Browser sign-in for providers that don't accept passwords (Microsoft 365, Gmail).
   * Returns the address it signed in as and the secret to hand to addAccount.
   */
  signIn(provider: OAuthProviderId, loginHint?: string): Promise<{ email?: string; secret: string }>
  /** The person closed the sign-in window: abandon the sign-in in progress. */
  cancelSignIn(): void
  /** Save an account's password or app password to the Keychain; an empty secret removes it. */
  setSecret(accountId: string, secret: string): Promise<void>
  /** An account was removed: drop its secret and anything queued for it. */
  forgetAccount(accountId: string): Promise<void>
  /**
   * Startup cleanup: forget every stored account not in `keep` (removed while the engine was down,
   * or whose removal never finished). An empty `keep` does nothing, and accounts being served are
   * always kept. Resolves with the ids it removed.
   */
  purgeAccountsExcept(keep: string[]): Promise<string[]>
  /** Work offline: pause sync and sending until turned back on. */
  setOffline(offline: boolean): void

  /**
   * Widen the account's list by a page of older conversations and publish it again. The wider list
   * stays: later snapshots keep showing at least as much, so scrolling never loses rows.
   */
  loadMore(accountId: string): void
  /**
   * One page of a view, counted within that view rather than the account, so a folder full of old
   * mail isn't hidden behind the newest of everything: `limit` conversations below `after` (the
   * previous page's `nextCursor`; none for the first page), newest first. Summaries only, like a
   * snapshot. `since` (a revision an earlier page reported) also returns what changed since, so a
   * list paged deep can refresh its first page and patch the rest instead of reloading it all.
   * Null when the view is local state the engine can't narrow (Snoozed, the Screener, the Outbox, a
   * label Jefi made itself): the account window (`loadMore`) already holds those.
   */
  loadView(accountId: string, view: MailboxView, page: { after?: ViewCursor | null; limit: number; since?: number }): Promise<ViewPage | null>
  /**
   * The newest unread Inbox conversations across every account served, newest first, at most
   * `limit`, each tagged with its account. Summaries only; Junk, Trash, snoozed and screened mail left out.
   */
  unreadAcrossAccounts(limit: number): Promise<UnreadThread[]>
  /** One conversation with its messages, loaded when it's opened (list snapshots omit bodies). */
  loadThread(accountId: string, threadId: string): Promise<MailThread | null>
  /** Screener: whether it's on, switching it, and deciding on a sender (block also moves their mail to Trash). */
  screenerEnabled(accountId: string): Promise<boolean>
  setScreener(accountId: string, on: boolean): Promise<void>
  screenSender(accountId: string, email: string, verdict: 'allow' | 'block'): Promise<number>
  /** Mail rules for an account, in order. */
  listRules(accountId: string): Promise<MailRule[]>
  /** Create or update a rule; returns the new list. Rejects a rule with no conditions. */
  saveRule(accountId: string, rule: MailRule): Promise<MailRule[]>
  deleteRule(accountId: string, id: string): Promise<MailRule[]>
  /** Run one rule over the Inbox now; returns how many conversations it touched. */
  runRule(accountId: string, id: string): Promise<number>
  /** Search the whole local mailbox (full text + operators); newest conversations first. */
  search(accountId: string, query: string): Promise<MailThread[]>
  /** Clean-up report: senders, newsletters, old or large mail, from the local database. */
  scrubReport(accountId: string, by: ScrubGroupBy): Promise<ScrubGroup[]>
  /** Mailbox-wide numbers for the Clean up overview. */
  scrubStats(accountId: string): Promise<ScrubStats | null>
  /** Move every conversation a group covers (minus the newest `keepLatest`); returns what moved, for Undo. */
  /**
   * Clears mail in bulk: 'archive' and 'trash' move it (and can be undone), 'purge' erases it on the
   * server, which cannot. Returns what moved; purging returns nothing, because there is no way back.
   */
  scrub(accountId: string, selector: ScrubSelector, action: 'archive' | 'trash' | 'purge', keepLatest: number): Promise<ScrubMove[]>
  /** Put scrubbed conversations back where they were. */
  unscrub(accountId: string, moves: ScrubMove[]): void
  /** Leave a mailing list: one-click POST when offered; otherwise a mailto or web link for the UI. */
  unsubscribe(accountId: string, sender: string): Promise<{ ok: true; done: boolean; mailto?: string; link?: string } | { ok: false; error: string }>
  /** Download a message's attachment (its index in the reader's list) and open it with the system app. */
  openAttachment(accountId: string, messageId: string, index: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** Return a local attachment path, downloading it on a cache miss. Never opens the file. */
  getAttachment(accountId: string, messageId: string, index: number): Promise<GetAttachmentResult>
  /** Return the exact RFC 822 source in a bounded local cache. Never opens or exports it. */
  getOriginalMessage(accountId: string, messageId: string): Promise<GetOriginalResult>

  /** Fetch now. `manual` marks a sync the person asked for, which reports its outcome. */
  syncNow(accountId: string, manual: boolean): void
  /**
   * Let the engine keep accounts current on its own (off until the UI is ready for mail): a cheap
   * full sync every couple of minutes, and the inbox every 30s while push is down.
   */
  setAutoSync(on: boolean): void
  /** The app came to the front: sync accounts whose last sync is more than a moment old. */
  appActivated(): void

  /** Hand a message to SMTP (after the UI's undo window). Failures stay queued and retry on sync. */
  /** `sendAt` (epoch ms) schedules it: send later. */
  send(accountId: string, threadId: string, mail: DraftFields, sendAt?: number): void
  /** Archive a conversation until `until`, then return it to the Inbox unread. */
  snooze(accountId: string, threadId: string, until: number): void
  unsnooze(accountId: string, threadId: string): void
  /** Drop a queued or failed message. Resolves false once transmission has started. */
  cancelSend(accountId: string, threadId: string): Promise<boolean>
  /** `sendAt` (epoch ms) holds the reply in the outbox until then: the undo-send window. */
  sendReply(accountId: string, threadId: string, messageId: string, reply: ReplyFields, sendAt?: number): void
  /** Retry a failed message or reply the engine still holds. */
  retry(accountId: string, threadId: string, messageId?: string): void
  /** The person says an unconfirmed message or reply did go out: it leaves the Outbox for Sent. */
  confirmSent(accountId: string, threadId: string, messageId?: string): void

  setFlags(accountId: string, threadId: string, flags: { unread?: boolean; starred?: boolean }): void
  move(accountId: string, threadId: string, folder: FolderId): void
  /** A conversation's labels, exactly: Gmail ids go to the server, Jefi's own (lb:) stay on this Mac. */
  setLabels(accountId: string, threadId: string, labels: string[]): void
  /**
   * Jefi's own labels (local-labels.ts), for accounts without server labels. `label.id` is chosen by
   * the UI (see localLabelId) so it can use the label at once. Each emits labelsChanged.
   */
  createLabel(accountId: string, label: Label): void
  renameLabel(accountId: string, labelId: string, name: string): void
  /** Deletes the label and takes it off every conversation. */
  deleteLabel(accountId: string, labelId: string): void
  deleteForever(accountId: string, threadId: string): void
  saveDraft(accountId: string, threadId: string, mail: DraftFields): void

  // --- Calendar and notes (docs/calendar-notes-architecture.md). Writes resolve with what was
  // stored and reject with a message fit to show; each also emits calendarChanged / notesChanged.

  /**
   * The person's default alerts, for events that don't choose their own. The first call starts the
   * reminder scheduler, which then runs in the engine for as long as it lives (reminderDue events).
   */
  setReminderDefaults(defaults: ReminderDefaults): void
  /** Every calendar, local ones first. There is always at least one local calendar, and it's the default unless another is. */
  listCalendars(): Promise<Calendar[]>
  createLocalCalendar(input: { name: string; color: string }): Promise<Calendar>
  /** Name, colour, hidden, or `isDefault: true` (which takes it from the previous default). */
  updateCalendar(id: string, patch: CalendarPatch): Promise<Calendar>
  /** Deletes a calendar and its events; rejects for the last local one. */
  deleteCalendar(id: string): Promise<void>
  /** Occurrences overlapping [from, to) (epoch ms), by start; visible calendars unless `calendarIds` says. */
  listEvents(from: number, to: number, calendarIds?: string[]): Promise<EventOccurrence[]>
  getEvent(id: string): Promise<CalendarEvent | null>
  /** The event with this iCalendar UID (or its exception at `recurrenceId`), to match invite updates and replies. */
  eventByUid(uid: string, recurrenceId?: number): Promise<CalendarEvent | null>
  /** Create (no id) or update. For an occurrence of a series, `options` says which part changes. */
  saveEvent(input: EventInput, options?: SaveEventOptions): Promise<CalendarEvent>
  /** Delete an event, or part of a series: 'this' / 'following' need `occurrenceStart`. */
  deleteEvent(id: string, scope?: SeriesScope, occurrenceStart?: number): Promise<boolean>
  eventLinks(eventId: string): Promise<EventLink[]>
  linkEvent(eventId: string, target: MailLinkTarget): Promise<EventLink>
  unlinkEvent(linkId: string): Promise<boolean>
  /** Events linked to a conversation (UI thread id) or any of its messages. */
  eventsForThread(accountId: string, threadId: string): Promise<CalendarEvent[]>
  /** Raw text/calendar parts stored with a message (UI message id), for invite parsing. */
  invitesForMessage(accountId: string, messageId: string): Promise<Invite[]>
  /**
   * The invitation in a message (UI message id) for the reader's invite card: parsed, deduplicated,
   * with the calendar's event and our answer. Null when the message carries no REQUEST, CANCEL or REPLY.
   */
  inviteForMessage(accountId: string, messageId: string): Promise<InviteView | null>
  /**
   * Received invitations still waiting for our answer, soonest first (for the menu bar panel): not
   * cancelled and not over by `now`. They change with calendarChanged.
   */
  pendingInvites(now?: number): Promise<InviteSummary[]>
  /**
   * Answers an invitation: the event is added or updated with our answer (a declined one is kept but
   * hidden), and a REPLY goes to the organizer from `accountId` through the outbox. `sendAt` holds it
   * for an undo window (cancelSend(accountId, outboxId) takes it back). `outboxId` is null when the
   * invite names no organizer to answer.
   */
  respondToInvite(accountId: string, messageId: string, response: InviteResponse, comment?: string, options?: { sendAt?: number }): Promise<{ event: CalendarEvent; outboxId: string | null }>
  /**
   * For an event Jefi organizes: sends REQUEST (after creating or changing it) or CANCEL (before
   * deleting it; the event is marked cancelled) to its attendees, from the event's account.
   */
  sendEventInvites(eventId: string, kind: 'request' | 'cancel', options?: { sendAt?: number }): Promise<{ outboxId: string; recipients: string[] }>

  /** Notes, pinned first then latest edited; `query` full-text searches title and body. */
  listNotes(query?: string): Promise<Note[]>
  getNote(id: string): Promise<Note | null>
  /** Create (no id) or update; `links` are added to the note's links. */
  saveNote(input: NoteInput): Promise<Note>
  deleteNote(id: string): Promise<boolean>
  linkNote(noteId: string, target: LinkTarget): Promise<NoteLink>
  unlinkNote(linkId: string): Promise<boolean>
  /** Notes linked to a conversation (UI thread id) or any of its messages. */
  notesForThread(accountId: string, threadId: string): Promise<Note[]>
  notesForEvent(eventId: string): Promise<Note[]>

  // --- Tasks (docs/tasks-architecture.md). Writes resolve with what was stored, reject with a
  // message fit to show, and emit tasksChanged.

  /** Open tasks (by due date, none last) unless `query.status` says; `search` full-text searches title and notes. */
  listTasks(query?: TaskQuery): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  /** Create (no id) or update; undefined fields keep their value, `links` are added. */
  saveTask(input: TaskInput): Promise<Task>
  /** Complete a task, or bring a completed one back. */
  setTaskDone(id: string, done: boolean): Promise<Task>
  deleteTask(id: string): Promise<boolean>
  linkTask(taskId: string, target: LinkTarget): Promise<TaskLink>
  unlinkTask(linkId: string): Promise<boolean>
  /** Tasks linked to a conversation (UI thread id) or any of its messages, open ones first. */
  tasksForThread(accountId: string, threadId: string): Promise<Task[]>
  /** Projects and labels for tasks, by name. Deleting one keeps its tasks (without it). */
  listTaskProjects(): Promise<TaskProject[]>
  saveTaskProject(input: { id?: string; name: string; color: string }): Promise<TaskProject>
  deleteTaskProject(id: string): Promise<boolean>
  listTaskLabels(): Promise<TaskLabel[]>
  saveTaskLabel(input: { id?: string; name: string; color: string }): Promise<TaskLabel>
  deleteTaskLabel(id: string): Promise<boolean>

  dispose(): void
}

export type ScrubMove = { threadId: string; back: FolderId }
