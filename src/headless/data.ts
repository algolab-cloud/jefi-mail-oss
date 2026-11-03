import { existsSync, readFileSync } from 'node:fs'
import { configDir } from '../paths'
import { APP_VERSION } from '../version'
import type { MailThread } from '../data'
import { openDatabaseReadOnly, type MailDatabase } from '../engine/db'
import { countInboxUnread, loadThread, loadView } from '../engine/threads'
import { searchThreads } from '../engine/search'
import { getCalendar, listEvents } from '../engine/calendar/store'
import { pendingInvites } from '../engine/calendar/invites'
import { getNote, listNotes } from '../engine/calendar/notes'
import type { Calendar, EventOccurrence, Note, NoteLink } from '../engine/calendar/types'
import { addDays, displaySpan, startOfDay } from '../calendar/dates'
import { findMeetingLink, httpsLinks } from '../engine/calendar/meeting'

// ---------------------------------------------------------------------------
// The read-only data layer behind `Jefi cli` and `Jefi mcp` (docs/integrations.md, sections 2 and 3).
// Opens mail.db read-only and asks the engine's own queries, then maps their results to the
// contract's JSON shapes. accounts.json is read for ids, names and addresses only: never a secret.
// ---------------------------------------------------------------------------

export type Person = { name: string; email: string }
export type ThreadJson = {
  id: string
  accountId: string
  subject: string
  from: Person
  snippet: string
  date: string
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  url: string
}
export type MessageJson = { id: string; from: Person; to: Person[]; cc: Person[]; date: string; subject: string; text: string }
export type EventJson = {
  id: string
  occurrenceStart: number
  title: string
  start: string
  end: string
  allDay: boolean
  location: string | null
  calendar: { id: string; name: string; color: string }
  meetingUrl: string | null
  url: string
}
export type InviteJson = { eventId: string; title: string; start: string; end: string; allDay: boolean; organizer: Person | null; accountId: string; threadId: string }
export type NoteLinkJson = { kind: string; title: string; url: string | null }
export type NoteSummaryJson = { id: string; title: string; snippet: string; updatedAt: string; links: NoteLinkJson[] }
export type NoteJson = { id: string; title: string; body: string; updatedAt: string; links: NoteLinkJson[] }
export type AccountJson = { id: string; name: string; email: string }

/** Plain text per message in `thread`, so one long newsletter can't swamp a caller. */
export const MESSAGE_TEXT_CAP = 20_000
const SNIPPET = 160

/** A mistake the caller can fix (bad id, missing folder): shown as the error, no stack. */
export class HeadlessError extends Error {}

/** Local time as ISO 8601 with its offset (2026-09-26T09:30:00+03:00), as the contract's dates are. */
export function isoLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  )
}

/**
 * The link to join a meeting, from an event's location or notes: a Zoom, Meet, Teams or Webex link
 * wins over any other https link, and the location over the notes.
 */
export function meetingUrl(...texts: Array<string | null | undefined>): string | null {
  return findMeetingLink(...texts) ?? texts.flatMap(httpsLinks).find((link) => URL.canParse(link) && new URL(link).hostname !== '') ?? null
}

const person = (address: { name?: string; email: string } | undefined | null): Person => ({ name: address?.name ?? '', email: address?.email ?? '' })

