import { countRender } from './render-counts'
import { useEffect, useRef, useState } from 'react'
import type { PublicInstance } from '@gpuix/react'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { FONT, THEMES, TOPBAR_HEIGHT, useSettings } from './theme'
import { Icon, IconButton } from './icons'
import { Button } from './ui'
import { Spinner } from './toast'
import { MailMarkdown } from './markdown'
import { useMail, type BulkAction } from './store'
import { useAi } from './use-ai'
import { usePaneWidth } from './resizer'
import { floatingObstacle } from './html-view'
import { aiErrorMessage, threadForModel } from './ai'
import { clearHandoff, currentHandoff, useHandoff, withHandoff } from './assistant-handoff'
import { assistantUnavailableText, describeTool, needsConfirmation, runAssistant, runAssistantOpenAI, type AssistantEvent, type AssistantTools, type Folder, type ThreadAction } from './assistant'
import { replyRecipients } from './reply'
import { runAssistantCodex, type CodexTurn } from './assistant-codex'
import { accountName } from './accounts'
import type { DraftFields, MailThread } from './data'
import { dispatchJefiUrl, parseJefiUrl } from './deeplink'

// ---------------------------------------------------------------------------
// The Assistant panel: chat with Claude or OpenAI about your mail. It can search, read, open conversations,
// write emails and replies (into the composer, never sent), and tidy up with the app's own actions.
// ---------------------------------------------------------------------------

export const ASSISTANT_WIDTH = 380

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'confirm'; id: number; question: string; state: 'asking' | 'yes' | 'no' }
  | { kind: 'tool'; id: string; label: string; state: 'running' | 'ok' | 'error'; detail?: string }
type Entry = { role: 'user'; text: string; attached?: string } | { role: 'assistant'; parts: Part[]; error?: string; done: boolean }

/** The unpinned chat box. */
const FLOAT_WIDTH = 400
const FLOAT_HEIGHT = 580

const CATCH_UP = 'Catch me up on unread mail'
/** With several accounts the catch-up covers all of them. */
const CATCH_UP_ALL = 'Catch me up on unread mail across all my accounts'
const SUGGESTIONS = [CATCH_UP, 'What needs a reply from me?', 'Write an email to…', 'Archive newsletters older than a week']

