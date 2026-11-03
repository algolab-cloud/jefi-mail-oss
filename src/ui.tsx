import { useState, type ReactNode } from 'react'
import { FONT, mixHex, THEMES, useSettings } from './theme'
import { Icon, type IconName } from './icons'
import { useOverlay } from './overlays'

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** A popover anchored to its parent element. Clicking outside closes it. */
export function Menu({
  open,
  onClose,
  children,
  side = 'bottom',
  align = 'start',
  width = 220,
  testId,
  position,
}: {
  /** Open at this window point (a context menu) instead of beside the parent. */
  position?: { x: number; y: number }
  open: boolean
  onClose: () => void
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number
  testId?: string
}) {
  const { C } = useSettings()
  useOverlay(open)
  if (!open) return null
  return (
    <anchored {...(position ? { position, anchor: 'topLeft' as const } : { side, align, gap: 6 })} fit="snap" deferred priority={2} occlude style={{ backgroundColor: C.raised, borderRadius: 12 }}>
      <div
        testId={testId}
        onMouseDownOutside={onClose}
        style={{
          width,
          borderRadius: 12,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 6, blurRadius: 20, spreadRadius: 0, color: '#00000055' },
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </anchored>
  )
}

export function MenuItem({
  label,
  icon,
  onSelect,
  checked,
  hint,
  danger,
  dot,
  testId,
  leading,
}: {
  label: string
  icon?: IconName
  onSelect: () => void
  checked?: boolean
  hint?: string
  danger?: boolean
  dot?: string
  testId?: string
  leading?: ReactNode
}) {
  const { C } = useSettings()
  const color = danger ? C.accent : C.text
  return (
    <div
      testId={testId}
      onClick={onSelect}
      style={{
        minHeight: 30,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        cursor: 'pointer',
        hover: { backgroundColor: C.overlayStrong },
      }}
    >
      {leading}
      {dot ? <div style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: dot, marginLeft: 3, marginRight: 2, pointerEvents: 'none' }} /> : null}
      {icon ? <Icon name={icon} size={15} color={danger ? C.accent : C.secondary} /> : null}
      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, color, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
        {label}
      </text>
      {hint ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, flexShrink: 0 }}>{hint}</text> : null}
      {checked ? <Icon name="check" size={14} color={C.accent} /> : null}
    </div>
  )
}

export function MenuLabel({ children }: { children: string }) {
  const { C } = useSettings()
  return (
    <div style={{ paddingLeft: 8, paddingTop: 5, paddingBottom: 4 }}>
      <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted, fontFamily: FONT }}>{children}</text>
    </div>
  )
}

export function MenuSeparator() {
  const { C } = useSettings()
  return <div style={{ height: 1, backgroundColor: C.divider, marginTop: 4, marginBottom: 4, flexShrink: 0 }} />
}

/** Open/close state for a trigger + Menu pair. */
export function useToggle(initial = false) {
  const [open, setOpen] = useState(initial)
  return { open, toggle: () => setOpen((v) => !v), close: () => setOpen(false), show: () => setOpen(true) }
}

// ---------------------------------------------------------------------------
// Buttons + fields
// ---------------------------------------------------------------------------

