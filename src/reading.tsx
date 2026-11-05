import { countRender } from './render-counts'
import { BidiText } from './bidi-text'
import { motion, useGpuixRequired, useWindowSize, type PublicInstance } from '@gpuix/react'
import { ClipContext, FullHtml, fullRenderingAvailable, hasRemoteImages } from './html-view'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Tooltip } from './tooltip'
import { useContextMenu, type ContextItem } from './context-menu'
import { chunkMarkdown, splitQuoted } from './mail-text'
import { FONT, READ_PAD_LEFT, READ_PAD_RIGHT, TOPBAR_HEIGHT, allowRemoteImagesFrom, mixHex, remoteImagesAllowed, useSettings } from './theme'
import { Icon, IconButton, type IconName } from './icons'
import { AttachmentCard, Divider, Face } from './primitives'
import type { Attachment, DraftFields, FolderId, Label, LabelTone, MailAddress, MailFolder, MailThread, Message } from './data'
import { MailMarkdown, findContact, plainSnippet, plainTextMarkdown } from './markdown'
import { messagePage } from './message-page'
import { isCmd, useKeys } from './keys'
import { countTrackers, withoutTrackers } from './trackers'
import { SignInCodePill, freshCode } from './sign-in-pill'
import { signInFresh } from './sign-in-code'
import { FOLDER_NAMES, shallowEqual, useMail, useMailActions, useMailSelector } from './store'
import { useStableCallback } from './stable-callback'
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, useToggle } from './ui'
import { Spinner } from './toast'
import { aiErrorMessage, draftReply, summarizeThread, translateMessage } from './ai'
import { useAi } from './use-ai'
import { draftFromMailto, LinkPopover, type LinkPosition, type LinkReviewRequest } from './link-popover'
import { copyLink, copyText, openExternalLink } from './native/mail-webview'
import { sendToAssistant } from './assistant-handoff'
import { SummaryCard } from './summary-card'
import { pickAttachmentDestination, pickAttachmentDirectory, pickOriginalDestination, saveAttachmentInDirectory, saveAttachmentTo, saveOriginalTo } from './native/file-picker'
import { replySubject } from './engine/mime'
import { messageText, replyDraft as buildReplyDraft, replyRecipients, type ReplyMode } from './reply'
import { geometryMayChange } from './geometry-wake'
import { findReaderMatches, markdownSearchText, printableThread, readRawHeaders, type ReaderMatch, type ReaderSearchRow } from './reader-tools'
import { OriginalMessageModal, ReaderFindBar } from './reader-tools-ui'
import { printReaderText } from './native/print'
import { previewFile } from './native/quick-look'
import { MessageCalendar, type ThreadRef } from './reader-calendar/message-calendar'
import { AddToNotesButton, ThreadLinks, addMessageToNotes } from './reader-calendar/thread-links'
import { MakeTaskButton, makeTaskFromMessage } from './tasks'

export type { ReplyMode } from './reply'

/** A lifecycle subscription isolated in a custom hook; components do not coordinate work with effects. */
function useAbortOnUnmount(ref: { current: AbortController | null }) {
  useEffect(() => () => ref.current?.abort(), [])
}

const SNOOZE_OPTIONS = ['Later today', 'Tomorrow', 'This weekend', 'Next week']

function Paragraph({ block, onLink, sender, trustedDomains }: { block: string | string[]; onLink: (url: string, position?: LinkPosition) => void; sender: string; trustedDomains: readonly string[] }) {
  const source = useMemo(() => plainTextMarkdown(block), [block])
  return <MailMarkdown source={source} prepared onLink={onLink} linkDisclosure={{ sender, trustedDomains }} />
}

const addressText = (address: MailAddress) => address.name && address.name.toLowerCase() !== address.email.toLowerCase()
  ? `${address.name} <${address.email}>`
  : address.email

const addressList = (addresses: MailAddress[] | undefined) => addresses?.map(addressText).join(', ') ?? ''

function preciseMessageTime(message: Message) {
  if (!Number.isFinite(message.timestamp)) return message.time
  return new Date(message.timestamp!).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })
}

const retryTime = (at: number) => {
  const seconds = Math.round((at - Date.now()) / 1000)
  if (seconds > 0 && seconds < 60) return `in ${seconds}s`
  if (seconds >= 60 && seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function outboxFailureText(thread: MailThread, fallback: string) {
  const attempts = thread.sendAttempts ?? 0
  // It may already be in the recipients' inboxes: say so before anyone sends it again.
  // The advice leads: the banner is one line, and the server's details can be cut off.
  if (thread.sendUnconfirmed) return `May have been sent · check Sent first${thread.sendError ? ` · ${thread.sendError}` : ''}`
  if (thread.sendPermanent) return thread.sendError ? `Sending stopped · ${thread.sendError} · retry manually` : 'Sending stopped · retry manually'
  // Why it failed matters as much as what happens next: a typo'd address and a dead server need
  // different fixes.
  const why = thread.sendError ? ` · ${thread.sendError}` : ''
  if (thread.sendRetryStopped) return `Automatic retries stopped after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}${why}`
  if (thread.sendRetryAt) return `Attempt ${Math.max(1, attempts)} · retrying ${retryTime(thread.sendRetryAt)}${why}`
  return thread.sendError || fallback
}

function messageDetailRows(message: Message): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['From', message.fromAddress ? addressText(message.fromAddress) : `${message.from} <${message.email}>`],
    ['To', addressList(message.toAddresses) || message.to],
  ]
  const cc = addressList(message.ccAddresses)
  const replyTo = addressList(message.replyToAddresses)
  if (cc) rows.push(['Cc', cc])
  if (replyTo) rows.push(['Reply-To', replyTo])
  rows.push(['Date', preciseMessageTime(message)])
  if (message.messageId) rows.push(['Message-ID', message.messageId])
  return rows
}

/** "Fwd: " once: a subject that already says Fwd:, Fw: or FWD: keeps it. */
export const forwardSubject = (subject: string) => (/^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`)

/** The draft a Forward starts from, after every attachment has a readable local path. */
export function forwardDraft(thread: MailThread, message: Message, attachments: Attachment[]): DraftFields {
  // The original's headers, as every mail client forwards them: who, when (with the date, not just
  // the time the list shows), what, and to whom.
  const from = message.fromAddress?.email ? addressText(message.fromAddress) : message.email ? `${message.from} <${message.email}>` : message.from
  const to = addressList(message.toAddresses) || message.to
  const cc = addressList(message.ccAddresses)
  const headers = [`From: ${from}`, `Date: ${preciseMessageTime(message)}`, `Subject: ${thread.subject}`, ...(to ? [`To: ${to}`] : []), ...(cc ? [`Cc: ${cc}`] : [])]
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: forwardSubject(thread.subject),
    body: `\n\n---\n\n**Forwarded message**\n${headers.join('\n')}\n\n${messageText(message)}`,
    attachments: attachments.length ? attachments : undefined,
  }
}

/** Fetch every file before composing. Any failure aborts the whole forward; attachments never vanish silently. */
export async function prepareForwardDraft(
  thread: MailThread,
  message: Message,
  getAttachment: (messageId: string, index: number, attachment: Attachment) => Promise<{ ok: true; attachment: Attachment & { path: string } } | { ok: false; error: string }>,
): Promise<{ ok: true; draft: DraftFields } | { ok: false; error: string }> {
  const attachments: Attachment[] = []
  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    let result: Awaited<ReturnType<typeof getAttachment>>
    try {
      result = await getAttachment(message.id, index, attachment)
    } catch (error) {
      return { ok: false, error: `${attachment.name}: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!result.ok) return { ok: false, error: `${attachment.name}: ${result.error}` }
    attachments.push(result.attachment)
  }
  return { ok: true, draft: forwardDraft(thread, message, attachments) }
}

export type MessagePart =
  /** A message that isn't the open one: a single row, clicked to open it. */
  | { kind: 'collapsed' }
  | { kind: 'head' }
  | { kind: 'full' }
  | { kind: 'markdown'; source: string; first: boolean }
  | { kind: 'paragraphs'; blocks: Message['paragraphs']; first: boolean }
  | { kind: 'loading' }
  /** Quoted history at the end of a reply, folded until asked for. */
  | { kind: 'quoted'; open: boolean }
  | { kind: 'foot' }

/**
 * A plain-text body's paragraphs split into what's new and the quoted history trailing it (see
 * splitQuoted). Null when there is no trailing quote, or the body has list blocks to keep as they are.
 */
export function splitQuotedParagraphs(blocks: Message['paragraphs']): { body: string[]; quoted: string[] } | null {
  if (!blocks.length || blocks.some((block) => typeof block !== 'string')) return null
  const split = splitQuoted((blocks as string[]).join('\n\n'))
  if (!split.quoted) return null
  const paragraphs = (text: string) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  return { body: paragraphs(split.body), quoted: paragraphs(split.quoted) }
}

/**
 * How a message is drawn. One message in a conversation is open at a time, read in the HTML view
 * (there is one web view); the others are a row each. 'text' draws the body as text instead: while
 * finding in the conversation, which searches every message, and where there is no web view.
 */
export type MessageView = 'collapsed' | 'html' | 'text'

