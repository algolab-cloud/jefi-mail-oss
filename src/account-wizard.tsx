import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FONT, useSettings } from './theme'
import { Icon, IconButton, type IconName } from './icons'
import { Divider } from './primitives'
import { Button, Field, Modal, SecretInput, SegmentedControl, TextInput } from './ui'
import { useMail } from './store'
import { isSignInCancelled, oauthProviderFor } from './engine'
import { ProviderLogo } from './provider-logo'
import {
  DEFAULT_PORTS,
  PROVIDERS,
  guessServers,
  providerFor,
  providerForEmail,
  type ProviderId,
  type Security,
  type ServerSettings,
} from './accounts'

type Step = 'provider' | 'account' | 'servers' | 'connect' | 'done'

/** Cancel stale connection results when a wizard is replaced or closed. */
function useConnectionLifetime() {
  const current = useRef<AbortController | null>(null)
  useEffect(() => () => current.current?.abort(), [])
  return current
}

const STEP_TITLES: Record<Step, { title: string; caption: string }> = {
  provider: { title: 'Add an account', caption: 'Choose where your mail lives' },
  account: { title: 'Your account', caption: 'Who the mail belongs to and how Jefi signs in' },
  servers: { title: 'Server settings', caption: 'Where Jefi fetches and sends mail' },
  connect: { title: 'Connecting', caption: 'Checking your settings' },
  done: { title: 'All set', caption: 'Your account is ready' },
}

const SECURITY_OPTIONS: Array<{ value: Security; label: string }> = [
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'None' },
]

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function ProviderTile({ id, selected, onSelect }: { id: ProviderId; selected: boolean; onSelect: () => void }) {
  const { C } = useSettings()
  const provider = providerFor(id)
  return (
    <div
      testId={`provider-${id}`}
      onClick={onSelect}
      style={{
        width: 160,
        height: 76,
        borderRadius: 12,
        // Only the chosen tile is outlined; the rest sit borderless on the pane.
        borderWidth: 2,
        borderColor: selected ? C.accent : '#00000000',
        backgroundColor: C.raised,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        paddingLeft: 14,
        gap: 8,
        cursor: 'pointer',
        hover: { backgroundColor: C.raisedHover },
      }}
    >
      <div style={{ height: 28, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
        <ProviderLogo id={id} size={26} />
      </div>
      <text style={{ fontSize: 13.5, fontWeight: 500, color: C.text, fontFamily: FONT }}>{provider.label}</text>
    </div>
  )
}

function ServerBlock({
  kind,
  servers,
  onChange,
}: {
  kind: 'imap' | 'smtp'
  servers: ServerSettings
  onChange: (next: ServerSettings) => void
}) {
  const { C } = useSettings()
  const host = kind === 'imap' ? servers.imapHost : servers.smtpHost
  const port = kind === 'imap' ? servers.imapPort : servers.smtpPort
  const security = kind === 'imap' ? servers.imapSecurity : servers.smtpSecurity
  const set = (patch: Partial<{ host: string; port: number; security: Security }>) =>
    onChange({
      ...servers,
      ...(kind === 'imap'
        ? { imapHost: patch.host ?? host, imapPort: patch.port ?? port, imapSecurity: patch.security ?? security }
        : { smtpHost: patch.host ?? host, smtpPort: patch.port ?? port, smtpSecurity: patch.security ?? security }),
    })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <text style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: FONT }}>
        {kind === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
        <div style={{ flexGrow: 1, flexBasis: 0 }}>
          <Field label="Host">
            <TextInput testId={`wizard-${kind}-host`} value={host} placeholder={`${kind}.example.com`} onChange={(v) => set({ host: v.trim() })} invalid={!host} />
          </Field>
        </div>
        <div style={{ width: 90 }}>
          <Field label="Port">
            <TextInput
              testId={`wizard-${kind}-port`}
              // An emptied field stays empty (0 means none yet) rather than turning into a stuck "0".
              value={port ? String(port) : ''}
              placeholder={String(DEFAULT_PORTS[kind][security])}
              invalid={!port}
              onChange={(v) => {
                const n = Number(v.replace(/\D/g, ''))
                set({ port: Number.isFinite(n) ? Math.min(n, 65535) : port })
              }}
            />
          </Field>
        </div>
      </div>
      <Field label="Security">
        <SegmentedControl
          testId={`wizard-${kind}-security`}
          value={security}
          options={SECURITY_OPTIONS}
          onChange={(next) => set({ security: next, port: port === DEFAULT_PORTS[kind][security] ? DEFAULT_PORTS[kind][next] : port })}
        />
      </Field>
    </div>
  )
}

