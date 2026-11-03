import { useEffect, useState, type ReactNode } from 'react'
import { BidiText } from '../bidi-text'
import type { Calendar, EventLink, EventOccurrence, SeriesScope } from '../engine'
import { joinLink, meetingProvider } from '../engine/calendar/meeting'
import { FONT, mixHex, useSettings } from '../theme'
import { Icon, IconButton, type IconName } from '../icons'
import { useMailActions } from '../store'
import { useOverlay } from '../overlays'
import { displaySpan } from './dates'
import { describeRule, sendsInvites } from './draft'
import { inviteSender } from './invites'
import { dayLine, monthShortDay, solid, whenText } from './format'

// ---------------------------------------------------------------------------
// The card an event opens: when, where, who, linked mail, and edit / delete. Anchored beside the
// event it belongs to; a click anywhere else closes it.
// ---------------------------------------------------------------------------

/** The conversation a link points into (a message id is `${threadId}-${rowid}`). */
export function threadOfLink(link: EventLink): { accountId: string; threadId: string } | null {
  const target = link.target
  if (!link.live || !('accountId' in target) || target.accountId === null) return null
  if ('threadId' in target) return { accountId: target.accountId, threadId: target.threadId }
  if ('messageId' in target) return { accountId: target.accountId, threadId: target.messageId.slice(0, target.messageId.lastIndexOf('-')) }
  return null
}

