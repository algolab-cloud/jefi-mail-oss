import { configDir } from './paths'
import { REBINDABLE, assignableKey, type ShortcutBindings, type ShortcutScheme } from './shortcuts'
import { normalizeTrustedLinkDomain } from './link-safety'
import { createContext, useContext } from 'react'
import { DEFAULT_SIDEBAR, normalizeSidebar, type SidebarPrefs } from './sidebar-state'

// ---------------------------------------------------------------------------
// Theme tokens
// ---------------------------------------------------------------------------

export type ThemeName = 'dark' | 'light'
export type AccentName = 'red' | 'blue' | 'violet' | 'green' | 'amber'
/** How surfaces are drawn: solid, or Liquid Glass (a blurred window the panes let show through). */
export type StyleName = 'default' | 'glass'

export type BaseColors = {
  sidebar: string
  list: string
  reading: string
  raised: string
  raisedHover: string
  navSelected: string
  rowSelected: string
  segment: string
  segmentActive: string
  chip: string
  overlay: string
  overlayStrong: string
  border: string
  divider: string
  text: string
  /** Ink on a pill filled with `text` (Compose, primary buttons): always opaque, even in Liquid Glass. */
  onText: string
  secondary: string
  muted: string
  ghost: string
  face: string
  star: string
  purple: string
  green: string
  blue: string
  amber: string
  pink: string
  teal: string
  red: string
}

export type AccentColors = {
  accent: string
  accentHover: string
  accentActive: string
  onAccent: string
}

export type Colors = BaseColors & AccentColors

