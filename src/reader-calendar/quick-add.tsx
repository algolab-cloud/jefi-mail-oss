import { useRef, useState } from 'react'
import type { CalendarEvent } from '../engine'
import { useCalendars } from '../local-data'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'
import { useOverlay } from '../overlays'
import { Button, TextInput } from '../ui'
import { quickAddEvent } from './actions'
import { Pressable } from './bits'
import { useReaderSeams } from './seams'
import { eventFromDraft, userTimeZone, type QuickAddDraft } from './suggest'

/**
 * The compact "Add to calendar" form beside a suggestion: title, when, which calendar. The full
 * editor (recurrence, location, people) is the calendar's; "More options…" hands over to it.
 */
export function QuickAddPopover({ initial, threadId, messageId, onClose, onAdded }: { initial: QuickAddDraft; threadId: string; messageId: string; onClose: () => void; onAdded: (event: CalendarEvent) => void }) {
  const { C } = useSettings()
  const actions = useMailActions()
  const calendars = useCalendars().filter((c) => c.canWrite)
  const seams = useReaderSeams()
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useOverlay(true)
  const set = (patch: Partial<QuickAddDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setError(null)
  }
  const calendarId = draft.calendarId ?? calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id ?? null
  // A ref, not the state: two Enters before a frame would both see `saving` false and add twice.
  const busy = useRef(false)
  const add = async () => {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    const result = await quickAddEvent(actions, { ...draft, calendarId }, threadId, messageId).finally(() => {
      busy.current = false
      setSaving(false)
    })
    if (!result.ok) return setError(result.error)
    actions.notify(`Added “${result.event.title}” to your calendar`)
    onAdded(result.event)
  }
  const more = () => {
    const built = eventFromDraft({ ...draft, calendarId }, actions.messageTarget(threadId, messageId), userTimeZone())
    if (!built.ok) return setError(built.error)
    onClose()
    seams.openEventEditor?.(built.input)
  }
  const onKey = (key: string) => {
    if (key === 'escape') onClose()
  }
  const label = (text: string) => <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted, fontFamily: FONT }}>{text}</text>
  return (
    <anchored side="bottom" align="end" gap={6} fit="snap" deferred priority={2} occlude style={{ backgroundColor: C.raised, borderRadius: 12 }}>
      <div
        testId="quick-add"
        onMouseDownOutside={onClose}
        style={{
          width: 340,
          borderRadius: 12,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: '#00000055' },
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>Add to calendar</text>
        <TextInput value={draft.title} onChange={(title) => set({ title })} placeholder="Title" testId="quick-add-title" autoFocus onEnter={() => void add()} onKey={onKey} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
            <div style={{ flexGrow: 1 }}>{label(draft.allDay ? 'Dates' : 'When')}</div>
            <Pressable
              label="All day"
              testId="quick-add-all-day"
              onPress={() => set({ allDay: !draft.allDay })}
              style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, height: 20, paddingLeft: 4, paddingRight: 4, borderRadius: 5, hover: { backgroundColor: C.overlay } }}
            >
              <div style={{ width: 13, height: 13, borderRadius: 3.5, borderWidth: 1, borderColor: draft.allDay ? C.accent : C.ghost, backgroundColor: draft.allDay ? C.accent : undefined, pointerEvents: 'none' }} />
              <text style={{ fontSize: 12, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>All day</text>
            </Pressable>
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 118, flexShrink: 0 }}>
              <TextInput value={draft.date} onChange={(date) => set({ date })} placeholder="2026-10-03" testId="quick-add-date" onEnter={() => void add()} onKey={onKey} />
            </div>
            {draft.allDay ? (
              <>
                <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>to</text>
                <div style={{ width: 118, flexShrink: 0 }}>
                  <TextInput value={draft.endDate} onChange={(endDate) => set({ endDate })} placeholder="2026-10-05" testId="quick-add-end-date" onEnter={() => void add()} onKey={onKey} />
                </div>
              </>
            ) : (
              <>
                <div style={{ width: 70, flexShrink: 0 }}>
                  <TextInput value={draft.startTime} onChange={(startTime) => set({ startTime })} placeholder="15:00" testId="quick-add-start" onEnter={() => void add()} onKey={onKey} />
                </div>
                <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>–</text>
                <div style={{ width: 70, flexShrink: 0 }}>
                  <TextInput value={draft.endTime} onChange={(endTime) => set({ endTime })} placeholder="16:00" testId="quick-add-end" onEnter={() => void add()} onKey={onKey} />
                </div>
              </>
            )}
          </div>
        </div>
        {calendars.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {label('Calendar')}
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {calendars.map((calendar) => {
                const selected = calendar.id === calendarId
                return (
                  <Pressable
                    key={calendar.id}
                    label={calendar.name}
                    testId={`quick-add-calendar-${calendar.id}`}
                    onPress={() => set({ calendarId: calendar.id })}
                    style={{
                      height: 24,
                      paddingLeft: 8,
                      paddingRight: 9,
                      borderRadius: 12,
                      backgroundColor: selected ? C.overlayStrong : C.overlay,
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      hover: { backgroundColor: C.overlayStrong },
                    }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: calendar.color, pointerEvents: 'none' }} />
                    <text style={{ fontSize: 12, color: selected ? C.text : C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>{calendar.name}</text>
                  </Pressable>
                )
              })}
            </div>
          </div>
        ) : null}
        {error ? <text testId="quick-add-error" style={{ fontSize: 12, color: C.accent, fontFamily: FONT }}>{error}</text> : null}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {seams.openEventEditor ? (
            <Pressable label="More options" testId="quick-add-more" onPress={more} style={{ height: 24, paddingLeft: 4, paddingRight: 4, borderRadius: 5, display: 'flex', alignItems: 'center', hover: { backgroundColor: C.overlay } }}>
              <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>More options…</text>
            </Pressable>
          ) : null}
          <div style={{ flexGrow: 1 }} />
          <Button label="Cancel" variant="ghost" onClick={onClose} testId="quick-add-cancel" />
          <Button label={saving ? 'Adding…' : 'Add'} variant="primary" disabled={saving} onClick={() => void add()} testId="quick-add-save" />
        </div>
      </div>
    </anchored>
  )
}
