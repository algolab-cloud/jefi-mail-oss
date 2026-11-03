import { describe, expect, test } from 'bun:test'
import type { MailThread } from './data'
import { successor, unclickedThread } from './selection'

const t = (id: string, folder: MailThread['folder'] = 'inbox') => ({ id, folder }) as MailThread

describe('successor', () => {
  test('the conversation below the archived one takes its place', () => {
    expect(successor(['a', 'b', 'c', 'd'], [t('a'), t('b'), t('d')], 'c')?.id).toBe('d')
  })

  test('the last conversation leaving falls back to the one above it', () => {
    expect(successor(['a', 'b', 'c'], [t('a'), t('b')], 'c')?.id).toBe('b')
  })

  test('skips neighbours that left with it, and drafts', () => {
    expect(successor(['a', 'b', 'c', 'd', 'e'], [t('a'), t('d', 'drafts'), t('e')], 'b')?.id).toBe('e')
  })

  test('nothing to do while the conversation is still listed, or when it was never listed', () => {
    expect(successor(['a', 'b'], [t('a'), t('b')], 'a')).toBeNull()
    expect(successor(['a', 'b'], [t('a')], 'z')).toBeNull()
    expect(successor(['a'], [], 'a')).toBeNull()
    expect(successor(['a'], [t('a')], null)).toBeNull()
  })
})

describe('unclickedThread', () => {
  test('starts on the first conversation, passing over drafts', () => {
    expect(unclickedThread([t('d', 'drafts'), t('a'), t('b')], null)?.id).toBe('a')
    expect(unclickedThread([], null)).toBeUndefined()
  })

  test('new mail above the one shown does not replace it', () => {
    expect(unclickedThread([t('new'), t('a'), t('b')], 'a')?.id).toBe('a')
  })

  test('once it leaves the list, the first conversation again', () => {
    expect(unclickedThread([t('new'), t('b')], 'a')?.id).toBe('new')
  })
})
