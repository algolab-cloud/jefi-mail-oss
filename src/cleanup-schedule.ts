import { useEffect, useRef, useSyncExternalStore } from 'react'
import { aiErrorMessage, classifySenders, cleanupConnection, findWorthKeeping } from './ai'
import { keepersOf, saveSmartResult, smartScan, updateSmartResult } from './smart-clean'
import { useMail } from './store'
import { useSettings, type CleanupAction, type CleanupSchedule } from './theme'
import { toast } from './toast'
import { useAi } from './use-ai'

// ---------------------------------------------------------------------------
// Scheduled clean-up: while Jefi is open, the smart clean-up runs daily or weekly over every
// account. It sorts each Inbox (the result shows under Clean up → Smart) and, if the person chose
// to, archives the junk or moves it to Trash. Only senders called junk are touched: never "not
// sure", never anyone the person writes to, answers, flags or chose to keep, and never the junk
// senders' conversations that look worth keeping. Moves come with Undo. Real mail found in Spam is
// only reported: moving it out is the person's call, since phishing is made to look real.
// ---------------------------------------------------------------------------

const DAY = 86_400_000
export const CLEANUP_EVERY: Record<Exclude<CleanupSchedule, 'off'>, number> = { daily: DAY, weekly: 7 * DAY }
/** How often to look whether a run is due. */
const CHECK_MS = 15 * 60_000
/** Not in the middle of launching and syncing: the first look waits a little. */
const FIRST_CHECK_MS = 2 * 60_000

export function cleanupDue(schedule: CleanupSchedule, lastRunAt: number, now: number) {
  return schedule !== 'off' && now - lastRunAt >= CLEANUP_EVERY[schedule]
}

/** When the next run is due (ms), or null when it's off. Overdue means "at the next check". */
export function nextCleanupAt(schedule: CleanupSchedule, lastRunAt: number, now: number): number | null {
  if (schedule === 'off') return null
  return Math.max(now, lastRunAt + CLEANUP_EVERY[schedule])
}

export type CleanupOutcome = { action: CleanupAction; senders: number; junk: number; moved: number; kept: number; spam: number; errors: string[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** What a run did, in a line for Settings. */
export function cleanupSummary(outcome: CleanupOutcome): string {
  if (outcome.errors.length && !outcome.senders) return `Couldn't run: ${outcome.errors[0]}`
  const what =
    outcome.junk === 0
      ? `No junk among ${plural(outcome.senders, 'sender')}`
      : outcome.action === 'review'
        ? `Found ${plural(outcome.junk, 'junk sender')} to review`
        : `${outcome.action === 'trash' ? 'Moved' : 'Archived'} ${plural(outcome.moved, 'conversation')}${outcome.action === 'trash' ? ' to Trash' : ''} from ${plural(outcome.junk, 'junk sender')}`
  const extra = [
    outcome.kept ? `kept ${plural(outcome.kept, 'conversation')} that look${outcome.kept === 1 ? 's' : ''} important` : null,
    outcome.spam ? `${plural(outcome.spam, 'message')} in Spam may be real` : null,
    outcome.errors.length ? `${plural(outcome.errors.length, 'account')} failed` : null,
  ].filter(Boolean)
  return [what, ...extra].join(' · ')
}

// --- Whether a run is going, for Settings -----------------------------------------------------

let running = false
const listeners = new Set<() => void>()
const setRunning = (value: boolean) => {
  running = value
  listeners.forEach((listener) => listener())
}
export const useCleanupRunning = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => running,
  )

let runNow: (() => Promise<void>) | null = null
/** Settings → "Run now": a run whatever the schedule says. */
export const runCleanupNow = () => runNow?.() ?? Promise.resolve()

/** Runs the clean-up when it's due. Mounted once, in the workspace; `onReview` opens Clean up → Smart. */
export function useScheduledCleanup(onReview: () => void) {
  const { settings, update } = useSettings()
  const ai = useAi()
  const mail = useMail()
  const latest = useRef({ settings, update, ai, mail, onReview })
  latest.current = { settings, update, ai, mail, onReview }

  const run = async (force: boolean) => {
    const { settings, update, ai, mail } = latest.current
    if (running || !ai.connection || !mail.hasAccounts || !settings.onboarded) return
    if (!force && !cleanupDue(settings.cleanupSchedule, settings.cleanupLastRunAt, Date.now())) return
    setRunning(true)
    // Recorded up front: a run that fails waits for the next one instead of retrying every check.
    update({ cleanupLastRunAt: Date.now() })
    const connection = cleanupConnection(ai.connection, settings.cleanupModels)
    const keep = new Set(settings.cleanupKeepSenders)
    const action = settings.cleanupAction
    const outcome: CleanupOutcome = { action, senders: 0, junk: 0, moved: 0, kept: 0, spam: 0, errors: [] }
    try {
      for (const account of mail.accounts) {
        try {
          const me = { name: account.name, email: account.email }
          const quiet = { onText: () => {} }
          const scan = await smartScan({
            profiles: () => mail.senderProfiles(account.id),
            senderThreads: (senders) => mail.senderThreads(senders, account.id),
            spamThreads: () => mail.spamThreads(account.id),
            keep,
            askSenders: (block) => classifySenders(connection, block, me, quiet),
            askKeepers: (block) => findWorthKeeping(connection, block, me, 'junk', quiet),
            askSpam: (block) => findWorthKeeping(connection, block, me, 'spam', quiet),
          })
          saveSmartResult(account.id, scan)
          const junk = scan.groups.filter((g) => g.verdict === 'junk')
          const kept = keepersOf(junk)
          outcome.senders += scan.groups.length
          outcome.junk += junk.length
          outcome.kept += kept.length
          outcome.spam += scan.spam.length
          if (junk.length && action !== 'review') {
            outcome.moved += await mail.scrubAll(junk, action, 0, { accountId: account.id, title: 'Scheduled clean-up', except: kept })
            const done = new Set(junk.map((g) => g.key))
            updateSmartResult(account.id, (current) => ({ groups: current.groups.filter((g) => !done.has(g.key)) }))
          }
        } catch (err) {
          outcome.errors.push(aiErrorMessage(err))
        }
      }
    } finally {
      const summary = cleanupSummary(outcome)
      latest.current.update({ cleanupLastSummary: summary })
      if (outcome.errors.length && !outcome.senders) toast.error("Scheduled clean-up couldn't run", { description: outcome.errors[0] })
      else if ((action === 'review' && outcome.junk) || outcome.spam) toast('Scheduled clean-up', { description: summary, action: { label: 'Review', onClick: () => latest.current.onReview() } })
      setRunning(false)
    }
  }

  useEffect(() => {
    runNow = () => run(true)
    return () => {
      runNow = null
    }
  }, [])

  useEffect(() => {
    if (settings.cleanupSchedule === 'off') return
    const check = () => void run(false)
    const first = setTimeout(check, FIRST_CHECK_MS)
    const handle = setInterval(check, CHECK_MS)
    return () => {
      clearTimeout(first)
      clearInterval(handle)
    }
  }, [settings.cleanupSchedule])
}
