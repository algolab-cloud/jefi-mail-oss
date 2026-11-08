import type { SenderProfile, ThreadPeek } from './engine/scrub'

// ---------------------------------------------------------------------------
// Smart clean-up: the person's own AI sorts the senders in their Inbox into junk, mail worth
// keeping, and the ones it isn't sure about. Nothing moves until the person says so.
//
// Then it takes a closer look, one conversation at a time, where a whole-sender verdict could
// lose something: the conversations of junk senders (a shop's receipt among its promotions, a sign-in
// code among an app's notifications) are checked for ones worth keeping, which every clean-up then
// leaves where they are; and Spam is checked for real mail the server misfiled.
//
// What the mailbox already knows wins over the model: anyone the person writes to, answers, flags
// or chose to keep is important, and is never sent to the model at all. Only sender names and
// addresses, counts, subject lines and short previews are sent; full messages stay on the Mac. The
// model's answers are untrusted text: anything that isn't well formed is read as "unsure" (senders)
// or "nothing picked" (conversations).
// ---------------------------------------------------------------------------

export type Verdict = 'junk' | 'unsure' | 'important'
/** A conversation found worth keeping, with why. */
export type Keeper = { threadId: string; subject: string; reason: string }
/** `keepers`: conversations of this sender a clean-up leaves where they are. */
export type SmartGroup = SenderProfile & { verdict: Verdict; reason: string; keepers: Keeper[] }
/** A conversation in Spam that looks like real mail. */
export type SpamRescue = ThreadPeek & { reason: string }
export type SmartScan = { groups: SmartGroup[]; spam: SpamRescue[] }

/** Senders per request: small enough for a quick, reliable answer, big enough to be few requests. */
export const BATCH = 40
/** Conversations per request: a line each, so more fit. */
export const PEEK_BATCH = 50
/** At most this many conversations of junk senders get the closer look, newest per sender first. */
const PEEK_MAX = 600
/** Requests in flight at once. */
const PARALLEL = 3
const REASON_MAX = 60
const VERDICTS: readonly Verdict[] = ['junk', 'unsure', 'important']

/** The verdict the mailbox itself gives, or null when it's the model's call. */
export function knownVerdict(sender: SenderProfile, keep: ReadonlySet<string>): { verdict: Verdict; reason: string } | null {
  if (keep.has(sender.detail.toLowerCase())) return { verdict: 'important', reason: 'You chose to keep them' }
  if (sender.wrote > 0) return { verdict: 'important', reason: sender.wrote === 1 ? 'You wrote to them' : `You wrote to them ${sender.wrote} times` }
  if (sender.answered > 0) return { verdict: 'important', reason: 'You answered their mail' }
  if (sender.flagged > 0) return { verdict: 'important', reason: 'You flagged their mail' }
  return null
}

const oneLine = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max)
const quoted = (value: string, max: number) => `"${oneLine(value, max).replace(/"/g, "'")}"`

/** One numbered line per sender: who, how much, whether it looks bulk, and what they've been sending. */
export function sendersForModel(batch: SenderProfile[]): string {
  return batch
    .map((sender, i) => {
      const facts = [
        `${sender.messages} ${sender.messages === 1 ? 'message' : 'messages'}`,
        sender.unread ? `${sender.unread} unread` : 'all read',
        sender.canUnsubscribe ? 'has an unsubscribe link' : sender.bulk ? 'bulk-style address' : null,
      ].filter(Boolean)
      const subjects = sender.subjects.map((s) => quoted(s, 90)).join('; ')
      return `${i + 1}. ${oneLine(sender.label, 60)} <${sender.detail}> | ${facts.join(', ')} | recent subjects: ${subjects || '(none)'}`
    })
    .join('\n')
}

/** One numbered line per conversation: sender, subject, and a short preview. */
export function threadsForModel(batch: ThreadPeek[]): string {
  return batch
    .map((t, i) => `${i + 1}. From: ${oneLine(t.fromName, 60)} <${t.sender}> | Subject: ${quoted(t.subject || '(no subject)', 120)} | Preview: ${quoted(t.snippet, 140)}`)
    .join('\n')
}

