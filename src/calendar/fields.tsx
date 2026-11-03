import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FONT, useSettings } from '../theme'
import { Icon, type IconName } from '../icons'
import { findContact, searchContacts } from '../contacts'
import { Face } from '../primitives'
import { useOverlay } from '../overlays'
import { atMinutes, type Weekday } from './dates'
import { EMAIL_RE, addGuests, parseTimeInput } from './draft'
import { mediumDate, timeText } from './format'
import { MiniMonth } from './mini-month'

// ---------------------------------------------------------------------------
// The editor's fields: a day picker, a time field you can type into or pick from, a switch, a
// dropdown, and the guests field with contact suggestions.
// ---------------------------------------------------------------------------

// Open popovers, newest last. Escape closes the newest before whatever it sits in (the editor), so
// dismissing a dropdown doesn't throw away the event being written. Keys go to the newest-registered
// handler first, and a popover's is registered before its sheet's, so the sheet asks here instead.
const openPopovers: Array<() => void> = []

/** Closes the newest open popover; false when none is open. */
export function closePopover(): boolean {
  const close = openPopovers.at(-1)
  close?.()
  return !!close
}

/** A popover under its trigger that closes on an outside click or Escape. */
export function Popover({ open, onClose, children, width, testId, align = 'start' }: { open: boolean; onClose: () => void; children: ReactNode; width: number; testId?: string; align?: 'start' | 'end' }) {
  const { C, settings } = useSettings()
  useOverlay(open)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const entry = () => closeRef.current()
    openPopovers.push(entry)
    return () => void openPopovers.splice(openPopovers.indexOf(entry), 1)
  }, [open])
  if (!open) return null
  return (
    <anchored side="bottom" align={align} gap={6} fit="snap" deferred priority={3} occlude style={{ backgroundColor: C.raised, borderRadius: 12 }}>
      <div
        testId={testId}
        onMouseDownOutside={onClose}
        style={{
          width,
          borderRadius: 12,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: 0, color: settings.theme === 'dark' ? '#00000077' : '#00000026' },
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </anchored>
  )
}

/** The pill every picker trigger shares. */
export function FieldButton({ label, onClick, icon, testId, active, invalid, grow }: { label: string; onClick: () => void; icon?: IconName; testId?: string; active?: boolean; invalid?: boolean; grow?: boolean }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        height: 32,
        paddingLeft: 10,
        paddingRight: icon ? 8 : 10,
        borderRadius: 9,
        backgroundColor: active ? C.overlayStrong : C.overlay,
        borderWidth: 1,
        borderColor: invalid ? C.accent : 'transparent',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexGrow: grow ? 1 : 0,
        flexShrink: 0,
        cursor: 'pointer',
        hover: { backgroundColor: C.overlayStrong },
      }}
    >
      <text style={{ flexGrow: grow ? 1 : 0, fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{label}</text>
      {icon ? (
        <div style={{ pointerEvents: 'none', display: 'flex' }}>
          <Icon name={icon} size={13} color={C.muted} />
        </div>
      ) : null}
    </div>
  )
}

export function DateField({ value, onChange, firstDay, testId, invalid }: { value: number; onChange: (day: number) => void; firstDay: Weekday; testId?: string; invalid?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <FieldButton label={mediumDate(value)} onClick={() => setOpen((v) => !v)} testId={testId} active={open} invalid={invalid} />
      <Popover open={open} onClose={() => setOpen(false)} width={252} testId={testId ? `${testId}-picker` : undefined}>
        <MiniMonth
          value={value}
          firstDay={firstDay}
          dots={false}
          testId={testId ? `${testId}-month` : undefined}
          onPick={(day) => {
            onChange(day)
            setOpen(false)
          }}
        />
      </Popover>
    </div>
  )
}

/**
 * A time you can type ("2pm", "14:30") or pick from a list in half hours. `from` makes the list start
 * there and show how long each choice would make the event.
 */
