import type { SignIn } from './sign-in-code'
import type { IconName } from './icons'

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type FaceSpec = { src?: string; letter?: string }

/** `size` is the label people read ("540 KB"); `path` is the file on this Mac, set on anything composed. */
/** `index`: a received file's position among its message's stored parts (the reader hides some). */
export type Attachment = { name: string; size: string; path?: string; index?: number }

/** A mailbox as it appeared in a message header. */
export type MailAddress = { name?: string; email: string }

/** RFC 2369/8058 options attached to this exact message. The UI always reviews before acting. */
export type UnsubscribeOptions = { oneClick: string | null; link: string | null; mailto: string | null }

export type Message = {
  id: string
  from: string
  email: string
  to: string
  /** Structured headers used for reply addressing and message details; presentation strings above stay for compatibility. */
  fromAddress?: MailAddress
  toAddresses?: MailAddress[]
  ccAddresses?: MailAddress[]
  replyToAddresses?: MailAddress[]
  /** RFC Message-ID and References for replying to this exact message. */
  messageId?: string
  references?: string[]
  unsubscribe?: UnsubscribeOptions
  face: FaceSpec
  time: string
  /** Exact message time; `time` remains the compact display label. */
  timestamp?: number
  paragraphs: Array<string | string[]>
  /** Markdown body for mail written in Jefi's composer; rendered instead of `paragraphs`. */
  markdown?: string
  attachments?: Attachment[]
  /** Delivery state for messages written in Jefi; absent once delivered. */
  /** A reply still in the Outbox. 'unconfirmed': the server may have it, so it isn't sent again on its own. */
  status?: 'sending' | 'failed' | 'unconfirmed'
  /** The original HTML, for Full view; only on conversations opened in the reader. */
  html?: string
  /** The body isn't stored on this Mac yet; `paragraphs` holds the snippet at best. */
  bodyMissing?: boolean
}

export type FolderId = 'inbox' | 'starred' | 'snoozed' | 'outbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash'

/** Recipients + body a draft reopens with in the composer. */
export type DraftFields = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments?: Attachment[]
  /** The conversation (and the message in it) this answers, so a reopened or scheduled reply still threads. */
  replying?: { threadId: string; messageId?: string }
  /** The account (id) it's sent from, and whose Drafts keep it; the active account when absent. */
  from?: string
}

export type MailThread = {
  id: string
  sender: string
  subject: string
  snippet: string
  /** The one-time code or magic link in the newest message, offered in one click (src/sign-in-code.ts). */
  signIn?: SignIn
  date: string
  /** Epoch ms of the latest activity, for ordering lists that merge several accounts. */
  at?: number
  group: 'Today' | 'Yesterday' | 'Last 7 days' | 'Earlier'
  unread: boolean
  starred: boolean
  icons: Array<'paperclip' | 'star' | 'calendar' | 'clock'>
  priority: boolean
  tag: string
  face: FaceSpec
  messages: Message[]
  folder: FolderId
  /** Label ids. */
  labels: string[]
  snoozeUntil?: string
  draft?: DraftFields
  /** Outbox pipeline: waiting out the undo window, handing to SMTP, or failed. */
  sendState?: 'queued' | 'sending' | 'failed'
  /** Delivery attempts already made for this immutable outbox snapshot. */
  sendAttempts?: number
  /** The most recent SMTP or local delivery error. */
  sendError?: string
  /** Epoch ms for the next automatic retry; absent when none is scheduled. */
  sendRetryAt?: number
  /** The server rejected this permanently, so only a person can retry it. */
  sendPermanent?: boolean
  /** Temporary delivery kept failing until the automatic retry budget ended. */
  sendRetryStopped?: boolean
  /** The server may have accepted it (no reply after the body went out); only a person decides what's next. */
  sendUnconfirmed?: boolean
  /** Bodies and attachments are loaded (the reader has opened it); list snapshots leave this unset. */
  full?: boolean
  /** Plain IMAP folders (by path) holding this conversation; see MailFolder. */
  folders?: string[]
  /** In custom folders only, so `folder` is a placeholder and built-in mailboxes skip it. */
  onlyInFolders?: boolean
  /** From a first-time sender while the Screener is on: shown under Screener, not the Inbox. */
  screened?: boolean
  /** Send later: when this outbox message is due to go out, as a label ("tomorrow, 8:00"). */
  scheduledFor?: string
}

export type Folder = {
  id: FolderId
  label: string
  icon: IconName
  count?: number
  tone?: 'red' | 'muted'
}

export type LabelTone = 'purple' | 'green' | 'blue' | 'amber' | 'pink' | 'teal'
export type Label = { id: string; label: string; color: LabelTone }

/** Someone the account corresponds with; filled from synced mail (src/contacts.ts). */
export type Contact = {
  name: string
  email: string
  face: FaceSpec
  role?: string
}

export const FOLDERS: Folder[] = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox', tone: 'red' },
  { id: 'starred', label: 'Starred', icon: 'star' },
  { id: 'snoozed', label: 'Snoozed', icon: 'clock' },
  { id: 'outbox', label: 'Outbox', icon: 'upload', tone: 'muted' },
  { id: 'sent', label: 'Sent', icon: 'send' },
  { id: 'drafts', label: 'Drafts', icon: 'file', tone: 'muted' },
  { id: 'archive', label: 'Archive', icon: 'archive' },
  { id: 'spam', label: 'Spam', icon: 'alertCircle' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
]

export const GROUPS: MailThread['group'][] = ['Today', 'Yesterday', 'Last 7 days', 'Earlier']

/** A plain IMAP folder (no special use), listed under Folders in the sidebar. */
export type MailFolder = { path: string; name: string; depth: number }