export function Button({
  label,
  onClick,
  variant = 'secondary',
  icon,
  disabled,
  testId,
}: {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  icon?: IconName
  disabled?: boolean
  testId?: string
}) {
  const { C } = useSettings()
  const primary = variant === 'primary'
  // Primary is inverted against the surface, like Compose; the accent is kept for unread marks and Send.
  const bg = primary ? C.text : variant === 'secondary' ? C.overlay : undefined
  const fg = primary ? C.onText : variant === 'danger' ? C.accent : C.text
  return (
    <div
      testId={testId}
      onClick={disabled ? undefined : onClick}
      style={{
        height: 32,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: 16,
        backgroundColor: bg,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        flexShrink: 0,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
        hover: disabled ? undefined : { backgroundColor: primary ? mixHex(C.text, C.reading, 0.12) : C.overlayStrong },
        active: disabled ? undefined : { backgroundColor: primary ? mixHex(C.text, C.reading, 0.22) : C.overlayStrong },
      }}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <text style={{ fontSize: 13, fontWeight: 500, color: fg, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <text style={{ fontSize: 12.5, fontWeight: 500, color: C.secondary, fontFamily: FONT }}>{label}</text>
      {children}
      {error ? (
        <text style={{ fontSize: 12, color: C.accent, fontFamily: FONT }}>{error}</text>
      ) : hint ? (
        <text style={{ fontSize: 12, lineHeight: 17, color: C.muted, fontFamily: FONT }}>{hint}</text>
      ) : null}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  testId,
  autoFocus,
  onEnter,
  onKey,
  invalid,
}: {
  /** Any other key (e.g. "up", "down", "escape"), for lists driven from the input. */
  onKey?: (key: string) => void
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
  autoFocus?: boolean
  onEnter?: () => void
  invalid?: boolean
}) {
  const { C } = useSettings()
  return (
    <div
      style={{
        height: 34,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: invalid ? C.accent : 'transparent',
        backgroundColor: C.overlay,
        paddingLeft: 10,
        paddingRight: 10,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <input
        testId={testId}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.value ?? '')}
        // Enter on a GPUIX input arrives as submit, never as a keydown.
        onSubmit={() => onEnter?.()}
        onKeyDown={(event) => {
          if (event.key && event.key !== 'enter') onKey?.(event.key)
        }}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
    </div>
  )
}

/**
 * GPUIX inputs have no password mode, so the field shows bullets and reconstructs the
 * secret from edits at the end of the value (typing, pasting, and backspace).
 */
export function SecretInput({
  value,
  onChange,
  placeholder,
  testId,
  onEnter,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
  onEnter?: () => void
}) {
  const { C } = useSettings()
  const [reveal, setReveal] = useState(false)
  const [key, setKey] = useState(0)
  const shown = reveal ? value : '•'.repeat(value.length)
  return (
    <div
      style={{
        height: 34,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.list,
        paddingLeft: 10,
        paddingRight: 4,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <input
        key={key}
        testId={testId}
        autoFocus={key > 0}
        value={shown}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.value ?? ''
          if (reveal) return onChange(next)
          const kept = next.replace(/•/g, '').length === 0
          if (kept && next.length <= value.length) {
            onChange(value.slice(0, next.length))
          } else {
            // New characters arrive after the bullets; a full replacement arrives without them.
            const bullets = next.match(/^•*/)?.[0].length ?? 0
            onChange(value.slice(0, bullets) + next.slice(bullets))
          }
          setKey((k) => k + 1)
        }}
        onSubmit={() => onEnter?.()}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
      <div
        testId={testId ? `${testId}-reveal` : undefined}
        onClick={() => {
          setReveal((v) => !v)
          setKey((k) => k + 1)
        }}
        style={{
          height: 26,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 5,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          hover: { backgroundColor: C.overlay },
        }}
      >
        <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{reveal ? 'Hide' : 'Show'}</text>
      </div>
    </div>
  )
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  testId?: string
}) {
  const { C } = useSettings()
  return (
    <div style={{ height: 30, padding: 2, borderRadius: 15, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', flexShrink: 0 }}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <div
            key={option.value}
            testId={testId ? `${testId}-${option.value}` : undefined}
            onClick={() => onChange(option.value)}
            style={{
              paddingLeft: 10,
              paddingRight: 10,
              height: 26,
              borderRadius: 13,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              backgroundColor: active ? C.segmentActive : undefined,
              hover: active ? undefined : { backgroundColor: C.overlay },
            }}
          >
            <text style={{ fontSize: 12.5, fontWeight: active ? 500 : 400, color: active ? C.text : C.secondary, fontFamily: FONT }}>
              {option.label}
            </text>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({ children, onClose, width = 560, testId }: { children: ReactNode; onClose: () => void; width?: number; testId?: string }) {
  const { C, settings } = useSettings()
  useOverlay(true)
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#00000073',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onClick={onClose} />
      <div
        testId={testId}
        style={{
          width,
          maxHeight: '90%',
          borderRadius: 16,
          // Solid even in Liquid Glass: a dialog covers the app, which would show through a pane colour.
          backgroundColor: THEMES[settings.theme].reading,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 48, spreadRadius: 0, color: '#00000066' },
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  )
}
