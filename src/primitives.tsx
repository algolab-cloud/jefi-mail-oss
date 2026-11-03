import { useState } from 'react'
import { Tooltip } from './tooltip'
import { FONT, mixHex, useSettings, type Colors } from './theme'
import { Icon, type IconName } from './icons'
import { fileKind, middleEllipsis, type FileFamily } from './attachment-kind'
import type { Attachment, FaceSpec } from './data'
import { compactCount } from './sidebar-state'

export function Face({ src, letter, size }: FaceSpec & { size: number }) {
  const { C } = useSettings()
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size / 2,
        backgroundColor: C.face,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {src ? (
        <img src={src} objectFit="cover" style={{ width: size, height: size, borderRadius: size / 2 }} />
      ) : (
        <text style={{ fontSize: size * 0.4, fontWeight: 600, color: C.text, fontFamily: FONT }}>{letter}</text>
      )}
    </div>
  )
}

/** Every attachment card is this size, so a message's files line up in an even grid. */
export const ATTACHMENT_CARD_WIDTH = 236
export const ATTACHMENT_CARD_HEIGHT = 46

const FAMILY_TONE: Record<FileFamily, keyof Colors | null> = {
  pdf: 'red',
  document: 'blue',
  spreadsheet: 'green',
  presentation: 'amber',
  archive: null,
  image: 'purple',
  audio: 'pink',
  video: 'pink',
  calendar: 'teal',
  text: null,
  code: null,
  generic: null,
}

/** A small square tile tinted by file type, carrying the extension (or a file icon without one). */
export function FileTile({ name, size = 30 }: { name: string; size?: number }) {
  const { C } = useSettings()
  const kind = fileKind(name)
  const toneKey = FAMILY_TONE[kind.family]
  const tone = toneKey ? C[toneKey] : C.muted
  const fill = mixHex(tone, C.raised, toneKey ? 0.8 : 0.85)
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 6,
        backgroundColor: fill,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      {kind.label ? (
        <text style={{ fontSize: kind.label.length > 3 ? 8 : 9, fontWeight: 700, color: tone, fontFamily: FONT, pointerEvents: 'none' }}>{kind.label}</text>
      ) : (
        <Icon name="file" size={15} color={tone} />
      )}
    </div>
  )
}

export function AttachmentCard({
  attachment,
  onRemove,
  onOpen,
  onPreview,
  onSave,
  busy,
}: {
  attachment: Attachment
  onRemove?: () => void
  onOpen?: () => void
  onPreview?: () => void
  onSave?: () => void
  busy?: boolean
}) {
  const { C } = useSettings()
  // GPUIX sends enter/leave only to the element under the pointer, so moving onto the actions
  // strip or a button "leaves" the card. Hover is the union of every part, keyed so sibling
  // leave/enter order can't drop it; tracking the card alone made the actions blink.
  const [hoverParts, setHoverParts] = useState<Record<string, boolean>>({})
  const hoverPart = (part: string) => (on: boolean) => setHoverParts((parts) => (parts[part] === on ? parts : { ...parts, [part]: on }))
  const hovered = Object.values(hoverParts).some(Boolean)
  const [focused, setFocused] = useState(false)
  const [actionFocused, setActionFocused] = useState(false)
  const kind = fileKind(attachment.name)
  // Room for the name: ~24 characters beside the tile, fewer when the remove button takes a slot.
  const shown = middleEllipsis(attachment.name, onRemove ? 22 : 24)
  const meta = attachment.size ? `${kind.typeName} · ${attachment.size}` : kind.typeName
  const hasActions = Boolean(onPreview || onSave)
  const showActions = hasActions && !busy && (hovered || focused || actionFocused)
  const surface = onOpen && (hovered || focused) && !busy ? C.raisedHover : C.raised

  // Icon buttons float over the card's right edge, so showing them never changes its size. They
  // stay mounted (their testIds are what scripts click) and keep taking the pointer while faded
  // out: toggling pointerEvents with hover made GPUIX re-fire enter/leave under a still pointer,
  // another blink loop. Resting on a faded button counts as hovering the card and reveals it.
  const action = (label: string, icon: IconName, onSelect: () => void, testId: string) => (
    <Tooltip label={label} delay={300} hovered={Boolean(hoverParts[testId])}>
      <div
        onMouseEnter={() => hoverPart(testId)(true)}
        onMouseLeave={() => hoverPart(testId)(false)}
        testId={testId}
        role="button"
        aria-label={`${label} ${attachment.name}`}
        tabIndex={0}
        onClick={busy ? undefined : onSelect}
        onFocus={() => setActionFocused(true)}
        onBlur={() => setActionFocused(false)}
        onKeyDown={(event) => {
          if (!busy && (event.key === 'enter' || event.key === 'space' || event.key === ' ')) onSelect()
        }}
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          hover: { backgroundColor: C.overlayStrong },
        }}
      >
        <Icon name={icon} size={14} color={C.secondary} />
      </div>
    </Tooltip>
  )

  const card = (
    <div
      testId={onOpen ? `attachment-open-${attachment.name}` : undefined}
      role={onOpen ? 'button' : undefined}
      aria-label={onOpen ? `Open ${attachment.name}` : attachment.name}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen && !busy ? onOpen : undefined}
      onMouseEnter={() => hoverPart('card')(true)}
      onMouseLeave={() => hoverPart('card')(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (onOpen && !busy && (event.key === 'enter' || event.key === 'space' || event.key === ' ')) onOpen()
      }}
      style={{
        width: ATTACHMENT_CARD_WIDTH,
        height: ATTACHMENT_CARD_HEIGHT,
        flexShrink: 0,
        position: 'relative',
        borderRadius: 12,
        backgroundColor: surface,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: onRemove ? 6 : 10,
        gap: 10,
        opacity: busy ? 0.55 : 1,
        cursor: onOpen && !busy ? 'pointer' : 'default',
      }}
    >
      <FileTile name={attachment.name} />
      <div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' }}>
        <text style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{shown}</text>
        <text style={{ fontSize: 11, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{meta}</text>
      </div>
      {onRemove ? (
        <div
          role="button"
          aria-label={`Remove ${attachment.name}`}
          onClick={onRemove}
          style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
        >
          <Icon name="x" size={13} color={C.muted} />
        </div>
      ) : null}
      {hasActions ? (
        <div
          onMouseEnter={() => hoverPart('strip')(true)}
          onMouseLeave={() => hoverPart('strip')(false)}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            height: ATTACHMENT_CARD_HEIGHT - 2,
            paddingLeft: 6,
            paddingRight: 6,
            borderTopRightRadius: 8,
            borderBottomRightRadius: 8,
            backgroundColor: surface,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            opacity: showActions ? 1 : 0,
            pointerEvents: busy ? 'none' : 'auto',
          }}
        >
          {onPreview ? action('Quick Look', 'eye', onPreview, `attachment-preview-${attachment.name}`) : null}
          {onSave ? action('Save as…', 'download', onSave, `attachment-save-${attachment.name}`) : null}
        </div>
      ) : null}
    </div>
  )
  return shown !== attachment.name ? <Tooltip label={attachment.name} delay={600}>{card}</Tooltip> : card
}

