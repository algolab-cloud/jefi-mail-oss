import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TOOLS, assistantUnavailableText, execute, needsConfirmation, runAssistant, runAssistantOpenAI, toolsFor, type AssistantEvent, type AssistantTools } from './assistant'
import { runAssistantCodex, type CodexTurn } from './assistant-codex'
import { forgetCodexPath } from './codex-path'
import { aiConnection } from './ai'

// ---------------------------------------------------------------------------
// The cross-account catch-up tool: offered to every backend only when the app provides it (more
// than one account), and its results name each conversation's account.
// ---------------------------------------------------------------------------

const noop = async () => ({ summary: 'Done' })
const base: AssistantTools = {
  search_mail: async () => [],
  list_threads: async () => [],
  read_thread: noop,
  open_thread: noop,
  compose_email: noop,
  draft_reply: noop,
  update_threads: noop,
  snooze_thread: noop,
  label_thread: noop,
}
const catchUp = [{ thread_id: 'acct-work:t1', subject: 'Budget', from: 'Ada', account: 'Work <me@work.example>' }]
const withAll: AssistantTools = { ...base, list_unread_all_accounts: async () => catchUp }
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)

test('the all-accounts tool is defined only when the app provides it', () => {
  expect(names(TOOLS)).toContain('list_unread_all_accounts')
  expect(names(toolsFor(base))).not.toContain('list_unread_all_accounts')
  expect(names(toolsFor(base))).toContain('list_threads')
  expect(names(toolsFor(withAll))).toContain('list_unread_all_accounts')
})

test('its results carry the account; without it the call is an unknown tool', async () => {
  const events: AssistantEvent[] = []
  const ok = await execute('1', 'list_unread_all_accounts', { limit: 10 }, withAll, (e) => events.push(e))
  expect(ok.ok).toBe(true)
  expect(JSON.parse(ok.content)[0].account).toBe('Work <me@work.example>')
  expect(events.at(-1)).toEqual({ type: 'tool-result', id: '1', ok: true, summary: '1 conversation' })
  expect(await execute('2', 'list_unread_all_accounts', { limit: 0 }, withAll, () => {})).toMatchObject({ ok: false })
  expect(await execute('3', 'list_unread_all_accounts', {}, base, () => {})).toEqual({ ok: false, content: 'Invalid input: unknown tool list_unread_all_accounts' })
})

// The SDKs talk to the network through fetch: capture what they would send and answer with a
// minimal finished stream.
const realFetch = globalThis.fetch
let sent: Array<{ url: string; body: Record<string, unknown> }> = []
afterEach(() => {
  globalThis.fetch = realFetch
  sent = []
})
const sse = (events: Array<[string, unknown]>) =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
function fakeFetch(reply: () => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sent.push({ url, body: JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))) })
    return reply()
  }) as typeof fetch
}

const anthropicDone = () =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
const openAIDone = () =>
  sse([['response.completed', { type: 'response.completed', sequence_number: 0, response: { id: 'r', object: 'response', output: [], status: 'completed' } }]])

test('Anthropic gets the all-accounts tool only when it is provided', async () => {
  fakeFetch(anthropicDone)
  await runAssistant('key', undefined, [{ role: 'user', content: 'Catch me up' }], 'ctx', withAll, () => {})
  await runAssistant('key', undefined, [{ role: 'user', content: 'Catch me up' }], 'ctx', base, () => {})
  expect(sent.map((s) => names(s.body.tools as Array<{ name: string }>).includes('list_unread_all_accounts'))).toEqual([true, false])
})

test('what is on screen goes into each new message, so earlier requests are never rewritten', async () => {
  fakeFetch(anthropicDone)
  const history: Parameters<typeof runAssistant>[2] = [{ role: 'user', content: 'Catch me up' }]
  await runAssistant('key', undefined, history, 'On screen: Inbox', base, () => {})
  history.push({ role: 'user', content: 'And Work?' })
  await runAssistant('key', undefined, history, 'On screen: Work', base, () => {})
  const [first, second] = sent.map((s) => s.body as { system: unknown; messages: unknown[] })
  // Newer Claude models reject a conversation whose system prompt or earlier turns changed.
  expect(second!.system).toEqual(first!.system)
  expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages)
  expect(second!.messages.at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: '<app_context>\nOn screen: Work\n</app_context>' },
      { type: 'text', text: 'And Work?' },
    ],
  })
})

test('OpenAI gets the all-accounts tool only when it is provided', async () => {
  fakeFetch(openAIDone)
  await runAssistantOpenAI('key', undefined, [{ role: 'user', content: 'Catch me up' }], 'ctx', withAll, () => {})
  await runAssistantOpenAI('key', undefined, [{ role: 'user', content: 'Catch me up' }], 'ctx', base, () => {})
  expect(sent.map((s) => names(s.body.tools as Array<{ name: string }>).includes('list_unread_all_accounts'))).toEqual([true, false])
})

