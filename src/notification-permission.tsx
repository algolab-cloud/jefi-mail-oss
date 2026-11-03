import { motion } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { FONT, mixHex, useSettings } from './theme'
import { Icon, type IconName } from './icons'
import { jefiAvatar } from './brand'
import { useKeys } from './keys'
import { useOverlay } from './overlays'
import { Button } from './ui'
import { notificationPermission, openNotificationSettings, requestNotificationPermission, type NotificationPermission } from './native/notify'
import { forcedNotificationPrompt } from './notification-prompt'

// ---------------------------------------------------------------------------
// Asking for notifications on purpose: a step in onboarding, a sheet over the app for people who
// haven't answered yet, and a status row in Settings. The system prompt appears only when the
// person presses "Turn on notifications", never on the first banner by surprise.
// ---------------------------------------------------------------------------

// The last answer macOS gave, for the whole app: asking can take seconds (up to 4 in a dev build),
// and Settings mounts its row afresh each time the section scrolls back into view, so a row starts
// from what was last known and re-reads quietly instead of saying "Checking with macOS…" every time.
let lastKnown: NotificationPermission | null = null
let reading: Promise<NotificationPermission> | null = null

/** The last known permission, or null before macOS has answered once. */
export const cachedNotificationPermission = () => lastKnown

/**
 * Asks macOS (through `read`) and remembers the answer. Reads already under way are shared, so a
 * row polling every few seconds never stacks up slow ones.
 */
export function readNotificationPermission(read: () => Promise<NotificationPermission> = notificationPermission): Promise<NotificationPermission> {
  reading ??= read()
    .then((value) => (lastKnown = value))
    .finally(() => (reading = null))
  return reading
}

/** Remembers an answer learned another way (the system prompt), or forgets it (tests). */
export const rememberNotificationPermission = (value: NotificationPermission | null) => void (lastKnown = value)

/** The current permission, re-read on demand. JEFI_FORCE_NOTIFICATION_PROMPT pretends a status for screenshots. */
export function useNotificationPermission() {
  const forced = forcedNotificationPrompt()
  const [status, setStatus] = useState<NotificationPermission | null>(() => forced ?? lastKnown)
  const refresh = () => {
    if (forced) return Promise.resolve(forced)
    return readNotificationPermission().then((value) => (setStatus(value), value))
  }
  useEffect(() => void refresh(), [])
  const request = async (): Promise<NotificationPermission> => {
    // A forced status never raises the real system prompt: pretend the person said yes.
    const value = forced ? await new Promise<NotificationPermission>((done) => setTimeout(() => done('granted'), 500)) : await requestNotificationPermission()
    if (!forced) rememberNotificationPermission(value)
    setStatus(value)
    return value
  }
  return { status, refresh, request }
}

export type PermissionInk = { text: string; muted: string; faint: string; card: string; cardBorder: string }

export const PERMISSION_REASONS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'star', title: 'Mail from people who matter', body: 'Not every newsletter, just the conversations you’d want to know about.' },
  { icon: 'calendarPlus', title: 'Invitations', body: 'Accept or decline while the plan is still fresh.' },
  { icon: 'clock', title: 'Event reminders', body: 'A nudge before it starts, at the time you choose.' },
  { icon: 'moon', title: 'Even with the window closed', body: 'Jefi keeps watch from the menu bar.' },
]

