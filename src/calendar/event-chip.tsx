import type { ReactNode } from 'react'
import type { Calendar, EventOccurrence } from '../engine'
import { FONT, mixHex, THEMES, useSettings } from '../theme'
import { eventTint, timeText } from './format'
import { BidiText, hasRtl } from '../bidi-text'

// ---------------------------------------------------------------------------
// How an event looks wherever it's drawn: a block on the time grid, a bar across days, a line in a
// month cell. All take their colour from the calendar, dim once they're over, and invert when
// selected so the card's owner is obvious.
// ---------------------------------------------------------------------------

type Tint = ReturnType<typeof eventTint>

function useTint(calendar: Calendar | undefined, past: boolean): Tint {
  const { C, settings } = useSettings()
  return eventTint(calendar?.color ?? C.accent, C, settings.theme === 'dark', { past })
}

/**
 * Event cards are glass: a thin veil of the calendar's colour, a frosted hairline edge, and the
 * everyday text colours. Selecting one deepens the veil and colours the edge. The veil is mixed into
 * the page colour rather than laid over it, so the grid's lines stay behind the card.
 */
function useGlass(tint: Tint, selected: boolean, past: boolean) {
  const { C, settings } = useSettings()
  const base = tint.edge.slice(0, 7)
  const page = THEMES[settings.theme].reading
  return {
    fill: mixHex(page, base, selected ? 0.28 : past ? 0.08 : 0.14),
    hover: mixHex(page, base, 0.2),
    edge: selected ? `${base}B3` : settings.theme === 'dark' ? '#FFFFFF14' : '#0000000F',
    title: past ? C.muted : C.text,
    sub: past ? C.ghost : C.secondary,
  }
}

