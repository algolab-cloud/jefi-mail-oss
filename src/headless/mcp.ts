import { readSync, writeSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { APP_VERSION } from '../version'
import { HeadlessError, type JefiData } from './data'
import { MAX_URL, isoInstant, parseJefiUrl, recipients, type JefiRoute } from '../deeplink'

// ---------------------------------------------------------------------------
// `Jefi mcp`: a Model Context Protocol server over stdio (docs/integrations.md, section 3). Reads go
// through the read-only data layer; the three act tools only open jefi:// links, so the person
// reviews the draft, event or note in Jefi and nothing is sent or saved without them.
//
// Synchronous on purpose: it runs from gate.ts before the rest of the app has loaded, and blocking
// reads of stdin keep the UI modules from ever evaluating (see gate.ts).
// ---------------------------------------------------------------------------

/** Newest first; the first one is what a client that offers something else gets. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
/** A tool result's text is cut here, so one call can't flood the model's context. */
export const RESULT_CAP = 100_000
const MAX_LIMIT = 50

type Json = Record<string, unknown>
type Schema = { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties: false }
type Tool = { name: string; title: string; description: string; inputSchema: Schema; readOnly: boolean; run: (args: Json, ctx: McpContext) => string }

export type McpContext = {
  data: () => JefiData
  /** Opens a jefi:// URL in the running app (macOS `open`). */
  open: (url: string) => void
}

const str = (description: string): Json => ({ type: 'string', description })
const limit = (fallback: number): Json => ({ type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `How many to return (default ${fallback}, at most ${MAX_LIMIT}).` })
const schema = (properties: Record<string, Json>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false })

function need(args: Json, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new HeadlessError(`"${name}" is required.`)
  return value
}
const optional = (args: Json, name: string) => (typeof args[name] === 'string' && (args[name] as string).trim() ? (args[name] as string) : undefined)
function limitOf(args: Json, fallback: number) {
  const value = args.limit
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new HeadlessError('"limit" must be a whole number above 0.')
  return Math.min(value, MAX_LIMIT)
}
function timeOf(args: Json, name: string) {
  const t = Date.parse(need(args, name))
  if (!Number.isFinite(t)) throw new HeadlessError(`"${name}" isn't an ISO 8601 date.`)
  return t
}
/** An event time the app's jefi://new-event link keeps: a YYYY-MM-DD day or an ISO 8601 date-time. */
function instantOf(args: Json, name: string) {
  const value = need(args, name).trim()
  if (!isoInstant(value)) throw new HeadlessError(`"${name}" must be ISO 8601, like 2026-10-02 or 2026-10-02T12:00:00+03:00.`)
  return value
}

/**
 * Opens a jefi:// link only if the app will take it as asked: the app drops a link longer than
 * MAX_URL and anything its parser can't read, and saying "opened" then would be a lie.
 */
