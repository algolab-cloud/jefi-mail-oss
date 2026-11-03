import { motion } from '@gpuix/react'
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FONT, useSettings } from './theme'
import { Icon, type IconName } from './icons'

// ---------------------------------------------------------------------------
// Sonner-style toasts: a global `toast()` API plus a stacked <Toaster />.
// ---------------------------------------------------------------------------

export type ToastKind = 'default' | 'success' | 'error' | 'info' | 'warning' | 'loading'

export type ToastAction = { label: string; onClick: () => void }

export type ToastOptions = {
  id?: string
  description?: string
  action?: ToastAction
  /** Milliseconds; Infinity keeps it until dismissed. Loading toasts never expire. */
  duration?: number
}

type ToastRecord = ToastOptions & {
  id: string
  kind: ToastKind
  title: string
  createdAt: number
  /** Set when dismissed; the record lingers briefly so it can animate out. */
  leaving?: boolean
}

const DEFAULT_DURATION = 4500
/**
 * GPUIX redraws the whole window on every animation frame, so a toast's slide costs as many
 * full-window frames as it lasts: kept short, and a short travel, it still reads as a slide.
 */
const ANIMATION_S = 0.15
const EXIT_MS = 150
const ENTER_FROM = -10
const MAX_VISIBLE = 3

let toasts: ToastRecord[] = []
let seq = 0
const listeners = new Set<() => void>()
const timers = new Map<string, { handle: ReturnType<typeof setTimeout>; endsAt: number; remaining: number }>()
let paused = false

const emit = () => {
  toasts = [...toasts]
  for (const listener of listeners) listener()
}

function schedule(record: ToastRecord) {
  const existing = timers.get(record.id)
  if (existing) clearTimeout(existing.handle)
  timers.delete(record.id)
  const duration = record.kind === 'loading' ? Infinity : (record.duration ?? (record.kind === 'error' ? 7000 : DEFAULT_DURATION))
  if (!Number.isFinite(duration)) return
  if (paused) {
    timers.set(record.id, { handle: setTimeout(() => {}, 0), endsAt: 0, remaining: duration })
    return
  }
  timers.set(record.id, { handle: setTimeout(() => dismiss(record.id), duration), endsAt: Date.now() + duration, remaining: duration })
}

function upsert(kind: ToastKind, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `t${++seq}`
  const index = toasts.findIndex((t) => t.id === id)
  if (index >= 0) {
    const updated: ToastRecord = { ...toasts[index]!, ...options, id, kind, title, leaving: false }
    // Clear fields the update didn't restate, so a loading → success swap drops the old action.
    if (!('action' in options)) delete updated.action
    if (!('description' in options)) delete updated.description
    toasts[index] = updated
    schedule(updated)
  } else {
    const record: ToastRecord = { ...options, id, kind, title, createdAt: Date.now() }
    toasts.push(record)
    schedule(record)
  }
  emit()
  return id
}

export function dismiss(id?: string) {
  const targets = id ? toasts.filter((t) => t.id === id) : toasts
  if (targets.length === 0) return
  for (const t of targets) {
    t.leaving = true
    const timer = timers.get(t.id)
    if (timer) clearTimeout(timer.handle)
    timers.delete(t.id)
  }
  emit()
  setTimeout(() => {
    toasts = toasts.filter((t) => !(t.leaving && targets.some((x) => x.id === t.id)))
    emit()
  }, EXIT_MS)
}

function setPaused(next: boolean) {
  if (paused === next) return
  paused = next
  for (const [id, timer] of timers) {
    clearTimeout(timer.handle)
    if (next) {
      timers.set(id, { ...timer, remaining: timer.endsAt ? Math.max(0, timer.endsAt - Date.now()) : timer.remaining })
    } else {
      const remaining = Math.max(800, timer.remaining)
      timers.set(id, { handle: setTimeout(() => dismiss(id), remaining), endsAt: Date.now() + remaining, remaining })
    }
  }
}

type PromiseMessages<T> = {
  loading: string
  success: string | ((value: T) => string)
  error: string | ((error: unknown) => string)
  description?: string
}

export const toast = Object.assign((title: string, options?: ToastOptions) => upsert('default', title, options), {
  success: (title: string, options?: ToastOptions) => upsert('success', title, options),
  error: (title: string, options?: ToastOptions) => upsert('error', title, options),
  info: (title: string, options?: ToastOptions) => upsert('info', title, options),
  warning: (title: string, options?: ToastOptions) => upsert('warning', title, options),
  loading: (title: string, options?: ToastOptions) => upsert('loading', title, options),
  dismiss,
  promise: <T,>(promise: Promise<T>, messages: PromiseMessages<T>, options?: ToastOptions) => {
    const id = upsert('loading', messages.loading, { ...options, description: messages.description })
    promise.then(
      (value) => upsert('success', typeof messages.success === 'function' ? messages.success(value) : messages.success, { id }),
      (error) => upsert('error', typeof messages.error === 'function' ? messages.error(error) : messages.error, { id }),
    )
    return id
  },
})

function useToasts() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts,
  )
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const WIDTH = 356
const HEIGHT_SINGLE = 52
const HEIGHT_WITH_DESCRIPTION = 70
const GAP = 10
const PEEK = 12

/** Three dots pulsing in turn — GPUIX can't rotate, so this stands in for a spinner. */
export function Spinner({ size = 14, color }: { size?: number; color: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const handle = setInterval(() => setFrame((f) => (f + 1) % 3), 260)
    return () => clearInterval(handle)
  }, [])
  const dot = Math.max(3, Math.round(size / 4.5))
  return (
    <div style={{ width: size, height: size, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: dot / 2, pointerEvents: 'none' }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color, opacity: i === frame ? 1 : 0.3 }} />
      ))}
    </div>
  )
}

