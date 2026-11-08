import type { ScrubGroup, ScrubStats, SenderProfile, ThreadPeek } from './scrub'
import type { MailRule, RuleMatchCount } from './rules'
import type { Account } from '../accounts'
import type { EngineMethod, FromWorker, ToWorker } from './protocol'
import type { ConnectionReport } from './connection'
import type { MailThread } from '../data'
import type { EngineEvent, EngineListener, GetAttachmentResult, GetOriginalResult, MailEngine, ScrubMove, UnreadThread, ViewPage } from './types'
import type { Calendar, CalendarEvent, EventLink, EventOccurrence, Invite, InviteSummary, InviteView, Note, NoteLink, Task, TaskLabel, TaskLink, TaskProject } from './calendar/types'

// ---------------------------------------------------------------------------
// MailEngine backed by the engine worker. Commands are posted as messages; events come back in
// batches. If the worker dies, every account reports a sync error instead of the UI hanging.
// ---------------------------------------------------------------------------

/**
 * Inside a `bun build --compile` binary the worker is an extra entrypoint (package.json and
 * scripts/bundle.ts), embedded relative to the entrypoints' common root (src/) with a .js extension.
 * Use that absolute $bunfs path: relative specifiers resolve against the working directory first and
 * can silently load the project's source files instead. In dev, resolve next to this module.
 */
const workerEntry = () => (import.meta.url.includes('$bunfs') ? '/$bunfs/root/engine/worker.js' : new URL('./worker.ts', import.meta.url).href)

/**
 * `env` replaces the worker's environment. Tests pass one with JEFI_CONFIG_DIR: a worker starts with
 * the process's original environment, so setting process.env first doesn't reach it.
 */
