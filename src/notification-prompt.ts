import type { NotificationPermission } from './native/notify'

// ---------------------------------------------------------------------------
// When to show the notification permission screen to someone who already uses Jefi. New people
// meet it inside onboarding instead; this decides the sheet shown over the app on launch.
// ---------------------------------------------------------------------------

/** "Not now" keeps the screen away this long. */
export const NOTIFICATION_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000

export type NotificationPromptSettings = {
  onboarded: boolean
  notificationPromptDismissedAt: number
  notificationDeniedPromptVersion: string
}

export type NotificationPromptContext = {
  appVersion: string
  /** Something else has the person's attention: onboarding, What's new, a wizard. */
  busy: boolean
}

/** The variant to show, or null for none. 'denied' offers System Settings instead of the prompt. */
export function shouldShowNotificationPrompt(
  status: NotificationPermission,
  settings: NotificationPromptSettings,
  now: number,
  context: NotificationPromptContext,
): 'undetermined' | 'denied' | null {
  if (status !== 'undetermined' && status !== 'denied') return null
  if (!settings.onboarded || context.busy) return null
  const snoozed = settings.notificationPromptDismissedAt > 0 && now - settings.notificationPromptDismissedAt < NOTIFICATION_PROMPT_SNOOZE_MS
  if (snoozed) return null
  // A refusal was a choice: remind at most once per version, never every launch.
  if (status === 'denied' && settings.notificationDeniedPromptVersion === context.appVersion) return null
  return status
}

/** JEFI_FORCE_NOTIFICATION_PROMPT=undetermined|denied pretends that status, for screenshots. */
export function forcedNotificationPrompt(env: Record<string, string | undefined> = process.env): 'undetermined' | 'denied' | null {
  const value = env.JEFI_FORCE_NOTIFICATION_PROMPT
  return value === 'undetermined' || value === 'denied' ? value : null
}