/** The pieces a message is drawn in, top to bottom. `showQuoted` unfolds its quoted history. */
export function messageParts(message: Message, view: MessageView, showQuoted = false): MessagePart[] {
  if (view === 'collapsed') return [{ kind: 'collapsed' }]
  const markdown = (source: string, first: boolean) => chunkMarkdown(source).map((chunk, i): MessagePart => ({ kind: 'markdown', source: chunk, first: first && i === 0 }))
  // The body isn't on this Mac yet: `paragraphs` holds the snippet at best, and drawing that as the
  // message would pass a one-line preview off as the whole of it.
  if (message.bodyMissing) return [{ kind: 'head' }, { kind: 'loading' }, { kind: 'foot' }]
  if (view === 'html') return [{ kind: 'head' }, messagePage(message) ? { kind: 'full' } : { kind: 'loading' }, { kind: 'foot' }]
  const split = message.markdown !== undefined ? splitQuoted(message.markdown) : null
  const paragraphs = (blocks: Message['paragraphs'], first: boolean): MessagePart[] =>
    Array.from({ length: Math.ceil(blocks.length / 12) }, (_, i) => ({
      kind: 'paragraphs' as const,
      blocks: blocks.slice(i * 12, i * 12 + 12),
      first: first && i === 0,
    }))
  // Plain-text replies fold their quoted history the way Markdown ones do.
  const plain = !split ? splitQuotedParagraphs(message.paragraphs) : null
  const body: MessagePart[] =
    split
        ? [
            ...markdown(split.body, true),
            ...(split.quoted ? [{ kind: 'quoted', open: showQuoted } as MessagePart, ...(showQuoted ? markdown(split.quoted, false) : [])] : []),
          ]
        : plain?.quoted
          ? [...paragraphs(plain.body, true), { kind: 'quoted', open: showQuoted }, ...(showQuoted ? paragraphs(plain.quoted, false) : [])]
          : message.paragraphs.length
            ? paragraphs(message.paragraphs, true)
            : [{ kind: 'loading' }]
  return [{ kind: 'head' }, ...body, { kind: 'foot' }]
}

/** Find rows for the reader's pieces, with the lowercased text kept so each keystroke only scans. */
export function readerSearchRows(items: readonly ({ kind: string; key: string; part?: MessagePart })[]): ReaderSearchRow[] {
  return items.flatMap((item) => {
    if (!item.part) return []
    const text = bodySearchText(item.part)
    return text ? [{ key: item.key, text, lower: text.toLocaleLowerCase() }] : []
  })
}

export function bodySearchText(part: MessagePart) {
  if (part.kind === 'markdown') return markdownSearchText(part.source)
  if (part.kind === 'paragraphs') return part.blocks.map((block) => Array.isArray(block) ? block.join('\n') : block).join('\n')
  return ''
}

/**
 * Line lengths of a paragraph that hasn't arrived. Fixed, not random: a skeleton that reshuffles on
 * every render reads as the page glitching rather than as mail on its way.
 */
const SKELETON_LINES = [
  [0.96, 0.88, 0.94, 0.62],
  [0.92, 0.97, 0.7],
  [0.9, 0.84, 0.93, 0.55],
]

/**
 * The shape of a message while its body downloads: a few paragraphs of grey lines, breathing gently
 * so it reads as working rather than stuck. It stands in for text that is about to appear, so it is
 * sized like text — the message doesn't jump when the real words land.
 */
