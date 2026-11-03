import { FONT, useSettings } from './theme'
import { useKeys } from './keys'
import { useOverlay } from './overlays'
import { SHORTCUTS, shortcutList } from './shortcuts'
import { CALENDAR_SHORTCUTS } from './calendar/keys'
import { APP_SHORTCUTS } from './sidebar-state'

// ---------------------------------------------------------------------------
// The cheat sheet (?): every keyboard shortcut, grouped, over a dimmed window. Reported to
// overlays.ts like the command palette, so the native HTML view steps aside while it's up.
// ---------------------------------------------------------------------------

const GROUPS = [...new Set(SHORTCUTS.map((s) => s.group))]
/** Every group's rows as the person's keyboard has them, the calendar's (live while it's open) included. */
const rowsFor = (shortcuts: ReturnType<typeof shortcutList>): Record<string, ReadonlyArray<{ keys: string; label: string }>> => ({
  ...Object.fromEntries(GROUPS.map((group) => [group, shortcuts.filter((s) => s.group === group)])),
  Apps: APP_SHORTCUTS,
  Calendar: CALENDAR_SHORTCUTS,
})

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { C, settings } = useSettings()
  const ROWS = rowsFor(shortcutList({ scheme: settings.shortcutScheme, keys: settings.shortcutKeys }))
  useOverlay(true)
  // Registered after the workspace, so Escape and a second ? close the sheet rather than reopening it.
  useKeys((press) => {
    const key = press.key?.toLowerCase()
    if (key !== 'escape' && key !== '?' && !(key === '/' && press.modifiers?.shift)) return false
    onClose()
    return true
  })

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 90 }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000066' }} onClick={onClose} />
      <div
        testId="shortcut-sheet"
        style={{
          width: 860,
          borderRadius: 16,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 48, spreadRadius: 0, color: '#00000077' },
          display: 'flex',
          flexDirection: 'column',
          padding: 20,
          gap: 14,
        }}
      >
        <text style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Keyboard shortcuts</text>
        {/* Two columns of groups, so the whole sheet fits without scrolling. */}
        <div style={{ display: 'flex', flexDirection: 'row', gap: 28 }}>
          {[GROUPS.slice(0, 2), GROUPS.slice(2), ['Apps', 'Calendar']].map((column, i) => (
            <div key={i} style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {column.filter((group) => ROWS[group]?.length).map((group) => (
                <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <text style={{ fontSize: 11.5, fontWeight: 600, color: C.secondary, fontFamily: FONT, paddingBottom: 2 }}>{group}</text>
                  {ROWS[group]!.map((shortcut) => (
                    <div key={shortcut.label} style={{ height: 22, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <text style={{ width: 66, flexShrink: 0, fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{shortcut.keys}</text>
                      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                        {shortcut.label}
                      </text>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
        <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>⌘K for everything else · Esc to close</text>
      </div>
    </div>
  )
}