export function TimeField({ value, onChange, day, from, testId, invalid }: { value: number; onChange: (minutes: number) => void; day: number; from?: number; testId?: string; invalid?: boolean }) {
  const { C } = useSettings()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const shown = text ?? timeText(atMinutes(day, value))
  const commit = (typed: string | null = text) => {
    if (typed === null) return
    const parsed = parseTimeInput(typed)
    if (parsed !== null) onChange(parsed)
    setText(null)
    setKey((k) => k + 1)
  }
  const start = from ?? 0
  const choices = Array.from({ length: 48 }, (_, i) => start + i * 30).filter((m) => (from === undefined ? m < 24 * 60 : m > from && m <= from + 24 * 60))
  const duration = (m: number) => {
    const length = m - (from ?? 0)
    return length < 60 ? `${length} min` : `${Number((length / 60).toFixed(1))} hr`
  }
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <div
        style={{
          width: 96,
          height: 32,
          borderRadius: 9,
          backgroundColor: open ? C.overlayStrong : C.overlay,
          borderWidth: 1,
          borderColor: invalid ? C.accent : 'transparent',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 10,
          paddingRight: 2,
        }}
      >
        <input
          key={key}
          testId={testId}
          value={shown}
          onChange={(event) => setText(event.value ?? '')}
          onBlur={() => commit()}
          // Enter on a GPUIX input arrives as submit, never as a keydown.
          onSubmit={(event) => commit(event.value)}
          onKeyDown={(event) => {
            if (event.key === 'down') setOpen(true)
            else if (event.key === 'escape') setOpen(false)
          }}
          style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 500, fontFamily: FONT, color: C.text }}
        />
        <div
          testId={testId ? `${testId}-menu` : undefined}
          onClick={() => setOpen((v) => !v)}
          style={{ width: 22, height: 26, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
        >
          <div style={{ pointerEvents: 'none', display: 'flex' }}>
            <Icon name="chevronDown" size={12} color={C.muted} />
          </div>
        </div>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} width={from === undefined ? 130 : 170}>
        <div style={{ maxHeight: 240, overflowY: 'scroll', display: 'flex', flexDirection: 'column' }}>
          {choices.map((m) => {
            const current = m % (24 * 60) === value
            return (
              <div
                key={m}
                onClick={() => {
                  onChange(m % (24 * 60))
                  setOpen(false)
                }}
                style={{ height: 28, flexShrink: 0, paddingLeft: 8, paddingRight: 8, borderRadius: 6, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer', backgroundColor: current ? C.overlayStrong : undefined, hover: { backgroundColor: C.overlayStrong } }}
              >
                <text style={{ fontSize: 12.5, fontWeight: current ? 600 : 400, color: C.text, fontFamily: FONT, pointerEvents: 'none' }}>{timeText(atMinutes(day, m % (24 * 60)))}</text>
                {from !== undefined ? <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{duration(m)}</text> : null}
              </div>
            )
          })}
        </div>
      </Popover>
    </div>
  )
}

export function Switch({ on, onChange, label, testId }: { on: boolean; onChange: (on: boolean) => void; label: string; testId?: string }) {
  const { C } = useSettings()
  return (
    <div testId={testId} onClick={() => onChange(!on)} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, cursor: 'pointer', height: 32, paddingRight: 4 }}>
      <div style={{ width: 30, height: 18, borderRadius: 9, backgroundColor: on ? C.accent : C.overlayStrong, padding: 2, display: 'flex', flexDirection: 'row', justifyContent: on ? 'flex-end' : 'flex-start', pointerEvents: 'none' }}>
        <div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#FFFFFF', boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: '#00000040' } }} />
      </div>
      <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}

