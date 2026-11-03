import { describe, expect, test } from 'bun:test'
import type { MailThread } from './data'
import { inboxUnreadCount, unreadBasis } from './unread-count'

const t = (id: string, unread: boolean, extra: Partial<MailThread> = {}) => ({ id, folder: 'inbox', unread, ...extra }) as MailThread

describe('inbox unread badge', () => {
  const window = [t('a', true), t('b', true), t('c', false), t('s', true, { screened: true })]

  test('an Inbox bigger than the window counts from the engine, not the rows it holds', () => {
    const basis = unreadBasis(1003, window)
    expect(inboxUnreadCount(window, basis)).toBe(1003)
  })

  test('reading, unreading and archiving within the window move it at once', () => {
    const basis = unreadBasis(1003, window)
    expect(inboxUnreadCount([t('a', false), t('b', true), t('c', false)], basis)).toBe(1002)
    expect(inboxUnreadCount([t('a', true), t('b', true), t('c', true)], basis)).toBe(1004)
    expect(inboxUnreadCount([t('a', true), t('b', true, { folder: 'archive' }), t('c', false)], basis)).toBe(1002)
  })

  test('older mail paged into the list is already in the total, so it is not counted twice', () => {
    const basis = unreadBasis(1003, window)
    expect(inboxUnreadCount([...window, t('old-1', true), t('old-2', true)], basis)).toBe(1003)
  })

  test('without an engine count it counts the list, and never goes below zero', () => {
    expect(inboxUnreadCount(window, null)).toBe(2)
    expect(inboxUnreadCount([t('a', false), t('b', false)], unreadBasis(0, window))).toBe(0)
  })
})
