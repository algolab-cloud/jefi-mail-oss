import { useState } from 'react'
import type { Attendee, EventOccurrence, InviteResponse, InviteView } from '../engine'
import { Icon, type IconName } from '../icons'
import { useEvents, useLocalQuery } from '../local-data'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'

// ---------------------------------------------------------------------------
// The invitation card the reader shows above a message that carries a calendar invite (iTIP).
// Self-contained: give it the conversation and message ids and it loads the invite, the event it
// made and any clashes itself, and re-renders on calendar changes only.
//
//   {message.hasInvite ? <InviteCard threadId={thread.id} messageId={message.id} /> : null}
//
// It renders nothing for a message without a REQUEST, CANCEL or REPLY, so it's safe to mount on any
// message whose attachments include text/calendar or application/ics.
// ---------------------------------------------------------------------------

const DAY = 86_400_000
const userZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** A time zone's canonical name ("Asia/Calcutta" is "Asia/Kolkata", "Etc/UTC" is "UTC"), or null for one Intl doesn't know. */
const canonicalZone = (zone: string): string | null => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}
const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'GMT0', 'Etc/Greenwich', 'Greenwich', 'Etc/UCT', 'UCT'])

/**
 * The invite's time on our clock, then on the organizer's when that tells us something: their zone
 * is a real place other than ours and the line reads differently. An invitation written in UTC
 * (DTSTART:…Z, as many calendars send them) says nothing about where the organizer is, so it gets
 * no second line.
 */
export function whenLines(v: Pick<InviteView, 'startAt' | 'endAt' | 'allDay' | 'timeZone'>, mine = userZone()): string[] {
  if (v.allDay) {
    const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    const last = v.endAt - DAY
    return [last > v.startAt ? `${day.format(v.startAt)} – ${day.format(last)} · All day` : `${day.format(v.startAt)} · All day`]
  }
  const line = (zone: string, label?: string) => {
    const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: zone })
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone })
    const sameDay = date.format(v.startAt) === date.format(v.endAt)
    const end = sameDay ? time.format(v.endAt) : `${date.format(v.endAt)}, ${time.format(v.endAt)}`
    return `${date.format(v.startAt)}, ${time.format(v.startAt)} – ${end}${label ? ` (${label})` : ''}`
  }
  const lines = [line(mine)]
  const theirs = v.timeZone ? canonicalZone(v.timeZone) : null
  if (!theirs || UTC_ZONES.has(theirs) || UTC_ZONES.has(v.timeZone!) || theirs === canonicalZone(mine)) return lines
  const other = line(theirs)
  if (other !== lines[0]) lines.push(line(theirs, v.timeZone!.replace(/_/g, ' ')))
  return lines
}

const WEEKDAY: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
const UNIT: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }

/** "Every 2 weeks on Mon, Thu, 6 times" from an RRULE. */
export function recurrenceSummary(rule: string): string {
  const parts = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]))
  const unit = UNIT[parts.FREQ ?? ''] ?? 'time'
  const every = Number(parts.INTERVAL ?? 1)
  let text = every > 1 ? `Every ${every} ${unit}s` : `Every ${unit}`
  const days = parts.BYDAY?.split(',').map((d) => WEEKDAY[d.replace(/^[+-]?\d+/, '')] ?? d)
  if (days?.length) text += ` on ${days.join(', ')}`
  if (parts.COUNT) text += `, ${parts.COUNT} times`
  else if (parts.UNTIL) {
    const u = parts.UNTIL
    text += `, until ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8)))}`
  }
  return text
}

/** "Kenji, Ada and 3 others · 2 accepted, 1 declined". */
export function attendeeSummary(attendees: Attendee[]): string {
  const others = attendees.filter((a) => !a.self)
  if (!others.length) return ''
  const names = others.slice(0, 2).map((a) => a.name || a.email)
  const rest = others.length - names.length
  const who = rest > 0 ? `${names.join(', ')} and ${rest} other${rest > 1 ? 's' : ''}` : names.join(' and ')
  const count = (p: Attendee['partstat']) => others.filter((a) => a.partstat === p).length
  const tally = [
    [count('accepted'), 'accepted'],
    [count('tentative'), 'maybe'],
    [count('declined'), 'declined'],
  ].flatMap(([n, label]) => (n ? [`${n} ${label}`] : []))
  return tally.length ? `${who} · ${tally.join(', ')}` : who
}

const RESPONSES: Array<{ value: InviteResponse; label: string }> = [
  { value: 'accepted', label: 'Accept' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: 'Decline' },
]
const ANSWERED: Record<string, string> = { accepted: 'You’re going', tentative: 'You might go', declined: 'You declined' }
const REPLIED: Record<string, string> = { accepted: 'accepted', tentative: 'tentatively accepted', declined: 'declined', 'needs-action': 'hasn’t answered', delegated: 'delegated' }

function Row({ icon, children, tone }: { icon: IconName; children: string; tone?: string }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 8, pointerEvents: 'none' }}>
      <div style={{ paddingTop: 2, flexShrink: 0 }}>
        <Icon name={icon} size={13} color={C.muted} />
      </div>
      <text style={{ fontSize: 12.5, lineHeight: 18, color: tone ?? C.secondary, fontFamily: FONT, flexGrow: 1, minWidth: 0 }}>{children}</text>
    </div>
  )
}

