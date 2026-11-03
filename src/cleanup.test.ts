import { expect, test } from 'bun:test'
import { messageCount, purgeCopy } from './cleanup'

test('counts say message or messages', () => {
  expect(messageCount(1)).toBe('1 message')
  expect(messageCount(0)).toBe('0 messages')
  expect(messageCount(1200)).toBe(`${(1200).toLocaleString()} messages`)
})

test('Delete forever says what it will erase', () => {
  const sender = { label: 'Northwind Deals', messages: 1, bytes: 2048, selector: { sender: 'news@deals.example' } }
  expect(purgeCopy(sender, 0).title).toBe('Delete 1 message for good?')
  expect(purgeCopy(sender, 0).body).toStartWith('Everything from Northwind Deals is erased on the server')
  // Keep newest: the group's totals overstate what goes, so it says so.
  const kept = purgeCopy({ ...sender, messages: 30 }, 5)
  expect(kept.title).toBe('Delete all but the newest 5 for good?')
  expect(kept.body).toStartWith('Everything from Northwind Deals except its newest 5 conversations is erased')
  expect(kept.body).toContain('frees up to 2 KB')
  // Age and size groups aren't someone mail is "from", and don't keep any.
  const old = purgeCopy({ label: 'Older than 1 year', messages: 40, bytes: 0, selector: { olderThanDays: 365 } }, 5)
  expect(old.title).toBe('Delete 40 messages for good?')
  expect(old.body).toStartWith('Every message older than 1 year is erased')
})