export function EventCard({
  occurrence: o,
  calendar,
  onClose,
  onEdit,
  onDeleted,
  side = 'right',
}: {
  occurrence: EventOccurrence
  calendar: Calendar | undefined
  onClose: () => void
  onEdit: () => void
  onDeleted: () => void
  side?: 'left' | 'right' | 'top' | 'bottom'
}) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { eventLinks, showThread, deleteEvent } = useMailActions()
  const [links, setLinks] = useState<EventLink[]>([])
  const [confirm, setConfirm] = useState(false)
  // A delete that would email the guests waits here for the person to choose whether to tell them.
  const [notifyScope, setNotifyScope] = useState<SeriesScope | null>(null)
  useOverlay(true)
  useEffect(() => {
    let live = true
    void eventLinks(o.id).then((next) => live && setLinks(next))
    return () => {
      live = false
    }
  }, [o.id])

  const color = solid(calendar?.color ?? C.accent, C)
  const { start } = displaySpan(o)
  const readOnly = calendar ? !calendar.canWrite : false
  const series = o.recurring || !!o.recurringMasterId
  const remove = async (scope: SeriesScope, notify?: boolean) => {
    // The guests of the person's own upcoming event can hear it's off (the whole event; one occurrence
    // can't be cancelled on its own yet), but only when they choose to tell them. If the cancellation
    // can't be sent, the event stays so they can retry or delete it quietly.
    const sender = inviteSender()
    if (sender && cancelsForGuests(o, scope, Date.now())) {
      if (notify === undefined) {
        setConfirm(false)
        setNotifyScope(scope)
        return
      }
      if (notify) {
        const sent = await sender({ ...o, id: o.recurringMasterId ?? o.id }, 'cancel').then(
          () => true,
          () => false,
        )
        if (!sent) return
      }
    }
    const ok = await deleteEvent(o.id, scope, o.recurring ? o.occurrenceStart : undefined)
    if (ok) onDeleted()
  }
  const mail = links.filter((l) => l.target.kind === 'thread' || l.target.kind === 'message')
  const join = joinLink(o)
  const meeting = meetingProvider(join)

  return (
    <anchored side={side} align="start" gap={8} fit="snap" deferred priority={2} occlude style={{ backgroundColor: C.raised, borderRadius: 14 }}>
      <div
        testId="event-card"
        onMouseDownOutside={onClose}
        style={{
          width: 340,
          // The grid under it turns selection off; a place or a description here can be copied.
          userSelect: 'text',
          borderRadius: 14,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 14, blurRadius: 40, spreadRadius: 0, color: dark ? '#00000088' : '#00000030' },
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* A band of the calendar's colour, so the card says whose event it is at a glance. GPUIX clips
            children to a rectangle, not the card's rounded corners, so the band rounds its own. */}
        <div style={{ height: 4, borderTopLeftRadius: 13, borderTopRightRadius: 13, backgroundColor: color, pointerEvents: 'none' }} />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', paddingTop: 14, paddingLeft: 18, paddingRight: 10, gap: 8 }}>
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 }}>
            <BidiText testId="event-card-title" text={o.title || 'Untitled event'} style={{ fontSize: 16.5, lineHeight: 22, fontWeight: 600, color: C.text, fontFamily: FONT }} />
            <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>{`${dayLine(start)} · ${whenText(o)}`}</text>
          </div>
          {readOnly ? null : <IconButton icon="pencil" size={15} pad={30} tooltip="Edit" onClick={onEdit} testId="event-card-edit" />}
          {readOnly ? null : <IconButton icon="trash" size={15} pad={30} tooltip="Delete" onClick={() => (series ? setConfirm(true) : void remove('all'))} testId="event-card-delete" />}
          <IconButton icon="x" size={15} pad={30} tooltip="Close" onClick={onClose} testId="event-card-close" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14, paddingBottom: 16, paddingLeft: 18, paddingRight: 18 }}>
          {/* An occurrence changed on its own is a row without the rule; it would read "Does not repeat". */}
          {series ? <Row icon="repeat">{<Quiet>{o.recurrence ? describeRule(o.recurrence, start) : 'Part of a repeating series, changed on its own'}</Quiet>}</Row> : null}
          {join ? (
            <div
              testId="event-card-join"
              onClick={() => void Bun.spawn(['open', join], { stdout: 'ignore', stderr: 'ignore' })}
              style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 12, marginLeft: -2, borderRadius: 16, backgroundColor: C.text, cursor: 'pointer', hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) }, active: { backgroundColor: mixHex(C.text, C.reading, 0.22) } }}
            >
              <div style={{ pointerEvents: 'none', display: 'flex' }}>
                <Icon name={meeting ? 'video' : 'link'} size={15} color={C.onText} />
              </div>
              <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {meeting ? `Join ${meeting.label}` : 'Open link'}
              </text>
            </div>
          ) : null}
          {o.location ? (
            <Row icon="mapPin">
              <text style={{ fontSize: 13, lineHeight: 18, color: C.text, fontFamily: FONT }}>{o.location}</text>
            </Row>
          ) : null}
          {o.attendees.length ? (
            <Row icon="users">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexGrow: 1, minWidth: 0 }}>
                <Quiet>{`${o.attendees.length} ${o.attendees.length === 1 ? 'guest' : 'guests'}${answered(o)}`}</Quiet>
                {o.attendees.slice(0, 6).map((a) => (
                  <div key={a.email} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.face, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <text style={{ fontSize: 9.5, fontWeight: 600, color: C.secondary, fontFamily: FONT }}>{(a.name || a.email).slice(0, 1).toUpperCase()}</text>
                    </div>
                    <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, color: a.partstat === 'declined' ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', textDecoration: a.partstat === 'declined' ? 'line-through' : 'none' }}>
                      {a.name || a.email}
                    </text>
                    <PartStat value={a.partstat} />
                  </div>
                ))}
                {o.attendees.length > 6 ? <Quiet>{`and ${o.attendees.length - 6} more`}</Quiet> : null}
              </div>
            </Row>
          ) : null}
          {o.description ? (
            <Row icon="alignLeft">
              <text style={{ fontSize: 13, lineHeight: 19, color: C.secondary, fontFamily: FONT, lineClamp: 6 }}>{o.description}</text>
            </Row>
          ) : null}
          {mail.map((link) => {
            const thread = threadOfLink(link)
            const from = link.snapshot.from
            return (
              <div
                key={link.id}
                testId="event-card-mail"
                onClick={thread ? () => showThread(thread.accountId, thread.threadId) : undefined}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 10,
                  paddingRight: 10,
                  marginLeft: -2,
                  borderRadius: 9,
                  backgroundColor: C.overlay,
                  cursor: thread ? 'pointer' : 'default',
                  hover: thread ? { backgroundColor: C.overlayStrong } : undefined,
                }}
              >
                <div style={{ pointerEvents: 'none', display: 'flex' }}>
                  <Icon name={link.role === 'invite' ? 'calendar' : 'mail'} size={15} color={thread ? C.accent : C.muted} />
                </div>
                <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' }}>
                  <text style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{link.snapshot.subject || '(no subject)'}</text>
                  <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    {[from?.name || from?.email, link.snapshot.date ? monthShortDay(link.snapshot.date) : null, thread ? null : 'no longer in your mail'].filter(Boolean).join(' · ')}
                  </text>
                </div>
                {thread ? (
                  <div style={{ pointerEvents: 'none', display: 'flex' }}>
                    <Icon name="arrowRight" size={14} color={C.muted} />
                  </div>
                ) : null}
              </div>
            )
          })}
          <Row icon="calendar">
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
              <Quiet>{calendar?.name ?? 'Calendar'}</Quiet>
            </div>
          </Row>
        </div>

        {confirm ? (
          <div testId="event-card-delete-scope" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 8, borderTopWidth: 1, borderColor: C.overlay, backgroundColor: C.overlay, borderBottomLeftRadius: 13, borderBottomRightRadius: 13 }}>
            <text style={{ fontSize: 12, fontWeight: 600, color: C.secondary, fontFamily: FONT, paddingLeft: 10, paddingTop: 4, paddingBottom: 4 }}>Delete a repeating event</text>
            <ScopeChoice label="This event" onSelect={() => void remove('this')} testId="delete-this" />
            <ScopeChoice label="This and following events" onSelect={() => void remove('following')} testId="delete-following" />
            <ScopeChoice label="All events in the series" onSelect={() => void remove('all')} danger testId="delete-all" />
          </div>
        ) : null}
        {notifyScope ? (
          <div testId="event-card-delete-notify" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 8, borderTopWidth: 1, borderColor: C.overlay, backgroundColor: C.overlay, borderBottomLeftRadius: 13, borderBottomRightRadius: 13 }}>
            <text style={{ fontSize: 12, fontWeight: 600, color: C.secondary, fontFamily: FONT, paddingLeft: 10, paddingTop: 4, paddingBottom: 4 }}>Tell the guests it's cancelled?</text>
            <ScopeChoice label="Delete and notify guests" onSelect={() => void remove(notifyScope, true)} danger testId="delete-notify" />
            <ScopeChoice label="Delete without notifying" onSelect={() => void remove(notifyScope, false)} testId="delete-quietly" />
          </div>
        ) : null}
      </div>
    </anchored>
  )
}