function Choice({ label, selected, busy, onClick, testId }: { label: string; selected: boolean; busy: boolean; onClick: () => void; testId: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={busy ? undefined : onClick}
      style={{
        height: 30,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: 15,
        backgroundColor: selected ? C.accent : C.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: busy ? 0.6 : 1,
        cursor: busy ? 'default' : 'pointer',
        hover: busy || selected ? undefined : { backgroundColor: C.overlayStrong },
      }}
    >
      <text style={{ fontSize: 12.5, fontWeight: 500, color: selected ? C.onAccent : C.text, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}

function LinkButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  const { C } = useSettings()
  return (
    <div testId={testId} onClick={onClick} style={{ paddingLeft: 4, paddingRight: 4, height: 24, borderRadius: 5, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}>
      <text style={{ fontSize: 12.5, fontWeight: 500, color: C.accent, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}

/** Other events in the calendar at the same time, this one left out. */
function useConflicts(view: InviteView | null): EventOccurrence[] {
  const from = view?.startAt ?? 0
  const to = view ? Math.max(view.endAt, view.startAt + 1) : 0
  const events = useEvents(from, to)
  if (!view || view.cancelled || view.method !== 'REQUEST') return []
  return (events ?? []).filter((e) => e.id !== view.eventId && e.recurringMasterId !== view.eventId && e.uid !== view.uid && e.startAt < to && e.endAt > from && !(e.allDay && !view.allDay))
}

export function InviteCard({ threadId, messageId }: { threadId: string; messageId: string }) {
  const { C } = useSettings()
  const actions = useMailActions()
  const view = useLocalQuery('calendar', `invite:${threadId}:${messageId}`, () => actions.inviteForMessage(threadId, messageId))
  const conflicts = useConflicts(view)
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)
  if (!view) return null

  const answer = async (response: InviteResponse) => {
    setBusy(true)
    await actions.respondToInvite(threadId, messageId, response)
    setBusy(false)
    setChanging(false)
  }
  const remove = async () => {
    if (view.eventId) await actions.deleteEvent(view.eventId)
  }

  const responded = view.response && view.response !== 'needs-action' ? view.response : null
  const showChoices = view.method === 'REQUEST' && !view.cancelled && (!responded || changing)
  const where = view.location
  const people = attendeeSummary(view.attendees)
  const organizer = view.organizer ? view.organizer.name || view.organizer.email : null

  return (
    <div
      testId="invite-card"
      style={{ marginTop: 8, marginBottom: 12, padding: 14, gap: 10, borderRadius: 12, backgroundColor: C.raised, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
        <Icon name="calendar" size={15} color={view.cancelled ? C.muted : C.accent} />
        <text style={{ fontSize: 14, fontWeight: 600, color: view.cancelled ? C.muted : C.text, fontFamily: FONT, flexGrow: 1, minWidth: 0, textDecoration: view.cancelled ? 'line-through' : undefined }}>
          {view.title}
        </text>
        {view.method === 'REQUEST' && view.sequence > 0 && !view.cancelled ? <text style={{ fontSize: 11, color: C.muted, fontFamily: FONT }}>Updated</text> : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {whenLines(view).map((line, i) => (
          <Row key={i} icon="clock" tone={i ? C.muted : undefined}>{line}</Row>
        ))}
        {view.recurrence ? <Row icon="refresh">{recurrenceSummary(view.recurrence)}</Row> : null}
        {where ? <Row icon="pin">{where}</Row> : null}
        {organizer ? <Row icon="user">{`Organizer: ${organizer}`}</Row> : null}
        {people ? <Row icon="userPlus">{people}</Row> : null}
        {conflicts.length ? (
          <Row icon="alertCircle" tone={C.amber}>{`Overlaps ${conflicts.slice(0, 2).map((e) => e.title).join(', ')}${conflicts.length > 2 ? ` and ${conflicts.length - 2} more` : ''}`}</Row>
        ) : null}
      </div>

      {view.method === 'REPLY' && view.replyFrom ? (
        <text testId="invite-reply" style={{ fontSize: 12.5, color: C.text, fontFamily: FONT }}>
          {`${view.replyFrom.name || view.replyFrom.email} ${REPLIED[view.replyFrom.partstat ?? 'needs-action']}`}
        </text>
      ) : null}

      {view.cancelled ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, flexGrow: 1 }}>This event was cancelled</text>
          {view.eventId ? <LinkButton label="Remove from calendar" onClick={() => void remove()} testId="invite-remove" /> : null}
        </div>
      ) : null}

      {view.method === 'REQUEST' && !view.cancelled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.outdated ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>This invitation has since been updated; your answer applies to the latest version.</text> : null}
          {view.state === 'pending' && !view.eventId ? (
            <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>Not added to your calendar, since it came from Junk or an unknown sender. Answering adds it.</text>
          ) : null}
          {showChoices ? (
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {RESPONSES.map((r) => (
                <Choice key={r.value} label={r.label} selected={responded === r.value} busy={busy} onClick={() => void answer(r.value)} testId={`invite-${r.value}`} />
              ))}
              {changing ? <LinkButton label="Keep answer" onClick={() => setChanging(false)} testId="invite-keep" /> : null}
            </div>
          ) : responded ? (
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <div style={{ pointerEvents: 'none' }}>
                <Icon name={responded === 'declined' ? 'x' : 'circleCheck'} size={14} color={responded === 'declined' ? C.muted : C.green} />
              </div>
              <text testId="invite-response" style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, flexGrow: 1 }}>{ANSWERED[responded] ?? responded}</text>
              <LinkButton label="Change response" onClick={() => setChanging(true)} testId="invite-change" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
