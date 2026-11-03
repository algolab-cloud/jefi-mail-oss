/**
 * Notices the Mac waking from sleep: a repeating timer that fires much later than scheduled means
 * the process was suspended. Sockets rarely survive that, so the engine reconnects and resyncs.
 */
export function detectWake(onWake: (sleptMs: number) => void, options: { intervalMs?: number; toleranceMs?: number; now?: () => number } = {}) {
  const intervalMs = options.intervalMs ?? 15_000
  const toleranceMs = options.toleranceMs ?? 30_000
  const now = options.now ?? Date.now
  let last = now()
  const handle = setInterval(() => {
    const current = now()
    const gap = current - last
    last = current
    if (gap > intervalMs + toleranceMs) onWake(gap - intervalMs)
  }, intervalMs)
  return () => clearInterval(handle)
}
