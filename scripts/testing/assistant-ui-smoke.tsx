/** Isolated native smoke check: bun scripts/testing/assistant-ui-smoke.tsx */
import { expect, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createTestRoot } from '@gpuix/react/testing'

// Saved chats go to a throwaway folder, never the real ~/.config/jefi.
const configDir = mkdtempSync(`${tmpdir()}/jefi-assistant-smoke-`)
process.env.JEFI_CONFIG_DIR = configDir

const { DEFAULT_SETTINGS, SettingsContext, palette } = await import('../../src/theme')
const { chatAboutThread, clearHandoff, currentHandoff, currentHandoffs } = await import('../../src/assistant-handoff')
const { loadChats } = await import('../../src/assistant-chats')
const { setContacts } = await import('../../src/contacts')
import type { MailThread } from '../../src/data'
import type { AssistantEvent, AssistantTools } from '../../src/assistant'

const thread = {
  id: 'work:budget', subject: 'Budget review', sender: 'Ada', date: 'Today', folder: 'inbox', labels: [], icons: [],
  messages: [{ id: 'm1', from: 'Ada', email: 'ada@example.com', to: 'me@example.com', time: 'Today', face: {}, paragraphs: ['Please review the revised budget by Friday.'], fromAddress: { name: 'Ada', email: 'ada@example.com' } }],
} as unknown as MailThread
const offsite = { ...thread, id: 'work:offsite', subject: 'Team offsite', sender: 'Grace', messages: [{ ...thread.messages[0]!, id: 'm2', from: 'Grace', email: 'grace@example.com', fromAddress: { name: 'Grace', email: 'grace@example.com' } }] } as unknown as MailThread
setContacts([{ name: 'Grace Hopper', email: 'grace@example.com', face: {} } as never])

