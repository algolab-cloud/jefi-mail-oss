import React from 'react'
import { FONT, useSettings } from './theme'
import { Spinner } from './toast'

// ---------------------------------------------------------------------------
// Pieces Clean up's views share: sizes and counts as words, tab chips, row buttons and share bars.
// ---------------------------------------------------------------------------

export const formatBytes = (bytes: number) =>
  bytes <= 0 ? '0 KB' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

export const messageCount = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'message' : 'messages'}`

export function TabChip({ label, active, onClick, testId }: { label: string; active: boolean; onClick: () => void; testId: string }) {
  const { C } = useSettings()
  return (
    <div testId={testId} onClick={onClick} style={{ height: 30, paddingLeft: 12, paddingRight: 12, borderRadius: 8, display: 'flex', alignItems: 'center', cursor: 'pointer', backgroundColor: active ? C.chip : undefined, hover: { backgroundColor: C.overlay } }}>
      <text style={{ fontSize: 13, fontWeight: 500, color: active ? C.text : C.secondary, fontFamily: FONT }}>{label}</text>
    </div>
  )
}

/** How this group compares with the biggest one in the list. */
export function ShareBar({ share }: { share: number }) {
  const { C } = useSettings()
  return (
    <div style={{ width: 72, height: 4, borderRadius: 2, backgroundColor: C.chip, flexShrink: 0, display: 'flex', flexDirection: 'row' }}>
      <div style={{ width: Math.max(3, Math.round(72 * share)), height: 4, borderRadius: 2, backgroundColor: C.accent }} />
    </div>
  )
}

export function RowAction({ label, onClick, danger, busy, testId }: { label: string; onClick: () => void; danger?: boolean; busy?: boolean; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={busy ? undefined : onClick}
      style={{
        height: 28,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 14,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        backgroundColor: C.overlay,
        hover: { backgroundColor: C.overlayStrong },
      }}
    >
      {busy ? <Spinner size={12} color={C.accent} /> : null}
      <text style={{ fontSize: 12.5, fontWeight: 500, color: danger ? C.accent : C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}
