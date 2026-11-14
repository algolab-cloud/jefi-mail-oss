import { expect, test } from 'bun:test'
import { openDatabase } from './db'
import { pendingCount, queueMove, queueMoves } from './pending-ops'
import { seedMailbox } from './testing/seed'

// A mass clean-up queues thousands of moves at once. Each used to look for an earlier move of its
// message by reading and parsing every move already queued, so the cost grew with the queue: 3,000
// took ~3.6s (quadratic), all on the engine's thread. Bounds here are loose on purpose (slow CI);
// what they catch is the quadratic growth coming back.

const seeded = () => {
  const db = openDatabase(':memory:')
  const ids = seedMailbox(db, 'acct', 'me@example.com', { path: 'INBOX', specialUse: '\\Inbox' }, { count: 3000, subject: 'Sale' })
  seedMailbox(db, 'acct', 'me@example.com', { path: 'Archive', specialUse: '\\Archive' }, { count: 1, subject: 'Old' })
  return { db, threads: ids.map((id) => `acct:m${id}`) }
}

test('a clean-up queues 3,000 moves in well under the old ~3.6s', () => {
  const { db, threads } = seeded()
  const started = performance.now()
  expect(queueMoves(db, 'acct', threads, 'archive')).toHaveLength(3000)
  expect(performance.now() - started).toBeLessThan(2000)
  expect(pendingCount(db, 'acct')).toBe(3000)

  // Undo supersedes each queued move rather than piling up a second one, just as fast.
  const again = performance.now()
  expect(queueMoves(db, 'acct', threads, 'inbox')).toHaveLength(3000)
  expect(performance.now() - again).toBeLessThan(2000)
  expect(pendingCount(db, 'acct')).toBe(3000)
  db.close()
})

test('queueing one move costs the same with 3,000 already queued as with none', () => {
  const { db, threads } = seeded()
  const time = (slice: string[]) => {
    const started = performance.now()
    for (const threadId of slice) queueMove(db, 'acct', threadId, 'archive')
    return performance.now() - started
  }
  time(threads.slice(0, 100)) // warm up the statement cache
  const first = time(threads.slice(100, 600))
  time(threads.slice(600, 2500))
  const last = time(threads.slice(2500))
  expect(pendingCount(db, 'acct')).toBe(3000)
  // Quadratic, the last 500 took about ten times the first 500.
  expect(last).toBeLessThan(first * 3)
  db.close()
})
