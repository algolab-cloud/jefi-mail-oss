import { describe, expect, test } from 'bun:test'
import { SETTINGS_SECTIONS, deferJefiRoute, dispatchJefiUrl, eventPrefill, isoDay, localDay, parseJefiUrl, recipients, routeJefiLink, settingsSectionWindow, subscribeJefiLinks, type JefiRoute, type LinkTargets } from './deeplink'

describe('parseJefiUrl', () => {
  test('mail routes', () => {
    expect(parseJefiUrl('jefi://')).toEqual({ kind: 'inbox' })
    expect(parseJefiUrl('jefi://inbox')).toEqual({ kind: 'inbox' })
    expect(parseJefiUrl('jefi://inbox/acc-1')).toEqual({ kind: 'inbox', accountId: 'acc-1' })
    expect(parseJefiUrl('jefi://thread/acc-1:t%2042')).toEqual({ kind: 'thread', threadId: 'acc-1:t 42' })
    expect(parseJefiUrl('JEFI://Thread/abc')).toEqual({ kind: 'thread', threadId: 'abc' })
    expect(parseJefiUrl('jefi://search?q=invoice%20march')).toEqual({ kind: 'search', query: 'invoice march' })
  })

  test('compose prefills and never carries more than addresses and text', () => {
    expect(parseJefiUrl('jefi://compose?to=a@b.c,Nora%20%3Cnora@x.io%3E,junk&cc=c@d.e&subject=Hi%0Athere&body=Line%201%0ALine%202&account=me@x.io')).toEqual({
      kind: 'compose',
      prefill: { to: ['a@b.c', 'nora@x.io'], cc: ['c@d.e'], bcc: [], subject: 'Hi there', body: 'Line 1\nLine 2', account: 'me@x.io' },
    })
    expect(parseJefiUrl('jefi://compose')).toEqual({ kind: 'compose', prefill: { to: [], cc: [], bcc: [], subject: '', body: '' } })
  })

  test('calendar and events', () => {
    expect(parseJefiUrl('jefi://calendar')).toEqual({ kind: 'calendar' })
    expect(parseJefiUrl('jefi://calendar?date=2026-10-02&view=week')).toEqual({ kind: 'calendar', date: '2026-10-02', view: 'week' })
    // Impossible days and unknown views are dropped, not guessed at.
    expect(parseJefiUrl('jefi://calendar?date=2026-02-30&view=year')).toEqual({ kind: 'calendar' })
    expect(parseJefiUrl('jefi://event/ev1')).toEqual({ kind: 'event', eventId: 'ev1' })
    expect(parseJefiUrl('jefi://event/ev1?start=1790000000000')).toEqual({ kind: 'event', eventId: 'ev1', start: 1790000000000 })
    expect(parseJefiUrl('jefi://event/ev1?start=-5')).toEqual({ kind: 'event', eventId: 'ev1' })
    expect(parseJefiUrl('jefi://new-event?title=Standup&start=2026-10-02T09:30&end=2026-10-02T10:00%2B02:00&location=Room%201&notes=Agenda')).toEqual({
      kind: 'new-event',
      prefill: { title: 'Standup', start: '2026-10-02T09:30', end: '2026-10-02T10:00+02:00', location: 'Room 1', notes: 'Agenda' },
    })
    expect(parseJefiUrl('jefi://new-event?start=tomorrow&allDay=1')).toEqual({ kind: 'new-event', prefill: { allDay: true } })
    expect(parseJefiUrl('jefi://quick-add?text=Lunch%20with%20Nora%20Friday%201pm')).toEqual({ kind: 'quick-add', text: 'Lunch with Nora Friday 1pm' })
  })

  test('notes and settings', () => {
    expect(parseJefiUrl('jefi://notes')).toEqual({ kind: 'notes' })
    expect(parseJefiUrl('jefi://note/n1')).toEqual({ kind: 'notes', noteId: 'n1' })
    expect(parseJefiUrl('jefi://new-note?title=Idea&body=a%0Ab')).toEqual({ kind: 'new-note', title: 'Idea', body: 'a\nb' })
    expect(parseJefiUrl('jefi://settings')).toEqual({ kind: 'settings' })
    expect(parseJefiUrl('jefi://settings/Accounts')).toEqual({ kind: 'settings', section: 'accounts' })
    expect(parseJefiUrl('jefi://settings/nope')).toEqual({ kind: 'settings' })
  })

  test('unknown routes and missing ids just open Jefi', () => {
    expect(parseJefiUrl('jefi://send?to=a@b.c')).toEqual({ kind: 'open' })
    expect(parseJefiUrl('jefi://thread')).toEqual({ kind: 'open' })
    expect(parseJefiUrl('jefi://event/')).toEqual({ kind: 'open' })
  })

  test('rejects other schemes, junk and oversized input', () => {
    expect(parseJefiUrl('mailto:a@b.c')).toBeNull()
    expect(parseJefiUrl('https://jefi.app')).toBeNull()
    expect(parseJefiUrl('jefi://thread/%E0%A4%A')).toEqual({ kind: 'open' })
    expect(parseJefiUrl(`jefi://search?q=${'a'.repeat(9000)}`)).toBeNull()
    expect(parseJefiUrl(`jefi://thread/${'x'.repeat(600)}`)).toEqual({ kind: 'open' })
    expect(parseJefiUrl(`jefi://search?q=${'a'.repeat(2000)}`)).toEqual({ kind: 'search', query: 'a'.repeat(500) })
    expect(parseJefiUrl('jefi://thread/a%00b')).toEqual({ kind: 'open' })
  })
})

