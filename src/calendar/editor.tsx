import { motion } from '@gpuix/react'
import { useRef, useState, type ReactNode } from 'react'
import type { SeriesScope } from '../engine'
import { meetingLink, meetingProvider } from '../engine/calendar/meeting'
import { FONT, mixHex, useSettings } from '../theme'
import { Icon, IconButton, type IconName } from '../icons'
import { useKeys } from '../keys'
import { useOverlay } from '../overlays'
import { useCalendars } from '../local-data'
import { useMailActions, useMailSelector } from '../store'
import { toast } from '../toast'
import { findContact } from '../contacts'
import { addDays, atMinutes, startOfDay } from './dates'
import { addGuests, describeRule, draftFromEvent, draftFromPrefill, draftSpan, draftToInput, hasErrors, moveStart, repeatOptions, sendsInvites, validateDraft, type EventDraft } from './draft'
import { DateField, GuestsField, Select, Switch, TimeField, closePopover } from './fields'
import { dayLine, solid, whenText } from './format'
import { alertOptions, decodeAlarms, encodeAlarms } from './alerts'
import { useWeekInfo } from './hooks'
import { inviteSender } from './invites'
import { ScopeChoice } from './event-card'
import { closeEventEditor, setCalendarState, useCalendarState, type EditorState } from './state'

// ---------------------------------------------------------------------------
// The event editor: a sheet over the app for a new event (from the calendar, a keypress, or the
// reader's "Add to calendar" via openEventEditor) or an existing one. Mounted once at the shell.
// ---------------------------------------------------------------------------

/** Mount once inside MailProvider; shows the editor whenever openEventEditor / editOccurrence asks. */
export function EventEditorHost() {
  const editor = useCalendarState((s) => s.editor)
  return editor ? <EventEditor key={editor.key} editor={editor} /> : null
}