export function threadJson(accountId: string, thread: MailThread): ThreadJson {
  const latest = thread.messages.at(-1)
  return {
    id: thread.id,
    accountId,
    subject: thread.subject,
    from: latest?.fromAddress ? person(latest.fromAddress) : { name: latest?.from ?? thread.sender, email: latest?.email ?? '' },
    snippet: thread.snippet,
    date: isoLocal(thread.at ?? latest?.timestamp ?? 0),
    unread: thread.unread,
    starred: thread.starred,
    hasAttachments: thread.icons.includes('paperclip'),
    url: `jefi://thread/${encodeURIComponent(thread.id)}`,
  }
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function eventJson(event: EventOccurrence, calendar: Pick<Calendar, 'id' | 'name' | 'color'> | null): EventJson {
  const span = displaySpan(event)
  return {
    id: event.id,
    occurrenceStart: event.occurrenceStart,
    title: event.title,
    start: isoLocal(span.start),
    end: isoLocal(span.end),
    allDay: event.allDay,
    location: event.location,
    calendar: { id: event.calendarId, name: calendar?.name ?? '', color: calendar?.color ?? '' },
    meetingUrl: meetingUrl(event.url, event.location, event.description),
    url: `jefi://event/${encodeURIComponent(event.id)}?start=${event.occurrenceStart}`,
  }
}

function linkJson(link: NoteLink): NoteLinkJson {
  const { target, snapshot } = link
  const title = snapshot.subject ?? snapshot.title ?? snapshot.name ?? snapshot.email ?? ''
  if (target.kind === 'thread' && target.accountId) return { kind: 'thread', title, url: `jefi://thread/${encodeURIComponent(target.threadId)}` }
  // A message id is its conversation's id and its row (`${threadId}-${row}`); the conversation opens.
  if (target.kind === 'message' && target.accountId) return { kind: 'message', title, url: `jefi://thread/${encodeURIComponent(target.messageId.replace(/-\d+$/, ''))}` }
  if (target.kind === 'event') return { kind: 'event', title, url: `jefi://event/${encodeURIComponent(target.eventId)}` }
  if (target.kind === 'contact') return { kind: 'contact', title: title || target.email, url: `mailto:${target.email}` }
  return { kind: target.kind, title, url: null }
}

const noteSnippet = (body: string) => cap(body.replace(/[#>*_`[\]]/g, '').replace(/\s+/g, ' ').trim(), SNIPPET)

export type OpenOptions = { dir?: string | null; now?: () => number }

export type JefiData = ReturnType<typeof openJefiData>

/**
 * Opens Jefi's data in `dir` (configDir() by default: ~/.config/jefi or JEFI_CONFIG_DIR). Throws a
 * HeadlessError when the folder or mail.db isn't there, or the schema isn't this build's.
 */
export function openJefiData(options: OpenOptions = {}) {
  const dir = options.dir ?? configDir()
  if (!dir || !existsSync(dir)) throw new HeadlessError(`Jefi's data folder isn't there (${dir ?? '~/.config/jefi'}). Open Jefi and add an account first.`)
  const path = `${dir}/mail.db`
  if (!existsSync(path)) throw new HeadlessError(`No mail.db in ${dir}. Open Jefi and add an account first.`)
  let db: MailDatabase
  try {
    db = openDatabaseReadOnly(path)
  } catch (err) {
    throw new HeadlessError(err instanceof Error ? err.message : String(err))
  }
  const now = options.now ?? Date.now

  function accounts(): AccountJson[] {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(`${dir}/accounts.json`, 'utf8'))
    } catch {
      return []
    }
    const list = (raw as { accounts?: unknown })?.accounts
    if (!Array.isArray(list)) return []
    // Only these three fields leave: servers, tokens and anything else in the file stay put.
    return list
      .filter((a): a is { id: string; name?: unknown; email: string; label?: unknown } => typeof a?.id === 'string' && typeof a?.email === 'string')
      .map((a) => ({ id: a.id, name: (typeof a.label === 'string' && a.label.trim()) || (typeof a.name === 'string' ? a.name : '') || a.email, email: a.email }))
  }

  function accountIds(account?: string): string[] {
    const all = accounts()
    if (!account) return all.map((a) => a.id)
    const found = all.find((a) => a.id === account || a.email.toLowerCase() === account.toLowerCase())
    if (!found) throw new HeadlessError(`No account "${account}". Run \`accounts\` to list them.`)
    return [found.id]
  }

  const newestFirst = (threads: ThreadJson[], limit: number) => threads.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit)

  const calendars = new Map<string, Calendar | null>()
  const calendarOf = (id: string) => {
    if (!calendars.has(id)) calendars.set(id, getCalendar(db, id))
    return calendars.get(id) ?? null
  }

  /** Occurrences shown in [from, to) on the person's clock, all-day dates as local days. */
  function events(from: number, to: number): EventJson[] {
    if (!(to > from)) throw new HeadlessError('The end of the range must be after its start.')
    const DAY = 86_400_000
    // All-day dates are stored as UTC midnights: a day either side catches them in any zone.
    return listEvents(db, from - DAY, to + DAY)
      .filter((event) => {
        const span = displaySpan(event)
        return span.start < to && (span.end > from || span.start >= from)
      })
      .map((event) => eventJson(event, calendarOf(event.calendarId)))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1))
  }

  return {
    db,
    accounts,

    unread() {
      // Counted in SQL: building every unread conversation took seconds on a big mailbox.
      const byAccount = accounts().map((a) => ({ id: a.id, email: a.email, unread: countInboxUnread(db, a) }))
      return { total: byAccount.reduce((sum, a) => sum + a.unread, 0), accounts: byAccount }
    },

    search(query: string, { limit = 20, account }: { limit?: number; account?: string } = {}): ThreadJson[] {
      if (!query.trim()) throw new HeadlessError('Search needs a query.')
      const out: ThreadJson[] = []
      for (const id of accountIds(account)) {
        for (const thread of searchThreads(db, id, query, { limit })) out.push(threadJson(id, thread))
      }
      return newestFirst(out, limit)
    },

    inbox({ limit = 30, account }: { limit?: number; account?: string } = {}): ThreadJson[] {
      const out: ThreadJson[] = []
      for (const id of accountIds(account)) {
        const page = loadView(db, id, 'inbox', { limit })
        for (const thread of page?.threads ?? []) if (!thread.screened) out.push(threadJson(id, thread))
      }
      return newestFirst(out, limit)
    },

    thread(threadId: string): { thread: ThreadJson; messages: MessageJson[] } {
      const accountId = threadId.includes(':') ? threadId.slice(0, threadId.indexOf(':')) : ''
      const thread = accountId ? loadThread(db, accountId, threadId) : null
      if (!thread) throw new HeadlessError(`No conversation "${threadId}".`)
      return {
        thread: threadJson(accountId, thread),
        messages: thread.messages.map((m) => ({
          id: m.id,
          from: m.fromAddress ? person(m.fromAddress) : { name: m.from, email: m.email },
          to: (m.toAddresses ?? []).map(person),
          cc: (m.ccAddresses ?? []).map(person),
          date: isoLocal(m.timestamp ?? 0),
          subject: thread.subject,
          // HTML mail as the Markdown the reader draws for it, plain mail as its text.
          text: cap(m.markdown ?? m.paragraphs.join('\n\n'), MESSAGE_TEXT_CAP),
        })),
      }
    },

    events,
    today: () => {
      const start = startOfDay(now())
      return events(start, addDays(start, 1))
    },
    agenda: (days = 7) => {
      const start = startOfDay(now())
      return events(start, addDays(start, Math.max(1, Math.floor(days))))
    },

    invites(): InviteJson[] {
      return pendingInvites(db, now()).map((invite) => {
        const span = displaySpan(invite)
        return {
          eventId: invite.eventId,
          title: invite.title,
          start: isoLocal(span.start),
          end: isoLocal(span.end),
          allDay: invite.allDay,
          organizer: invite.organizer ? person(invite.organizer) : null,
          accountId: invite.accountId,
          threadId: invite.threadId,
        }
      })
    },

    notes({ limit = 30, query }: { limit?: number; query?: string } = {}): NoteSummaryJson[] {
      return listNotes(db, query?.trim() || undefined)
        .slice(0, limit)
        .map((note) => ({ id: note.id, title: note.title, snippet: noteSnippet(note.body), updatedAt: isoLocal(note.updatedAt), links: note.links.map(linkJson) }))
    },

    note(noteId: string): NoteJson {
      const note: Note | null = getNote(db, noteId)
      if (!note) throw new HeadlessError(`No note "${noteId}".`)
      return { id: note.id, title: note.title, body: note.body, updatedAt: isoLocal(note.updatedAt), links: note.links.map(linkJson) }
    },

    version: () => ({ version: APP_VERSION }),

    close: () => db.close(),
  }
}
