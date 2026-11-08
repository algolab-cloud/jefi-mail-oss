import { expect, test } from 'bun:test'
import { SETTINGS_SECTIONS, parseJefiUrl } from './deeplink'
import { SETTINGS_GROUPS, SETTINGS_PAGES, pageOf, searchSettings, showSettingsPage } from './settings-pages'

test('every linkable section is on exactly one page', () => {
  for (const section of SETTINGS_SECTIONS) expect(SETTINGS_PAGES.filter((page) => page.sections.includes(section))).toHaveLength(1)
  // And no page names a section links can't reach.
  expect(SETTINGS_PAGES.flatMap((page) => page.sections).sort()).toEqual([...SETTINGS_SECTIONS].sort())
})

test('links and buttons land on the page that holds their section', () => {
  expect(pageOf('ai')).toBe('ai')
  expect(pageOf('signin')).toBe('accounts')
  expect(pageOf('tasks')).toBe('calendar')
  expect(pageOf('sync')).toBe('notifications')
  expect(pageOf('cleanup')).toBe('cleanup')
  // Links from before the pages existed still work, and the new pages have links of their own.
  for (const section of ['appearance', 'mailbox', 'privacy', 'accounts', 'ai', 'signin', 'calendar', 'tasks', 'sync', 'menubar', 'integrations', 'about', 'keyboard', 'cleanup'] as const)
    expect(parseJefiUrl(`jefi://settings/${section}`)).toEqual({ kind: 'settings', section })
})

test('pages have unique ids and labels, grouped, with About last', () => {
  const ids = SETTINGS_PAGES.map((page) => page.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(SETTINGS_PAGES.map((page) => page.label)).size).toBe(ids.length)
  expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual(['General', 'Mail', 'AI & tools', null])
  expect(ids.at(-1)).toBe('about')
})

test('showing the page that is already open changes nothing', () => {
  showSettingsPage('ai')
  expect(() => showSettingsPage('ai')).not.toThrow()
})

test('search finds pages by name or by what is on them', () => {
  const ids = (query: string) => searchSettings(query).map((page) => page.id)
  expect(ids('')).toHaveLength(SETTINGS_PAGES.length)
  expect(ids('dark')).toEqual(['appearance'])
  expect(ids('shortcuts')).toEqual(['keyboard'])
  expect(ids('Junk')).toEqual(['cleanup'])
  expect(ids('chatgpt model')).toEqual(['ai'])
  expect(ids('user agent')).toEqual(['accounts'])
  expect(ids('nothing like this')).toEqual([])
})