function EventEditor({ editor }: { editor: EditorState }) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const calendars = useCalendars()
  const { saveEvent } = useMailActions()
  const mailAccount = useMailSelector((s) => (s.hasAccounts ? s.account.id : null), (a, b) => a === b)
  const { firstDay } = useWeekInfo()
  const writable = calendars.filter((c) => c.canWrite)
  const fallback = writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? 'local'
  const existing = editor.occurrence
  const [draft, setDraft] = useState<EventDraft>(() =>
    existing ? draftFromEvent(existing) : draftFromPrefill(editor.prefill, { calendarId: editor.prefill.calendarId && writable.some((c) => c.id === editor.prefill.calendarId) ? editor.prefill.calendarId : fallback, now: Date.now() }),
  )
  // The latest draft, for saving: React state only flushes when a frame pumps, so a save on the key
  // that follows typing would otherwise read the draft from before the last keystrokes.
  const latest = useRef(draft)
  const update = (change: (d: EventDraft) => EventDraft) => {
    latest.current = change(latest.current)
    setDraft(latest.current)
  }
  const set = (patch: Partial<EventDraft>) => update((d) => ({ ...d, ...patch }))
  // An address typed into Guests but not yet made a chip; saving includes it rather than dropping it.
  const guestText = useRef('')
  const [guestsKey, setGuestsKey] = useState(0)
  const [tried, setTried] = useState(false)
  const [askScope, setAskScope] = useState(false)
  const [saving, setSaving] = useState(false)
  // Saving is async; a second Enter (or ⌘↩ with a click) before it lands must not save twice.
  const busy = useRef(false)
  const errors = validateDraft(draft)
  const shownErrors = tried ? errors : { end: errors.end }
  useOverlay(true)

  const series = !!existing && (existing.recurring || !!existing.recurringMasterId)
  const sender = inviteSender()
  const invites = sendsInvites(draft) && !!sender

  const save = async (scope?: SeriesScope) => {
    setTried(true)
    if (busy.current) return
    if (guestText.current.trim()) {
      set({ attendees: addGuests(latest.current.attendees, guestText.current, (part) => findContact(part)?.email) })
      guestText.current = ''
      setGuestsKey((k) => k + 1)
    }
    const current = latest.current
    if (hasErrors(validateDraft(current))) return
    if (existing?.recurring && !scope) return setAskScope(true)
    busy.current = true
    setSaving(true)
    const input = draftToInput(current, existing?.id)
    // Invitations go out from an account: the one the mail it came from is in, else the one being read.
    const sending = sendsInvites(current) && !!sender
    if (sending && !existing?.accountId) input.accountId = current.link?.accountId ?? mailAccount
    // Editing through an occurrence: the times are this occurrence's; 'all' shifts the series with it.
    const options = existing?.recurring ? { scope: scope ?? 'all', occurrenceStart: existing.occurrenceStart } : undefined
    const saved = await saveEvent(input, options).finally(() => {
      busy.current = false
      setSaving(false)
    })
    if (!saved) return
    closeEventEditor()
    // A new event is shown where it landed: at 23:45 on the last day of the week the next free slot
    // is next week, and the event seemed to vanish. Only the calendar's own position moves, so an
    // event added from a message doesn't take the person away from their mail.
    setCalendarState(existing ? { selected: null } : { selected: null, cursor: draftSpan(current).start })
    // TODO(invites): the iTIP work registers a sender (./invites); this is where invitations go out.
    if (sending) void sender!(saved, 'request').catch((error) => toast.error('Couldn’t send the invitations', { description: error instanceof Error ? error.message : String(error) }))
    if (!existing) toast.success(current.link ? 'Added to your calendar' : 'Event created', { description: `${dayLine(draftSpan(current).start)} · ${whenText(saved)}` })
  }

  useKeys((press) => {
    const key = press.key?.toLowerCase()
    if (key === 'escape') {
      // A dropdown or date picker first, then the scope question, then the sheet.
      if (closePopover()) return true
      if (askScope) setAskScope(false)
      else closeEventEditor()
      return true
    }
    if (key === 'enter' && (press.modifiers?.cmd || press.modifiers?.ctrl)) {
      void save()
      return true
    }
    // Everything else belongs to the fields (and nothing behind the sheet should act on it).
    return true
  })

  const calendar = calendars.find((c) => c.id === draft.calendarId)
  const color = solid(calendar?.color ?? C.accent, C)
  const repeats = repeatOptions(draft.startDay)
  const customRule = draft.recurrence && !repeats.some((r) => r.rule === draft.recurrence)
  const multiDay = draft.endDay !== draft.startDay
  // An exception can't carry its own rule, and 'this'-scoped edits drop it.
  const canRepeat = !existing?.recurringMasterId
  const meeting = meetingProvider(meetingLink(draft.url))

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#00000080' : '#0000004A' }}
        onClick={closeEventEditor}
      />
      <motion.div initial={{ opacity: 0, top: 10 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div
          testId="event-editor"
          style={{
            width: 600,
            borderRadius: 16,
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.overlayStrong,
            boxShadow: { offsetX: 0, offsetY: 24, blurRadius: 64, spreadRadius: 0, color: dark ? '#00000099' : '#00000038' },
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Title, on a wash of the calendar's colour. */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 20, paddingLeft: 24, paddingRight: 14, paddingBottom: 14 }}>
            <div style={{ width: 6, height: 30, borderRadius: 3, backgroundColor: color }} />
            <input
              testId="event-title"
              autoFocus={!existing}
              value={draft.title}
              placeholder="Add a title"
              onChange={(event) => set({ title: event.value ?? '' })}
              // Enter on a GPUIX input arrives as submit, never as a keydown (⌘↩ is the sheet's key).
              onSubmit={(event) => {
                if (event.value !== undefined) set({ title: event.value })
                void save()
              }}
              style={{ flexGrow: 1, minWidth: 0, fontSize: 21, fontWeight: 600, fontFamily: FONT, color: C.text }}
            />
            <IconButton icon="x" size={16} pad={30} tooltip="Close" onClick={closeEventEditor} testId="event-editor-close" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 24, paddingRight: 24, paddingBottom: 20 }}>
            <Line icon="clock">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <DateField value={draft.startDay} firstDay={firstDay} testId="event-start-day" onChange={(day) => update((d) => moveStart(d, { startDay: day }))} />
                  {draft.allDay ? null : <TimeField value={draft.startMinutes} day={draft.startDay} testId="event-start-time" onChange={(m) => update((d) => moveStart(d, { startMinutes: m }))} />}
                  <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT, paddingLeft: 2, paddingRight: 2 }}>–</text>
                  {draft.allDay ? null : (
                    <TimeField
                      value={draft.endMinutes}
                      day={draft.endDay}
                      // A same-day end lists times after the start, with how long each would be.
                      from={multiDay ? undefined : draft.startMinutes}
                      testId="event-end-time"
                      invalid={!!shownErrors.end}
                      onChange={(m) => update((d) => ({ ...d, endMinutes: m, endDay: d.endDay === d.startDay && m <= d.startMinutes ? addDays(d.startDay, 1) : d.endDay }))}
                    />
                  )}
                  {draft.allDay || multiDay ? <DateField value={draft.endDay} firstDay={firstDay} testId="event-end-day" invalid={!!shownErrors.end} onChange={(day) => set({ endDay: day })} /> : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <Switch
                    on={draft.allDay}
                    label="All day"
                    testId="event-all-day"
                    onChange={(allDay) =>
                      update((d) =>
                        allDay
                          ? { ...d, allDay, endDay: Math.max(d.startDay, startOfDay(atMinutes(d.endDay, d.endMinutes) - 1)), alarms: null }
                          : { ...d, allDay, endDay: d.startDay, startMinutes: 9 * 60, endMinutes: 10 * 60, alarms: null },
                      )
                    }
                  />
                  {!draft.allDay && !multiDay ? (
                    <text testId="event-add-end-day" onClick={() => update((d) => ({ ...d, endDay: addDays(d.startDay, 1) }))} style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, cursor: 'pointer', hover: { color: C.text } }}>
                      Ends another day
                    </text>
                  ) : null}
                </div>
                {shownErrors.end ? <ErrorText>{shownErrors.end}</ErrorText> : null}
              </div>
            </Line>

            {canRepeat ? (
              <Line icon="repeat">
                <Select
                  value={draft.recurrence}
                  testId="event-repeat"
                  options={[...repeats.map((r) => ({ value: r.rule, label: r.label })), ...(customRule ? [{ value: draft.recurrence, label: describeRule(draft.recurrence, draft.startDay) }] : [])]}
                  onChange={(recurrence) => set({ recurrence })}
                />
              </Line>
            ) : null}

            <Line icon="bell">
              <Select
                value={encodeAlarms(draft.alarms)}
                testId="event-alert"
                options={alertOptions(draft.alarms, draft.allDay, draft.allDay ? settings.defaultAllDayAlert : settings.defaultAlert)}
                onChange={(value) => set({ alarms: decodeAlarms(value) })}
              />
            </Line>

            <Line icon="calendar">
              <Select
                value={draft.calendarId}
                testId="event-calendar"
                width={220}
                options={writable.map((c) => ({ value: c.id, label: c.name, dot: solid(c.color, C) }))}
                onChange={(calendarId) => set({ calendarId })}
              />
            </Line>

            <Line icon="mapPin">
              <Box>
                <input testId="event-location" value={draft.location} placeholder="Add a place or a link" onChange={(event) => set({ location: event.value ?? '' })} style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }} />
              </Box>
            </Line>

            <Line icon="video">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexGrow: 1, minWidth: 0 }}>
                <Box>
                  <input testId="event-meeting" value={draft.url} placeholder="Add a Zoom, Meet or Teams link" onChange={(event) => set({ url: event.value ?? '' })} style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }} />
                  {meeting ? (
                    <text testId="event-meeting-provider" style={{ flexShrink: 0, paddingLeft: 8, fontSize: 12, fontWeight: 600, color: C.accent, fontFamily: FONT, whiteSpace: 'nowrap' }}>
                      {meeting.label}
                    </text>
                  ) : null}
                </Box>
                {shownErrors.url ? <ErrorText>{shownErrors.url}</ErrorText> : null}
              </div>
            </Line>

            <Line icon="users">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexGrow: 1, minWidth: 0 }}>
                <Box tall>
                  <GuestsField key={guestsKey} value={draft.attendees} testId="event-guests" onChange={(attendees) => set({ attendees })} onTyping={(text) => void (guestText.current = text)} />
                </Box>
                {shownErrors.attendees ? <ErrorText>{shownErrors.attendees}</ErrorText> : null}
                {draft.attendees.length > 0 && !sender ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>Guests are saved with the event. Sending invitations by email is coming soon.</text> : null}
              </div>
            </Line>

            <Line icon="alignLeft">
              <Box tall>
                <textarea
                  testId="event-description"
                  value={draft.description}
                  placeholder="Add a description"
                  minRows={2}
                  maxRows={6}
                  onChange={(event) => set({ description: event.value ?? '' })}
                  style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, lineHeight: 20, fontFamily: FONT, color: C.text, paddingTop: 6, paddingBottom: 6 }}
                />
              </Box>
            </Line>

            {draft.link ? (
              <Line icon="mail">
                <div style={{ height: 32, display: 'flex', alignItems: 'center' }}>
                  <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>Linked to the email it came from</text>
                </div>
              </Line>
            ) : null}
          </div>

          {askScope ? (
            <div testId="event-editor-scope" style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 10, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderTopWidth: 1, borderColor: C.overlay }}>
              <text style={{ fontSize: 12.5, fontWeight: 600, color: C.secondary, fontFamily: FONT, paddingLeft: 10, paddingBottom: 4 }}>This is a repeating event. Change…</text>
              <ScopeChoice label="Only this event" onSelect={() => void save('this')} testId="save-this" />
              <ScopeChoice label="This and following events" onSelect={() => void save('following')} testId="save-following" />
              <ScopeChoice label="All events in the series" onSelect={() => void save('all')} testId="save-all" />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, paddingBottom: 14, paddingLeft: 24, paddingRight: 16, borderTopWidth: 1, borderColor: C.overlay }}>
              <text style={{ flexGrow: 1, fontSize: 12, color: C.muted, fontFamily: FONT }}>{series ? 'Part of a repeating series' : '⌘↩ to save · Esc to close'}</text>
              <div testId="event-cancel" onClick={closeEventEditor} style={{ height: 34, paddingLeft: 14, paddingRight: 14, borderRadius: 17, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}>
                <text style={{ fontSize: 13.5, fontWeight: 500, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>Cancel</text>
              </div>
              <div
                testId="event-save"
                onClick={() => void save()}
                style={{
                  height: 34,
                  paddingLeft: 18,
                  paddingRight: 18,
                  borderRadius: 17,
                  backgroundColor: C.text,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  opacity: saving ? 0.6 : 1,
                  hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) },
                  active: { backgroundColor: mixHex(C.text, C.reading, 0.22) },
                }}
              >
                <text style={{ fontSize: 13.5, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none' }}>{invites ? 'Save and send invites' : existing ? 'Save' : 'Create event'}</text>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}

function Line({ icon, children }: { icon: IconName; children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
      <div style={{ width: 18, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={16} color={C.muted} />
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}

function Box({ children, tall }: { children: ReactNode; tall?: boolean }) {
  const { C } = useSettings()
  return (
    <div style={{ minHeight: 32, height: tall ? undefined : 32, borderRadius: 8, backgroundColor: C.overlay, paddingLeft: 10, paddingRight: 10, paddingTop: tall ? 2 : 0, paddingBottom: tall ? 2 : 0, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      {children}
    </div>
  )
}

function ErrorText({ children }: { children: string }) {
  const { C } = useSettings()
  return <text style={{ fontSize: 12, color: C.accent, fontFamily: FONT }}>{children}</text>
}

