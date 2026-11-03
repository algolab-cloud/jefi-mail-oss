import { useEffect, useState } from 'react'
import type { DateSuggestion } from '../detect/dates'
import type { MailThread, Message } from '../data'
import type { CalendarEvent, Invite } from '../engine'
import { Icon } from '../icons'
import { useCalendarRevision, useLocalQuery } from '../local-data'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'
import { threadEventsWithLinks } from './actions'
import { LinkAction, Pressable } from './bits'
import { dismiss, dismissalKey, useDismissed } from './dismissals'
import { QuickAddPopover } from './quick-add'
import { useReaderSeams } from './seams'
import { cachedSuggestions, detectForMessage, draftFromSuggestion, eventsForMessage, formatWhen, pickSuggestions, suggestionKey, userTimeZone } from './suggest'

// Under a message's header: its calendar invite, or the dates in it worth adding to the calendar.

/** Stored messages only: outbox and optimistic copies have no invites or links yet. */
const stored = (message: Message) => /-\d+$/.test(message.id) && !message.status && !message.bodyMissing

const inviteCache = new Map<string, Invite[]>()

function useInvites(threadId: string, message: Message): Invite[] | null {
  const { invitesForMessage } = useMailActions()
  const ok = stored(message)
  // A message can be on screen before sync has stored its body, and with it its invites (the newest
  // mail opens as it arrives). So "none" is asked again when the body lands or the calendar changes
  // (an arriving invite is applied as an event); only invites found are kept for good.
  const rev = useCalendarRevision()
  const body = message.paragraphs.length + (message.html?.length ?? 0)
  const [value, setValue] = useState<{ id: string; invites: Invite[] } | null>(null)
  useEffect(() => {
    if (!ok || inviteCache.get(message.id)?.length) return
    let current = true
    void invitesForMessage(threadId, message.id).then((invites) => {
      inviteCache.set(message.id, invites)
      if (current) setValue({ id: message.id, invites })
    })
    return () => {
      current = false
    }
  }, [threadId, message.id, ok, rev, body])
  if (!ok) return []
  return inviteCache.get(message.id) ?? (value?.id === message.id ? value.invites : null)
}

/** Detected dates, worked out after the header has drawn and remembered per message. */
function useDetected(message: Message, subject: string): DateSuggestion[] | null {
  const [value, setValue] = useState<{ id: string; found: DateSuggestion[] } | null>(null)
  const cached = cachedSuggestions(message)
  useEffect(() => {
    if (cached) return
    const handle = setTimeout(() => setValue({ id: message.id, found: detectForMessage(message, subject) }), 0)
    return () => clearTimeout(handle)
  }, [message, subject, cached])
  return cached ?? (value?.id === message.id ? value.found : null)
}

/** What the calendar pieces under a message take from its conversation. */
export type ThreadRef = Pick<MailThread, 'id' | 'subject'>

function useMessageEvents(thread: ThreadRef, message: Message): CalendarEvent[] {
  const { accountOf, eventLinks } = useMailActions()
  const accountId = accountOf(thread.id).id
  const events = useLocalQuery('calendar', `message\u0000${accountId}\u0000${thread.id}\u0000${message.id}`, async (engine) =>
    eventsForMessage(await threadEventsWithLinks(await engine.eventsForThread(accountId, thread.id), eventLinks), message.id),
  )
  return events ?? []
}

export function MessageCalendar({ thread, message }: { thread: ThreadRef; message: Message }) {
  const invites = useInvites(thread.id, message)
  const seams = useReaderSeams()
  if (invites === null) return null
  if (invites.length) {
    return seams.renderInvite ? <>{seams.renderInvite({ thread, message, invites })}</> : <InvitePlaceholder invites={invites} />
  }
  return <SuggestionStrip thread={thread} message={message} />
}

