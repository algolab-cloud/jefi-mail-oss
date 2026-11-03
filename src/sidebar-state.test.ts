import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  DEFAULT_SIDEBAR,
  appKeyFor,
  appOf,
  badgeText,
  compactCount,
  mailBadge,
  normalizeSidebar,
  sectionShown,
  startsSoon,
  syncSummary,
  toggleSection,
  updateCard,
} from './sidebar-state'
import { DEFAULT_SETTINGS, loadSettings } from './theme'

test('mail tools and settings belong to the Mail app', () => {
  expect(appOf(null)).toBe('mail')
  expect(appOf('cleanup')).toBe('mail')
  expect(appOf('rules')).toBe('mail')
  expect(appOf('calendar')).toBe('calendar')
  expect(appOf('notes')).toBe('notes')
  expect(appOf('tasks')).toBe('tasks')
})

test('sections toggle one at a time and a closed one still shows what is selected', () => {
  const next = toggleSection(DEFAULT_SIDEBAR, 'more')
  expect(next.open).toEqual({ more: true, labels: true, folders: true })
  expect(DEFAULT_SIDEBAR.open.more).toBe(false)
  expect(toggleSection(next, 'labels').open.labels).toBe(false)
  expect(sectionShown(DEFAULT_SIDEBAR, 'more', false)).toBe(false)
  expect(sectionShown(DEFAULT_SIDEBAR, 'more', true)).toBe(true)
})

test('sidebar prefs from old or hand-edited files fall back key by key', () => {
  expect(normalizeSidebar(undefined)).toEqual(DEFAULT_SIDEBAR)
  expect(normalizeSidebar('yes')).toEqual(DEFAULT_SIDEBAR)
  expect(normalizeSidebar({ collapsed: 'true', open: { more: true, labels: 'no' } })).toEqual({ collapsed: false, open: { more: true, labels: true, folders: true } })
  expect(normalizeSidebar({ collapsed: true, open: { folders: false } })).toEqual({ collapsed: true, open: { more: false, labels: true, folders: false } })
})

test('the sidebar prefs survive a save and load', () => {
  const previous = process.env.JEFI_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'jefi-sidebar-'))
  process.env.JEFI_CONFIG_DIR = directory
  try {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ theme: 'light' }))
    expect(loadSettings().sidebar).toEqual(DEFAULT_SIDEBAR)
    const sidebar = { collapsed: true, open: { more: true, labels: false, folders: true } }
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, sidebar, paneWidths: { sidebar: 300 } }))
    const loaded = loadSettings()
    expect(loaded.sidebar).toEqual(sidebar)
    expect(loaded.paneWidths).toEqual({ ...DEFAULT_SETTINGS.paneWidths, sidebar: 300 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
    else process.env.JEFI_CONFIG_DIR = previous
  }
})

test('the Mail badge counts every inbox and caps its text', () => {
  expect(mailBadge({})).toBe(0)
  expect(mailBadge({ a: 3, b: 12 })).toBe(15)
  expect(mailBadge({ a: -1, b: 2 })).toBe(2)
  expect(badgeText(7)).toBe('7')
  expect(badgeText(99)).toBe('99')
  expect(badgeText(100)).toBe('99+')
})

test('the Calendar dot is for timed events starting within 15 minutes', () => {
  const now = 1_000_000_000
  expect(startsSoon([{ startAt: now + 10 * 60_000 }], now)).toBe(true)
  expect(startsSoon([{ startAt: now + 15 * 60_000 }], now)).toBe(true)
  expect(startsSoon([{ startAt: now + 16 * 60_000 }], now)).toBe(false)
  expect(startsSoon([{ startAt: now - 60_000 }], now)).toBe(false)
  expect(startsSoon([{ startAt: now + 60_000, allDay: true }], now)).toBe(false)
})

