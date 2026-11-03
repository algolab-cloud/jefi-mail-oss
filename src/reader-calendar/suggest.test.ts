import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { DateSuggestion } from '../detect/dates'
import type { Message } from '../data'
import { dismiss, dismissalKey, isDismissed, resetDismissals } from './dismissals'
import { appendToBody, detectForMessage, draftFromSuggestion, eventFromDraft, formatWhen, newNoteFromMessage, pickSuggestions, utcDays } from './suggest'

const DAY = 86_400_000
const ZONE = 'Europe/Berlin'
// Mon 22 Sep 2026, 09:00 in Berlin.
const SENT = Date.UTC(2026, 8, 22, 7)
const link = { kind: 'message' as const, accountId: 'a', messageId: 'a:t1-1' }

const msg = (text: string, extra: Partial<Message> = {}): Message => ({
  id: `a:t1-${Math.floor(Math.random() * 1e9)}`,
  from: 'Lea Ortiz',
  email: 'lea@atlas.dev',
  to: 'me',
  face: { letter: 'L' } as Message['face'],
  time: '09:00',
  timestamp: SENT,
  paragraphs: text.split('\n\n'),
  ...extra,
})

const suggestion = (over: Partial<DateSuggestion> = {}): DateSuggestion => ({
  start: SENT + 3 * DAY,
  end: SENT + 3 * DAY + 3_600_000,
  allDay: false,
  sourceText: 'Thursday at 9',
  index: 0,
  length: 13,
  confidence: 'high',
  ...over,
})

test('detects the meeting in a message and memoizes it', () => {
  const m = msg('Design review on Thursday at 3pm, in the big room.')
  const found = detectForMessage(m, 'Design review', ZONE)
  expect(found.length).toBe(1)
  expect(found[0]).toMatchObject({ allDay: false, start: Date.UTC(2026, 8, 24, 13), end: Date.UTC(2026, 8, 24, 14), title: 'Design review' })
  expect(detectForMessage(m, 'Design review', ZONE)).toBe(found)
  // No body yet, no sent date: nothing to read.
  expect(detectForMessage(msg('Thursday at 3pm', { bodyMissing: true }), 'x', ZONE)).toEqual([])
  expect(detectForMessage(msg('Thursday at 3pm', { timestamp: undefined }), 'x', ZONE)).toEqual([])
})

test('suggestion filters: old mail, bulk mail, invites, dismissed, past, at most three', () => {
  const now = SENT + DAY
  const base = { message: msg(''), now, hasInvite: false, dismissed: false }
  const one = [suggestion()]
  expect(pickSuggestions({ ...base, detected: one })).toEqual(one)
  expect(pickSuggestions({ ...base, detected: one, hasInvite: true })).toEqual([])
  expect(pickSuggestions({ ...base, detected: one, dismissed: true })).toEqual([])
  // Older than 60 days.
  expect(pickSuggestions({ ...base, detected: one, message: msg('', { timestamp: now - 61 * DAY }) })).toEqual([])
  expect(pickSuggestions({ ...base, detected: one, message: msg('', { timestamp: now - 59 * DAY }) })).toEqual(one)
  // Mail still sending has no place for it yet.
  expect(pickSuggestions({ ...base, detected: one, message: msg('', { status: 'sending' }) })).toEqual([])
  // Bulk mail: only high-confidence timed dates.
  const bulk = msg('', { unsubscribe: { link: 'https://x.example/u' } as Message['unsubscribe'] })
  const medium = suggestion({ confidence: 'medium', start: SENT + 4 * DAY })
  const allDay = suggestion({ allDay: true, start: SENT + 5 * DAY, end: SENT + 6 * DAY })
  expect(pickSuggestions({ ...base, message: bulk, detected: [one[0]!, medium, allDay] })).toEqual(one)
  expect(pickSuggestions({ ...base, detected: [one[0]!, medium, allDay] }).length).toBe(3)
  // Already over.
  expect(pickSuggestions({ ...base, detected: [suggestion({ start: now - 7_200_000, end: now - 3_600_000 })] })).toEqual([])
  // At most three.
  const many = [1, 2, 3, 4, 5].map((d) => suggestion({ start: SENT + d * DAY, end: SENT + d * DAY + 1 }))
  expect(pickSuggestions({ ...base, detected: many }).length).toBe(3)
})