/** A ring whose arc is `share` of the circle (clockwise from the top), over a faint full track. */
function ShareRing({ share, size, color }: { share: number; size: number; color: string }) {
  const r = 9
  const c = 2 * Math.PI * r
  const ring = (dash: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="4" stroke-linecap="butt"><circle cx="12" cy="12" r="${r}" transform="rotate(-90 12 12)"${dash}/></svg>`
  const arc = Math.min(1, Math.max(0, share)) * c
  return (
    <div style={{ width: size, height: size, flexShrink: 0, position: 'relative', pointerEvents: 'none' }}>
      <svg source={ring('')} style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, color, opacity: 0.3 }} />
      {arc > 0 ? <svg source={ring(` stroke-dasharray="${arc.toFixed(2)} ${c.toFixed(2)}"`)} style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, color }} /> : null}
    </div>
  )
}

/**
 * The count beside a folder. With `total` (all conversations there), the red badge also carries a
 * ring of unread vs read, and hovering it explains the numbers; `facts` adds lines to that popover.
 */
export function CountBadge({ count, tone, total, facts }: { count: number; tone: 'red' | 'muted'; total?: number; facts?: string[] }) {
  const { C } = useSettings()
  if (count <= 0) return null
  if (tone === 'muted') {
    return <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, flexShrink: 0 }}>{compactCount(count)}</text>
  }
  const ring = total !== undefined && total >= count
  const badge = (
    <div
      testId="count-badge"
      style={{
        height: 18,
        minWidth: 18,
        paddingLeft: ring ? 4 : 5,
        paddingRight: 5,
        gap: 4,
        borderRadius: 9,
        backgroundColor: C.accent,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        // Hover belongs to the tooltip wrapper (GPUIX delivers pointer events to the deepest painted element).
        pointerEvents: ring ? 'none' : undefined,
      }}
    >
      {ring ? <ShareRing share={count / total} size={11} color={C.onAccent} /> : null}
      <text style={{ fontSize: 11, fontWeight: 600, color: C.onAccent, fontFamily: FONT }}>{compactCount(count)}</text>
    </div>
  )
  if (!ring) return badge
  const read = total - count
  return (
    <Tooltip
      side="bottom"
      delay={250}
      testId="count-popover"
      label={`${count.toLocaleString()} unread of ${total.toLocaleString()}`}
      detail={`${read.toLocaleString()} read · ${Math.round((count / total) * 100)}% unread`}
      lines={facts}
    >
      {badge}
    </Tooltip>
  )
}

export function SectionLabel({ children, top = 0 }: { children: string; top?: number }) {
  const { C } = useSettings()
  return (
    <div style={{ paddingLeft: 6, paddingTop: top, paddingBottom: 4, flexShrink: 0 }}>
      <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{children}</text>
    </div>
  )
}

export function Divider() {
  const { C } = useSettings()
  return <div style={{ height: 1, flexShrink: 0, backgroundColor: C.divider }} />
}

/** An account's label, as a small chip with its colour. Used wherever an account is named. */
export function AccountLabelChip({ label, color }: { label: string; color: string }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 18, paddingLeft: 6, paddingRight: 7, gap: 5, borderRadius: 4, backgroundColor: C.chip, display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0, pointerEvents: 'none' }}>
      <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <text style={{ fontSize: 11, fontWeight: 500, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}