const ACTIONS: Record<ThreadAction, BulkAction> = {
  archive: { move: 'archive' },
  trash: { move: 'trash' },
  move_to_inbox: { move: 'inbox' },
  mark_read: { unread: false },
  mark_unread: { unread: true },
  star: { starred: true },
  unstar: { starred: false },
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
  useEffect(() => {
    if (pinned) return
    floatingObstacle.current = floatRef.current
    return () => void (floatingObstacle.current = null)
  }, [pinned])
  countRender('AssistantPanel')
  const store = useMail()
  const ai = useAi()
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [inputKey, setInputKey] = useState(0)
  const handoff = useHandoff()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  // Each provider keeps the conversation in its own format; switching provider starts a new chat.
  const history = useRef<{ provider: 'anthropic' | 'openai' | 'codex'; claude: Anthropic.Beta.BetaMessageParam[]; openai: OpenAI.Responses.ResponseInputItem[]; codex: CodexTurn[] }>({
    provider: 'anthropic',
    claude: [],
    openai: [],
    codex: [],
  })
  const connection = ai.enabled ? ai.connection : null
  const provider = connection?.provider ?? null
  const abort = useRef<AbortController | null>(null)
  // Tools read live state: a request can outlast the render that started it.
  const live = useRef(store)
  live.current = store

  // A yes/no card in the chat; the tool call waits on the answer.
  const confirms = useRef(new Map<number, (ok: boolean) => void>())
  const confirm = (question: string) =>
    new Promise<boolean>((resolve) => {
      const id = Date.now() + Math.random()
      confirms.current.set(id, resolve)
      update((entry) => ({ ...entry, parts: [...entry.parts, { kind: 'confirm', id, question, state: 'asking' }] }))
    })
  const answer = (id: number, ok: boolean) => {
    confirms.current.get(id)?.(ok)
    confirms.current.delete(id)
    setEntries((prev) => prev.map((e) => (e.role === 'assistant' ? { ...e, parts: e.parts.map((p) => (p.kind === 'confirm' && p.id === id ? { ...p, state: ok ? 'yes' : 'no' } : p)) } : e)))
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
  const findThread = (id: string) => {
    const thread = live.current.threads.find((t) => t.id === id) ?? elsewhere.current.get(id)?.thread
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
    open_thread: async ({ thread_id }) => {
      findThread(thread_id)
      const owner = elsewhere.current.get(thread_id)?.accountId
      if (owner && owner !== live.current.account.id) live.current.showThread(owner, thread_id)
      else onOpenThread(thread_id)
      return { summary: 'Opened' }
    },
    compose_email: async ({ to, cc, subject, body }) => {
      onCompose({ to, cc: cc ?? [], bcc: [], subject, body })
      return { summary: 'Opened in the composer, not sent' }
    },
    draft_reply: async ({ thread_id, body, reply_all }) => {
      const thread = findThread(thread_id)
      await inAccountOf([thread_id])
      const selected = thread.messages.at(-1)!
      const recipients = replyRecipients(selected, reply_all ? 'replyAll' : 'reply', live.current.accounts.map((account) => account.email))
      onCompose(
        { ...recipients, bcc: [], subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`, body },
        { replyTo: thread_id, parentMessageId: selected.id, title: 'Reply' },
      )
      return { summary: 'Opened in the composer, not sent' }
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
      live.current.bulk(ids, ACTIONS[action])
      return { summary: ids.length === 1 ? '1 conversation' : `${ids.length} conversations` }
    },
    snooze_thread: async ({ thread_id, until }) => {
      findThread(thread_id)
      await inAccountOf([thread_id])
      live.current.snooze(thread_id, until)
      return { summary: `Until ${until.toLowerCase()}` }
    },
    label_thread: async ({ thread_id, label }) => {
      const thread = findThread(thread_id)
      await inAccountOf([thread_id])
      const match = live.current.labels.find((l) => l.label.toLowerCase() === label.trim().toLowerCase())
      if (!match) throw new Error(`No label called "${label}". Existing labels: ${live.current.labels.map((l) => l.label).join(', ') || 'none'}`)
      if (!thread.labels.includes(match.id)) live.current.toggleLabel(thread_id, match.id)
      return { summary: match.label }
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
    ].join('\n')
  }

  const update = (change: (entry: Extract<Entry, { role: 'assistant' }>) => Extract<Entry, { role: 'assistant' }>) =>
    setEntries((prev) => {
      const last = prev[prev.length - 1]
      return last?.role === 'assistant' ? [...prev.slice(0, -1), change(last)] : prev
    })

  const send = (text: string) => {
    const message = text.trim()
    // `busy` is state and lags a frame behind: a second Enter right away would start a second run.
    if (!message || busy || running.current || !connection) return
    running.current = true
    const h = history.current
    if (h.provider !== connection.provider) {
      h.provider = connection.provider
      h.claude = []
      h.openai = []
      h.codex = []
      setEntries([])
    }
    setInput('')
    setInputKey((k) => k + 1)
    // Read now, not from the render: the person may have removed it a moment ago.
    const attached = currentHandoff()
    const modelMessage = withHandoff(message, attached)
    clearHandoff()
    setEntries((prev) => [...prev, { role: 'user', text: message, attached: attached?.title }, { role: 'assistant', parts: [], done: false }])
    // Where this turn starts, so a stopped or failed turn can be rolled back whole (a dangling tool call would break the next one).
    const list = connection.provider === 'anthropic' ? h.claude : connection.provider === 'openai' ? h.openai : h.codex
    const start = list.length
    const rollback = () => {
      list.length = start
    }
    const controller = (abort.current = new AbortController())
    const onEvent = (event: AssistantEvent) => {
      if (event.type === 'text')
        update((entry) => {
          const last = entry.parts[entry.parts.length - 1]
          return last?.kind === 'text'
            ? { ...entry, parts: [...entry.parts.slice(0, -1), { kind: 'text', text: last.text + event.text }] }
            : { ...entry, parts: [...entry.parts, { kind: 'text', text: event.text }] }
        })
      else if (event.type === 'tool') update((entry) => ({ ...entry, parts: [...entry.parts, { kind: 'tool', id: event.id, label: describeTool(event.name, event.input), state: 'running' }] }))
      else
        update((entry) => ({
          ...entry,
          parts: entry.parts.map((p) => (p.kind === 'tool' && p.id === event.id ? { ...p, state: event.ok ? 'ok' : 'error', detail: event.summary } : p)),
        }))
    }
    setBusy(true)
    const run =
      connection.provider === 'anthropic'
        ? (h.claude.push({ role: 'user', content: modelMessage }), runAssistant(connection.key, connection.model, h.claude, context(), tools, onEvent, controller.signal))
        : connection.provider === 'openai'
          ? (h.openai.push({ role: 'user', content: modelMessage }), runAssistantOpenAI(connection.key, connection.model, h.openai, context(), tools, onEvent, controller.signal))
          : (h.codex.push({ role: 'user', text: modelMessage }), runAssistantCodex(connection.model, h.codex, context(), tools, onEvent, controller.signal))
    run
      .then(() => update((entry) => ({ ...entry, done: true })))
      .catch((error) => {
        rollback()
        update((entry) => ({ ...entry, done: true, error: controller.signal.aborted ? 'Stopped' : aiErrorMessage(error) }))
      })
      .finally(() => {
        running.current = false
        setBusy(false)
      })
  }

  const openLink = (url: string) => {
    const route = parseJefiUrl(url)
    const id = route?.kind === 'thread' ? route.threadId : null
    const owner = id ? elsewhere.current.get(id)?.accountId : undefined
    if (id && owner && owner !== live.current.account.id) live.current.showThread(owner, id)
    else if (id && live.current.threads.some((t) => t.id === id)) onOpenThread(id)
    // Any other jefi:// link goes through the same router as links from outside Jefi.
    else if (route) dispatchJefiUrl(url)
    else if (/^https?:/.test(url)) Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
  }

  const newChat = () => {
    declinePending()
    abort.current?.abort()
    history.current = { provider: history.current.provider, claude: [], openai: [], codex: [] }
    elsewhere.current.clear()
    setEntries([])
  }

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
        <text style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Assistant</text>
        <IconButton icon="plus" size={15} pad={26} tooltip="New chat" onClick={newChat} testId="assistant-new" />
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
      ) : (
        <>
          <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', gap: 14, paddingLeft: 16, paddingRight: 16, paddingTop: 6, paddingBottom: 12 }}>
            {entries.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12 }}>
                <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT, paddingBottom: 4 }}>{`Ask about your mail, or have ${ai.providerName} write and tidy up for you. Nothing is sent without you.`}</text>
                {SUGGESTIONS.map((s) => (s === CATCH_UP && store.accounts.length > 1 ? CATCH_UP_ALL : s)).map((s, i) => (
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
                    {entry.attached ? <AttachedLabel title={entry.attached} /> : null}
                    <div style={{ maxWidth: 290, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 12, backgroundColor: C.chip }}>
                      <text style={{ fontSize: 13.5, lineHeight: 19, color: C.text, fontFamily: FONT }}>{entry.text}</text>
                    </div>
                  </div>
                ) : (
                  <div key={i} testId="assistant-reply" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {entry.parts.map((part, j) =>
                      part.kind === 'text' ? (
                        <MailMarkdown key={j} source={part.text} onLink={openLink} />
                      ) : part.kind === 'confirm' ? (
                        <div key={j} testId="assistant-confirm" style={{ borderRadius: 8, backgroundColor: C.raised, paddingLeft: 12, paddingRight: 8, paddingTop: 8, paddingBottom: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, color: C.text, fontFamily: FONT }}>{part.question}</text>
                          {part.state === 'asking' ? (
                            <>
                              <Button label="No" variant="ghost" onClick={() => answer(part.id, false)} testId="assistant-confirm-no" />
                              <Button label="Yes" variant="primary" onClick={() => answer(part.id, true)} testId="assistant-confirm-yes" />
                            </>
                          ) : (
                            <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{part.state === 'yes' ? 'Confirmed' : 'Declined'}</text>
                          )}
                        </div>
                      ) : (
                        <div key={j} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                          {part.state === 'running' ? <Spinner size={11} color={C.accent} /> : <Icon name={part.state === 'ok' ? 'check' : 'x'} size={12} color={part.state === 'ok' ? C.muted : C.accent} />}
                          <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>
                            {part.detail && part.state !== 'running' ? `${part.label} · ${part.detail}` : part.label}
                          </text>
                        </div>
                      ),
                    )}
                    {!entry.done && entry.parts.length === 0 ? <Spinner size={13} color={C.accent} /> : null}
                    {entry.error ? <text style={{ fontSize: 12.5, color: entry.error === 'Stopped' ? C.muted : C.accent, fontFamily: FONT }}>{entry.error}</text> : null}
                  </div>
                ),
              )
            )}
          </div>

          <div style={{ flexShrink: 0, paddingLeft: 12, paddingRight: 12, paddingBottom: 12 }}>
            <div style={{ borderRadius: 10, backgroundColor: C.raised, paddingLeft: 12, paddingRight: 6, paddingTop: 8, paddingBottom: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {handoff ? <AttachedLabel title={handoff.title} onRemove={clearHandoff} /> : null}
              <textarea
                key={inputKey}
                testId="assistant-input"
                autoFocus
                value={input}
                placeholder={handoff ? 'Ask about it, or have it drafted into a reply…' : `Ask ${ai.providerName} about your mail…`}
                minRows={1}
                maxRows={6}
                onChange={(event) => setInput(event.value ?? '')}
                // Enter sends (it arrives as submit once this is set); the text comes with it, so a
                // quick Enter after typing can't send what the field held a frame earlier.
                onSubmit={(event) => send(event.value ?? input)}
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

/** What goes along with a message: above the chat box until sent (removable), then above the message. */
function AttachedLabel({ title, onRemove }: { title: string; onRemove?: () => void }) {
  const { C } = useSettings()
  return (
    <div testId={onRemove ? 'assistant-attached' : 'assistant-sent-attached'} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', alignSelf: onRemove ? 'flex-start' : 'flex-end', gap: 6, maxWidth: 290, height: 24, paddingLeft: 8, paddingRight: onRemove ? 2 : 8, borderRadius: 7, backgroundColor: C.overlay }}>
      <Icon name="sparkles" size={12} color={C.accent} />
      <text style={{ minWidth: 0, flexShrink: 1, fontSize: 12, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</text>
      {onRemove ? <IconButton icon="x" size={11} pad={20} tooltip="Remove" onClick={onRemove} testId="assistant-attached-remove" /> : null}
    </div>
  )
}