/** One macOS-style banner, drawn rather than posted, so the person sees what they're agreeing to. */
function Banner({ dark, accent, title, subtitle, body, when }: { dark: boolean; accent: string; title: string; subtitle?: string; body: string; when: string }) {
  const text = dark ? '#F2F2F5' : '#1B1B22'
  const muted = dark ? '#A5A6B4' : '#6B6C7A'
  return (
    <div
      style={{
        width: '100%',
        borderRadius: 16,
        paddingTop: 11,
        paddingBottom: 11,
        paddingLeft: 12,
        paddingRight: 14,
        backgroundColor: dark ? '#2C2D3AF0' : '#FFFFFFF2',
        borderWidth: 1,
        borderColor: dark ? '#FFFFFF1A' : '#1B1B2212',
        boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: 0, color: dark ? '#00000080' : '#1B1B2224' },
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
      }}
    >
      <img src={jefiAvatar(accent)} objectFit="contain" style={{ width: 36, height: 36, flexShrink: 0 }} />
      <div style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <text style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</text>
          <text style={{ fontSize: 11.5, color: muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{when}</text>
        </div>
        {subtitle ? <text style={{ fontSize: 12.5, fontWeight: 500, color: text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{subtitle}</text> : null}
        <text style={{ fontSize: 12.5, color: muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{body}</text>
      </div>
    </div>
  )
}

/** Two banners as they'd land in the corner of the screen: a letter and a reminder. */
export function BannerPreview({ dark, accent }: { dark: boolean; accent: string }) {
  return (
    <div testId="notification-preview" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <motion.div initial={{ opacity: 0, left: 24 }} animate={{ opacity: 1, left: 0 }} transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }} style={{ position: 'relative', display: 'flex' }}>
        <Banner dark={dark} accent={accent} title="Maya Okafor" subtitle="Dinner on Thursday?" body="I found the little place by the harbour, they hold a table until eight…" when="now" />
      </motion.div>
      <motion.div initial={{ opacity: 0, left: 24 }} animate={{ opacity: 1, left: 0 }} transition={{ duration: 0.5, delay: 0.35, ease: [0.22, 1, 0.36, 1] }} style={{ position: 'relative', display: 'flex' }}>
        <Banner dark={dark} accent={accent} title="Design review" body="In 10 minutes · Studio 3" when="9:50" />
      </motion.div>
    </div>
  )
}

/** The four reasons, compact: an accent-tinted icon and a line each. */
export function PermissionReasons({ ink, accent, columns = 1 }: { ink: PermissionInk; accent: string; columns?: 1 | 2 }) {
  const row = (reason: (typeof PERMISSION_REASONS)[number]) => (
    <div key={reason.title} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 9, backgroundColor: `${accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={reason.icon} size={15} color={accent} />
      </div>
      <div style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <text style={{ fontSize: 13.5, fontWeight: 600, color: ink.text, fontFamily: FONT }}>{reason.title}</text>
        <text style={{ fontSize: 12.5, lineHeight: 18, color: ink.muted, fontFamily: FONT }}>{reason.body}</text>
      </div>
    </div>
  )
  if (columns === 1) return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{PERMISSION_REASONS.map(row)}</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {[0, 2].map((start) => (
        <div key={start} style={{ display: 'flex', flexDirection: 'row', gap: 20 }}>
          {PERMISSION_REASONS.slice(start, start + 2).map(row)}
        </div>
      ))}
    </div>
  )
}

export const DENIED_HELP = 'Open System Settings › Notifications › Jefi Mail and turn on Allow notifications.'

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

export type PromptOutcome = 'granted' | 'later' | 'settings'

/**
 * The sheet over the app for someone who already uses Jefi. 'undetermined' asks through the system
 * prompt; 'denied' can only point at System Settings, since macOS never asks twice.
 */
export function NotificationPermissionSheet({ variant, onClose }: { variant: 'undetermined' | 'denied'; onClose: (outcome: PromptOutcome) => void }) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { request } = useNotificationPermission()
  const [phase, setPhase] = useState<'ask' | 'asking' | 'granted'>('ask')
  useOverlay(true)
  useKeys((press) => {
    if (press.key?.toLowerCase() !== 'escape') return false
    if (phase !== 'granted') onClose('later')
    return true
  })
  // A brief "all set" before the sheet steps aside.
  useEffect(() => {
    if (phase !== 'granted') return
    const timer = setTimeout(() => onClose('granted'), 1400)
    return () => clearTimeout(timer)
  }, [phase])

  const turnOn = async () => {
    if (phase !== 'ask') return
    setPhase('asking')
    const answer = await request()
    if (answer === 'granted') setPhase('granted')
    else setPhase('ask')
  }
  const openSettings = () => {
    void openNotificationSettings()
    onClose('settings')
  }
  const ink: PermissionInk = { text: C.text, muted: C.secondary, faint: C.muted, card: C.raised, cardBorder: C.overlay }
  const granted = phase === 'granted'
  const title = granted ? 'You’re all set.' : variant === 'denied' ? 'Notifications are off' : 'Know when it matters'
  const intro = granted
    ? 'Jefi will tap you on the shoulder, and only when it’s worth it.'
    : variant === 'denied'
      ? 'macOS is keeping Jefi quiet, so new mail, invitations and reminders arrive without a word.'
      : 'Let Jefi tell you when something arrives, even while you’re in another app.'

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#0000008C' : '#00000052' }}
        onClick={() => !granted && onClose('later')}
      />
      <Rise>
        <div
          testId="notification-prompt"
          style={{
            width: 584,
            borderRadius: 16,
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.overlayStrong,
            boxShadow: { offsetX: 0, offsetY: 24, blurRadius: 64, spreadRadius: 0, color: dark ? '#00000099' : '#0000003D' },
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* A strip of "desktop" where the banners land, lit faintly by the accent. */}
          <div
            style={{
              paddingTop: 26,
              paddingBottom: 24,
              paddingLeft: 88,
              paddingRight: 88,
              background: {
                type: 'linear-gradient',
                angle: 160,
                stops: dark
                  ? [{ color: '#15172A', position: 0 }, { color: `${C.accent}33`, position: 1 }]
                  : [{ color: '#FFF6E8', position: 0 }, { color: `${C.accent}2E`, position: 1 }],
              },
              borderBottomWidth: 1,
              borderColor: C.overlay,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <BannerPreview dark={dark} accent={C.accent} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 24, paddingLeft: 32, paddingRight: 32, paddingBottom: 22, gap: 6 }}>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name={granted ? 'circleCheck' : 'bell'} size={20} color={C.accent} />
              <text testId="notification-prompt-title" style={{ fontSize: 23, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</text>
            </div>
            <text style={{ fontSize: 14, lineHeight: 21, color: C.secondary, fontFamily: FONT }}>{intro}</text>
          </div>

          {granted ? null : (
            <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 32, paddingRight: 32, paddingBottom: 24 }}>
              <PermissionReasons ink={ink} accent={C.accent} columns={2} />
            </div>
          )}

          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 32,
              paddingRight: 20,
              borderTopWidth: 1,
              borderColor: C.overlay,
              minHeight: 64,
            }}
          >
            <text style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: C.muted, fontFamily: FONT }}>
              {granted ? '' : variant === 'denied' ? DENIED_HELP : 'You can change this any time in Settings.'}
            </text>
            {granted ? null : (
              <>
                <Button label="Not now" variant="ghost" onClick={() => onClose('later')} testId="notification-prompt-later" />
                <SheetPrimary
                  label={variant === 'denied' ? 'Open System Settings' : phase === 'asking' ? 'Waiting for macOS…' : 'Turn on notifications'}
                  onClick={variant === 'denied' ? openSettings : () => void turnOn()}
                  testId="notification-prompt-allow"
                />
              </>
            )}
          </div>
        </div>
      </Rise>
    </div>
  )
}

function SheetPrimary({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        height: 36,
        paddingLeft: 18,
        paddingRight: 18,
        borderRadius: 18,
        backgroundColor: C.text,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        cursor: 'pointer',
        hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) },
        active: { backgroundColor: mixHex(C.text, C.reading, 0.22) },
      }}
    >
      <text style={{ fontSize: 13.5, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}

/** Settings: what macOS currently allows, and the one thing to do about it. */
export function NotificationPermissionControl({ permission }: { permission: ReturnType<typeof useNotificationPermission> }) {
  const { status, request } = permission
  if (status === 'granted') return <PermissionBadge label="Allowed" good />
  if (status === 'undetermined') return <Button label="Turn on" variant="primary" onClick={() => void request()} testId="settings-notification-permission" />
  if (status === 'denied') return <Button label="Open System Settings" onClick={() => void openNotificationSettings()} testId="settings-notification-permission" />
  return <PermissionBadge label={status === null ? 'Checking…' : 'Unavailable'} />
}

/** The row's subtitle for the same status. */
export function permissionSummary(status: NotificationPermission | null): string {
  if (status === 'granted') return 'macOS lets Jefi show banners'
  if (status === 'denied') return 'Turned off in System Settings, so no banners appear'
  if (status === 'undetermined') return 'Jefi hasn’t asked yet'
  if (status === 'unavailable') return 'Only the installed app can show banners'
  return 'Checking with macOS…'
}

function PermissionBadge({ label, good }: { label: string; good?: boolean }) {
  const { C } = useSettings()
  return (
    <div testId="settings-notification-permission-status" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {good ? <Icon name="circleCheck" size={15} color={C.green} /> : null}
      <text style={{ fontSize: 13, color: good ? C.text : C.muted, fontFamily: FONT }}>{label}</text>
    </div>
  )
}