type Check = { label: string; state: 'pending' | 'running' | 'ok' | 'failed' }

function CheckRow({ check }: { check: Check }) {
  const { C } = useSettings()
  const icon: IconName = check.state === 'ok' ? 'check' : check.state === 'failed' ? 'x' : 'loader'
  const filled = check.state === 'ok' || check.state === 'failed'
  return (
    <div style={{ height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: filled ? C.accent : C.chip,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {check.state === 'pending' ? null : <Icon name={icon} size={12} color={filled ? C.onAccent : C.secondary} />}
      </div>
      <text style={{ fontSize: 13.5, color: check.state === 'pending' ? C.muted : C.text, fontFamily: FONT }}>{check.label}</text>
    </div>
  )
}

/** Card chrome for the wizard when it's embedded in a page (onboarding) instead of a modal. */
function InlineFrame({ children }: { children: ReactNode; onClose: () => void; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      testId="account-wizard"
      style={{ width: '100%', borderRadius: 14, backgroundColor: C.raised, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {children}
    </div>
  )
}

export function AccountWizard({
  onClose,
  onDone,
  inline = false,
  initialProvider,
  initialName = '',
}: {
  onClose: () => void
  onDone: (accountId: string) => void
  /** Start on the account form for this provider (skips the provider grid). */
  initialProvider?: ProviderId
  initialName?: string
  /** Render as a card inside a page; Cancel reads "Back" and the done step continues the host flow. */
  inline?: boolean
}) {
  const { C } = useSettings()
  const { accounts, addAccount, checkConnection, signIn, cancelSignIn } = useMail()

  const [step, setStep] = useState<Step>(initialProvider ? 'account' : 'provider')
  const [providerId, setProviderId] = useState<ProviderId>(initialProvider ?? 'gmail')
  const [name, setName] = useState(initialName)
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const [servers, setServers] = useState<ServerSettings>(() => providerFor(initialProvider ?? 'gmail').servers ?? guessServers(''))
  const [touched, setTouched] = useState(false)
  // Once hosts are edited by hand, stop re-deriving them from the email address.
  const [serversEdited, setServersEdited] = useState(false)
  const [checks, setChecks] = useState<Check[]>([])
  const [createdId, setCreatedId] = useState<string | null>(null)
  // Set when the connection check fails: what went wrong, and which step fixes it.
  const [connectError, setConnectError] = useState<{ message: string; fixStep: Step } | null>(null)
  /** Set once a browser sign-in succeeded; used instead of a password. */
  const [oauthSecret, setOauthSecret] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const connection = useConnectionLifetime()
  // The browser sign-in in flight, if any: a newer one, Cancel, or closing the wizard makes its
  // result stale, and closing the wizard stops it (else the browser page waits for 5 minutes).
  const signInAttempt = useRef(0)
  const signInPending = useRef(false)
  useEffect(() => () => {
    signInAttempt.current++
    if (signInPending.current) cancelSignIn()
  }, [])

  const startSignIn = (kind: NonNullable<typeof oauthKind>) => {
    const attempt = ++signInAttempt.current
    signInPending.current = true
    setSigningIn(true)
    setSignInError(null)
    signIn(kind, email.trim() || undefined)
      .then((result) => {
        if (attempt !== signInAttempt.current) return
        setOauthSecret(result.secret)
        if (result.email) setEmail(result.email)
      })
      .catch((err) => {
        if (attempt !== signInAttempt.current || isSignInCancelled(err)) return
        setSignInError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (attempt !== signInAttempt.current) return
        signInPending.current = false
        setSigningIn(false)
      })
  }

  const stopSignIn = () => {
    signInAttempt.current++
    signInPending.current = false
    setSigningIn(false)
    setSignInError(null)
    cancelSignIn()
  }

  const provider = providerFor(providerId)
  const emailValid = EMAIL_RE.test(email.trim())
  const duplicate = accounts.some((a) => a.email.toLowerCase() === email.trim().toLowerCase())
  // Gmail signs in with an app password (Google sign-in needs a paid security review for mail access).
  const appPassword = providerId === 'gmail'
  const oauthKind = appPassword ? null : oauthProviderFor(providerId)
  // Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it.
  const typedSecret = appPassword ? secret.replace(/\s+/g, '') : secret
  const credential = appPassword ? typedSecret : (oauthSecret ?? typedSecret)
  const accountValid = name.trim().length > 0 && emailValid && !duplicate && credential.length > 0
  const serversValid = servers.imapHost.length > 0 && servers.smtpHost.length > 0 && servers.imapPort > 0 && servers.smtpPort > 0

  const chooseProvider = (id: ProviderId) => {
    // A Microsoft sign-in belongs to Microsoft: it must not become another provider's password.
    if (id !== providerId) {
      if (signInPending.current) stopSignIn()
      setOauthSecret(null)
      setSignInError(null)
    }
    setProviderId(id)
    const preset = providerFor(id).servers
    setServers(preset ?? guessServers(email))
    setServersEdited(false)
  }

  const updateEmail = (value: string) => {
    setEmail(value)
    // A sign-in is for the address it was made with; another address signs in again.
    if (oauthSecret && value.trim().toLowerCase() !== email.trim().toLowerCase()) setOauthSecret(null)
    // Typing a known address switches to that provider's presets.
    const detected = providerForEmail(value)
    if (detected && detected.id !== providerId && providerId !== 'imap') chooseProvider(detected.id)
    else if (providerId === 'imap' && !serversEdited) setServers(guessServers(value))
  }

  const editServers = (next: ServerSettings) => {
    setServers(next)
    setServersEdited(true)
  }

  const nextFromAccount = () => {
    setTouched(true)
    if (!accountValid) return
    if (provider.reviewServers) setStep('servers')
    else connect()
  }

  // Connection check: the engine signs in to IMAP and SMTP with the unsaved settings. The account is
  // only added (and its secret handed to the Keychain) once both succeed.
  const connect = () => {
    connection.current?.abort()
    const attempt = new AbortController()
    connection.current = attempt
    setStep('connect')
    const labels = [`Finding ${servers.imapHost}`, `Signing in as ${email.trim()}`, `Checking outgoing mail on ${servers.smtpHost}`]
    const input = { name: name.trim(), email: email.trim(), provider: providerId, servers }
    setConnectError(null)
    setChecks(labels.map((label, i) => ({ label, state: i === 1 ? 'pending' : 'running' })))

    checkConnection(input, credential)
      .then(({ imap, smtp }) => {
        if (attempt.signal.aborted) return
        // An auth failure means the server was found; anything else failed before signing in.
        const imapFailedAt = imap.ok ? -1 : imap.kind === 'auth' ? 1 : 0
        setChecks(
          labels.map((label, i) => {
            if (i < 2) return { label, state: imapFailedAt === -1 || i < imapFailedAt ? 'ok' : i === imapFailedAt ? 'failed' : 'pending' }
            return { label, state: smtp.ok ? 'ok' : 'failed' }
          }),
        )
        const failures = [imap, smtp].filter((result): result is Extract<typeof result, { ok: false }> => !result.ok)
        if (failures.length) {
          // Both reasons, so fixing one doesn't just reveal the other on the next try.
          setConnectError({ message: [...new Set(failures.map((f) => f.message))].join('\n'), fixStep: failures[0]!.kind === 'auth' ? 'account' : 'servers' })
          return
        }
        const created = addAccount(input, credential)
        setCreatedId(created.id)
        setSecret('')
        setStep('done')
      })
      .catch((err) => {
        if (!attempt.signal.aborted) setConnectError({ message: err instanceof Error ? err.message : String(err), fixStep: 'servers' })
      })
  }

  // A check can take a while against a slow server: stop it and go back to the settings.
  const cancelConnect = () => {
    connection.current?.abort()
    connection.current = null
    setStep(provider.reviewServers || providerId === 'imap' ? 'servers' : 'account')
  }

  const back = () => {
    if (step === 'account' && initialProvider) onClose()
    else if (step === 'account') setStep('provider')
    else if (step === 'servers') setStep('account')
  }

  const { title, caption } =
    step === 'connect' && connectError ? { title: "Couldn't connect", caption: 'Fix the highlighted step and try again' } : STEP_TITLES[step]
  const stepIndex = ['provider', 'account', 'servers', 'connect', 'done'].indexOf(step)

  const Frame = inline ? InlineFrame : Modal
  return (
    <Frame onClose={onClose} testId="account-wizard">
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 22, paddingRight: 14, paddingTop: 16, paddingBottom: 14, gap: 12 }}>
        {step === 'account' || step === 'servers' ? (
          <IconButton icon="chevronLeft" size={16} pad={28} onClick={back} testId="wizard-back" />
        ) : null}
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <text style={{ fontSize: 17, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</text>
          <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{caption}</text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 5, marginRight: 8 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ width: i === Math.min(stepIndex, 3) ? 16 : 6, height: 6, borderRadius: 3, backgroundColor: i <= stepIndex ? C.accent : C.chip }} />
          ))}
        </div>
        {!inline ? <IconButton icon="x" size={16} pad={28} onClick={onClose} testId="wizard-close" /> : null}
      </div>
      <Divider />

      {/* Body */}
      <div style={{ paddingLeft: 22, paddingRight: 22, paddingTop: 18, paddingBottom: 20, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'scroll' }}>
        {step === 'provider' ? (
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {PROVIDERS.map((p) => (
              <ProviderTile key={p.id} id={p.id} selected={p.id === providerId} onSelect={() => chooseProvider(p.id)} />
            ))}
          </div>
        ) : null}

        {step === 'account' ? (
          <>
            <Field label="Name" hint="Shown to people you email" error={touched && !name.trim() ? 'Enter your name' : undefined}>
              <TextInput testId="wizard-name" autoFocus value={name} placeholder="Full name" onChange={setName} onEnter={nextFromAccount} />
            </Field>
            <Field
              label="Email address"
              error={touched && !emailValid ? 'Enter a valid email address' : duplicate ? 'This account is already in Jefi' : undefined}
            >
              <TextInput
                testId="wizard-email"
                value={email}
                placeholder={provider.domains[0] ? `you@${provider.domains[0]}` : 'you@example.com'}
                onChange={updateEmail}
                onEnter={nextFromAccount}
                invalid={(touched && !emailValid) || duplicate}
              />
            </Field>
            {appPassword ? (
              <Field
                label="Google app password"
                hint="In your Google Account, turn on 2-Step Verification, create an app password named “Jefi”, and paste the 16 letters here."
                error={touched && !typedSecret ? 'Paste the app password from Google' : undefined}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <SecretInput testId="wizard-secret" value={secret} onChange={setSecret} onEnter={nextFromAccount} />
                  <div style={{ alignSelf: 'flex-start' }}>
                    <Button
                      label="Open Google app passwords"
                      variant="ghost"
                      icon="externalLink"
                      testId="wizard-app-password-link"
                      onClick={() => void Bun.spawn(['open', 'https://myaccount.google.com/apppasswords'], { stdout: 'ignore', stderr: 'ignore' })}
                    />
                  </div>
                </div>
              </Field>
            ) : oauthKind ? (
              <Field
                label="Sign in"
                hint="Microsoft no longer accepts passwords for mail apps."
                error={touched && !oauthSecret ? 'Sign in with Microsoft to continue' : undefined}
              >
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Button
                    label={signingIn ? 'Waiting for sign-in…' : oauthSecret ? 'Signed in — sign in again' : 'Sign in with Microsoft'}
                    variant={oauthSecret ? 'ghost' : 'primary'}
                    disabled={signingIn}
                    testId="wizard-oauth"
                    onClick={() => startSignIn(oauthKind)}
                  />
                  {signingIn ? <Button label="Cancel" variant="ghost" testId="wizard-oauth-cancel" onClick={stopSignIn} /> : null}
                  {oauthSecret ? <Icon name="check" size={14} color={C.accent} /> : null}
                </div>
              </Field>
            ) : (
              <Field label={provider.secretLabel} hint={provider.secretHint} error={touched && !secret ? `Enter your ${provider.secretLabel.toLowerCase()}` : undefined}>
                <SecretInput testId="wizard-secret" value={secret} onChange={setSecret} onEnter={nextFromAccount} />
              </Field>
            )}
            {signInError ? (
              <text testId="wizard-signin-error" style={{ fontSize: 12.5, lineHeight: 17, color: C.accent, fontFamily: FONT }}>
                {signInError}
              </text>
            ) : null}
            {providerId !== 'imap' ? (
              <div
                testId="wizard-edit-servers"
                onClick={() => {
                  setTouched(true)
                  if (accountValid) setStep('servers')
                }}
                style={{ alignSelf: 'flex-start', cursor: 'pointer', hover: { opacity: 0.7 } }}
              >
                <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, textDecoration: 'underline' }}>
                  {`Uses ${servers.imapHost} — edit server settings`}
                </text>
              </div>
            ) : null}
          </>
        ) : null}

        {step === 'servers' ? (
          <>
            {providerId === 'zoho' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <text style={{ fontSize: 12.5, lineHeight: 18, color: C.secondary, fontFamily: FONT }}>
                  Confirm the servers shown in Zoho Mail → Settings → Mail Accounts → Server Configuration Details. These defaults are for paid organizations in the US. Personal accounts use imap.zoho.com and smtp.zoho.com; other regions use their own server names. Keep Zoho’s “Save copy of sent emails” enabled.
                </text>
                <Button label="Zoho setup guide" variant="ghost" icon="externalLink" testId="wizard-zoho-guide" onClick={() => void Bun.spawn(['open', 'https://www.zoho.com/mail/help/imap-access.html'], { stdout: 'ignore', stderr: 'ignore' })} />
              </div>
            ) : null}
            <ServerBlock kind="imap" servers={servers} onChange={editServers} />
            <Divider />
            <ServerBlock kind="smtp" servers={servers} onChange={editServers} />
          </>
        ) : null}

        {step === 'connect' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4, paddingBottom: 4 }}>
            {checks.map((check) => (
              <CheckRow key={check.label} check={check} />
            ))}
          </div>
        ) : null}

        {step === 'done' ? (
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 52, height: 52, borderRadius: 12, backgroundColor: C.raised, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              <ProviderLogo id={providerId} size={providerId === 'yahoo' ? 14 : 28} />
              <div style={{ position: 'absolute', right: -5, bottom: -5, width: 20, height: 20, borderRadius: 10, backgroundColor: C.accent, borderWidth: 2, borderColor: C.reading, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="check" size={11} color={C.onAccent} />
              </div>
            </div>
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <text style={{ fontSize: 14.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{email.trim()}</text>
              <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>
                {`${name.trim()} · ${provider.label} · ${servers.imapHost}`}
              </text>
            </div>
          </div>
        ) : null}

        {step === 'connect' && connectError ? (
          <text testId="wizard-connect-error" style={{ fontSize: 13, lineHeight: 18, color: C.accent, fontFamily: FONT }}>
            {connectError.message}
          </text>
        ) : null}

        {step === 'connect' || step === 'done' ? (
          <text style={{ fontSize: 12, lineHeight: 17, color: C.muted, fontFamily: FONT }}>
            Your password is kept in the macOS Keychain, never in a file.
          </text>
        ) : null}
      </div>

      {/* Footer */}
      <Divider />
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingLeft: 22, paddingRight: 16, paddingTop: 12, paddingBottom: 12, gap: 8 }}>
        {step === 'connect' && !connectError ? (
          <Button label="Cancel" variant="ghost" onClick={cancelConnect} testId="wizard-cancel-connect" />
        ) : step === 'connect' ? (
          <>
            <Button label="Back" variant="ghost" onClick={() => setStep(connectError!.fixStep)} testId="wizard-fix" />
            <Button label="Try again" variant="primary" onClick={connect} testId="wizard-retry" />
          </>
        ) : step === 'done' ? (
          <>
            {inline ? null : <Button label="Close" variant="ghost" onClick={onClose} testId="wizard-close-done" />}
            <Button label={inline ? 'Continue' : 'Open inbox'} variant="primary" onClick={() => createdId && onDone(createdId)} testId="wizard-open-inbox" />
          </>
        ) : (
          <>
            <Button label={inline && step === 'provider' ? 'Back' : 'Cancel'} variant="ghost" onClick={onClose} testId="wizard-cancel" />
            {step === 'provider' ? <Button label="Continue" variant="primary" onClick={() => setStep('account')} testId="wizard-next" /> : null}
            {step === 'account' ? (
              <Button label={provider.reviewServers ? 'Continue' : 'Connect'} variant="primary" onClick={nextFromAccount} testId="wizard-next" />
            ) : null}
            {step === 'servers' ? (
              <Button label="Connect" variant="primary" disabled={!serversValid} onClick={connect} testId="wizard-next" />
            ) : null}
          </>
        )}
      </div>
    </Frame>
  )
}