/** A timed event on the grid. Tall enough, it shows its time and place under the title. */
export function TimeBlock({
  occurrence: o,
  calendar,
  height,
  past,
  selected,
  ghost,
  timeLabel,
  onMouseDown,
  onMouseUp,
  onResizeDown,
  testId,
}: {
  occurrence: Pick<EventOccurrence, 'title' | 'startAt' | 'endAt' | 'location' | 'status'>
  calendar: Calendar | undefined
  height: number
  past: boolean
  selected: boolean
  /** Being dragged: a lighter copy stays where it was. */
  ghost?: boolean
  /** Overrides the start–end text (a drag preview shows where it's going). */
  timeLabel?: string
  onMouseDown?: (event: { x?: number; y?: number }) => void
  onMouseUp?: () => void
  onResizeDown?: (event: { x?: number; y?: number }) => void
  testId?: string
}) {
  const { C } = useSettings()
  const tint = useTint(calendar, past)
  const compact = height < 38
  const time = timeLabel ?? `${timeText(o.startAt, true)} – ${timeText(o.endAt, true)}`
  const glass = useGlass(tint, selected, past)
  const fill = glass.fill
  const title = glass.title
  const sub = glass.sub
  return (
    <div
      testId={testId}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      style={{
        position: 'relative',
        height,
        borderRadius: 8,
        backgroundColor: fill,
        borderWidth: 1,
        borderColor: glass.edge,
        paddingLeft: 8,
        // Room on the right for the calendar dot.
        paddingRight: 14,
        paddingTop: compact ? 0 : 3,
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        alignItems: compact ? 'center' : 'stretch',
        gap: compact ? 5 : 1,
        overflow: 'hidden',
        opacity: ghost ? 0.45 : 1,
        cursor: 'pointer',
        boxShadow: selected ? { offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: '#00000033' } : undefined,
        hover: selected ? undefined : { backgroundColor: glass.hover },
      }}
    >
      {!compact && height >= 56 && hasRtl(o.title) ? (
        // A right-to-left title wrapped in reading order; the block clips what doesn't fit.
        <BidiText
          text={o.title}
          style={{ fontSize: 12, lineHeight: 15, fontWeight: 600, color: title, fontFamily: FONT, textDecoration: o.status === 'cancelled' ? 'line-through' : 'none', pointerEvents: 'none' }}
          box={{ flexShrink: 0, minWidth: 0, pointerEvents: 'none' }}
        />
      ) : (
        <text
          style={{
            fontSize: 12,
            lineHeight: 15,
            fontWeight: 600,
            color: title,
            fontFamily: FONT,
            flexShrink: compact ? 1 : 0,
            minWidth: 0,
            whiteSpace: compact || height < 56 ? 'nowrap' : 'normal',
            textOverflow: 'ellipsis',
            lineClamp: compact ? undefined : Math.max(1, Math.floor((height - 22) / 15)),
            textDecoration: o.status === 'cancelled' ? 'line-through' : 'none',
            pointerEvents: 'none',
          }}
        >
          {o.title || 'Untitled event'}
        </text>
      )}
      <text style={{ fontSize: 11, lineHeight: 14, color: sub, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', flexShrink: compact ? 0 : 1, pointerEvents: 'none' }}>
        {compact ? timeText(o.startAt, true) : time}
      </text>
      {!compact && height >= 64 && o.location ? (
        <text style={{ fontSize: 11, lineHeight: 14, color: sub, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{o.location}</text>
      ) : null}
      {/* The calendar's colour as a dot in the corner, instead of a strip down the side. */}
      <div style={{ position: 'absolute', top: compact ? (height - 6) / 2 : 6, right: 6, width: 6, height: 6, borderRadius: 3, backgroundColor: tint.edge, pointerEvents: 'none' }} />
      {onResizeDown ? (
        <div
          onMouseDown={onResizeDown}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, cursor: 'ns-resize', backgroundColor: '#00000001' }}
        />
      ) : null}
    </div>
  )
}

/** An all-day or multi-day event across the days it covers (the week's all-day row, a month week). */
export function DayBar({
  occurrence: o,
  calendar,
  past,
  selected,
  before,
  after,
  onClick,
  testId,
  prefix,
}: {
  occurrence: Pick<EventOccurrence, 'title' | 'allDay' | 'startAt'>
  calendar: Calendar | undefined
  past: boolean
  selected: boolean
  before: boolean
  after: boolean
  onClick: () => void
  testId?: string
  prefix?: string
}) {
  const tint = useTint(calendar, past)
  const glass = useGlass(tint, selected, past)
  const fill = glass.fill
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        height: 20,
        borderTopLeftRadius: before ? 0 : 10,
        borderBottomLeftRadius: before ? 0 : 10,
        borderTopRightRadius: after ? 0 : 10,
        borderBottomRightRadius: after ? 0 : 10,
        backgroundColor: fill,
        borderWidth: 1,
        borderColor: glass.edge,
        paddingLeft: 8,
        paddingRight: 6,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: selected ? { offsetX: 0, offsetY: 3, blurRadius: 10, spreadRadius: 0, color: '#00000033' } : undefined,
      }}
    >
      {prefix ? <text style={{ fontSize: 11, color: glass.sub, fontFamily: FONT, flexShrink: 0, pointerEvents: 'none' }}>{prefix}</text> : null}
      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, color: glass.title, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
        {o.title || 'Untitled event'}
      </text>
      <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tint.edge, flexShrink: 0, pointerEvents: 'none' }} />
    </div>
  )
}

/** A timed event as one line in a month cell: its colour as a dot, the time, the title. */
export function MonthLine({
  occurrence: o,
  calendar,
  past,
  selected,
  onClick,
  testId,
}: {
  occurrence: Pick<EventOccurrence, 'title' | 'startAt'>
  calendar: Calendar | undefined
  past: boolean
  selected: boolean
  onClick: () => void
  testId?: string
}) {
  const { C } = useSettings()
  const tint = useTint(calendar, past)
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        height: 20,
        paddingLeft: 5,
        paddingRight: 5,
        borderRadius: 5,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        cursor: 'pointer',
        backgroundColor: selected ? tint.edge : undefined,
        hover: selected ? undefined : { backgroundColor: C.overlayStrong },
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: selected ? '#FFFFFF' : tint.edge, flexShrink: 0, pointerEvents: 'none' }} />
      <text style={{ fontSize: 11, color: selected ? '#FFFFFFCC' : past ? C.ghost : C.muted, fontFamily: FONT, flexShrink: 0, pointerEvents: 'none' }}>{timeText(o.startAt, true)}</text>
      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 11.5, fontWeight: 500, color: selected ? '#FFFFFF' : past ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
        {o.title || 'Untitled event'}
      </text>
    </div>
  )
}

/** Holds an event and the card it opens, so the card anchors to the event without being inside its click target. */
export function Anchor({ children, card, grow }: { children: ReactNode; card: ReactNode; grow?: number }) {
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: grow, flexBasis: grow === undefined ? undefined : 0, minWidth: 0 }}>
      {children}
      {card}
    </div>
  )
}