/** A trigger with a menu of choices. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  testId,
  width = 260,
  grow,
}: {
  value: T
  options: Array<{ value: T; label: string; dot?: string }>
  onChange: (value: T) => void
  testId?: string
  width?: number
  grow?: boolean
}) {
  const { C } = useSettings()
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value) ?? options[0]
  return (
    <div style={{ position: 'relative', display: 'flex', flexGrow: grow ? 1 : 0 }}>
      <div
        testId={testId}
        onClick={() => setOpen((v) => !v)}
        style={{ height: 32, paddingLeft: 10, paddingRight: 8, borderRadius: 8, backgroundColor: open ? C.overlayStrong : C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexGrow: grow ? 1 : 0, cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
      >
        {current?.dot ? <div style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: current.dot, pointerEvents: 'none' }} /> : null}
        <text style={{ flexGrow: 1, fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{current?.label ?? ''}</text>
        <div style={{ pointerEvents: 'none', display: 'flex' }}>
          <Icon name="chevronDown" size={13} color={C.muted} />
        </div>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} width={width}>
        {options.map((option) => (
          <div
            key={option.value}
            testId={testId ? `${testId}-${option.value || 'none'}` : undefined}
            onClick={() => {
              onChange(option.value)
              setOpen(false)
            }}
            style={{ height: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 6, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
          >
            {option.dot ? <div style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: option.dot, pointerEvents: 'none' }} /> : null}
            <text style={{ flexGrow: 1, fontSize: 13, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{option.label}</text>
            {option.value === value ? (
              <div style={{ pointerEvents: 'none', display: 'flex' }}>
                <Icon name="check" size={14} color={C.accent} />
              </div>
            ) : null}
          </div>
        ))}
      </Popover>
    </div>
  )
}

/** Guests as chips, with the people you write to suggested as you type. `onTyping` reports text not yet a chip, so saving can include it. */
export function GuestsField({ value, onChange, onTyping, testId }: { value: string[]; onChange: (emails: string[]) => void; onTyping?: (text: string) => void; testId?: string }) {
  const { C } = useSettings()
  const [input, setInputState] = useState('')
  const [key, setKey] = useState(0)
  const [focused, setFocused] = useState(false)
  const setInput = (text: string) => {
    setInputState(text)
    onTyping?.(text)
  }
  const add = (raw: string) => {
    onChange(addGuests(value, raw, (part) => findContact(part)?.email))
    setInput('')
    setKey((k) => k + 1)
  }
  const suggestions = searchContacts(input, value, 5)
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, minHeight: 32, flexGrow: 1, minWidth: 0 }}>
      {value.map((email) => {
        const contact = findContact(email)
        const valid = EMAIL_RE.test(email)
        return (
          <div key={email} style={{ height: 26, borderRadius: 13, backgroundColor: valid ? C.chip : C.overlay, borderWidth: valid ? 0 : 1, borderColor: C.accent, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 3, paddingRight: 4, gap: 6 }}>
            {contact ? (
              <Face {...contact.face} size={20} />
            ) : (
              <div style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.face, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <text style={{ fontSize: 10, fontWeight: 600, color: C.secondary, fontFamily: FONT }}>{email.slice(0, 1).toUpperCase()}</text>
              </div>
            )}
            <text style={{ fontSize: 12.5, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{contact?.name || email}</text>
            <div
              testId={`guest-remove-${email}`}
              onClick={() => onChange(value.filter((e) => e !== email))}
              style={{ width: 18, height: 18, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
            >
              <div style={{ pointerEvents: 'none', display: 'flex' }}>
                <Icon name="x" size={11} color={C.muted} />
              </div>
            </div>
          </div>
        )
      })}
      <div style={{ position: 'relative', display: 'flex', flexGrow: 1, flexBasis: 0, minWidth: 140 }}>
        <input
          key={key}
          testId={testId}
          autoFocus={key > 0}
          value={input}
          placeholder={value.length ? 'Add another guest' : 'Add guests'}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onChange={(event) => {
            const next = event.value ?? ''
            if (/[,;\s]$/.test(next) && next.trim()) add(next)
            else setInput(next)
          }}
          // Enter on a GPUIX input arrives as submit, never as a keydown.
          onSubmit={(event) => {
            const text = event.value ?? input
            if (text.trim()) add(searchContacts(text, value, 1)[0]?.email ?? text)
          }}
          onKeyDown={(event) => {
            if (event.key === 'tab' && input.trim()) add(suggestions[0]?.email ?? input)
            else if (event.key === 'backspace' && !input && value.length) onChange(value.slice(0, -1))
          }}
          style={{ flexGrow: 1, minWidth: 0, height: 32, fontSize: 13.5, fontFamily: FONT, color: C.text }}
        />
        {focused && suggestions.length ? (
          <anchored side="bottom" align="start" gap={4} fit="snap" deferred priority={3} occlude style={{ backgroundColor: C.raised, borderRadius: 10 }}>
            <div style={{ width: 320, borderRadius: 12, backgroundColor: C.raised, borderWidth: 1, borderColor: C.overlayStrong, boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: '#00000044' }, padding: 4, display: 'flex', flexDirection: 'column' }}>
              {suggestions.map((contact, i) => (
                <div
                  key={contact.email}
                  testId={`guest-suggest-${contact.email}`}
                  onClick={() => add(contact.email)}
                  style={{ height: 40, paddingLeft: 8, paddingRight: 8, borderRadius: 7, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, cursor: 'pointer', backgroundColor: i === 0 ? C.overlay : undefined, hover: { backgroundColor: C.overlayStrong } }}
                >
                  <Face {...contact.face} size={26} />
                  <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
                    <text style={{ fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT }}>{contact.name}</text>
                    <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{contact.email}</text>
                  </div>
                </div>
              ))}
            </div>
          </anchored>
        ) : null}
      </div>
    </div>
  )
}
