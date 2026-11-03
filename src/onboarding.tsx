import { motion, useWindowSize } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import { useEffect, useState, type ReactNode } from 'react'
import { ACCENTS, FONT, useSettings, type AccentName } from './theme'
import { Icon } from './icons'
import { useMail } from './store'
import { AccountWizard } from './account-wizard'
import { ProviderLogo } from './provider-logo'
import { providerFor, type ProviderId } from './accounts'
import { JefiWordmark } from './brand'
import { APP_VERSION } from './version'
import { BannerPreview, DENIED_HELP, useNotificationPermission } from './notification-permission'
import { openNotificationSettings } from './native/notify'
import welcomeArt from './assets/onboarding/welcome.png' with { type: 'file' }
import connectArt from './assets/onboarding/connect.png' with { type: 'file' }
import styleArt from './assets/onboarding/style.png' with { type: 'file' }
import notifyArt from './assets/onboarding/notify.png' with { type: 'file' }
import doneArt from './assets/onboarding/done.png' with { type: 'file' }

// ---------------------------------------------------------------------------
// First launch: a few short steps, each with its own illustration beside the copy. Connect an
// account (or look around with the demo), pick a look, and you're in; everything else has a
// sensible default and lives in Settings.
// ---------------------------------------------------------------------------

type Step = 'welcome' | 'mail' | 'connect' | 'style' | 'notify' | 'done'

/** Steps shown as dots (connect is part of mail). Notifications only when there's something to ask. */
const milestones = (askNotifications: boolean): Step[] =>
  askNotifications ? ['welcome', 'mail', 'style', 'notify', 'done'] : ['welcome', 'mail', 'style', 'done']

/** The illustration for each step; the account form keeps the mail one. */
const ART: Record<Exclude<Step, 'connect'>, string> = {
  welcome: welcomeArt,
  mail: connectArt,
  style: styleArt,
  notify: notifyArt,
  done: doneArt,
}
const artOf = (step: Step) => (step === 'connect' ? 'mail' : step)

/** GPUI paints from a path on disk or a data URL; inside the executable the import is neither, so read it once. */
const dataUrls = new Map<string, string>()
const artUrl = (path: string) => {
  let url = dataUrls.get(path)
  if (!url) dataUrls.set(path, (url = `data:image/png;base64,${readFileSync(path).toString('base64')}`))
  return url
}

const GLOWS: Array<{ name: AccentName; label: string }> = [
  { name: 'violet', label: 'Aurora' },
  { name: 'blue', label: 'Tide' },
  { name: 'green', label: 'Fern' },
  { name: 'amber', label: 'Lantern' },
  { name: 'red', label: 'Ember' },
]

const PROVIDERS: ProviderId[] = ['gmail', 'outlook', 'icloud', 'fastmail', 'yahoo', 'imap']

const NIGHT = { top: '#0C0C12', bottom: '#17151F', text: '#F4F2EE', muted: '#A2A1B3', faint: '#5E5D70', card: '#FFFFFF0D', cardBorder: '#FFFFFF1A' }
const DAY = { top: '#FCFBF8', bottom: '#EFEEF9', text: '#1B1B22', muted: '#5F6173', faint: '#A3A4B3', card: '#FFFFFFCC', cardBorder: '#1B1B2214' }
type Ink = typeof NIGHT

function greeting() {
  const hour = new Date().getHours()
  if (hour < 5) return 'Up late?'
  if (hour < 12) return 'Good morning.'
  if (hour < 18) return 'Good afternoon.'
  return 'Good evening.'
}

