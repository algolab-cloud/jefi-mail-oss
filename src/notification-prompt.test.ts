import { expect, test } from 'bun:test'
import { NOTIFICATION_PROMPT_SNOOZE_MS, forcedNotificationPrompt, shouldShowNotificationPrompt } from './notification-prompt'

const NOW = Date.UTC(2026, 8, 26)
const fresh = { onboarded: true, notificationPromptDismissedAt: 0, notificationDeniedPromptVersion: '' }
const context = { appVersion: '0.9.0', busy: false }

test('an open question is asked once the app is up', () => {
  expect(shouldShowNotificationPrompt('undetermined', fresh, NOW, context)).toBe('undetermined')
})

test('granted, or no helper to ask with, shows nothing', () => {
  expect(shouldShowNotificationPrompt('granted', fresh, NOW, context)).toBeNull()
  expect(shouldShowNotificationPrompt('unavailable', fresh, NOW, context)).toBeNull()
})

test('never during onboarding or over another sheet', () => {
  expect(shouldShowNotificationPrompt('undetermined', { ...fresh, onboarded: false }, NOW, context)).toBeNull()
  expect(shouldShowNotificationPrompt('undetermined', fresh, NOW, { ...context, busy: true })).toBeNull()
})

test('"Not now" keeps it away for two weeks', () => {
  const dismissed = { ...fresh, notificationPromptDismissedAt: NOW - NOTIFICATION_PROMPT_SNOOZE_MS + 1000 }
  expect(shouldShowNotificationPrompt('undetermined', dismissed, NOW, context)).toBeNull()
  expect(shouldShowNotificationPrompt('denied', dismissed, NOW, context)).toBeNull()
  expect(shouldShowNotificationPrompt('undetermined', dismissed, NOW + 1000, context)).toBe('undetermined')
})

test('a refusal is mentioned at most once per version', () => {
  expect(shouldShowNotificationPrompt('denied', fresh, NOW, context)).toBe('denied')
  const seen = { ...fresh, notificationDeniedPromptVersion: '0.9.0' }
  expect(shouldShowNotificationPrompt('denied', seen, NOW, context)).toBeNull()
  expect(shouldShowNotificationPrompt('denied', seen, NOW, { ...context, appVersion: '0.10.0' })).toBe('denied')
  // The version marker is only about refusals; an open question still gets asked.
  expect(shouldShowNotificationPrompt('undetermined', seen, NOW, context)).toBe('undetermined')
})

test('the screenshot hook accepts only the two variants', () => {
  expect(forcedNotificationPrompt({ JEFI_FORCE_NOTIFICATION_PROMPT: 'denied' })).toBe('denied')
  expect(forcedNotificationPrompt({ JEFI_FORCE_NOTIFICATION_PROMPT: 'undetermined' })).toBe('undetermined')
  expect(forcedNotificationPrompt({ JEFI_FORCE_NOTIFICATION_PROMPT: '1' })).toBeNull()
  expect(forcedNotificationPrompt({})).toBeNull()
})
