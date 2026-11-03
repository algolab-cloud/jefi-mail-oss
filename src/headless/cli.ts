import { APP_VERSION } from '../version'
import { HeadlessError, openJefiData, type EventJson, type JefiData, type ThreadJson } from './data'
import { selftest, type SelftestResult } from './selftest'

// ---------------------------------------------------------------------------
// `Jefi cli <command> [--json]` (docs/integrations.md, section 2). Synchronous from argv to output:
// it runs before the rest of the app has loaded (see gate.ts), so nothing here may wait on an event.
// ---------------------------------------------------------------------------

export type CliArgs = { command: string; positional: string[]; flags: Record<string, string>; json: boolean }

const VALUE_FLAGS = new Set(['limit', 'account', 'days', 'from', 'to', 'query'])

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: '', positional: [], flags: {}, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') out.json = true
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined]
      if (!VALUE_FLAGS.has(name)) throw new HeadlessError(`Unknown option --${name}.`)
      const value = inline ?? argv[++i]
      if (value === undefined) throw new HeadlessError(`--${name} needs a value.`)
      out.flags[name] = value
    } else if (!out.command) out.command = arg
    else out.positional.push(arg)
  }
  return out
}

const USAGE = `Usage: Jefi cli <command> [--json]

  accounts                                 Your accounts
  unread                                   Unread count in each inbox
  search <query> [--limit 20] [--account id]
  inbox [--limit 30] [--account id]
  thread <threadId>                        A conversation, as plain text
  today | agenda [--days 7]                Events
  events --from <ISO> --to <ISO>
  invites                                  Invitations awaiting your reply
  notes [--limit 30] [--query q]
  note <noteId>
  version`

function count(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new HeadlessError(`--${name} must be a whole number above 0.`)
  return Math.min(n, 1000)
}

function time(value: string | undefined, name: string): number {
  if (!value) throw new HeadlessError(`events needs --${name} <ISO date>.`)
  const t = Date.parse(value)
  if (!Number.isFinite(t)) throw new HeadlessError(`--${name} isn't a date: ${value}`)
  return t
}

/** Runs one command against the data; returns the JSON value. */
export function runCommand(args: CliArgs, data: () => JefiData): unknown {
  const { command, positional, flags } = args
  switch (command) {
    case 'accounts':
      return data().accounts()
    case 'unread':
      return data().unread()
    case 'search': {
      const query = positional.join(' ')
      if (!query.trim()) throw new HeadlessError('search needs a query.')
      return data().search(query, { limit: count(flags.limit, 20, 'limit'), account: flags.account })
    }
    case 'inbox':
      return data().inbox({ limit: count(flags.limit, 30, 'limit'), account: flags.account })
    case 'thread':
      if (!positional[0]) throw new HeadlessError('thread needs a thread id.')
      return data().thread(positional[0])
    case 'today':
      return data().today()
    case 'agenda':
      return data().agenda(count(flags.days, 7, 'days'))
    case 'events':
      return data().events(time(flags.from, 'from'), time(flags.to, 'to'))
    case 'invites':
      return data().invites()
    case 'notes':
      return data().notes({ limit: count(flags.limit, 30, 'limit'), query: flags.query ?? (positional.join(' ') || undefined) })
    case 'note':
      if (!positional[0]) throw new HeadlessError('note needs a note id.')
      return data().note(positional[0])
    case 'version':
      return { version: APP_VERSION }
    default:
      throw new HeadlessError(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE)
  }
}

// --- Human output ---------------------------------------------------------------------------------

const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)
const shortDate = (iso: string) => iso.slice(0, 16).replace('T', ' ')

function threadLine(t: ThreadJson) {
  return `${t.unread ? '•' : ' '} ${shortDate(t.date)}  ${clip(t.from.name || t.from.email, 22).padEnd(22)}  ${clip(t.subject, 60)}\n    ${t.id}`
}

