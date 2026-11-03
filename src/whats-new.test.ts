import { describe, expect, test } from 'bun:test'
import { currentNotes, majorMinor, notesFor, olderThan, whatsNewDecision, WHATS_NEW, type ReleaseNotes } from './whats-new'
import { DEFAULT_SETTINGS } from './theme'

const notes: ReleaseNotes[] = [{ version: '0.6', title: 't', intro: 'i', items: [] }]
const decide = (onboarded: boolean, lastSeenVersion: string, appVersion: string) => whatsNewDecision({ onboarded, lastSeenVersion, appVersion }, notes)

describe('majorMinor', () => {
  test('keeps major.minor', () => {
    expect(majorMinor('0.6.0')).toBe('0.6')
    expect(majorMinor('0.6.12')).toBe('0.6')
    expect(majorMinor('v1.10.2-beta')).toBe('1.10')
  })
  test('empty or odd input gives nothing', () => {
    expect(majorMinor('')).toBe('')
    expect(majorMinor('dev')).toBe('')
  })
})

describe('whatsNewDecision', () => {
  test('an existing 0.5 user updating to 0.6 sees the notes', () => {
    expect(decide(true, '', '0.6.0')).toBe('show')
    expect(decide(true, '0.5.1', '0.6.0')).toBe('show')
  })
  test('once seen, it stays away', () => {
    expect(decide(true, '0.6.0', '0.6.0')).toBe('nothing')
  })
  test('a patch release records itself without showing the notes again', () => {
    expect(decide(true, '0.6.0', '0.6.1')).toBe('record')
  })
  test('a release without notes records itself silently', () => {
    expect(decide(true, '0.6.1', '0.7.0')).toBe('record')
    expect(decide(true, '', '0.5.1')).toBe('record')
  })
  test('a fresh install waits for onboarding, which records the version', () => {
    expect(decide(false, '', '0.6.0')).toBe('nothing')
    expect(decide(true, '0.6.0', '0.6.0')).toBe('nothing')
  })
})

test('notes are found by major.minor, and the palette falls back to the newest', () => {
  expect(notesFor('0.6.3')?.version).toBe('0.6')
  expect(notesFor('0.5.1')).toBeUndefined()
  expect(currentNotes('0.5.1')).toBe(WHATS_NEW[0])
})

test('settings from before 0.6 have no lastSeenVersion; the default is empty', () => {
  expect({ ...DEFAULT_SETTINGS, ...{ onboarded: true } }.lastSeenVersion).toBe('')
})

test('going back to an older build records it instead of showing notes already seen past', () => {
  const notes: ReleaseNotes[] = [
    { version: '0.8', title: 'Eight', items: [] },
    { version: '0.7', title: 'Seven', items: [] },
  ] as never
  expect(whatsNewDecision({ onboarded: true, lastSeenVersion: '0.8.0', appVersion: '0.7.3' }, notes)).toBe('record')
  expect(whatsNewDecision({ onboarded: true, lastSeenVersion: '0.7.3', appVersion: '0.8.0' }, notes)).toBe('show')
  expect(olderThan('0.7.9', '0.8.0')).toBe(true)
  expect(olderThan('1.0.0', '0.9.9')).toBe(false)
  expect(olderThan('0.8', '0.8.0')).toBe(false)
  expect(olderThan('', '0.8.0')).toBe(false)
})
