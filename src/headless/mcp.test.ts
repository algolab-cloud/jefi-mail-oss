import { afterAll, beforeAll, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { buildFixture } from './fixture'
import { openJefiData, type JefiData } from './data'
import { PROTOCOL_VERSIONS, RESULT_CAP, handleLine, handleMessage, jefiUrl, type McpContext } from './mcp'

let fixture: Awaited<ReturnType<typeof buildFixture>>
let data: JefiData

beforeAll(async () => {
  fixture = await buildFixture({ mcpEnabled: true })
  data = openJefiData({ dir: fixture.dir })
})
afterAll(() => {
  data?.close()
  fixture?.cleanup()
})

const ENTRY = `${import.meta.dir}/../mail.tsx`

/** Runs `bun src/mail.tsx mcp` over stdio: writes each request, then reads a response per request. */
async function session(requests: object[], env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', ENTRY, 'mcp'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, JEFI_CONFIG_DIR: fixture.dir, ...env },
  })
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stderr, responses: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
}

test('a round trip over stdio: initialize, tools/list, tools/call search_mail', async () => {
  const { code, responses } = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_mail', arguments: { query: 'invoice' } } },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
  ])
  expect(code).toBe(0)
  expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4])
  expect(responses[0].result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jefi' } })
  expect(responses[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
    'search_mail',
    'list_inbox',
    'read_thread',
    'list_events',
    'today',
    'list_invites',
    'search_notes',
    'read_note',
    'draft_email',
    'create_event',
    'create_note',
  ])
  const call = responses[2].result
  expect(call.isError).toBe(false)
  expect(JSON.parse(call.content[0].text).map((t: { subject: string }) => t.subject)).toEqual(['Invoice for March'])
  expect(responses[3].result).toEqual({})
}, 20_000)

test('refuses to start while the setting is off', async () => {
  writeFileSync(`${fixture.dir}/settings.json`, JSON.stringify({ mcpEnabled: false }))
  try {
    const { code, stderr, responses } = await session([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }])
    expect(code).toBe(1)
    expect(stderr).toContain('Settings → Integrations')
    expect(responses).toEqual([])
  } finally {
    writeFileSync(`${fixture.dir}/settings.json`, JSON.stringify({ mcpEnabled: true }))
  }
}, 20_000)

function context() {
  const opened: string[] = []
  const ctx: McpContext = { data: () => data, open: (url) => void opened.push(url) }
  return { ctx, opened }
}
const call = (ctx: McpContext, name: string, args: object = {}) => handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, ctx)!.result as { content: Array<{ text: string }>; isError: boolean }

test('protocol version: the client offer when known, else the newest', () => {
  const { ctx } = context()
  const offer = (protocolVersion: string) => (handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }, ctx)!.result as { protocolVersion: string }).protocolVersion
  expect(offer('2024-11-05')).toBe('2024-11-05')
  expect(offer('2099-01-01')).toBe(PROTOCOL_VERSIONS[0]!)
})

test('JSON-RPC errors: unknown method, unknown tool, bad JSON; notifications get no reply', () => {
  const { ctx } = context()
  expect(handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, ctx)!.error!.code).toBe(-32601)
  expect(handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_mail' } }, ctx)!.error!.code).toBe(-32602)
  expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }, ctx)).toBeNull()
  expect(JSON.parse(handleLine('{nope', ctx)[0]!).error.code).toBe(-32700)
})

test('read tools return the data layer JSON; tool mistakes are isError results', () => {
  const { ctx } = context()
  expect(JSON.parse(call(ctx, 'today').content[0]!.text).map((e: { title: string }) => e.title)).toEqual(['Offsite', 'Standup', 'Gym'])
  expect(JSON.parse(call(ctx, 'list_inbox', { limit: 1 }).content[0]!.text)).toHaveLength(1)
  expect(JSON.parse(call(ctx, 'read_note', { noteId: fixture.noteId }).content[0]!.text).title).toBe('Trip ideas')
  expect(JSON.parse(call(ctx, 'list_invites').content[0]!.text)[0].title).toBe('Planning')
  expect(call(ctx, 'read_note', { noteId: 'nope' })).toEqual({ content: [{ type: 'text', text: 'No note "nope".' }], isError: true } as never)
  expect(call(ctx, 'search_mail', {}).isError).toBe(true)
  expect(call(ctx, 'list_events', { from: '2026-01-01', to: '2028-01-01' }).content[0]!.text).toMatch(/at most a year/)
})

