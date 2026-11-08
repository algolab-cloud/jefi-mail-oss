import { countRender } from './render-counts'
import { motion, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AccountLabelChip, Face } from './primitives'
import { useMail } from './store'
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, SecretInput, SegmentedControl, TextInput, useToggle } from './ui'
import { useKeys } from './keys'
import { REBINDABLE, assignableKey, shortcutList, type ShortcutAction } from './shortcuts'
import { ALL_DAY_ALERTS, TIMED_ALERTS, alertLabel, taskAlertLabel } from './calendar/alerts'
import { ANTHROPIC_MODEL, OPENAI_MODEL, listClaudeModels, listCodexModels, listOpenAIModels, testAnthropicKey, testOpenAIKey, aiErrorMessage, type ModelOption } from './ai'
import { refreshCodex, setAnthropicKey, setOpenAIKey, useAi } from './use-ai'
import { nextCleanupAt, runCleanupNow, useCleanupRunning } from './cleanup-schedule'
import { codexPath, setCodexPath } from './codex-path'
import { pickFile } from './native/file-picker'
import { SIGN_IN_BROWSERS, SIGN_IN_PLATFORMS, browserVersion, inAppSignInAvailable, platformToken, signInUserAgent, webkitVersion } from './native/oauth-window'
import { ACCOUNT_TONES, accountTone, providerFor, type Account } from './accounts'
import { ProviderLogo } from './provider-logo'
import { JefiWordmark, jefiAvatar } from './brand'
import { ACCENTS, DEFAULT_SETTINGS, FONT, TOPBAR_HEIGHT, THEMES, forgetRemoteImageSender, useSettings, type AccentName, type SignInUserAgent, type ThemeName } from './theme'
import { Icon, IconButton } from './icons'
import { APP_VERSION } from './version'
import { checkForUpdates, restartToUpdate, useUpdater } from './use-updater'
import { SectionLabel } from './primitives'
import { normalizeTrustedLinkDomain } from './link-safety'
import { WebRiskError, validateWebRiskKey } from './web-risk'
import { removeWebRiskKey, saveWebRiskKey, useWebRiskKey } from './web-risk-key'
import { LinkProtectionSettings } from './link-protection-settings'
import { NotificationPermissionControl, permissionSummary, useNotificationPermission } from './notification-permission'
import { copyLink } from './native/mail-webview'
import { setupSnippets, snippetDisplayLines } from './headless/setup'
import { toast } from './toast'
import type { SettingsSection } from './deeplink'
import { pageOf, settingsPage, showSettingsPage, useSettingsPage } from './settings-pages'
import { SettingsNav } from './settings-sidebar'
import { openFeedback } from './feedback'