function openLink(ctx: McpContext, url: string, kind: JefiRoute['kind']): JefiRoute {
  if (url.length > MAX_URL) throw new HeadlessError(`That is too long to open in Jefi (${url.length.toLocaleString('en-US')} characters as a link, at most ${MAX_URL.toLocaleString('en-US')}). Shorten the text and try again.`)
  const route = parseJefiUrl(url)
  if (route?.kind !== kind) throw new HeadlessError("Jefi couldn't read that request.")
  ctx.open(url)
  return route
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** A jefi:// URL with its query values encoded; empty values are left out. */
export function jefiUrl(route: string, query: Record<string, string | undefined>): string {
  const params = Object.entries(query)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  return `jefi://${route}${params.length ? `?${params.join('&')}` : ''}`
}

const addresses = (value: unknown) => (Array.isArray(value) ? value.filter((a) => typeof a === 'string').join(',') : typeof value === 'string' ? value : '')

export const TOOLS: Tool[] = [
  {
    name: 'search_mail',
    title: 'Search mail',
    description: 'Searches mail in Jefi, newest first. Supports the app\'s operators: from:, to:, subject:, has:attachment, is:unread, is:starred, in:inbox|sent|archive, before:/after:YYYY-MM-DD.',
    inputSchema: schema({ query: str('What to search for.'), limit: limit(20) }, ['query']),
    readOnly: true,
    run: (args, ctx) => json(ctx.data().search(need(args, 'query'), { limit: limitOf(args, 20) })),
  },
  {
    name: 'list_inbox',
    title: 'List inbox',
    description: 'The newest conversations in the inbox, across accounts or for one.',
    inputSchema: schema({ limit: limit(30), account: str('An account id or email address (see the accounts in results); all accounts when left out.') }),
    readOnly: true,
    run: (args, ctx) => json(ctx.data().inbox({ limit: limitOf(args, 30), account: optional(args, 'account') })),
  },
  {
    name: 'read_thread',
    title: 'Read a conversation',
    description: 'Every message of a conversation as plain text (each capped at 20,000 characters).',
    inputSchema: schema({ threadId: str('The conversation id from search_mail or list_inbox.') }, ['threadId']),
    readOnly: true,
    run: (args, ctx) => json(ctx.data().thread(need(args, 'threadId'))),
  },
  {
    name: 'list_events',
    title: 'List events',
    description: 'Calendar events between two dates, in start order, repeating events expanded.',
    inputSchema: schema({ from: str('Start, ISO 8601.'), to: str('End, ISO 8601.') }, ['from', 'to']),
    readOnly: true,
    run: (args, ctx) => {
      const from = timeOf(args, 'from')
      const to = timeOf(args, 'to')
      // A year at most: repeating events expand to one entry per occurrence.
      if (to - from > 366 * 86_400_000) throw new HeadlessError('Ask for at most a year of events at a time.')
      return json(ctx.data().events(from, to))
    },
  },
  {
    name: 'today',
    title: 'Today',
    description: "Today's calendar events, in start order.",
    inputSchema: schema({}),
    readOnly: true,
    run: (_args, ctx) => json(ctx.data().today()),
  },
  {
    name: 'list_invites',
    title: 'List invitations',
    description: 'Invitations received by email that are still waiting for a reply.',
    inputSchema: schema({}),
    readOnly: true,
    run: (_args, ctx) => json(ctx.data().invites()),
  },
  {
    name: 'search_notes',
    title: 'Search notes',
    description: 'Notes, pinned first then most recently edited; with a query, the best matches.',
    inputSchema: schema({ query: str('Words to find in titles and bodies.'), limit: limit(30) }),
    readOnly: true,
    run: (args, ctx) => json(ctx.data().notes({ query: optional(args, 'query'), limit: limitOf(args, 30) })),
  },
  {
    name: 'read_note',
    title: 'Read a note',
    description: 'A note in full (Markdown) with its links to mail and events.',
    inputSchema: schema({ noteId: str('The note id from search_notes.') }, ['noteId']),
    readOnly: true,
    run: (args, ctx) => json(ctx.data().note(need(args, 'noteId'))),
  },
  {
    name: 'draft_email',
    title: 'Draft an email',
    description: 'Opens a new message in Jefi, filled in, for the person to review and send. Nothing is sent.',
    inputSchema: schema(
      {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
        subject: str('Subject.'),
        body: str('Body, plain text or Markdown.'),
        cc: { type: 'array', items: { type: 'string' }, description: 'Cc addresses.' },
      },
      ['to', 'subject', 'body'],
    ),
    readOnly: false,
    run: (args, ctx) => {
      const to = addresses(args.to)
      if (!recipients(to).length) throw new HeadlessError('"to" needs at least one email address, like ada@example.com.')
      const cc = addresses(args.cc)
      const dropped = [...to.split(/[,;]/), ...cc.split(/[,;]/)].map((a) => a.trim()).filter((a) => a && !recipients(a).length)
      if (dropped.length) throw new HeadlessError(`Not an email address: ${dropped.join(', ')}`)
      openLink(ctx, jefiUrl('compose', { to, cc, subject: typeof args.subject === 'string' ? args.subject : '', body: typeof args.body === 'string' ? args.body : '' }), 'compose')
      return 'Opened a draft in Jefi for you to review and send.'
    },
  },
  {
    name: 'create_event',
    title: 'Create an event',
    description: "Opens Jefi's event editor, filled in, for the person to review and save. Nothing is saved until they do.",
    inputSchema: schema(
      {
        title: str('Title.'),
        start: str('Start, ISO 8601 (a date alone for an all-day event).'),
        end: str('End, ISO 8601.'),
        allDay: { type: 'boolean', description: 'An all-day event.' },
        location: str('Where.'),
        notes: str('Notes.'),
      },
      ['title', 'start'],
    ),
    readOnly: false,
    run: (args, ctx) => {
      const title = need(args, 'title')
      const start = instantOf(args, 'start')
      const end = optional(args, 'end') ? instantOf(args, 'end') : undefined
      if (end && Date.parse(end) <= Date.parse(start)) throw new HeadlessError('"end" must be after "start".')
      openLink(ctx, jefiUrl('new-event', { title, start, end, allDay: args.allDay === true ? '1' : undefined, location: optional(args, 'location'), notes: optional(args, 'notes') }), 'new-event')
      return 'Opened the event in Jefi for you to review and save.'
    },
  },
  {
    name: 'create_note',
    title: 'Create a note',
    description: 'Opens a new note in Jefi, filled in.',
    inputSchema: schema({ title: str('Title.'), body: str('Body, Markdown.') }, ['title', 'body']),
    readOnly: false,
    run: (args, ctx) => {
      openLink(ctx, jefiUrl('new-note', { title: need(args, 'title'), body: typeof args.body === 'string' ? args.body : '' }), 'new-note')
      return 'Opened a new note in Jefi for you to review.'
    },
  },
]

const toolList = () =>
  TOOLS.map(({ name, title, description, inputSchema, readOnly }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { title, readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  }))

type Request = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }
export type Response = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const reply = (id: Request['id'], result: unknown): Response => ({ jsonrpc: '2.0', id: id ?? null, result })
const failure = (id: Request['id'], code: number, message: string): Response => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

