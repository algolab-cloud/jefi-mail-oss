import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Handoff } from './assistant-handoff'
import { parseJefiUrl } from './deeplink'
import { configDir } from './paths'

// ---------------------------------------------------------------------------
// What the assistant panel shows, and the chats it keeps: each one saved on this Mac (owner-only,
// next to the mail database it quotes from) so it can be reopened from the history list, with the
// model's own copy of the conversation so it can be carried on.
// ---------------------------------------------------------------------------

/** An email the assistant wrote, waiting in the chat for the person to open, change or copy. */
export type Draft = { threadId?: string; parentMessageId?: string; to: string[]; cc: string[]; subject: string; body: string }

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'confirm'; id: number; question: string; state: 'asking' | 'yes' | 'no' }
  | { kind: 'tool'; id: string; name: string; label: string; state: 'running' | 'ok' | 'error'; detail?: string; undo?: () => void; undone?: boolean }
  | { kind: 'draft'; id: string; draft: Draft; rewriting?: boolean }

export type UserEntry = { role: 'user'; text: string; handoffs?: Handoff[] }
/** `start`: where this turn began in the provider's history, so it can be rolled back and asked again. */
export type AssistantEntry = { role: 'assistant'; parts: Part[]; error?: string; done: boolean; start?: number }
export type Entry = UserEntry | AssistantEntry

export type ChatProvider = 'anthropic' | 'openai' | 'codex'
export type SavedChat = { id: string; title: string; updatedAt: number; provider: ChatProvider; entries: Entry[]; history: unknown[] }

/** Older chats fall off the end. */
export const MAX_CHATS = 50

const chatsFile = () => {
  const dir = configDir()
  return dir ? `${dir}/assistant-chats.json` : null
}

/** The first thing the person asked, on one line. */
export function chatTitle(entries: Entry[]) {
  const first = entries.find((e): e is UserEntry => e.role === 'user')
  const text = (first?.text ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text || 'New chat'
}

/** The text the assistant wrote in a turn, without the tool rows and cards. */
export const replyText = (entry: AssistantEntry) => entry.parts.flatMap((part) => (part.kind === 'text' ? [splitFollowups(part.text).text] : [])).join('\n\n')

/** The chat as plain text: for copying, and for carrying a chat over to another provider. */
export function transcript(entries: Entry[]) {
  return entries
    .map((e) =>
      e.role === 'user'
        ? `You: ${e.text}${e.handoffs?.length ? `\nAttached: ${e.handoffs.map((h) => h.title).join(', ')}` : ''}`
        : `Assistant: ${[replyText(e), ...e.parts.flatMap((p) => (p.kind === 'draft' ? [`[Draft] To: ${p.draft.to.join(', ')}\nSubject: ${p.draft.subject}\n\n${p.draft.body}`] : []))].filter(Boolean).join('\n\n')}${e.error ? `\n${e.error}` : ''}`,
    )
    .join('\n\n')
}

/** Entries as saved: no functions, no question left hanging, nothing still "running". */
export function settled(entries: Entry[]): Entry[] {
  return entries.map((e) =>
    e.role === 'user'
      ? e
      : {
          ...e,
          done: true,
          ...(e.done ? {} : { error: e.error ?? 'Stopped' }),
          parts: e.parts.map((p): Part => {
            if (p.kind === 'confirm') return p.state === 'asking' ? { ...p, state: 'no' } : p
            if (p.kind === 'draft') return { kind: 'draft', id: p.id, draft: p.draft }
            if (p.kind === 'tool') {
              const { undo: _undo, ...rest } = p
              return { ...rest, state: rest.state === 'running' ? 'error' : rest.state }
            }
            return p
          }),
        },
  )
}

const isChat = (value: unknown): value is SavedChat => {
  const c = value as SavedChat
  return !!c && typeof c.id === 'string' && typeof c.title === 'string' && typeof c.updatedAt === 'number' && ['anthropic', 'openai', 'codex'].includes(c.provider) && Array.isArray(c.entries) && Array.isArray(c.history)
}

export function loadChats(): SavedChat[] {
  const file = chatsFile()
  if (!file) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { chats?: unknown }
    return (Array.isArray(raw.chats) ? raw.chats.filter(isChat) : []).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function write(chats: SavedChat[]) {
  const file = chatsFile()
  if (!file) return
  try {
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    // Written aside and moved into place, so a crash mid-write can't leave half a file.
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ chats }), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
  } catch {}
}

/** Adds or replaces the chat, newest first, keeping the last MAX_CHATS. */
export function saveChat(chat: SavedChat) {
  const chats = [{ ...chat, entries: settled(chat.entries) }, ...loadChats().filter((c) => c.id !== chat.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS)
  write(chats)
}

export function deleteChat(id: string) {
  write(loadChats().filter((c) => c.id !== id))
}

export function clearChats() {
  write([])
}

/** "Today", "Yesterday", "Mon", or "Mar 3", for the history list. */
export function chatWhen(ms: number, now = Date.now()) {
  const day = (t: number) => new Date(t).toDateString()
  if (day(ms) === day(now)) return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (day(ms) === day(now - 86_400_000)) return 'Yesterday'
  if (now - ms < 6 * 86_400_000) return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---------------------------------------------------------------------------
// Follow-ups, sources and re-asking
// ---------------------------------------------------------------------------

const FOLLOWUPS = /<followups>([\s\S]*?)(?:<\/followups>|$)/i

/**
 * The reply without its trailing `<followups>a | b | c</followups>` line, and the suggestions in it.
 * While the reply streams, a half-written tag (`<follo`) is hidden too, so it never flashes on screen.
 */
export function splitFollowups(text: string): { text: string; followups: string[] } {
  const match = text.match(FOLLOWUPS)
  if (match) {
    const followups = (match[1] ?? '')
      .split('|')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 1 && s.length <= 90)
      .slice(0, 3)
    return { text: text.slice(0, match.index).trimEnd(), followups }
  }
  const partial = text.match(/<(f(o(l(l(o(w(u(p(s)?)?)?)?)?)?)?)?)?$/i)
  return { text: partial ? text.slice(0, partial.index).trimEnd() : text, followups: [] }
}

/** The conversations an answer links to (jefi://thread/…), in order, each once. */
export function linkedThreads(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(/\]\((jefi:[^)\s]+)\)|<(jefi:[^>\s]+)>/gi)) {
    const route = parseJefiUrl(match[1] ?? match[2] ?? '')
    if (route?.kind === 'thread' && !ids.includes(route.threadId)) ids.push(route.threadId)
  }
  return ids
}

/** Tools that only look, or only write into the chat: a turn that used nothing else can be asked again safely. */
export const RERUNNABLE_TOOLS = new Set(['search_mail', 'list_threads', 'list_unread_all_accounts', 'read_thread', 'read_attachment', 'open_thread', 'compose_email', 'draft_reply'])

/** Whether running this turn again can't repeat a change to the mailbox (or a question the person answered). */
export const canRerun = (entry: AssistantEntry) => entry.parts.every((p) => p.kind === 'text' || p.kind === 'draft' || (p.kind === 'tool' && RERUNNABLE_TOOLS.has(p.name)))
