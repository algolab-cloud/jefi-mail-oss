import { useSyncExternalStore } from 'react'
import { APP_VERSION } from './version'

// ---------------------------------------------------------------------------
// Bug reports and feature requests from inside the app. They go to jefi.app's contact endpoint (the
// same inbox as the website's form), with the app's version, macOS and chip if the person allows it.
// Nothing else is attached: no mail, no logs, no account details beyond the reply address they type.
// ---------------------------------------------------------------------------

export type FeedbackKind = 'bug' | 'feature' | 'general'

export const FEEDBACK_KINDS: Array<{ value: FeedbackKind; label: string; placeholder: string }> = [
  { value: 'bug', label: 'Bug', placeholder: 'What happened, and what did you expect? Steps to make it happen again help most.' },
  { value: 'feature', label: 'Feature request', placeholder: 'What would you like Jefi to do, and what would it help you with?' },
  { value: 'general', label: 'Other', placeholder: 'Questions, ideas, anything else.' },
]

export type FeedbackDraft = { kind: FeedbackKind; message: string; email: string; name: string; includeContext: boolean }

/** Stored beside the report on jefi.app (messages.app_version, os_version, arch). */
export type FeedbackContext = { version: string; os: string; arch: string }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** What's wrong with a draft before it's sent, field by field; empty when it can go. */
export function feedbackErrors(d: FeedbackDraft): Partial<Record<'message' | 'email', string>> {
  const errors: Partial<Record<'message' | 'email', string>> = {}
  const message = d.message.trim()
  if (message.length < 5) errors.message = 'Please write a little more'
  else if (message.length > 5000) errors.message = 'Please keep it under 5,000 characters'
  if (!EMAIL_RE.test(d.email.trim())) errors.email = 'An address to reply to'
  return errors
}

/** The request body jefi.app/api/contact takes. */
export function feedbackBody(d: FeedbackDraft, context: FeedbackContext | null) {
  return {
    topic: d.kind,
    message: d.message.trim(),
    email: d.email.trim(),
    name: d.name.trim() || undefined,
    ...(d.includeContext && context ? { context } : {}),
  }
}

let macOS: string | null = null
/** "0.8.0", "15.1", "arm64": what's sent with a report when allowed. */
export function feedbackContext(): FeedbackContext {
  if (macOS === null) {
    try {
      macOS = Bun.spawnSync(['sw_vers', '-productVersion']).stdout.toString().trim()
    } catch {
      macOS = ''
    }
  }
  return { version: APP_VERSION, os: macOS, arch: process.arch }
}

export type SendFeedback = (d: FeedbackDraft) => Promise<{ ok: true } | { ok: false; error: string }>

export const sendFeedback: SendFeedback = async (d) => {
  const base = process.env.JEFI_API_URL ?? 'https://jefi.app'
  try {
    const response = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(feedbackBody(d, feedbackContext())),
    })
    if (response.ok) return { ok: true }
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    return { ok: false, error: body?.error ?? `jefi.app answered ${response.status}` }
  } catch {
    return { ok: false, error: 'Couldn’t reach jefi.app. Check your connection and try again.' }
  }
}

// The sheet is mounted once (FeedbackHost); anything can open it on a kind.
let open: { kind: FeedbackKind; key: number } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

export function openFeedback(kind: FeedbackKind = 'bug') {
  open = { kind, key: Date.now() }
  emit()
}

export function closeFeedback() {
  open = null
  emit()
}

export function useFeedbackRequest() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
}