test('results are capped', () => {
  const big: McpContext = { data: () => ({ ...data, notes: () => [{ id: 'n', title: 'x'.repeat(RESULT_CAP * 2), snippet: '', updatedAt: '', links: [] }] }) as JefiData, open: () => {} }
  const text = call(big, 'search_notes').content[0]!.text
  expect(text.length).toBeLessThan(RESULT_CAP + 100)
  expect(text).toContain('cut at')
})

test('act tools only open jefi:// links and confirm', () => {
  const { ctx, opened } = context()
  expect(call(ctx, 'draft_email', { to: ['ada@example.com', 'bob@example.com'], subject: 'Q3 & more', body: 'Hi Ada,\nsee you' }).content[0]!.text).toBe(
    'Opened a draft in Jefi for you to review and send.',
  )
  expect(call(ctx, 'create_event', { title: 'Lunch', start: '2026-10-02T12:00:00+03:00', end: '2026-10-02T13:00:00+03:00', location: 'Café' }).isError).toBe(false)
  expect(call(ctx, 'create_note', { title: 'Ideas', body: '- one' }).isError).toBe(false)
  expect(call(ctx, 'create_event', { title: 'Nope', start: 'whenever' }).isError).toBe(true)
  expect(opened).toEqual([
    'jefi://compose?to=ada%40example.com%2Cbob%40example.com&subject=Q3%20%26%20more&body=Hi%20Ada%2C%0Asee%20you',
    'jefi://new-event?title=Lunch&start=2026-10-02T12%3A00%3A00%2B03%3A00&end=2026-10-02T13%3A00%3A00%2B03%3A00&location=Caf%C3%A9',
    'jefi://new-note?title=Ideas&body=-%20one',
  ])
  expect(jefiUrl('new-event', { title: 'All day', start: '2026-10-02', allDay: '1', notes: undefined })).toBe('jefi://new-event?title=All%20day&start=2026-10-02&allDay=1')
})

test("act tools fail instead of opening a link the app would drop or empty", () => {
  const { ctx, opened } = context()
  const error = (name: string, args: Record<string, unknown>) => {
    const result = call(ctx, name, args)
    expect(result.isError).toBe(true)
    return result.content[0]!.text
  }
  // jefi:// links over MAX_URL are ignored by the app: the draft would never appear.
  expect(error('draft_email', { to: ['ada@example.com'], subject: 'Long', body: 'é'.repeat(3000) })).toMatch(/too long to open in Jefi/)
  expect(error('create_note', { title: 'Long', body: 'x'.repeat(9000) })).toMatch(/too long/)
  // Addresses the link parser would silently drop.
  expect(error('draft_email', { to: ['Ada'], subject: 's', body: 'b' })).toMatch(/at least one email address/)
  expect(error('draft_email', { to: ['ada@example.com', 'bob'], subject: 's', body: 'b' })).toBe('Not an email address: bob')
  // Dates Date.parse reads but the link parser doesn't: the event would open with no time.
  expect(error('create_event', { title: 'Lunch', start: 'October 2, 2026 12:00' })).toMatch(/ISO 8601/)
  expect(error('create_event', { title: 'Lunch', start: '2026-10-02 12:00' })).toMatch(/ISO 8601/)
  expect(error('create_event', { title: 'Lunch', start: '2026-10-02T13:00', end: '2026-10-02T12:00' })).toMatch(/after "start"/)
  expect(opened).toEqual([])
  expect(call(ctx, 'draft_email', { to: ['Ada Lovelace <ada@example.com>'], subject: 's', body: 'b' }).isError).toBe(false)
  expect(call(ctx, 'create_event', { title: 'Offsite', start: '2026-10-02', end: '2026-10-03', allDay: true }).isError).toBe(false)
  expect(opened).toHaveLength(2)
})
