import { Profiler, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { countCommit, countRender, renderCountsOn } from './render-counts'
import { deepEqual, keepLoadedBodies, reuseUnchanged, sameItems, shallowEqual } from './store-equality'
import { FOLDER_NAMES, mergeLabels, ruleDraftFrom, snoozeTime } from './store-pure'
import type { Attachment, DraftFields, FolderId, Label, LabelTone, MailFolder, MailThread, Message } from './data'
import { accountsToKeep, guessServers, initials, loadAccounts, saveAccounts, type Account } from './accounts'
import { plainSnippet, recipientNames } from './markdown'
import { copySignInCode, freshCode } from './sign-in-pill'
import { setContacts } from './contacts'
import { toast } from './toast'
import { useSettings } from './theme'
import type { ScrubGroup, ScrubGroupBy, ScrubStats, SenderProfile, ThreadPeek } from './engine/scrub'
import type { MailRule, RuleMatchCount } from './engine/rules'
import type { ScrubMove, UnreadThread } from './engine/types'
import { snoozeLabel } from './engine/snooze'
import { inboxUnreadCount, unreadBasis, type UnreadBasis } from './unread-count'
import { sidebarCounts, type SidebarCounts } from './sidebar-counts'
import { addToBurst, incomingThread, newMailCopy, type NewMailBurst } from './new-mail'
import { appIsActive, MAIL_IMAGE, senderImage, showNotification, subscribeEventOpens, subscribeNotificationOpens, type EventRoute } from './native/notify'
import { reminderDefaults } from './calendar/alerts'
import { announceReminder } from './calendar/reminder-banners'
import { showEvent } from './calendar/state'
import { VIEW_PAGE, createEngine, gmailLabelId, isSignInCancelled, localLabelId, oauthProviderFor, openInBrowser, type ConnectionReport, type EngineEvent, type OAuthProviderId, type ReplyFields, type SyncState } from './engine'
import type {
  Calendar,
  CalendarEvent,
  CalendarPatch,
  EventInput,
  EventLink,
  EventOccurrence,
  Invite,
  InviteResponse,
  InviteView,
  LinkTarget,
  MailLinkTarget,
  Note,
  NoteInput,
  NoteLink,
  SaveEventOptions,
  SeriesScope,
  Task,
  TaskInput,
  TaskLabel,
  TaskLink,
  TaskProject,
} from './engine'
import { LocalDataProvider, applyLocalEvent, createLocalData } from './local-data'
import { pushRecent } from './menubar-data'
import type { MailboxView } from './view'
import { EMPTY_PAGES, appendPage, firstPages, refreshPages, type ViewPages } from './view-pages'
import { closeSignInWindow, inAppSignInAvailable, openSignInWindow, signInUserAgent } from './native/oauth-window'
import { fileProblemMessage, readProblem } from './attachment-files'
import { statSync } from 'node:fs'
import { notificationRequestBelongsToAccount, resolveNotificationEvent } from './notification-routing'
import { openTask } from './tasks/open'
import { IDLE_SYNC as IDLE, IDLE_SYNC_META, REVEAL_AFTER_MS, nextSyncView, revealBackgroundSync, type SyncMeta, type SyncView } from './sync-view'

// ---------------------------------------------------------------------------
// UI mail store. Holds threads, optimistic changes, the undo-send window and toasts; the mail
// engine (src/engine) owns sync, delivery and storage, and reports back through events. Accounts
// persist in accounts.json (no secrets); mail lives in the engine's database.
// ---------------------------------------------------------------------------

export type { SyncState }
export type { SyncView }
export type ReplyInput = ReplyFields

export type BulkAction = { move: FolderId } | { unread: boolean } | { starred: boolean } | 'deleteForever'

/** Native notification activation is an external subscription; keep its lifecycle out of MailProvider. */
function useNotificationOpen(accounts: Account[], setActiveId: (id: string) => void, setOpenRequest: (id: string) => void) {
  useEffect(() => subscribeNotificationOpens(({ accountId, threadId }) => {
    // A banner can outlive an account removal. Ignore its stale route instead of persisting an
    // active account id that no longer exists.
    if (!accounts.some((account) => account.id === accountId)) return
    setActiveId(accountId)
    setOpenRequest(threadId)
  }), [accounts, setActiveId, setOpenRequest])
}


type MailStore = {
  accounts: Account[]
  /** False when no account is set up yet; the workspace isn't rendered then. */
  hasAccounts: boolean
  /**
   * The mailbox being read. With no accounts this is a placeholder that is never rendered, so
   * components can read account fields without null checks (see hasAccounts).
   */
  account: Account
  switchAccount: (id: string) => void
  /** Adds the account and hands its secret to the engine (Keychain); the secret is never kept in UI state. */
  addAccount: (account: Omit<Account, 'id' | 'face'>, secret?: string) => Account
  removeAccount: (id: string) => void
  /** Sign in to IMAP and SMTP with unsaved settings (account wizard). */
  checkConnection: (account: Omit<Account, 'id' | 'face'>, secret: string) => Promise<ConnectionReport>
  /** Browser sign-in (Microsoft); returns the secret for addAccount. */
  signIn: (provider: OAuthProviderId, loginHint?: string) => Promise<{ email?: string; secret: string }>
  /** Stops a browser sign-in that's waiting; its signIn() rejects with a cancel (isSignInCancelled). */
  cancelSignIn: () => void
  /** The server rejected this account's credentials (or they're missing): it needs signing in again. */
  needsSignInOf: (accountId: string) => boolean
  /** Sign an account in again: the browser for Gmail/Outlook; false means use Settings (password). */
  reconnect: (accountId: string) => Promise<boolean>
  makePrimary: (id: string) => void
  /** Change an account's label or colour. */
  updateAccount: (id: string, change: Pick<Account, 'label' | 'color'>) => void

  threads: MailThread[]
  /** Every account's conversations, newest first: what All Inboxes and All Starred list from. */
  allThreads: MailThread[]
  /** The conversation list on screen, so the engine can page that view rather than the account. */
  setView: (view: MailboxView) => void
  /**
   * The engine's page for the view on screen: its conversation ids newest first, or `order: null`
   * when the view is local state the engine doesn't query (the account window holds those). `view`
   * says which view it answers, as the store learns of a change a render after the list does.
   */
  viewPage: { view: MailboxView; order: string[] | null; loading: boolean; hasMore: boolean }
  /**
   * The list holds the newest conversations of the view on screen, not all of them: this says older
   * ones are stored, and `loadOlder` asks the engine for the next page of them.
   */
  hasOlder: boolean
  /** The account's list holds every conversation it has (nothing older is left out of the window). */
  listComplete: boolean
  loadOlder: () => void
  labels: Label[]
  /** The account's plain IMAP folders, for the sidebar's Folders section. */
  folders: MailFolder[]
  addLabel: (name: string) => Label | null
  /** False when the name is empty or another label has it. */
  renameLabel: (id: string, name: string) => boolean
  removeLabel: (id: string) => void

  move: (id: string, folder: FolderId) => void
  /** Screener: on/off for this account, and deciding on a first-time sender. */
  screenerOn: boolean
  setScreener: (on: boolean) => void
  screenSender: (email: string, name: string, verdict: 'allow' | 'block') => void
  /** Search the whole mailbox; results join the conversation list. Returns their ids, newest first. */
  search: (query: string) => Promise<string[]>
  /** Mail rules (engine-side), plus a draft the Rules pane opens with ("Create rule from…"). */
  listRules: () => Promise<MailRule[]>
  saveRule: (rule: MailRule) => Promise<MailRule[] | null>
  deleteRule: (id: string) => Promise<MailRule[]>
  runRule: (rule: MailRule) => Promise<void>
  /** How many Inbox conversations these conditions cover right now. */
  countRuleMatches: (match: MailRule['match']) => Promise<RuleMatchCount>
  ruleDraft: MailRule | null
  startRule: (draft: Partial<MailRule> | null) => void
  /** Mailbox clean-up (Scrub): a report, a move with Undo, and leaving mailing lists. */
  scrubReport: (by: ScrubGroupBy) => Promise<ScrubGroup[]>
  scrubStats: () => Promise<ScrubStats | null>
  /** Inbox senders for the smart clean-up; the active account unless another is named. */
  senderProfiles: (accountId?: string) => Promise<SenderProfile[]>
  /** Bulk clean-up. 'purge' erases on the server and can't be undone; the other two can. */
  /** `except`: conversations to leave where they are (ones the smart clean-up found worth keeping). */
  scrub: (group: ScrubGroup, action: 'archive' | 'trash' | 'purge', keepLatest: number, except?: string[]) => Promise<number>
  /** The newest conversations from these senders, for the smart clean-up's closer look. */
  senderThreads: (senders: string[], accountId?: string) => Promise<ThreadPeek[]>
  /** The newest conversations in Spam. */
  spamThreads: (accountId?: string) => Promise<ThreadPeek[]>
  /** Moves conversations out of Spam into the Inbox, behind one toast and one Undo. */
  notSpam: (threads: Array<Pick<ThreadPeek, 'threadId' | 'subject'>>, accountId?: string) => void
  /** Archive or trash several senders at once, behind one toast and one Undo. Returns conversations moved. */
  scrubAll: (groups: ScrubGroup[], action: 'archive' | 'trash', keepLatest: number, options?: { accountId?: string; title?: string; except?: string[] }) => Promise<number>
  unsubscribe: (group: Pick<ScrubGroup, 'detail' | 'label'>) => Promise<boolean>
  /** One action over several conversations, with a single toast (and Undo, for moves). */
  bulk: (ids: string[], action: BulkAction) => void
  toggleStar: (id: string) => void
  setUnread: (id: string, unread: boolean) => void
  toggleLabel: (id: string, labelId: string) => void
  snooze: (id: string, until: string) => void
  /** `undo`: offered on the toast (a discarded draft can be brought back by the caller). */
  deleteForever: (id: string, undo?: () => void) => void
  /**
   * Waits out the undo-send window like any message. `draftId`: the saved draft the reply was written
   * in, which sending consumes. `onUndo`: gives the text back to whoever wrote it when Undo is chosen.
   */
  /**
   * False when nothing was sent (the conversation is gone): the caller keeps the text.
   * `archive`: Send and archive. Undoing the send puts the conversation back where it was, too.
   */
  reply: (id: string, input: ReplyInput, options?: { draftId?: string; onUndo?: () => void; archive?: boolean }) => boolean
  retryReply: (threadId: string, messageId: string) => void
  /** The person says an unconfirmed reply went out. */
  confirmReplySent: (threadId: string, messageId: string) => void
  send: (mail: DraftFields, draftId?: string, sendAt?: number) => string
  retrySend: (id: string) => void
  /** The person says an unconfirmed Outbox message went out. */
  confirmSent: (id: string) => void
  cancelSend: (id: string) => void
  saveDraft: (mail: DraftFields, draftId?: string, quiet?: boolean) => string

  /** Unread conversations in each account's Inbox, by account id. */
  inboxUnread: Record<string, number>
  /** A conversation with its messages loaded (bodies included), for reading it programmatically. */
  fetchThread: (id: string) => Promise<MailThread | null>
  /** The account a conversation belongs to. */
  accountOf: (threadId: string) => Account
  sync: SyncView
  syncStateOf: (accountId: string) => SyncView
  syncNow: () => void
  offline: boolean
  setOffline: (offline: boolean) => void

  /**
   * Loads a conversation's messages (list snapshots carry summaries only). Resolves once they're in
   * the store's state, so a caller can show the conversation in the same commit as its bodies.
   */
  openThread: (id: string) => Promise<void>
  /** Show a conversation from any account: switches to its account first, then the workspace opens it. */
  showThread: (accountId: string, threadId: string) => void
  /** The newest unread Inbox conversations across every account, tagged with theirs (the Assistant's catch-up). */
  unreadAcrossAccounts: (limit: number) => Promise<UnreadThread[]>
  /** A thread a toast action asked to show; the workspace opens it and clears the request. */
  openRequest: string | null
  clearOpenRequest: () => void

  notify: (message: string, undo?: () => void) => void
  /** Get a local attachment path, downloading only on a cache miss and never opening it. */
  getAttachment: (messageId: string, index: number, attachment: Attachment) => Promise<{ ok: true; attachment: Attachment & { path: string } } | { ok: false; error: string }>
  /** Get the exact RFC 822 source for a received message without opening it. */
  getOriginalMessage: (messageId: string) => Promise<{ ok: true; path: string; size: number } | { ok: false; error: string }>
  /** Get a local attachment path, then explicitly open it with the system app. */
  openAttachment: (messageId: string, index: number, attachment: Attachment) => void

  // Calendar and notes (docs/calendar-notes-architecture.md). Read them through the hooks in
  // ./local-data, which re-render only their readers; these are the writes, plus one-off reads.
  // Writes resolve with what was stored, or null after toasting why they failed.
  createCalendar: (input: { name: string; color: string }) => Promise<Calendar | null>
  updateCalendar: (id: string, patch: CalendarPatch) => Promise<Calendar | null>
  deleteCalendar: (id: string) => Promise<boolean>
  listEvents: (from: number, to: number, calendarIds?: string[]) => Promise<EventOccurrence[]>
  getEvent: (id: string) => Promise<CalendarEvent | null>
  eventByUid: (uid: string, recurrenceId?: number) => Promise<CalendarEvent | null>
  saveEvent: (input: EventInput, options?: SaveEventOptions) => Promise<CalendarEvent | null>
  deleteEvent: (id: string, scope?: SeriesScope, occurrenceStart?: number) => Promise<boolean>
  eventLinks: (eventId: string) => Promise<EventLink[]>
  linkEvent: (eventId: string, target: MailLinkTarget) => Promise<EventLink | null>
  unlinkEvent: (linkId: string) => Promise<boolean>
  /** The text/calendar parts of a message in a conversation. */
  invitesForMessage: (threadId: string, messageId: string) => Promise<Invite[]>
  /** The message's invitation as the invite card shows it, or null. */
  inviteForMessage: (threadId: string, messageId: string) => Promise<InviteView | null>
  /** Accept / Maybe / Decline: updates the calendar and sends the organizer a reply (with Undo). */
  respondToInvite: (threadId: string, messageId: string, response: InviteResponse, comment?: string) => Promise<CalendarEvent | null>
  /** Sends invitations (or a cancellation) for an event Jefi organizes to its attendees. */
  sendEventInvites: (eventId: string, kind: 'request' | 'cancel') => Promise<boolean>
  getNote: (id: string) => Promise<Note | null>
  saveNote: (input: NoteInput) => Promise<Note | null>
  deleteNote: (id: string) => Promise<boolean>
  linkNote: (noteId: string, target: LinkTarget) => Promise<NoteLink | null>
  unlinkNote: (linkId: string) => Promise<boolean>
  getTask: (id: string) => Promise<Task | null>
  saveTask: (input: TaskInput) => Promise<Task | null>
  /** Completes a task (or brings it back); resolves with it, or null after a toast. */
  setTaskDone: (id: string, done: boolean) => Promise<Task | null>
  deleteTask: (id: string) => Promise<boolean>
  linkTask: (taskId: string, target: LinkTarget) => Promise<TaskLink | null>
  unlinkTask: (linkId: string) => Promise<boolean>
  saveTaskProject: (input: { id?: string; name: string; color: string }) => Promise<TaskProject | null>
  deleteTaskProject: (id: string) => Promise<boolean>
  saveTaskLabel: (input: { id?: string; name: string; color: string }) => Promise<TaskLabel | null>
  deleteTaskLabel: (id: string) => Promise<boolean>
  /** Link targets for a conversation or one of its messages, with the account filled in. */
  threadTarget: (threadId: string) => MailLinkTarget
  messageTarget: (threadId: string, messageId: string) => MailLinkTarget
}

/** One empty folder list, so an account without folders doesn't hand out a new array each render. */
const NO_FOLDERS: MailFolder[] = []
const MailContext = createContext<MailStore | null>(null)

/** Every render's store; `useMail()` re-renders on any change, so hot components use the hooks below. */
export function useMail(): MailStore {
  const value = useContext(MailContext)
  if (!value) throw new Error('useMail requires MailProvider')
  return value
}

type MailActions = { [K in keyof MailStore as MailStore[K] extends (...args: never[]) => unknown ? K : never]: MailStore[K] }

/**
 * The latest store, outside React state: the provider writes it each render and tells subscribers
 * after commit. `actions` are stable functions that call the latest render's closure, so holding one
 * never goes stale and never makes a memoized child render again.
 */
type MailSource = { current: MailStore; listeners: Set<() => void>; actions: MailActions }
const MailSourceContext = createContext<MailSource | null>(null)

function useSource(): MailSource {
  const source = useContext(MailSourceContext)
  if (!source) throw new Error('useMail requires MailProvider')
  return source
}

function createSource(): MailSource {
  const bound = new Map<PropertyKey, (...args: unknown[]) => unknown>()
  const source: MailSource = {
    current: null as unknown as MailStore,
    listeners: new Set(),
    actions: new Proxy({} as MailActions, {
      get: (_, key) => {
        let fn = bound.get(key)
        if (!fn) bound.set(key, (fn = (...args) => (source.current[key as keyof MailActions] as (...a: unknown[]) => unknown)(...args)))
        return fn
      },
    }),
  }
  return source
}

/**
 * Stable store actions. Only for calling: a function that *reads* state (syncStateOf, needsSignInOf,
 * accountOf) won't re-render its caller when that state changes, so select its result instead.
 */
export function useMailActions(): MailActions {
  return useSource().actions
}

/**
 * The latest store, read when called: for what an action needs at the moment it runs (a context
 * menu's "Mark all as read"), so a component needn't re-render on every publish to have it.
 */
export function useMailSnapshot(): () => MailStore {
  const source = useSource()
  return useCallback(() => source.current, [source])
}

export { shallowEqual }
export { FOLDER_NAMES, mergeLabels, ruleDraftFrom, snoozeTime }

/**
 * The unread numbers on the sidebar, the rail, the Dock and the menu bar. A context, not a selector:
 * a selector's component that isn't rendering anyway hears of a change only after the commit, so
 * reading a conversation (unread → read) redrew those numbers in a second commit, and a second
 * whole-window batch, right after the reader's. Its value keeps its identity until a number changes.
 */
export type MailCounts = { inboxUnread: Record<string, number>; sidebar: SidebarCounts }
const MailCountsContext = createContext<MailCounts | null>(null)

export function useMailCounts(): MailCounts {
  const value = useContext(MailCountsContext)
  if (!value) throw new Error('useMailCounts requires MailProvider')
  return value
}

/** Re-renders only when the selected slice changes (shallowly), not on every store change. */
export function useMailSelector<T>(selector: (store: MailStore) => T, isEqual: (a: T, b: T) => boolean = shallowEqual): T {
  const source = useSource()
  const last = useRef<{ value: T } | null>(null)
  const read = () => {
    const next = selector(source.current)
    if (last.current && isEqual(last.current.value, next)) return last.current.value
    last.current = { value: next }
    return next
  }
  const subscribe = useCallback((listener: () => void) => {
    source.listeners.add(listener)
    return () => void source.listeners.delete(listener)
  }, [source])
  return useSyncExternalStore(subscribe, read)
}


const TONES: LabelTone[] = ['purple', 'green', 'blue', 'amber', 'pink', 'teal']
/** How often to check whether Jefi came to the front: GPUIX has no app-activation event to listen to. */
const ACTIVATION_CHECK_MS = 2_000

const composedMessage = (
  id: string,
  account: Account,
  mail: { body: string; to: string[]; cc: string[]; bcc?: string[]; attachments?: DraftFields['attachments'] },
): Message => ({
  id,
  from: account.name,
  email: account.email,
  fromAddress: { name: account.name, email: account.email },
  toAddresses: mail.to.map((email) => ({ email })),
  ccAddresses: mail.cc.map((email) => ({ email })),
  replyToAddresses: [],
  to:
    [recipientNames(mail.to), mail.cc.length ? `cc ${recipientNames(mail.cc)}` : '', mail.bcc?.length ? `bcc ${recipientNames(mail.bcc)}` : '']
      .filter(Boolean)
      .join(' · ') || 'no recipients',
  face: account.face,
  time: 'Just now',
  timestamp: Date.now(),
  paragraphs: [],
  markdown: mail.body.trim() ? mail.body : '_(empty message)_',
  attachments: mail.attachments?.length ? mail.attachments : undefined,
})

const outgoingThread = (id: string, account: Account, mail: DraftFields, folder: FolderId): MailThread => ({
  id,
  sender: folder === 'drafts' ? 'Draft' : account.name,
  subject: mail.subject.trim() || '(no subject)',
  snippet: plainSnippet(mail.body) || '(no content)',
  date: 'Just now',
  group: 'Today',
  unread: false,
  starred: false,
  icons: mail.attachments?.length ? ['paperclip'] : [],
  priority: false,
  tag: FOLDER_NAMES[folder],
  face: account.face,
  folder,
  labels: [],
  folders: [],
  draft: mail,
  messages: [composedMessage(`${id}-1`, account, mail)],
})

/** Stand-in while no account exists; the workspace is replaced by the first-run screen. */
const NO_ACCOUNT: Account = { id: '', name: '', email: '', provider: 'imap', face: { letter: '?' }, servers: guessServers('') }

const quote = (subject: string) => `“${subject.length > 38 ? `${subject.slice(0, 37)}…` : subject}”`

export function MailProvider({ children }: { children: ReactNode }) {
  countRender('MailProvider')
  const [initial] = useState(loadAccounts)
  const [accounts, setAccounts] = useState<Account[]>(initial.accounts)
  const [activeId, setActiveId] = useState(initial.activeId)
  const [mailboxes, setMailboxes] = useState<Record<string, MailThread[]>>({})
  /** Accounts whose stored mail runs past what their list holds, from the last snapshot. */
  const [olderAvailable, setOlderAvailable] = useState<Record<string, boolean>>({})
  /** Each account's whole-Inbox unread count from its last complete publish (see unread-count.ts). */
  const [unreadBases, setUnreadBases] = useState<Record<string, UnreadBasis | null>>({})
  /** The view on screen, and the engine's page of it (see viewPage). */
  const [view, setView] = useState<MailboxView>('inbox')
  const [pages, setPages] = useState<Record<string, ViewPages>>({})
  /** Ids the view on screen has paged in, which a complete publish must not drop (see threadsChanged). */
  const pagedRef = useRef<{ accountId: string; ids: Set<string> }>({ accountId: '', ids: new Set() })
  /** Bumped by every complete list publish, so the view on screen is queried again alongside it. */
  const [publishes, setPublishes] = useState(0)
  /** Labels made this run, shown at once until the engine lists them (see mergeLabels). Ids carry their account. */
  const [labels, setLabels] = useState<Label[]>([])
  /** Each account's labels as the engine lists them: Gmail's, and those Jefi keeps itself (local-labels.ts). */
  const [accountLabels, setAccountLabels] = useState<Record<string, Label[]>>({})
  /** Accounts on Gmail, where a label made in Jefi is a server label rather than a local one. */
  const [gmailAccounts, setGmailAccounts] = useState<Record<string, boolean>>({})
  const [accountFolders, setAccountFolders] = useState<Record<string, MailFolder[]>>({})
  const [signInNeeded, setSignInNeeded] = useState<Record<string, boolean>>({})
  /** The rule being drafted, for the account it was started in: another account never sees it. */
  const [ruleDraftFor, setRuleDraftFor] = useState<{ accountId: string; rule: MailRule } | null>(null)
  /** Bumped when the contact list changes, so components re-render with new suggestions. */
  const [, setContactsVersion] = useState(0)
  /** Each account's contact list as last published, to tell a change from a repeat. */
  const contactsSeen = useRef(new Map<string, unknown>())
  /** The account whose contacts the suggestions hold. */
  const contactsFor = useRef<string | null>(null)
  const [syncStates, setSyncStates] = useState<Record<string, SyncView>>({})
  const [offline, setOfflineState] = useState(false)
  const [openRequest, setOpenRequest] = useState<string | null>(null)
  useNotificationOpen(accounts, setActiveId, setOpenRequest)
  const { settings } = useSettings()
  const undoSendRef = useRef(settings.undoSendSeconds)
  undoSendRef.current = settings.undoSendSeconds

  const [engine] = useState(createEngine)
  const [source] = useState(createSource)
  const [localData] = useState(() => createLocalData(engine))

  // Engine events and toast actions outlive the render that set them up, so they read live state through refs.
  const mailboxesRef = useRef(mailboxes)
  mailboxesRef.current = mailboxes
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const undoTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  /** Accounts with a page of older mail on the way, so scrolling can't queue a dozen of them. */
  const pendingOlder = useRef(new Set<string>())
  /** Conversations whose bodies are loading (see openThread). */
  const openingThreads = useRef(new Map<string, Promise<void>>())

  /**
   * Sync gating bookkeeping (see sync-view.ts): `syncRawRef` is each account's latest full engine
   * state (events only carry what changed); `syncMetaRef` is the reveal/failure state that decides
   * what's actually shown; `syncViewRef` mirrors the displayed `syncStates` so a batch with several
   * events for one account reads its own latest write instead of a stale render's closure.
   */
  const syncRawRef = useRef<Record<string, SyncState>>({})
  const syncMetaRef = useRef<Record<string, SyncMeta>>({})
  const syncViewRef = useRef<Record<string, SyncView>>({})
  const syncRevealTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => saveAccounts({ accounts, activeId }), [accounts, activeId])
  // loadAccounts moved an unreadable accounts.json aside; say where, once.
  useEffect(() => {
    if (initial.backup) toast("Couldn't read your account list", { description: `A copy was saved to ${initial.backup}` })
  }, [initial])

  const account = accounts.find((a) => a.id === activeId) ?? accounts[0] ?? NO_ACCOUNT
  const threads = useMemo(() => mailboxes[account.id] ?? [], [mailboxes, account.id])
  // Each account's list, merged by when they last moved. Accounts already removed are left out.
  const allThreads = useMemo(
    () => accounts.flatMap((a) => mailboxes[a.id] ?? []).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    [mailboxes, accounts],
  )

  const accountById = (id: string) => accountsRef.current.find((a) => a.id === id)
  const threadIn = (accountId: string, id: string) => mailboxesRef.current[accountId]?.find((t) => t.id === id)

  // A publish that changed nothing on screen (every conversation handed back as it was) leaves the
  // state alone, so it re-renders nothing and draws no frame.
  const updateThreadsFor = (accountId: string, update: (threads: MailThread[]) => MailThread[]) =>
    setMailboxes((prev) => {
      const before = prev[accountId]
      const next = update(before ?? [])
      return before && sameItems(next, before) ? prev : { ...prev, [accountId]: next }
    })

  const patchFor = (accountId: string, id: string, change: (thread: MailThread) => Partial<MailThread>) =>
    updateThreadsFor(accountId, (list) => list.map((t) => (t.id === id ? { ...t, ...change(t) } : t)))

  /**
   * The account a conversation belongs to. Synced ids start with "<accountId>:"; mail the UI made itself
   * (outbox, drafts) is found by looking; anything else belongs to the active account.
   */
  const ownerOf = (id: string) => {
    const prefix = id.slice(0, id.indexOf(':'))
    if (prefix && accountsRef.current.some((a) => a.id === prefix)) return prefix
    const holder = Object.entries(mailboxesRef.current).find(([, list]) => list.some((t) => t.id === id))
    return holder?.[0] ?? account.id
  }
  const patch = (id: string, change: (thread: MailThread) => Partial<MailThread>) => patchFor(ownerOf(id), id, change)
  /** The account a label id (`gm:<account>:…` or `lb:<account>:…`) belongs to. */
  const labelOwner = (id: string) => accountsRef.current.find((a) => id.startsWith(`gm:${a.id}:`) || id.startsWith(`lb:${a.id}:`))?.id
  const find = (id: string) => threads.find((t) => t.id === id) ?? threadIn(ownerOf(id), id)

  /** Conversations that already got a banner this run, so a resync can't repeat one. */
  const bannered = useRef(new Set<string>())
  const notificationsRef = useRef(settings.notifications)
  notificationsRef.current = settings.notifications
  const bannerOnce = (threadId: string) => {
    if (bannered.current.has(threadId)) return false
    bannered.current.add(threadId)
    // Bounded: the app can run for weeks.
    if (bannered.current.size > 500) bannered.current = new Set([...bannered.current].slice(-200))
    return true
  }

  /** The running new-mail burst per account (see new-mail.ts). */
  const bursts = useRef(new Map<string, NewMailBurst>())

  const notify: MailStore['notify'] = (message, undo) => {
    toast(message, undo ? { action: { label: 'Undo', onClick: undo } } : undefined)
  }

  const applySyncView = (accountId: string, view: SyncView) => {
    // A hidden background sync hands back the view on screen for every progress event, and a shown
    // one often repeats it: re-rendering the whole provider for those would redraw nothing.
    const prev = syncViewRef.current[accountId]
    if (prev && shallowEqual(prev, view)) return
    syncViewRef.current[accountId] = view
    setSyncStates((current) => ({ ...current, [accountId]: view }))
  }

  const clearRevealTimer = (accountId: string) => {
    const timer = syncRevealTimers.current.get(accountId)
    if (timer) clearTimeout(timer)
    syncRevealTimers.current.delete(accountId)
  }

  /** REVEAL_AFTER_MS has passed on a hidden background sync, or the person checked manually while one
   *  was already running: show it as a calm "Updating…" instead of staying invisible. A no-op once
   *  the run has already finished or already been revealed. */
  const revealAccount = (accountId: string) => {
    clearRevealTimer(accountId)
    const raw = syncRawRef.current[accountId] ?? IDLE
    const meta = syncMetaRef.current[accountId] ?? IDLE_SYNC_META
    const prevView = syncViewRef.current[accountId] ?? IDLE
    const { view, meta: nextMeta } = revealBackgroundSync(prevView, raw, meta)
    syncMetaRef.current[accountId] = nextMeta
    if (view !== prevView) applySyncView(accountId, view)
  }

  const scheduleReveal = (accountId: string) => {
    clearRevealTimer(accountId)
    syncRevealTimers.current.set(accountId, setTimeout(() => revealAccount(accountId), REVEAL_AFTER_MS))
  }

  /** Seeds an account's sync bookkeeping outside the normal event path (a freshly added account). */
  const seedSync = (accountId: string, view: SyncView) => {
    syncRawRef.current[accountId] = view
    syncMetaRef.current[accountId] = IDLE_SYNC_META
    applySyncView(accountId, view)
  }

  const forgetSync = (accountId: string) => {
    clearRevealTimer(accountId)
    delete syncRawRef.current[accountId]
    delete syncMetaRef.current[accountId]
    delete syncViewRef.current[accountId]
    setSyncStates((prev) => {
      if (!(accountId in prev)) return prev
      const next = { ...prev }
      delete next[accountId]
      return next
    })
  }

  const openThread = (accountId: string, threadId: string) => {
    if (accountId !== activeId) setActiveId(accountId)
    setOpenRequest(threadId)
  }

  // --- Engine events --------------------------------------------------------

  /** The provider's page opens in Jefi's own window where it can, else in the default browser. */
  const showSignInPage = (url: string | null) => {
    const inApp = inAppSignInAvailable && !process.env.JEFI_OAUTH_BROWSER
    if (!url) return inApp && closeSignInWindow()
    if (inApp) openSignInWindow(url, () => engine.cancelSignIn(), signInUserAgent(settings.signInUserAgent))
    else openInBrowser(url)
  }

  const handleEvents = (events: EngineEvent[]) => {
    // Accounts that announced new mail in this batch skip the "up to date" confirmation.
    const announced = new Set<string>()
    for (const event of events) {
      if (event.type === 'signInPage') {
        showSignInPage(event.url)
        continue
      }
      if (event.type === 'calendarChanged' || event.type === 'notesChanged' || event.type === 'tasksChanged') {
        applyLocalEvent(localData, event)
        continue
      }
      if (event.type === 'reminderDue') {
        announceReminder(event.reminder, openEventRoute)
        continue
      }
      const { accountId } = event
      switch (event.type) {
        case 'syncState': {
          const raw: SyncState = { ...(syncRawRef.current[accountId] ?? IDLE), ...event.state }
          syncRawRef.current[accountId] = raw
          const meta = syncMetaRef.current[accountId] ?? IDLE_SYNC_META
          const prevView = syncViewRef.current[accountId] ?? IDLE
          const result = nextSyncView(prevView, raw, meta, event.manual, Date.now())
          syncMetaRef.current[accountId] = result.meta
          applySyncView(accountId, result.view)
          if (result.reveal === 'start') scheduleReveal(accountId)
          else if (result.reveal === 'clear') clearRevealTimer(accountId)
          // Toasts follow the raw event, not the gated view: a manual sync always reports its outcome.
          if (!event.manual) break
          if (event.state.status === 'error') {
            toast.error('Sync failed', {
              id: `sync-${accountId}`,
              description: event.state.error,
              action: { label: 'Retry', onClick: () => engine.syncNow(accountId, true) },
            })
          } else if (event.state.status === 'idle' && !announced.has(accountId)) {
            toast.success(`${accountById(accountId)?.email ?? 'Mailbox'} is up to date`, { id: `sync-${accountId}` })
          }
          break
        }
        case 'threadsChanged': {
          if (event.replaceAll) {
            // The widened list has arrived (or a routine publish confirmed it): a further page may be asked for.
            pendingOlder.current.delete(accountId)
            const older = !!event.hasMore
            setOlderAvailable((prev) => (prev[accountId] === older ? prev : { ...prev, [accountId]: older }))
            // A complete list replaces what the view query added, so it is run again with this batch.
            setPublishes((n) => n + 1)
            const basis = unreadBasis(event.inboxUnread, event.upserts)
            setUnreadBases((prev) => (sameBasis(prev[accountId], basis) ? prev : { ...prev, [accountId]: basis }))
          }
          const replaced = new Set([...event.upserts.map((t) => t.id), ...(event.removed ?? [])])
          updateThreadsFor(accountId, (list) => {
            const upserts = reuseUnchanged(keepLoadedBodies(event.upserts, list), list)
            if (!event.replaceAll) return [...upserts, ...list.filter((t) => !replaced.has(t.id))]
            // Keep what only the UI knows (mail still in the outbox); drop what the engine now owns:
            // synced conversations, drafts, and local copies of delivered mail now in Sent.
            const engineOwned = (t: MailThread) => t.id.startsWith(`${accountId}:`) || t.folder === 'drafts' || (t.folder === 'sent' && !t.sendState)
            // Deeper pages of the view on screen stay: the view query patches them rather than
            // loading every page again.
            const paged = pagedRef.current.accountId === accountId ? pagedRef.current.ids : new Set<string>()
            return [...upserts, ...list.filter((t) => (!engineOwned(t) || paged.has(t.id)) && !replaced.has(t.id))]
          })
          if (!event.incoming) break
          // Screened mail waits quietly until its sender is allowed; the rest joins this account's burst.
          const incoming = event.upserts.map(incomingThread)
          const burst = addToBurst(bursts.current.get(accountId), incoming, Date.now())
          if (!burst) break
          bursts.current.set(accountId, burst)
          announced.add(accountId)
          const copy = newMailCopy(burst)
          // The menu bar's recent list takes each new conversation, banner or not.
          const at = Date.now()
          for (const t of incoming) {
            if (t.screened || !burst.threads.some((b) => b.id === t.id)) continue
            const upsert = event.upserts.find((u) => u.id === t.id)
            const code = upsert ? freshCode(upsert) : null
            pushRecent({ id: `mail:${t.id}`, kind: 'mail', title: t.sender, subtitle: t.subject, at, route: { accountId, threadId: t.id }, ...(code ? { code } : {}) })
          }
          // A sign-in code in a lone new conversation is offered right away: that's why the mail came.
          const lone = burst.threads.length === 1 ? event.upserts.find((t) => t.id === copy.threadId) : undefined
          const signInCode = lone ? freshCode(lone) : null
          // A stable id per account, so a burst updates one toast instead of stacking several.
          toast.info(copy.title, {
            id: `new-mail-${accountId}`,
            description: signInCode ? `${copy.description} · ${signInCode}` : copy.description,
            action: signInCode
              ? { label: 'Copy code', onClick: () => copySignInCode(signInCode) }
              : { label: 'View', onClick: () => openThread(accountId, copy.threadId) },
          })
          // A banner as well, but only when Jefi is behind another app: in front, the toast is enough.
          // One per event at most, and only if it brings a conversation not bannered before.
          if (notificationsRef.current && !appIsActive()) {
            const fresh = event.upserts.filter((t) => !t.screened && burst.threads.some((b) => b.id === t.id)).map((t) => bannerOnce(t.id))
            if (fresh.includes(true)) {
              // One sender's face (their newest message's), or an envelope for a burst from several.
              const newest = burst.threads.length === 1 ? event.upserts.find((t) => t.id === copy.threadId)?.messages.at(-1) : undefined
              const image = burst.threads.length === 1 ? (newest ? senderImage(newest.face, newest.email) : undefined) : MAIL_IMAGE
              showNotification({
                accountId,
                threadId: copy.threadId,
                title: burst.threads.length === 1 ? burst.threads[0]!.sender : copy.title,
                subtitle: accountById(accountId)?.email,
                body: signInCode ? `${signInCode} · ${copy.description}` : copy.description,
                image,
                ...(signInCode ? { copy: signInCode } : {}),
              })
            }
          }
          break
        }
        case 'outboxState': {
          const { threadId } = event
          const thread = threadIn(accountId, threadId)
          if (!thread) break
          const toastId = `send-${threadId}`
          const to = recipientNames(thread.draft?.to ?? []) || 'recipients'
          if (event.state === 'sending') {
            patchFor(accountId, threadId, () => ({
              sendState: 'sending',
              sendAttempts: event.attempts,
              sendError: undefined,
              sendRetryAt: undefined,
              sendPermanent: undefined,
              sendRetryStopped: undefined,
              sendUnconfirmed: undefined,
            }))
            toast.loading(`Sending to ${to}…`, { id: toastId, description: quote(thread.subject) })
          } else if (event.state === 'failed') {
            patchFor(accountId, threadId, () => ({
              sendState: 'failed',
              sendAttempts: event.attempts,
              sendError: event.error,
              sendRetryAt: event.nextRetryAt ?? undefined,
              sendPermanent: event.permanent || undefined,
              sendRetryStopped: event.retryStopped || undefined,
              sendUnconfirmed: event.unconfirmed || undefined,
            }))
            if (event.unconfirmed) {
              // Retrying could deliver it twice, so the toast offers the safe answer instead.
              toast.error(`Couldn't confirm ${quote(thread.subject)} was sent`, {
                id: toastId,
                description: `${event.error ?? 'The server didn’t reply'} · Check Sent before sending again · kept in Outbox`,
                action: { label: 'It was sent', onClick: () => engine.confirmSent(accountId, threadId) },
              })
              break
            }
            const retry = event.nextRetryAt
              ? `Automatic retry at ${new Date(event.nextRetryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : event.retryStopped ? `Automatic retries stopped after ${event.attempts ?? 0} attempts` : 'Manual retry required'
            toast.error(`Couldn't send ${quote(thread.subject)}`, {
              id: toastId,
              description: `${event.error ?? 'SMTP server is unreachable'} · ${retry} · kept in Outbox`,
              action: { label: 'Retry', onClick: () => engine.retry(accountId, threadId) },
            })
          } else {
            patchFor(accountId, threadId, () => ({
              folder: 'sent',
              sendState: undefined,
              sendAttempts: undefined,
              sendError: undefined,
              sendRetryAt: undefined,
              sendPermanent: undefined,
              sendRetryStopped: undefined,
              sendUnconfirmed: undefined,
              tag: 'Sent',
              draft: undefined,
              date: 'Just now',
            }))
            toast.success('Message sent', {
              id: toastId,
              description: `To ${to}`,
              action: { label: 'View', onClick: () => openThread(accountId, threadId) },
            })
          }
          break
        }
        case 'replyState': {
          const { threadId, messageId } = event
          const status = event.state === 'sent' ? undefined : event.state === 'failed' && event.unconfirmed ? 'unconfirmed' : event.state
          patchFor(accountId, threadId, (t) => ({ messages: t.messages.map((m) => (m.id === messageId ? { ...m, status } : m)) }))
          const fallback = threadIn(accountId, messageId)
          if (fallback?.folder === 'outbox') {
            if (event.state === 'sent') {
              updateThreadsFor(accountId, (list) => list.filter((thread) => thread.id !== messageId))
            } else {
              patchFor(accountId, messageId, () => ({
                sendState: event.state === 'sending' ? 'sending' : 'failed',
                sendAttempts: event.attempts,
                sendError: event.error,
                sendRetryAt: event.nextRetryAt ?? undefined,
                sendPermanent: event.permanent || undefined,
                sendRetryStopped: event.retryStopped || undefined,
                sendUnconfirmed: event.unconfirmed || undefined,
              }))
            }
          }
          const thread = threadIn(accountId, threadId) ?? fallback
          const description = thread ? quote(thread.subject) : undefined
          const toastId = `reply-${messageId}`
          if (event.state === 'sending') toast.loading('Sending reply…', { id: toastId, description })
          else if (event.state === 'sent') toast.success('Reply sent', { id: toastId, description })
          else if (event.unconfirmed) {
            toast.error("Couldn't confirm the reply was sent", {
              id: toastId,
              description: `${event.error ?? 'The server didn’t reply'} · Check Sent before sending again`,
              action: { label: 'It was sent', onClick: () => engine.confirmSent(accountId, threadId, messageId) },
            })
          } else {
            toast.error("Reply wasn't sent", {
              id: toastId,
              description: event.error ?? 'SMTP server is unreachable',
              action: { label: 'Retry', onClick: () => engine.retry(accountId, threadId, messageId) },
            })
          }
          break
        }
        case 'labelsChanged':
          // Every sync sends them; most syncs change none.
          setAccountLabels((prev) => (deepEqual(prev[accountId], event.labels) ? prev : { ...prev, [accountId]: event.labels }))
          if (event.gmail !== undefined) setGmailAccounts((prev) => (!!prev[accountId] === event.gmail ? prev : { ...prev, [accountId]: !!event.gmail }))
          break
        case 'foldersChanged':
          setAccountFolders((prev) => (deepEqual(prev[accountId], event.folders) ? prev : { ...prev, [accountId]: event.folders }))
          break
        case 'contactsChanged': {
          // Every sync sends them; a list like the last one changes no suggestion, unless the
          // suggestions are still another account's.
          const same = deepEqual(contactsSeen.current.get(accountId), event.contacts)
          contactsSeen.current.set(accountId, event.contacts)
          const shown = accountId === activeId
          if (same && (!shown || contactsFor.current === accountId)) break
          // Suggestions follow the account being read; the list is module state, not React state.
          if (shown) {
            setContacts(event.contacts)
            contactsFor.current = accountId
          }
          setContactsVersion((v) => v + 1)
          break
        }
        case 'connection': {
          const needs = event.status === 'error' && !!event.needsSignIn
          // Offline says nothing about the credentials: keep what we knew.
          if (event.status === 'offline') break
          setSignInNeeded((prev) => (!!prev[accountId] === needs ? prev : { ...prev, [accountId]: needs }))
          if (needs && !signInNeededRef.current[accountId]) {
            const email = accountById(accountId)?.email ?? 'An account'
            toast.error('Sign in again', {
              id: `signin-${accountId}`,
              description: `${email} was signed out`,
              action: { label: 'Sign in', onClick: () => void reconnectRef.current(accountId) },
            })
          }
          break
        }
      }
    }
  }

  const [screenerOn, setScreenerOn] = useState(false)
  useEffect(() => {
    // A late answer for the account just left must not set the switch for this one.
    let live = true
    void engine.screenerEnabled(account.id).then((on) => live && setScreenerOn(on), () => {})
    return () => {
      live = false
    }
  }, [account.id])

  const signInNeededRef = useRef(signInNeeded)
  signInNeededRef.current = signInNeeded
  const reconnect = async (accountId: string) => {
    const target = accountById(accountId)
    if (!target) return false
    const provider = target.auth === 'password' ? null : oauthProviderFor(target.provider)
    if (!provider) return false
    const id = `signin-${accountId}`
    toast.loading('Finish signing in…', { id })
    try {
      const result = await engine.signIn(provider, target.email)
      if (result.email && result.email.toLowerCase() !== target.email.toLowerCase()) {
        toast.error(`That was ${result.email}`, { id, description: `Sign in as ${target.email} to reconnect this account` })
        return true
      }
      await engine.setSecret(accountId, result.secret)
      setSignInNeeded((prev) => ({ ...prev, [accountId]: false }))
      toast.success(`${target.email} is connected again`, { id })
      engine.syncNow(accountId, true)
    } catch (err) {
      // Closing the sign-in window is a choice, not a failure.
      if (isSignInCancelled(err)) toast.dismiss(id)
      else toast.error("Couldn't sign in", { id, description: err instanceof Error ? err.message : String(err) })
    }
    return true
  }
  const reconnectRef = useRef(reconnect)
  reconnectRef.current = reconnect

  /** A reminder's banner or toast: the calendar, on that occurrence with its card open. */
  const openEventRoute = (route: EventRoute) => {
    // A task's reminder carries the task's id where an event's would be (engine reminders.ts).
    if (route.eventId.startsWith('task-')) return openTask(route.eventId)
    void resolveNotificationEvent(route, (id) => engine.getEvent(id)).then((target) => {
      if (target) showEvent(target)
      else toast.error("Couldn't open that reminder", { description: 'The event is no longer in your calendar.' })
    })
  }
  const openEventRouteRef = useRef(openEventRoute)
  openEventRouteRef.current = openEventRoute
  useEffect(() => subscribeEventOpens((route) => openEventRouteRef.current(route)), [])
  // Starts the engine's reminder scheduler, and re-plans it whenever a default changes.
  useEffect(
    () => engine.setReminderDefaults(reminderDefaults(settings.defaultAlert, settings.defaultAllDayAlert, settings.defaultTaskAlert, settings.defaultTaskAllDayAlert)),
    [engine, settings.defaultAlert, settings.defaultAllDayAlert, settings.defaultTaskAlert, settings.defaultTaskAllDayAlert],
  )

  const handleEventsRef = useRef(handleEvents)
  handleEventsRef.current = handleEvents
  useEffect(() => engine.subscribe((events) => handleEventsRef.current(events)), [engine])
  // After subscribe: an in-process engine (JEFI_ENGINE=inline) publishes stored mail from inside
  // this call, and a snapshot sent while nothing is listening is never offered again.
  useEffect(() => engine.setAccounts(accounts), [accounts])
  // Once per launch, right after the first setAccounts: drop mail kept for accounts accounts.json no
  // longer lists (removed while the engine was down, or a removal that never finished). Only against
  // a list that loaded cleanly; see accountsToKeep.
  useEffect(() => {
    const keep = accountsToKeep(initial)
    if (keep) void engine.purgeAccountsExcept(keep).catch(() => {})
  }, [engine])
  useEffect(() => () => engine.dispose(), [engine])
  // Reveal timers fire on a plain setTimeout, outside React's own cleanup; drop them with the provider.
  useEffect(
    () => () => {
      for (const timer of syncRevealTimers.current.values()) clearTimeout(timer)
      syncRevealTimers.current.clear()
    },
    [],
  )

  // The view on screen, queried on its own so an old folder isn't hidden behind the account's newest
  // mail, a keyset page at a time. The result joins the conversation list the way search results do;
  // `order` keeps it in the engine's order. A complete publish replaces the list, so it is followed
  // by a fresh first page and a patch of the deeper ones (view-pages.ts), not a reload of them all.
  const pageKey = `${account.id}\u0000${view}`
  const page = pages[pageKey]
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  pagedRef.current = { accountId: account.id, ids: new Set(page?.order ?? []) }
  const loadedKey = useRef<string | null>(null)
  const addThreads = (accountId: string, upserts: MailThread[], removed: string[] = []) => {
    if (!upserts.length && !removed.length) return
    const drop = new Set([...upserts.map((t) => t.id), ...removed])
    updateThreadsFor(accountId, (list) => [...reuseUnchanged(keepLoadedBodies(upserts, list), list), ...list.filter((t) => !drop.has(t.id))])
  }
  useEffect(() => {
    let live = true
    const accountId = account.id
    const current = pagesRef.current[pageKey]
    const fresh = loadedKey.current !== pageKey || !current?.order
    loadedKey.current = pageKey
    const load = (limit: number) =>
      engine.loadView(accountId, view, { limit }).then((result) => {
        if (!live) return
        setPages((prev) => ({ ...prev, [pageKey]: firstPages(result) }))
        if (result) addThreads(accountId, result.threads)
      })
    if (fresh) {
      // Only the view on screen is kept: another one's pages went stale when it was left.
      setPages((prev) => ({ [pageKey]: { ...(prev[pageKey] ?? EMPTY_PAGES), loading: true } }))
      void load(VIEW_PAGE)
    } else {
      void engine.loadView(accountId, view, { limit: VIEW_PAGE, since: current.revision }).then((result) => {
        if (!live || !result) return
        const byId = new Map((mailboxesRef.current[accountId] ?? []).map((t) => [t.id, t]))
        const latest = pagesRef.current[pageKey] ?? current
        const merged = refreshPages(latest, result, view, (id) => byId.get(id)?.at)
        // The engine couldn't say what changed: reload as much as was showing, in one query.
        if (merged === 'reset') return void load(Math.max(VIEW_PAGE, latest.order?.length ?? 0))
        setPages((prev) => ({ ...prev, [pageKey]: merged.pages }))
        addThreads(accountId, [...result.threads, ...merged.upserts], merged.removed)
      })
    }
    return () => {
      live = false
    }
  }, [pageKey, publishes])

  const loadNextPage = () => {
    const accountId = account.id
    const key = pageKey
    const current = pagesRef.current[key]
    if (!current?.order || current.loading || !current.hasMore || !current.cursor) return
    setPages((prev) => ({ ...prev, [key]: { ...prev[key]!, loading: true } }))
    void engine.loadView(accountId, view, { after: current.cursor, limit: VIEW_PAGE }).then((result) => {
      if (loadedKey.current !== key) return
      setPages((prev) => {
        const latest = prev[key]
        if (!latest) return prev
        return { ...prev, [key]: result ? appendPage(latest, result) : { ...latest, loading: false } }
      })
      if (result) addThreads(accountId, result.threads)
    })
  }

  // Sync when an account becomes active, then let the engine keep it current (it picks the cadence
  // from push health). Held until onboarding is done so the first sync (and its "new mail" toast)
  // happens in front of the person, not behind the intro.
  useEffect(() => {
    if (!settings.onboarded) return
    // Every account, not just the one on screen, so the switcher's unread badges stay current.
    const ids = accounts.map((a) => a.id)
    for (const id of ids) engine.syncNow(id, false)
    engine.setAutoSync(true)
    // Coming back to Jefi catches up at once instead of at the next poll.
    let active = appIsActive()
    const handle = setInterval(() => {
      const now = appIsActive()
      if (now && !active) engine.appActivated()
      active = now
    }, ACTIVATION_CHECK_MS)
    return () => {
      clearInterval(handle)
      engine.setAutoSync(false)
    }
  }, [accounts.map((a) => a.id).join(','), settings.onboarded])

  // --- Sending ------------------------------------------------------------

  /** The account a message is written as: its From, when that's still an account, else the active one. */
  const sender = (mail: DraftFields) => (mail.from ? accountById(mail.from) : undefined) ?? account
  /** Takes a draft or outgoing message out of every account's list but `accountId` (its From changed). */
  const leaveOtherAccounts = (id: string, accountId: string) => {
    for (const [other, list] of Object.entries(mailboxesRef.current)) {
      if (other !== accountId && list.some((t) => t.id === id)) updateThreadsFor(other, (items) => items.filter((t) => t.id !== id))
    }
  }

  const cancelSend: MailStore['cancelSend'] = (id) => {
    const accountId = ownerOf(id)
    const timer = undoTimers.current.get(id)
    if (timer) clearTimeout(timer)
    undoTimers.current.delete(id)
    // Read live state: the Undo toast calls this with a closure from before the outbox row existed.
    const thread = threadIn(accountId, id)
    if (!thread || thread.sendState === 'sending') return
    void engine.cancelSend(accountId, id).then((cancelled) => {
      if (!cancelled) return
      patchFor(accountId, id, () => ({ folder: 'drafts', sendState: undefined, sender: 'Draft', tag: 'Drafts' }))
      // The engine dropped the draft when the send was queued; put it back so it survives a restart.
      if (thread.draft) engine.saveDraft(accountId, id, thread.draft)
      toast('Sending cancelled', {
        id: `send-${id}`,
        description: 'Moved back to Drafts',
        action: { label: 'Open', onClick: () => openThread(accountId, id) },
      })
    })
  }

  // --- Store --------------------------------------------------------------

  const move: MailStore['move'] = (id, folder) => {
    const thread = find(id)
    if (!thread || thread.folder === folder) return
    const previous = { folder: thread.folder, snoozeUntil: thread.snoozeUntil }
    patch(id, () => ({ folder, snoozeUntil: undefined }))
    const verb: Partial<Record<FolderId, string>> = {
      archive: 'Archived',
      trash: 'Moved to Trash',
      spam: 'Marked as spam',
      inbox: 'Moved to Inbox',
    }
    toast(verb[folder] ?? `Moved to ${FOLDER_NAMES[folder]}`, {
      description: quote(thread.subject),
      action: {
        label: 'Undo',
        onClick: () => {
          patch(id, () => previous)
          engine.move(ownerOf(id), id, previous.folder)
        },
      },
    })
    engine.move(ownerOf(id), id, folder)
  }

  const bulk: MailStore['bulk'] = (ids, action) => {
    const targets = ids.map(find).filter((t): t is MailThread => !!t)
    if (!targets.length) return
    const count = targets.length === 1 ? '1 conversation' : `${targets.length} conversations`
    if (action === 'deleteForever') {
      const gone = new Set(targets.map((t) => t.id))
      for (const t of targets) {
        const owner = ownerOf(t.id)
        updateThreadsFor(owner, (list) => list.filter((x) => x.id !== t.id))
        engine.deleteForever(owner, t.id)
      }
      return void toast(`Deleted ${count} forever`)
    }
    if ('unread' in action) {
      for (const t of targets) {
        patch(t.id, () => ({ unread: action.unread }))
        engine.setFlags(ownerOf(t.id), t.id, { unread: action.unread })
      }
      return void toast(`Marked ${count} as ${action.unread ? 'unread' : 'read'}`)
    }
    if ('starred' in action) {
      for (const t of targets) {
        patch(t.id, () => ({ starred: action.starred }))
        engine.setFlags(ownerOf(t.id), t.id, { starred: action.starred })
      }
      return void toast(`${action.starred ? 'Starred' : 'Unstarred'} ${count}`)
    }
    const moving = targets.filter((t) => t.folder !== action.move)
    const previous = moving.map((t) => ({ id: t.id, folder: t.folder, snoozeUntil: t.snoozeUntil }))
    for (const t of moving) {
      patch(t.id, () => ({ folder: action.move, snoozeUntil: undefined }))
      engine.move(ownerOf(t.id), t.id, action.move)
    }
    const verb: Partial<Record<FolderId, string>> = { archive: 'Archived', trash: 'Moved to Trash', spam: 'Marked as spam', inbox: 'Moved to Inbox' }
    toast(`${verb[action.move] ?? `Moved to ${FOLDER_NAMES[action.move]}`}: ${count}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          for (const p of previous) {
            patch(p.id, () => ({ folder: p.folder, snoozeUntil: p.snoozeUntil }))
            engine.move(ownerOf(p.id), p.id, p.folder)
          }
        },
      },
    })
  }

  const scrub: MailStore['scrub'] = async (group, action, keepLatest, except) => {
    const accountId = account.id
    const moves = await engine.scrub(accountId, group.selector, action, keepLatest, except)
    // Purging returns nothing to undo, so the count comes from what the report said was there.
    if (action === 'purge') {
      toast(`Deleting ${group.messages.toLocaleString()} messages from the server`, { description: group.label })
      return group.messages
    }
    if (!moves.length) {
      toast('Nothing to clean up', { description: group.label })
      return 0
    }
    const count = moves.length === 1 ? '1 conversation' : `${moves.length.toLocaleString()} conversations`
    toast(`${action === 'trash' ? 'Moved to Trash' : 'Archived'}: ${count}`, {
      description: group.label,
      action: { label: 'Undo', onClick: () => engine.unscrub(accountId, moves) },
    })
    return moves.length
  }

  const scrubAll: MailStore['scrubAll'] = async (groups, action, keepLatest, options = {}) => {
    const accountId = options.accountId ?? account.id
    const moves: ScrubMove[] = []
    // One after another: each is a single local transaction, and the queue syncs them together.
    for (const group of groups) moves.push(...(await engine.scrub(accountId, group.selector, action, 'sender' in group.selector ? keepLatest : 0, options.except)))
    if (!moves.length) {
      toast('Nothing to clean up')
      return 0
    }
    const count = moves.length === 1 ? '1 conversation' : `${moves.length.toLocaleString()} conversations`
    const from = groups.length === 1 ? groups[0]!.label : `From ${groups.length.toLocaleString()} senders`
    toast(`${action === 'trash' ? 'Moved to Trash' : 'Archived'}: ${count}`, {
      description: options.title ? `${options.title} · ${from}` : from,
      action: { label: 'Undo', onClick: () => engine.unscrub(accountId, moves) },
    })
    return moves.length
  }

  const notSpam: MailStore['notSpam'] = (threads, accountId = account.id) => {
    if (!threads.length) return
    for (const thread of threads) engine.move(accountId, thread.threadId, 'inbox')
    toast(threads.length === 1 ? 'Moved to Inbox' : `Moved to Inbox: ${threads.length.toLocaleString()} conversations`, {
      description: threads.length === 1 ? quote(threads[0]!.subject) : 'Out of Spam',
      action: { label: 'Undo', onClick: () => threads.forEach((thread) => engine.move(accountId, thread.threadId, 'spam')) },
    })
  }

  const unsubscribe: MailStore['unsubscribe'] = async (group) => {
    const id = `unsubscribe-${group.detail}`
    toast.loading(`Unsubscribing from ${group.label}…`, { id })
    try {
      return await unsubscribeFrom(group, id)
    } catch (err) {
      // The loading toast is replaced either way, never left spinning.
      toast.error(`Couldn't unsubscribe from ${group.label}`, { id, description: err instanceof Error ? err.message : String(err) })
      return false
    }
  }
  const unsubscribeFrom = async (group: Pick<ScrubGroup, 'label' | 'detail'>, id: string) => {
    const result = await engine.unsubscribe(account.id, group.detail)
    if (!result.ok) {
      toast.error(`Couldn't unsubscribe from ${group.label}`, { id, description: result.error })
      return false
    }
    if (result.done) {
      toast.success(`Unsubscribed from ${group.label}`, { id })
      return true
    }
    if (result.mailto) {
      // mailto:address?subject=…&body=… — send it for them, like any other message.
      const url = new URL(result.mailto)
      store.send({
        to: [decodeURIComponent(url.pathname)],
        cc: [],
        bcc: [],
        subject: url.searchParams.get('subject') ?? 'unsubscribe',
        body: url.searchParams.get('body') ?? 'unsubscribe',
      } as DraftFields)
      toast.success(`Unsubscribe request sent to ${group.label}`, { id })
      return true
    }
    if (result.link) {
      Bun.spawn(['open', result.link], { stdout: 'ignore', stderr: 'ignore' })
      toast.info('Finish unsubscribing in your browser', { id, description: group.label })
      return true
    }
    toast.error(`Couldn't unsubscribe from ${group.label}`, { id, description: "This sender doesn't offer an unsubscribe link" })
    return false
  }

  /** The conversation holding a message, in whichever account it is: All Inboxes shows them all. */
  const threadWithMessage = (messageId: string) => {
    for (const list of [threads, ...Object.values(mailboxesRef.current)]) {
      const found = list.find((thread) => thread.messages.some((message) => message.id === messageId))
      if (found) return found
    }
    return undefined
  }

  const getAttachment: MailStore['getAttachment'] = async (messageId, index, attachment) => {
    if (attachment.path) {
      const problem = readProblem(attachment.path)
      if (problem) return { ok: false, error: fileProblemMessage(attachment.name, problem) }
      try {
        if (!statSync(attachment.path).isFile()) return { ok: false, error: `${attachment.name} is not a regular file` }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true, attachment: { ...attachment, path: attachment.path } }
    }
    const owner = threadWithMessage(messageId)
    const accountId = owner ? ownerOf(owner.id) : account.id
    if (!owner?.id.startsWith(`${accountId}:`)) return { ok: false, error: `${attachment.name} is attached to mail that hasn't been sent yet` }
    try {
      const result = await engine.getAttachment(accountId, messageId, attachment.index ?? index)
      return result.ok ? { ok: true, attachment: { ...attachment, path: result.path } } : result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const getOriginalMessage: MailStore['getOriginalMessage'] = async (messageId) => {
    const owner = threadWithMessage(messageId)
    const accountId = owner ? ownerOf(owner.id) : account.id
    if (!owner?.id.startsWith(`${accountId}:`)) return { ok: false, error: 'Original source is available for received mail only' }
    try {
      return await engine.getOriginalMessage(accountId, messageId)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Derived values keep their identity between unrelated changes, so selectors on them stay quiet.
  const serverLabels = accountLabels[account.id]
  // A label made here shows at once; the engine's list takes over once it has it (on Gmail, next sync).
  const allLabels = useMemo(() => mergeLabels(labels.filter((l) => labelOwner(l.id) === account.id), serverLabels ?? []), [labels, serverLabels, account.id])
  const inboxCounts = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, inboxUnreadCount(mailboxes[a.id] ?? [], unreadBases[a.id] ?? null)])),
    [accounts, mailboxes, unreadBases],
  )
  const inboxUnreadRef = useRef(inboxCounts)
  if (!shallowEqual(inboxUnreadRef.current, inboxCounts)) inboxUnreadRef.current = inboxCounts
  const tally = useMemo(() => sidebarCounts(threads), [threads])
  const tallyRef = useRef(tally)
  if (tallyRef.current !== tally && !deepEqual(tallyRef.current, tally)) tallyRef.current = tally
  const counts = useMemo<MailCounts>(() => ({ inboxUnread: inboxUnreadRef.current, sidebar: tallyRef.current }), [inboxUnreadRef.current, tallyRef.current])

  const store: MailStore = {
    search: async (query) => {
      const accountId = account.id
      const found = await engine.search(accountId, query)
      if (found.length) {
        const ids = new Set(found.map((t) => t.id))
        updateThreadsFor(accountId, (list) => [...keepLoadedBodies(found, list), ...list.filter((t) => !ids.has(t.id))])
      }
      return found.map((t) => t.id)
    },
    screenerOn,
    setScreener: (on) => {
      setScreenerOn(on)
      engine.setScreener(account.id, on).then(
        () => toast(on ? 'Screener on' : 'Screener off', { description: on ? 'New senders will wait in the Screener' : 'Everyone goes straight to the Inbox' }),
        (err) => {
          // The switch goes back to what the engine still has.
          setScreenerOn(!on)
          toast.error("Couldn't change the Screener", { description: err instanceof Error ? err.message : String(err) })
        },
      )
    },
    screenSender: (email, name, verdict) => {
      // Update the list now; the engine's next snapshot agrees.
      updateThreadsFor(account.id, (list) =>
        list.map((t) => (t.screened && t.messages.some((m) => m.email.toLowerCase() === email.toLowerCase()) ? { ...t, screened: false, ...(verdict === 'block' ? { folder: 'trash' as const } : {}) } : t)),
      )
      void engine.screenSender(account.id, email, verdict)
      toast(verdict === 'allow' ? `${name} can now reach your Inbox` : `Blocked ${name}`, { description: verdict === 'block' ? 'Their mail goes to Trash' : email })
    },
    listRules: () => engine.listRules(account.id),
    saveRule: async (rule) => {
      try {
        const rules = await engine.saveRule(account.id, rule)
        toast.success(`Saved rule “${rule.name}”`)
        return rules
      } catch (err) {
        toast.error("Couldn't save the rule", { description: err instanceof Error ? err.message : String(err) })
        return null
      }
    },
    deleteRule: async (id) => {
      const rules = await engine.deleteRule(account.id, id)
      toast('Rule deleted')
      return rules
    },
    countRuleMatches: (match) => engine.countRuleMatches(account.id, match),
    runRule: async (rule) => {
      let count: number
      try {
        count = await engine.runRule(account.id, rule.id)
      } catch (err) {
        // Nothing was changed (a run is all or nothing), so it can just be tried again.
        toast.error(`Couldn't run ${rule.name}`, { description: `${err instanceof Error ? err.message : String(err)}. Nothing was moved; try again.` })
        return
      }
      if (count) toast('Rule applied', { description: `${rule.name} · ${count === 1 ? '1 conversation' : `${count} conversations`}` })
      else toast('Nothing matches in the Inbox', { description: rule.name })
    },
    ruleDraft: ruleDraftFor?.accountId === account.id ? ruleDraftFor.rule : null,
    // Editing keeps the rule's id and on/off state, so saving replaces it instead of adding a copy.
    startRule: (draft) => setRuleDraftFor(draft ? { accountId: account.id, rule: ruleDraftFrom(draft) } : null),
    scrubReport: (by) => engine.scrubReport(account.id, by),
    scrubStats: () => engine.scrubStats(account.id),
    senderProfiles: (accountId) => engine.senderProfiles(accountId ?? account.id),
    senderThreads: (senders, accountId) => engine.senderThreads(accountId ?? account.id, senders),
    spamThreads: (accountId) => engine.spamThreads(accountId ?? account.id),
    notSpam,
    scrub,
    scrubAll,
    unsubscribe,
    bulk,
    accounts,
    hasAccounts: accounts.length > 0,
    account,
    switchAccount: (id) => {
      const next = accounts.find((a) => a.id === id)
      if (!next || id === activeId) return
      setOpenRequest(null)
      setActiveId(id)
      toast(`Switched to ${next.email}`)
    },
    addAccount: (input, secret) => {
      const id = `acct-${Date.now().toString(36)}`
      // OAuth secrets are stored as JSON (tokens); anything else is a password or app password.
      const auth: Account['auth'] = secret?.trimStart().startsWith('{') ? 'oauth' : 'password'
      const created: Account = { ...input, id, face: { letter: initials(input.name) }, auth }
      if (secret) {
        engine.setSecret(id, secret).catch((err) =>
          toast.error("Couldn't save the password to Keychain", { description: err instanceof Error ? err.message : String(err) }),
        )
      }
      setAccounts((prev) => [...prev, created])
      // No lastSyncedAt: the first download is shown in full rather than hidden as a background sync.
      seedSync(id, IDLE)
      toast.success('Account added', { description: created.email })
      return created
    },
    checkConnection: (input, secret) => engine.checkConnection({ ...input, id: 'unsaved', face: {} }, secret),
    signIn: (provider, loginHint) => engine.signIn(provider, loginHint),
    cancelSignIn: () => engine.cancelSignIn(),
    needsSignInOf: (id) => !!signInNeeded[id],
    reconnect: (id) => reconnectRef.current(id),
    removeAccount: (id) => {
      const removed = accounts.find((a) => a.id === id)
      const rest = accounts.filter((a) => a.id !== id)
      setAccounts(rest)
      void engine.forgetAccount(id).catch(() => {})
      forgetSync(id)
      setOpenRequest((request) => notificationRequestBelongsToAccount(request, id) ? null : request)
      if (activeId === id) setActiveId(rest[0]?.id ?? '')
      if (removed) toast(`Removed ${removed.email}`)
    },
    updateAccount: (id, change) => setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...change, label: change.label?.trim() || undefined } : a))),
    makePrimary: (id) => setAccounts((prev) => [...prev.filter((a) => a.id === id), ...prev.filter((a) => a.id !== id)]),

    threads,
    allThreads,
    setView,
    viewPage: { view, order: page?.order ?? null, loading: !page || page.loading, hasMore: !!page?.hasMore },
    // A view the engine queries knows its own end; the rest ride on the account window.
    hasOlder: page?.order ? page.hasMore : !!olderAvailable[account.id],
    listComplete: !olderAvailable[account.id],
    loadOlder: () => {
      // A view the engine pages gets its next page; the rest widen the account window.
      if (page?.order) return loadNextPage()
      if (!olderAvailable[account.id] || pendingOlder.current.has(account.id)) return
      pendingOlder.current.add(account.id)
      engine.loadMore(account.id)
    },
    labels: allLabels,
    folders: accountFolders[account.id] ?? NO_FOLDERS,
    addLabel: (name) => {
      const clean = name.trim()
      if (!clean) return null
      const existing = allLabels.find((l) => l.label.toLowerCase() === clean.toLowerCase())
      if (existing) return existing
      // On Gmail it is a real label (the engine adds it with X-GM-LABELS), so it outlives the next sync.
      // Elsewhere Jefi keeps it in mail.db (local-labels.ts).
      const gmail = gmailAccounts[account.id] ?? account.provider === 'gmail'
      const label: Label = {
        id: gmail ? gmailLabelId(account.id, clean) : localLabelId(account.id),
        label: clean,
        color: TONES[allLabels.length % TONES.length]!,
      }
      setLabels((prev) => [...prev, label])
      if (!gmail) engine.createLabel(account.id, label)
      toast.success(`Label “${clean}” created`)
      return label
    },
    renameLabel: (id, name) => {
      const clean = name.trim()
      const owner = labelOwner(id)
      const current = allLabels.find((l) => l.id === id)
      // Gmail's labels are the server's, and Jefi can't rename one there yet.
      if (!clean || !owner || !current || !id.startsWith('lb:')) return false
      if (clean === current.label) return true
      if (allLabels.some((l) => l.id !== id && l.label.toLowerCase() === clean.toLowerCase())) {
        toast.error(`There's already a label called “${clean}”`)
        return false
      }
      const renamed = (list: Label[]) => list.map((l) => (l.id === id ? { ...l, label: clean } : l))
      setLabels(renamed)
      setAccountLabels((prev) => (prev[owner] ? { ...prev, [owner]: renamed(prev[owner]) } : prev))
      engine.renameLabel(owner, id, clean)
      return true
    },
    removeLabel: (id) => {
      const removed = allLabels.find((l) => l.id === id)
      const owner = labelOwner(id)
      setLabels((prev) => prev.filter((l) => l.id !== id))
      if (owner) setAccountLabels((prev) => (prev[owner] ? { ...prev, [owner]: prev[owner].filter((l) => l.id !== id) } : prev))
      setMailboxes((prev) =>
        Object.fromEntries(Object.entries(prev).map(([key, list]) => [key, list.map((t) => (t.labels.includes(id) ? { ...t, labels: t.labels.filter((l) => l !== id) } : t))])),
      )
      if (owner && id.startsWith('lb:')) engine.deleteLabel(owner, id)
      if (removed) toast(`Deleted label “${removed.label}”`)
    },

    move,
    toggleStar: (id) => {
      const thread = find(id)
      if (!thread) return
      patch(id, () => ({ starred: !thread.starred }))
      engine.setFlags(ownerOf(id), id, { starred: !thread.starred })
    },
    setUnread: (id, unread) => {
      patch(id, () => ({ unread }))
      engine.setFlags(ownerOf(id), id, { unread })
    },
    toggleLabel: (id, labelId) => {
      const thread = find(id)
      if (!thread) return
      // A label is its account's: one from another (All Inboxes shows several) can't go on this mail.
      const owner = labelOwner(labelId)
      if (owner && owner !== ownerOf(id)) return
      const labels = thread.labels.includes(labelId) ? thread.labels.filter((l) => l !== labelId) : [...thread.labels, labelId]
      patch(id, () => ({ labels }))
      engine.setLabels(ownerOf(id), id, labels)
    },
    snooze: (id, option) => {
      const thread = find(id)
      if (!thread) return
      const until = snoozeTime(option)
      const label = snoozeLabel(until)
      const previous = { folder: thread.folder, snoozeUntil: thread.snoozeUntil }
      patch(id, () => ({ folder: 'snoozed', snoozeUntil: label }))
      engine.snooze(ownerOf(id), id, until)
      toast(`Snoozed until ${label}`, {
        description: quote(thread.subject),
        action: {
          label: 'Undo',
          onClick: () => {
            patch(id, () => previous)
            engine.unsnooze(ownerOf(id), id)
          },
        },
      })
    },
    deleteForever: (id, undo) => {
      const thread = find(id)
      const owner = ownerOf(id)
      updateThreadsFor(owner, (list) => list.filter((t) => t.id !== id))
      engine.deleteForever(owner, id)
      if (thread) toast(thread.folder === 'drafts' ? 'Draft discarded' : 'Deleted forever', { description: quote(thread.subject), ...(undo ? { action: { label: 'Undo', onClick: undo } } : {}) })
    },
    reply: (id, input, options = {}) => {
      if (!find(id)) return false
      const messageId = `${id}-${Date.now()}`
      // Written as the account the conversation belongs to, which may not be the active one.
      const from = accountById(ownerOf(id)) ?? account
      const message = { ...composedMessage(messageId, from, input), status: 'sending' as const }
      const previous = find(id)
      const listed = previous ? { snippet: previous.snippet, date: previous.date, group: previous.group } : {}
      patch(id, (t) => ({
        messages: [...t.messages, message],
        snippet: plainSnippet(input.body) || t.snippet,
        date: 'Just now',
        group: 'Today',
        unread: false,
      }))
      const owner = ownerOf(id)
      const undoMs = undoSendRef.current * 1000
      engine.sendReply(owner, id, messageId, input, undoMs ? Date.now() + undoMs : undefined)
      // Send and archive: without an undo window it's an ordinary archive, with its own Undo.
      const archived = options.archive && previous && previous.folder !== 'archive' ? { folder: previous.folder, snoozeUntil: previous.snoozeUntil } : null
      if (options.archive && !undoMs) move(id, 'archive')
      else if (archived) {
        patchFor(owner, id, () => ({ folder: 'archive', snoozeUntil: undefined }))
        engine.move(owner, id, 'archive')
      }
      if (undoMs) {
        const toastId = `reply-${messageId}`
        const undo = () =>
          void engine.cancelSend(owner, messageId).then((cancelled) => {
            // Too late: it's already on its way, and its own events say how that goes.
            if (!cancelled) return
            patchFor(owner, id, (t) => ({ ...listed, ...(archived ?? {}), messages: t.messages.filter((m) => m.id !== messageId) }))
            // Unsent, so not archived either: back where it was.
            if (archived) engine.move(owner, id, archived.folder)
            toast('Reply not sent', { id: toastId, description: 'It’s back where you wrote it' })
            options.onUndo?.()
          })
        toast.loading('Sending reply…', { id: toastId, description: quote(find(id)?.subject ?? ''), action: { label: 'Undo', onClick: undo } })
      }
      const draftId = options.draftId
      // The reply went out of the full composer's autosaved draft: that draft is done, like a sent message's.
      if (draftId) {
        const owner = ownerOf(draftId)
        updateThreadsFor(owner, (list) => list.filter((t) => t.id !== draftId))
        engine.deleteForever(owner, draftId)
      }
      return true
    },
    retryReply: (threadId, messageId) => engine.retry(ownerOf(threadId), threadId, messageId),
    confirmReplySent: (threadId, messageId) => engine.confirmSent(ownerOf(threadId), threadId, messageId),
    send: (mail, draftId, sendAt) => {
      // Sent as the account the composer's From names (the active one without a choice).
      const from = sender(mail)
      if (draftId) leaveOtherAccounts(draftId, from.id)
      const id = draftId ?? `sent-${Date.now()}`
      const accountId = from.id
      const thread = { ...outgoingThread(id, from, mail, 'outbox'), sendState: 'queued' as const }
      updateThreadsFor(accountId, (list) => [thread, ...list.filter((t) => t.id !== id)])
      if (sendAt) {
        // Send later: straight to the engine's outbox with a time; it goes out even if Jefi restarts.
        patchFor(accountId, id, () => ({ scheduledFor: snoozeLabel(sendAt) }))
        engine.send(accountId, id, mail, sendAt)
        toast('Scheduled', {
          id: `send-${id}`,
          description: `${quote(thread.subject)} · ${snoozeLabel(sendAt)}`,
          action: { label: 'Undo', onClick: () => cancelSend(id) },
        })
        return id
      }
      const undoMs = undoSendRef.current * 1000
      if (undoMs === 0) {
        // No undo window: hand straight to SMTP once the outbox row has rendered, so its events find it.
        setTimeout(() => engine.send(accountId, id, mail), 0)
        return id
      }
      // Gmail-style undo window before the message is handed to SMTP.
      toast.loading('Sending…', {
        id: `send-${id}`,
        description: `To ${recipientNames(mail.to) || 'no one'} · ${quote(thread.subject)}`,
        action: { label: 'Undo', onClick: () => cancelSend(id) },
      })
      undoTimers.current.set(
        id,
        setTimeout(() => {
          undoTimers.current.delete(id)
          engine.send(accountId, id, mail)
        }, undoMs),
      )
      return id
    },
    retrySend: (id) => {
      engine.retry(ownerOf(id), id)
    },
    confirmSent: (id) => engine.confirmSent(ownerOf(id), id),
    cancelSend,
    saveDraft: (mail, draftId, quiet) => {
      const id = draftId ?? `draft-${Date.now()}`
      // A draft lives in its From account's Drafts: changing From moves it there (the engine too).
      const from = sender(mail)
      leaveOtherAccounts(id, from.id)
      updateThreadsFor(from.id, (list) => [outgoingThread(id, from, mail, 'drafts'), ...list.filter((t) => t.id !== id)])
      engine.saveDraft(from.id, id, mail)
      if (!quiet) toast.success('Draft saved', { description: quote(mail.subject.trim() || '(no subject)') })
      return id
    },

    inboxUnread: inboxUnreadRef.current,
    accountOf: (threadId) => accountById(ownerOf(threadId)) ?? account,
    sync: syncStates[account.id] ?? IDLE,
    syncStateOf: (id) => syncStates[id] ?? IDLE,
    syncNow: () => {
      // A background sync may already be running: the engine queues the manual one behind it, so
      // surface the running one now rather than staying quiet until the queued sync's own events arrive.
      revealAccount(account.id)
      engine.syncNow(account.id, true)
    },
    offline,
    setOffline: (next) => {
      setOfflineState(next)
      engine.setOffline(next)
      if (next) toast.warning("You're offline", { description: 'Sync and sending are paused' })
      else {
        toast.success('Back online')
        engine.syncNow(account.id, false)
      }
    },

    fetchThread: async (id) => {
      const accountId = ownerOf(id)
      const full = await engine.loadThread(accountId, id)
      if (!full) return threadIn(accountId, id) ?? null
      const loaded = { ...(threadIn(accountId, id) ?? full), messages: full.messages, draft: full.draft ?? undefined, full: true }
      // An exact notification lookup can find a stored conversation before the bounded list snapshot
      // publishes. Upsert it so selecting the returned id cannot fall back to another visible row.
      updateThreadsFor(accountId, (list) => list.some((thread) => thread.id === id)
        ? list.map((thread) => thread.id === id ? loaded : thread)
        : [loaded, ...list])
      return loaded
    },
    showThread: openThread,
    unreadAcrossAccounts: (limit) => engine.unreadAcrossAccounts(limit),
    openThread: (id) => {
      // Selecting a conversation and the reader's fallback both ask; one load serves them.
      const pending = openingThreads.current.get(id)
      if (pending) return pending
      const accountId = ownerOf(id)
      const load = engine
        .loadThread(accountId, id)
        .then((full) => {
          if (full) patchFor(accountId, id, () => ({ messages: full.messages, draft: full.draft ?? undefined, full: true }))
        })
        .catch(() => {})
        .finally(() => openingThreads.current.delete(id))
      openingThreads.current.set(id, load)
      return load
    },

    getAttachment,
    getOriginalMessage,

    openAttachment: (messageId, index, attachment) => {
      const id = `attachment-${messageId}-${index}`
      toast.loading(`Opening ${attachment.name}…`, { id })
      void getAttachment(messageId, index, attachment).then(async (result) => {
        if (result.ok) {
          try {
            const process = Bun.spawn(['open', result.attachment.path], { stdout: 'ignore', stderr: 'ignore' })
            if (await process.exited === 0) toast.dismiss(id)
            else toast.error(`Couldn't open ${attachment.name}`, { id, description: 'The system could not open this file.' })
          } catch (error) {
            toast.error(`Couldn't open ${attachment.name}`, { id, description: error instanceof Error ? error.message : String(error) })
          }
        } else toast.error(`Couldn't open ${attachment.name}`, { id, description: result.error })
      })
    },

    openRequest,
    clearOpenRequest: () => setOpenRequest(null),

    notify,

    createCalendar: (input) => failSoft("Couldn't create the calendar", engine.createLocalCalendar(input)),
    updateCalendar: (id, patch) => failSoft("Couldn't change the calendar", engine.updateCalendar(id, patch)),
    deleteCalendar: async (id) => (await failSoft("Couldn't delete the calendar", engine.deleteCalendar(id).then(() => true))) ?? false,
    listEvents: (from, to, calendarIds) => engine.listEvents(from, to, calendarIds),
    getEvent: (id) => engine.getEvent(id),
    eventByUid: (uid, recurrenceId) => engine.eventByUid(uid, recurrenceId),
    saveEvent: (input, options) => failSoft("Couldn't save the event", engine.saveEvent(input, options)),
    deleteEvent: async (id, scope, occurrenceStart) => (await failSoft("Couldn't delete the event", engine.deleteEvent(id, scope, occurrenceStart))) ?? false,
    eventLinks: (eventId) => engine.eventLinks(eventId),
    linkEvent: (eventId, target) => failSoft("Couldn't link the event", engine.linkEvent(eventId, target)),
    unlinkEvent: async (linkId) => (await failSoft("Couldn't remove the link", engine.unlinkEvent(linkId))) ?? false,
    invitesForMessage: (threadId, messageId) => engine.invitesForMessage(ownerOf(threadId), messageId),
    inviteForMessage: (threadId, messageId) => engine.inviteForMessage(ownerOf(threadId), messageId),
    respondToInvite: async (threadId, messageId, response, comment) => {
      const accountId = ownerOf(threadId)
      const undoMs = undoSendRef.current * 1000
      const sent = await failSoft("Couldn't answer the invitation", engine.respondToInvite(accountId, messageId, response, comment, undoMs ? { sendAt: Date.now() + undoMs } : undefined))
      if (!sent) return null
      const said = response === 'accepted' ? 'Accepted' : response === 'tentative' ? 'Maybe' : 'Declined'
      const outboxId = sent.outboxId
      toast(`${said}: ${sent.event.title}`, {
        description: outboxId ? 'The organizer will get your answer' : 'Saved in your calendar',
        ...(outboxId && undoMs
          ? { action: { label: 'Undo', onClick: () => void engine.cancelSend(accountId, outboxId).then((ok) => ok && toast('Answer not sent', { description: 'Your calendar keeps it; change it any time' })) } }
          : {}),
      })
      return sent.event
    },
    sendEventInvites: async (eventId, kind) => {
      const sent = await failSoft(kind === 'cancel' ? "Couldn't send the cancellation" : "Couldn't send the invitations", engine.sendEventInvites(eventId, kind))
      if (!sent) return false
      toast(kind === 'cancel' ? 'Cancellation sent' : 'Invitations sent', { description: recipientNames(sent.recipients) })
      return true
    },
    getNote: (id) => engine.getNote(id),
    saveNote: (input) => failSoft("Couldn't save the note", engine.saveNote(input)),
    deleteNote: async (id) => (await failSoft("Couldn't delete the note", engine.deleteNote(id))) ?? false,
    linkNote: (noteId, target) => failSoft("Couldn't link the note", engine.linkNote(noteId, target)),
    unlinkNote: async (linkId) => (await failSoft("Couldn't remove the link", engine.unlinkNote(linkId))) ?? false,
    getTask: (id) => engine.getTask(id),
    saveTask: (input) => failSoft("Couldn't save the task", engine.saveTask(input)),
    setTaskDone: (id, done) => failSoft(done ? "Couldn't complete the task" : "Couldn't reopen the task", engine.setTaskDone(id, done)),
    deleteTask: async (id) => (await failSoft("Couldn't delete the task", engine.deleteTask(id))) ?? false,
    linkTask: (taskId, target) => failSoft("Couldn't link the task", engine.linkTask(taskId, target)),
    unlinkTask: async (linkId) => (await failSoft("Couldn't remove the link", engine.unlinkTask(linkId))) ?? false,
    saveTaskProject: (input) => failSoft("Couldn't save the project", engine.saveTaskProject(input)),
    deleteTaskProject: async (id) => (await failSoft("Couldn't delete the project", engine.deleteTaskProject(id))) ?? false,
    saveTaskLabel: (input) => failSoft("Couldn't save the label", engine.saveTaskLabel(input)),
    deleteTaskLabel: async (id) => (await failSoft("Couldn't delete the label", engine.deleteTaskLabel(id))) ?? false,
    threadTarget: (threadId) => ({ kind: 'thread', accountId: ownerOf(threadId), threadId }),
    messageTarget: (threadId, messageId) => ({ kind: 'message', accountId: ownerOf(threadId), messageId }),
  }

  // Written during render so children rendering in this pass read it; subscribers that bailed out hear after commit.
  source.current = store
  useLayoutEffect(() => {
    for (const listener of source.listeners) listener()
  })

  const tree = renderCountsOn ? <Profiler id="mail" onRender={countCommit}>{children}</Profiler> : children
  return (
    <MailSourceContext.Provider value={source}>
      <LocalDataProvider value={localData}>
        <MailCountsContext.Provider value={counts}>
          <MailContext.Provider value={store}>{tree}</MailContext.Provider>
        </MailCountsContext.Provider>
      </LocalDataProvider>
    </MailSourceContext.Provider>
  )
}


/** Two whole-Inbox counts that would put the same number on the badge. */
const sameBasis = (a: UnreadBasis | null | undefined, b: UnreadBasis | null) =>
  a === b || (!!a && !!b && a.total === b.total && a.inWindow === b.inWindow && a.window.size === b.window.size && [...b.window].every((id) => a.window.has(id)))

/** A calendar or notes write: its result, or null after a toast saying what went wrong. */
async function failSoft<T>(title: string, write: Promise<T>): Promise<T | null> {
  try {
    return await write
  } catch (err) {
    toast.error(title, { description: err instanceof Error ? err.message : String(err) })
    return null
  }
}