test('nothing is sent anywhere while AI is off', () => {
  const keys = { anthropic: 'sk-ant', openai: 'sk-openai' }
  const off = { aiEnabled: false, aiProvider: 'anthropic', aiOpenAiMode: 'key', aiModels: { anthropic: '', openai: '', codex: '' } } as unknown as Parameters<typeof aiConnection>[0]
  // The panel only runs a backend with a connection; with AI off there is none.
  expect(aiConnection(off, keys, true)).toBeNull()
  expect(aiConnection({ ...off, aiProvider: 'openai', aiOpenAiMode: 'codex' } as typeof off, keys, true)).toBeNull()
})

// Codex: a fake CLI that lists the MCP tools Jefi serves, calls the catch-up tool, and replies.
const directory = mkdtempSync(`${tmpdir()}/jefi-assistant-test-`)
const binary = `${directory}/codex`
const listed = `${directory}/tools.json`
const called = `${directory}/called.json`
const previousBinary = process.env.JEFI_CODEX_BINARY
beforeAll(() => {
  writeFileSync(
    binary,
    `#!/bin/sh
url=""
for arg in "$@"; do
  case "$arg" in mcp_servers.jefi.url=*) url=\${arg#mcp_servers.jefi.url=}; url=\${url#\\"}; url=\${url%\\"} ;; esac
done
post() { curl -s -X POST -H "authorization: Bearer $JEFI_MCP_TOKEN" -H 'content-type: application/json' -d "$1" "$url"; }
post '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' > "${listed}"
post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_unread_all_accounts","arguments":{"limit":5}}}' > "${called}"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"You have 1 unread in Work."}}'
`,
  )
  chmodSync(binary, 0o755)
  process.env.JEFI_CODEX_BINARY = binary
  // An earlier test file may have looked Codex up already; the answer is cached.
  forgetCodexPath()
})
afterAll(() => {
  if (previousBinary === undefined) delete process.env.JEFI_CODEX_BINARY
  else process.env.JEFI_CODEX_BINARY = previousBinary
  forgetCodexPath()
  rmSync(directory, { recursive: true, force: true })
})

test('Codex sees the all-accounts tool over MCP and gets accounts back', async () => {
  const history: CodexTurn[] = [{ role: 'user', text: 'Catch me up' }]
  await runAssistantCodex(undefined, history, 'ctx', withAll, () => {})
  expect(history.at(-1)).toEqual({ role: 'assistant', text: 'You have 1 unread in Work.' })
  const tools = JSON.parse(readFileSync(listed, 'utf8')).result.tools as Array<{ name: string }>
  expect(names(tools)).toContain('list_unread_all_accounts')
  const result = JSON.parse(readFileSync(called, 'utf8')).result
  expect(result.isError).toBe(false)
  expect(JSON.parse(result.content[0].text)[0].account).toBe('Work <me@work.example>')

  await runAssistantCodex(undefined, [{ role: 'user', text: 'Catch me up' }], 'ctx', base, () => {})
  expect(names(JSON.parse(readFileSync(listed, 'utf8')).result.tools)).not.toContain('list_unread_all_accounts')
  expect(JSON.parse(readFileSync(called, 'utf8')).result.isError).toBe(true)
})

test('changes to more than three conversations, and any trash, ask the person first', () => {
  expect(needsConfirmation(1, 'archive')).toBe(false)
  expect(needsConfirmation(3, 'mark_read')).toBe(false)
  expect(needsConfirmation(4, 'archive')).toBe(true)
  expect(needsConfirmation(40, 'star')).toBe(true)
  expect(needsConfirmation(1, 'trash')).toBe(true)
})

test('the assistant says why it is unavailable, pointing at the actual fix', () => {
  const base = { loaded: true, aiEnabled: false, codexSelected: false, available: false, providerName: 'Claude' }
  expect(assistantUnavailableText(base)).toStartWith('Turn on AI features in Settings → AI')
  expect(assistantUnavailableText({ ...base, loaded: false })).toBe('Checking your Keychain for an API key…')
  expect(assistantUnavailableText({ ...base, loaded: false, codexSelected: true })).toBe('Checking your ChatGPT sign-in…')
  expect(assistantUnavailableText({ ...base, aiEnabled: true })).toBe('Add your Claude API key in Settings → AI to use the assistant.')
  expect(assistantUnavailableText({ ...base, aiEnabled: true, codexSelected: true, codexError: 'Not signed in to ChatGPT.' })).toBe('Not signed in to ChatGPT.')
})
