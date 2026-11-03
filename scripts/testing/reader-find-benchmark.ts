/**
 * Per-keystroke cost of find-in-conversation on a synthetic 24-message / ~2.9 MiB conversation
 * (the lume-c0k audit size).
 *   bun scripts/testing/reader-find-benchmark.ts [--messages N] [--kib N]
 * "before" rebuilds the reader pieces and search rows on every keystroke, as the reader did when
 * its items depended on the query text; "after" builds them once per find session and only scans.
 */
import type { Message } from '../../src/data'
import { findReaderMatches } from '../../src/reader-tools'
import { messageParts, readerSearchRows } from '../../src/reading'

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : Number(process.argv[index + 1])
}
const count = arg('--messages', 24)
const kib = arg('--kib', 124)

const paragraph = (i: number) =>
  `Paragraph ${i}: the **quarterly** numbers for [the report](https://example.com/r/${i}) are in, and _everyone_ should read section ${i % 7} before Friday's review.\n\n`
const body = (seed: number) => {
  let text = `# Update ${seed}\n\n`
  for (let i = 0; text.length < kib * 1024; i++) text += paragraph(seed * 1000 + i)
  return `${text}\nOn Monday someone wrote:\n> earlier message ${seed}\n> with quoted lines\n`
}
const messages: Message[] = Array.from({ length: count }, (_, i) => ({
  id: `m${i}`,
  from: 'Sender',
  email: 'sender@example.com',
  to: 'me@example.com',
  face: { initials: 'S', color: '#888' } as Message['face'],
  time: '9:00',
  paragraphs: [],
  markdown: body(i),
}))
const bytes = messages.reduce((sum, message) => sum + (message.markdown?.length ?? 0), 0)

const buildItems = (findActive: boolean) =>
  messages.flatMap((message) =>
    messageParts(message, findActive ? 'text' : 'html', findActive).map((part, i) => ({ kind: 'part', key: `${message.id}:${i}`, part })),
  )

const keystrokes = ['q', 'qu', 'qua', 'quar', 'quart', 'quarte', 'quarter', 'quarterl', 'quarterly', 'section 3', 'review', 'friday']
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
  return `median ${at(0.5).toFixed(2)} ms, p95 ${at(0.95).toFixed(2)} ms`
}
const rounds = 10

const before: number[] = []
const beforeSearch: number[] = []
for (let r = 0; r < rounds; r++) {
  for (const query of keystrokes) {
    const start = performance.now()
    const rows = readerSearchRows(buildItems(true)).map(({ key, text }) => ({ key, text }))
    const built = performance.now()
    findReaderMatches(rows, query)
    const end = performance.now()
    before.push(end - start)
    beforeSearch.push(end - built)
  }
}

const after: number[] = []
let open = 0
for (let r = 0; r < rounds; r++) {
  const start = performance.now()
  const rows = readerSearchRows(buildItems(true))
  open += performance.now() - start
  for (const query of keystrokes) {
    const t = performance.now()
    findReaderMatches(rows, query)
    after.push(performance.now() - t)
  }
}

console.log(`${count} messages, ${(bytes / 1024 / 1024).toFixed(2)} MiB markdown, ${keystrokes.length * rounds} keystrokes`)
console.log(`before per keystroke (rebuild + search): ${stats(before)} (search alone ${stats(beforeSearch)})`)
console.log(`after per keystroke (search only):        ${stats(after)}`)
console.log(`after, once per find session (build rows): ${(open / rounds).toFixed(2)} ms`)