/** TODO(invites): replaced by <InviteCard> through ReaderCalendarSeams.renderInvite. */
function InvitePlaceholder({ invites }: { invites: Invite[] }) {
  const { C } = useSettings()
  return (
    <div testId="invite-placeholder" style={{ marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="calendar" size={14} color={C.muted} />
      <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>{invites[0]!.method === 'CANCEL' ? 'Calendar cancellation' : 'Calendar invitation'}</text>
    </div>
  )
}

function SuggestionStrip({ thread, message }: { thread: ThreadRef; message: Message }) {
  const { C } = useSettings()
  const seams = useReaderSeams()
  const { notify } = useMailActions()
  const detected = useDetected(message, thread.subject)
  const key = dismissalKey(message)
  const dismissed = useDismissed(key)
  const linked = useMessageEvents(thread, message)
  const [open, setOpen] = useState<string | null>(null)
  // Rows added from here this session, so the right row says "Added" even after editing its time.
  const [added, setAdded] = useState<Record<string, string>>({})
  if (!detected) return null
  const shown = pickSuggestions({ message, detected, now: Date.now(), hasInvite: false, dismissed })
  if (!shown.length) return null
  const timeZone = userTimeZone()
  const eventFor = (s: DateSuggestion) => {
    const byRow = added[suggestionKey(s)]
    return linked.find((e) => e.id === byRow) ?? linked.find((e) => (s.allDay ? e.allDay && Math.abs(e.startAt - s.start) < 86_400_000 : e.startAt === s.start))
  }
  const openEvent = (event: CalendarEvent) => (seams.openEvent ? seams.openEvent(event) : notify(`“${event.title}” · ${formatWhen({ start: event.startAt, end: event.endAt, allDay: event.allDay }, event.allDay ? 'UTC' : timeZone)}`))
  return (
    <div
      testId={`date-suggestions-${message.id}`}
      style={{ marginTop: 10, paddingTop: 4, paddingBottom: 4, paddingLeft: 10, paddingRight: 4, borderRadius: 8, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
    >
      <div style={{ height: 28, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <Icon name="calendar" size={14} color={C.accent} />
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {shown.map((s) => {
          const rowKey = suggestionKey(s)
          const event = eventFor(s)
          return (
            <div key={rowKey} testId={`date-suggestion-${rowKey}`} style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <text style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatWhen(s, timeZone)}</text>
              {s.title ? <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 }}>{s.title}</text> : null}
              <div style={{ flexGrow: 1 }} />
              {event ? (
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                  <Icon name="check" size={13} color={C.green} />
                  <text style={{ fontSize: 12.5, fontWeight: 500, color: C.green, fontFamily: FONT, marginLeft: 3 }}>Added</text>
                  <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, marginLeft: 2 }}>·</text>
                  <LinkAction label="Open" testId={`date-suggestion-open-${rowKey}`} onPress={() => openEvent(event)} />
                </div>
              ) : (
                <div style={{ flexShrink: 0 }}>
                  <LinkAction label="Add to calendar" testId={`date-suggestion-add-${rowKey}`} onPress={() => setOpen(open === rowKey ? null : rowKey)} />
                  {open === rowKey ? (
                    <QuickAddPopover
                      initial={draftFromSuggestion(s, thread.subject, timeZone)}
                      threadId={thread.id}
                      messageId={message.id}
                      onClose={() => setOpen(null)}
                      onAdded={(created) => {
                        setAdded((prev) => ({ ...prev, [rowKey]: created.id }))
                        setOpen(null)
                      }}
                    />
                  ) : null}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <Pressable
        label="Dismiss date suggestions"
        testId={`date-suggestions-dismiss-${message.id}`}
        onPress={() => dismiss(key)}
        style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, hover: { backgroundColor: C.overlayStrong } }}
      >
        <div style={{ pointerEvents: 'none', display: 'flex' }}><Icon name="x" size={13} color={C.muted} /></div>
      </Pressable>
    </div>
  )
}