export function Switch({ value, onChange, testId }: { value: boolean; onChange: (value: boolean) => void; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={() => onChange(!value)}
      style={{
        width: 38,
        height: 22,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: value ? C.accent : C.overlayStrong,
        backgroundColor: value ? C.accent : C.overlayStrong,
        flexShrink: 0,
        position: 'relative',
        cursor: 'pointer',
        active: { opacity: 0.85 },
      }}
    >
      <motion.div
        initial={false}
        animate={{ left: value ? 18 : 2 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        style={{
          position: 'absolute',
          top: 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: value ? C.onAccent : C.secondary,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}

export function ThemeCard({ name, label }: { name: ThemeName; label: string }) {
  const { settings, update, C } = useSettings()
  const selected = settings.theme === name
  const t = THEMES[name]
  return (
    <div
      testId={`theme-${name}`}
      onClick={() => update({ theme: name })}
      style={{
        flexGrow: 1,
        flexBasis: 0,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: selected ? C.accent : 'transparent',
        backgroundColor: C.raised,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        paddingRight: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
        hover: { backgroundColor: C.raisedHover },
      }}
    >
      <div
        style={{
          height: 72,
          borderRadius: 6,
          backgroundColor: t.reading,
          borderWidth: 1,
          borderColor: t.border,
          display: 'flex',
          flexDirection: 'row',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: 26,
            backgroundColor: t.sidebar,
            borderRightWidth: 1,
            borderColor: t.divider,
            display: 'flex',
            flexDirection: 'column',
            paddingTop: 8,
            paddingLeft: 5,
            gap: 5,
          }}
        >
          <div style={{ width: 12, height: 4, borderRadius: 2, backgroundColor: t.navSelected }} />
          <div style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
          <div style={{ width: 10, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
        </div>
        <div
          style={{
            width: 44,
            backgroundColor: t.list,
            borderRightWidth: 1,
            borderColor: t.divider,
            display: 'flex',
            flexDirection: 'column',
            paddingTop: 8,
            paddingLeft: 6,
            gap: 6,
          }}
        >
          <div style={{ width: 30, height: 5, borderRadius: 2.5, backgroundColor: t.secondary }} />
          <div style={{ width: 24, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
          <div style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
        </div>
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', paddingTop: 10, paddingLeft: 8, gap: 5 }}>
          <div style={{ width: 60, height: 6, borderRadius: 3, backgroundColor: t.text }} />
          <div style={{ width: 80, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
          <div style={{ width: 70, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
          <div style={{ width: 52, height: 4, borderRadius: 2, backgroundColor: t.ghost }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 2 }}>
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: 7,
            borderWidth: 2,
            borderColor: selected ? C.accent : C.ghost,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          {selected ? <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent }} /> : null}
        </div>
        <text style={{ fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT }}>{label}</text>
      </div>
    </div>
  )
}

export const ACCENT_NAMES: AccentName[] = ['red', 'blue', 'violet', 'green', 'amber']

export function AccentSwatch({ name }: { name: AccentName }) {
  const { settings, update, C } = useSettings()
  const selected = settings.accent === name
  return (
    <div
      testId={`accent-${name}`}
      onClick={() => update({ accent: name })}
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 2,
        borderColor: selected ? C.text : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      <div style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: ACCENTS[name].accent, pointerEvents: 'none' }} />
    </div>
  )
}

export /** Whether this section opens its page: its heading would only repeat the page's title. */
const FirstOnPage = createContext(false)

/** A section's heading, left out when it is the first thing on its page (the title above says it). */
function Heading({ children, top }: { children: string; top?: number }) {
  return useContext(FirstOnPage) ? <div style={{ height: 6, flexShrink: 0 }} /> : <SectionLabel top={top}>{children}</SectionLabel>
}

function SettingsCard({ children }: { children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div
      style={{
        borderRadius: 12,
        backgroundColor: C.raised,
        display: 'flex',
        flexDirection: 'column',
        marginBottom: 24,
      }}
    >
      {children}
    </div>
  )
}

export function CardDivider() {
  const { C } = useSettings()
  return <div style={{ height: 1, flexShrink: 0, backgroundColor: C.overlay, marginLeft: 14, marginRight: 14 }} />
}

/** What macOS allows, re-read every few seconds so a change made in System Settings shows up here. */
function NotificationPermissionRow() {
  const permission = useNotificationPermission()
  useEffect(() => {
    const timer = setInterval(() => void permission.refresh(), 3000)
    return () => clearInterval(timer)
  }, [])
  return (
    <SettingsRow title="Notification permission" sub={permissionSummary(permission.status)}>
      <NotificationPermissionControl permission={permission} />
    </SettingsRow>
  )
}

/** The mail keyboard: which one, and the single keys moved to keys of the person's own. */
function KeyboardSettings() {
  const { C, settings, update } = useSettings()
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null)
  const bindings = { scheme: settings.shortcutScheme, keys: settings.shortcutKeys }
  const list = shortcutList(bindings)
  const setKey = (action: ShortcutAction, key: string | null) => {
    const keys = { ...settings.shortcutKeys }
    if (key) keys[action] = key
    else delete keys[action]
    update({ shortcutKeys: keys })
  }
  // While a key is being chosen, the next press is it: Esc gives up, ⌫ puts the default back.
  useKeys((press) => {
    if (!capturing) return false
    const pressed = press.key?.toLowerCase() ?? ''
    if (pressed === 'escape') setCapturing(null)
    else if (pressed === 'backspace' || pressed === 'delete') {
      setKey(capturing, null)
      setCapturing(null)
    } else if (!press.modifiers?.cmd && !press.modifiers?.ctrl && !press.modifiers?.alt) {
      const key = press.modifiers?.shift ? ({ '/': '?', '3': '#' }[pressed] ?? pressed) : pressed
      if (assignableKey(key)) {
        setKey(capturing, key)
        setCapturing(null)
      }
    }
    return true
  })
  return (
    <>
      <Heading>Keyboard</Heading>
      <SettingsCard>
        <SettingsRow title="Shortcuts" sub={settings.shortcutScheme === 'single' ? 'Single keys, as in Gmail: E archives, R replies, J and K move' : settings.shortcutScheme === 'command' ? 'With ⌘, as in Apple Mail, so a stray key does nothing' : 'No mail shortcuts; ⌘N and ⌘K still work'}>
          <SegmentedControl
            testId="shortcut-scheme"
            value={settings.shortcutScheme}
            options={[
              { value: 'single', label: 'Single keys' },
              { value: 'command', label: '⌘ keys' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(shortcutScheme) => {
              setCapturing(null)
              update({ shortcutScheme })
            }}
          />
        </SettingsRow>
        {settings.shortcutScheme === 'single'
          ? REBINDABLE.map((action) => {
              const row = list.find((s) => s.action === action)
              if (!row) return null
              const own = settings.shortcutKeys[action]
              return (
                <div key={action}>
                  <CardDivider />
                  <SettingsRow title={row.label}>
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {own && capturing !== action ? <Button label="Default" variant="ghost" onClick={() => setKey(action, null)} testId={`shortcut-reset-${action}`} /> : null}
                      <div
                        testId={`shortcut-key-${action}`}
                        onClick={() => setCapturing(capturing === action ? null : action)}
                        style={{ minWidth: 64, height: 26, paddingLeft: 10, paddingRight: 10, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: capturing === action ? C.accent : C.overlay, cursor: 'pointer', hover: { opacity: 0.85 } }}
                      >
                        <text style={{ fontSize: 12.5, fontWeight: 600, color: capturing === action ? C.onAccent : C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                          {capturing === action ? 'Press a key…' : row.keys}
                        </text>
                      </div>
                    </div>
                  </SettingsRow>
                </div>
              )
            })
          : null}
      </SettingsCard>
    </>
  )
}

export function SettingsRow({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  const { C } = useSettings()
  return (
    <div
      style={{
        minHeight: 52,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 14,
        paddingRight: 14,
        paddingTop: 9,
        paddingBottom: 9,
        gap: 16,
      }}
    >
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <text style={{ fontSize: 13.5, fontWeight: 500, color: C.text, fontFamily: FONT }}>{title}</text>
        {sub ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{sub}</text> : null}
      </div>
      {children}
    </div>
  )
}

function SettingsValue({ children }: { children: string }) {
  const { C } = useSettings()
  return <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT, flexShrink: 0 }}>{children}</text>
}

function AccountRow({ account, primary, active }: { account: Account; primary: boolean; active: boolean }) {
  const { C } = useSettings()
  countRender('AccountRow')
  const { accounts, makePrimary, removeAccount, switchAccount, updateAccount } = useMail()
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(account.label ?? '')
  const tone = accountTone(account, accounts)
  const save = () => {
    updateAccount(account.id, { label: draft, color: account.color })
    setEditing(false)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
    <div testId={`settings-account-${account.email}`} style={{ minHeight: 60, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10, gap: 12 }}>
      <div style={{ width: 34, height: 34, flexShrink: 0, position: 'relative' }}>
        <Face {...account.face} size={34} />
        <div style={{ position: 'absolute', right: -4, bottom: -4, width: 18, height: 18, borderRadius: 5, backgroundColor: C.reading, borderWidth: 1, borderColor: C.overlayStrong, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ProviderLogo id={account.provider} size={account.provider === 'yahoo' ? 5 : 11} />
        </div>
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <text style={{ fontSize: 13.5, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0 }}>{account.email}</text>
          {account.label ? <AccountLabelChip label={account.label} color={C[tone]} /> : null}
          {primary ? (
            <div style={{ height: 18, paddingLeft: 7, paddingRight: 7, borderRadius: 9, backgroundColor: C.chip, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <text style={{ fontSize: 11, color: C.secondary, fontFamily: FONT }}>Primary</text>
            </div>
          ) : null}
          {active ? <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.accent, flexShrink: 0 }} /> : null}
        </div>
        <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {`${account.name} · ${providerFor(account.provider).label} · ${account.servers.imapHost}`}
        </text>
      </div>
      {confirming ? (
        <>
          <Button label="Cancel" variant="ghost" onClick={() => setConfirming(false)} />
          <Button label="Remove" variant="primary" testId={`confirm-remove-${account.email}`} onClick={() => removeAccount(account.id)} />
        </>
      ) : (
        <>
          <IconButton
            icon="tag"
            size={15}
            pad={28}
            active={editing}
            tooltip={account.label ? 'Edit label' : 'Add a label'}
            testId={`label-${account.email}`}
            onClick={() => {
              setDraft(account.label ?? '')
              setEditing((v) => !v)
            }}
          />
          {!active ? <Button label="Switch" variant="ghost" testId={`switch-${account.email}`} onClick={() => switchAccount(account.id)} /> : null}
          {!primary ? <Button label="Make primary" variant="ghost" testId={`primary-${account.email}`} onClick={() => makePrimary(account.id)} /> : null}
          {accounts.length > 1 ? (
            <Button label="Remove" variant="danger" testId={`remove-${account.email}`} onClick={() => setConfirming(true)} />
          ) : null}
        </>
      )}
    </div>
    {editing ? (
      <div testId={`label-editor-${account.email}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 60, paddingRight: 14, paddingBottom: 12 }}>
        <div style={{ width: 180, flexShrink: 0 }}>
          <TextInput testId={`label-input-${account.email}`} autoFocus value={draft} placeholder="Work, Personal…" onChange={setDraft} onEnter={save} onKey={(key) => key === 'escape' && setEditing(false)} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 6, flexGrow: 1 }}>
          {ACCOUNT_TONES.map((t) => (
            <div
              key={t}
              testId={`label-color-${t}`}
              onClick={() => updateAccount(account.id, { label: account.label, color: t })}
              style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: C[t], cursor: 'pointer', borderWidth: 2, borderColor: t === tone ? C.text : C.raised }}
            />
          ))}
        </div>
        <Button label="Save" variant="primary" testId={`label-save-${account.email}`} onClick={save} />
      </div>
    ) : null}
    </div>
  )
}

/** Pick Claude or OpenAI; OpenAI can use an API key or the locally authenticated Codex CLI. */
function AiSettings() {
  const { settings, update, C } = useSettings()
  const ai = useAi()
  const { key } = ai
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const usingCodex = settings.aiProvider === 'openai' && settings.aiOpenAiMode === 'codex'
  const apiName = settings.aiProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'
  const save = async () => {
    if (!draft.trim() || status?.tone === 'busy') return
    setStatus({ tone: 'busy', text: `Checking the key with ${apiName}…` })
    const result = settings.aiProvider === 'anthropic' ? await testAnthropicKey(draft) : await testOpenAIKey(draft)
    if (!result.ok) return setStatus({ tone: 'error', text: result.error })
    try {
      if (settings.aiProvider === 'anthropic') await setAnthropicKey(draft)
      else await setOpenAIKey(draft)
    } catch {
      // A Keychain that refuses mustn't leave the row on "Checking…" for good.
      return setStatus({ tone: 'error', text: "The key works, but it couldn't be saved to your Keychain. Try again." })
    }
    setDraft('')
    setStatus({ tone: 'ok', text: 'Key saved to your Keychain' })
    update({ aiEnabled: true })
  }
  const remove = async () => {
    try {
      if (settings.aiProvider === 'anthropic') await setAnthropicKey('')
      else await setOpenAIKey('')
    } catch {
      return setStatus({ tone: 'error', text: "Couldn't remove the key from your Keychain. Try again." })
    }
    update({ aiEnabled: false })
    setStatus(null)
  }
  const checkCodex = async () => {
    setStatus({ tone: 'busy', text: 'Checking your ChatGPT sign-in…' })
    const result = await refreshCodex()
    setStatus(result.ok ? { tone: 'ok', text: 'Signed in to ChatGPT' } : { tone: 'error', text: result.error })
  }
  const selectProvider = (provider: 'anthropic' | 'openai') => {
    update({ aiProvider: provider })
    setDraft('')
    setStatus(null)
    if (provider === 'openai' && settings.aiOpenAiMode === 'codex') void refreshCodex()
  }
  const selectOpenAIMode = (aiOpenAiMode: 'api' | 'codex') => {
    update({ aiOpenAiMode })
    setDraft('')
    setStatus(null)
    if (aiOpenAiMode === 'codex') void refreshCodex()
  }
  const masked = key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null
  const providerReady = ai.available
  return (
    <>
      <Heading>AI</Heading>
      <SettingsCard>
        <SettingsRow title="Provider" sub="Choose how Jefi runs summaries and reply drafts.">
          <SegmentedControl
            testId="ai-provider"
            value={settings.aiProvider}
            options={[{ value: 'anthropic', label: 'Claude' }, { value: 'openai', label: 'OpenAI' }]}
            onChange={selectProvider}
          />
        </SettingsRow>
        {settings.aiProvider === 'openai' ? (
          <>
            <CardDivider />
            <SettingsRow title="OpenAI access" sub="Use a metered API key or your ChatGPT plan.">
              <SegmentedControl
                testId="ai-openai-mode"
                value={settings.aiOpenAiMode}
                options={[{ value: 'api', label: 'API key' }, { value: 'codex', label: 'ChatGPT plan' }]}
                onChange={selectOpenAIMode}
              />
            </SettingsRow>
          </>
        ) : null}
        <CardDivider />
        {usingCodex ? (
          <SettingsRow
            title="ChatGPT sign-in"
            sub={!ai.codex.loaded ? 'Checking your ChatGPT sign-in…' : ai.codex.available ? 'Signed in · uses your ChatGPT plan through OpenAI’s Codex CLI' : ai.codex.error ?? 'Install OpenAI’s Codex CLI and run codex login to sign in with ChatGPT.'}
          >
            <Button label={!ai.codex.loaded || status?.tone === 'busy' ? 'Checking…' : 'Check again'} variant="secondary" disabled={!ai.codex.loaded || status?.tone === 'busy'} onClick={() => void checkCodex()} testId="ai-codex-check" />
          </SettingsRow>
        ) : null}
        {usingCodex ? (
          <>
            <CardDivider />
            <CodexPathRow onChecked={setStatus} />
          </>
        ) : null}
        {usingCodex ? null : (
          <>
            <SettingsRow
              title={`${apiName} API key`}
              sub={masked ? `Saved in your Keychain · ${masked}` : settings.aiProvider === 'anthropic' ? 'Create one at console.anthropic.com → API keys. Anthropic bills you for what you use.' : 'Create one at platform.openai.com → API keys. OpenAI bills you for what you use.'}
            >
              {masked ? <Button label="Remove key" variant="danger" onClick={() => void remove()} testId="ai-key-remove" /> : null}
            </SettingsRow>
            {masked ? null : (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14, paddingBottom: 12 }}>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <SecretInput testId="ai-key-input" value={draft} placeholder={settings.aiProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} onChange={setDraft} onEnter={() => void save()} />
                </div>
                <Button label={status?.tone === 'busy' ? 'Checking…' : 'Save key'} variant="primary" disabled={!draft.trim() || status?.tone === 'busy'} onClick={() => void save()} testId="ai-key-save" />
              </div>
            )}
          </>
        )}
        {providerReady ? (
          <>
            <CardDivider />
            <ModelPicker slot={usingCodex ? 'codex' : settings.aiProvider} apiKey={key} />
          </>
        ) : null}
        {status ? (
          <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12 }}>
            <text testId="ai-key-status" style={{ fontSize: 12, color: status.tone === 'error' ? C.accent : C.secondary, fontFamily: FONT }}>{status.text}</text>
          </div>
        ) : null}
        <CardDivider />
        <SettingsRow title="Use AI features" sub={providerReady ? `Summarize conversations and draft replies with ${ai.providerName}` : usingCodex ? 'Sign in to ChatGPT first' : 'Add an API key first'}>
          <Switch testId="toggle-ai" value={settings.aiEnabled && providerReady} onChange={(value) => providerReady && update({ aiEnabled: value })} />
        </SettingsRow>
        <CardDivider />
        <div style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 12 }}>
          <text style={{ fontSize: 12, lineHeight: 17, color: C.muted, fontFamily: FONT }}>
            {settings.aiProvider === 'anthropic'
              ? "Only when you use a feature, the conversation it's about is sent from your Mac to Anthropic's API with your key. Nothing passes through servers we run."
              : usingCodex
                ? "Only when you use a feature, the conversation it's about is sent from your Mac to OpenAI through its official Codex CLI, signed in with your ChatGPT account. Runs are ephemeral and read-only, and nothing passes through servers we run."
                : "Only when you use a feature, the conversation it's about is sent from your Mac to OpenAI's API with your key. Nothing passes through servers we run."}
          </text>
        </div>
      </SettingsCard>
    </>
  )
}

const CLEANUP_ACTION_SUB = {
  review: 'Sorted for you to review under Clean up → Smart. Nothing moves on its own',
  archive: 'Junk is archived. Undo from the notice, or find it in Archive',
  trash: 'Junk goes to Trash. Undo from the notice, or restore it from Trash',
} as const

/** The smart clean-up on a schedule: how often, and what happens to the junk it finds. */
function CleanupSettings() {
  const { settings, update, C } = useSettings()
  const ai = useAi()
  const running = useCleanupRunning()
  const ready = !!ai.connection
  const now = Date.now()
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const next = nextCleanupAt(settings.cleanupSchedule, settings.cleanupLastRunAt, now)
  const last = settings.cleanupLastRunAt ? `Last run ${when(settings.cleanupLastRunAt)}` : 'Not run yet'
  const upcoming = !ready || next === null ? null : next <= now + 60_000 ? 'Next run in the next few minutes' : `Next run ${when(next)}`
  const usingCodex = settings.aiProvider === 'openai' && settings.aiOpenAiMode === 'codex'
  return (
    <>
      <Heading>Inbox clean-up</Heading>
      <SettingsCard>
        {ready ? null : (
          <>
            <SettingsRow title="Needs AI" sub="Clean up sorts mail with your AI provider. Set one up and turn on AI features first">
              <Button label="Open AI settings" variant="secondary" onClick={() => showSettingsPage('ai')} testId="cleanup-open-ai" />
            </SettingsRow>
            <CardDivider />
          </>
        )}
        {ai.available ? (
          <>
            <ModelPicker slot={usingCodex ? 'codex' : settings.aiProvider} apiKey={ai.key} field="cleanupModels" />
            <CardDivider />
          </>
        ) : null}
        <SettingsRow title="Clean up automatically" sub={"Sorts every account's Inbox while Jefi is open, with the clean-up model"}>
          <SegmentedControl
            testId="cleanup-schedule"
            value={settings.cleanupSchedule}
            options={[{ value: 'off', label: 'Off' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]}
            onChange={(cleanupSchedule) => update({ cleanupSchedule })}
          />
        </SettingsRow>
        <CardDivider />
        <SettingsRow title="Junk it finds" sub={CLEANUP_ACTION_SUB[settings.cleanupAction]}>
          <SegmentedControl
            testId="cleanup-action"
            value={settings.cleanupAction}
            options={[{ value: 'review', label: 'Just sort' }, { value: 'archive', label: 'Archive' }, { value: 'trash', label: 'Trash' }]}
            onChange={(cleanupAction) => update({ cleanupAction })}
          />
        </SettingsRow>
        <CardDivider />
        <SettingsRow title={running ? 'Cleaning up…' : last} sub={running ? 'Sorting senders in every Inbox' : [settings.cleanupLastRunAt ? settings.cleanupLastSummary : '', upcoming ?? 'Runs only when you choose Run now'].filter(Boolean).join(' · ')}>
          <Button label={running ? 'Running…' : 'Run now'} variant="secondary" disabled={!ready || running} onClick={() => void runCleanupNow()} testId="cleanup-run-now" />
        </SettingsRow>
        <CardDivider />
        <div style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 12 }}>
          <text style={{ fontSize: 12, lineHeight: 17, color: C.muted, fontFamily: FONT }}>
            Only senders the AI calls junk are touched: never ones it isn't sure about, anyone you write to or answer, senders whose mail you flagged, or senders you chose to keep. Their receipts, codes and account notices stay put, and real mail found in Spam is only pointed out, never moved for you. Sender names, addresses, subject lines and short previews go to your AI provider; full messages don't.
          </text>
        </div>
      </SettingsCard>
    </>
  )
}

/**
 * Which model a provider runs. The list comes from the provider itself (Anthropic's and OpenAI's
 * model lists with the saved key, or the Codex CLI's catalog); any other model id can be typed in.
 */
/**
 * Where the Codex CLI is. Jefi looks in the usual places, but an app opened from Finder inherits
 * almost no PATH, so an unusual install needs pointing at by hand.
 */
function CodexPathRow({ onChecked }: { onChecked: (status: { tone: 'ok' | 'error' | 'busy'; text: string } | null) => void }) {
  const { settings, update } = useSettings()
  const found = codexPath()
  const set = (path: string) => {
    update({ aiCodexPath: path })
    setCodexPath(path)
    onChecked({ tone: 'busy', text: 'Checking the Codex CLI…' })
    void refreshCodex().then((result) => onChecked(result.ok ? { tone: 'ok', text: `Using ${codexPath() ?? 'codex'}` } : { tone: 'error', text: result.error }))
  }
  const choose = () => {
    const picked = pickFile('Use this', 'Choose the codex command (run “which codex” in Terminal to find it)')
    if (picked) set(picked)
  }
  return (
    <SettingsRow
      title="Codex CLI"
      sub={settings.aiCodexPath ? `Set by you · ${settings.aiCodexPath}` : found ? `Found at ${found}` : 'Not found. Choose it, or install the Codex CLI.'}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {settings.aiCodexPath ? <Button label="Clear" variant="ghost" onClick={() => set('')} testId="ai-codex-path-clear" /> : null}
        <Button label="Choose…" variant="secondary" onClick={choose} testId="ai-codex-path" />
      </div>
    </SettingsRow>
  )
}

function ModelPicker({ slot, apiKey, field = 'aiModels' }: { slot: 'anthropic' | 'openai' | 'codex'; apiKey: string | null; /** The main model, or the one clean-up sorts senders with. */ field?: 'aiModels' | 'cleanupModels' }) {
  const { settings, update, C } = useSettings()
  const menu = useToggle()
  const [models, setModels] = useState<{ slot: string; list: ModelOption[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const forCleanup = field === 'cleanupModels'
  const chosen = settings[field][slot]
  const builtIn = slot === 'anthropic' ? ANTHROPIC_MODEL : slot === 'openai' ? OPENAI_MODEL : 'set by ChatGPT'
  // Clean-up falls back to the main model, whatever that is.
  const fallback = forCleanup ? settings.aiModels[slot] || builtIn : builtIn
  const defaultLabel = forCleanup ? `Same as Model · ${fallback}` : `Default · ${fallback}`
  const tid = forCleanup ? 'ai-cleanup-model' : 'ai-model'
  const choose = (model: string) => {
    update({ [field]: { ...settings[field], [slot]: model.trim() } })
    menu.close()
  }
  const open = () => {
    menu.toggle()
    if (models?.slot === slot) return
    setError(null)
    const load = slot === 'anthropic' ? (apiKey ? listClaudeModels(apiKey) : Promise.resolve([])) : slot === 'openai' ? (apiKey ? listOpenAIModels(apiKey) : Promise.resolve([])) : listCodexModels()
    load.then((list) => setModels({ slot, list })).catch((e) => setError(aiErrorMessage(e)))
  }
  const list = models?.slot === slot ? models.list : null
  const label = chosen ? (list?.find((m) => m.id === chosen)?.label ?? chosen) : defaultLabel
  return (
    <SettingsRow title={forCleanup ? 'Clean-up model' : 'Model'} sub={forCleanup ? 'Sorts senders for Clean up. A smaller, faster model works well and costs less' : 'Used for summaries, reply drafts and the assistant'}>
      <div style={{ flexShrink: 0, position: 'relative' }}>
        <div
          testId={`${tid}`}
          onClick={open}
          style={{ height: 30, paddingLeft: 10, paddingRight: 8, gap: 6, borderRadius: 15, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
        >
          <text style={{ fontSize: 12.5, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{label}</text>
          <Icon name="chevronDown" size={13} color={C.muted} />
        </div>
        <Menu open={menu.open} onClose={menu.close} align="end" width={300} testId={`${tid}-menu`}>
          <MenuItem label={defaultLabel} checked={!chosen} onSelect={() => choose('')} testId={`${tid}-default`} />
          <MenuSeparator />
          <MenuLabel>{slot === 'codex' ? 'ChatGPT models' : slot === 'anthropic' ? 'Claude models on your key' : 'OpenAI models on your key'}</MenuLabel>
          <div style={{ maxHeight: 280, overflowY: 'scroll', display: 'flex', flexDirection: 'column' }}>
            {error ? (
              <text style={{ fontSize: 12, color: C.accent, fontFamily: FONT, paddingLeft: 10, paddingTop: 4, paddingBottom: 6 }}>{error}</text>
            ) : !list ? (
              <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, paddingLeft: 10, paddingTop: 4, paddingBottom: 6 }}>Loading…</text>
            ) : (
              list.map((m) => <MenuItem key={m.id} label={m.label} hint={m.label !== m.id ? m.id : undefined} checked={chosen === m.id} onSelect={() => choose(m.id)} testId={`${tid}-${m.id}`} />)
            )}
          </div>
          <MenuSeparator />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4 }}>
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <TextInput testId={`${tid}-custom`} value={custom} placeholder="Other model id" onChange={setCustom} onEnter={() => custom.trim() && choose(custom)} />
            </div>
            <Button label="Use" variant="ghost" disabled={!custom.trim()} onClick={() => choose(custom)} testId={`${tid}-custom-use`} />
          </div>
        </Menu>
      </div>
    </SettingsRow>
  )
}

/** The default alert for one kind of event or task: a menu of the presets the editors offer too. */
function AlertPicker({ allDay, setting = allDay ? 'defaultAllDayAlert' : 'defaultAlert', testId = allDay ? 'default-all-day-alert' : 'default-alert' }: {
  allDay: boolean
  setting?: 'defaultAlert' | 'defaultAllDayAlert' | 'defaultTaskAlert' | 'defaultTaskAllDayAlert'
  testId?: string
}) {
  const { settings, update, C } = useSettings()
  const menu = useToggle()
  const value = settings[setting]
  const label = setting === 'defaultTaskAlert' ? taskAlertLabel : alertLabel
  const choose = (next: number | null) => {
    update({ [setting]: next })
    menu.close()
  }
  return (
    <div style={{ flexShrink: 0, position: 'relative' }}>
      <div
        testId={testId}
        onClick={menu.toggle}
        style={{ height: 30, paddingLeft: 10, paddingRight: 8, gap: 6, borderRadius: 15, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
      >
        <text style={{ fontSize: 12.5, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{value === null ? 'None' : label(value, allDay)}</text>
        <Icon name="chevronDown" size={13} color={C.muted} />
      </div>
      <Menu open={menu.open} onClose={menu.close} align="end" width={220} testId={`${testId}-menu`}>
        <MenuItem label="None" checked={value === null} onSelect={() => choose(null)} testId={`${testId}-none`} />
        <MenuSeparator />
        {(allDay ? ALL_DAY_ALERTS : TIMED_ALERTS).map((m) => (
          <MenuItem key={m} label={label(m, allDay)} checked={value === m} onSelect={() => choose(m)} testId={`${testId}-${m}`} />
        ))}
      </Menu>
    </div>
  )
}

/** The running version, what the updater is doing about a newer one, and the switch for it. */
function UpdateRows() {
  const { settings, update } = useSettings()
  const updates = useUpdater()
  const busy = updates.status === 'checking' || updates.status === 'downloading'
  if (updates.status === 'unofficial') {
    return (
      <SettingsRow title={`Version ${APP_VERSION}`} sub="Built from source, so it doesn’t update itself. Official releases are at jefi.app" />
    )
  }
  const sub =
    updates.status === 'checking'
      ? 'Checking for a newer version…'
      : updates.status === 'downloading'
        ? `Downloading Jefi ${updates.version}…`
        : updates.status === 'ready'
          ? `Jefi ${updates.version} is ready. It installs when you restart.`
          : updates.status === 'manual'
            ? `Jefi ${updates.version} is out. Move Jefi to Applications to update automatically, or download it.`
            : updates.status === 'error'
              ? `Couldn't update: ${updates.message}`
              : updates.status === 'current'
                ? 'Jefi is up to date'
                : undefined
  return (
    <>
      <SettingsRow title={`Version ${APP_VERSION}`} sub={sub}>
        {updates.status === 'ready' ? (
          <Button label="Restart to update" variant="primary" onClick={() => void restartToUpdate()} testId="update-restart" />
        ) : updates.status === 'manual' ? (
          <Button label="Download" variant="secondary" onClick={() => void Bun.spawn(['open', updates.url], { stdout: 'ignore', stderr: 'ignore' })} testId="update-download" />
        ) : (
          <Button label={busy ? 'Checking…' : 'Check for updates'} variant="ghost" disabled={busy} onClick={() => void checkForUpdates()} testId="update-check" />
        )}
      </SettingsRow>
      <CardDivider />
      <SettingsRow title="Update automatically" sub="Download new versions in the background and install them on the next restart">
        <Switch testId="toggle-auto-update" value={settings.autoUpdate} onChange={(autoUpdate) => update({ autoUpdate })} />
      </SettingsRow>
    </>
  )
}

/** A short list is worth reading at a glance; a long one waits behind "Show". */
const SENDERS_SHOWN = 4

/**
 * The remote-image policy and the senders trusted so far. A grant that can't be taken back isn't a
 * privacy setting, so every allowed address is listed here with a way to forget it.
 */
function RemoteImageRows() {
  const { settings, update, C } = useSettings()
  const allowed = settings.remoteImageSenders
  const [expanded, setExpanded] = useState(false)
  const listed = expanded || allowed.length <= SENDERS_SHOWN
  return (
    <>
      <SettingsRow title="Remote images" sub="Images a sender's server has to be asked for tell them when you read their mail">
        <SegmentedControl
          testId="remote-images"
          value={settings.remoteImages}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'always', label: 'Always show' },
          ]}
          onChange={(remoteImages) => update({ remoteImages })}
        />
      </SettingsRow>
      {allowed.length ? (
        <>
          <CardDivider />
          <SettingsRow
            title="Allowed senders"
            sub={`${allowed.length === 1 ? '1 sender' : `${allowed.length} senders`} whose remote images load without asking`}
          >
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {allowed.length > SENDERS_SHOWN ? (
                <Button label={expanded ? 'Hide' : 'Show'} variant="ghost" onClick={() => setExpanded((v) => !v)} testId="remote-images-show-allowed" />
              ) : null}
              <Button label="Forget all" variant="ghost" onClick={() => update({ remoteImageSenders: [] })} testId="remote-images-forget-all" />
            </div>
          </SettingsRow>
          {listed ? (
            <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {allowed.map((email) => (
                <div
                  key={email}
                  style={{
                    height: 30,
                    paddingLeft: 10,
                    paddingRight: 4,
                    borderRadius: 6,
                    backgroundColor: C.overlay,
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    {email}
                  </text>
                  <IconButton
                    icon="x"
                    size={13}
                    pad={22}
                    tooltip="Hide images from this sender again"
                    onClick={() => update({ remoteImageSenders: forgetRemoteImageSender(settings, email) })}
                    testId={`remote-images-forget-${email}`}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  )
}

function TrustedLinkDomainRows() {
  const { settings, update, C } = useSettings()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const domains = settings.trustedLinkDomains
  const listed = expanded || domains.length <= SENDERS_SHOWN

  const add = () => {
    const domain = normalizeTrustedLinkDomain(draft)
    if (!domain) {
      setError('Enter a valid hostname, such as example.com.')
      return
    }
    if (domains.includes(domain)) {
      setError(`${domain} is already trusted.`)
      return
    }
    update({ trustedLinkDomains: [...domains, domain] })
    setDraft('')
    setError(null)
    setExpanded(true)
  }

  return (
    <>
      <SettingsRow
        title="Trusted link domains"
        sub="Trust applies to this exact host only. It does not prove a link is safe or allow remote images."
      >
        <div style={{ width: 270, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <TextInput
                testId="trusted-link-domain-input"
                value={draft}
                placeholder="example.com"
                invalid={!!error}
                onChange={(value) => {
                  setDraft(value)
                  setError(null)
                }}
                onEnter={add}
              />
            </div>
            <Button label="Add" onClick={add} disabled={!draft.trim()} testId="trusted-link-domain-add" />
          </div>
          {error ? <text testId="trusted-link-domain-error" style={{ fontSize: 12, color: C.accent, fontFamily: FONT }}>{error}</text> : null}
        </div>
      </SettingsRow>
      {domains.length ? (
        <>
          <CardDivider />
          <SettingsRow
            title={domains.length === 1 ? '1 trusted domain' : `${domains.length} trusted domains`}
            sub="Links to other hosts still show a warning before opening"
          >
            {domains.length > SENDERS_SHOWN ? (
              <Button label={expanded ? 'Hide' : 'Show'} variant="ghost" onClick={() => setExpanded((value) => !value)} testId="trusted-link-domains-show" />
            ) : null}
          </SettingsRow>
          {listed ? (
            <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {domains.map((domain) => (
                <div
                  key={domain}
                  style={{
                    height: 30,
                    paddingLeft: 10,
                    paddingRight: 4,
                    borderRadius: 6,
                    backgroundColor: C.overlay,
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    {domain}
                  </text>
                  <IconButton
                    icon="x"
                    size={13}
                    pad={22}
                    tooltip={`Stop trusting ${domain}`}
                    onClick={() => update({ trustedLinkDomains: domains.filter((item) => item !== domain) })}
                    testId={`trusted-link-domain-remove-${domain}`}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  )
}

export function GoogleWebRiskRows() {
  const { C } = useSettings()
  const webRisk = useWebRiskKey()
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyLock = useRef(false)

  const save = async () => {
    const key = draft.trim()
    if (!key || busyLock.current) return
    busyLock.current = true
    setBusy(true)
    setStatus({ tone: 'busy', text: 'Checking access with Google using example.com…' })
    try {
      await validateWebRiskKey(key)
      await saveWebRiskKey(key)
      setDraft('')
      setStatus({ tone: 'ok', text: 'API key saved to your Keychain' })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof WebRiskError ? error.message : "Couldn't save the API key to Keychain.",
      })
    } finally {
      busyLock.current = false
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busyLock.current) return
    busyLock.current = true
    setBusy(true)
    setStatus({ tone: 'busy', text: 'Removing the API key…' })
    try {
      await removeWebRiskKey()
      setStatus(null)
    } catch {
      setStatus({ tone: 'error', text: "Couldn't remove the API key from Keychain." })
    } finally {
      busyLock.current = false
      setBusy(false)
    }
  }

  const keySub = !webRisk.loaded
    ? 'Checking your Keychain…'
    : webRisk.error
      ? webRisk.error
      : webRisk.configured
        ? 'Saved in your Keychain. Checks run only when you choose Check with Google.'
        : 'Optional. Save and check tests your key with example.com. Usage is billed to your Google Cloud project.'

  return (
    <>
      <SettingsRow title="Google Web Risk" sub={keySub}>
        {webRisk.configured ? (
          <Button label={busy ? 'Removing…' : 'Remove key'} variant="danger" disabled={busy} onClick={() => void remove()} testId="web-risk-key-remove" />
        ) : null}
      </SettingsRow>
      {!webRisk.loaded || webRisk.configured ? null : (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14, paddingBottom: 12 }}>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <SecretInput testId="web-risk-key-input" value={draft} placeholder="Google Cloud API key" onChange={(value) => {
              if (busyLock.current) return
              setDraft(value)
              setStatus(null)
            }} onEnter={() => void save()} />
          </div>
          <Button label={busy ? 'Checking…' : 'Save and check'} variant="primary" disabled={!draft.trim() || busy} onClick={() => void save()} testId="web-risk-key-save" />
        </div>
      )}
      {status ? (
        <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 10 }}>
          <text testId="web-risk-key-status" style={{ fontSize: 12, color: status.tone === 'error' ? C.accent : C.secondary, fontFamily: FONT }}>{status.text}</text>
        </div>
      ) : null}
      <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12 }}>
        <text style={{ fontSize: 12, lineHeight: 17, color: C.muted, fontFamily: FONT }}>
          Results are provided by Google Web Risk, which can miss risky sites and flag legitimate sites by mistake. Jefi sends nothing to Google when you read or hover. When you choose Check with Google, the complete clicked HTTP(S) URL—including private path or query tokens—is sent directly from your Mac to Google with your API key. No match in Google's list is not a safety guarantee.
        </text>
      </div>
    </>
  )
}

/** The user agent of the in-app sign-in window (Microsoft), part by part. */
function SignInSettings() {
  const { settings, update, C } = useSettings()
  const ua = settings.signInUserAgent
  const set = (patch: Partial<SignInUserAgent>) => update({ signInUserAgent: { ...ua, ...patch } })
  const field = (key: keyof SignInUserAgent, title: string, sub: string, placeholder: string) => (
    <SettingsRow title={title} sub={sub}>
      <div style={{ width: 260, flexShrink: 0 }}>
        <TextInput testId={`signin-ua-${key}`} value={ua[key]} placeholder={placeholder} onChange={(value) => set({ [key]: value })} />
      </div>
    </SettingsRow>
  )
  const d = DEFAULT_SETTINGS.signInUserAgent
  const customized = (Object.keys(ua) as Array<keyof SignInUserAgent>).some((key) => ua[key].trim() !== d[key])
  return (
    <>
      <Heading>Sign-in window</Heading>
      <SettingsCard>
        <SettingsRow title="Browser" sub="The browser the sign-in page thinks it's in">
          <SegmentedControl testId="signin-ua-family" value={ua.family} options={SIGN_IN_BROWSERS} onChange={(family) => set({ family })} />
        </SettingsRow>
        <CardDivider />
        <SettingsRow title="Operating system" sub="The system the sign-in page thinks it's on">
          <SegmentedControl testId="signin-ua-platform" value={ua.platform} options={SIGN_IN_PLATFORMS} onChange={(platform) => set({ platform })} />
        </SettingsRow>
        <CardDivider />
        {field('os', 'Platform token', 'Overrides the operating system above', platformToken(ua.platform, ua.family))}
        <CardDivider />
        {field('browser', 'Browser version', 'Leave empty for a current release', browserVersion(ua.family))}
        {ua.family === 'firefox' ? null : (
          <>
            <CardDivider />
            {field('webkit', 'WebKit version', 'Engine build reported to the provider', webkitVersion(ua.family))}
          </>
        )}
        <CardDivider />
        {field('suffix', 'Suffix', 'Added to the end, e.g. Jefi/0.1', 'None')}
        <CardDivider />
        {field('custom', 'Custom user agent', 'Replaces everything above when set', 'Built from the fields above')}
        <CardDivider />
        <div style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{signInUserAgent(ua)}</text>
          {customized ? (
            <div style={{ display: 'flex', flexDirection: 'row' }}>
              <Button label="Reset to default" variant="ghost" onClick={() => update({ signInUserAgent: DEFAULT_SETTINGS.signInUserAgent })} testId="signin-ua-reset" />
            </div>
          ) : null}
        </div>
      </SettingsCard>
    </>
  )
}

/** One setup snippet: where it goes, the text in a monospace block, and a button that copies it. */
function SetupSnippetRow({ id, title, where, text }: { id: string; title: string; where: string; text: string }) {
  const { C } = useSettings()
  const copy = () => (copyLink(text) ? toast.success(`${title} setup copied`) : toast.error("Couldn't copy"))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <text style={{ fontSize: 13.5, fontWeight: 500, color: C.text, fontFamily: FONT }}>{title}</text>
          <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{where}</text>
        </div>
        <Button label="Copy" variant="ghost" onClick={copy} testId={`copy-setup-${id}`} />
      </div>
      {/* Wrapped lines rather than <code>, which paints each line on one row and cut long paths off at the edge. */}
      <div testId={`setup-text-${id}`} style={{ borderRadius: 9, backgroundColor: C.overlay, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, display: 'flex', flexDirection: 'column' }}>
        {snippetDisplayLines(text).map((line, i) => (
          <text key={i} style={{ width: '100%', minWidth: 0, color: C.text, fontSize: 11.5, lineHeight: 17, fontFamily: 'Menlo' }}>
            {line || '\u00a0'}
          </text>
        ))}
      </div>
    </div>
  )
}

/**
 * Settings → Integrations: the MCP server stays off until turned on here, since it hands mail to an
 * AI app. The command line is shown either way; it reads the same files any local process can.
 */
function IntegrationSettings() {
  const { settings, update } = useSettings()
  const snippets = setupSnippets()
  const mcp = snippets.filter((snippet) => snippet.id !== 'cli')
  const cli = snippets.find((snippet) => snippet.id === 'cli')!
  return (
    <>
      <Heading>Integrations</Heading>
      <SettingsCard>
        <SettingsRow title="Allow AI apps to read Jefi (MCP)" sub="AI apps can read your mail, calendar and notes. Nothing is sent or changed without you">
          <Switch testId="toggle-mcp" value={settings.mcpEnabled} onChange={(mcpEnabled) => update({ mcpEnabled })} />
        </SettingsRow>
        {settings.mcpEnabled
          ? mcp.map((snippet) => (
              <div key={snippet.id} style={{ display: 'flex', flexDirection: 'column' }}>
                <CardDivider />
                <SetupSnippetRow {...snippet} />
              </div>
            ))
          : null}
        <CardDivider />
        <SetupSnippetRow {...cli} />
      </SettingsCard>
    </>
  )
}

/**
 * Settings, optionally scrolled to one section: jefi://settings/<section> asks for one, and `key`
 * changes with every request so asking for the same section again scrolls back to it.
 */
/**
 * Settings, one page at a time. The pages and their groups are in settings-pages.ts; the sidebar
 * lists them (settings-sidebar.tsx), or, with the sidebar hidden, `nav` puts the list in the pane.
 */
export function SettingsPane({ onAddAccount, focus, nav = false }: { onAddAccount: () => void; focus?: { section: SettingsSection; key: number } | null; nav?: boolean }) {
  const { settings, update, C, windowStyle } = useSettings()
  countRender('SettingsPane')
  const { accounts, account: activeAccount, offline, setOffline, syncNow, sync, screenerOn, setScreener } = useMail()
  const pageId = useSettingsPage()
  const renderer = useGpuixRequired()
  const scrollRef = useRef<PublicInstance>(null)
  const sectionRefs = useRef(new Map<SettingsSection, PublicInstance | null>())
  // A link or "Open Settings" button names a section: open the page that holds it, and when the
  // section isn't the first thing there (Sign-in window under Accounts, say), scroll down to it.
  useEffect(() => {
    if (!focus) return
    showSettingsPage(pageOf(focus.section))
    // The page's scrollable height isn't known on its first layout (a scroll then is clamped to
    // nothing), so this measures and scrolls a few times, like the calendar does, until it's there.
    let done = false
    const scrollToSection = () => {
      const scroll = scrollRef.current
      const target = sectionRefs.current.get(focus.section)
      const box = scroll ? renderer.getElementBounds?.(scroll.id) : null
      const at = target ? renderer.getElementBounds?.(target.id) : null
      if (done || !scroll || !box || !at) return
      const below = at.y - box.y
      if (below <= 2) return void (done = true)
      const offset = Math.abs(renderer.getScrollOffset?.(scroll.id)?.[1] ?? 0)
      renderer.scrollTo?.(scroll.id, 0, -(offset + below))
    }
    const timers = [50, 250, 700, 1200].map((ms) => setTimeout(scrollToSection, ms))
    return () => timers.forEach(clearTimeout)
  }, [focus?.key])
  const nodes: Record<SettingsSection, ReactNode> = {
    appearance: (
      <>
        <Heading top={4}>Appearance</Heading>
        <SettingsCard>
          <div style={{ paddingTop: 12, paddingLeft: 14, paddingRight: 14, display: 'flex', flexDirection: 'row', gap: 10 }}>
            <ThemeCard name="dark" label="Dark" />
            <ThemeCard name="light" label="Light" />
          </div>
          <CardDivider />
          <SettingsRow
            title="Style"
            sub={settings.style !== (windowStyle ?? settings.style) ? 'Restart Jefi to see the change' : 'Liquid Glass lets your desktop show softly through the window'}
          >
            <SegmentedControl
              testId="style"
              value={settings.style}
              options={[
                { value: 'default', label: 'Default' },
                { value: 'glass', label: 'Liquid Glass' },
              ]}
              onChange={(style) => update({ style })}
            />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Accent" sub="Send button, unread markers, and highlights">
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8, flexShrink: 0 }}>
              {ACCENT_NAMES.map((name) => (
                <AccentSwatch key={name} name={name} />
              ))}
            </div>
          </SettingsRow>
        </SettingsCard>
      </>
    ),
    mailbox: (
      <>
        <Heading>Mailbox</Heading>
        <SettingsCard>
          <SettingsRow title="Unread counts" sub="Show unread badges next to folders">
            <Switch
              testId="toggle-unread-counts"
              value={settings.unreadCounts}
              onChange={(value) => update({ unreadCounts: value })}
            />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Undo send" sub="How long a sent message waits in the Outbox before it goes out">
            <SegmentedControl
              testId="undo-send"
              value={String(settings.undoSendSeconds) as '0' | '5' | '10' | '20'}
              options={[
                { value: '0', label: 'Off' },
                { value: '5', label: '5s' },
                { value: '10', label: '10s' },
                { value: '20', label: '20s' },
              ]}
              onChange={(value) => update({ undoSendSeconds: Number(value) as 0 | 5 | 10 | 20 })}
            />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Screen new senders" sub="Mail from people you haven't heard from before waits in the Screener until you allow or block them">
            <Switch testId="toggle-screener" value={screenerOn} onChange={setScreener} />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="List snippets" sub="Show message previews in the inbox list">
            <Switch testId="toggle-snippets" value={settings.snippets} onChange={(value) => update({ snippets: value })} />
          </SettingsRow>
        </SettingsCard>
      </>
    ),
    keyboard: <KeyboardSettings />,
    privacy: (
      <>
        <Heading>Privacy and link protection</Heading>
        <SettingsCard>
          <RemoteImageRows />
          <CardDivider />
          <TrustedLinkDomainRows />
          <CardDivider />
          <LinkProtectionSettings />
          <CardDivider />
          <GoogleWebRiskRows />
        </SettingsCard>
      </>
    ),
    accounts: (
      <>
        <Heading>Accounts</Heading>
        <SettingsCard>
          {accounts.map((item, index) => (
            <div key={item.id}>
              {index > 0 ? <CardDivider /> : null}
              <AccountRow account={item} primary={index === 0} active={item.id === activeAccount.id} />
            </div>
          ))}
          <CardDivider />
          <div
            testId="settings-add-account"
            onClick={onAddAccount}
            style={{ cursor: 'pointer', borderBottomLeftRadius: 8, borderBottomRightRadius: 8, hover: { backgroundColor: C.overlay } }}
          >
            <SettingsRow title="Add account" sub="Gmail, Outlook, iCloud, Fastmail, Yahoo, or any IMAP server">
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                {(['gmail', 'outlook', 'icloud', 'fastmail'] as const).map((id) => (
                  <ProviderLogo key={id} id={id} size={16} />
                ))}
                <ProviderLogo id="yahoo" size={8} />
                <Icon name="plus" size={16} color={C.secondary} />
              </div>
            </SettingsRow>
          </div>
        </SettingsCard>
      </>
    ),
    ai: <AiSettings />,
    cleanup: <CleanupSettings />,
    signin: (
      <>
        {inAppSignInAvailable ? <SignInSettings /> : null}
      </>
    ),
    calendar: (
      <>
        <Heading>Calendar</Heading>
        <SettingsCard>
          <SettingsRow title="Event alerts" sub="For timed events that don't choose their own">
            <AlertPicker allDay={false} />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="All-day event alerts" sub="Times are on your clock, on the day or before it">
            <AlertPicker allDay />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Show tasks in the calendar" sub="Tasks with a due date appear on their day, and open in Tasks">
            <Switch testId="toggle-calendar-tasks" value={settings.calendarShowsTasks} onChange={(calendarShowsTasks) => update({ calendarShowsTasks })} />
          </SettingsRow>
        </SettingsCard>
      </>
    ),
    tasks: (
      <>
        <Heading>Tasks</Heading>
        <SettingsCard>
          <SettingsRow title="Task reminders" sub="For tasks due at a time that don't choose their own">
            <AlertPicker allDay={false} setting="defaultTaskAlert" testId="default-task-alert" />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Tasks due on a day" sub="Times are on your clock, on the day or before it">
            <AlertPicker allDay setting="defaultTaskAllDayAlert" testId="default-task-all-day-alert" />
          </SettingsRow>
        </SettingsCard>
      </>
    ),
    sync: (
      <>
        <Heading>Sync</Heading>
        <SettingsCard>
          <SettingsRow
            title="Sync now"
            sub={sync.status === 'syncing' ? `Fetching ${sync.phase ?? 'mail'} for ${activeAccount.email}…` : `Fetch new mail for ${activeAccount.email}`}
          >
            <Button label={sync.status === 'syncing' ? 'Syncing…' : 'Sync'} disabled={sync.status === 'syncing'} onClick={syncNow} testId="settings-sync-now" />
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="New mail banners" sub="Show a Notification Center banner when mail arrives and Jefi isn't in front">
            <Switch testId="toggle-notifications" value={settings.notifications} onChange={(notifications) => update({ notifications })} />
          </SettingsRow>
          <CardDivider />
          <NotificationPermissionRow />
          <CardDivider />
          <SettingsRow title="Simulate offline" sub="Developer: make sync and sending fail to test error states">
            <Switch testId="toggle-offline" value={offline} onChange={setOffline} />
          </SettingsRow>
        </SettingsCard>
      </>
    ),
    menubar: (
      <>
        <Heading>Menu bar</Heading>
        <SettingsCard>
          <SettingsRow title="Keep Jefi in the menu bar" sub="Closing the window leaves Jefi running there, so mail keeps syncing and banners keep coming. Quit from its menu">
            <Switch testId="toggle-menu-bar" value={settings.menuBar} onChange={(menuBar) => update({ menuBar })} />
          </SettingsRow>
          {settings.menuBar ? (
            <>
              <CardDivider />
              <SettingsRow title="Beside the icon" sub="Kept short: a long title can disappear under the camera notch">
                <SegmentedControl
                  testId="menu-bar-title"
                  value={settings.menuBarTitle}
                  options={[{ value: 'none', label: 'Nothing' }, { value: 'unread', label: 'Unread' }, { value: 'next', label: 'Next event' }]}
                  onChange={(menuBarTitle) => update({ menuBarTitle })}
                />
              </SettingsRow>
              <CardDivider />
              <SettingsRow title="Hide the Dock icon when the window is closed" sub="Jefi then lives only in the menu bar until you open it again">
                <Switch testId="toggle-hide-dock" value={settings.hideDockWhenClosed} onChange={(hideDockWhenClosed) => update({ hideDockWhenClosed })} />
              </SettingsRow>
            </>
          ) : null}
        </SettingsCard>
      </>
    ),
    integrations: <IntegrationSettings />,
    about: (
      <>
        <Heading>About</Heading>
        <SettingsCard>
          <div testId="about-brand" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 14, paddingRight: 14, paddingTop: 14, paddingBottom: 14 }}>
            <img src={jefiAvatar(C.accent)} objectFit="contain" style={{ width: 52, height: 52, borderRadius: 12 }} />
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <JefiWordmark height={22} color={C.text} />
              <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{`Your mail, in a better light · Version ${APP_VERSION}`}</text>
            </div>
          </div>
          <CardDivider />
          <SettingsRow title="Welcome tour" sub="Walk through first-launch setup again">
            <Button label="Replay onboarding" variant="ghost" onClick={() => update({ onboarded: false })} testId="replay-onboarding" />
          </SettingsRow>
          <CardDivider />
          <UpdateRows />
          <CardDivider />
          <SettingsRow title="Feedback" sub="Found a bug, or missing something? Tell us from here">
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <Button label="Report a bug" variant="ghost" onClick={() => openFeedback('bug')} testId="settings-report-bug" />
              <Button label="Request a feature" variant="ghost" onClick={() => openFeedback('feature')} testId="settings-request-feature" />
            </div>
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Licence" sub="Free and open source software">
            <SettingsValue>GPL-3.0</SettingsValue>
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Renderer">
            <SettingsValue>GPUIX</SettingsValue>
          </SettingsRow>
          <CardDivider />
          <SettingsRow title="Typography">
            <SettingsValue>Geist</SettingsValue>
          </SettingsRow>
        </SettingsCard>
      </>
    ),
  }
  const page = settingsPage(pageId)

  return (
    <div testId="settings" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'row', backgroundColor: C.list }}>
      {nav ? (
        <div style={{ width: 220, flexShrink: 0, height: '100%', paddingTop: TOPBAR_HEIGHT - 14, display: 'flex', flexDirection: 'column', borderRightWidth: 1, borderColor: C.divider }}>
          <SettingsNav />
        </div>
      ) : null}
      <div style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingLeft: 24, paddingRight: 24 }}>
          <div style={{ width: '100%', maxWidth: 640, paddingLeft: 24, paddingRight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name={page.icon} size={17} color={C.secondary} />
            <text testId="settings-title" style={{ fontSize: 19, fontWeight: 600, color: C.text, fontFamily: FONT }}>{page.label}</text>
          </div>
        </div>
        {/* Keyed by page (and by link), so each opens at its top before scrolling to what was asked for. */}
        <div key={`${pageId}-${focus?.key ?? ''}`} ref={scrollRef} testId="settings-scroll" style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div testId={`settings-page-${pageId}`} style={{ width: '100%', maxWidth: 640, paddingLeft: 24, paddingRight: 24, paddingBottom: 32, display: 'flex', flexDirection: 'column' }}>
            {page.sections.map((section, index) => (
              <FirstOnPage.Provider key={section} value={index === 0}>
                <div ref={(el: PublicInstance | null) => void sectionRefs.current.set(section, el)} testId={`settings-section-${section}`} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                  {nodes[section]}
                </div>
              </FirstOnPage.Provider>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