/** The JSON array in the answer, allowing a code fence or a sentence around it. */
function arrayIn(text: string): unknown[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** The 0-based position an item's `id` (1-based) names in a batch of `count`, or null. */
function positionOf(record: Record<string, unknown>, count: number): number | null {
  const id = typeof record.id === 'number' ? record.id : typeof record.id === 'string' ? Number(record.id) : NaN
  return Number.isInteger(id) && id >= 1 && id <= count ? id - 1 : null
}

const reasonOf = (record: Record<string, unknown>) => (typeof record.reason === 'string' ? oneLine(record.reason, REASON_MAX) : '')

/** Verdicts by position in the batch (0-based). Ids out of range, unknown verdicts and repeats are dropped. */
export function parseVerdicts(text: string, count: number): Map<number, { verdict: Verdict; reason: string }> {
  const out = new Map<number, { verdict: Verdict; reason: string }>()
  for (const item of arrayIn(text) ?? []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const at = positionOf(record, count)
    if (at === null || out.has(at)) continue
    const verdict = typeof record.verdict === 'string' ? (record.verdict.trim().toLowerCase() as Verdict) : null
    if (!verdict || !VERDICTS.includes(verdict)) continue
    out.set(at, { verdict, reason: reasonOf(record) })
  }
  return out
}

/** The conversations picked as worth keeping, by position in the batch (0-based), with why. */
export function parsePicks(text: string, count: number): Map<number, string> {
  const out = new Map<number, string>()
  for (const item of arrayIn(text) ?? []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const at = positionOf(record, count)
    if (at !== null && !out.has(at)) out.set(at, reasonOf(record) || 'Looks important')
  }
  return out
}

/** Runs `job` over `batches`, PARALLEL at a time, stopping between batches when `signal` aborts. */
async function inBatches<T>(batches: T[][], job: (batch: T[]) => Promise<void>, signal?: AbortSignal) {
  let next = 0
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) throw new Error('Stopped')
      await job(batches[next++]!)
    }
  }
  if (signal?.aborted) throw new Error('Stopped')
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker))
}

const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

/**
 * Sorts every sender: the mailbox's own verdict where it has one, the model's for the rest, in
 * batches of BATCH. `ask` sends one batch's block and returns the model's answer.
 */
