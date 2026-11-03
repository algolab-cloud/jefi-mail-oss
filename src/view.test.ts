import { expect, test } from 'bun:test'
import type { MailThread } from './data'
import { baseView, isUnified, threadInView } from './view'

const thread = (fields: Partial<MailThread>): MailThread =>
  ({ id: 'a:1', sender: 'Ada', subject: 'Hi', snippet: '', date: '', group: 'Today', unread: false, starred: false, icons: [], priority: true, folder: 'inbox', labels: [], messages: [], face: {}, ...fields }) as MailThread

test('All Inboxes and All Starred hold what each account would show in its own', () => {
  expect(threadInView(thread({ folder: 'inbox' }), 'all:inbox')).toBe(true)
  expect(threadInView(thread({ folder: 'archive' }), 'all:inbox')).toBe(false)
  // Mail waiting in the Screener isn't in any Inbox yet, unified or not.
  expect(threadInView(thread({ folder: 'inbox', screened: true }), 'all:inbox')).toBe(false)
  expect(threadInView(thread({ folder: 'archive', starred: true }), 'all:starred')).toBe(true)
  expect(threadInView(thread({ folder: 'trash', starred: true }), 'all:starred')).toBe(false)
})

test('a unified view pages as its own account view', () => {
  expect(isUnified('all:inbox')).toBe(true)
  expect(isUnified('inbox')).toBe(false)
  expect(baseView('all:inbox')).toBe('inbox')
  expect(baseView('all:starred')).toBe('starred')
  expect(baseView('label:gm:a:Work')).toBe('label:gm:a:Work')
})