export function createWorkerEngine(options: { env?: Record<string, string> } = {}): MailEngine {
  const worker = new Worker(workerEntry(), options.env ? { env: options.env } : undefined)
  const listeners = new Set<EngineListener>()
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 1
  let accounts: Account[] = []
  let crashed: string | null = null
  let disposed = false

  const emit = (events: EngineEvent[]) => {
    for (const listener of listeners) listener(events)
  }

  const fail = (reason: string) => {
    if (crashed || disposed) return
    crashed = reason
    for (const { reject } of pending.values()) reject(new Error(reason))
    pending.clear()
    emit(
      accounts.flatMap((a): EngineEvent[] => [
        { type: 'connection', accountId: a.id, status: 'error', error: reason },
        { type: 'syncState', accountId: a.id, manual: false, state: { status: 'error', phase: undefined, error: reason } },
      ]),
    )
  }

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data
    if (message.kind === 'events') emit(message.events)
    else if (message.kind === 'result') {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (!call) return
      if (message.ok) call.resolve(message.value)
      else call.reject(new Error(message.error))
    }
  }
  worker.onerror = (event) => {
    event.preventDefault?.()
    const reason = event.error instanceof Error ? event.error.message : (event.message?.match(/^error: (.*)$/m)?.[1] ?? event.message?.split('\n')[0])
    fail(`Mail engine crashed: ${reason || 'unknown error'}`)
  }
  worker.addEventListener('close', () => fail('Mail engine stopped'))

  const call = <T = void>(method: EngineMethod, ...args: unknown[]): Promise<T> => {
    if (crashed) return Promise.reject(new Error(crashed))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ kind: 'command', id, method, args } satisfies ToWorker)
    })
  }
  // Fire-and-forget commands surface failures as events via the worker; a rejected call only means the engine is gone.
  const send = (method: EngineMethod, ...args: unknown[]) => void call(method, ...args).catch(() => {})

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setAccounts(next) {
      accounts = next
      send('setAccounts', next)
    },
    checkConnection: (account, secret) => call<ConnectionReport>('checkConnection', account, secret),
    // Browser sign-in can sit for minutes while the person authenticates.
    signIn: (provider, loginHint) => call<{ email?: string; secret: string }>('signIn', provider, loginHint),
    cancelSignIn: () => send('cancelSignIn'),
    setSecret: (accountId, secret) => call('setSecret', accountId, secret),
    forgetAccount: (accountId) => call('forgetAccount', accountId),
    purgeAccountsExcept: (keep) => call<string[]>('purgeAccountsExcept', keep),
    setOffline: (offline) => send('setOffline', offline),
    syncNow: (accountId, manual) => send('syncNow', accountId, manual),
    setAutoSync: (on) => send('setAutoSync', on),
    appActivated: () => send('appActivated'),
    loadMore: (accountId) => send('loadMore', accountId),
    loadView: (accountId, view, page) => call<ViewPage | null>('loadView', accountId, view, page).catch(() => null),
    unreadAcrossAccounts: (limit) => call<UnreadThread[]>('unreadAcrossAccounts', limit).catch(() => []),
    loadThread: (accountId, threadId) => call<MailThread | null>('loadThread', accountId, threadId).catch(() => null),
    screenerEnabled: (accountId) => call<boolean>('screenerEnabled', accountId).catch(() => false),
    setScreener: (accountId, on) => call('setScreener', accountId, on),
    screenSender: (accountId, email, verdict) => call<number>('screenSender', accountId, email, verdict).catch(() => 0),
    listRules: (accountId) => call<MailRule[]>('listRules', accountId).catch(() => []),
    saveRule: (accountId, rule) => call<MailRule[]>('saveRule', accountId, rule),
    deleteRule: (accountId, id) => call<MailRule[]>('deleteRule', accountId, id).catch(() => []),
    runRule: (accountId, id) => call<number>('runRule', accountId, id),
    countRuleMatches: (accountId, match) => call<RuleMatchCount>('countRuleMatches', accountId, match),
    search: (accountId, query) => call<MailThread[]>('search', accountId, query).catch(() => []),
    scrubStats: (accountId) => call<ScrubStats | null>('scrubStats', accountId).catch(() => null),
    scrubReport: (accountId, by) => call<ScrubGroup[]>('scrubReport', accountId, by).catch(() => []),
    senderProfiles: (accountId) => call<SenderProfile[]>('senderProfiles', accountId),
    senderThreads: (accountId, senders) => call<ThreadPeek[]>('senderThreads', accountId, senders),
    spamThreads: (accountId) => call<ThreadPeek[]>('spamThreads', accountId),
    scrub: (accountId, selector, folder, keepLatest, except) => call<ScrubMove[]>('scrub', accountId, selector, folder, keepLatest, except).catch(() => []),
    unscrub: (accountId, moves) => void call('unscrub', accountId, moves).catch(() => {}),
    unsubscribe: (accountId, sender) =>
      call<{ ok: true; done: boolean; mailto?: string; link?: string } | { ok: false; error: string }>('unsubscribe', accountId, sender).catch(() => ({ ok: false as const, error: 'Jefi stopped responding' })),
    openAttachment: (accountId, messageId, index) =>
      call<{ ok: true } | { ok: false; error: string }>('openAttachment', accountId, messageId, index).catch(() => ({ ok: false as const, error: 'Jefi stopped responding' })),
    getAttachment: (accountId, messageId, index) =>
      call<GetAttachmentResult>('getAttachment', accountId, messageId, index).catch(() => ({ ok: false as const, error: 'Jefi stopped responding' })),
    getOriginalMessage: (accountId, messageId) =>
      call<GetOriginalResult>('getOriginalMessage', accountId, messageId).catch(() => ({ ok: false as const, error: 'Jefi stopped responding' })),
    send: (accountId, threadId, mail, sendAt) => send('send', accountId, threadId, mail, sendAt),
    snooze: (accountId, threadId, until) => send('snooze', accountId, threadId, until),
    unsnooze: (accountId, threadId) => send('unsnooze', accountId, threadId),
    cancelSend: (accountId, threadId) => call<boolean>('cancelSend', accountId, threadId).catch(() => false),
    sendReply: (accountId, threadId, messageId, reply, sendAt) => send('sendReply', accountId, threadId, messageId, reply, sendAt),
    retry: (accountId, threadId, messageId) => send('retry', accountId, threadId, messageId),
    confirmSent: (accountId, threadId, messageId) => send('confirmSent', accountId, threadId, messageId),
    setFlags: (accountId, threadId, flags) => send('setFlags', accountId, threadId, flags),
    move: (accountId, threadId, folder) => send('move', accountId, threadId, folder),
    setLabels: (accountId, threadId, labels) => send('setLabels', accountId, threadId, labels),
    createLabel: (accountId, label) => send('createLabel', accountId, label),
    renameLabel: (accountId, labelId, name) => send('renameLabel', accountId, labelId, name),
    deleteLabel: (accountId, labelId) => send('deleteLabel', accountId, labelId),
    deleteForever: (accountId, threadId) => send('deleteForever', accountId, threadId),
    saveDraft: (accountId, threadId, mail) => send('saveDraft', accountId, threadId, mail),
    // Reads fall back to nothing if the engine is gone; writes reject, so the UI can say what failed.
    setReminderDefaults: (defaults) => send('setReminderDefaults', defaults),
    listCalendars: () => call<Calendar[]>('listCalendars').catch(() => []),
    createLocalCalendar: (input) => call<Calendar>('createLocalCalendar', input),
    updateCalendar: (id, patch) => call<Calendar>('updateCalendar', id, patch),
    deleteCalendar: (id) => call('deleteCalendar', id),
    listEvents: (from, to, calendarIds) => call<EventOccurrence[]>('listEvents', from, to, calendarIds).catch(() => []),
    getEvent: (id) => call<CalendarEvent | null>('getEvent', id).catch(() => null),
    eventByUid: (uid, recurrenceId) => call<CalendarEvent | null>('eventByUid', uid, recurrenceId).catch(() => null),
    saveEvent: (input, options) => call<CalendarEvent>('saveEvent', input, options),
    deleteEvent: (id, scope, occurrenceStart) => call<boolean>('deleteEvent', id, scope, occurrenceStart),
    eventLinks: (eventId) => call<EventLink[]>('eventLinks', eventId).catch(() => []),
    linkEvent: (eventId, target) => call<EventLink>('linkEvent', eventId, target),
    unlinkEvent: (linkId) => call<boolean>('unlinkEvent', linkId),
    eventsForThread: (accountId, threadId) => call<CalendarEvent[]>('eventsForThread', accountId, threadId).catch(() => []),
    invitesForMessage: (accountId, messageId) => call<Invite[]>('invitesForMessage', accountId, messageId).catch(() => []),
    inviteForMessage: (accountId, messageId) => call<InviteView | null>('inviteForMessage', accountId, messageId).catch(() => null),
    pendingInvites: (now) => call<InviteSummary[]>('pendingInvites', now).catch(() => []),
    respondToInvite: (accountId, messageId, response, comment, options) =>
      call<{ event: CalendarEvent; outboxId: string | null }>('respondToInvite', accountId, messageId, response, comment, options),
    sendEventInvites: (eventId, kind, options) => call<{ outboxId: string; recipients: string[] }>('sendEventInvites', eventId, kind, options),
    listNotes: (query) => call<Note[]>('listNotes', query).catch(() => []),
    getNote: (id) => call<Note | null>('getNote', id).catch(() => null),
    saveNote: (input) => call<Note>('saveNote', input),
    deleteNote: (id) => call<boolean>('deleteNote', id),
    linkNote: (noteId, target) => call<NoteLink>('linkNote', noteId, target),
    unlinkNote: (linkId) => call<boolean>('unlinkNote', linkId),
    notesForThread: (accountId, threadId) => call<Note[]>('notesForThread', accountId, threadId).catch(() => []),
    notesForEvent: (eventId) => call<Note[]>('notesForEvent', eventId).catch(() => []),
    listTasks: (query) => call<Task[]>('listTasks', query).catch(() => []),
    getTask: (id) => call<Task | null>('getTask', id).catch(() => null),
    saveTask: (input) => call<Task>('saveTask', input),
    setTaskDone: (id, done) => call<Task>('setTaskDone', id, done),
    deleteTask: (id) => call<boolean>('deleteTask', id),
    linkTask: (taskId, target) => call<TaskLink>('linkTask', taskId, target),
    unlinkTask: (linkId) => call<boolean>('unlinkTask', linkId),
    tasksForThread: (accountId, threadId) => call<Task[]>('tasksForThread', accountId, threadId).catch(() => []),
    listTaskProjects: () => call<TaskProject[]>('listTaskProjects').catch(() => []),
    saveTaskProject: (input) => call<TaskProject>('saveTaskProject', input),
    deleteTaskProject: (id) => call<boolean>('deleteTaskProject', id),
    listTaskLabels: () => call<TaskLabel[]>('listTaskLabels').catch(() => []),
    saveTaskLabel: (input) => call<TaskLabel>('saveTaskLabel', input),
    deleteTaskLabel: (id) => call<boolean>('deleteTaskLabel', id),
    dispose() {
      disposed = true
      listeners.clear()
      pending.clear()
      worker.terminate()
    },
  }
}
