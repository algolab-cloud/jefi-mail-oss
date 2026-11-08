import { expect, test } from 'bun:test'
import { CLEANUP_EVERY, cleanupDue, cleanupSummary, nextCleanupAt } from './cleanup-schedule'
import { cleanupConnection } from './ai'

const DAY = 86_400_000

test('a run is due once its interval has passed, never when off', () => {
  const now = 100 * DAY
  expect(cleanupDue('off', 0, now)).toBe(false)
  expect(cleanupDue('daily', 0, now)).toBe(true)
  expect(cleanupDue('daily', now - DAY + 1, now)).toBe(false)
  expect(cleanupDue('daily', now - DAY, now)).toBe(true)
  expect(cleanupDue('weekly', now - 3 * DAY, now)).toBe(false)
  expect(cleanupDue('weekly', now - CLEANUP_EVERY.weekly, now)).toBe(true)
})

test('the next run is the interval after the last, or now when overdue', () => {
  const now = 100 * DAY
  expect(nextCleanupAt('off', now, now)).toBeNull()
  expect(nextCleanupAt('daily', now - DAY / 2, now)).toBe(now + DAY / 2)
  expect(nextCleanupAt('weekly', 0, now)).toBe(now)
})

test('a run is summed up in words', () => {
  const base = { senders: 40, junk: 0, moved: 0, kept: 0, spam: 0, errors: [] as string[] }
  expect(cleanupSummary({ ...base, action: 'archive' })).toBe('No junk among 40 senders')
  expect(cleanupSummary({ ...base, action: 'review', junk: 1 })).toBe('Found 1 junk sender to review')
  expect(cleanupSummary({ ...base, action: 'archive', junk: 3, moved: 21 })).toBe('Archived 21 conversations from 3 junk senders')
  expect(cleanupSummary({ ...base, action: 'trash', junk: 2, moved: 1, errors: ['x'] })).toBe('Moved 1 conversation to Trash from 2 junk senders · 1 account failed')
  expect(cleanupSummary({ ...base, senders: 0, action: 'review', errors: ['Not signed in to ChatGPT.'] })).toBe("Couldn't run: Not signed in to ChatGPT.")
  expect(cleanupSummary({ ...base, action: 'archive', junk: 2, moved: 9, kept: 1, spam: 3 })).toBe('Archived 9 conversations from 2 junk senders · kept 1 conversation that looks important · 3 messages in Spam may be real')
})

test('clean-up uses its own model when one is chosen, else the main one', () => {
  const models = { anthropic: 'claude-haiku-5-5', openai: '', codex: '' }
  expect(cleanupConnection({ provider: 'anthropic', key: 'k', model: 'claude-sonnet-5-5' }, models)).toEqual({ provider: 'anthropic', key: 'k', model: 'claude-haiku-5-5' })
  expect(cleanupConnection({ provider: 'openai', key: 'k', model: 'gpt-x' }, models)).toEqual({ provider: 'openai', key: 'k', model: 'gpt-x' })
  expect(cleanupConnection({ provider: 'codex' }, { ...models, codex: ' gpt-mini ' })).toEqual({ provider: 'codex', model: 'gpt-mini' })
})
