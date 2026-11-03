// On-device detection of event-like dates in an email body ("tomorrow at
// 3pm", "Oct 12-14", "dinner on Friday"). chrono-node does the parsing; this
// module decides which matches look like events and places them in the
// user's zone relative to when the mail was sent. Never calls out to AI.

import * as chrono from 'chrono-node'
import { offsetMinutes, zonedToEpoch, isValidTimeZone, wallTime } from './tz'

export type DateSuggestion = {
  start: number
  end?: number
  allDay: boolean
  title?: string
  sourceText: string
  index: number
  length: number
  confidence: 'high' | 'medium'
}

export type DetectInput = {
  text: string
  subject?: string
  sentAt: number
  timeZone: string
  locale?: string
}

const MAX_SUGGESTIONS = 5
const HOUR = 36e5
const DAY = 24 * HOUR

// Words that make a bare day read like an event. Mostly English, plus the
// commonest ones for the other locales we parse.
const EVENT_WORDS = [
  'meeting', 'meet', 'call', 'dinner', 'lunch', 'breakfast', 'brunch', 'coffee', 'drinks',
  'deadline', 'due', 'appointment', 'appt', 'flight', 'webinar', 'interview', 'party',
  'reservation', 'check-in', 'check in', 'checkout', 'check-out', 'conference', 'workshop',
  'review', 'sync', 'standup', 'stand-up', 'demo', 'presentation', 'session', 'event',
  'wedding', 'birthday', 'concert', 'class', 'training', 'offsite', 'kickoff', 'kick-off',
  'launch', 'hearing', 'visit', 'booking', 'game', 'match', 'show', 'ceremony', 'screening',
  'interview', 'catch up', 'catch-up', '1:1', 'one-on-one', 'retro', 'viewing', 'pickup',
  'pick-up', 'delivery', 'departure', 'arrival', 'departs', 'arrives',
  'termin', 'besprechung', 'treffen', 'abendessen', 'mittagessen', 'frist',
  'réunion', 'rendez-vous', 'dîner', 'déjeuner', 'échéance',
  'reunión', 'cita', 'cena', 'almuerzo', 'plazo',
  'reunião', 'jantar', 'almoço', 'prazo',
  'vergadering', 'afspraak', 'etentje',
  '会議', 'ミーティング', '打ち合わせ', '締め切り', '予約',
]

