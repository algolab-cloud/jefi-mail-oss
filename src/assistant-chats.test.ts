import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { canRerun, chatTitle, clearChats, deleteChat, linkedThreads, loadChats, MAX_CHATS, replyText, saveChat, settled, splitFollowups, transcript, type AssistantEntry, type Entry } from './assistant-chats'

let dir = ''
const before = process.env.JEFI_CONFIG_DIR
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/jefi-chats-`)
  process.env.JEFI_CONFIG_DIR = dir
})
afterEach(() => {
  if (before === undefined) delete process.env.JEFI_CONFIG_DIR
  else process.env.JEFI_CONFIG_DIR = before
  rmSync(dir, { recursive: true, force: true })
})

const answer = (parts: AssistantEntry['parts'], extra: Partial<AssistantEntry> = {}): AssistantEntry => ({ role: 'assistant', parts, done: true, ...extra })

test('follow-ups come off the end of a reply and become buttons; a half-written tag never shows', () => {
  expect(splitFollowups('Done.\n<followups>Draft a reply | Archive these |  Who else is on this? | Fourth</followups>')).toEqual({
    text: 'Done.',
    followups: ['Draft a reply', 'Archive these', 'Who else is on this?'],
  })
  expect(splitFollowups('Done.\n<follo')).toEqual({ text: 'Done.', followups: [] })
  expect(splitFollowups('Done.\n<followups>Draft a re')).toEqual({ text: 'Done.', followups: ['Draft a re'] })
  expect(splitFollowups('Use <b> tags')).toEqual({ text: 'Use <b> tags', followups: [] })
  expect(replyText(answer([{ kind: 'text', text: 'Hi\n<followups>A b</followups>' }]))).toBe('Hi')
})

test('an answer points at the conversations it links to, each once', () => {
  const text = 'See [Budget](jefi://thread/work%3Abudget) and [Budget again](jefi://thread/work%3Abudget), then <jefi://thread/x1>. [Web](https://example.com)'
  expect(linkedThreads(text)).toEqual(['work:budget', 'x1'])
})

test('only a turn that changed nothing in the mailbox can be asked again', () => {
  const tool = (name: string) => ({ kind: 'tool' as const, id: name, name, label: name, state: 'ok' as const })
  expect(canRerun(answer([tool('search_mail'), tool('read_thread'), { kind: 'draft', id: 'd', draft: { to: [], cc: [], subject: '', body: 'x' } }, { kind: 'text', text: 'ok' }]))).toBe(true)
  expect(canRerun(answer([tool('update_threads')]))).toBe(false)
  expect(canRerun(answer([{ kind: 'confirm', id: 1, question: 'Trash?', state: 'no' }]))).toBe(false)
})

test('a saved chat has no functions, no open question and nothing left running', () => {
  const entries: Entry[] = [
    { role: 'user', text: 'Archive the newsletters', handoffs: [{ title: 'News', text: 'Email thread_id: n', threadId: 'n' }] },
    answer(
      [
        { kind: 'tool', id: 't', name: 'update_threads', label: 'Archive: 2 conversations', state: 'running', undo: () => {} },
        { kind: 'confirm', id: 2, question: 'Archive 5?', state: 'asking' },
        { kind: 'draft', id: 'd', draft: { to: ['a@x'], cc: [], subject: 'Hi', body: 'Hello' }, rewriting: true },
      ],
      { done: false },
    ),
  ]
  const [, reply] = settled(entries) as [Entry, AssistantEntry]
  expect(reply.done).toBe(true)
  expect(reply.error).toBe('Stopped')
  expect(reply.parts).toEqual([
    { kind: 'tool', id: 't', name: 'update_threads', label: 'Archive: 2 conversations', state: 'error' },
    { kind: 'confirm', id: 2, question: 'Archive 5?', state: 'no' },
    { kind: 'draft', id: 'd', draft: { to: ['a@x'], cc: [], subject: 'Hi', body: 'Hello' } },
  ])
  expect(transcript(entries)).toContain('Attached: News')
  expect(transcript(entries)).toContain('[Draft] To: a@x\nSubject: Hi\n\nHello')
  expect(chatTitle(entries)).toBe('Archive the newsletters')
  expect(chatTitle([{ role: 'user', text: 'x'.repeat(80) }])).toHaveLength(60)
})

test('chats are kept on this Mac for the owner only, newest first, the oldest dropped past the limit', () => {
  const chat = (n: number) => ({ id: `c${n}`, title: `Chat ${n}`, updatedAt: n, provider: 'anthropic' as const, entries: [{ role: 'user' as const, text: `q${n}` }], history: [{ role: 'user', content: `q${n}` }] })
  for (let n = 1; n <= MAX_CHATS + 2; n++) saveChat(chat(n))
  const chats = loadChats()
  expect(chats).toHaveLength(MAX_CHATS)
  expect(chats[0]?.id).toBe(`c${MAX_CHATS + 2}`)
  expect(chats.some((c) => c.id === 'c1')).toBe(false)
  expect(statSync(`${dir}/assistant-chats.json`).mode & 0o777).toBe(0o600)
  saveChat({ ...chat(5), updatedAt: 10_000, title: 'Renamed' })
  expect(loadChats()[0]).toMatchObject({ id: 'c5', title: 'Renamed' })
  deleteChat('c5')
  expect(loadChats().some((c) => c.id === 'c5')).toBe(false)
  clearChats()
  expect(loadChats()).toEqual([])
})
