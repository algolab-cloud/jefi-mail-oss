import { describe, expect, test } from 'bun:test'
import { detectDates } from './dates'

const berlin = 'Europe/Berlin'
const ny = 'America/New_York'
// Thursday 2026-09-24 10:00 in Berlin (UTC+2).
const sentAt = Date.parse('2026-09-24T08:00:00Z')
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())

const detect = (text: string, extra: Partial<Parameters<typeof detectDates>[0]> = {}) =>
  detectDates({ text, sentAt, timeZone: berlin, ...extra })

describe('detectDates', () => {
  test('relative date with time resolves against sentAt in the user zone', () => {
    const [s, ...rest] = detect('Hi Anna,\n\nCan we do the Design review tomorrow at 3pm?\n\nThanks')
    expect(rest).toHaveLength(0)
    expect(iso(s!.start)).toBe('2026-09-25T13:00:00.000Z')
    expect(iso(s!.end)).toBe('2026-09-25T14:00:00.000Z')
    expect(s!.allDay).toBe(false)
    expect(s!.title).toBe('Design review')
    expect(s!.sourceText).toBe('tomorrow at 3pm')
    expect(s!.confidence).toBe('high')
  })

  test('index and length point into the original text', () => {
    const text = 'Lunch next Friday at 12:30 works for me.'
    const [s] = detect(text)
    expect(text.slice(s!.index, s!.index + s!.length)).toBe(s!.sourceText)
    expect(iso(s!.start)).toBe('2026-10-02T10:30:00.000Z')
    expect(iso(s!.end)).toBe('2026-10-02T11:30:00.000Z')
  })

  test('time range keeps its end', () => {
    const [s] = detect('Standup moved to Monday 9:30-10:15.', { subject: 'Re: Fwd: Standup' })
    expect(iso(s!.start)).toBe('2026-09-28T07:30:00.000Z')
    expect(iso(s!.end)).toBe('2026-09-28T08:15:00.000Z')
    expect(s!.title).toBe('Standup')
  })

  test('explicit day range with en dash is all-day with exclusive end', () => {
    const [s] = detect('The conference runs Oct 12–14 in Lisbon.')
    expect(s!.allDay).toBe(true)
    expect(iso(s!.start)).toBe('2026-10-11T22:00:00.000Z')
    expect(iso(s!.end)).toBe('2026-10-14T22:00:00.000Z')
  })

  test('day with an event keyword is all-day; without one it is skipped', () => {
    const [s] = detect('Reminder: the report is due on October 3.', { subject: 'Q3 report' })
    expect(s!.allDay).toBe(true)
    expect(iso(s!.start)).toBe('2026-10-02T22:00:00.000Z')
    expect(s!.title).toBe('Q3 report')
    expect(detect('I was thinking about October 3 the other day.')).toHaveLength(0)
  })

  test('"on the 12th" with a keyword', () => {
    const [s] = detect('Dinner on the 12th?')
    expect(s!.allDay).toBe(true)
    expect(iso(s!.start)).toBe('2026-10-11T22:00:00.000Z')
  })

  test('skips quoted replies, reply headers and signatures', () => {
    const text = [
      'Sounds good.',
      '',
      '> Can we meet tomorrow at 4pm?',
      '',
      'On Wed, Sep 23, 2026 at 9:12 AM Bob <bob@example.com> wrote:',
      'Let us have a call on Friday at 11am.',
      '',
    ].join('\n')
    expect(detect(text)).toHaveLength(0)
    const sig = 'See you at the meeting Monday 2pm.\n-- \nBob\nOffice hours: Tuesday 10am-12pm'
    const found = detect(sig)
    expect(found).toHaveLength(1)
    expect(found[0]!.sourceText).toBe('Monday 2pm')
  })

  test('skips forwarded headers and footers but reads the forwarded body', () => {
    const text = [
      '---------- Forwarded message ---------',
      'From: Carol <carol@example.com>',
      'Date: Tue, Sep 22, 2026 at 3:04 PM',
      'Subject: Offsite',
      'To: team@example.com',
      '',
      'The offsite dinner is on Oct 2 at 7pm.',
      '',
      'Unsubscribe from these emails. Sent Sep 22 at 10am.',
      '© 2026 Example Inc. All rights reserved.',
    ].join('\n')
    const found = detect(text)
    expect(found).toHaveLength(1)
    expect(iso(found[0]!.start)).toBe('2026-10-02T17:00:00.000Z')
    expect(found[0]!.title).toBeDefined()
  })

  test('ignores order numbers, prices, phone numbers, versions and bare years', () => {
    const text = [
      'Your order #2026-10-12 has shipped. Tracking: 1Z 10/12 3344.',
      'Total: $10.12, call 555-10-12 for help.',
      'Upgrade to version 10.12 today. Founded in 2019.',
      'Invoice no. 12/10 is attached.',
    ].join('\n')
    expect(detect(text)).toEqual([])
  })

  test('drops past dates but keeps recent ones', () => {
    expect(detect('The meeting on September 1 at 3pm went well.')).toHaveLength(0)
    // The day before sending is still within the one-day grace.
    expect(detect('Notes from the call yesterday at 5pm.')).toHaveLength(1)
  })

  test('dedupes and caps to five, best first', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `Meeting ${i + 1}: October ${i + 1} at ${i + 9}:00`)
    lines.push('Also the meeting on October 1 at 9:00 again.')
    const found = detect(lines.join('\n'))
    expect(found).toHaveLength(5)
    const starts = new Set(found.map((f) => f.start))
    expect(starts.size).toBe(5)
    expect(found.every((f) => f.confidence === 'high')).toBe(true)
  })

  test('explicit zone in the text wins over the user zone', () => {
    const [s] = detect('Call at 9am PST tomorrow.')
    expect(iso(s!.start)).toBe('2026-09-25T17:00:00.000Z')
  })

  test('DST: Berlin wall time is kept across the October change', () => {
    // Sent before the switch (UTC+2), event after it (UTC+1).
    const [s] = detectDates({ text: 'Meeting on October 26 at 10:00.', sentAt: Date.parse('2026-10-20T08:00:00Z'), timeZone: berlin })
    expect(iso(s!.start)).toBe('2026-10-26T09:00:00.000Z')
    // The change night itself: 02:30 happens twice; take the first.
    const [t] = detectDates({ text: 'Call on October 25 at 2:30am.', sentAt: Date.parse('2026-10-20T08:00:00Z'), timeZone: berlin })
    expect(iso(t!.start)).toBe('2026-10-25T00:30:00.000Z')
  })

  test('DST: New York in March', () => {
    const sent = Date.parse('2026-03-05T15:00:00Z') // EST
    const [s] = detectDates({ text: 'Dinner Monday March 9 at 7pm', sentAt: sent, timeZone: ny })
    expect(iso(s!.start)).toBe('2026-03-09T23:00:00.000Z') // EDT
    // 2:30am on the change day does not exist; it lands after the jump.
    const [t] = detectDates({ text: 'Flight on March 8 at 2:30am', sentAt: sent, timeZone: ny })
    expect(iso(t!.start)).toBe('2026-03-08T07:30:00.000Z')
  })

  test('other locales when asked', () => {
    const [s] = detect('Können wir uns morgen um 15 Uhr treffen?', { locale: 'de-DE' })
    expect(iso(s!.start)).toBe('2026-09-25T13:00:00.000Z')
    const [f] = detect('Réunion demain à 15h', { locale: 'fr' })
    expect(iso(f!.start)).toBe('2026-09-25T13:00:00.000Z')
  })

  test('is fast on a long email', () => {
    const para = 'Thanks for the update on the project. We reviewed the numbers from last quarter and they look fine. ' +
      'Order #48213 shipped for $19.99. Please call 555-0134 if anything changes.\n'
    const text = para.repeat(200) + 'Let us meet on Tuesday at 10am.\n' + para.repeat(50)
    detect(text)
    const t0 = performance.now()
    const found = detect(text)
    const ms = performance.now() - t0
    expect(found).toHaveLength(1)
    console.log(`detectDates on ${text.length} chars: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(250)
  })

  test('lengths of time are not events', () => {
    for (const text of [
      'It should take about an hour.',
      'The drive is around 2 hours.',
      'Allow roughly 30 min for setup.',
      'Please reply within 2 hours.',
      'It takes half an hour to get there.',
      'The talk lasts 45 minutes.',
      'Budget two hours for it.',
      'We spent a couple of hours on it.',
      'I will be back in 20 minutes.',
    ]) expect(detect(text)).toEqual([])
  })

  test('"in an hour" next to an event word is a medium hint', () => {
    const [s, ...rest] = detect('Quick call in an hour?')
    expect(rest).toHaveLength(0)
    expect(iso(s!.start)).toBe('2026-09-24T09:00:00.000Z')
    expect(s!.confidence).toBe('medium')
    // Still a length when phrased as one.
    expect(detect('The meeting should take about an hour.')).toEqual([])
  })

  test('a length after an event time sets its end', () => {
    const [s, ...rest] = detect('Meeting tomorrow at 3pm for 2 hours.')
    expect(rest).toHaveLength(0)
    expect(iso(s!.start)).toBe('2026-09-25T13:00:00.000Z')
    expect(iso(s!.end)).toBe('2026-09-25T15:00:00.000Z')
    expect(iso(detect('Dinner on Friday at 7pm, for about an hour and a half')[0]!.end)).toBe('2026-09-25T18:30:00.000Z')
    expect(iso(detect('Sync Monday 10:00 for 30 min')[0]!.end)).toBe('2026-09-28T08:30:00.000Z')
  })
})