/** A soft wash of the accent behind the illustration, so it sits in light rather than on a flat page. */
function glowImage(accent: string, alpha: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs><radialGradient id="g" cx="200" cy="200" r="200" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${accent}" stop-opacity="${alpha.toFixed(2)}"/>
    <stop offset="0.55" stop-color="${accent}" stop-opacity="${(alpha * 0.35).toFixed(2)}"/>
    <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
  </radialGradient></defs>
  <circle cx="200" cy="200" r="200" fill="url(#g)"/>
</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

/**
 * Every step's illustration, stacked: the current one fades and rises in while the others fade
 * out. All six stay mounted so a step change never waits on decoding. A slow bob keeps it alive.
 */
function Illustration({ step, cx, cy, size, accent, day, leaving }: { step: Step; cx: number; cy: number; size: number; accent: string; day: boolean; leaving: boolean }) {
  const [up, setUp] = useState(false)
  useEffect(() => {
    const handle = setInterval(() => setUp((u) => !u), 2400)
    return () => clearInterval(handle)
  }, [])
  const shown = artOf(step)
  const bob = up ? -size * 0.025 : size * 0.025
  const glow = size * 1.5
  return (
    <>
      <img src={glowImage(accent, day ? 0.22 : 0.3)} objectFit="contain" style={{ position: 'absolute', left: cx - glow / 2, top: cy - glow / 2, width: glow, height: glow, pointerEvents: 'none' }} />
      {(Object.keys(ART) as Array<keyof typeof ART>).map((key) => {
        const active = key === shown
        const grow = leaving && active ? 1.12 : 1
        const s = size * grow
        return (
          // Outside: the quick fade and rise between steps. Inside: the slow bob.
          <motion.div
            key={key}
            initial={false}
            animate={{ opacity: active ? 1 : 0, left: cx - s / 2, top: cy - s / 2 + (active ? 0 : size * 0.08), width: s, height: s }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            style={{ position: 'absolute', pointerEvents: 'none' }}
          >
            <motion.div initial={false} animate={{ top: active ? bob : 0 }} transition={{ duration: 2.4, ease: 'easeInOut' }} style={{ position: 'relative', width: '100%', height: '100%' }}>
              <img src={artUrl(ART[key])} objectFit="contain" style={{ width: '100%', height: '100%' }} />
            </motion.div>
          </motion.div>
        )
      })}
    </>
  )
}

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, top: 12 }}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: 0.45, delay, ease: 'easeOut' }}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </motion.div>
  )
}

function PrimaryButton({ label, onClick, disabled, testId }: { label: string; onClick: () => void; disabled?: boolean; testId: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={disabled ? undefined : onClick}
      style={{
        height: 46,
        paddingLeft: 22,
        paddingRight: 18,
        borderRadius: 23,
        backgroundColor: C.accent,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        alignSelf: 'flex-start',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 28, spreadRadius: 0, color: `${C.accent}55` },
        hover: disabled ? undefined : { backgroundColor: C.accentHover },
        active: disabled ? undefined : { backgroundColor: C.accentActive },
      }}
    >
      <text style={{ fontSize: 15, fontWeight: 600, color: C.onAccent, fontFamily: FONT }}>{label}</text>
      <Icon name="arrowRightLong" size={16} color={C.onAccent} />
    </div>
  )
}

function TextLink({ label, onClick, testId, ink }: { label: string; onClick: () => void; testId: string; ink: Ink }) {
  return (
    <div testId={testId} onClick={onClick} style={{ alignSelf: 'flex-start', cursor: 'pointer', hover: { opacity: 0.7 } }}>
      <text style={{ fontSize: 14, color: ink.muted, fontFamily: FONT, textDecoration: 'underline' }}>{label}</text>
    </div>
  )
}

/** One provider in the grid: its logo and name on a card. */
function ProviderCard({ id, onPick, ink, accent }: { id: ProviderId; onPick: () => void; ink: Ink; accent: string }) {
  return (
    <div
      testId={`provider-${id}`}
      onClick={onPick}
      style={{
        flexGrow: 1,
        flexBasis: 0,
        height: 54,
        paddingLeft: 16,
        paddingRight: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: ink.cardBorder,
        backgroundColor: ink.card,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        hover: { borderColor: accent },
      }}
    >
      {/* Yahoo's logo is its wordmark, so it stands alone. */}
      <ProviderLogo id={id} size={id === 'yahoo' ? 16 : 22} />
      {id === 'yahoo' ? null : (
        <text style={{ fontSize: 14.5, fontWeight: 500, color: ink.text, fontFamily: FONT, pointerEvents: 'none' }}>{id === 'imap' ? 'Other (IMAP)' : providerFor(id).label}</text>
      )}
    </div>
  )
}