test('⌘1 ⌘2 ⌘3 ⌘4 switch apps and ⌘\\ toggles the sidebar', () => {
  const cmd = (key: string, extra = {}) => ({ key, modifiers: { cmd: true, ...extra } })
  expect(appKeyFor(cmd('1'))).toBe('mail')
  expect(appKeyFor(cmd('2'))).toBe('calendar')
  expect(appKeyFor(cmd('3'))).toBe('notes')
  expect(appKeyFor(cmd('4'))).toBe('tasks')
  expect(appKeyFor(cmd('\\'))).toBe('toggleSidebar')
  expect(appKeyFor({ key: '1', modifiers: { ctrl: true } })).toBe('mail')
  // Plain digits are the calendar's views; shifted or ⌥ ones are someone else's.
  expect(appKeyFor({ key: '1' })).toBeNull()
  expect(appKeyFor(cmd('1', { shift: true }))).toBeNull()
  expect(appKeyFor(cmd('1', { alt: true }))).toBeNull()
  expect(appKeyFor(cmd('5'))).toBeNull()
})

test('the sync dot is red only for a surfaced failure and shows offline and sign-in apart', () => {
  const now = Date.now()
  const base = { offline: false, needsSignIn: false, outbox: 0, email: 'a@b.c', now }
  expect(syncSummary({ ...base, sync: { status: 'idle', done: 1, total: 1, lastSyncedAt: now - 1000 } })).toMatchObject({ dot: 'ok', line: 'Up to date' })
  expect(syncSummary({ ...base, sync: { status: 'idle', done: 1, total: 1, lastSyncedAt: now - 10 * 60_000 } }).line).toBe('Synced 10m ago')
  expect(syncSummary({ ...base, sync: { status: 'idle', done: 0, total: 1 } }).dot).toBe('never')
  expect(syncSummary({ ...base, sync: { status: 'syncing', done: 0, total: 1, background: true } })).toMatchObject({ dot: 'syncing', line: 'Updating…' })
  expect(syncSummary({ ...base, sync: { status: 'syncing', done: 0, total: 1, phase: 'Inbox' } }).line).toBe('Syncing Inbox…')
  expect(syncSummary({ ...base, sync: { status: 'error', done: 0, total: 1, error: 'Timed out' } })).toMatchObject({ dot: 'failed', hint: 'Timed out · Click to try again' })
  expect(syncSummary({ ...base, offline: true, outbox: 2, sync: { status: 'error', done: 0, total: 1 } })).toMatchObject({ dot: 'offline', line: 'Offline · 2 waiting to send' })
  expect(syncSummary({ ...base, needsSignIn: true, sync: { status: 'idle', done: 1, total: 1 } }).dot).toBe('signIn')
})

test('the update card: a ready or downloadable version until it is waved off', () => {
  expect(updateCard({ status: 'current', checkedAt: 0 }, null)).toBeNull()
  expect(updateCard({ status: 'downloading', version: '0.9.0' }, null)).toBeNull()
  expect(updateCard({ status: 'ready', version: '0.9.0' }, null)).toMatchObject({ title: 'Jefi 0.9.0 is ready', action: 'restart' })
  expect(updateCard({ status: 'manual', version: '0.9.0', url: 'https://jefi.app/download' }, null)).toMatchObject({ action: 'download', url: 'https://jefi.app/download' })
  expect(updateCard({ status: 'ready', version: '0.9.0' }, '0.9.0')).toBeNull()
  // Waving off one version doesn't hide the next.
  expect(updateCard({ status: 'ready', version: '0.9.1' }, '0.9.0')).not.toBeNull()
})

test('folder counts past 999 shorten to k and m, never rounding up', () => {
  expect(compactCount(0)).toBe('0')
  expect(compactCount(999)).toBe('999')
  expect(compactCount(1000)).toBe('1k')
  expect(compactCount(1250)).toBe('1.2k')
  expect(compactCount(9999)).toBe('9.9k')
  expect(compactCount(19938)).toBe('19k')
  expect(compactCount(999_999)).toBe('999k')
  expect(compactCount(1_000_000)).toBe('1m')
  expect(compactCount(3_480_000)).toBe('3.4m')
})
