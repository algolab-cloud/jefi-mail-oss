import type { ReactNode } from 'react'
import { FONT, useSettings } from '../theme'
import { Icon, type IconName } from '../icons'

/** A clickable that Tab reaches and Enter/Space press, like the reader's Unsubscribe link. */
export function Pressable({ onPress, label, testId, style, children }: { onPress: () => void; label: string; testId?: string; style: Record<string, unknown>; children: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      testId={testId}
      onClick={onPress}
      onKeyDown={(event) => {
        if (event.key === 'enter' || event.key === 'space' || event.key === ' ') onPress()
      }}
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </div>
  )
}

/** A small text action ("Add to calendar", "Open") in the accent colour. */
export function LinkAction({ label, onPress, testId, icon, muted }: { label: string; onPress: () => void; testId?: string; icon?: IconName; muted?: boolean }) {
  const { C } = useSettings()
  const color = muted ? C.muted : C.accent
  return (
    <Pressable
      label={label}
      onPress={onPress}
      testId={testId}
      style={{ height: 24, paddingLeft: 7, paddingRight: 7, borderRadius: 12, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0, hover: { backgroundColor: C.overlayStrong } }}
    >
      {icon ? <div style={{ pointerEvents: 'none', display: 'flex' }}><Icon name={icon} size={13} color={color} /></div> : null}
      <text style={{ fontSize: 12.5, fontWeight: 500, color, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{label}</text>
    </Pressable>
  )
}

/** A rounded chip with an icon or colour dot, for linked notes and events. */
export function LinkChip({ icon, dot, label, detail, onPress, testId }: { icon: IconName; dot?: string; label: string; detail?: string; onPress: () => void; testId?: string }) {
  const { C } = useSettings()
  return (
    <Pressable
      label={`Open ${label}`}
      onPress={onPress}
      testId={testId}
      style={{ height: 24, maxWidth: 380, paddingLeft: 8, paddingRight: 9, borderRadius: 12, backgroundColor: C.chip, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, hover: { backgroundColor: C.overlayStrong } }}
    >
      {dot ? <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot, pointerEvents: 'none', flexShrink: 0 }} /> : null}
      <div style={{ pointerEvents: 'none', display: 'flex' }}><Icon name={icon} size={12} color={C.secondary} /></div>
      <text style={{ fontSize: 12, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1, pointerEvents: 'none' }}>{label}</text>
      {detail ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0, pointerEvents: 'none' }}>{detail}</text> : null}
    </Pressable>
  )
}
