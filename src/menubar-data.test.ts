import { expect, test } from 'bun:test'
import type { InviteSummary } from './engine'
import { RECENT_CAP, addRecent, arrivedInvites, createRecentBuffer, type RecentItem } from './menubar-data'

const mail = (n: number, at = n): RecentItem => ({ id: `mail:t${n}`, kind: 'mail', title: `Sender ${n}`, subtitle: `Subject ${n}`, at, route: { accountId: 'a', threadId: `t${n}` } })

test('recent: newest first, a repeat moves to the front instead of doubling, capped', () => {
  let items: RecentItem[] = []
  for (let n = 1; n <= 12; n++) items = addRecent(items, mail(n))
  expect(items.map((i) => i.id)).toEqual(Array.from({ length: RECENT_CAP }, (_, i) => `mail:t${12 - i}`))
  items = addRecent(items, { ...mail(5, 20), subtitle: 'Re: Subject 5' })
  expect(items.length).toBe(RECENT_CAP)
  expect(items[0]).toMatchObject({ id: 'mail:t5', subtitle: 'Re: Subject 5', at: 20 })
  expect(items.filter((i) => i.id === 'mail:t5').length).toBe(1)
  expect(addRecent([], mail(1), 0)).toEqual([])
})

test('recent buffer: unseen counts what came after markSeen; clear empties it; listeners hear changes', () => {
  const buffer = createRecentBuffer(3)
  let heard = 0
  const stop = buffer.subscribe(() => heard++)
  buffer.push(mail(1, 100))
  buffer.push({ id: 'reminder:e1@200', kind: 'reminder', title: 'Standup', subtitle: 'In 10 minutes', at: 110, route: { eventId: 'e1', occurrenceStart: 0 } })
  expect(buffer.get()).toMatchObject({ unseen: 2 })
  const before = buffer.get()
  buffer.markSeen(120)
  expect(buffer.get()).toMatchObject({ unseen: 0, seenAt: 120 })
  expect(buffer.get().items).toBe(before.items)
  // Nothing new: no change, no notification.
  buffer.markSeen(120)
  buffer.push(mail(2, 130))
  expect(buffer.get().unseen).toBe(1)
  expect(buffer.get().items.map((i) => i.kind)).toEqual(['mail', 'reminder', 'mail'])
  buffer.clear()
  expect(buffer.get()).toMatchObject({ items: [], unseen: 0 })
  buffer.clear()
  stop()
  buffer.push(mail(3))
  expect(heard).toBe(5)
})

const summary = (eventId: string) => ({ eventId }) as InviteSummary

test('arrived invites: none on the first load, then only the ones not pending before', () => {
  expect(arrivedInvites(null, [summary('a')])).toEqual([])
  expect(arrivedInvites([summary('a')], [summary('a'), summary('b')]).map((i) => i.eventId)).toEqual(['b'])
  expect(arrivedInvites([summary('a'), summary('b')], [summary('a')])).toEqual([])
})

test('recent: an invitation and its own new-mail entry are listed once, as the invitation', () => {
  const invite: RecentItem = { id: 'invite:e1', kind: 'invite', title: 'Offsite dinner', subtitle: 'Invitation from Mira', at: 100_000, route: { accountId: 'a', threadId: 't9' } }
  const itsMail: RecentItem = { id: 'mail:t9', kind: 'mail', title: 'Mira Cole', subtitle: 'Invitation: Offsite dinner', at: 99_000, route: { accountId: 'a', threadId: 't9' } }
  expect(addRecent(addRecent([mail(1)], itsMail), invite).map((i) => i.id)).toEqual(['invite:e1', 'mail:t1'])
  expect(addRecent(addRecent([mail(1)], invite), { ...itsMail, at: 101_000 }).map((i) => i.id)).toEqual(['invite:e1', 'mail:t1'])
  // A reply on that conversation much later is news of its own.
  expect(addRecent([invite], { ...itsMail, at: 100_000 + 3_600_000 }).map((i) => i.id)).toEqual(['mail:t9', 'invite:e1'])
})
