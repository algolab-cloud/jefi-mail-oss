import { countRender } from './render-counts'
import { useEffect, useRef, useState } from 'react'
import type { PublicInstance } from '@gpuix/react'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { FONT, THEMES, TOPBAR_HEIGHT, useSettings } from './theme'
import { Icon, IconButton } from './icons'
import { Button } from './ui'
import { Spinner } from './toast'
import { copyText } from './native/mail-webview'
import { MailMarkdown } from './markdown'
import { useMail, type BulkAction } from './store'
import { useAi } from './use-ai'
import { usePaneWidth } from './resizer'
import { floatingObstacle } from './html-view'
import { aiErrorMessage, rewriteEmail, threadForModel, writerNote, type Rewrite } from './ai'
import { attachContact, attachThread, clearHandoff, currentHandoffs, removeHandoff, sendToAssistant, useHandoffs, withHandoff, type Handoff } from './assistant-handoff'
import { assistantUnavailableText, describeTool, needsConfirmation, runAssistant, runAssistantOpenAI, type AssistantEvent, type AssistantTools, type Folder, type ThreadAction } from './assistant'
import {
  canRerun,
  chatTitle,
  chatWhen,
  deleteChat,
  linkedThreads,
  loadChats,
  replyText,
  saveChat,
  splitFollowups,
  transcript,
  type AssistantEntry,
  type ChatProvider,
  type Draft,
  type Entry,
  type Part,
  type SavedChat,
  type UserEntry,
} from './assistant-chats'
import { attachmentText } from './attachment-text'
import { replyRecipients } from './reply'
import { runAssistantCodex, type CodexTurn } from './assistant-codex'
import { accountName } from './accounts'
import { searchContacts } from './contacts'
import type { Contact, DraftFields, MailThread } from './data'
import { dispatchJefiUrl, parseJefiUrl } from './deeplink'

// ---------------------------------------------------------------------------
// The Assistant panel: chat with Claude or OpenAI about your mail. It can search, read (attached
// files too), open conversations, write emails and replies (as draft cards in the chat, never sent),
// and tidy up with the app's own actions, each with Undo right in the chat. Chats are kept on this
// Mac and can be reopened from the history list.
// ---------------------------------------------------------------------------

export const ASSISTANT_WIDTH = 380

/** The unpinned chat box. */
const FLOAT_WIDTH = 400
const FLOAT_HEIGHT = 580

const CATCH_UP = 'Catch me up on unread mail'
/** With several accounts the catch-up covers all of them. */
const CATCH_UP_ALL = 'Catch me up on unread mail across all my accounts'
const SUGGESTIONS = [CATCH_UP, 'What needs a reply from me?', 'Write an email to…', 'Archive newsletters older than a week']
const ONE_THREAD = ['Summarize this thread', 'What do I need to do next?', 'Draft a reply to this thread']
const MANY_THREADS = ['Summarize these conversations', 'What do I need to do in each?', 'Which of these need a reply?']

/** Ways a draft card can be rewritten in place, in the order its buttons show. */
const DRAFT_REWRITES: Array<{ how: Rewrite; label: string }> = [
  { how: 'shorter', label: 'Shorter' },
  { how: 'formal', label: 'Formal' },
  { how: 'friendly', label: 'Friendlier' },
]

/** Emails an answer links to, shown under it. */
const MAX_SOURCES = 4

const ACTIONS: Record<ThreadAction, BulkAction> = {
  archive: { move: 'archive' },
  trash: { move: 'trash' },
  move_to_inbox: { move: 'inbox' },
  mark_read: { unread: false },
  mark_unread: { unread: true },
  star: { starred: true },
  unstar: { starred: false },
}

type ProviderHistory = { provider: ChatProvider; claude: Anthropic.Beta.BetaMessageParam[]; openai: OpenAI.Responses.ResponseInputItem[]; codex: CodexTurn[] }
const emptyHistory = (provider: ChatProvider): ProviderHistory => ({ provider, claude: [], openai: [], codex: [] })
/** The provider's own copy of the chat, the one the model is sent. */
const historyList = (h: ProviderHistory): unknown[] => (h.provider === 'anthropic' ? h.claude : h.provider === 'openai' ? h.openai : h.codex)

type Mention = { kind: 'thread'; thread: MailThread } | { kind: 'contact'; contact: Contact }

/** The @word being typed at the end of the chat box, or null when there isn't one. */
const mentionQuery = (input: string) => input.match(/(?:^|\s)@([^\s@]{0,40})$/)?.[1] ?? null

// Native view registration and cancellation are lifecycle subscriptions, isolated from rendering.
function useAssistantLifecycle(pinned: boolean, floatRef: { current: PublicInstance | null }, abort: { current: AbortController | null }, confirms: { current: Map<number, (ok: boolean) => void> }) {
  useEffect(() => {
    if (pinned) return
    floatingObstacle.current = floatRef.current
    return () => void (floatingObstacle.current = null)
  }, [pinned])
  useEffect(() => () => {
    abort.current?.abort()
    for (const resolve of confirms.current.values()) resolve(false)
    confirms.current.clear()
  }, [])
}