function eventLine(e: EventJson) {
  const when = e.allDay ? `${e.start.slice(0, 10)} all day   ` : `${shortDate(e.start)}-${e.end.slice(11, 16)}`
  return `${when}  ${e.title}${e.location ? ` (${e.location})` : ''}${e.meetingUrl ? `\n    ${e.meetingUrl}` : ''}`
}

export function humanOutput(command: string, value: unknown): string {
  const list = (items: unknown[], line: (item: never) => string, empty: string) => (items.length ? items.map((item) => line(item as never)).join('\n') : empty)
  switch (command) {
    case 'accounts':
      return list(value as unknown[], (a: { id: string; name: string; email: string }) => `${a.name} <${a.email}>  ${a.id}`, 'No accounts.')
    case 'unread': {
      const u = value as { total: number; accounts: Array<{ email: string; unread: number }> }
      return [`${u.total} unread`, ...u.accounts.map((a) => `  ${a.email}: ${a.unread}`)].join('\n')
    }
    case 'search':
    case 'inbox':
      return list(value as unknown[], threadLine, 'No conversations.')
    case 'thread': {
      const t = value as ReturnType<JefiData['thread']>
      return [
        t.thread.subject,
        ...t.messages.map((m) => `\n--- ${m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}, ${shortDate(m.date)}\n\n${m.text}`),
      ].join('\n')
    }
    case 'today':
    case 'agenda':
    case 'events':
      return list(value as unknown[], eventLine, 'No events.')
    case 'invites':
      return list(value as unknown[], (i: { title: string; start: string; organizer: { name: string; email: string } | null }) => `${shortDate(i.start)}  ${i.title}${i.organizer ? `  from ${i.organizer.name || i.organizer.email}` : ''}`, 'No invitations waiting.')
    case 'notes':
      return list(value as unknown[], (n: { id: string; title: string; snippet: string }) => `${n.title || '(untitled)'}  ${n.id}${n.snippet ? `\n    ${clip(n.snippet, 80)}` : ''}`, 'No notes.')
    case 'note': {
      const n = value as { title: string; body: string }
      return `${n.title}\n\n${n.body}`
    }
    case 'version':
      return (value as { version: string }).version
    default:
      return JSON.stringify(value, null, 2)
  }
}

const selftestOutput = (r: SelftestResult) =>
  [`Frameworks: ${r.frameworks}`, ...r.helpers.map((h) => `${h.ok ? 'ok  ' : 'FAIL'}  ${h.file}${h.error ? `  ${h.error}` : ''}`)].join('\n')

/** The whole CLI: argv after `cli` in, exit code and stdout text out. */
export function runCli(argv: string[], options: { dir?: string | null; now?: () => number; selftest?: () => SelftestResult } = {}): { code: number; stdout: string } {
  const json = argv.includes('--json')
  let opened: JefiData | null = null
  try {
    // Asking for help is not a mistake: the usage on its own, and success.
    if (argv.length === 0 || argv.some((arg) => arg === '--help' || arg === '-h') || argv[0] === 'help') {
      return { code: argv.length === 0 ? 1 : 0, stdout: `${USAGE}\n` }
    }
    const args = parseCliArgs(argv)
    // Internal (release workflow), so not in USAGE; a failed helper is a failed run.
    if (args.command === 'selftest') {
      const result = (options.selftest ?? selftest)()
      return { code: result.ok ? 0 : 1, stdout: `${json ? JSON.stringify(result, null, 2) : selftestOutput(result)}\n` }
    }
    const value = runCommand(args, () => (opened ??= openJefiData(options)))
    return { code: 0, stdout: `${json ? JSON.stringify(value, null, 2) : humanOutput(args.command, value)}\n` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { code: 1, stdout: `${json ? JSON.stringify({ error: message }) : `jefi: ${message}`}\n` }
  } finally {
    ;(opened as JefiData | null)?.close()
  }
}