export async function sortSenders(
  senders: SenderProfile[],
  keep: ReadonlySet<string>,
  ask: (block: string) => Promise<string>,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<SmartGroup[]> {
  const verdicts = new Map<string, { verdict: Verdict; reason: string }>()
  const unknown: SenderProfile[] = []
  for (const sender of senders) {
    const known = knownVerdict(sender, keep)
    if (known) verdicts.set(sender.key, known)
    else unknown.push(sender)
  }
  let done = 0
  onProgress?.(0, unknown.length)
  await inBatches(
    chunk(unknown, BATCH),
    async (batch) => {
      const parsed = parseVerdicts(await ask(sendersForModel(batch)), batch.length)
      batch.forEach((sender, i) => verdicts.set(sender.key, parsed.get(i) ?? { verdict: 'unsure', reason: '' }))
      done += batch.length
      onProgress?.(done, unknown.length)
    },
    signal,
  )
  return senders.map((sender) => ({ ...sender, ...(verdicts.get(sender.key) ?? { verdict: 'unsure' as const, reason: '' }), keepers: [] }))
}

/**
 * The conversations among `threads` worth keeping, by thread id, with why. Starred ones are kept
 * without asking; the rest go to the model in batches of PEEK_BATCH.
 */
export async function pickWorthKeeping(
  threads: ThreadPeek[],
  ask: (block: string) => Promise<string>,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const picked = new Map<string, string>()
  const unknown: ThreadPeek[] = []
  for (const thread of threads) {
    if (thread.flagged) picked.set(thread.threadId, 'You starred it')
    else unknown.push(thread)
  }
  let done = 0
  onProgress?.(0, unknown.length)
  await inBatches(
    chunk(unknown, PEEK_BATCH),
    async (batch) => {
      const picks = parsePicks(await ask(threadsForModel(batch)), batch.length)
      for (const [at, reason] of picks) picked.set(batch[at]!.threadId, reason)
      done += batch.length
      onProgress?.(done, unknown.length)
    },
    signal,
  )
  return picked
}

export type ScanStage = 'senders' | 'keepers' | 'spam'

/**
 * The whole smart clean-up for one account: sort the senders, look through the junk senders'
 * conversations for ones to keep, and look through Spam for real mail. The `ask*` functions send a
 * block to the model; the rest read the mailbox.
 */
export async function smartScan(deps: {
  profiles: () => Promise<SenderProfile[]>
  senderThreads: (senders: string[]) => Promise<ThreadPeek[]>
  spamThreads: () => Promise<ThreadPeek[]>
  keep: ReadonlySet<string>
  askSenders: (block: string) => Promise<string>
  askKeepers: (block: string) => Promise<string>
  askSpam: (block: string) => Promise<string>
  onProgress?: (stage: ScanStage, done: number, total: number) => void
  signal?: AbortSignal
}): Promise<SmartScan> {
  const { signal, onProgress } = deps
  const groups = await sortSenders(await deps.profiles(), deps.keep, deps.askSenders, (done, total) => onProgress?.('senders', done, total), signal)

  const junk = groups.filter((g) => g.verdict === 'junk')
  const threads = junk.length ? (await deps.senderThreads(junk.map((g) => g.detail))).slice(0, PEEK_MAX) : []
  const keepers = await pickWorthKeeping(threads, deps.askKeepers, (done, total) => onProgress?.('keepers', done, total), signal)
  const bySender = new Map<string, Keeper[]>()
  for (const thread of threads) {
    const reason = keepers.get(thread.threadId)
    if (reason) bySender.set(thread.sender, [...(bySender.get(thread.sender) ?? []), { threadId: thread.threadId, subject: thread.subject, reason }])
  }

  const spam = await deps.spamThreads()
  const rescued = await pickWorthKeeping(
    spam.map((t) => ({ ...t, flagged: false })),
    deps.askSpam,
    (done, total) => onProgress?.('spam', done, total),
    signal,
  )
  return {
    groups: groups.map((g) => (bySender.has(g.detail) ? { ...g, keepers: bySender.get(g.detail)! } : g)),
    spam: spam.flatMap((t) => (rescued.has(t.threadId) ? [{ ...t, reason: rescued.get(t.threadId)! }] : [])),
  }
}

/** Every kept conversation in these groups: what a clean-up of them must leave alone. */
export const keepersOf = (groups: SmartGroup[]) => groups.flatMap((g) => g.keepers.map((k) => k.threadId))

// --- The last result, per account ---------------------------------------------------------------
// Sorting costs AI requests, so it's kept while Jefi runs: leaving Clean up and coming back shows
// what was found, minus anything already dealt with.

type Stored = SmartScan & { at: number }
const results = new Map<string, Stored>()
const resultListeners = new Set<(accountId: string) => void>()
const changed = (accountId: string) => resultListeners.forEach((listener) => listener(accountId))

export const smartResult = (accountId: string) => results.get(accountId) ?? null
export function saveSmartResult(accountId: string, scan: SmartScan, at = Date.now()) {
  results.set(accountId, { ...scan, at })
  changed(accountId)
}
export function updateSmartResult(accountId: string, change: (scan: SmartScan) => Partial<SmartScan>) {
  const current = results.get(accountId)
  if (!current) return
  results.set(accountId, { ...current, ...change(current) })
  changed(accountId)
}
/** Called with the account whose result changed, e.g. when a scheduled run finishes. */
export function subscribeSmartResults(listener: (accountId: string) => void) {
  resultListeners.add(listener)
  return () => void resultListeners.delete(listener)
}

// --- "Review" from a scheduled run: open Clean up on the Smart tab ------------------------------

let smartRequested = false
const viewListeners = new Set<() => void>()

/** Asks Clean up to show Smart: now if it's open, or when it next opens. */
export function requestSmartView() {
  smartRequested = true
  viewListeners.forEach((listener) => listener())
}
/** True once per request; Clean up calls it when it opens and when asked. */
export function takeSmartRequest() {
  const asked = smartRequested
  smartRequested = false
  return asked
}
export function subscribeSmartRequests(listener: () => void) {
  viewListeners.add(listener)
  return () => void viewListeners.delete(listener)
}