function BodySkeleton() {
  const { C } = useSettings()
  const [lit, setLit] = useState(false)
  useEffect(() => {
    const handle = setInterval(() => setLit((on) => !on), 900)
    return () => clearInterval(handle)
  }, [])
  return (
    <div testId="body-skeleton" style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 14, paddingBottom: 6, pointerEvents: 'none' }}>
      {SKELETON_LINES.map((paragraph, block) => (
        <div key={block} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {paragraph.map((width, line) => (
            <motion.div
              key={line}
              initial={false}
              animate={{ opacity: lit ? 0.75 : 0.35 }}
              // Each line follows the one above it, so the pulse travels down the message.
              transition={{ duration: 0.9, ease: 'easeInOut', delay: (block * 4 + line) * 0.05 }}
              style={{ height: 11, borderRadius: 5.5, width: `${Math.round(width * 100)}%`, backgroundColor: C.chip }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Above a full-view message whose HTML asks for images from the network: they stay hidden until the
 * person says otherwise, for this message or for everything this sender writes.
 */
function RemoteImageNotice({ sender, onShow, onAlways }: { sender: string; onShow: () => void; onAlways: () => void }) {
  const { C } = useSettings()
  return (
    <div
      testId="remote-images-notice"
      style={{
        marginBottom: 12,
        padding: 10,
        borderRadius: 7,
        backgroundColor: C.overlay,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Icon name="eye" size={15} color={C.muted} />
      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, lineHeight: 18, color: C.secondary, fontFamily: FONT }}>
        Remote images are hidden to stop senders knowing when you read this.
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <Button label="Show images" variant="ghost" onClick={onShow} testId="show-remote-images" />
        <Button label={`Always show from ${sender}`} variant="ghost" onClick={onAlways} testId="always-show-remote-images" />
      </div>
    </div>
  )
}

type MessageBlockProps = {
  /** All a block draws from its conversation; the whole of it would re-render every block on a star or a label. */
  thread: ThreadRef
  /** The conversation as it is now, for the actions that take all of it when chosen (notes, task, print). */
  threadOf: () => MailThread
  /** Handlers take the message so the reader can pass one stable function to every block (see memo below). */
  onToggleQuoted: (message: Message) => void
  /** This message's remote images were shown for this read, whatever the sender's standing is. */
  showImages: boolean
  onShowImages: (message: Message) => void
  onComposeLink: (draft: DraftFields) => void
  /** This virtualized body row owns its own match numbering. */
  find?: { query: string; activeIndex?: number }
  message: Message
  /** Which piece of the message this item draws: the reader lists pieces, not whole messages (see messageParts). */
  part: MessagePart
  /** Opens this message, closing the one that was open (a single web view at a time). */
  onOpen: (message: Message) => void
  onReply: (message: Message, mode: ReplyMode) => void
  onForward: (message: Message) => void
  onRetry: (message: Message) => void
  onConfirmSent: (message: Message) => void
}

// Typing a reply re-renders the reader on every keystroke; blocks whose props hold still skip it.
const MessageBlock = memo(MessageBlockView, (a, b) => {
  for (const key of Object.keys(a) as (keyof MessageBlockProps)[]) {
    if (key === 'find' ? !shallowEqual(a.find, b.find) : a[key] !== b[key]) return false
  }
  return Object.keys(a).length === Object.keys(b).length
})

function MessageBlockView({
  thread,
  threadOf,
  message,
  onOpen: openOf,
  onReply: replyTo,
  onForward: forwardOf,
  onRetry: retryOf,
  onConfirmSent: confirmSentOf,
  part,
  onToggleQuoted: toggleQuotedOf,
  showImages,
  onShowImages: showImagesOf,
  onComposeLink,
  find,
}: MessageBlockProps) {
  const onReply = (mode: ReplyMode) => replyTo(message, mode)
  const onForward = () => forwardOf(message)
  const onRetry = () => retryOf(message)
  const onConfirmSent = () => confirmSentOf(message)
  const onToggleQuoted = () => toggleQuotedOf(message)
  const onShowImages = () => showImagesOf(message)
  const { settings, update, C } = useSettings()
  const renderer = useGpuixRequired()
  countRender('MessageBlock')
  const mailActions = useMailActions()
  const { notify, getAttachment, getOriginalMessage, openAttachment } = mailActions
  const [details, setDetails] = useState(false)
  const [linkReview, setLinkReview] = useState<LinkReviewRequest | null>(null)
  const [attachmentBusy, setAttachmentBusy] = useState<string | null>(null)
  const [original, setOriginal] = useState<{ path: string; headers: string } | 'loading' | null>(null)
  const menu = useToggle()
  const unsubscribeMenu = useToggle()
  const canShowOriginal = thread.id.includes(':') && /-\d+$/.test(message.id)
  const allowImages = showImages || remoteImagesAllowed(settings, message.email)
  // The body is scanned once per message, not on every scroll frame that re-renders this piece.
  // Pictures worth asking about: tracking pixels never load, so mail with nothing else doesn't ask.
  const remoteImages = useMemo(() => Boolean(message.html) && hasRemoteImages(withoutTrackers(message.html!)), [message.html])
  // The newest message's sign-in code or link, while it's fresh (src/sign-in-code.ts).
  // Only the head shows them; a code arrives with its message, so this re-renders when it does.
  const whole = part.kind === 'head' ? threadOf() : null
  const newest = whole?.messages.at(-1)?.id === message.id
  const signInCode = whole && newest ? freshCode(whole) : null
  const signInLink = whole && newest && whole.signIn?.kind === 'link' && signInFresh(whole.at) ? whole.signIn.url : null
  // The page the HTML view shows: the sender's HTML, or the message's text made into a page.
  const page = useMemo(() => (part.kind === 'full' ? messagePage(message) : null), [part.kind, message])
  // Tracking pixels never load, even once remote images are shown (trackers.ts).
  const trackers = useMemo(() => (part.kind === 'full' && message.html ? countTrackers(message.html) : 0), [part.kind, message.html])
  const shownPage = useMemo(() => (page && allowImages && trackers ? withoutTrackers(page) : page), [page, allowImages, trackers])
  // The window's size is read when a link is chosen: a live one polled the window ten times a second
  // in every block on screen, and re-rendered every block's body on a resize.
  const reviewLink = useCallback((raw: string, position?: LinkPosition) => {
    const size = windowSizeOf(renderer)
    setLinkReview({
      raw,
      position: position ?? { x: Math.max(24, size.width * 0.5), y: Math.max(64, size.height * 0.32) },
    })
  }, [renderer])
  const saveAttachment = async (attachment: Attachment, index: number) => {
    const destination = pickAttachmentDestination(attachment.name)
    if (!destination) return
    setAttachmentBusy(`save-${index}`)
    try {
      const result = await getAttachment(message.id, index, attachment)
      if (!result.ok) return notify(`Couldn't save ${attachment.name}: ${result.error}`)
      await saveAttachmentTo(result.attachment.path, destination)
      notify(`Saved ${attachment.name}`)
    } catch (error) {
      notify(`Couldn't save ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAttachmentBusy(null)
    }
  }
  const saveAllAttachments = async () => {
    const directory = pickAttachmentDirectory()
    if (!directory || !message.attachments?.length) return
    setAttachmentBusy('all')
    const local: Array<Attachment & { path: string }> = []
    try {
      for (const [index, attachment] of message.attachments.entries()) {
        const result = await getAttachment(message.id, index, attachment)
        if (!result.ok) throw new Error(`${attachment.name}: ${result.error}`)
        local.push(result.attachment)
      }
      let saved = 0
      try {
        for (const attachment of local) {
          await saveAttachmentInDirectory(attachment.path, directory, attachment.name)
          saved++
        }
      } catch (error) {
        throw new Error(`${saved} of ${local.length} saved. ${error instanceof Error ? error.message : String(error)}`)
      }
      notify(`Saved ${local.length} ${local.length === 1 ? 'attachment' : 'attachments'}`)
    } catch (error) {
      notify(`Couldn't save all attachments: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAttachmentBusy(null)
    }
  }
  const previewAttachment = async (attachment: Attachment, index: number) => {
    if (attachmentBusy) return
    setAttachmentBusy(`preview-${index}`)
    try {
      const result = await getAttachment(message.id, index, attachment)
      if (!result.ok) return notify(`Couldn't preview ${attachment.name}: ${result.error}`)
      const preview = await previewFile(result.attachment.path)
      if (!preview.ok) notify(`Couldn't preview ${attachment.name}: ${preview.error}`)
    } catch (error) {
      notify(`Couldn't preview ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAttachmentBusy(null)
    }
  }
  const showOriginal = async () => {
    if (original === 'loading') return
    setOriginal('loading')
    try {
      const result = await getOriginalMessage(message.id)
      if (!result.ok) {
        setOriginal(null)
        return notify(`Couldn't load original message: ${result.error}`)
      }
      setOriginal({ path: result.path, headers: await readRawHeaders(result.path) })
    } catch (error) {
      setOriginal(null)
      notify(`Couldn't load original message: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const exportOriginal = async () => {
    if (!original || original === 'loading') return
    const destination = pickOriginalDestination(thread.subject)
    if (!destination) return
    try {
      await saveOriginalTo(original.path, destination)
      notify('Original message exported')
    } catch (error) {
      notify(`Couldn't export original message: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const composeUnsubscribe = () => {
    const draft = message.unsubscribe?.mailto ? draftFromMailto(message.unsubscribe.mailto) : null
    unsubscribeMenu.close()
    if (draft) onComposeLink(draft)
    else notify("Couldn't prepare the unsubscribe request")
  }
  const reviewUnsubscribeLink = () => {
    const link = message.unsubscribe?.link ?? message.unsubscribe?.oneClick
    unsubscribeMenu.close()
    if (link) reviewLink(link)
  }
  const print = () => {
    if (!printReaderText('Jefi Mail', printableThread(threadOf(), message))) notify("Couldn't open the print panel")
  }
  const copy = (text: string, what: string) => notify(copyLink(text) ? `${what} copied` : "Couldn't copy")
  // Right-click: copy what's selected, or the message, plus the ⋯ menu's actions. The Full view is a
  // native web view laid over this block that takes its own right-clicks (WebKit's menu).
  const contextMenu = useContextMenu()
  const onContext = contextMenu((): ContextItem[] => {
    const selected = renderer.getSelectedText?.() ?? ''
    return [
      ...(selected.trim() ? [{ label: 'Copy', icon: 'copy', onSelect: () => copy(selected, 'Selection'), testId: 'ctx-message-copy' } as ContextItem] : []),
      ...(message.bodyMissing ? [] : [{ label: 'Copy message text', icon: 'copy', onSelect: () => copy(messageText(message), 'Message text'), testId: 'ctx-message-copy-text' } as ContextItem]),
      { label: 'Copy sender address', icon: 'atSign', onSelect: () => copy(message.email, 'Address'), testId: 'ctx-message-copy-address' },
      'separator',
      { label: 'Reply', icon: 'reply', onSelect: () => onReply('reply'), testId: 'ctx-message-reply' },
      { label: 'Reply all', icon: 'replyAll', onSelect: () => onReply('replyAll') },
      { label: 'Forward', icon: 'forward', onSelect: onForward },
      ...(canShowOriginal
        ? [
            { label: 'Add to notes', icon: 'pencil', onSelect: () => void addMessageToNotes(mailActions, threadOf(), message) } as ContextItem,
            { label: 'Make task', icon: 'circleCheck', onSelect: () => void makeTaskFromMessage(mailActions, threadOf(), message) } as ContextItem,
          ]
        : []),
      'separator',
      { label: 'Print message / Save PDF', icon: 'printer', onSelect: print },
    ]
  })
  return (
    <div
      onAuxClick={onContext}
      highlight={find ? { query: find.query, activeIndex: find.activeIndex, color: C.chip, activeColor: C.amber } : null}
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingLeft: READ_PAD_LEFT,
        paddingRight: READ_PAD_RIGHT,
        paddingTop: part.kind === 'head' ? 12 : part.kind === 'collapsed' ? 6 : 0,
        paddingBottom: part.kind === 'foot' ? 16 : part.kind === 'collapsed' ? 6 : 0,
      }}
    >
      {part.kind === 'collapsed' ? (
        <div
          testId={`message-collapsed-${message.id}`}
          onClick={() => openOf(message)}
          style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, height: 36, cursor: 'pointer', hover: { opacity: 0.8 } }}
        >
          <Face {...message.face} size={28} />
          <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0 }}>{message.from}</text>
          <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', flexGrow: 1, minWidth: 0, textOverflow: 'ellipsis' }}>
            {plainSnippet(messageText(message))}
          </text>
          <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0 }}>{message.time}</text>
        </div>
      ) : null}
      {part.kind === 'head' ? (
        <>
          {/* Header: avatar beside the sender. The body below starts at the avatar's edge, not indented past it. */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Face {...message.face} size={36} />
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', height: 20 }}>
                <text style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{message.from}</text>
                <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', marginLeft: 8, flexGrow: 1, minWidth: 0, textOverflow: 'ellipsis' }}>
                  {`<${message.email}>`}
                </text>
                {message.status === 'sending' ? (
                  <div testId={`message-sending-${message.id}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <Spinner size={12} color={C.accent} />
                    <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap' }}>Sending…</text>
                  </div>
                ) : message.status === 'unconfirmed' ? (
                  // The server may have it: no one-click retry, which could deliver it twice.
                  <div testId={`message-unconfirmed-${message.id}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <Icon name="alertCircle" size={13} color={C.accent} />
                    <text style={{ fontSize: 12.5, fontWeight: 500, color: C.accent, fontFamily: FONT, whiteSpace: 'nowrap', paddingLeft: 4, paddingRight: 4 }}>Not confirmed</text>
                    {([['It was sent', onConfirmSent, 'confirm'], ['Send again', onRetry, 'retry']] as const).map(([label, run, id]) => (
                      <div key={id} testId={`message-unconfirmed-${id}-${message.id}`} onClick={run} style={{ paddingLeft: 6, paddingRight: 6, height: 22, borderRadius: 5, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}>
                        <text style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
                      </div>
                    ))}
                  </div>
                ) : message.status === 'failed' ? (
                  <div
                    testId={`message-retry-${message.id}`}
                    onClick={onRetry}
                    style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, paddingLeft: 6, paddingRight: 6, height: 22, borderRadius: 5, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
                  >
                    <Icon name="alertCircle" size={13} color={C.accent} />
                    <text style={{ fontSize: 12.5, fontWeight: 500, color: C.accent, fontFamily: FONT, whiteSpace: 'nowrap' }}>Not sent · Retry</text>
                  </div>
                ) : (
                  <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0 }}>{message.time}</text>
                )}
                {signInCode ? (
                  <div style={{ flexShrink: 0, marginLeft: 8 }}>
                    <SignInCodePill code={signInCode} size="large" testId={`message-sign-in-code-${message.id}`} />
                  </div>
                ) : signInLink ? (
                  // Reviewed like any link in the message: sign-in mail is what phishing imitates.
                  <div
                    testId={`message-sign-in-link-${message.id}`}
                    onClick={() => reviewLink(signInLink)}
                    style={{ flexShrink: 0, marginLeft: 8, height: 24, paddingLeft: 10, paddingRight: 10, borderRadius: 12, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.chip, cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
                  >
                    <Icon name="lock" size={12} color={C.accent} />
                    <text style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>Sign in</text>
                  </div>
                ) : null}
                {message.unsubscribe ? (
                  <div style={{ flexShrink: 0, marginLeft: 6 }}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label="Review unsubscribe options"
                      testId={`message-unsubscribe-${message.id}`}
                      onClick={unsubscribeMenu.toggle}
                      onKeyDown={(event) => {
                        if (event.key === 'enter' || event.key === 'space' || event.key === ' ') unsubscribeMenu.toggle()
                      }}
                      style={{ height: 20, paddingLeft: 6, paddingRight: 6, borderRadius: 4, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
                    >
                      <text style={{ fontSize: 11.5, fontWeight: 500, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>Unsubscribe</text>
                    </div>
                    <Menu open={unsubscribeMenu.open} onClose={unsubscribeMenu.close} align="end" width={320}>
                      <MenuLabel>Unsubscribe options from this message</MenuLabel>
                      <div style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 5 }}>
                        <text style={{ fontSize: 11.5, lineHeight: 16, color: C.muted, fontFamily: FONT }}>
                          Jefi will open or compose the request for your review. Nothing is sent automatically.
                        </text>
                      </div>
                      {message.unsubscribe.link || message.unsubscribe.oneClick ? (
                        <MenuItem icon="externalLink" label="Review unsubscribe page" testId={`unsubscribe-review-link-${message.id}`} onSelect={reviewUnsubscribeLink} />
                      ) : null}
                      {message.unsubscribe.mailto ? (
                        <MenuItem icon="mail" label="Compose unsubscribe request" testId={`unsubscribe-compose-${message.id}`} onSelect={composeUnsubscribe} />
                      ) : null}
                    </Menu>
                  </div>
                ) : null}
                <div style={{ width: 8, flexShrink: 0 }} />
                <IconButton icon="reply" size={16} pad={26} onClick={() => onReply('reply')} testId={`message-reply-${message.id}`} />
                <div style={{ width: 4, flexShrink: 0 }} />
                <div style={{ flexShrink: 0 }}>
                  <IconButton icon="more" size={16} pad={26} active={menu.open} onClick={menu.toggle} testId={`message-more-${message.id}`} />
                  <Menu open={menu.open} onClose={menu.close} align="end" width={180}>
                    <MenuItem icon="reply" label="Reply" onSelect={() => { menu.close(); onReply('reply') }} />
                    <MenuItem icon="replyAll" label="Reply all" onSelect={() => { menu.close(); onReply('replyAll') }} />
                    <MenuItem icon="forward" label="Forward" testId={`message-forward-${message.id}`} onSelect={() => { menu.close(); onForward() }} />
                    {canShowOriginal ? <MenuItem icon="pencil" label="Add to notes" testId={`message-add-to-notes-${message.id}`} onSelect={() => { menu.close(); void addMessageToNotes(mailActions, threadOf(), message) }} /> : null}
                    {canShowOriginal ? <MenuItem icon="circleCheck" label="Make task" testId={`message-make-task-${message.id}`} onSelect={() => { menu.close(); void makeTaskFromMessage(mailActions, threadOf(), message) }} /> : null}
                    <MenuSeparator />
                    {canShowOriginal ? <MenuItem icon="file" label={original === 'loading' ? 'Loading original…' : 'View original'} testId={`message-original-${message.id}`} onSelect={() => { menu.close(); void showOriginal() }} /> : null}
                    <MenuItem icon="printer" label="Print message / Save PDF" testId={`message-print-${message.id}`} onSelect={() => { menu.close(); print() }} />
                  </Menu>
                </div>
              </div>
              <div
                testId={`message-details-${message.id}`}
                onClick={() => setDetails((v) => !v)}
                style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, height: 18, cursor: 'pointer', hover: { opacity: 0.75 } }}
              >
                <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{`to ${message.toAddresses?.length ? message.toAddresses.map((address) => address.name || address.email).join(', ') : message.to}`}</text>
                <Icon name={details ? 'chevronDown' : 'chevronRight'} size={12} color={C.muted} />
              </div>
            </div>
          </div>
          {details ? (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 7, backgroundColor: C.overlay, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {messageDetailRows(message).map(([label, value]) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
                  <text style={{ width: 82, flexShrink: 0, fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
                  <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>{value}</text>
                </div>
              ))}
            </div>
          ) : null}
          {/* Its calendar invite, or dates worth adding to the calendar. */}
          <MessageCalendar thread={thread} message={message} />
        </>
      ) : null}

      {/* Body, one piece per list item */}
      {part.kind === 'full' ? (
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 14 }}>
          {trackers ? (
            <div testId={`trackers-blocked-${message.id}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Icon name="shieldCheck" size={13} color={C.muted} />
              <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{`${trackers} ${trackers === 1 ? 'tracker' : 'trackers'} blocked`}</text>
            </div>
          ) : null}
          {remoteImages && !allowImages ? (
            <RemoteImageNotice
              sender={message.from}
              onShow={onShowImages}
              onAlways={() => update({ remoteImageSenders: allowRemoteImagesFrom(settings, message.email) })}
            />
          ) : null}
          <WindowFittedHtml
            html={shownPage!}
            allowRemoteImages={allowImages}
            onLink={reviewLink}
            linkDisclosure={find ? undefined : { sender: message.email, trustedDomains: settings.trustedLinkDomains }}
          />
        </div>
      ) : part.kind === 'markdown' ? (
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: part.first ? 14 : 10 }}>
          <MailMarkdown source={part.source} testId={part.first ? `message-body-${message.id}` : undefined} onLink={reviewLink} linkDisclosure={find ? undefined : { sender: message.email, trustedDomains: settings.trustedLinkDomains }} />
        </div>
      ) : part.kind === 'paragraphs' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: part.first ? 14 : 10 }}>
          {part.blocks.map((block, index) => find
            ? <MailMarkdown key={index} source={plainTextMarkdown(block)} prepared onLink={reviewLink} />
            : <Paragraph key={index} block={block} onLink={reviewLink} sender={message.email} trustedDomains={settings.trustedLinkDomains} />)}
        </div>
      ) : part.kind === 'quoted' ? (
        <div style={{ display: 'flex', flexDirection: 'row', paddingTop: 10 }}>
          <Tooltip label={part.open ? 'Hide quoted text' : 'Show quoted text'}>
            <div
              testId={`quoted-${message.id}`}
              onClick={onToggleQuoted}
              style={{ height: 18, paddingLeft: 8, paddingRight: 8, borderRadius: 9, backgroundColor: part.open ? C.overlayStrong : C.chip, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
            >
              <text style={{ fontSize: 12, fontWeight: 700, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>•••</text>
            </div>
          </Tooltip>
        </div>
      ) : part.kind === 'loading' ? (
        // Not downloaded yet: the engine is fetching it from the server.
        <BodySkeleton />
      ) : null}

      {/* Attachments */}
      {part.kind === 'foot' && message.attachments && message.attachments.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 12 }}>
          <div style={{ height: 1, backgroundColor: C.divider }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingTop: 6 }}>
            <text style={{ flexGrow: 1, fontSize: 12.5, lineHeight: 18, color: C.secondary, fontFamily: FONT }}>
              {message.attachments.length === 1 ? '1 attachment' : `${message.attachments.length} attachments`}
            </text>
            <Button label={attachmentBusy === 'all' ? 'Saving…' : 'Save all'} variant="ghost" disabled={Boolean(attachmentBusy)} onClick={() => void saveAllAttachments()} testId={`attachments-save-all-${message.id}`} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {message.attachments.map((attachment, index) => (
              <AttachmentCard
                key={`${index}-${attachment.name}`}
                attachment={attachment}
                busy={Boolean(attachmentBusy)}
                onOpen={() => openAttachment(message.id, index, attachment)}
                onPreview={() => void previewAttachment(attachment, index)}
                onSave={() => void saveAttachment(attachment, index)}
              />
            ))}
          </div>
        </div>
      ) : null}
      {linkReview ? (
        <LinkPopover
          key={linkReview.raw}
          raw={linkReview.raw}
          sender={message.email}
          trustedDomains={settings.trustedLinkDomains}
          position={linkReview.position}
          onClose={() => setLinkReview(null)}
          onOpen={(url) => {
            if (!openExternalLink(url)) notify("Couldn't open this link")
          }}
          onCompose={onComposeLink}
          onCopy={(url) => notify(copyLink(url) ? 'Link copied' : "Couldn't copy link")}
        />
      ) : null}
      {original && original !== 'loading' ? (
        <OriginalMessageModal
          headers={original.headers}
          onClose={() => setOriginal(null)}
          onCopy={() => notify(copyLink(original.headers) ? 'Headers copied' : "Couldn't copy headers")}
          onExport={() => void exportOriginal()}
        />
      ) : null}
    </div>
  )
}

export function ReplyComposer({
  thread,
  message,
  mode,
  draft: readDraft,
  hasDraft,
  shown,
  onMode,
  onType,
  onDraft,
  onExpand,
}: {
  thread: MailThread
  message: Message
  mode: ReplyMode
  /** The reply's latest text: typing doesn't re-render the composer, so it's read when needed. */
  draft: () => string
  /** Whether there's any text, which Send and the AI button show. */
  hasDraft: boolean
  /** The text the field mounts with (it keeps its own after that). */
  shown: string
  onMode: (mode: ReplyMode) => void
  /** Each keystroke's text. */
  onType: (value: string) => void
  /** Text set from outside the field (a toolbar insert, AI, sending); the field is remounted with it. */
  onDraft: (value: string) => void
  /** A reply names the message it answers; a forward (no `parentMessageId`) starts a new conversation. */
  onExpand: (initial: DraftFields, parentMessageId?: string) => void
}) {
  const { C } = useSettings()
  countRender('ReplyComposer')
  const accounts = useMailSelector((store) => store.accounts)
  const { reply, accountOf, notify, getAttachment } = useMailActions()
  const sendMenu = useToggle()
  const modeMenu = useToggle()
  // Toolbar inserts replace the value wholesale; remount so native text follows.
  const [key, setKey] = useState(0)
  const [forwarding, setForwarding] = useState(false)

  // The selected AI provider drafts the reply. Whatever is typed is the instruction; the draft replaces it.
  const ai = useAi()
  const [drafting, setDrafting] = useState(false)
  const draftAbort = useRef<AbortController | null>(null)
  useAbortOnUnmount(draftAbort)

  // The composer stays put from one conversation to the next (see ReadingPane); what belonged to the
  // last one goes: open menus, a forward being prepared, an AI draft still streaming into it.
  const lastThread = useRef(thread.id)
  if (lastThread.current !== thread.id) {
    lastThread.current = thread.id
    draftAbort.current?.abort()
    if (key !== 0) setKey(0)
    if (forwarding) setForwarding(false)
    if (drafting) setDrafting(false)
    if (sendMenu.open) sendMenu.close()
    if (modeMenu.open) modeMenu.close()
  }
  const draftWithAi = () => {
    if (!ai.connection || drafting) return
    const instruction = readDraft()
    const abort = (draftAbort.current = new AbortController())
    const me = accountOf(thread.id)
    let text = ''
    let last = 0
    // The field only follows its value when remounted, so refresh it a few times a second while streaming.
    const show = (force = false) => {
      if (!force && Date.now() - last < 120) return
      last = Date.now()
      onDraft(text)
      setKey((k) => k + 1)
    }
    setDrafting(true)
    draftReply(ai.connection, thread, { name: me.name, email: me.email }, instruction, {
      signal: abort.signal,
      onText: (delta) => {
        text += delta
        show()
      },
    })
      .then((final) => {
        text = final.trim()
        show(true)
      })
      .catch((error) => {
        if (abort.signal.aborted) return
        onDraft(instruction)
        setKey((k) => k + 1)
        notify(`Couldn't draft a reply: ${aiErrorMessage(error)}`)
      })
      .finally(() => setDrafting(false))
  }
  const recipients = replyRecipients(message, mode, accounts.map((item) => item.email))
  const recipientLabels = [...recipients.to, ...recipients.cc].map((address) => findContact(address)?.name ?? address)
  const hasRecipients = recipientLabels.length > 0
  const canSend = hasRecipients && hasDraft

  const fields = (): DraftFields => ({
    ...recipients,
    bcc: [],
    subject: replySubject(thread.subject),
    body: readDraft(),
  })

  const send = (archive = false) => {
    const text = readDraft()
    if (!hasRecipients || !text.trim()) return
    const threadId = thread.id
    const sent = reply(threadId, { body: text, ...recipients, parentMessageId: message.id }, {
      archive,
      // Undo puts the text back in this conversation's reply box, even if it has been left since.
      onUndo: () => {
        const since = replyTexts.get(threadId)?.trim()
        const restored = since ? `${text}\n\n${since}` : text
        replyTexts.set(threadId, restored)
        onDraft(restored)
        setKey((k) => k + 1)
      },
    })
    if (!sent) return
    onDraft('')
    setKey((k) => k + 1)
  }
  const forwardInstead = async () => {
    if (forwarding) return
    modeMenu.close()
    setForwarding(true)
    if (message.attachments?.length) notify(`Preparing ${message.attachments.length === 1 ? message.attachments[0]!.name : `${message.attachments.length} attachments`}…`)
    try {
      const result = await prepareForwardDraft(thread, message, getAttachment)
      if (!result.ok) return notify(`Couldn't prepare forward: ${result.error}`)
      onExpand({ ...result.draft, body: `${readDraft()}${result.draft.body}` })
    } catch (error) {
      notify(`Couldn't prepare forward: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setForwarding(false)
    }
  }

  const modes: Array<{ id: ReplyMode; label: string }> = [
    { id: 'reply', label: 'Reply' },
    { id: 'replyAll', label: 'Reply all' },
  ]
  const insert = (snippet: string) => {
    const draft = readDraft()
    onDraft(`${draft}${draft && !draft.endsWith(' ') && !draft.endsWith('\n') ? ' ' : ''}${snippet}`)
    setKey((k) => k + 1)
  }
  return (
    <div style={{ flexShrink: 0, paddingLeft: READ_PAD_LEFT, paddingRight: READ_PAD_RIGHT, paddingTop: 4, paddingBottom: 14, display: 'flex', flexDirection: 'column' }}>
      {/* One card: who it goes to on top, the text, then the tools and Send along the bottom. */}
      <div style={{ borderRadius: 14, backgroundColor: C.raised, display: 'flex', flexDirection: 'column', paddingTop: 6, paddingBottom: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', height: 30, gap: 2, paddingLeft: 6, paddingRight: 6 }}>
          {modes.map((item) => {
            const active = item.id === mode
            return (
              <div
                key={item.id}
                testId={`mode-${item.id}`}
                onClick={() => onMode(item.id)}
                style={{
                  height: 24,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 12,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  backgroundColor: active ? C.overlayStrong : undefined,
                  hover: active ? undefined : { backgroundColor: C.overlay },
                }}
              >
                <text style={{ fontSize: 12.5, fontWeight: 500, color: active ? C.text : C.muted, fontFamily: FONT }}>{item.label}</text>
              </div>
            )
          })}
          <text style={{ flexGrow: 1, minWidth: 0, marginLeft: 8, fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {hasRecipients ? `to ${recipientLabels.join(', ')}` : 'No reply address available'}
          </text>
          <div style={{ flexShrink: 0 }}>
            <IconButton icon="more" size={15} pad={26} active={modeMenu.open} onClick={modeMenu.toggle} testId="reply-more" />
            <Menu open={modeMenu.open} onClose={modeMenu.close} side="top" align="end" width={200}>
              <MenuItem icon="maximize" label="Open in full composer" testId="reply-expand" onSelect={() => { modeMenu.close(); onExpand(fields(), message.id) }} />
              <MenuItem
                icon="forward"
                label={forwarding ? 'Preparing forward…' : 'Forward instead'}
                onSelect={() => void forwardInstead()}
              />
            </Menu>
          </div>
        </div>

        <div style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 4 }}>
          <textarea
            // Per conversation too: the field keeps the native text typed into it, and the next
            // conversation's reply (or none) has to replace it.
            key={`${thread.id}:${key}`}
            testId="composer"
            autoFocus={key > 0}
            value={shown}
            placeholder="Write a reply…"
            minRows={2}
            maxRows={10}
            onChange={(event) => onType(event.value ?? '')}
            style={{ fontSize: 14, lineHeight: 20, fontFamily: FONT, color: C.text }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', height: 32, paddingLeft: 8, paddingRight: 8, gap: 2, marginTop: 4 }}>
          <IconButton icon="maximize" size={15} pad={28} onClick={() => onExpand(fields(), message.id)} testId="reply-tool-expand" />
          <IconButton icon="bold" size={15} pad={28} testId="reply-tool-bold" onClick={() => insert('**bold**')} />
          <IconButton icon="link" size={15} pad={28} testId="reply-tool-link" onClick={() => insert('[link text](https://)')} />
          <IconButton icon="paperclip" size={15} pad={28} onClick={() => onExpand(fields(), message.id)} testId="reply-tool-attach" />
          {ai.enabled ? (
            drafting ? (
              <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Spinner size={13} color={C.accent} />
              </div>
            ) : (
              <IconButton
                icon="sparkles"
                size={15}
                pad={28}
                tooltip={hasDraft ? `Draft with ${ai.providerName} from what you typed` : `Draft a reply with ${ai.providerName}`}
                onClick={draftWithAi}
                testId="reply-tool-ai"
              />
            )
          ) : null}
          <div style={{ flexGrow: 1 }} />
          <div style={{ flexShrink: 0 }}>
            <IconButton icon="chevronDown" size={14} pad={28} active={sendMenu.open} tooltip="More ways to send" onClick={sendMenu.toggle} testId="send-options" />
            <Menu open={sendMenu.open} onClose={sendMenu.close} side="top" align="end" width={190}>
              <MenuItem icon="archive" label="Send and archive" testId="send-archive" onSelect={() => { sendMenu.close(); send(true) }} />
            </Menu>
          </div>
          <div
            testId="send"
            onClick={() => send()}
            style={{
              width: 32,
              height: 32,
              marginLeft: 4,
              borderRadius: 16,
              flexShrink: 0,
              opacity: canSend ? 1 : 0.4,
              backgroundColor: C.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              hover: canSend ? { backgroundColor: C.accentHover } : undefined,
              active: canSend ? { backgroundColor: C.accentActive } : undefined,
            }}
          >
            <Icon name="send" size={15} color={C.onAccent} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolbarMenuButton({ icon, testId, children, width = 200, conversation }: { icon: IconName; testId: string; children: (close: () => void) => ReactNode; width?: number; conversation: string }) {
  const menu = useToggle()
  // Kept from one conversation to the next: a menu left open was about the last one.
  const shownFor = useRef(conversation)
  if (shownFor.current !== conversation) {
    shownFor.current = conversation
    if (menu.open) menu.close()
  }
  return (
    <div style={{ flexShrink: 0 }}>
      <IconButton icon={icon} size={17} active={menu.open} onClick={menu.toggle} testId={testId} />
      <Menu open={menu.open} onClose={menu.close} align="end" width={width}>
        {children(menu.close)}
      </Menu>
    </div>
  )
}

/**
 * The chips beside the subject: the mailbox (unless the mail lives only in custom folders), its
 * custom folders, then its labels. Only labels carry a colour dot.
 */
export function readerChips(thread: MailThread, folders: readonly MailFolder[], labels: readonly Label[]): Array<{ key: string; name: string; tone?: LabelTone }> {
  return [
    ...(thread.onlyInFolders ? [] : [{ key: 'mailbox', name: thread.screened ? 'Screener' : FOLDER_NAMES[thread.folder] }]),
    ...(thread.folders ?? []).map((path) => ({ key: `folder:${path}`, name: folders.find((f) => f.path === path)?.name ?? path })),
    ...labels.map((label) => ({ key: `label:${label.id}`, name: label.label, tone: label.color })),
  ]
}

/**
 * Inline replies being written, by conversation: glancing at another conversation and coming back
 * finds the reply as it was left.
 */
const replyTexts = new Map<string, string>()

/** The window's size now, or a stand-in while it's still opening. */
function windowSizeOf(renderer: { getWindowSize?: () => { width: number; height: number } | null | undefined }) {
  try {
    const size = renderer.getWindowSize?.()
    if (size && size.width > 0 && size.height > 0) return size
  } catch {}
  return { width: 800, height: 600 }
}

/** Full view as tall as the window allows: the one block that follows the window's size. */
function WindowFittedHtml(props: Omit<Parameters<typeof FullHtml>[0], 'height'>) {
  const { height } = useWindowSize()
  return <FullHtml {...props} height={Math.max(320, height - 300)} />
}

const READER_WINDOW = 12
const READER_OVERDRAW = 4

/** Memoized: re-renders when its conversation changes, not for every workspace render around it. */
export const ReadingPane = memo(ReadingPaneView)

function ReadingPaneView({
  thread,
  onCompose,
  onMove,
}: {
  thread: MailThread
  onCompose: (initial: DraftFields, replyTo?: string, parentMessageId?: string) => void
  /** Moving the conversation away (archive, trash, spam, back to the Inbox); the store's move by default. */
  onMove?: (id: string, folder: FolderId) => void
}) {
  // The open message: the newest, until another is opened. Kept per conversation, and dropped if the
  // message leaves it (a draft sent, a message deleted).
  const [opened, setOpened] = useState<{ threadId: string; messageId: string } | null>(null)
  const openId =
    opened?.threadId === thread.id && thread.messages.some((m) => m.id === opened.messageId) ? opened.messageId : (thread.messages.at(-1)?.id ?? '')
  const openMessage = useStableCallback((message: Message) => setOpened({ threadId: thread.id, messageId: message.id }))
  const scrollRef = useRef<PublicInstance>(null)
  const listRef = useRef<PublicInstance>(null)
  const renderer = useGpuixRequired()
  // The inline reply's text. Typing doesn't re-render the pane (a render per keystroke cost a whole
  // extra frame): `draft` holds the latest, `hasDraft` changes only when it empties or fills, and
  // `draftShown` only when something other than typing sets the text (and remounts the field).
  const draft = useRef(replyTexts.get(thread.id) ?? '')
  const [hasDraft, setHasDraft] = useState(() => draft.current.trim() !== '')
  const [draftShown, setDraftShown] = useState(draft.current)
  const typeDraft = (value: string) => {
    draft.current = value
    const has = value.trim() !== ''
    if (has) replyTexts.set(thread.id, value)
    else replyTexts.delete(thread.id)
    if (has !== hasDraft) setHasDraft(has)
  }
  const setDraft = (value: string) => {
    typeDraft(value)
    setDraftShown(value)
  }
  const readDraft = useStableCallback(() => draft.current)
  const [mode, setMode] = useState<ReplyMode>('reply')
  const [replyMessageId, setReplyMessageId] = useState(() => thread.messages.at(-1)?.id ?? '')
  const { C } = useSettings()
  countRender('ReadingPane')
  const { account, accounts, labels: accountLabels, folders } = useMailSelector((store) => ({ account: store.account, accounts: store.accounts, labels: store.labels, folders: store.folders }))
  // The labels this conversation can take: its own account's. In All Inboxes it may be another's,
  // whose labels aren't loaded here, so none are offered rather than the wrong account's.
  const owner = thread.id.includes(':') ? thread.id.split(':')[0]! : account.id
  const labels = owner === account.id ? accountLabels : accountLabels.filter((l) => l.id.startsWith(`gm:${owner}:`) || l.id.startsWith(`lb:${owner}:`))
  const { move: storeMove, toggleStar, setUnread, toggleLabel, snooze, deleteForever, addLabel, retryReply, confirmReplySent, retrySend, confirmSent, cancelSend, getAttachment, notify } = useMailActions()
  const move = onMove ?? storeMove
  const threadLabels = labels.filter((l) => thread.labels.includes(l.id))

  // Long mail (a big newsletter) drawn in one piece costs a full layout on every scroll frame, so the
  // conversation is a virtual list of pieces and only those near the viewport are mounted.
  /** Messages whose quoted history is unfolded. */
  const [showQuoted, setShowQuoted] = useState<Set<string>>(new Set())
  /** Messages whose remote images were shown for this read only; cleared with the conversation. */
  const [showImages, setShowImages] = useState<Set<string>>(new Set())
  const [forwarding, setForwarding] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  // The selected provider's summary of this conversation, while it runs and after.
  const ai = useAi()
  // The card holds a summary of the conversation, or a translation of the open message.
  type Summary = { threadId: string; kind: 'summary' | 'translation'; text: string; state: 'streaming' | 'done' | 'error'; error?: string }
  const [summary, setSummary] = useState<Summary | null>(null)
  const summaryAbort = useRef<AbortController | null>(null)
  const runCard = (kind: Summary['kind']) => {
    if (!ai.connection) return
    const open = thread.messages.find((m) => m.id === openId) ?? thread.messages.at(-1)
    if (kind === 'translation' && !open) return
    summaryAbort.current?.abort()
    const abort = (summaryAbort.current = new AbortController())
    const threadId = thread.id
    setSummary({ threadId, kind, text: '', state: 'streaming' })
    const stream = {
      signal: abort.signal,
      onText: (delta: string) => setSummary((prev) => (prev?.threadId === threadId ? { ...prev, text: prev.text + delta } : prev)),
    }
    ;(kind === 'translation' ? translateMessage(ai.connection, open!, readerLanguage(), stream) : summarizeThread(ai.connection, thread, stream))
      .then(() => setSummary((prev) => (prev?.threadId === threadId ? { ...prev, state: 'done' } : prev)))
      .catch((error) => {
        if (abort.signal.aborted) return
        setSummary((prev) => (prev?.threadId === threadId ? { ...prev, state: 'error', error: aiErrorMessage(error) } : prev))
      })
  }
  const summarize = () => runCard('summary')
  const translate = () => runCard('translation')
  const closeSummary = () => {
    summaryAbort.current?.abort()
    setSummary(null)
  }
  const shownSummary = summary?.threadId === thread.id ? summary : null

  type Item = { kind: 'top'; key: string } | { kind: 'summary'; key: string } | { kind: 'part'; key: string; message: Message; part: MessagePart; last: boolean }
  // The pieces only care whether a find is open, not what it says, so typing into find reruns the
  // match over cached text instead of re-chunking and re-normalizing every body per keystroke.
  const findActive = Boolean(findQuery.trim())
  const items = useMemo<Item[]>(
    () => [
      { kind: 'top', key: 'top' },
      ...(shownSummary ? [{ kind: 'summary' as const, key: 'summary' }] : []),
      ...thread.messages.flatMap((message, index) =>
        messageParts(
          message,
          findActive || !fullRenderingAvailable ? 'text' : message.id === openId ? 'html' : 'collapsed',
          findActive || showQuoted.has(message.id),
        ).map((part, i): Item => ({
          kind: 'part',
          key: `${message.id}:${i}`,
          message,
          part,
          last: index === thread.messages.length - 1,
        })),
      ),
    ],
    [thread.messages, openId, showQuoted, !!shownSummary, findActive],
  )
  const searchRows = useMemo(() => readerSearchRows(items), [items])
  const searchKeys = useMemo(() => new Set(searchRows.map((row) => row.key)), [searchRows])
  const findResult = useMemo(() => findReaderMatches(searchRows, findQuery), [searchRows, findQuery])
  const findMatches = findResult.matches
  const itemsRef = useRef(items)
  itemsRef.current = items
  const searchRowsRef = useRef(searchRows)
  searchRowsRef.current = searchRows
  const findMatchesRef = useRef(findMatches)
  findMatchesRef.current = findMatches
  const itemNodes = useRef(new Map<string, PublicInstance>())
  const scrollToMatch = (match: ReaderMatch) => {
    const list = listRef.current
    const index = itemsRef.current.findIndex((item) => item.key === match.key)
    if (index < 0 || !list) return
    renderer.scrollToItem?.(list.id, index, 0)
    const positionWithinRow = (attempt: number) => {
      const node = itemNodes.current.get(match.key)
      const bounds = node ? renderer.getElementBounds?.(node.id) : null
      if (!bounds && attempt < 4) {
        setTimeout(() => positionWithinRow(attempt + 1), 16)
        return
      }
      const text = searchRowsRef.current.find((row) => row.key === match.key)?.text ?? ''
      const estimate = bounds && text.length ? Math.max(0, (match.start / text.length) * bounds.height - 100) : 0
      renderer.scrollToItem?.(list.id, index, estimate)
      setTimeout(() => {
        const active = renderer.getPaintedHighlights?.().find((highlight) => highlight.active)?.rects[0]
        const readerBounds = scrollRef.current ? renderer.getElementBounds?.(scrollRef.current.id) : null
        const anchor = renderer.getListScrollTop?.(list.id)
        if (!active || !readerBounds || !anchor || anchor[0] !== index) return
        const targetY = readerBounds.y + Math.min(readerBounds.height * 0.35, 220)
        renderer.scrollToItem?.(list.id, index, Math.max(0, anchor[1]! + active.y - targetY))
      }, 16)
    }
    setTimeout(() => positionWithinRow(0), 16)
  }
  const moveFind = (direction: 1 | -1) => {
    if (!findMatches.length) return
    const next = (findIndex + direction + findMatches.length) % findMatches.length
    setFindIndex(next)
    setTimeout(() => scrollToMatch(findMatchesRef.current[next]!), 16)
  }
  const changeFind = (value: string) => {
    setFindQuery(value)
    setFindIndex(0)
    setTimeout(() => {
      const first = findMatchesRef.current[0]
      if (first) scrollToMatch(first)
    }, 16)
  }
  const toggleFind = () => {
    if (findOpen) {
      setFindOpen(false)
      setFindQuery('')
      setFindIndex(0)
    } else setFindOpen(true)
  }
  // ⌘F finds in the conversation, as in every Mac app.
  useKeys((press) => {
    if (!isCmd(press, 'f') || press.modifiers?.shift || press.modifiers?.alt) return false
    toggleFind()
    return true
  })
  const [range, setRange] = useState({ start: 0, end: READER_WINDOW })
  // The pane is kept from one conversation to the next (J/K rebuilt it whole, ~100-250 native
  // elements, for the few that differ); what belongs to a conversation is reset here instead.
  const lastThread = useRef(thread.id)
  const toTop = useRef(false)
  if (lastThread.current !== thread.id) {
    lastThread.current = thread.id
    toTop.current = true
    if (range.start !== 0 || range.end !== READER_WINDOW) setRange({ start: 0, end: READER_WINDOW })
    if (showQuoted.size) setShowQuoted(new Set())
    if (showImages.size) setShowImages(new Set())
    if (findQuery) setFindQuery('')
    if (findOpen) setFindOpen(false)
    if (findIndex) setFindIndex(0)
    if (forwarding) setForwarding(null)
    summaryAbort.current?.abort()
    if (summary) setSummary(null)
    // This conversation's inline reply, as it was left (see replyTexts).
    draft.current = replyTexts.get(thread.id) ?? ''
    if (hasDraft !== (draft.current.trim() !== '')) setHasDraft(!hasDraft)
    if (draftShown !== draft.current) setDraftShown(draft.current)
    if (mode !== 'reply') setMode('reply')
    const last = thread.messages.at(-1)?.id ?? ''
    if (replyMessageId !== last) setReplyMessageId(last)
  }
  // A new conversation starts at its top. The list is kept too, so it's scrolled there when the last
  // one was left scrolled (a scroll costs a frame of its own; GPUIX ignores one on a list just mounted).
  useLayoutEffect(() => {
    if (!toTop.current) return
    toTop.current = false
    const list = listRef.current
    if (!list) return
    const at = renderer.getListScrollTop?.(list.id)
    if (!at || at[0] !== 0 || at[1] !== 0) renderer.scrollToItem?.(list.id, 0, 0)
  }, [thread.id])
  const onVisibleRange = (event: { startIndex?: number; endIndex?: number }) => {
    geometryMayChange()
    const start = Math.max(0, (event.startIndex ?? 0) - READER_OVERDRAW)
    const end = Math.min(items.length, (event.endIndex ?? READER_WINDOW) + READER_OVERDRAW)
    if (start !== range.start || end !== range.end) setRange({ start, end })
  }
  const inTrash = thread.folder === 'trash'

  const forward = async (message: Message) => {
    if (forwarding) return
    setForwarding(message.id)
    if (message.attachments?.length) notify(`Preparing ${message.attachments.length === 1 ? message.attachments[0]!.name : `${message.attachments.length} attachments`}…`)
    try {
      const result = await prepareForwardDraft(thread, message, getAttachment)
      if (!result.ok) return notify(`Couldn't prepare forward: ${result.error}`)
      onCompose(result.draft)
    } catch (error) {
      notify(`Couldn't prepare forward: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setForwarding(null)
    }
  }

  const ownIdentities = accounts.map((item) => item.email)
  const replyMessage = thread.messages.find((message) => message.id === replyMessageId) ?? thread.messages.at(-1)!
  const replyFull = (message: Message, replyMode: ReplyMode) => {
    onCompose(buildReplyDraft(thread, message, replyMode, ownIdentities, draft.current), thread.id, message.id)
    // What was typed inline went with it.
    setDraft('')
  }

  // One identity for every message block, so the memoized blocks skip renders (keystrokes, sync) they don't need.
  const replyToMessage = useStableCallback((message: Message, replyMode: ReplyMode) => {
    if (draft.current.trim()) replyFull(message, replyMode)
    else {
      setReplyMessageId(message.id)
      setMode(replyMode)
    }
  })
  const forwardMessage = useStableCallback((message: Message) => void forward(message))
  const retryMessage = useStableCallback((message: Message) => retryReply(thread.id, message.id))
  const confirmMessageSent = useStableCallback((message: Message) => confirmReplySent(thread.id, message.id))
  const showMessageImages = useStableCallback((message: Message) => setShowImages((prev) => new Set(prev).add(message.id)))
  const composeLink = useStableCallback((initial: DraftFields) => onCompose(initial))
  const threadOf = useStableCallback(() => thread)
  const threadRef = useMemo(() => ({ id: thread.id, subject: thread.subject }), [thread.id, thread.subject])
  const toggleQuoted = useStableCallback((message: Message) =>
    setShowQuoted((prev) => {
      const next = new Set(prev)
      if (!next.delete(message.id)) next.add(message.id)
      return next
    }),
  )

  return (
    <div
      testId="reading-pane"
      style={{
        flexGrow: 1,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: C.reading,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: TOPBAR_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingRight: 16,
          gap: 6,
        }}
      >
        {thread.folder === 'outbox' ? null : (
          <ToolbarGroup>
            <MakeTaskButton thread={thread} />
            <AddToNotesButton thread={thread} />
          </ToolbarGroup>
        )}
        {ai.enabled ? (
          <ToolbarGroup>
            <IconButton icon="sparkles" size={17} active={shownSummary?.kind === 'summary'} tooltip={`Summarize with ${ai.providerName}`} onClick={summarize} testId="action-summarize" />
            <IconButton icon="languages" size={17} active={shownSummary?.kind === 'translation'} tooltip={`Translate with ${ai.providerName}`} onClick={translate} testId="action-translate" />
          </ToolbarGroup>
        ) : null}
        {inTrash ? (
          <ToolbarGroup>
            <IconButton icon="inbox" size={17} onClick={() => move(thread.id, 'inbox')} testId="action-restore" />
            <IconButton icon="trash" size={17} onClick={() => deleteForever(thread.id)} testId="action-delete-forever" />
          </ToolbarGroup>
        ) : (
          <ToolbarGroup>
            {thread.folder === 'archive' ? (
              <IconButton icon="inbox" size={17} onClick={() => move(thread.id, 'inbox')} testId="action-inbox" />
            ) : (
              <IconButton icon="archive" size={17} onClick={() => move(thread.id, 'archive')} testId="action-archive" />
            )}
            <IconButton icon="trash" size={17} onClick={() => move(thread.id, 'trash')} testId="action-trash" />
            <ToolbarMenuButton icon="clock" testId="action-snooze" width={180} conversation={thread.id}>
              {(close) => (
                <>
                  <MenuLabel>Snooze until</MenuLabel>
                  {SNOOZE_OPTIONS.map((option) => (
                    <MenuItem key={option} label={option} testId={`snooze-${option}`} onSelect={() => { close(); snooze(thread.id, option) }} />
                  ))}
                  {thread.folder === 'snoozed' ? (
                    <>
                      <MenuSeparator />
                      <MenuItem icon="inbox" label="Unsnooze" onSelect={() => { close(); move(thread.id, 'inbox') }} />
                    </>
                  ) : null}
                </>
              )}
            </ToolbarMenuButton>
            <ToolbarMenuButton icon="tag" testId="action-label" conversation={thread.id}>
              {(close) => (
                <>
                  <MenuLabel>Labels</MenuLabel>
                  {labels.map((label) => (
                    <MenuItem
                      key={label.id}
                      label={label.label}
                      dot={C[label.color]}
                      checked={thread.labels.includes(label.id)}
                      testId={`toggle-label-${label.id}`}
                      onSelect={() => toggleLabel(thread.id, label.id)}
                    />
                  ))}
                  <MenuSeparator />
                  <NewLabelItem
                    onCreate={(name) => {
                      const label = addLabel(name)
                      if (label && !thread.labels.includes(label.id)) toggleLabel(thread.id, label.id)
                      close()
                    }}
                  />
                </>
              )}
            </ToolbarMenuButton>
          </ToolbarGroup>
        )}
        <ToolbarMenuButton icon="more" testId="action-more" width={210} conversation={thread.id}>
          {(close) => (
            <>
              <MenuItem icon="mailOpen" label={thread.unread ? 'Mark as read' : 'Mark as unread'} testId="action-toggle-unread" onSelect={() => { close(); setUnread(thread.id, !thread.unread) }} />
              <MenuItem icon={thread.starred ? 'starFilled' : 'star'} label={thread.starred ? 'Remove star' : 'Add star'} onSelect={() => { close(); toggleStar(thread.id) }} />
              <MenuItem icon="forward" label="Forward" testId="action-forward" onSelect={() => { close(); forward(thread.messages[thread.messages.length - 1]!) }} />
              <MenuItem icon="search" label="Find in conversation" testId="action-find-menu" onSelect={() => { close(); setFindOpen(true) }} />
              <MenuItem icon="printer" label="Print conversation / Save PDF" testId="action-print-thread" onSelect={() => { close(); if (!printReaderText('Jefi Mail', printableThread(thread))) notify("Couldn't open the print panel") }} />
              <MenuSeparator />
              {thread.folder !== 'inbox' ? <MenuItem icon="inbox" label="Move to Inbox" onSelect={() => { close(); move(thread.id, 'inbox') }} /> : null}
              {thread.folder === 'spam' ? (
                <MenuItem icon="check" label="Not spam" onSelect={() => { close(); move(thread.id, 'inbox') }} />
              ) : (
                <MenuItem icon="alertCircle" label="Report spam" testId="action-spam" onSelect={() => { close(); move(thread.id, 'spam') }} />
              )}
              {inTrash || thread.folder === 'spam' ? (
                <MenuItem icon="trash" label="Delete forever" danger onSelect={() => { close(); deleteForever(thread.id) }} />
              ) : null}
            </>
          )}
        </ToolbarMenuButton>
      </div>

      {findOpen ? (
        <ReaderFindBar
          query={findQuery}
          current={Math.min(findIndex, Math.max(0, findMatches.length - 1))}
          total={findMatches.length}
          truncated={findResult.truncated}
          onQuery={changeFind}
          onPrevious={() => moveFind(-1)}
          onNext={() => moveFind(1)}
          onClose={() => { setFindOpen(false); setFindQuery(''); setFindIndex(0) }}
        />
      ) : null}

      <ClipContext.Provider value={scrollRef}>
      {/* The visible reader area: the full HTML view is clipped to this box, so it never covers the reply composer. */}
      <div
        ref={scrollRef}
        testId="reader-area"
        // The Full HTML view follows scrolling from outside GPUIX; a wheel over the reader wakes it.
        onScroll={geometryMayChange}
        style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
      <virtual-list
        ref={listRef}
        itemCount={items.length}
        estimatedItemHeight={160}
        windowStart={range.start}
        onVisibleRange={onVisibleRange}
        style={{ flexGrow: 1, minHeight: 0 }}
        testId="reader-scroll"
      >
        {items.slice(range.start, range.end).map((item) =>
          item.kind === 'summary' ? (
            shownSummary ? <SummaryCard
                key="summary"
                provider={ai.providerName}
                subject={thread.subject}
                summary={shownSummary}
                onClose={closeSummary}
                onRetry={() => runCard(shownSummary.kind)}
                onCopy={(text) => notify(copyText(text) ? 'Copied' : "Couldn't copy")}
                onAsk={sendToAssistant}
              /> : null
          ) : item.kind === 'top' ? (
            // Keyed by thread so opening another one remounts it and it settles in from just below.
            <motion.div key={`top-${thread.id}`} initial={{ opacity: 0, top: 6 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: 0.16, ease: 'easeOut' }} style={{ position: 'relative', width: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
              {/* Subject */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingLeft: READ_PAD_LEFT,
                  paddingRight: READ_PAD_RIGHT - 6,
                  paddingTop: 8,
                  paddingBottom: 10,
                  gap: 8,
                }}
              >
                {/* Right-to-left subjects wrap in reading order (see bidi-text.tsx); others are the plain text they were. */}
                <BidiText testId="reader-subject" text={thread.subject} maxLines={3} style={{ fontSize: 21, lineHeight: 28, fontWeight: 600, color: C.text, fontFamily: FONT }} box={{ minWidth: 0, flexShrink: 1 }} />
                {readerChips(thread, folders, threadLabels).map((chip) => (
                  <div
                    key={chip.key}
                    style={{
                      height: 22,
                      paddingLeft: 8,
                      paddingRight: 8,
                      borderRadius: 5,
                      backgroundColor: C.chip,
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      flexShrink: 0,
                    }}
                  >
                    {chip.tone ? <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: C[chip.tone] }} /> : null}
                    <text style={{ fontSize: 12, color: C.secondary, fontFamily: FONT }}>{chip.name}</text>
                  </div>
                ))}
                {thread.snoozeUntil ? (
                  <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, flexShrink: 0 }}>{`until ${thread.snoozeUntil}`}</text>
                ) : null}
                <div style={{ flexGrow: 1 }} />
                <IconButton
                  icon={thread.starred ? 'starFilled' : 'star'}
                  color={thread.starred ? C.star : undefined}
                  size={18}
                  onClick={() => toggleStar(thread.id)}
                  testId="action-star"
                />
              </div>
              <Divider />
              {/* Notes and events linked to this conversation. Its own per conversation: it keeps showing
                  what it had while the next loads, which would be the last conversation's links. */}
              <ThreadLinks key={thread.id} thread={thread} />

              {thread.folder === 'outbox' ? (
                <div
                  testId="outbox-banner"
                  style={{
                    marginLeft: READ_PAD_LEFT,
                    marginRight: READ_PAD_RIGHT,
                    marginTop: 12,
                    paddingLeft: 12,
                    paddingRight: 8,
                    height: 44,
                    borderRadius: 12,
                    backgroundColor: C.overlay,
                    // Outlined only when sending failed, so the failure stands out from the quiet pending state.
                    borderWidth: thread.sendState === 'failed' ? 1 : 0,
                    borderColor: C.accent,
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  {thread.sendState === 'failed' ? <Icon name="alertCircle" size={16} color={C.accent} /> : <Spinner size={16} color={C.accent} />}
                  <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    {thread.sendState === 'failed'
                      ? outboxFailureText(thread, `${account.servers.smtpHost} is unreachable`)
                      : thread.sendState === 'sending'
                        ? `Sending via ${account.servers.smtpHost}…`
                        : thread.scheduledFor
                          ? `Scheduled — sends ${thread.scheduledFor}`
                          : 'Queued — sends in a few seconds'}
                  </text>
                  {thread.sendState === 'queued' ? <Button label="Undo send" variant="ghost" onClick={() => cancelSend(thread.id)} testId="outbox-undo" /> : null}
                  {/* A rejected address or a missing file needs changing, not retrying: back to Drafts. */}
                  {thread.sendState === 'failed' ? <Button label="Edit" variant="ghost" onClick={() => cancelSend(thread.id)} testId="outbox-edit" /> : null}
                  {thread.sendState === 'failed' && thread.sendUnconfirmed ? (
                    <>
                      <Button label="Send again" variant="ghost" onClick={() => retrySend(thread.id)} testId="outbox-send-again" />
                      <Button label="It was sent" variant="primary" onClick={() => confirmSent(thread.id)} testId="outbox-confirm-sent" />
                    </>
                  ) : thread.sendState === 'failed' ? <Button label="Retry" variant="primary" onClick={() => retrySend(thread.id)} testId="outbox-retry" /> : null}
                </div>
              ) : null}

              {thread.screened ? <ScreenerBanner thread={thread} /> : null}
            </motion.div>
          ) : (
            <div
              key={item.key}
              ref={(node) => {
                if (node) itemNodes.current.set(item.key, node)
                else itemNodes.current.delete(item.key)
              }}
              style={{ width: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column' }}
            >
              <MessageBlock
                thread={threadRef}
                threadOf={threadOf}
                message={item.message}
                part={item.part}
                onOpen={openMessage}
                onReply={replyToMessage}
                onForward={forwardMessage}
                onRetry={retryMessage}
                onConfirmSent={confirmMessageSent}
                showImages={showImages.has(item.message.id)}
                onShowImages={showMessageImages}
                onComposeLink={composeLink}
                find={findActive && searchKeys.has(item.key)
                  ? {
                      query: findQuery.trim(),
                      ...(findMatches[findIndex]?.key === item.key ? { activeIndex: findMatches[findIndex]!.occurrence } : {}),
                    }
                  : undefined}
                onToggleQuoted={toggleQuoted}
              />
              {item.part.kind === 'foot' && !item.last ? <Divider /> : null}
            </div>
          ),
        )}
      </virtual-list>
      </div>
      </ClipContext.Provider>

      {/* Nothing to reply to in your own draft (Save draft leaves it selected here): its row opens it to edit. */}
      {thread.folder === 'trash' || thread.folder === 'spam' || thread.folder === 'outbox' || thread.folder === 'drafts' ? null : (
        <ReplyComposer
          thread={thread}
          message={replyMessage}
          mode={mode}
          draft={readDraft}
          hasDraft={hasDraft}
          shown={draftShown}
          onMode={setMode}
          onType={typeDraft}
          onDraft={setDraft}
          onExpand={(initial, parentMessageId) => {
            // The text moves into the full composer (and its draft); it mustn't wait here as well.
            setDraft('')
            onCompose(initial, parentMessageId === undefined ? undefined : thread.id, parentMessageId)
          }}
        />
      )}
    </div>
  )
}

/** Related toolbar buttons in one rounded group, so the bar reads as a few clusters rather than a row of icons. */
function ToolbarGroup({ children }: { children: ReactNode }) {
  const { C } = useSettings()
  return <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, padding: 2, borderRadius: 10, backgroundColor: mixHex(C.reading, C.text, 0.1), flexShrink: 0 }}>{children}</div>
}

/** The language the person reads in: the Mac's, by name ("English", "Kiswahili"), for the model. */
function readerLanguage() {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale.split('-')[0]!) ?? 'English'
  } catch {
    return 'English'
  }
}

function NewLabelItem({ onCreate }: { onCreate: (name: string) => void }) {
  const { C } = useSettings()
  const [name, setName] = useState('')
  return (
    <div style={{ height: 30, paddingLeft: 8, paddingRight: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      <Icon name="plus" size={15} color={C.secondary} />
      <input
        testId="new-label-from-thread"
        value={name}
        placeholder="New label…"
        onChange={(event) => setName(event.value ?? '')}
        // Enter in an <input> arrives as a submit, not a key down.
        onSubmit={(event) => {
          const value = event.value ?? name
          if (value.trim()) onCreate(value)
        }}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: FONT, color: C.text }}
      />
    </div>
  )
}

/** A first-time sender while the Screener is on: let them into the Inbox, or block them. */
function ScreenerBanner({ thread }: { thread: MailThread }) {
  const { C } = useSettings()
  countRender('ScreenerBanner')
  const account = useMailSelector((store) => store.account)
  const { screenSender } = useMailActions()
  const sender = [...thread.messages].reverse().find((m) => m.email.toLowerCase() !== account.email.toLowerCase()) ?? thread.messages[0]!
  return (
    <div
      testId="screener-banner"
      style={{
        marginLeft: READ_PAD_LEFT,
        marginRight: READ_PAD_RIGHT,
        marginTop: 12,
        padding: 12,
        borderRadius: 12,
        backgroundColor: C.raised,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Icon name="userPlus" size={18} color={C.accent} />
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{`First email from ${sender.from}`}</text>
        <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{`Let ${sender.email} into your Inbox?`}</text>
      </div>
      <Button label="Block" variant="ghost" onClick={() => screenSender(sender.email, sender.from, 'block')} testId="screener-block" />
      <Button label="Allow" variant="primary" onClick={() => screenSender(sender.email, sender.from, 'allow')} testId="screener-allow" />
    </div>
  )
}