const copied: string[] = []
const fetched: string[] = []
const requests: string[] = []
const composed: Array<{ initial: unknown; extra: unknown }> = []
const moves: string[] = []
const store = {
  account: { id: 'work', name: 'Me', email: 'me@example.com' },
  accounts: [{ id: 'work', name: 'Me', email: 'me@example.com' }],
  threads: [thread, offsite], labels: [], notify: () => {},
  fetchThread: async (id: string) => { fetched.push(id); return id === offsite.id ? offsite : thread },
  bulk: (ids: string[], action: { move?: string }) => { moves.push(`${action.move}:${ids.join(',')}`); return () => moves.push(`undo:${ids.join(',')}`) },
}
mock.module('../../src/store', () => ({ useMail: () => store }))
mock.module('../../src/use-ai', () => ({ useAi: () => ({ enabled: true, connection: { provider: 'anthropic', key: 'fake', model: 'fake' }, providerName: 'Claude' }) }))
const native = await import('../../src/native/mail-webview')
mock.module('../../src/native/mail-webview', () => ({ ...native, copyText: (text: string) => { copied.push(text); return true } }))
const ai = await import('../../src/ai')
mock.module('../../src/ai', () => ({
  ...ai,
  rewriteEmail: async (_c: unknown, _body: string, how: string, stream: { onText: (t: string) => void }) => { stream.onText(`Shorter (${how}).`); return `Shorter (${how}).` },
}))
const assistant = await import('../../src/assistant')
let failure = false
let tool = false
let answers = 0
mock.module('../../src/assistant', () => ({
  ...assistant,
  runAssistant: async (_key: string, _model: string, history: Array<{ role: string; content: unknown }>, _context: string, tools: AssistantTools, onEvent: (event: AssistantEvent) => void) => {
    const message = String(history.at(-1)?.content)
    requests.push(message)
    if (tool) onEvent({ type: 'tool', id: 'tool-1', name: 'update_threads', input: { thread_ids: [thread.id], action: 'archive' } })
    if (failure) throw new Error('Connection interrupted')
    if (message.endsWith('Draft a reply')) {
      await assistant.execute('draft-1', 'draft_reply', { thread_id: thread.id, body: 'Thanks Ada, I will review it by Friday.' }, tools, onEvent)
      onEvent({ type: 'text', text: 'Here is a reply.' })
    } else if (message.endsWith('Archive it')) {
      await assistant.execute('archive-1', 'update_threads', { thread_ids: [thread.id], action: 'archive' }, tools, onEvent)
      onEvent({ type: 'text', text: 'Archived it.' })
    } else {
      onEvent({ type: 'text', text: `Review [Budget review](jefi://thread/work%3Abudget) by **Friday** (${++answers}).\n<followups>Draft a reply | Archive it</followups>` })
    }
    history.push({ role: 'assistant', content: 'ok' })
  },
}))
const { AssistantPanel } = await import('../../src/assistant-panel')
const root = createTestRoot({ width: 420, height: 900 })
const settle = async () => { await new Promise((r) => setTimeout(r, 30)); root.renderer.flush() }
const has = (id: string) => !!root.renderer.findByTestId(id)
const click = async (id: string) => {
  const node = root.renderer.findByTestId(id)
  if (!node) throw new Error(`Missing ${id}`)
  const b = root.renderer.getElementBounds(node.id)!
  root.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2)
  root.renderer.dispatchNativeEvents()
  await settle()
}
const type = async (id: string, keys: string) => {
  root.renderer.nativeSimulateKeystrokes(root.renderer.findByTestId(id)!.id, keys)
  root.renderer.dispatchNativeEvents()
  await settle()
}
const opened: string[] = []
try {
  chatAboutThread(thread)
  root.render(
    <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS, assistantPinned: true, aiInstructions: 'Keep it short.' }, C: palette('dark', 'red'), update: () => {} }}>
      <div style={{ width: 420, height: 900, display: 'flex' }}>
        <AssistantPanel onClose={() => {}} onOpenThread={(id) => opened.push(id)} onCompose={(initial, extra) => composed.push({ initial, extra })} onOpenSettings={() => {}} view="Inbox" openThread={null} />
      </div>
    </SettingsContext.Provider>,
  )
  await settle()

  // A thread attached from its menu goes in whole; the answer's sources and follow-ups show under it.
  expect(has('assistant-attached')).toBe(true)
  await click('assistant-suggestion-0')
  expect(fetched).toEqual([thread.id])
  expect(requests[0]).toContain('revised budget by Friday')
  expect(requests[0]).toContain('Email thread_id: work:budget')
  expect(currentHandoff()).toBeNull()
  expect(has('assistant-source-work:budget')).toBe(true)
  expect(has('assistant-followup-0')).toBe(true)
  await click('assistant-copy-1')
  expect(copied.at(-1)).toBe('Review [Budget review](jefi://thread/work%3Abudget) by **Friday** (1).')
  await click('assistant-source-work:budget')
  expect(opened).toEqual([thread.id])

  // Regenerate replaces the answer rather than adding one.
  await click('assistant-regenerate')
  expect(requests).toHaveLength(2)
  expect(has('assistant-copy-3')).toBe(false)
  expect(copied.length).toBe(1)
  await click('assistant-copy-1')
  expect(copied.at(-1)).toContain('(2)')

  // A follow-up drafts a reply: a card in the chat, rewritten in place, opened as a real reply.
  mkdirSync('tmp', { recursive: true })
  root.renderer.captureScreenshot('tmp/assistant-answer.png')
  await click('assistant-followup-0')
  expect(has('assistant-draft')).toBe(true)
  await click('assistant-draft-shorter')
  await settle()
  expect(root.renderer.findByTestId('assistant-draft-body')).toBeTruthy()
  await click('assistant-draft-open')
  expect(composed.at(-1)).toMatchObject({ initial: { to: ['ada@example.com'], body: 'Shorter (shorter).' }, extra: { replyTo: thread.id, parentMessageId: 'm1' } })

  // An archive from the chat can be taken back from the chat.
  await type('assistant-input', 'A r c h i v e space i t enter')
  expect(moves).toEqual([`archive:${thread.id}`])
  expect(has('assistant-undo-archive-1')).toBe(true)
  expect(has('assistant-regenerate')).toBe(false)
  await click('assistant-undo-archive-1')
  expect(moves).toEqual([`archive:${thread.id}`, `undo:${thread.id}`])
  expect(has('assistant-undo-archive-1')).toBe(false)

  // @ brings in more conversations and people.
  await type('assistant-input', 'C o m p a r e space @ o f f')
  expect(has('assistant-mentions')).toBe(true)
  await type('assistant-input', 'enter')
  expect(currentHandoffs().map((h) => h.threadId)).toEqual([offsite.id])
  await type('assistant-input', 'space @ g r a c e')
  await click('assistant-mention-0')
  expect(currentHandoffs().map((h) => h.contact ?? h.threadId)).toEqual([offsite.id, 'grace@example.com'])
  expect(has('assistant-mentions')).toBe(false)
  await click('assistant-send')
  expect(requests.at(-1)).toContain('<attached title="Team offsite">')
  expect(requests.at(-1)).toContain('Person: Grace Hopper <grace@example.com>')
  mkdirSync('tmp', { recursive: true })
  root.renderer.captureScreenshot('tmp/assistant-controls.png')

  // The chat was kept, and comes back from the history list.
  expect(loadChats()[0]?.entries.length).toBe(8)
  await click('assistant-new')
  expect(has('assistant-suggestion-0')).toBe(true)
  await click('assistant-history')
  expect(has('assistant-history-0')).toBe(true)
  root.renderer.captureScreenshot('tmp/assistant-history.png')
  await click('assistant-history-0')
  expect(has('assistant-draft')).toBe(true)
  expect(has('assistant-source-work:budget')).toBe(true)

  // Retry after a failure; none once a tool changed something.
  await click('assistant-new')
  failure = true
  await click('assistant-suggestion-0')
  expect(has('assistant-retry')).toBe(true)
  failure = false
  await click('assistant-retry')
  expect(has('assistant-retry')).toBe(false)
  expect(has('assistant-copy-1')).toBe(true)
  expect(has('assistant-copy-3')).toBe(false)

  await click('assistant-new')
  failure = true
  tool = true
  await click('assistant-suggestion-0')
  expect(has('assistant-retry')).toBe(false)
  console.log('Assistant smoke passed: thread context, sources, follow-ups, regenerate, draft cards, undo, @-mentions, history, retry.')
} finally {
  root.unmount()
  clearHandoff()
  rmSync(configDir, { recursive: true, force: true })
}