function capText(text: string) {
  return text.length > RESULT_CAP ? `${text.slice(0, RESULT_CAP)}\n… (cut at ${RESULT_CAP} characters; ask for fewer results)` : text
}

/** One JSON-RPC message in, its response out (null for notifications). */
export function handleMessage(message: unknown, ctx: McpContext): Response | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return failure(null, -32600, 'Invalid request')
  const { id, method, params = {} } = message as Request
  const notification = id === undefined
  if (typeof method !== 'string') return notification ? null : failure(id, -32600, 'Invalid request')
  switch (method) {
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jefi', title: 'Jefi Mail', version: APP_VERSION },
        instructions:
          "Jefi is the person's mail, calendar and notes app. Read tools return JSON from their local data. The draft_email, create_event and create_note tools only open Jefi prefilled: the person reviews, sends or saves it themselves.",
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: toolList() })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name)
      if (!tool) return failure(id, -32602, `Unknown tool: ${String(params.name)}`)
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Json) : {}
      try {
        return reply(id, { content: [{ type: 'text', text: capText(tool.run(args, ctx)) }], isError: false })
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default:
      if (notification) return null
      return failure(id, -32601, `Method not found: ${method}`)
  }
}

/** Handles one line of newline-delimited JSON-RPC; returns the lines to write back. */
export function handleLine(line: string, ctx: McpContext): string[] {
  if (!line.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return [JSON.stringify(failure(null, -32700, 'Parse error'))]
  }
  const responses = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => handleMessage(m, ctx)).filter((r): r is Response => r !== null)
  if (!responses.length) return []
  return [JSON.stringify(Array.isArray(parsed) ? responses : responses[0])]
}

/** Serves stdin → stdout until stdin closes. Blocking reads, see the header. */
export function serveStdio(ctx: McpContext) {
  const buffer = Buffer.alloc(64 * 1024)
  // A character split across two reads is held back until its last byte arrives.
  const decoder = new StringDecoder('utf8')
  let pending = ''
  for (;;) {
    let read = 0
    try {
      read = readSync(0, buffer, 0, buffer.length, null)
    } catch (err) {
      // A non-blocking stdin (some launchers hand one over) says "not yet" instead of waiting.
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
        Bun.sleepSync(10)
        continue
      }
      if ((err as NodeJS.ErrnoException).code === 'EOF') break
      throw err
    }
    if (read === 0) break
    pending += decoder.write(buffer.subarray(0, read))
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      for (const out of handleLine(line, ctx)) writeSync(1, `${out}\n`)
    }
  }
  for (const out of handleLine(pending + decoder.end(), ctx)) writeSync(1, `${out}\n`)
}