const EVENT_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(${EVENT_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^\\p{L}\\p{N}])`,
  'iu',
)

// Words that turn the next number into an identifier rather than a date.
const ID_BEFORE = /(?:#|\border|\btracking|\binvoice|\bref(?:erence)?|\bno\.?|\bnumber|\bversion|\bv|\bticket|\bcase|\bid|\bacct|\baccount|\bsku|\bitem|\bconfirmation|\bcode|\bphone|\btel|\bfax|\bmobile|\bcall me at|[$€£¥₹])\s*[:#]?\s*$/i

// Lengths of time. chrono reads "about an hour" or "for 2 hours" as that
// long from now, which is never what the writer meant.
const AMOUNT = String.raw`(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-?five|ninety|a few|few|a couple(?: of)?|couple(?: of)?|\d+(?:[.,]\d+)?|half an?|an? half)`
const UNIT = String.raw`(?:sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?|hours?)`
const DURATION_RE = new RegExp(String.raw`^(?:(?:about|around|roughly|approximately|approx\.?|maybe|for|within|in|takes?|lasts?)\s+)*${AMOUNT}\s+(?:and a half\s+)?${UNIT}(?:\s+(?:and a half|or so))?$`, 'i')
// Words right before the match that make it a length rather than a time.
const DURATION_BEFORE = /\b(?:about|around|roughly|approximately|for|within|takes?|took|taking|lasts?|lasting|spend|spent|needs?|only|another|over|under|up to|at least|at most)\s*$/i
// "for 2 hours" after an event time: its length.
const LENGTH_AFTER = new RegExp(String.raw`^\s*,?\s*(?:for|lasting)\s+(?:(?:about|around|roughly|approximately)\s+)?(${AMOUNT})\s+(and a half\s+)?(${UNIT})(\s+and a half)?`, 'i')

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fortyfive: 45, 'forty-five': 45, ninety: 90,
  couple: 2, 'a couple': 2, 'couple of': 2, 'a couple of': 2, few: 3, 'a few': 3,
  'half a': 0.5, 'half an': 0.5, 'a half': 0.5, 'an half': 0.5,
}

// Milliseconds in "2 hours", "90 min", "an hour and a half".
export function lengthOf(amount: string, unit: string, andHalf = false) {
  const a = amount.toLowerCase().trim()
  let n = /^\d/.test(a) ? Number(a.replace(',', '.')) : WORD_NUMBERS[a] ?? NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (andHalf) n += 0.5
  const u = unit.toLowerCase()
  const ms = u.startsWith('h') ? n * HOUR : u.startsWith('m') ? n * 60_000 : n * 1000
  // Under five minutes or over a day isn't a meeting length we can trust.
  return ms >= 5 * 60_000 && ms <= DAY ? ms : undefined
}

const LOCALES: Record<string, chrono.Chrono> = {
  de: chrono.de.casual,
  fr: chrono.fr.casual,
  es: chrono.es.casual,
  pt: chrono.pt.casual,
  nl: chrono.nl.casual,
  ja: chrono.ja.casual,
  it: chrono.it.casual,
  sv: chrono.sv.casual,
  ru: chrono.ru.casual,
  zh: chrono.zh.casual,
  uk: chrono.uk.casual,
  fi: chrono.fi.casual,
}

// English plus "on the 12th", which chrono leaves alone: the next
// occurrence of that day of the month.
const english = (() => {
  const c = chrono.casual.clone()
  c.parsers.push({
    pattern: () => /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?[A-Za-z]{3})/i,
    extract: (ctx, match) => {
      const day = Number(match[1])
      if (day < 1 || day > 31) return null
      const ref = ctx.refDate
      let year = ref.getFullYear()
      let month = ref.getMonth() + 1
      if (day < ref.getDate()) {
        month++
        if (month > 12) {
          month = 1
          year++
        }
      }
      return { day, month, year }
    },
  })
  return c
})()

function parserFor(locale: string | undefined) {
  const lang = locale?.toLowerCase().split(/[-_]/)[0]
  return lang && LOCALES[lang] ? [english, LOCALES[lang]!] : [english]
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ')

// Replaces text we must not read dates from with spaces, so match indices
// still point into the original body.
export function maskText(text: string) {
  const lines = text.split('\n')
  let cut = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const t = line.trim()
    // Everything under a reply header, signature delimiter or quoted original.
    if (
      /^-{2,}\s*original message\s*-{2,}$/i.test(t) ||
      /^on\b.{0,200}\bwrote:$/i.test(t) ||
      (/^on\b/i.test(t) && /wrote:$/i.test(lines[i + 1]?.trim() ?? '')) ||
      /^(?:am|le|el|em|op)\b.{0,200}(?:schrieb|écrit|escribió|escreveu|schreef)\b.{0,40}:$/i.test(t) ||
      line === '-- ' ||
      t === '--'
    ) {
      cut = i
      break
    }
    if (
      /^>/.test(t) ||
      /^\*?(?:sent|date|from|to|cc|subject|gesendet|datum|envoyé|enviado)\s*:/i.test(t) ||
      /unsubscribe|copyright|©|all rights reserved|privacy policy|manage (?:your )?preferences|view (?:it )?in (?:your )?browser/i.test(t)
    ) {
      lines[i] = blank(line)
    }
  }
  if (cut >= 0) for (let i = cut; i < lines.length; i++) lines[i] = blank(lines[i]!)
  // Normalise dashes so "Oct 12–14" parses as a range; same length.
  return lines.join('\n').replace(/[‒-―−]/g, '-')
}

function cleanSubject(subject: string | undefined) {
  let s = subject?.trim() ?? ''
  for (;;) {
    const next = s.replace(/^(?:re|fwd?|aw|wg|tr|sv|vs|rv|antw)\s*(?:\[\d+\])?\s*:\s*/i, '').trim()
    if (next === s) break
    s = next
  }
  // Calendar-ish subjects ("Invitation: X @ Tue ...") keep just the name.
  s = s.replace(/^(?:invitation|updated invitation|invite)\s*:\s*/i, '').replace(/\s+@\s+.*$/, '')
  return s || undefined
}

function lineAround(text: string, index: number, length: number) {
  const from = text.lastIndexOf('\n', index - 1) + 1
  const nl = text.indexOf('\n', index + length)
  const to = nl < 0 ? text.length : nl
  return { line: text.slice(from, to), from }
}

// "Design review", "Team dinner": up to three capitalised words before the
// event word on the match's line.
function phraseTitle(line: string) {
  const m = line.match(EVENT_RE)
  if (!m) return undefined
  const kw = m[1]!
  const before = line.slice(0, m.index! + m[0].length - kw.length)
  const words = before.match(/((?:[A-Z][\w&'-]*\s+){1,3})$/)
  if (!words) return { keyword: kw }
  const lead = words[1]!.trim().split(/\s+/)
  // Drop sentence-starters that aren't part of a name.
  while (lead.length && /^(?:The|A|An|Our|My|Your|Please|Let's|Lets|Re|Hi|Hey|Also|And|So|Just|This|That|Next|Our|I|We)$/.test(lead[0]!)) lead.shift()
  if (!lead.length) return { keyword: kw }
  return { title: `${lead.join(' ')} ${kw}`, keyword: kw }
}

type Scored = DateSuggestion & { score: number }

export function detectDates(input: DetectInput): DateSuggestion[] {
  const { text, sentAt } = input
  const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC'
  if (!text) return []
  const masked = maskText(text)
  const reference = { instant: new Date(sentAt), timezone: offsetMinutes(sentAt, timeZone) }
  const subject = cleanSubject(input.subject)
  const found: Scored[] = []

  for (const parser of parserFor(input.locale)) {
    for (const r of parser.parse(masked, reference, { forwardDate: true })) {
      const s = judge(r, masked, text, sentAt, timeZone, subject)
      if (s) found.push(s)
    }
  }

  // Best first, then drop anything overlapping a better match.
  found.sort((a, b) => b.score - a.score || a.index - b.index)
  const kept: Scored[] = []
  for (const f of found) {
    const overlaps = kept.some((k) => f.index < k.index + k.length && k.index < f.index + f.length)
    const same = kept.some((k) => k.start === f.start && k.allDay === f.allDay)
    if (!overlaps && !same) kept.push(f)
    if (kept.length >= MAX_SUGGESTIONS) break
  }
  return kept.map(({ score: _, ...s }) => s)
}

function judge(
  r: chrono.ParsedResult,
  masked: string,
  text: string,
  sentAt: number,
  timeZone: string,
  subject: string | undefined,
): Scored | undefined {
  const src = r.text.trim()
  const index = r.index + (r.text.length - r.text.trimStart().length)
  // Bare numbers and years ("2026", "12") are never events on their own.
  if (/^\d+$/.test(src)) return undefined

  // Identifiers, prices, phone numbers and versions: digits glued to the
  // match or a telling word right before it.
  const before = masked.slice(Math.max(0, index - 24), index)
  const after = masked.slice(index + src.length, index + src.length + 3)
  if (ID_BEFORE.test(before)) return undefined
  if (/[\d./-]$/.test(before) && /\d/.test(src[0]!)) return undefined
  if (/^[./-]?\d/.test(after) && /\d$/.test(src)) return undefined

  // Lengths of time ("about an hour", "for 30 min", "takes two hours") are
  // not plans. "in an hour" is kept only next to an event word ("call in an
  // hour"), and then only as a medium-confidence hint since the writer may
  // still mean a length.
  const relative = [...r.tags()].some((t) => t.startsWith('result/relative'))
  let fromNow = false
  if (relative && /^(?:takes?|lasts?)$/i.test(src)) return undefined
  if (relative && DURATION_RE.test(src)) {
    if (!/^in\s/i.test(src) || DURATION_BEFORE.test(before)) return undefined
    fromNow = true
  }

  const s = r.start
  const hasTime = s.isCertain('hour')
  const hasDay = s.isCertain('day') || s.isCertain('weekday') || [...r.tags()].some((t) => t.startsWith('casualReference/') && !/noon|morning|afternoon|evening|night|midnight|now/.test(t))
  const isRange = !!r.end && (r.end.isCertain('day') || r.end.isCertain('hour'))
  const { line } = lineAround(masked, index, src.length)
  const phrase = phraseTitle(line)
  const hasKeyword = !!phrase

  // Only things that read like events.
  if (fromNow && !hasKeyword) return undefined
  const eventLike = (hasDay && hasTime) || (isRange && (hasDay || hasTime)) || (hasKeyword && (hasDay || hasTime))
  if (!eventLike) return undefined

  const allDay = !hasTime
  const wall = (c: chrono.ParsedComponents, dayOnly: boolean) => ({
    year: c.get('year')!,
    month: c.get('month')!,
    day: c.get('day')!,
    hour: dayOnly ? 0 : c.get('hour') ?? 0,
    minute: dayOnly ? 0 : c.get('minute') ?? 0,
    second: 0,
  })
  // An explicit zone in the text ("3pm PT") wins; otherwise the wall time
  // is the user's, which keeps DST right even when the event is weeks out.
  const place = (c: chrono.ParsedComponents) =>
    !allDay && c.isCertain('timezoneOffset') ? c.date().getTime() : zonedToEpoch(wall(c, allDay), timeZone)

  const start = place(s)
  let end: number | undefined
  if (allDay) {
    const last = r.end ? place(r.end) : start
    // Exclusive end: midnight after the last day.
    const w = wallTime(last + 36 * HOUR, timeZone)
    end = zonedToEpoch({ ...w, hour: 0, minute: 0, second: 0 }, timeZone)
  } else {
    // "at 3pm for 2 hours": the length that follows sets the end.
    const len = masked.slice(index + src.length, index + src.length + 48).match(LENGTH_AFTER)
    const ms = len ? lengthOf(len[1]!, len[3]!, !!(len[2] || len[4])) : undefined
    end = r.end?.isCertain('hour') ? place(r.end) : start + (ms ?? HOUR)
    if (end <= start) end += DAY
  }

  // Past events: allow up to a day before sending (e.g. "this morning").
  if ((end ?? start) < sentAt - DAY) return undefined
  // forwardDate pushes a yearless "September 1" sent on Sept 24 into next
  // year; that almost always meant the one just gone.
  if (!s.isCertain('year') && s.isCertain('month') && start > sentAt + 300 * DAY) return undefined

  const confidence: 'high' | 'medium' = !fromNow && hasDay && (hasTime || isRange || hasKeyword) ? 'high' : 'medium'
  let score = confidence === 'high' ? 100 : 50
  if (hasTime) score += 20
  if (isRange) score += 10
  if (hasKeyword) score += 10
  if (s.isCertain('day')) score += 5

  const title = phrase?.title ?? subject ?? (phrase ? phrase.keyword[0]!.toUpperCase() + phrase.keyword.slice(1) : undefined)
  const out: Scored = {
    start,
    end,
    allDay,
    sourceText: text.slice(index, index + src.length),
    index,
    length: src.length,
    confidence,
    score,
  }
  if (title) out.title = title
  return out
}
