import { afterAll, beforeAll, expect, test } from 'bun:test'
import { buildFixture } from './fixture'
import { parseCliArgs, runCli } from './cli'
import { headlessMode } from './gate'
import { APP_VERSION } from '../version'
import { setupSnippets, snippetDisplayLines } from './setup'

let fixture: Awaited<ReturnType<typeof buildFixture>>

beforeAll(async () => {
  fixture = await buildFixture()
})
afterAll(() => fixture?.cleanup())

const cli = (...argv: string[]) => runCli(argv, { dir: fixture.dir })
const json = (...argv: string[]) => {
  const { code, stdout } = cli(...argv, '--json')
  return { code, value: JSON.parse(stdout) }
}

test('the mode is argv[2], under bun and in the compiled binary alike', () => {
  expect(headlessMode(['bun', '/repo/src/mail.tsx', 'cli', 'today'])).toBe('cli')
  expect(headlessMode(['bun', '/$bunfs/root/Jefi', 'mcp'])).toBe('mcp')
  expect(headlessMode(['bun', '/$bunfs/root/Jefi'])).toBeNull()
  expect(headlessMode(['bun', '/repo/src/mail.tsx', '--hot'])).toBeNull()
})

test('arguments: command, positionals, value flags and --json anywhere', () => {
  expect(parseCliArgs(['search', 'from:ada', 'invoice', '--limit', '5', '--json', '--account=acct'])).toEqual({
    command: 'search',
    positional: ['from:ada', 'invoice'],
    flags: { limit: '5', account: 'acct' },
    json: true,
  })
  expect(() => parseCliArgs(['inbox', '--bogus', '1'])).toThrow(/Unknown option --bogus/)
  expect(() => parseCliArgs(['inbox', '--limit'])).toThrow(/needs a value/)
})

test('--json prints the contract shapes', () => {
  expect(json('accounts').value).toEqual([{ id: fixture.accountId, name: 'Work', email: 'me@example.com' }])
  expect(json('unread').value.total).toBe(2)
  expect(json('search', 'invoice').value.map((t: { subject: string }) => t.subject)).toEqual(['Invoice for March'])
  expect(json('inbox', '--limit', '2').value).toHaveLength(2)
  expect(json('today').value.map((e: { title: string }) => e.title)).toEqual(['Offsite', 'Standup', 'Gym'])
  expect(json('agenda', '--days', '3').value.filter((e: { title: string }) => e.title === 'Gym')).toHaveLength(3)
  expect(json('invites').value[0].title).toBe('Planning')
  expect(json('notes', '--query', 'lisbon').value[0].id).toBe(fixture.noteId)
  expect(json('note', fixture.noteId).value.title).toBe('Trip ideas')
  expect(json('version').value).toEqual({ version: APP_VERSION })
  const day = new Date(fixture.today)
  const from = day.toISOString()
  const to = new Date(fixture.today + 86_400_000).toISOString()
  expect(json('events', '--from', from, '--to', to).value.map((e: { title: string }) => e.title)).toEqual(['Offsite', 'Standup', 'Gym'])
  const thread = json('thread', json('search', 'tacos').value[0].id).value
  expect(thread.messages[0].text).toContain('Tacos on Friday?')
})

test('errors exit 1 with {error} under --json, a plain line otherwise', () => {
  expect(cli('note', 'nope', '--json')).toEqual({ code: 1, stdout: '{"error":"No note \\"nope\\"."}\n' })
  expect(cli('note', 'nope')).toEqual({ code: 1, stdout: 'jefi: No note "nope".\n' })
  expect(json('events', '--from', 'soon', '--to', 'later')).toEqual({ code: 1, value: { error: "--from isn't a date: soon" } })
  expect(json('inbox', '--limit', '0').value.error).toMatch(/whole number/)
  expect(json('frobnicate').value.error).toMatch(/Unknown command "frobnicate"/)
  expect(runCli(['today', '--json'], { dir: `${fixture.dir}/absent` }).code).toBe(1)
})

test('version needs no data folder', () => {
  expect(runCli(['version'], { dir: `${fixture.dir}/absent` })).toEqual({ code: 0, stdout: `${APP_VERSION}\n` })
})

test('human output is a short table', () => {
  const inbox = cli('inbox')
  expect(inbox.code).toBe(0)
  expect(inbox.stdout).toContain('Invoice for March')
  expect(inbox.stdout).toContain('Ada Lovelace')
  const today = cli('today').stdout
  expect(today).toContain('all day')
  expect(today).toContain('https://acme.zoom.us/j/123456?pwd=abc')
  expect(cli('unread').stdout).toStartWith('2 unread')
  expect(cli('note', fixture.noteId).stdout).toStartWith('Trip ideas\n\n# Lisbon')
})

test('setup snippets name the executable with `mcp`, and the CLI path', () => {
  const [claude, codex, other, cliSnippet] = setupSnippets(['/Applications/Jefi.app/Contents/MacOS/Jefi'])
  expect(JSON.parse(claude!.text)).toEqual({ mcpServers: { jefi: { command: '/Applications/Jefi.app/Contents/MacOS/Jefi', args: ['mcp'] } } })
  expect(codex!.text).toBe('[mcp_servers.jefi]\ncommand = "/Applications/Jefi.app/Contents/MacOS/Jefi"\nargs = ["mcp"]')
  expect(other!.text).toBe('/Applications/Jefi.app/Contents/MacOS/Jefi mcp')
  expect(cliSnippet!.text).toBe('/Applications/Jefi.app/Contents/MacOS/Jefi cli today')
  expect(setupSnippets(['/opt/bun', '/My Code/src/mail.tsx'])[2]!.text).toBe("/opt/bun '/My Code/src/mail.tsx' mcp")
})

test('snippets paint as wrappable lines that read back as the text Copy copies', () => {
  for (const snippet of setupSnippets(['/Users/someone/.bun/bin/bun', '/Users/someone/Development/projects/a-long-folder-name/src/mail.tsx'])) {
    const lines = snippetDisplayLines(snippet.text)
    // Only zero-width spaces and no-break indentation are added, never anything Copy would carry.
    expect(lines.join('\n').replace(/\u200b/g, '').replace(/\u00a0/g, ' ')).toBe(snippet.text)
    // The long path breaks at its slashes.
    expect(lines.some((line) => line.includes('/\u200bDevelopment/\u200bprojects'))).toBe(true)
  }
  expect(snippetDisplayLines('{\n  "a": 1\n}')).toEqual(['{', '\u00a0\u00a0"a": 1', '}'])
})

test('help, --help and -h print the usage and succeed; no command prints it and fails', () => {
  for (const argv of [['help'], ['--help'], ['-h'], ['search', '--help']]) {
    const result = runCli(argv, { dir: `${fixture.dir}/absent` })
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith('Usage: Jefi cli <command>')
  }
  const bare = runCli([], { dir: `${fixture.dir}/absent` })
  expect(bare.code).toBe(1)
  expect(bare.stdout).toStartWith('Usage: Jefi cli <command>')
})
