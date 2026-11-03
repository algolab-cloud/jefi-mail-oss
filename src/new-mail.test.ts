import { describe, expect, test } from 'bun:test'
import { addToBurst, incomingThread, newMailCopy, senderSummary } from './new-mail'

const t = (id: string, sender = id, extra: { screened?: boolean } = {}) => ({ id, sender, subject: `About ${id}`, ...extra })

describe('new mail grouping', () => {
  test('a single conversation keeps the per-message copy', () => {
    const burst = addToBurst(undefined, [t('a', 'Ada')], 0)!
    expect(newMailCopy(burst)).toEqual({ title: 'New message from Ada', description: 'About a', threadId: 'a' })
  })

  test('several become a count with a sender summary, routed to the newest', () => {
    const burst = addToBurst(undefined, [t('a', 'Ada'), t('b', 'Bob'), t('c', 'Cy')], 0)!
    expect(newMailCopy(burst)).toEqual({ title: '3 new messages', description: 'Ada, Bob and 1 other', threadId: 'c' })
  })

  test('screened mail is ignored', () => {
    expect(addToBurst(undefined, [t('a', 'Ada', { screened: true })], 0)).toBeNull()
    const burst = addToBurst(undefined, [t('a', 'Ada', { screened: true }), t('b', 'Bob')], 0)!
    expect(newMailCopy(burst).title).toBe('New message from Bob')
  })

  test('arrivals inside the window merge; later ones start a new burst', () => {
    const first = addToBurst(undefined, [t('a', 'Ada')], 0)!
    const merged = addToBurst(first, [t('b', 'Bob')], 3000)!
    expect(newMailCopy(merged).title).toBe('2 new messages')
    expect(newMailCopy(merged).description).toBe('Ada and Bob')
    const fresh = addToBurst(merged, [t('c', 'Cy')], 3000 + 5000)!
    expect(newMailCopy(fresh).title).toBe('New message from Cy')
  })

  test('the same thread is not counted twice', () => {
    const first = addToBurst(undefined, [t('a'), t('a')], 0)!
    expect(first.threads).toHaveLength(1)
    expect(addToBurst(first, [t('a')], 1000)).toBeNull()
  })

  test('sender summary dedupes names', () => {
    expect(senderSummary(['Ada', 'Ada', 'Bob'])).toBe('Ada and Bob')
    expect(senderSummary(['Ada', 'Bob', 'Cy', 'Di'])).toBe('Ada, Bob and 2 others')
  })
})

describe('who an arrival is from', () => {
  test('a reply in a conversation is announced from its sender, not the whole conversation', () => {
    const thread = { id: 'a:t1', sender: 'Nora Hale, Kenji Ito (3)', subject: 'Customer feedback', messages: [{ from: 'Nora Hale' }, { from: 'Nora Hale' }, { from: 'Kenji Ito' }] }
    const burst = addToBurst(undefined, [incomingThread(thread)], 1000)!
    expect(newMailCopy(burst)).toEqual({ title: 'New message from Kenji Ito', description: 'Customer feedback', threadId: 'a:t1' })
  })
  test('without messages the list sender loses its count', () => {
    expect(incomingThread({ id: 'x', sender: 'Nora Hale (2)', subject: 's' }).sender).toBe('Nora Hale')
    expect(incomingThread({ id: 'x', sender: 'Zoë Ølstad 🎉', subject: 's', screened: true })).toEqual({ id: 'x', sender: 'Zoë Ølstad 🎉', subject: 's', screened: true })
  })
})