/** Whether deleting sends the guests a cancellation: the person's own invited event, not over, deleted whole. */
export function cancelsForGuests(o: EventOccurrence, scope: SeriesScope, now: number): boolean {
  const whole = scope === 'all' || !(o.recurring || o.recurringMasterId)
  const over = o.recurring || o.recurringMasterId ? false : o.endAt <= now
  // No account means its invitations never went out, so there's no one to tell.
  return whole && !over && !!o.accountId && o.status !== 'cancelled' && sendsInvites({ attendees: o.attendees.map((a) => a.email), attendeeDetails: o.attendees })
}

const answered = (o: EventOccurrence) => {
  const yes = o.attendees.filter((a) => a.partstat === 'accepted').length
  const waiting = o.attendees.filter((a) => !a.partstat || a.partstat === 'needs-action').length
  return [yes ? ` · ${yes} yes` : '', waiting ? ` · ${waiting} awaiting` : ''].join('')
}

function Row({ icon, children }: { icon: IconName; children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ paddingTop: 1, display: 'flex' }}>
        <Icon name={icon} size={15} color={C.muted} />
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}

function Quiet({ children }: { children: string }) {
  const { C } = useSettings()
  return <text style={{ fontSize: 13, lineHeight: 18, color: C.secondary, fontFamily: FONT }}>{children}</text>
}

function PartStat({ value }: { value?: string }) {
  const { C } = useSettings()
  const [label, color] =
    value === 'accepted' ? ['Going', C.green] : value === 'declined' ? ['Declined', C.muted] : value === 'tentative' ? ['Maybe', C.amber] : ['Awaiting', C.ghost]
  return <text style={{ fontSize: 11, fontWeight: 500, color, fontFamily: FONT, flexShrink: 0 }}>{label}</text>
}

export function ScopeChoice({ label, onSelect, danger, testId }: { label: string; onSelect: () => void; danger?: boolean; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={onSelect}
      style={{ height: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 7, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
    >
      <text style={{ fontSize: 13, color: danger ? C.accent : C.text, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}