test('recipients keep valid, distinct addresses only', () => {
  expect(recipients('a@b.c; a@b.c, <x@y.z>, not an address, @b.c')).toEqual(['a@b.c', 'x@y.z'])
  expect(recipients(Array.from({ length: 150 }, (_, i) => `u${i}@x.io`).join(','))).toHaveLength(100)
})

test('isoDay checks the day exists', () => {
  expect(isoDay('2028-02-29')).toBe('2028-02-29')
  expect(isoDay('2026-02-29')).toBeUndefined()
  expect(isoDay('2026-1-2')).toBeUndefined()
})

test('eventPrefill turns ISO values into the editor prefill', () => {
  expect(eventPrefill({ title: 'A', start: '2026-10-02T09:30', end: '2026-10-02T10:00', location: 'L', notes: 'N' })).toEqual({
    title: 'A',
    start: new Date(2026, 9, 2, 9, 30).getTime(),
    end: new Date(2026, 9, 2, 10).getTime(),
    location: 'L',
    description: 'N',
  })
  // An all-day end names the last day; the editor wants the midnight after it.
  expect(eventPrefill({ start: '2026-10-02', end: '2026-10-03', allDay: true })).toEqual({ start: new Date(2026, 9, 2).getTime(), end: new Date(2026, 9, 4).getTime(), allDay: true })
  // An end before the start is dropped so the editor picks its default length.
  expect(eventPrefill({ start: '2026-10-02T10:00', end: '2026-10-02T09:00' })).toEqual({ start: new Date(2026, 9, 2, 10).getTime() })
})

function recorder() {
  const calls: unknown[][] = []
  const handler = new Proxy({} as LinkTargets, { get: (_, name) => (...args: unknown[]) => void calls.push([name, ...args]) })
  return { calls, handler }
}

describe('routeJefiLink', () => {
  const route = (url: string) => {
    const { calls, handler } = recorder()
    routeJefiLink(parseJefiUrl(url), handler)
    return calls
  }

  test('always brings the window forward first', () => {
    expect(route('jefi://nothing-here')).toEqual([['showWindow']])
    expect(route('mailto:a@b.c')).toEqual([['showWindow']])
  })

  test('maps every route to its target', () => {
    expect(route('jefi://inbox/acc')).toEqual([['showWindow'], ['inbox', 'acc']])
    expect(route('jefi://thread/acc:t1')).toEqual([['showWindow'], ['thread', 'acc:t1']])
    expect(route('jefi://compose?to=a@b.c&subject=Hi')).toEqual([['showWindow'], ['compose', { to: ['a@b.c'], cc: [], bcc: [], subject: 'Hi', body: '' }]])
    expect(route('jefi://search?q=x')).toEqual([['showWindow'], ['search', 'x']])
    expect(route('jefi://calendar?date=2026-10-02&view=month')).toEqual([['showWindow'], ['calendar', { date: localDay('2026-10-02'), view: 'month' }]])
    expect(route('jefi://calendar')).toEqual([['showWindow'], ['calendar', {}]])
    expect(route('jefi://event/e?start=5')).toEqual([['showWindow'], ['event', 'e', 5]])
    expect(route('jefi://new-event?title=T')).toEqual([['showWindow'], ['editEvent', { title: 'T' }]])
    expect(route('jefi://quick-add?text=Lunch')).toEqual([['showWindow'], ['quickAdd', 'Lunch']])
    expect(route('jefi://notes')).toEqual([['showWindow'], ['notes', undefined]])
    expect(route('jefi://note/n')).toEqual([['showWindow'], ['notes', 'n']])
    expect(route('jefi://new-note?title=T')).toEqual([['showWindow'], ['newNote', { title: 'T', body: '' }]])
    expect(route('jefi://settings/sync')).toEqual([['showWindow'], ['settings', 'sync']])
  })
})

test('links wait for a router, and a deferred route waits for the next one', async () => {
  const seen: Array<JefiRoute | null> = []
  dispatchJefiUrl('jefi://notes')
  const stop = subscribeJefiLinks((route) => seen.push(route))
  await Promise.resolve()
  expect(seen).toEqual([{ kind: 'notes' }])
  dispatchJefiUrl('jefi://inbox')
  expect(seen).toHaveLength(2)
  deferJefiRoute({ kind: 'search', query: 'x' })
  expect(seen).toHaveLength(2)
  stop()
  const next: Array<JefiRoute | null> = []
  const stopNext = subscribeJefiLinks((route) => next.push(route))
  await Promise.resolve()
  expect(next).toEqual([{ kind: 'search', query: 'x' }])
  stopNext()
})

describe('settings sections', () => {
  test('every section of the settings page has a link, integrations included', () => {
    expect(parseJefiUrl('jefi://settings/integrations')).toEqual({ kind: 'settings', section: 'integrations' })
    expect(SETTINGS_SECTIONS.indexOf('integrations')).toBe(SETTINGS_SECTIONS.indexOf('menubar') + 1)
  })

  test('the page mounts the asked-for section with room around it', () => {
    expect(settingsSectionWindow()).toEqual({ start: 0, end: 4 })
    expect(settingsSectionWindow('appearance')).toEqual({ start: 0, end: 5 })
    expect(settingsSectionWindow('calendar')).toEqual({ start: 5, end: 11 })
    expect(settingsSectionWindow('about')).toEqual({ start: SETTINGS_SECTIONS.length - 2, end: SETTINGS_SECTIONS.length })
  })
})