test('dismissals persist per message', () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-dismiss-`)
  const before = process.env.JEFI_CONFIG_DIR
  process.env.JEFI_CONFIG_DIR = dir
  try {
    resetDismissals()
    const key = dismissalKey({ id: 'a:t1-1', messageId: '<abc@x>' })
    expect(key).toBe('<abc@x>')
    expect(isDismissed(key)).toBe(false)
    dismiss(key)
    resetDismissals()
    expect(isDismissed(key)).toBe(true)
    expect(isDismissed(dismissalKey({ id: 'a:t1-2' }))).toBe(false)
  } finally {
    process.env.JEFI_CONFIG_DIR = before
    resetDismissals()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('formats times and ranges', () => {
  expect(formatWhen({ start: Date.UTC(2026, 9, 2, 13), end: Date.UTC(2026, 9, 2, 14), allDay: false }, ZONE, 'en-GB')).toBe('Fri 2 Oct, 15:00–16:00')
  // All-day ranges end exclusive, at the zone's midnight.
  const start = Date.UTC(2026, 9, 11, 22)
  expect(formatWhen({ start, end: start + 3 * DAY, allDay: true }, ZONE, 'en-GB')).toBe('Mon 12 Oct – Wed 14 Oct')
  expect(formatWhen({ start, end: start + DAY, allDay: true }, ZONE, 'en-GB')).toBe('Mon 12 Oct')
  expect(utcDays(start, start + 3 * DAY, ZONE)).toEqual({ startAt: Date.UTC(2026, 9, 12), endAt: Date.UTC(2026, 9, 15) })
})

test('quick add: a timed draft becomes an event in the zone, linked to the message', () => {
  const draft = draftFromSuggestion(suggestion({ start: Date.UTC(2026, 9, 2, 13), end: Date.UTC(2026, 9, 2, 14), title: 'Design review' }), 'Subject', ZONE)
  expect(draft).toMatchObject({ title: 'Design review', date: '2026-10-02', startTime: '15:00', endTime: '16:00', allDay: false })
  expect(eventFromDraft(draft, link, ZONE)).toEqual({
    ok: true,
    input: { title: 'Design review', calendarId: undefined, links: [link], startAt: Date.UTC(2026, 9, 2, 13), endAt: Date.UTC(2026, 9, 2, 14), allDay: false, timeZone: ZONE },
  })
  // Past midnight, and 12-hour input.
  const late = eventFromDraft({ ...draft, startTime: '11pm', endTime: '1:00' }, link, ZONE)
  expect(late.ok && late.input.endAt - late.input.startAt).toBe(2 * 3_600_000)
  expect(eventFromDraft({ ...draft, title: ' ' }, link, ZONE)).toEqual({ ok: false, error: 'Give the event a title' })
  expect(eventFromDraft({ ...draft, date: '2026-02-30' }, link, ZONE).ok).toBe(false)
  expect(eventFromDraft({ ...draft, startTime: '25:00' }, link, ZONE).ok).toBe(false)
})

test('quick add: an all-day range is stored as whole UTC days', () => {
  const start = Date.UTC(2026, 9, 11, 22)
  const draft = draftFromSuggestion(suggestion({ allDay: true, start, end: start + 3 * DAY, title: undefined }), 'Re: Offsite', ZONE)
  expect(draft).toMatchObject({ title: 'Re: Offsite', date: '2026-10-12', endDate: '2026-10-14', allDay: true })
  const result = eventFromDraft({ ...draft, calendarId: 'cal-1' }, link, ZONE)
  expect(result).toEqual({ ok: true, input: { title: 'Re: Offsite', calendarId: 'cal-1', links: [link], startAt: Date.UTC(2026, 9, 12), endAt: Date.UTC(2026, 9, 15), allDay: true } })
  expect(eventFromDraft({ ...draft, endDate: '2026-10-01' }, link, ZONE).ok).toBe(false)
})

test('notes: a new note from the subject with a quoted excerpt, and appending', () => {
  // The note header shows the sent day in the reader's own zone, so pin the
  // message to local noon on 22 Sep: the same day whatever TZ the tests run in.
  const m = msg('Can we move the review to Thursday?\n\nThanks,\nLea\n\n> On Monday you wrote:\n> old text', { timestamp: new Date(2026, 8, 22, 12).getTime() })
  const note = newNoteFromMessage({ subject: 'Re: Fwd: Q3 review' }, m, 'en-US')
  expect(note.title).toBe('Q3 review')
  expect(note.body).toBe('**Lea Ortiz** · Sep 22, 2026 · _Q3 review_\n\n> Can we move the review to Thursday?\n>\n> Thanks,\n> Lea')
  expect(appendToBody('My notes\n', { subject: 'Q3 review' }, m, 'en-US')).toBe(`My notes\n\n---\n\n${note.body}`)
  expect(appendToBody('', { subject: 'Q3 review' }, m, 'en-US')).toBe(note.body)
})

afterAll(() => resetDismissals())
