import { memo, useRef, useState } from 'react'
import type { Calendar } from '../engine'
import { FONT, useSettings } from '../theme'
import { Icon, IconButton } from '../icons'
import { useCalendars } from '../local-data'
import { useMailActions } from '../store'
import { Menu, MenuItem, MenuSeparator } from '../ui'
import { CALENDAR_COLORS, solid } from './format'

// ---------------------------------------------------------------------------
// The calendars in the rail: a coloured check to show or hide each, a menu to rename, recolour,
// make default or delete, and a row to add another.
// ---------------------------------------------------------------------------

export const CalendarList = memo(function CalendarList() {
  const { C } = useSettings()
  const calendars = useCalendars()
  const { createCalendar } = useMailActions()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  // Enter and the blur that follows it both finish the field: only the first one adds.
  const finished = useRef(false)
  const add = async (text = name) => {
    if (finished.current) return
    finished.current = true
    const trimmed = text.trim()
    setAdding(false)
    setName('')
    if (!trimmed) return
    const used = new Set(calendars.map((c) => c.color.toUpperCase()))
    await createCalendar({ name: trimmed, color: CALENDAR_COLORS.find((c) => !used.has(c)) ?? CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length]! })
  }
  const locals = calendars.filter((c) => c.source === 'local').length
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 6 }}>
        <text style={{ flexGrow: 1, fontSize: 12, fontWeight: 600, color: C.muted, fontFamily: FONT }}>Calendars</text>
        <IconButton icon="plus" size={14} pad={24} tooltip="New calendar" onClick={() => ((finished.current = false), setAdding(true))} testId="calendar-add" />
      </div>
      {calendars.map((calendar) => (
        <CalendarRow key={calendar.id} calendar={calendar} deletable={calendar.source !== 'local' || locals > 1} />
      ))}
      <TasksRow />
      {adding ? (
        <div style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 6, borderRadius: 8, backgroundColor: C.overlay }}>
          <div style={{ width: 14, height: 14, borderRadius: 4, borderWidth: 1.5, borderColor: C.ghost }} />
          <input
            testId="calendar-new-name"
            autoFocus
            value={name}
            placeholder="Calendar name"
            onChange={(event) => setName(event.value ?? '')}
            onBlur={() => void add()}
            // Enter on a GPUIX input arrives as submit, never as a keydown; its value is current where
            // \`name\` may still be a keystroke behind.
            onSubmit={(event) => void add(event.value ?? name)}
            onKeyDown={(event) => {
              if (event.key === 'escape') {
                finished.current = true
                setAdding(false)
                setName('')
              }
            }}
            style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: FONT, color: C.text }}
          />
        </div>
      ) : null}
    </div>
  )
})

