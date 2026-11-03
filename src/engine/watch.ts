import type { ImapFlow } from 'imapflow'

// ---------------------------------------------------------------------------
// Push for new mail: one long-lived connection per account sits in IMAP IDLE on the inbox and
// reports when the message count grows. Dropped connections reconnect with backoff, and a
// reconnect reports `resumed` so the engine can catch up on anything that arrived meanwhile.
// ---------------------------------------------------------------------------

export type InboxWatcher = {
  /** Drop the current connection and reconnect now (after sleep or a network change). */
  restart(): void
  stop(): void
  /** The live connection, once its inbox is selected — null while (re)connecting. Borrow it for a
   * quick inbox-only fetch instead of opening a second connection; only ever touch the inbox on it. */
  client(): ImapFlow | null
}

/** What IDLE reported: messages arrived, messages went, or flags changed without a UID to apply them by. */
export type NewMailReason = 'exists' | 'expunge' | 'flags'

export type WatchOptions = {
  connect: () => Promise<ImapFlow>
  mailbox?: string
  /** The inbox changed in a way only a sync can reconcile; `reason` says what IDLE saw. */
  onNewMail: (reason: NewMailReason) => void
  /** A flag (or Gmail label) change with a known UID, batched per microtask. Events without a UID
   * (older servers, some moves) fall back to onNewMail so the caller can reconcile with a sync. */
  onFlags?: (updates: Array<{ uid: number; flags: string[] }>) => void
  /** Connected again after a drop: mail may have arrived while disconnected. */
  onResumed: () => void
  onDisconnected?: (error: string) => void
  /** Delays between reconnect attempts; the last one repeats. */
  backoffMs?: number[]
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]

export function watchInbox(options: WatchOptions): InboxWatcher {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF
  let stopped = false
  let attempt = 0
  let everConnected = false
  let conn: ImapFlow | null = null
  /** Only set once the inbox is actually selected, so callers never borrow a connection mid-handshake. */
  let ready: ImapFlow | null = null
  let flagBatch: Array<{ uid: number; flags: string[] }> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  const scheduleReconnect = (error: string) => {
    if (stopped || retryTimer) return
    options.onDisconnected?.(error)
    const delay = backoff[Math.min(attempt, backoff.length - 1)]!
    attempt++
    retryTimer = setTimeout(() => {
      retryTimer = null
      void open()
    }, delay)
  }

  const open = async () => {
    if (stopped) return
    const mine = ++generation
    let next: ImapFlow
    try {
      next = await options.connect()
    } catch (err) {
      if (mine === generation) scheduleReconnect(err instanceof Error ? err.message : String(err))
      return
    }
    if (stopped || mine !== generation) {
      next.close()
      return
    }
    conn = next
    next.on('error', () => {})
    next.on('close', () => {
      if (conn === next) conn = null
      if (ready === next) ready = null
      if (mine === generation) scheduleReconnect('Connection closed')
    })
    try {
      const box = await next.mailboxOpen(options.mailbox ?? 'INBOX', { readOnly: true })
      let known = box.exists
      // Deletions and flag changes made elsewhere arrive during IDLE too.
      const changed = (reason: NewMailReason) => {
        if (!stopped && mine === generation) options.onNewMail(reason)
      }
      // With QRESYNC on, deletions come as VANISHED by UID; (EARLIER) ones only answer a resync's own
      // SELECT (the inbox fast path can sync on this connection), which is already reconciling them.
      next.on('expunge', (event: { earlier?: boolean }) => {
        if (!event.earlier) changed('expunge')
      })
      next.on('flags', (event: { uid?: number; flags: Set<string> }) => {
        if (stopped || mine !== generation) return
        // No UID (or no one to hand batched updates to): fall back to a sync, which can figure it out.
        if (!event.uid || !options.onFlags) return changed('flags')
        if (!flagBatch) {
          flagBatch = []
          queueMicrotask(() => {
            const batch = flagBatch!
            flagBatch = null
            options.onFlags!(batch)
          })
        }
        flagBatch.push({ uid: event.uid, flags: [...event.flags] })
      })
      next.on('exists', (event: { count: number; prevCount?: number }) => {
        // imapflow's prevCount already went down for deletions; `known` alone didn't, so the first
        // arrival after a deletion looked like no change and waited for the next poll.
        const before = event.prevCount ?? known
        // Ignore a retired connection: a notice can land after stop()/restart() began closing it.
        if (event.count > before && !stopped && mine === generation) options.onNewMail('exists')
        known = event.count
      })
      attempt = 0
      if (everConnected) options.onResumed()
      everConnected = true
      ready = next
      // This connection only waits for mail, so IDLE now rather than after imapflow's 15s autoIdleDelay.
      // Once IDLE ends (maxIdleTime refresh, a command), imapflow's auto-idle takes over again.
      next.idle().catch(() => {})
    } catch (err) {
      next.close()
      if (mine === generation) scheduleReconnect(err instanceof Error ? err.message : String(err))
    }
  }

  void open()

  return {
    restart() {
      if (stopped) return
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      attempt = 0
      generation++
      const previous = conn
      conn = null
      ready = null
      previous?.close()
      everConnected = true // a restart always wants a catch-up once connected
      void open()
    },
    stop() {
      stopped = true
      generation++
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      const previous = conn
      conn = null
      ready = null
      if (previous) previous.logout().catch(() => previous.close())
    },
    client() {
      return ready
    },
  }
}