export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const { settings, update, C } = useSettings()
  const { accounts, switchAccount } = useMail()
  const { width, height } = useWindowSize()
  const permission = useNotificationPermission()
  // Latched: granting on the step itself must not pull the step out from under the dots.
  const [askNotifications, setAskNotifications] = useState(false)
  useEffect(() => {
    if (permission.status === 'undetermined' || permission.status === 'denied') setAskNotifications(true)
  }, [permission.status])
  const MILESTONES = milestones(askNotifications)
  const [notifyPhase, setNotifyPhase] = useState<'ask' | 'asking' | 'granted'>('ask')

  const [step, setStep] = useState<Step>('welcome')
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)

  const day = settings.theme === 'light'
  const ink = day ? DAY : NIGHT
  const accent = ACCENTS[settings.accent].accent
  // The name typed into the account form, for the last step.
  const first = (accounts.find((a) => a.id === connectedId)?.name ?? '').trim().split(/\s+/)[0] ?? ''
  const at = Math.max(0, MILESTONES.indexOf(artOf(step)))

  const finish = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => {
      // A fresh install already has this version; its notes would only describe what they just met.
      update({ onboarded: true, lastSeenVersion: APP_VERSION })
      onFinish()
    }, 900)
  }

  const next = () => setStep(MILESTONES[Math.min(at + 1, MILESTONES.length - 1)]!)

  // The notifications step: the system prompt on request, a beat of "all set", then on.
  const turnOnNotifications = async () => {
    if (notifyPhase !== 'ask') return
    setNotifyPhase('asking')
    const answer = await permission.request()
    setNotifyPhase(answer === 'granted' ? 'granted' : 'ask')
  }
  useEffect(() => {
    if (step !== 'notify' || notifyPhase !== 'granted') return
    const timer = setTimeout(next, 1300)
    return () => clearTimeout(timer)
  }, [step, notifyPhase])
  // "Not now" here counts like "Not now" on the sheet, so it doesn't reappear as soon as the app opens.
  const laterNotifications = () => {
    update({ notificationPromptDismissedAt: Date.now() })
    next()
  }

  // Copy on the left, the illustration centred in the space to its right.
  const left = Math.max(64, width * 0.08)
  const column = Math.min(step === 'connect' ? 520 : 460, width * 0.44)
  const cx = left + column + (width - left - column) / 2
  const cy = height * 0.5
  const art = Math.max(260, Math.min(height * 0.6, (width - left - column) * 0.72, 520))

  const heading = (text: string, size = 40) => (
    <text style={{ fontSize: size, lineHeight: size * 1.15, fontWeight: 600, color: ink.text, fontFamily: FONT }}>{text}</text>
  )
  const lede = (text: string) => <text style={{ fontSize: 16.5, lineHeight: 25, color: ink.muted, fontFamily: FONT }}>{text}</text>
  const label = (text: string) => <text style={{ fontSize: 14, fontWeight: 600, color: ink.text, fontFamily: FONT }}>{text}</text>

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: leaving ? 0 : 1 }}
      transition={{ duration: leaving ? 0.7 : 0.5, delay: leaving ? 0.2 : 0, ease: 'easeInOut' }}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', userSelect: 'none' }}
    >
      <div testId="onboarding" style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: { type: 'linear-gradient', angle: 180, stops: [{ color: ink.top, position: 0 }, { color: ink.bottom, position: 1 }] } }} />
      <Illustration step={step} cx={cx} cy={cy} size={art} accent={accent} day={day} leaving={leaving} />

      {/* Top bar: brand + skip. Leaves room for the traffic lights. */}
      <div style={{ position: 'absolute', top: 16, left: 96, right: 28, height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <JefiWordmark height={20} color={ink.text} />
        </div>
        {step !== 'done' ? (
          <div testId="onboarding-skip" onClick={finish} style={{ paddingLeft: 10, paddingRight: 10, height: 28, borderRadius: 14, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: ink.card } }}>
            <text style={{ fontSize: 13, color: ink.muted, fontFamily: FONT }}>Skip</text>
          </div>
        ) : null}
      </div>

      {/* Copy column */}
      <div style={{ position: 'absolute', left, top: 0, bottom: 0, width: column, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div key={step} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {step === 'welcome' ? (
            <>
              <Reveal>{heading(greeting(), 48)}</Reveal>
              <Reveal delay={0.1}>{heading('Your mail, in a better light.', 30)}</Reveal>
              <Reveal delay={0.2}>{lede('Jefi Mail is a calm, fast home for every inbox you have. Setting up takes about a minute.')}</Reveal>
              <Reveal delay={0.3}>
                <PrimaryButton label="Get started" onClick={next} testId="onboarding-begin" />
              </Reveal>
            </>
          ) : null}

          {step === 'mail' ? (
            <>
              <Reveal>{heading('Where does your mail live?')}</Reveal>
              <Reveal delay={0.1}>{lede('Any mailbox works. Your password stays on this Mac.')}</Reveal>
              <Reveal delay={0.18}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[0, 2, 4].map((row) => (
                    <div key={row} style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
                      {PROVIDERS.slice(row, row + 2).map((id) => (
                        <ProviderCard
                          key={id}
                          id={id}
                          ink={ink}
                          accent={accent}
                          onPick={() => {
                            setProvider(id)
                            setStep('connect')
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </Reveal>
              <Reveal delay={0.26}>
                <TextLink label="Look around first with a demo mailbox" onClick={next} testId="onboarding-demo" ink={ink} />
              </Reveal>
            </>
          ) : null}

          {step === 'connect' && provider ? (
            <>
              <Reveal>{heading(`Connect ${provider === 'imap' ? 'your mail server' : providerFor(provider).label}`, 30)}</Reveal>
              <Reveal delay={0.1}>
                <AccountWizard
                  inline
                  initialProvider={provider}
                  onClose={() => setStep('mail')}
                  onDone={(id) => {
                    switchAccount(id)
                    setConnectedId(id)
                    next()
                  }}
                />
              </Reveal>
            </>
          ) : null}

          {step === 'style' ? (
            <>
              <Reveal>{heading(connectedId ? 'Connected. Now make it yours.' : 'Make it yours.')}</Reveal>
              <Reveal delay={0.1}>{lede('A colour for buttons and unread mail, and a look for day or night. Change either any time in Settings.')}</Reveal>
              <Reveal delay={0.18}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {label('Colour')}
                  <div style={{ display: 'flex', flexDirection: 'row', gap: 16 }}>
                    {GLOWS.map((glow) => {
                      const selected = settings.accent === glow.name
                      const color = ACCENTS[glow.name].accent
                      return (
                        <div key={glow.name} testId={`glow-${glow.name}`} onClick={() => update({ accent: glow.name })} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <div style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: selected ? ink.text : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: 18,
                                backgroundColor: color,
                                boxShadow: { offsetX: 0, offsetY: 4, blurRadius: selected ? 18 : 8, spreadRadius: 0, color: `${color}${selected ? '88' : '44'}` },
                              }}
                            />
                          </div>
                          <text style={{ fontSize: 12.5, fontWeight: selected ? 600 : 400, color: selected ? ink.text : ink.muted, fontFamily: FONT, pointerEvents: 'none' }}>{glow.label}</text>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </Reveal>
              <Reveal delay={0.26}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {label('Look')}
                  <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
                    {(
                      [
                        { theme: 'light', label: 'Light', icon: 'sun' },
                        { theme: 'dark', label: 'Dark', icon: 'moon' },
                      ] as const
                    ).map((option) => {
                      const selected = settings.theme === option.theme
                      return (
                        <div
                          key={option.theme}
                          testId={`sky-${option.theme}`}
                          onClick={() => update({ theme: option.theme })}
                          style={{
                            height: 44,
                            paddingLeft: 18,
                            paddingRight: 20,
                            borderRadius: 22,
                            borderWidth: selected ? 2 : 1,
                            borderColor: selected ? C.accent : ink.cardBorder,
                            backgroundColor: ink.card,
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 9,
                            cursor: 'pointer',
                          }}
                        >
                          <Icon name={option.icon} size={17} color={selected ? C.accent : ink.muted} />
                          <text style={{ fontSize: 14.5, fontWeight: 500, color: ink.text, fontFamily: FONT, pointerEvents: 'none' }}>{option.label}</text>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </Reveal>
              <Reveal delay={0.34}>
                <PrimaryButton label="Continue" onClick={next} testId="onboarding-style-next" />
              </Reveal>
            </>
          ) : null}

          {step === 'notify' ? (
            <>
              <Reveal>{heading(notifyPhase === 'granted' ? 'You’ll hear from us.' : permission.status === 'denied' ? 'Notifications are off.' : 'Never miss what matters.')}</Reveal>
              <Reveal delay={0.1}>
                {lede(
                  notifyPhase === 'granted'
                    ? 'Only when it’s worth it. You can tune this any time in Settings.'
                    : permission.status === 'denied'
                      ? `macOS is keeping Jefi Mail quiet. ${DENIED_HELP}`
                      : 'A gentle tap on the shoulder when something arrives, even while you’re in another app.',
                )}
              </Reveal>
              <Reveal delay={0.18}>
                <div style={{ width: Math.min(420, column), display: 'flex', flexDirection: 'column' }}>
                  <BannerPreview dark={!day} accent={accent} />
                </div>
              </Reveal>
              {notifyPhase === 'granted' ? null : (
                <Reveal delay={0.26}>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 18 }}>
                    {permission.status === 'denied' ? (
                      <PrimaryButton label="Open System Settings" onClick={() => void openNotificationSettings()} testId="onboarding-notify-settings" />
                    ) : (
                      <PrimaryButton label={notifyPhase === 'asking' ? 'Waiting for macOS…' : 'Turn on notifications'} onClick={() => void turnOnNotifications()} testId="onboarding-notify-allow" />
                    )}
                    <TextLink label={permission.status === 'denied' ? 'Continue' : 'Not now'} onClick={laterNotifications} testId="onboarding-notify-later" ink={ink} />
                  </div>
                </Reveal>
              )}
            </>
          ) : null}

          {step === 'done' ? (
            <>
              <Reveal>{heading(first ? `You’re all set, ${first}.` : 'You’re all set.', 48)}</Reveal>
              <Reveal delay={0.12}>{lede(connectedId ? 'Your mail is coming in now. There’s a letter from us waiting too.' : 'Your demo inbox is ready. Add your own account any time from Settings.')}</Reveal>
              <Reveal delay={0.24}>
                <PrimaryButton label="Open Jefi Mail" onClick={finish} testId="onboarding-finish" />
              </Reveal>
            </>
          ) : null}
        </div>
      </div>

      {/* Progress: one dot per step, the current one a short bar. */}
      <div style={{ position: 'absolute', left, bottom: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {MILESTONES.map((milestone, i) => (
          <motion.div
            key={milestone}
            initial={false}
            animate={{ width: i === at ? 22 : 7, opacity: i <= at ? 1 : 0.4 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            style={{ height: 7, borderRadius: 3.5, backgroundColor: i <= at ? accent : ink.faint }}
          />
        ))}
      </div>
    </motion.div>
  )
}