const GLYPHS: Partial<Record<ToastKind, { icon?: IconName; text?: string }>> = {
  success: { icon: 'check' },
  error: { icon: 'x' },
  info: { text: 'i' },
  warning: { text: '!' },
}

/** Memoized: a new toast or a dismissal re-renders the stack's positions, not every card's contents. */
const ToastCard = memo(ToastCardView)

function ToastCardView({ record, peek, onHover }: { record: ToastRecord; peek: boolean; onHover: (inside: boolean) => void }) {
  const { C, settings } = useSettings()
  const tone =
    record.kind === 'success' ? '#22A06B' : record.kind === 'error' ? '#E5484D' : record.kind === 'warning' ? '#D97706' : record.kind === 'info' ? '#3E63DD' : C.secondary
  const glyph = GLYPHS[record.kind]
  const surface = settings.theme === 'dark' ? '#1E1E22' : '#FFFFFF'
  return (
    <div
      testId={`toast-${record.id}`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 12,
        backgroundColor: surface,
        borderWidth: 1,
        borderColor: C.overlayStrong,
        boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: settings.theme === 'dark' ? '#00000080' : '#0000001F' },
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 14,
        paddingRight: 8,
        gap: 10,
      }}
    >
      {/* Cards tucked behind the front one show only their edge, like Sonner. Children stay
          mounted and fade, because swapping them out mid-stack left the front card blank. */}
      <div style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, opacity: peek ? 0 : 1 }}>
      {record.kind === 'loading' ? (
        <Spinner size={16} color={C.secondary} />
      ) : glyph ? (
        <div style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: tone, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, pointerEvents: 'none' }}>
          {glyph.icon ? (
            <Icon name={glyph.icon} size={11} color="#FFFFFF" />
          ) : (
            <text style={{ fontSize: 11, fontWeight: 700, color: '#FFFFFF', fontFamily: FONT }}>{glyph.text}</text>
          )}
        </div>
      ) : null}
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: 'none' }}>
        <text style={{ fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{record.title}</text>
        {record.description ? (
          <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{record.description}</text>
        ) : null}
      </div>
      {record.action ? (
        <div
          testId={`toast-action-${record.action.label.toLowerCase().replace(/\s+/g, '-')}`}
          onClick={() => {
            record.action?.onClick()
            dismiss(record.id)
          }}
          style={{
            height: 26,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 6,
            backgroundColor: C.text,
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
            cursor: 'pointer',
            hover: { opacity: 0.85 },
          }}
        >
          <text style={{ fontSize: 12, fontWeight: 600, color: surface, fontFamily: FONT }}>{record.action.label}</text>
        </div>
      ) : null}
      <div
        testId={`toast-close-${record.id}`}
        onClick={() => dismiss(record.id)}
        style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
      >
        <Icon name="x" size={12} color={C.muted} />
      </div>
      </div>
    </div>
  )
}

export function Toaster() {
  const all = useToasts()
  const [expanded, setExpanded] = useState(false)
  // GPUIX delivers enter/leave to the element under the pointer, not its ancestors, so each card
  // reports hover and a short grace period bridges the gaps between expanded cards.
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One identity, so the memoized cards skip the stack's re-renders.
  const onHover = useCallback((inside: boolean) => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current)
    collapseTimer.current = null
    if (inside) {
      setExpanded(true)
      setPaused(true)
    } else {
      collapseTimer.current = setTimeout(() => {
        setExpanded(false)
        setPaused(false)
      }, 160)
    }
  }, [])
  // Newest first; only the front few render, like Sonner's visibleToasts.
  const stack = [...all].reverse().slice(0, MAX_VISIBLE)
  useEffect(() => {
    if (stack.length === 0 && expanded) {
      setExpanded(false)
      setPaused(false)
    }
  }, [stack.length])
  if (stack.length === 0) return null

  const heights = stack.map((t) => (t.description ? HEIGHT_WITH_DESCRIPTION : HEIGHT_SINGLE))
  const expandedHeight = heights.reduce((sum, h) => sum + h, 0) + GAP * (stack.length - 1)
  const collapsedHeight = heights[0]! + PEEK * (stack.length - 1)

  let offset = 0
  const layout = stack.map((record, index) => {
    const height = heights[index]!
    const bottom = expanded ? offset : index * PEEK
    offset += height + GAP
    return { record, index, height, bottom, inset: expanded ? 0 : index * 10 }
  })
  return (
    // Bottom-centre: bottom-right would sit on top of the Send buttons. The full-width strip
    // ignores the pointer so only the cards themselves catch clicks.
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 20, height: expanded ? expandedHeight : collapsedHeight, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
    <div
      testId="toaster"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        position: 'relative',
        width: WIDTH,
        height: expanded ? expandedHeight : collapsedHeight,
        pointerEvents: 'auto',
      }}
    >
      {/* Oldest first so the newest paints on top. */}
      {[...layout].reverse().map(({ record, index, height, bottom, inset }) => {
        return (
          <motion.div
            key={record.id}
            initial={{ bottom: ENTER_FROM, opacity: 0, left: inset, width: WIDTH - inset * 2, height }}
            animate={{
              bottom: record.leaving ? bottom + ENTER_FROM : bottom,
              opacity: record.leaving ? 0 : index === 0 || expanded ? 1 : 1 - index * 0.25,
              left: inset,
              width: WIDTH - inset * 2,
              height: expanded || index === 0 ? height : heights[0]!,
            }}
            transition={{ duration: ANIMATION_S, ease: 'easeOut' }}
            style={{ position: 'absolute' }}
          >
            <ToastCard record={record} peek={!expanded && index > 0} onHover={onHover} />
          </motion.div>
        )
      })}
    </div>
    </div>
  )
}
