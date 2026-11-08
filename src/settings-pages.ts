import { useSyncExternalStore } from 'react'
import type { IconName } from './icons'
import type { SettingsSection } from './deeplink'

// ---------------------------------------------------------------------------
// Settings as pages: the sidebar lists them in groups and the pane shows one at a time. Every
// linkable section (deeplink.ts) lives on exactly one page, so jefi://settings/<section> and
// "Open Settings" buttons land on the page that holds it. The open page outlives the pane, so
// leaving Settings and coming back returns to where the person was.
// ---------------------------------------------------------------------------

export type SettingsPageId = 'appearance' | 'menubar' | 'notifications' | 'keyboard' | 'accounts' | 'mailbox' | 'privacy' | 'cleanup' | 'ai' | 'calendar' | 'integrations' | 'about'
/** `keywords`: what's on the page, for the search in the menu. */
export type SettingsPage = { id: SettingsPageId; label: string; icon: IconName; sections: SettingsSection[]; keywords: string }

export const SETTINGS_GROUPS: Array<{ label: string | null; pages: SettingsPage[] }> = [
  {
    label: 'General',
    pages: [
      { id: 'appearance', label: 'Appearance', icon: 'sun', sections: ['appearance'], keywords: 'theme dark light liquid glass style accent colour color' },
      { id: 'menubar', label: 'Menu bar & Dock', icon: 'panelTop', sections: ['menubar'], keywords: 'menu bar dock icon title unread next event close quit hide' },
      { id: 'notifications', label: 'Notifications & sync', icon: 'bell', sections: ['sync'], keywords: 'notifications banners alerts permission sync fetch refresh offline' },
      { id: 'keyboard', label: 'Keyboard', icon: 'keyboard', sections: ['keyboard'], keywords: 'keyboard shortcuts keys gmail apple mail single key command' },
    ],
  },
  {
    label: 'Mail',
    pages: [
      { id: 'accounts', label: 'Accounts', icon: 'users', sections: ['accounts', 'signin'], keywords: 'accounts add remove imap smtp gmail outlook icloud yahoo fastmail sign-in window browser user agent' },
      { id: 'mailbox', label: 'Mailbox', icon: 'inbox', sections: ['mailbox'], keywords: 'unread counts undo send screener new senders snippets previews list' },
      { id: 'privacy', label: 'Privacy & links', icon: 'shieldCheck', sections: ['privacy'], keywords: 'privacy remote images trackers links phishing safe browsing web risk trusted domains' },
      { id: 'cleanup', label: 'Clean up', icon: 'broom', sections: ['cleanup'], keywords: 'clean up junk spam newsletters schedule automatic daily weekly archive trash model' },
    ],
  },
  {
    label: 'AI & tools',
    pages: [
      { id: 'ai', label: 'AI', icon: 'sparkles', sections: ['ai'], keywords: 'ai claude anthropic openai chatgpt codex api key model assistant summaries drafts' },
      { id: 'calendar', label: 'Calendar & tasks', icon: 'calendar', sections: ['calendar', 'tasks'], keywords: 'calendar events alerts reminders all-day tasks due' },
      { id: 'integrations', label: 'Integrations', icon: 'link', sections: ['integrations'], keywords: 'integrations mcp cli command line claude desktop cursor codex raycast' },
    ],
  },
  { label: null, pages: [{ id: 'about', label: 'About Jefi', icon: 'info', sections: ['about'], keywords: 'about version updates feedback bug feature licence license onboarding welcome' }] },
]

export const SETTINGS_PAGES = SETTINGS_GROUPS.flatMap((group) => group.pages)

export const settingsPage = (id: SettingsPageId) => SETTINGS_PAGES.find((page) => page.id === id)!

/** Pages whose name or contents mention every word of `query`; all of them for an empty one. */
export function searchSettings(query: string): SettingsPage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return SETTINGS_PAGES.filter((page) => {
    const haystack = `${page.label} ${page.keywords}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** The page that shows `section`. */
export const pageOf = (section: SettingsSection): SettingsPageId => SETTINGS_PAGES.find((page) => page.sections.includes(section))?.id ?? 'appearance'

// --- The open page -----------------------------------------------------------------------------

let current: SettingsPageId = 'appearance'
const listeners = new Set<() => void>()

export function showSettingsPage(id: SettingsPageId) {
  if (id === current) return
  current = id
  listeners.forEach((listener) => listener())
}

export const useSettingsPage = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => current,
  )