function CalendarRow({ calendar, deletable }: { calendar: Calendar; deletable: boolean }) {
  const { C } = useSettings()
  const { updateCalendar, deleteCalendar } = useMailActions()
  const [menu, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const setMenu = (next: boolean | ((open: boolean) => boolean)) => {
    setConfirming(false)
    setMenuOpen(next)
  }
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(calendar.name)
  const [hover, setHover] = useState(false)
  const color = solid(calendar.color, C)
  const shown = !calendar.hidden
  const rename = () => {
    setRenaming(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== calendar.name) void updateCalendar(calendar.id, { name: trimmed })
    else setName(calendar.name)
  }
  return (
    <div
      testId={`calendar-${calendar.name}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 4, borderRadius: 8, hover: { backgroundColor: C.overlay } }}
    >
      <div
        testId={`calendar-toggle-${calendar.name}`}
        onClick={() => void updateCalendar(calendar.id, { hidden: shown })}
        style={{ width: 16, height: 16, borderRadius: 5, backgroundColor: shown ? color : undefined, borderWidth: shown ? 0 : 1.5, borderColor: color, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
      >
        {shown ? (
          <div style={{ pointerEvents: 'none', display: 'flex' }}>
            <Icon name="check" size={11} color="#FFFFFF" />
          </div>
        ) : null}
      </div>
      {renaming ? (
        <input
          testId="calendar-rename"
          autoFocus
          value={name}
          onChange={(event) => setName(event.value ?? '')}
          onBlur={rename}
          onSubmit={rename}
          onKeyDown={(event) => {
            if (event.key === 'escape') {
              setName(calendar.name)
              setRenaming(false)
            }
          }}
          style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: FONT, color: C.text }}
        />
      ) : (
        <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, color: shown ? C.text : C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{calendar.name}</text>
      )}
      {calendar.isDefault && !hover && !menu ? <text style={{ fontSize: 11, color: C.ghost, fontFamily: FONT, paddingRight: 6 }}>Default</text> : null}
      <div style={{ position: 'relative', display: 'flex', opacity: hover || menu ? 1 : 0 }}>
        <IconButton icon="more" size={14} pad={24} onClick={() => setMenu((v) => !v)} active={menu} testId={`calendar-menu-${calendar.name}`} />
        <Menu open={menu} onClose={() => setMenu(false)} width={210} align="end">
          {/* Swatches first: recolouring is the most common change. */}
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingLeft: 8, paddingRight: 8, paddingTop: 8, paddingBottom: 6 }}>
            {CALENDAR_COLORS.map((swatch) => {
              const current = swatch.toUpperCase() === calendar.color.toUpperCase()
              return (
                <div
                  key={swatch}
                  testId={`calendar-color-${swatch}`}
                  onClick={() => {
                    setMenu(false)
                    void updateCalendar(calendar.id, { color: swatch })
                  }}
                  style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: swatch, borderWidth: current ? 2 : 0, borderColor: C.raised, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: current ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color: swatch } : undefined }}
                >
                  {current ? (
                    <div style={{ pointerEvents: 'none', display: 'flex' }}>
                      <Icon name="check" size={11} color="#FFFFFF" />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
          <MenuSeparator />
          <MenuItem
            label="Rename"
            icon="pencil"
            onSelect={() => {
              setMenu(false)
              setRenaming(true)
            }}
          />
          <MenuItem label={shown ? 'Hide' : 'Show'} icon={shown ? 'eyeOff' : 'eye'} onSelect={() => (setMenu(false), void updateCalendar(calendar.id, { hidden: shown }))} />
          {calendar.isDefault || !calendar.canWrite ? null : <MenuItem label="Use for new events" icon="check" onSelect={() => (setMenu(false), void updateCalendar(calendar.id, { isDefault: true }))} />}
          {deletable ? (
            <>
              <MenuSeparator />
              {/* Its events go with it, so the first click only asks. */}
              {confirming ? (
                <MenuItem label={`Delete with all its events`} icon="trash" danger testId={`calendar-delete-confirm-${calendar.name}`} onSelect={() => (setMenu(false), void deleteCalendar(calendar.id))} />
              ) : (
                <MenuItem label="Delete calendar…" icon="trash" danger testId={`calendar-delete-${calendar.name}`} onSelect={() => setConfirming(true)} />
              )}
            </>
          ) : null}
        </Menu>
      </div>
    </div>
  )
}

/** Tasks with a due date, drawn on a Tasks calendar of their own; the check shows or hides them (a setting). */
function TasksRow() {
  const { C, settings, update } = useSettings()
  const shown = settings.calendarShowsTasks
  const color = solid(C.accent, C)
  return (
    <div testId="calendar-Tasks" style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 4, borderRadius: 8, hover: { backgroundColor: C.overlay } }}>
      <div
        testId="calendar-toggle-Tasks"
        onClick={() => update({ calendarShowsTasks: !shown })}
        style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: shown ? color : undefined, borderWidth: shown ? 0 : 1.5, borderColor: color, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
      >
        {shown ? (
          <div style={{ pointerEvents: 'none', display: 'flex' }}>
            <Icon name="check" size={11} color="#FFFFFF" />
          </div>
        ) : null}
      </div>
      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, color: C.text, fontFamily: FONT }}>Tasks</text>
      <text style={{ fontSize: 11.5, color: C.ghost, fontFamily: FONT, paddingRight: 6 }}>Due dates</text>
    </div>
  )
}
