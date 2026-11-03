import { expect, test } from 'bun:test'
import { parseDue, parseTaskSuggestions, todayForPrompt } from './suggest'

test('suggestions: a JSON array, even inside a code fence or a sentence', () => {
  const answer = 'Here you go:\n```json\n[{"title":"Send Lea the pricing numbers","due":"2026-09-28","quote":"still needs your numbers"},{"title":"Review the deck","due":null,"quote":""}]\n```'
  expect(parseTaskSuggestions(answer, 'Europe/Berlin')).toEqual([
    { title: 'Send Lea the pricing numbers', quote: 'still needs your numbers', dueAt: Date.UTC(2026, 8, 28), dueAllDay: true },
    { title: 'Review the deck', quote: '', dueAt: null, dueAllDay: false },
  ])
})

test('suggestions: anything malformed is dropped, not guessed', () => {
  expect(parseTaskSuggestions('No action items here.', 'UTC')).toEqual([])
  expect(parseTaskSuggestions('[{"title": "Unclosed"', 'UTC')).toEqual([])
  expect(parseTaskSuggestions('{"title":"Not an array"}', 'UTC')).toEqual([])
  const messy = JSON.stringify([null, 3, 'text', { title: '' }, { title: '  Call   Kenji ' }, { title: 'call kenji' }, { title: 42 }, { title: 'x'.repeat(300) }])
  const parsed = parseTaskSuggestions(messy, 'UTC')
  expect(parsed.map((s) => s.title.length)).toEqual([10, 120])
  expect(parsed[0]!.title).toBe('Call Kenji')
})

test('suggestions: at most five', () => {
  const many = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ title: `Task ${i}` })))
  expect(parseTaskSuggestions(many, 'UTC')).toHaveLength(5)
})

test('due: ISO dates are date-only, date-times are in the person’s zone, anything else is no due', () => {
  expect(parseDue('2026-10-02', 'Europe/Berlin')).toEqual({ dueAt: Date.UTC(2026, 9, 2), dueAllDay: true })
  expect(parseDue('2026-10-02T15:00', 'Europe/Berlin')).toEqual({ dueAt: Date.UTC(2026, 9, 2, 13), dueAllDay: false })
  expect(parseDue('2026-10-02T15:00:00', 'Europe/Berlin')).toEqual({ dueAt: Date.UTC(2026, 9, 2, 13), dueAllDay: false })
  expect(parseDue('2026-10-02 15:00:00.000', 'Europe/Berlin')).toEqual({ dueAt: Date.UTC(2026, 9, 2, 13), dueAllDay: false })
  for (const bad of ['2026-02-30', '2026-10-02T25:00', '2026-10-02T15:00Z', 'Friday', '', null, 12]) expect(parseDue(bad, 'UTC')).toEqual({ dueAt: null, dueAllDay: false })
})

test('the prompt states today in the person’s zone', () => {
  // 23:30 UTC on the 26th is already the 27th in Tokyo.
  expect(todayForPrompt(Date.UTC(2026, 8, 26, 23, 30), 'Asia/Tokyo')).toBe('Sunday, 2026-09-27')
  expect(todayForPrompt(Date.UTC(2026, 8, 26, 23, 30), 'America/New_York')).toBe('Saturday, 2026-09-26')
})
