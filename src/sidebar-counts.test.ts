import { expect, test } from 'bun:test'
import type { MailThread } from './data'
import { sidebarCounts } from './sidebar-counts'
import { threadInView } from './view'

const thread = (over: Partial<MailThread>): MailThread =>
  ({ id: Math.random().toString(36), folder: 'inbox', unread: false, starred: false, labels: [], folders: [], group: 'Today', screened: false, ...over }) as MailThread

test('one pass gives the counts the sidebar used to filter for', () => {
  const threads = [
    thread({ unread: true, labels: ['a'], folders: ['Projects'] }),
    thread({ unread: true, starred: true, group: 'Earlier', labels: ['a', 'b'] }),
    thread({ unread: false, labels: ['a'] }),
    thread({ unread: true, screened: true }),
    thread({ folder: 'trash', unread: true, labels: ['a'], folders: ['Projects'] }),
    thread({ folder: 'outbox' }),
    thread({ folder: 'drafts' }),
    thread({ folder: 'drafts' }),
    thread({ folder: 'spam', unread: true }),
    thread({ folder: 'spam', unread: true, labels: ['a'] }),
    thread({ folder: 'spam' }),
  ]
  const counts = sidebarCounts(threads)
  // The same filters MailSidebar ran, one by one.
  const inbox = threads.filter((t) => t.folder === 'inbox' && !t.screened)
  const unread = inbox.filter((t) => t.unread)
  expect(counts.stats.inbox).toEqual({ all: inbox.length, unread: unread.length, today: unread.filter((t) => t.group === 'Today').length, older: unread.filter((t) => t.group === 'Earlier').length, starred: unread.filter((t) => t.starred).length })
  expect(counts.screened).toBe(threads.filter((t) => t.screened && t.folder === 'inbox').length)
  expect(counts.outbox).toBe(1)
  expect(counts.drafts).toBe(2)
  expect(counts.spamUnread).toBe(2)
  // A label counts the unread mail its view lists: not the trash, not spam.
  for (const id of ['a', 'b']) expect(counts.labels[id]).toBe(threads.filter((t) => t.unread && threadInView(t, `label:${id}`)).length)
  expect(counts.labels.a).toBe(2)
  expect(counts.folders.Projects).toBe(threads.filter((t) => t.folders?.includes('Projects') && t.unread).length)
})
