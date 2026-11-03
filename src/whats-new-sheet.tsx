import { motion } from '@gpuix/react'
import type { ReactNode } from 'react'
import { FONT, mixHex, useSettings } from './theme'
import { Icon } from './icons'
import { JefiMark } from './brand'
import { useKeys } from './keys'
import { useOverlay } from './overlays'
import type { ReleaseNotes } from './whats-new'

// ---------------------------------------------------------------------------
// "What's new": a calm card over the app, shown once after an update to a new minor version and
// any time from the command palette. Reported to overlays.ts so the native HTML view steps aside.
// ---------------------------------------------------------------------------

/** A short fade and rise; rows follow a beat apart so the list reads top to bottom. */
function Rise({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, top: 8 }}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </motion.div>
  )
}

export function WhatsNewSheet({ notes, onClose }: { notes: ReleaseNotes; onClose: () => void }) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  useOverlay(true)
  useKeys((press) => {
    const key = press.key?.toLowerCase()
    if (key !== 'escape' && key !== 'enter') return false
    onClose()
    return true
  })

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#0000008C' : '#00000052' }}
        onClick={onClose}
      />
      <Rise>
        <div
          testId="whats-new"
          style={{
            width: 584,
            borderRadius: 16,
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.overlayStrong,
            boxShadow: { offsetX: 0, offsetY: 24, blurRadius: 64, spreadRadius: 0, color: dark ? '#00000099' : '#0000003D' },
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header: mark and version, the title, one line on what the release is about. */}
          <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 30, paddingLeft: 32, paddingRight: 32, paddingBottom: 24, gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: `${C.accent}24`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <JefiMark size={22} color={C.accent} />
              </div>
              <div style={{ height: 22, paddingLeft: 9, paddingRight: 9, borderRadius: 11, backgroundColor: `${C.accent}1F`, display: 'flex', alignItems: 'center' }}>
                <text style={{ fontSize: 11.5, fontWeight: 600, color: C.accent, fontFamily: FONT, whiteSpace: 'nowrap' }}>{`Version ${notes.version}`}</text>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <text style={{ fontSize: 23, fontWeight: 600, color: C.text, fontFamily: FONT }}>{notes.title}</text>
              <text style={{ fontSize: 14, lineHeight: 21, color: C.secondary, fontFamily: FONT }}>{notes.intro}</text>
            </div>
          </div>

          <div style={{ height: 1, backgroundColor: C.overlay, marginLeft: 32, marginRight: 32 }} />

          <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 22, paddingBottom: 24, paddingLeft: 32, paddingRight: 32, gap: 18 }}>
            {notes.items.map((item, i) => (
              <Rise key={item.title} delay={0.08 + i * 0.05}>
                <div testId={`whats-new-item-${i}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 10, backgroundColor: `${C.accent}1F`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={item.icon} size={17} color={C.accent} />
                  </div>
                  <div style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 1 }}>
                    <text style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: FONT }}>{item.title}</text>
                    <text style={{ fontSize: 13, lineHeight: 19, color: C.secondary, fontFamily: FONT }}>{item.body}</text>
                  </div>
                </div>
              </Rise>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 16,
              paddingBottom: 16,
              paddingLeft: 32,
              paddingRight: 20,
              borderTopWidth: 1,
              borderColor: C.overlay,
            }}
          >
            <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>Find this again with ⌘K</text>
            <div
              testId="whats-new-continue"
              onClick={onClose}
              style={{
                height: 36,
                paddingLeft: 18,
                paddingRight: 14,
                borderRadius: 18,
                backgroundColor: C.text,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) },
                active: { backgroundColor: mixHex(C.text, C.reading, 0.22) },
              }}
            >
              <text style={{ fontSize: 13.5, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none' }}>Continue</text>
              <div style={{ pointerEvents: 'none', display: 'flex' }}>
                <Icon name="arrowRightLong" size={15} color={C.onText} />
              </div>
            </div>
          </div>
        </div>
      </Rise>
    </div>
  )
}