export function AssistantPanel({
  onClose,
  onOpenThread,
  onCompose,
  onOpenSettings,
  view,
  openThread,
}: {
  onClose: () => void
  onOpenThread: (id: string) => void
  onCompose: (initial: Partial<DraftFields>, extra?: { replyTo?: string; parentMessageId?: string; title?: string }) => void
  onOpenSettings: () => void
  /** What the person is looking at, so "this email" means something. */
  view: string
  openThread: MailThread | null
}) {
  const { C, settings, update: updateSettings } = useSettings()
  const assistantWidth = usePaneWidth('assistant')
  const pinned = settings.assistantPinned
  // The Full HTML view is a native layer above everything drawn here: tell it where the chat box is.
  const floatRef = useRef<PublicInstance>(null)
  countRender('AssistantPanel')
  const store = useMail()
  const ai = useAi()
  // The chat lives in a ref, mirrored to state for rendering: a turn that ends reads (and saves)
  // exactly what's on screen, not what a render from before its last update saw.
  const [entries, setEntries] = useState<Entry[]>([])
  const chat = useRef<Entry[]>([])
  const commit = (next: Entry[]) => {
    chat.current = next
    setEntries(next)
  }
  const chatId = useRef<string>(crypto.randomUUID())
  const [input, setInput] = useState('')
  const [inputKey, setInputKey] = useState(0)
  const handoffs = useHandoffs()
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [saved, setSaved] = useState<SavedChat[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null)
  const running = useRef(false)
  // Each provider keeps the conversation in its own format; switching provider carries the chat over as text.
  const history = useRef<ProviderHistory>(emptyHistory('anthropic'))
  const connection = ai.enabled ? ai.connection : null
  const provider = connection?.provider ?? null
  const abort = useRef<AbortController | null>(null)
  // Tools read live state: a request can outlast the render that started it.
  const live = useRef(store)
  live.current = store
  const liveSettings = useRef(settings)
  liveSettings.current = settings
  /** Changes the person took back from the chat since the last message, for the model to hear about. */
  const undoneSince = useRef<string[]>([])

  // A yes/no card in the chat; the tool call waits on the answer.
  const confirms = useRef(new Map<number, (ok: boolean) => void>())
  useAssistantLifecycle(pinned, floatRef, abort, confirms)

  /** Changes the newest answer (the one being written). */
  const update = (change: (entry: AssistantEntry) => AssistantEntry) => {
    const last = chat.current[chat.current.length - 1]
    if (last?.role === 'assistant') commit([...chat.current.slice(0, -1), change(last)])
  }
  /** Changes one part wherever it is: a draft card or tool row can be acted on long after its turn. */
  const updatePart = (match: (part: Part) => boolean, change: (part: Part) => Part) =>
    commit(chat.current.map((e) => (e.role === 'assistant' && e.parts.some(match) ? { ...e, parts: e.parts.map((p) => (match(p) ? change(p) : p)) } : e)))

  const persist = () => {
    if (!liveSettings.current.assistantHistory || !chat.current.length) return
    saveChat({ id: chatId.current, title: chatTitle(chat.current), updatedAt: Date.now(), provider: history.current.provider, entries: chat.current, history: historyList(history.current) })
  }

  const confirm = (question: string) =>
    new Promise<boolean>((resolve) => {
      const id = Date.now() + Math.random()
      confirms.current.set(id, resolve)
      update((entry) => ({ ...entry, parts: [...entry.parts, { kind: 'confirm', id, question, state: 'asking' }] }))
    })
  const answer = (id: number, ok: boolean) => {
    confirms.current.get(id)?.(ok)
    confirms.current.delete(id)
    updatePart((p) => p.kind === 'confirm' && p.id === id, (p) => ({ ...p, state: ok ? 'yes' : 'no' }) as Part)
  }
  /** Stopping says no to whatever is still asked, and the cards show it, rather than keeping Yes/No that do nothing. */
  const declinePending = () => {
    for (const id of [...confirms.current.keys()]) answer(id, false)
  }

  const summary = (t: MailThread) => ({
    thread_id: t.id,
    subject: t.subject || '(no subject)',
    from: t.sender,
    date: t.date,
    unread: t.unread,
    starred: t.starred,
    folder: t.folder,
    snippet: t.snippet,
  })
  // Conversations list_unread_all_accounts returned, by id: some belong to accounts not on screen.
  const elsewhere = useRef(new Map<string, { accountId: string; thread: MailThread }>())
  const lookup = (id: string) => live.current.threads.find((t) => t.id === id) ?? elsewhere.current.get(id)?.thread
  const findThread = (id: string) => {
    const thread = lookup(id)
    if (!thread) throw new Error('No conversation with that thread_id. Search or list first')
    return thread
  }
  /**
   * Acting on another account's conversation happens in that account: switch to it and wait for the
   * store to follow, so the composer, labels and Undo toast are the right account's.
   */
  const inAccountOf = async (ids: string[]) => {
    const target = ids.map((id) => elsewhere.current.get(id)?.accountId).find((a) => a && a !== live.current.account.id)
    if (!target) return
    if (ids.some((id) => (elsewhere.current.get(id)?.accountId ?? live.current.account.id) !== target))
      throw new Error('Those conversations are in different accounts. Act on one account at a time')
    live.current.switchAccount(target)
    for (let i = 0; i < 60 && live.current.account.id !== target; i++) await new Promise((r) => setTimeout(r, 50))
    if (live.current.account.id !== target) throw new Error("Couldn't switch to that conversation's account")
  }
  const known = (id: string) => live.current.threads.some((t) => t.id === id) || elsewhere.current.has(id)

  /** A draft card in the answer being written. */
  const addDraft = (draft: Draft) => update((entry) => ({ ...entry, parts: [...entry.parts, { kind: 'draft', id: crypto.randomUUID(), draft }] }))

  const tools: AssistantTools = {
    search_mail: async ({ query }) => {
      const ids = await live.current.search(query)
      const byId = new Map(live.current.threads.map((t) => [t.id, t]))
      return ids.slice(0, 20).flatMap((id) => (byId.get(id) ? [summary(byId.get(id)!)] : []))
    },
    list_threads: async ({ folder, unread_only, from, older_than_days, newer_than_days, has_attachment, limit }) => {
      const inFolder = (t: MailThread, f: Folder) => (f === 'starred' ? t.starred && t.folder !== 'trash' : t.folder === f && !t.onlyInFolders)
      const now = Date.now()
      const day = 86_400_000
      const who = from?.trim().toLowerCase()
      return live.current.threads
        .filter((t) => inFolder(t, folder) && (!unread_only || t.unread))
        .filter((t) => !who || t.sender.toLowerCase().includes(who) || t.messages.some((m) => m.email.toLowerCase().includes(who)))
        .filter((t) => older_than_days === undefined || (t.at !== undefined && t.at < now - older_than_days * day))
        .filter((t) => newer_than_days === undefined || (t.at !== undefined && t.at >= now - newer_than_days * day))
        .filter((t) => !has_attachment || t.icons.includes('paperclip'))
        .slice(0, Math.min(limit ?? 20, 50))
        .map(summary)
    },
    ...(live.current.accounts.length > 1
      ? {
          list_unread_all_accounts: async ({ limit }: { limit?: number }) => {
            const found = await live.current.unreadAcrossAccounts(Math.min(Math.max(1, Math.floor(limit ?? 30)), 50))
            for (const { account, thread } of found) elsewhere.current.set(thread.id, { accountId: account.id, thread })
            return found.map(({ account, thread }) => ({ ...summary(thread), account: account.label ? `${account.label} <${account.email}>` : account.email }))
          },
        }
      : {}),
    read_thread: async ({ thread_id }) => {
      findThread(thread_id)
      const full = await live.current.fetchThread(thread_id)
      if (!full) throw new Error("Couldn't load that conversation")
      return threadForModel(full)
    },
    read_attachment: async ({ thread_id, name }) => {
      findThread(thread_id)
      const full = await live.current.fetchThread(thread_id)
      if (!full) throw new Error("Couldn't load that conversation")
      const wanted = name.trim().toLowerCase()
      // The newest copy of a file wins: a revised attachment usually keeps its name.
      for (const message of [...full.messages].reverse()) {
        const files = message.attachments ?? []
        const index = files.findIndex((a) => a.name.trim().toLowerCase() === wanted)
        if (index < 0) continue
        const got = await live.current.getAttachment(message.id, index, files[index]!)
        if (!got.ok) throw new Error(got.error)
        return `<attachment name="${got.attachment.name.replace(/["<>]/g, "'")}">\n${await attachmentText(got.attachment.path, got.attachment.name)}\n</attachment>`
      }
      const names = [...new Set(full.messages.flatMap((m) => (m.attachments ?? []).map((a) => a.name)))]
      throw new Error(`No attachment called "${name}" in that conversation. Its attachments: ${names.join(', ') || 'none'}`)
    },
    open_thread: async ({ thread_id }) => {
      findThread(thread_id)
      const owner = elsewhere.current.get(thread_id)?.accountId
      if (owner && owner !== live.current.account.id) live.current.showThread(owner, thread_id)
      else onOpenThread(thread_id)
      return { summary: 'Opened' }
    },
    compose_email: async ({ to, cc, subject, body }) => {
      addDraft({ to, cc: cc ?? [], subject, body })
      return { summary: 'Shown in the chat as a draft, not sent' }
    },
    draft_reply: async ({ thread_id, body, reply_all }) => {
      const thread = findThread(thread_id)
      const selected = thread.messages.at(-1)
      if (!selected) throw new Error('That conversation has no messages to reply to')
      const recipients = replyRecipients(selected, reply_all ? 'replyAll' : 'reply', live.current.accounts.map((account) => account.email))
      addDraft({
        threadId: thread_id,
        parentMessageId: selected.id,
        to: recipients.to,
        cc: recipients.cc,
        subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
        body,
      })
      return { summary: 'Shown in the chat as a draft, not sent' }
    },
    update_threads: async ({ thread_ids, action }) => {
      const ids = thread_ids.filter(known)
      if (!ids.length) throw new Error('None of those thread_ids exist')
      // Big or destructive changes wait for the person to say yes in the chat, before anything moves
      // (switching to the account the conversations are in included).
      if (needsConfirmation(ids.length, action)) {
        const what = action.replace(/_/g, ' ')
        const ok = await confirm(`${what.charAt(0).toUpperCase()}${what.slice(1)} ${ids.length === 1 ? '1 conversation' : `${ids.length} conversations`}?`)
        if (!ok) throw new Error('The person declined this change. Do not retry it.')
      }
      await inAccountOf(ids)
      const undo = live.current.bulk(ids, ACTIONS[action])
      return { summary: ids.length === 1 ? '1 conversation' : `${ids.length} conversations`, undo }
    },
    snooze_thread: async ({ thread_id, until }) => {
      findThread(thread_id)
      await inAccountOf([thread_id])
      const undo = live.current.snooze(thread_id, until)
      return { summary: `Until ${until.toLowerCase()}`, undo }
    },
    label_thread: async ({ thread_id, label }) => {
      const thread = findThread(thread_id)
      await inAccountOf([thread_id])
      const match = live.current.labels.find((l) => l.label.toLowerCase() === label.trim().toLowerCase())
      if (!match) throw new Error(`No label called "${label}". Existing labels: ${live.current.labels.map((l) => l.label).join(', ') || 'none'}`)
      if (thread.labels.includes(match.id)) return { summary: `${match.label} (already there)` }
      live.current.toggleLabel(thread_id, match.id)
      return { summary: match.label, undo: () => live.current.toggleLabel(thread_id, match.id) }
    },
  }

  const context = () => {
    const s = live.current
    const accounts = s.accounts.map((a) => `${accountName(a)} <${a.email}>`).join(', ')
    return [
      `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
      `The person: ${s.account.name} <${s.account.email}>. Accounts: ${accounts}.`,
      `On screen: the ${view} list.${openThread ? ` The open conversation is "${openThread.subject}" from ${openThread.sender} (thread_id ${openThread.id}); "this email" means it.` : ''}`,
      `Labels: ${s.labels.map((l) => l.label).join(', ') || 'none'}.`,
      ...(s.accounts.length > 1
        ? [`search_mail and list_threads cover the current account (${accountName(s.account)}); list_unread_all_accounts covers every account. When catching the person up, cover all accounts and say which account each conversation is in.`]
        : []),
      writerNote(liveSettings.current.aiInstructions).trim(),
    ]
      .filter(Boolean)
      .join('\n')
  }

  const send = (text: string, attachments?: readonly Handoff[]) => {
    const message = text.trim()
    // `busy` is state and lags a frame behind: a second Enter right away would start a second run.
    if (!message || busy || running.current || !connection) return
    running.current = true
    setShowHistory(false)
    const h = history.current
    // Another provider can't read this one's history: it gets the chat so far as text instead.
    const carried = h.provider !== connection.provider && chat.current.length ? transcript(chat.current) : ''
    if (h.provider !== connection.provider) history.current = emptyHistory(connection.provider)
    const turnHistory = history.current
    setInput('')
    setInputKey((k) => k + 1)
    setMentionDismissed(null)
    // Read now, not from the render: the person may have removed one a moment ago.
    const attached = [...(attachments ?? currentHandoffs())]
    if (!attachments) clearHandoff()
    const list = historyList(turnHistory)
    // Where this turn starts, so a stopped or failed turn can be rolled back whole (a dangling tool call would break the next one).
    const start = list.length
    commit([...chat.current, { role: 'user', text: message, ...(attached.length ? { handoffs: attached } : {}) }, { role: 'assistant', parts: [], done: false, start }])
    const rollback = () => {
      list.length = start
    }
    const undone = undoneSince.current.splice(0)
    const controller = (abort.current = new AbortController())
    const onEvent = (event: AssistantEvent) => {
      if (event.type === 'text')
        update((entry) => {
          const last = entry.parts[entry.parts.length - 1]
          return last?.kind === 'text'
            ? { ...entry, parts: [...entry.parts.slice(0, -1), { kind: 'text', text: last.text + event.text }] }
            : { ...entry, parts: [...entry.parts, { kind: 'text', text: event.text }] }
        })
      else if (event.type === 'tool')
        update((entry) => ({ ...entry, parts: [...entry.parts, { kind: 'tool', id: event.id, name: event.name, label: describeTool(event.name, event.input), state: 'running' }] }))
      else
        updatePart(
          (p) => p.kind === 'tool' && p.id === event.id,
          (p) => ({ ...p, state: event.ok ? 'ok' : 'error', detail: event.summary, ...(event.undo ? { undo: event.undo } : {}) }) as Part,
        )
    }
    setBusy(true)
    const run = async () => {
      // Attached conversations go in whole, read when sent so they're current.
      const resolved = await Promise.all(
        attached.map(async (item) => {
          if (!item.threadId) return item
          const full = await live.current.fetchThread(item.threadId)
          if (!full) throw new Error(`Couldn't load “${item.title}”. Try again when it is available.`)
          return { ...item, text: `Email thread_id: ${full.id}\n${threadForModel(full)}` }
        }),
      )
      controller.signal.throwIfAborted()
      const modelMessage = `${carried ? `<earlier_conversation>\n${carried.replace(/<\/earlier_conversation>/gi, '</ earlier_conversation>')}\n</earlier_conversation>\n\n` : ''}${withHandoff(message, resolved)}`
      const threadIds = attached.flatMap((a) => (a.threadId ? [a.threadId] : []))
      const turnContext = [
        context(),
        threadIds.length === 1 ? `The attached conversation (thread_id ${threadIds[0]}) is the subject of this request; "this email" and "this thread" refer to it.` : '',
        threadIds.length > 1 ? `The ${threadIds.length} attached conversations (thread_ids ${threadIds.join(', ')}) are the subject of this request; "these" refers to them.` : '',
        undone.length ? `Since the last message the person undid, from the chat: ${undone.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n')
      if (connection.provider === 'anthropic') {
        turnHistory.claude.push({ role: 'user', content: modelMessage })
        await runAssistant(connection.key, connection.model, turnHistory.claude, turnContext, tools, onEvent, controller.signal)
      } else if (connection.provider === 'openai') {
        turnHistory.openai.push({ role: 'user', content: modelMessage })
        await runAssistantOpenAI(connection.key, connection.model, turnHistory.openai, turnContext, tools, onEvent, controller.signal)
      } else {
        turnHistory.codex.push({ role: 'user', text: modelMessage })
        await runAssistantCodex(connection.model, turnHistory.codex, turnContext, tools, onEvent, controller.signal)
      }
    }
    run()
      .then(() => update((entry) => ({ ...entry, done: true })))
      .catch((error) => {
        rollback()
        update((entry) => ({ ...entry, done: true, error: controller.signal.aborted ? 'Stopped' : aiErrorMessage(error) }))
      })
      .finally(() => {
        running.current = false
        setBusy(false)
        persist()
      })
  }

  const openThreadById = (id: string) => {
    const owner = elsewhere.current.get(id)?.accountId
    if (owner && owner !== live.current.account.id) live.current.showThread(owner, id)
    else if (live.current.threads.some((t) => t.id === id)) onOpenThread(id)
    else dispatchJefiUrl(`jefi://thread/${encodeURIComponent(id)}`)
  }
  const openLink = (url: string) => {
    const route = parseJefiUrl(url)
    if (route?.kind === 'thread') openThreadById(route.threadId)
    // Any other jefi:// link goes through the same router as links from outside Jefi.
    else if (route) dispatchJefiUrl(url)
    else if (/^https?:/.test(url)) Bun.spawn(['/usr/bin/open', url], { stdout: 'ignore', stderr: 'ignore' })
  }

  const newChat = () => {
    if (running.current) return
    clearHandoff()
    setInput('')
    setInputKey((k) => k + 1)
    history.current = emptyHistory(history.current.provider)
    elsewhere.current.clear()
    undoneSince.current = []
    chatId.current = crypto.randomUUID()
    setShowHistory(false)
    commit([])
  }

  const toggleHistory = () => {
    if (!showHistory) setSaved(loadChats())
    setShowHistory(!showHistory)
  }
  const reopen = (saved: SavedChat) => {
    if (running.current) return
    clearHandoff()
    const restored = emptyHistory(saved.provider)
    if (saved.provider === 'anthropic') restored.claude = saved.history as Anthropic.Beta.BetaMessageParam[]
    else if (saved.provider === 'openai') restored.openai = saved.history as OpenAI.Responses.ResponseInputItem[]
    else restored.codex = saved.history as CodexTurn[]
    history.current = restored
    elsewhere.current.clear()
    undoneSince.current = []
    chatId.current = saved.id
    setShowHistory(false)
    commit(saved.entries)
  }
  const forget = (id: string) => {
    deleteChat(id)
    setSaved((list) => list.filter((c) => c.id !== id))
    if (id === chatId.current) chatId.current = crypto.randomUUID()
  }

  const copy = (text: string) => store.notify(copyText(text) ? 'Copied to clipboard' : "Couldn't copy")
  const edit = (entry: UserEntry) => {
    if (running.current) return
    setInput(entry.text)
    setInputKey((k) => k + 1)
    if (entry.handoffs?.length) sendToAssistant(...entry.handoffs)
    else clearHandoff()
  }
  /** Asks the latest question again: after a failure, or for a different answer when nothing in the mailbox changed. */
  const rerun = () => {
    const last = chat.current.at(-1)
    const user = chat.current.at(-2)
    if (running.current || last?.role !== 'assistant' || !canRerun(last) || user?.role !== 'user') return
    const h = history.current
    // A failed turn was already rolled back; a finished one is taken out of the model's history here.
    if (last.start !== undefined && h.provider === provider) {
      const list = historyList(h)
      list.length = Math.min(list.length, last.start)
    }
    commit(chat.current.slice(0, -2))
    send(user.text, user.handoffs ?? [])
  }

  const takeBack = (id: string) => {
    const part = chat.current.flatMap((e) => (e.role === 'assistant' ? e.parts : [])).find((p) => p.kind === 'tool' && p.id === id)
    if (part?.kind !== 'tool' || !part.undo || part.undone) return
    part.undo()
    undoneSince.current.push(part.label)
    updatePart((p) => p.kind === 'tool' && p.id === id, (p) => ({ ...p, undone: true, undo: undefined }) as Part)
    persist()
  }

  const openDraft = async (draft: Draft) => {
    if (draft.threadId && draft.parentMessageId && known(draft.threadId)) {
      try {
        await inAccountOf([draft.threadId])
      } catch (error) {
        return store.notify(error instanceof Error ? error.message : "Couldn't open the reply")
      }
      return onCompose({ to: draft.to, cc: draft.cc, bcc: [], subject: draft.subject, body: draft.body }, { replyTo: draft.threadId, parentMessageId: draft.parentMessageId, title: 'Reply' })
    }
    // A reply from a reopened chat whose conversation isn't loaded goes out as a new email to the same people.
    onCompose({ to: draft.to, cc: draft.cc, bcc: [], subject: draft.subject, body: draft.body })
  }
  const rewriteDraft = (id: string, draft: Draft, how: Rewrite) => {
    if (!connection) return
    const matches = (p: Part) => p.kind === 'draft' && p.id === id
    let text = ''
    updatePart(matches, (p) => ({ ...p, rewriting: true }) as Part)
    rewriteEmail(connection, draft.body, how, { onText: (delta) => updatePart(matches, (p) => (p.kind === 'draft' ? { ...p, draft: { ...p.draft, body: (text += delta) } } : p)) }, liveSettings.current.aiInstructions)
      .then((final) => updatePart(matches, (p) => (p.kind === 'draft' ? { ...p, rewriting: false, draft: { ...p.draft, body: final.trim() || draft.body } } : p)))
      .catch((error) => {
        updatePart(matches, (p) => (p.kind === 'draft' ? { ...p, rewriting: false, draft } : p))
        store.notify(aiErrorMessage(error))
      })
      .finally(persist)
  }

  // @-mentions: conversations and people matching what's typed after the @.
  const query = mentionQuery(input)
  const mentions: Mention[] =
    query === null || query === mentionDismissed || !provider
      ? []
      : [
          ...store.threads
            .filter((t) => t.folder !== 'outbox' && !handoffs.some((h) => h.threadId === t.id))
            .filter((t) => !query || t.subject.toLowerCase().includes(query.toLowerCase()) || t.sender.toLowerCase().includes(query.toLowerCase()))
            .slice(0, query ? 4 : 5)
            .map((thread): Mention => ({ kind: 'thread', thread })),
          ...searchContacts(query, handoffs.flatMap((h) => (h.contact ? [h.contact] : [])), 3).map((contact): Mention => ({ kind: 'contact', contact })),
        ]
  const highlighted = Math.min(mentionIndex, Math.max(0, mentions.length - 1))
  const pickMention = (mention: Mention) => {
    if (mention.kind === 'thread') attachThread(mention.thread)
    else attachContact(mention.contact)
    setInput((value) => value.replace(/@[^\s@]*$/, ''))
    setInputKey((k) => k + 1)
    setMentionIndex(0)
  }
  const onInputKey = (key: string) => {
    if (!mentions.length) return
    if (key === 'down') setMentionIndex((highlighted + 1) % mentions.length)
    else if (key === 'up') setMentionIndex((highlighted - 1 + mentions.length) % mentions.length)
    else if (key === 'tab') pickMention(mentions[highlighted]!)
    else if (key === 'escape') setMentionDismissed(query)
  }

  const threadsAttached = handoffs.filter((h) => h.threadId).length
  const suggestions = threadsAttached > 1 ? MANY_THREADS : threadsAttached === 1 ? ONE_THREAD : SUGGESTIONS.map((s) => (s === CATCH_UP && store.accounts.length > 1 ? CATCH_UP_ALL : s))
  const lastIndex = entries.length - 1

  return (
    <div
      ref={pinned ? undefined : floatRef}
      testId="assistant"
      style={
        pinned
          ? { width: assistantWidth, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.list, borderLeftWidth: 1, borderColor: C.divider }
          : // A chat box over the corner: the mail keeps its full width until the person pins it. Solid
            // even in Liquid Glass, since it covers mail rather than the desktop.
            { position: 'absolute', right: 16, bottom: 16, width: FLOAT_WIDTH, height: FLOAT_HEIGHT, maxHeight: '90%', display: 'flex', flexDirection: 'column', backgroundColor: THEMES[settings.theme].list, borderRadius: 12, borderWidth: 1, borderColor: C.overlayStrong, overflow: 'hidden', boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 48, spreadRadius: 0, color: '#00000066' } }
      }
    >
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 10, gap: 8 }}>
        <Icon name="sparkles" size={16} color={C.accent} />
        <text style={{ flexGrow: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {showHistory ? 'Chat history' : entries.length ? chatTitle(entries) : 'Assistant'}
        </text>
        {provider ? <IconButton icon="clock" size={15} pad={26} active={showHistory} tooltip={showHistory ? 'Back to the chat' : 'Chat history'} onClick={toggleHistory} testId="assistant-history" /> : null}
        <IconButton icon="plus" size={15} pad={26} tooltip={busy ? 'Stop the response before starting a new chat' : 'New chat'} dimmed={busy} onClick={busy ? undefined : newChat} testId="assistant-new" />
        {entries.length && !showHistory ? <IconButton icon="copy" size={15} pad={26} tooltip="Copy conversation" onClick={() => copy(transcript(chat.current))} testId="assistant-copy-chat" /> : null}
        <IconButton icon="pin" size={15} pad={26} active={pinned} tooltip={pinned ? 'Unpin (float as a chat box)' : 'Pin to the side'} onClick={() => updateSettings({ assistantPinned: !pinned })} testId="assistant-pin" />
        <IconButton icon="x" size={15} pad={26} tooltip="Close (⌘J)" onClick={onClose} testId="assistant-close" />
      </div>

      {!provider ? (
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, paddingLeft: 32, paddingRight: 32 }}>
          <Icon name="sparkles" size={26} color={C.muted} />
          <text testId="assistant-unavailable" style={{ fontSize: 13.5, color: C.secondary, fontFamily: FONT, textAlign: 'center' }}>
            {assistantUnavailableText({
              loaded: ai.loaded,
              aiEnabled: settings.aiEnabled,
              codexSelected: settings.aiProvider === 'openai' && settings.aiOpenAiMode === 'codex',
              codexError: ai.codex.error,
              available: ai.available,
              providerName: ai.providerName,
            })}
          </text>
          <Button label="Open Settings" variant="primary" onClick={onOpenSettings} testId="assistant-settings" />
        </div>
      ) : showHistory ? (
        <ChatHistory chats={saved} enabled={settings.assistantHistory} current={chatId.current} onOpen={reopen} onDelete={forget} onOpenSettings={onOpenSettings} />
      ) : (
        <>
          <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', gap: 14, paddingLeft: 16, paddingRight: 16, paddingTop: 6, paddingBottom: 12 }}>
            {entries.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12 }}>
                <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT, paddingBottom: 4 }}>{`Ask about your mail, or have ${ai.providerName} write and tidy up for you. Type @ to bring in an email or a person. Nothing is sent without you.`}</text>
                {suggestions.map((s, i) => (
                  <div
                    key={s}
                    testId={`assistant-suggestion-${i}`}
                    onClick={() => (s.endsWith('…') ? (setInput(s.replace('…', ' ')), setInputKey((k) => k + 1)) : send(s))}
                    style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, backgroundColor: C.raised, cursor: 'pointer', hover: { backgroundColor: C.raisedHover } }}
                  >
                    <text style={{ fontSize: 13, color: C.text, fontFamily: FONT, pointerEvents: 'none' }}>{s}</text>
                  </div>
                ))}
              </div>
            ) : (
              entries.map((entry, i) =>
                entry.role === 'user' ? (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {entry.handoffs?.map((h) => <AttachedLabel key={h.threadId ?? h.contact ?? h.title} item={h} />)}
                    <div style={{ maxWidth: 290, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 12, backgroundColor: C.chip }}>
                      <text style={{ fontSize: 13.5, lineHeight: 19, color: C.text, fontFamily: FONT }}>{entry.text}</text>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'row', gap: 2 }}>
                      <IconButton icon="copy" size={13} pad={24} tooltip="Copy message" onClick={() => copy(entry.text)} testId={`assistant-copy-${i}`} />
                      {!busy ? <IconButton icon="pencil" size={13} pad={24} tooltip="Edit and resend as a new message" onClick={() => edit(entry)} testId={`assistant-edit-${i}`} /> : null}
                    </div>
                  </div>
                ) : (
                  <AssistantReply
                    key={i}
                    index={i}
                    entry={entry}
                    latest={i === lastIndex}
                    busy={busy}
                    lookup={lookup}
                    onLink={openLink}
                    onOpenThread={openThreadById}
                    onAnswer={answer}
                    onUndo={takeBack}
                    onCopy={copy}
                    onRerun={rerun}
                    onFollowup={(text) => send(text, [])}
                    onOpenDraft={(draft) => void openDraft(draft)}
                    onRewriteDraft={rewriteDraft}
                  />
                ),
              )
            )}
          </div>

          <div style={{ flexShrink: 0, paddingLeft: 12, paddingRight: 12, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mentions.length ? (
              <div testId="assistant-mentions" style={{ borderRadius: 10, backgroundColor: C.raised, borderWidth: 1, borderColor: C.divider, paddingTop: 4, paddingBottom: 4, display: 'flex', flexDirection: 'column' }}>
                {mentions.map((m, i) => (
                  <div
                    key={m.kind === 'thread' ? m.thread.id : m.contact.email}
                    testId={`assistant-mention-${i}`}
                    onClick={() => pickMention(m)}
                    style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, height: 32, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', backgroundColor: i === highlighted ? C.raisedHover : undefined, hover: { backgroundColor: C.raisedHover } }}
                  >
                    <Icon name={m.kind === 'thread' ? 'mail' : 'user'} size={13} color={C.muted} />
                    <text style={{ flexShrink: 1, minWidth: 0, fontSize: 13, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
                      {m.kind === 'thread' ? m.thread.subject || '(no subject)' : m.contact.name || m.contact.email}
                    </text>
                    <text style={{ flexShrink: 0, maxWidth: 120, fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
                      {m.kind === 'thread' ? m.thread.sender : m.contact.email}
                    </text>
                  </div>
                ))}
              </div>
            ) : null}
            <div style={{ borderRadius: 10, backgroundColor: C.raised, paddingLeft: 12, paddingRight: 6, paddingTop: 8, paddingBottom: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {handoffs.length ? (
                <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                  {handoffs.map((h) => (
                    <AttachedLabel key={h.threadId ?? h.contact ?? h.title} item={h} onRemove={() => removeHandoff(h)} />
                  ))}
                </div>
              ) : null}
              <textarea
                key={inputKey}
                testId="assistant-input"
                autoFocus
                value={input}
                placeholder={handoffs.length ? 'Ask about it, or have a reply drafted…' : `Ask ${ai.providerName} about your mail, @ to add an email…`}
                minRows={1}
                maxRows={6}
                onChange={(event) => {
                  setInput(event.value ?? '')
                  setMentionIndex(0)
                }}
                onKeyDown={(event) => {
                  if (event.key) onInputKey(event.key)
                }}
                // Enter sends (it arrives as submit once this is set); the text comes with it, so a
                // quick Enter after typing can't send what the field held a frame earlier. With
                // @-suggestions showing, Enter picks the highlighted one instead.
                onSubmit={(event) => (mentions.length && mentionQuery(event.value ?? input) !== null ? pickMention(mentions[highlighted]!) : send(event.value ?? input))}
                style={{ fontSize: 13.5, lineHeight: 19, fontFamily: FONT, color: C.text }}
              />
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                <text testId="assistant-provider" style={{ flexGrow: 1, fontSize: 11, color: C.muted, fontFamily: FONT }}>{connection?.provider === 'codex' ? 'ChatGPT · your ChatGPT plan' : `${ai.providerName} · your API key`}</text>
                {busy ? (
                  <Button
                    label="Stop"
                    variant="ghost"
                    onClick={() => {
                      declinePending()
                      abort.current?.abort()
                    }}
                    testId="assistant-stop"
                  />
                ) : (
                  <Button label="Send" variant="primary" disabled={!input.trim()} onClick={() => send(input)} testId="assistant-send" />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** One answer: its text and cards, the emails it points to, and what can be done with it next. */
function AssistantReply({
  index,
  entry,
  latest,
  busy,
  lookup,
  onLink,
  onOpenThread,
  onAnswer,
  onUndo,
  onCopy,
  onRerun,
  onFollowup,
  onOpenDraft,
  onRewriteDraft,
}: {
  index: number
  entry: AssistantEntry
  latest: boolean
  busy: boolean
  lookup: (id: string) => MailThread | undefined
  onLink: (url: string) => void
  onOpenThread: (id: string) => void
  onAnswer: (id: number, ok: boolean) => void
  onUndo: (toolId: string) => void
  onCopy: (text: string) => void
  onRerun: () => void
  onFollowup: (text: string) => void
  onOpenDraft: (draft: Draft) => void
  onRewriteDraft: (id: string, draft: Draft, how: Rewrite) => void
}) {
  const { C } = useSettings()
  const text = replyText(entry)
  const lastText = [...entry.parts].reverse().find((p) => p.kind === 'text')
  const followups = latest && entry.done && !entry.error && lastText?.kind === 'text' ? splitFollowups(lastText.text).followups : []
  const sources = entry.done ? linkedThreads(text).flatMap((id) => (lookup(id) ? [lookup(id)!] : [])) : []
  const rerunnable = latest && entry.done && !busy && canRerun(entry)
  return (
    <div testId="assistant-reply" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {entry.parts.map((part, j) =>
        part.kind === 'text' ? (
          <MailMarkdown key={j} source={splitFollowups(part.text).text} onLink={onLink} />
        ) : part.kind === 'confirm' ? (
          <div key={j} testId="assistant-confirm" style={{ borderRadius: 8, backgroundColor: C.raised, paddingLeft: 12, paddingRight: 8, paddingTop: 8, paddingBottom: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, color: C.text, fontFamily: FONT }}>{part.question}</text>
            {part.state === 'asking' ? (
              <>
                <Button label="No" variant="ghost" onClick={() => onAnswer(part.id, false)} testId="assistant-confirm-no" />
                <Button label="Yes" variant="primary" onClick={() => onAnswer(part.id, true)} testId="assistant-confirm-yes" />
              </>
            ) : (
              <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{part.state === 'yes' ? 'Confirmed' : 'Declined'}</text>
            )}
          </div>
        ) : part.kind === 'draft' ? (
          <DraftCard key={part.id} id={part.id} draft={part.draft} rewriting={!!part.rewriting} onOpen={onOpenDraft} onRewrite={onRewriteDraft} onCopy={onCopy} />
        ) : // A finished draft tool is the card below it; its row would only repeat it.
        (part.name === 'compose_email' || part.name === 'draft_reply') && part.state === 'ok' ? null : (
          <div key={j} testId="assistant-tool" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 20 }}>
            {part.state === 'running' ? <Spinner size={11} color={C.accent} /> : <Icon name={part.undone ? 'undo' : part.state === 'ok' ? 'check' : 'x'} size={12} color={part.state === 'error' ? C.accent : C.muted} />}
            <text style={{ flexShrink: 1, fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>
              {part.undone ? `${part.label} · Undone` : part.detail && part.state !== 'running' ? `${part.label} · ${part.detail}` : part.label}
            </text>
            {part.undo && !part.undone ? (
              <div testId={`assistant-undo-${part.id}`} onClick={() => onUndo(part.id)} style={{ flexShrink: 0, height: 20, paddingLeft: 6, paddingRight: 6, borderRadius: 5, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}>
                <text style={{ fontSize: 12, fontWeight: 500, color: C.accent, fontFamily: FONT, pointerEvents: 'none' }}>Undo</text>
              </div>
            ) : null}
          </div>
        ),
      )}
      {!entry.done && entry.parts.length === 0 ? <Spinner size={13} color={C.accent} /> : null}
      {sources.length ? (
        <div testId="assistant-sources" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sources.slice(0, MAX_SOURCES).map((t) => (
            <div
              key={t.id}
              testId={`assistant-source-${t.id}`}
              onClick={() => onOpenThread(t.id)}
              style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 8, borderWidth: 1, borderColor: C.divider, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
            >
              <Icon name="mail" size={13} color={C.muted} />
              <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
                <text style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</text>
                <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${t.sender} · ${t.date}`}</text>
              </div>
            </div>
          ))}
          {sources.length > MAX_SOURCES ? <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, paddingLeft: 2 }}>{`+${sources.length - MAX_SOURCES} more in the answer`}</text> : null}
        </div>
      ) : null}
      {entry.error ? <text style={{ fontSize: 12.5, color: entry.error === 'Stopped' ? C.muted : C.accent, fontFamily: FONT }}>{entry.error}</text> : null}
      {entry.done ? (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          {text.trim() ? <IconButton icon="copy" size={13} pad={24} tooltip="Copy response" onClick={() => onCopy(text)} testId={`assistant-copy-${index}`} /> : null}
          {rerunnable && !entry.error ? <IconButton icon="refresh" size={13} pad={24} tooltip="Regenerate" onClick={onRerun} testId="assistant-regenerate" /> : null}
          {rerunnable && entry.error ? <Button label="Try again" variant="ghost" onClick={onRerun} testId="assistant-retry" /> : null}
        </div>
      ) : null}
      {followups.length && !busy ? (
        <div testId="assistant-followups" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {followups.map((f, k) => (
            <div
              key={f}
              testId={`assistant-followup-${k}`}
              onClick={() => onFollowup(f)}
              style={{ height: 26, paddingLeft: 10, paddingRight: 10, borderRadius: 13, borderWidth: 1, borderColor: C.divider, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
            >
              <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{f}</text>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** An email the assistant wrote: read it here, have it rewritten, or take it to the composer. */
function DraftCard({ id, draft, rewriting, onOpen, onRewrite, onCopy }: { id: string; draft: Draft; rewriting: boolean; onOpen: (draft: Draft) => void; onRewrite: (id: string, draft: Draft, how: Rewrite) => void; onCopy: (text: string) => void }) {
  const { C } = useSettings()
  const people = [...draft.to, ...draft.cc]
  return (
    <div testId="assistant-draft" style={{ borderRadius: 10, borderWidth: 1, borderColor: C.divider, backgroundColor: C.raised, display: 'flex', flexDirection: 'column' }}>
      <div style={{ paddingLeft: 12, paddingRight: 6, paddingTop: 6, paddingBottom: 8, display: 'flex', flexDirection: 'column', gap: 1, borderBottomWidth: 1, borderColor: C.divider }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={draft.threadId ? 'reply' : 'mail'} size={12} color={C.muted} />
          <text style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {`${draft.threadId ? 'Reply' : 'New email'} · To ${people.length ? people.join(', ') : 'nobody yet'}`}
          </text>
          {rewriting ? <Spinner size={12} color={C.accent} /> : <IconButton icon="copy" size={13} pad={22} tooltip="Copy text" onClick={() => onCopy(draft.body)} testId="assistant-draft-copy" />}
        </div>
        <text style={{ paddingRight: 6, fontSize: 13, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{draft.subject || '(no subject)'}</text>
      </div>
      <div style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 10 }}>
        <text testId="assistant-draft-body" style={{ fontSize: 13, lineHeight: 19, color: rewriting ? C.secondary : C.text, fontFamily: FONT }}>{draft.body}</text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 6, paddingBottom: 8 }}>
        <Button label={draft.threadId ? 'Open reply' : 'Open draft'} variant="primary" disabled={rewriting} onClick={() => onOpen(draft)} testId="assistant-draft-open" />
        {DRAFT_REWRITES.map(({ how, label }) => (
          <div
            key={how}
            testId={`assistant-draft-${how}`}
            onClick={rewriting ? undefined : () => onRewrite(id, draft, how)}
            style={{ height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 13, borderWidth: 1, borderColor: C.divider, display: 'flex', alignItems: 'center', cursor: rewriting ? 'default' : 'pointer', opacity: rewriting ? 0.5 : 1, hover: rewriting ? undefined : { backgroundColor: C.overlay } }}
          >
            <text style={{ fontSize: 12, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{label}</text>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Saved chats, newest first. */
function ChatHistory({ chats, enabled, current, onOpen, onDelete, onOpenSettings }: { chats: SavedChat[]; enabled: boolean; current: string; onOpen: (chat: SavedChat) => void; onDelete: (id: string) => void; onOpenSettings: () => void }) {
  const { C } = useSettings()
  if (!enabled || !chats.length)
    return (
      <div testId="assistant-history-empty" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, paddingLeft: 32, paddingRight: 32 }}>
        <Icon name="clock" size={24} color={C.muted} />
        <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT, textAlign: 'center' }}>{enabled ? 'Your chats will show up here, kept on this Mac.' : 'Chat history is off. Turn it on in Settings → AI to keep chats on this Mac.'}</text>
        {enabled ? null : <Button label="Open Settings" variant="secondary" onClick={onOpenSettings} testId="assistant-history-settings" />}
      </div>
    )
  return (
    <div testId="assistant-history-list" style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 12 }}>
      {chats.map((c, i) => (
        <div
          key={c.id}
          testId={`assistant-history-${i}`}
          onClick={() => onOpen(c)}
          style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, height: 36, paddingLeft: 10, paddingRight: 4, borderRadius: 8, cursor: 'pointer', backgroundColor: c.id === current ? C.overlay : undefined, hover: { backgroundColor: C.overlay } }}
        >
          <text style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 13, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{c.title}</text>
          <text style={{ flexShrink: 0, fontSize: 11.5, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{chatWhen(c.updatedAt)}</text>
          <IconButton icon="trash" size={13} pad={24} tooltip="Delete chat" onClick={() => onDelete(c.id)} testId={`assistant-history-delete-${i}`} />
        </div>
      ))}
    </div>
  )
}

/** What goes along with a message: above the chat box until sent (removable), then above the message. */
function AttachedLabel({ item, onRemove }: { item: Handoff; onRemove?: () => void }) {
  const { C } = useSettings()
  return (
    <div testId={onRemove ? 'assistant-attached' : 'assistant-sent-attached'} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', alignSelf: onRemove ? 'flex-start' : 'flex-end', gap: 6, maxWidth: 290, height: 24, paddingLeft: 8, paddingRight: onRemove ? 2 : 8, borderRadius: 7, backgroundColor: C.overlay }}>
      <Icon name={item.threadId ? 'mail' : item.contact ? 'user' : 'sparkles'} size={12} color={C.accent} />
      <text style={{ minWidth: 0, flexShrink: 1, fontSize: 12, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.title}</text>
      {onRemove ? <IconButton icon="x" size={11} pad={20} tooltip="Remove" onClick={onRemove} testId="assistant-attached-remove" /> : null}
    </div>
  )
}