/** Moves a `#RRGGBB` colour `amount` (0..1) of the way toward `toward`. */
export function mixHex(hex: string, toward: string, amount: number): string {
  const channels = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16))
  const from = channels(hex)
  const to = channels(toward)
  return `#${from
    .map((v, i) => Math.round(v + (to[i]! - v) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

export const ACCENTS: Record<AccentName, AccentColors> = {
  red: { accent: '#E5484D', accentHover: '#EB5A5F', accentActive: '#CF3F45', onAccent: '#FFFFFF' },
  blue: { accent: '#3E63DD', accentHover: '#4C74E4', accentActive: '#3553BD', onAccent: '#FFFFFF' },
  violet: { accent: '#8B5CF6', accentHover: '#9B71F7', accentActive: '#7A46E0', onAccent: '#FFFFFF' },
  green: { accent: '#059669', accentHover: '#0AA67C', accentActive: '#047857', onAccent: '#FFFFFF' },
  amber: { accent: '#D97706', accentHover: '#E2860E', accentActive: '#B45309', onAccent: '#FFFFFF' },
}

export const THEMES: Record<ThemeName, BaseColors> = {
  dark: {
    sidebar: '#141416',
    list: '#151517',
    reading: '#151517',
    raised: '#1D1D20',
    raisedHover: '#232326',
    navSelected: '#242428',
    rowSelected: '#1E1E22',
    segment: '#1C1C1F',
    segmentActive: '#2B2B30',
    chip: '#232326',
    overlay: '#FFFFFF0C',
    overlayStrong: '#FFFFFF16',
    border: '#242428',
    divider: '#1F1F23',
    text: '#ECECEE',
    onText: '#141416',
    secondary: '#B4B4BB',
    muted: '#7A7A82',
    ghost: '#5C5C64',
    face: '#3A3A40',
    star: '#F5C518',
    purple: '#8B5CF6',
    green: '#22C55E',
    blue: '#38BDF8',
    amber: '#F59E0B',
    pink: '#EC4899',
    teal: '#14B8A6',
    red: '#F87171',
  },
  light: {
    sidebar: '#F2F2F4',
    list: '#FAFAFA',
    reading: '#FFFFFF',
    raised: '#F1F1F3',
    raisedHover: '#E9E9EC',
    navSelected: '#E6E6E9',
    rowSelected: '#EFEFF1',
    segment: '#ECECEE',
    segmentActive: '#FFFFFF',
    chip: '#EBEBEE',
    overlay: '#0000000A',
    overlayStrong: '#00000014',
    border: '#E4E4E7',
    divider: '#ECECEE',
    text: '#18181B',
    onText: '#FFFFFF',
    secondary: '#52525B',
    muted: '#7C7C85',
    ghost: '#A1A1AA',
    face: '#E4E4E7',
    star: '#EAB308',
    purple: '#7C3AED',
    green: '#16A34A',
    blue: '#0284C7',
    amber: '#D97706',
    pink: '#DB2777',
    teal: '#0D9488',
    red: '#DC2626',
  },
}

/**
 * Liquid Glass swaps the surfaces for translucent ones over the window's blur. Panes are the most see-through;
 * raised surfaces (cards, menus, popovers) stay nearly opaque, since they sit over text rather than the desktop.
 */
export const GLASS: Record<ThemeName, Partial<BaseColors>> = {
  dark: {
    sidebar: '#16161A1F',
    list: '#18181C47',
    reading: '#1414179E',
    raised: '#2A2A2FE6',
    raisedHover: '#303036EE',
    navSelected: '#FFFFFF1A',
    rowSelected: '#FFFFFF12',
    segment: '#FFFFFF0D',
    segmentActive: '#FFFFFF24',
    chip: '#FFFFFF14',
    border: '#FFFFFF1A',
    divider: '#FFFFFF10',
  },
  light: {
    sidebar: '#F4F4F74D',
    list: '#FAFAFB80',
    reading: '#FFFFFFC2',
    raised: '#FFFFFFE6',
    raisedHover: '#FFFFFFF2',
    navSelected: '#0000000F',
    rowSelected: '#0000000A',
    segment: '#0000000A',
    segmentActive: '#FFFFFFE6',
    chip: '#0000000D',
    border: '#0000001A',
    divider: '#00000010',
  },
}

export const palette = (theme: ThemeName, accent: AccentName, style: StyleName = 'default'): Colors => ({
  ...THEMES[theme],
  ...(style === 'glass' ? GLASS[theme] : {}),
  ...ACCENTS[accent],
})

// ---------------------------------------------------------------------------
// Settings + persistence
// ---------------------------------------------------------------------------

export type Settings = {
  theme: ThemeName
  accent: AccentName
  /** Solid or Liquid Glass; the window's blur is chosen when it opens, so a change shows after a restart. */
  style: StyleName
  unreadCounts: boolean
  snippets: boolean
  /** Seconds a sent message waits in the Outbox so it can be undone; 0 sends immediately. */
  undoSendSeconds: 0 | 5 | 10 | 20
  /** The mail keyboard: Gmail's single keys, Apple Mail's ⌘ keys, or none (shortcuts.ts). */
  shortcutScheme: ShortcutScheme
  /** Single-key actions the person moved to a key of their own. */
  shortcutKeys: ShortcutBindings['keys']
  /** False until the first-launch onboarding is finished or skipped. */
  onboarded: boolean
  /** The version whose "What's new" was last seen (or skipped); empty for installs before 0.6. */
  lastSeenVersion: string
  /** Which local provider runs summaries and reply drafts. */
  aiProvider: 'anthropic' | 'openai'
  /** OpenAI can use a Keychain API key or the locally authenticated Codex CLI. */
  aiOpenAiMode: 'api' | 'codex'
  /** Where the Codex CLI is, when Jefi can't find it: an app opened from Finder has almost no PATH. */
  aiCodexPath: string
  /** Pane widths the person dragged to. */
  paneWidths: PaneWidths
  /** The context column beside the app rail: hidden or not, and which of its sections are open. */
  sidebar: SidebarPrefs
  /** The model each provider uses; empty means Jefi's default for it. */
  aiModels: { anthropic: string; openai: string; codex: string }
  /** AI features are off until the person turns them on. */
  aiEnabled: boolean
  /** Banners in Notification Center when new mail arrives and Jefi isn't the app in front. */
  notifications: boolean
  /** When "Not now" last closed the notification permission screen (ms); 0 if it never did. */
  notificationPromptDismissedAt: number
  /** The version that last showed the "notifications are off" screen, so a refusal isn't nagged about. */
  notificationDeniedPromptVersion: string
  /** Alert for timed events that don't choose their own: minutes before the start, or null for none. */
  defaultAlert: number | null
  /** Alert for all-day events: minutes before local midnight of the day (-540 is 9:00 on the day), or null. */
  defaultAllDayAlert: number | null
  /** Reminder for tasks due at a time that don't choose their own: minutes before the due time, or null for none. */
  defaultTaskAlert: number | null
  /** Reminder for tasks due on a day: minutes before local midnight of that day (-540 is 9:00 on the day), or null. */
  defaultTaskAllDayAlert: number | null
  /** Tasks with a due date show in the calendar, on a Tasks calendar of their own. */
  calendarShowsTasks: boolean
  /** Download new versions in the background and install them on the next restart. */
  autoUpdate: boolean
  /** The assistant docks as a pane beside the mail; unpinned, it floats over the corner as a chat box. */
  assistantPinned: boolean
  /** The user agent the in-app sign-in window presents; empty parts use the built-in default. */
  signInUserAgent: SignInUserAgent
  /**
   * Remote images tell the sender when a message was opened, so they stay hidden until asked for:
   * 'ask' hides them behind a banner in every message, 'always' loads them (https: only).
   */
  remoteImages: RemoteImagePolicy
  /** Senders whose remote images load without asking, lower-cased. */
  remoteImageSenders: string[]
  /** Senders the person told the smart clean-up to keep, lower-cased: never offered as junk again. */
  cleanupKeepSenders: string[]
  /** The model each provider uses to sort senders for clean-up; empty means the main model (aiModels). */
  cleanupModels: { anthropic: string; openai: string; codex: string }
  /** How often the smart clean-up runs on its own while Jefi is open. */
  cleanupSchedule: CleanupSchedule
  /** What a scheduled run does with junk: only sort it for review, archive it, or move it to Trash. */
  cleanupAction: CleanupAction
  /** When a scheduled (or "Run now") clean-up last started (ms); 0 if never. */
  cleanupLastRunAt: number
  /** What that run did, in words, for Settings. */
  cleanupLastSummary: string
  /** Exact destination hosts the user has chosen to trust for email links. */
  trustedLinkDomains: string[]
  /** Download and use the optional public phishing list for link review. */
  phishingListEnabled: boolean
  /** A Jefi item in the menu bar; with it on, closing the window keeps Jefi running there (sync and banners go on). */
  menuBar: boolean
  /** The text beside the menu bar icon: nothing, the unread count, or the next event. */
  menuBarTitle: MenuBarTitleMode
  /** Drop the Dock icon while the window is closed, so Jefi lives only in the menu bar. */
  hideDockWhenClosed: boolean
  /** `Jefi mcp` serves mail, calendar and notes to AI apps; off until the person turns it on. */
  mcpEnabled: boolean
}

export type MenuBarTitleMode = 'none' | 'unread' | 'next'

export type CleanupSchedule = 'off' | 'daily' | 'weekly'
export type CleanupAction = 'review' | 'archive' | 'trash'

export type RemoteImagePolicy = 'ask' | 'always'

export type PaneWidths = { sidebar: number; list: number; assistant: number }

export type SignInBrowser = 'safari' | 'chrome' | 'edge' | 'firefox'
export type SignInPlatform = 'mac' | 'windows' | 'linux'
export type SignInUserAgent = {
  family: SignInBrowser
  platform: SignInPlatform
  /** Free-text overrides; empty uses the preset's value. */
  custom: string
  os: string
  webkit: string
  browser: string
  suffix: string
}

/** Rebound keys as saved: one assignable key per known action; anything else is dropped. */
function shortcutKeysOf(value: unknown): ShortcutBindings['keys'] {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([action, key]) => (REBINDABLE as readonly string[]).includes(action) && typeof key === 'string' && assignableKey(key),
    ),
  ) as ShortcutBindings['keys']
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'violet',
  style: 'glass',
  unreadCounts: true,
  snippets: true,
  undoSendSeconds: 5,
  shortcutScheme: 'single',
  shortcutKeys: {},
  onboarded: false,
  lastSeenVersion: '',
  aiProvider: 'anthropic',
  aiOpenAiMode: 'api',
  aiCodexPath: '',
  aiModels: { anthropic: '', openai: '', codex: '' },
  paneWidths: { sidebar: 240, list: 440, assistant: 380 },
  sidebar: DEFAULT_SIDEBAR,
  aiEnabled: false,
  notifications: true,
  notificationPromptDismissedAt: 0,
  notificationDeniedPromptVersion: '',
  defaultAlert: 10,
  defaultAllDayAlert: -540,
  defaultTaskAlert: 0,
  defaultTaskAllDayAlert: -540,
  calendarShowsTasks: true,
  autoUpdate: true,
  assistantPinned: false,
  signInUserAgent: { family: 'safari', platform: 'mac', custom: '', os: '', webkit: '', browser: '', suffix: '' },
  remoteImages: 'ask',
  remoteImageSenders: [],
  cleanupKeepSenders: [],
  cleanupModels: { anthropic: '', openai: '', codex: '' },
  cleanupSchedule: 'off',
  cleanupAction: 'review',
  cleanupLastRunAt: 0,
  cleanupLastSummary: '',
  trustedLinkDomains: [],
  phishingListEnabled: false,
  menuBar: true,
  menuBarTitle: 'unread',
  hideDockWhenClosed: false,
  mcpEnabled: false,
}

/** Whether `email`'s remote images may load: everyone's may, or this sender was allowed before. */
export const remoteImagesAllowed = (settings: Settings, email: string) =>
  settings.remoteImages === 'always' || settings.remoteImageSenders.includes(email.trim().toLowerCase())

/** The allow list with `email` on it (addresses are matched without case, and kept only once). */
export const allowRemoteImagesFrom = (settings: Settings, email: string): string[] => {
  const address = email.trim().toLowerCase()
  return settings.remoteImageSenders.includes(address) ? settings.remoteImageSenders : [...settings.remoteImageSenders, address]
}

/** The allow list without `email`; a sender who isn't on it leaves the list as it was. */
export const forgetRemoteImageSender = (settings: Settings, email: string): string[] => {
  const address = email.trim().toLowerCase()
  return settings.remoteImageSenders.includes(address) ? settings.remoteImageSenders.filter((sender) => sender !== address) : settings.remoteImageSenders
}

function settingsFile(): string | null {
  const dir = configDir()
  return dir ? `${dir}/settings.json` : null
}

/** JEFI_SKIP_ONBOARDING=1 lets screenshot/e2e scripts start straight in the mailbox. */
const withEnv = (settings: Settings): Settings =>
  typeof process !== 'undefined' && process.env?.JEFI_SKIP_ONBOARDING === '1' ? { ...settings, onboarded: true } : settings

/** Old or hand-edited settings files must not turn malformed values into trusted destinations. */
const trustedLinkDomains = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const normalized = value
    .map((domain) => (typeof domain === 'string' ? normalizeTrustedLinkDomain(domain) : null))
    .filter((domain): domain is string => domain !== null)
  return [...new Set(normalized)]
}

/** One of `allowed`, or the default: a value from a newer version or a hand edit mustn't break the app. */
const oneOf = <T,>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
/** Pane widths are numbers the layout divides by; anything else is the default width. */
const widths = (value: unknown): PaneWidths => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const width = (key: keyof PaneWidths) => (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && (raw[key] as number) > 0 ? (raw[key] as number) : DEFAULT_SETTINGS.paneWidths[key])
  return { sidebar: width('sidebar'), list: width('list'), assistant: width('assistant') }
}
const strings = <T extends Record<string, string>,>(value: unknown, fallback: T): T => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(fallback).map(([key, base]) => [key, text(raw[key], base)])) as T
}

/** A stored alert setting: whole minutes or null; anything else falls back to the default. */
const alertSetting = (value: unknown, fallback: number | null): number | null =>
  value === null ? null : typeof value === 'number' && Number.isInteger(value) ? value : fallback

export function loadSettings(): Settings {
  const file = settingsFile()
  if (!file) return withEnv({ ...DEFAULT_SETTINGS })
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(file, 'utf8')) as Partial<Settings>
    const legacyProvider = (raw as { aiProvider?: string }).aiProvider
    const d = DEFAULT_SETTINGS
    return withEnv({
      ...DEFAULT_SETTINGS,
      ...raw,
      // An unknown theme or accent has no palette: the window would paint nothing at all.
      theme: oneOf(raw.theme, Object.keys(THEMES) as ThemeName[], d.theme),
      accent: oneOf(raw.accent, Object.keys(ACCENTS) as AccentName[], d.accent),
      style: oneOf(raw.style, ['default', 'glass'] as const, d.style),
      undoSendSeconds: oneOf(raw.undoSendSeconds, [0, 5, 10, 20] as const, d.undoSendSeconds),
      shortcutScheme: oneOf(raw.shortcutScheme, ['single', 'command', 'off'] as const, d.shortcutScheme),
      shortcutKeys: shortcutKeysOf(raw.shortcutKeys),
      remoteImages: oneOf(raw.remoteImages, ['ask', 'always'] as const, d.remoteImages),
      unreadCounts: bool(raw.unreadCounts, d.unreadCounts),
      snippets: bool(raw.snippets, d.snippets),
      onboarded: bool(raw.onboarded, d.onboarded),
      aiEnabled: bool(raw.aiEnabled, d.aiEnabled),
      notifications: bool(raw.notifications, d.notifications),
      autoUpdate: bool(raw.autoUpdate, d.autoUpdate),
      assistantPinned: bool(raw.assistantPinned, d.assistantPinned),
      lastSeenVersion: text(raw.lastSeenVersion, d.lastSeenVersion),
      aiCodexPath: text(raw.aiCodexPath, d.aiCodexPath),
      aiProvider: legacyProvider === 'openai' || legacyProvider === 'codex' ? 'openai' : 'anthropic',
      aiOpenAiMode: legacyProvider === 'codex' || raw.aiOpenAiMode === 'codex' ? 'codex' : 'api',
      signInUserAgent: {
        ...strings(raw.signInUserAgent, { custom: d.signInUserAgent.custom, os: d.signInUserAgent.os, webkit: d.signInUserAgent.webkit, browser: d.signInUserAgent.browser, suffix: d.signInUserAgent.suffix }),
        family: oneOf(raw.signInUserAgent?.family, ['safari', 'chrome', 'edge', 'firefox'] as const, d.signInUserAgent.family),
        platform: oneOf(raw.signInUserAgent?.platform, ['mac', 'windows', 'linux'] as const, d.signInUserAgent.platform),
      },
      aiModels: strings(raw.aiModels, d.aiModels),
      remoteImageSenders: (Array.isArray(raw.remoteImageSenders) ? raw.remoteImageSenders : []).map((email) => String(email).trim().toLowerCase()),
      cleanupKeepSenders: [...new Set((Array.isArray(raw.cleanupKeepSenders) ? raw.cleanupKeepSenders : []).flatMap((email) => (typeof email === 'string' && email.trim() ? [email.trim().toLowerCase()] : [])))],
      cleanupModels: strings(raw.cleanupModels, d.cleanupModels),
      cleanupSchedule: oneOf(raw.cleanupSchedule, ['off', 'daily', 'weekly'] as const, d.cleanupSchedule),
      cleanupAction: oneOf(raw.cleanupAction, ['review', 'archive', 'trash'] as const, d.cleanupAction),
      cleanupLastRunAt: typeof raw.cleanupLastRunAt === 'number' && Number.isFinite(raw.cleanupLastRunAt) ? raw.cleanupLastRunAt : 0,
      cleanupLastSummary: text(raw.cleanupLastSummary, d.cleanupLastSummary),
      trustedLinkDomains: trustedLinkDomains(raw.trustedLinkDomains),
      phishingListEnabled: raw.phishingListEnabled === true,
      defaultAlert: alertSetting(raw.defaultAlert, DEFAULT_SETTINGS.defaultAlert),
      defaultAllDayAlert: alertSetting(raw.defaultAllDayAlert, DEFAULT_SETTINGS.defaultAllDayAlert),
      defaultTaskAlert: alertSetting(raw.defaultTaskAlert, DEFAULT_SETTINGS.defaultTaskAlert),
      defaultTaskAllDayAlert: alertSetting(raw.defaultTaskAllDayAlert, DEFAULT_SETTINGS.defaultTaskAllDayAlert),
      calendarShowsTasks: raw.calendarShowsTasks !== false,
      menuBar: raw.menuBar !== false,
      menuBarTitle: raw.menuBarTitle === 'none' || raw.menuBarTitle === 'next' ? raw.menuBarTitle : 'unread',
      hideDockWhenClosed: raw.hideDockWhenClosed === true,
      mcpEnabled: raw.mcpEnabled === true,
      notificationPromptDismissedAt: typeof raw.notificationPromptDismissedAt === 'number' ? raw.notificationPromptDismissedAt : 0,
      notificationDeniedPromptVersion: typeof raw.notificationDeniedPromptVersion === 'string' ? raw.notificationDeniedPromptVersion : '',
      paneWidths: widths(raw.paneWidths),
      sidebar: normalizeSidebar(raw.sidebar),
    })
  } catch {
    return withEnv({ ...DEFAULT_SETTINGS })
  }
}

export function saveSettings(settings: Settings) {
  const file = settingsFile()
  if (!file) return
  try {
    const fs = require('node:fs')
    fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  } catch {}
}

export type SettingsContextValue = {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  C: Colors
  /** The style the window opened with, which is the one on screen until Jefi restarts. */
  windowStyle?: StyleName
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings requires SettingsContext.Provider')
  return value
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const FONT = typeof window === 'undefined' ? 'Geist' : 'Geist'
export const SIDEBAR_WIDTH = 248
/** Rows are inset this much from both sidebar edges; right-aligned content sits a second inset further in. */
export const SIDEBAR_INSET = 8
export const LIST_WIDTH = 440
export const TOPBAR_HEIGHT = 52
export const TRAFFIC_LIGHT_CLEARANCE =
  typeof process !== 'undefined' && process.platform === 'darwin' ? 96 : 12
export const READ_PAD_LEFT = 20
export const READ_PAD_RIGHT = 24
