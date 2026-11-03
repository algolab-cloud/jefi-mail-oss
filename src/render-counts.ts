import { writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Render counters for measuring store fan-out. Off unless JEFI_RENDER_COUNTS is set: `1` prints the
// counts to stderr on exit, anything else is a file path the counts are written to (JSON) on exit and
// every half second, so a driving script can read them while the app is still open.
// ---------------------------------------------------------------------------

const target = process.env.JEFI_RENDER_COUNTS
const counts = new Map<string, number>()

/** Counts one render of `name`. A no-op unless render counting is on. */
export const countRender: (name: string) => void = target
  ? (name) => counts.set(name, (counts.get(name) ?? 0) + 1)
  : () => {}

export function renderCounts(): Record<string, number> {
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))
}

export const renderCountsOn = !!target

let commits = 0
let commitMs = 0

/** A <Profiler> onRender: totals the commits under the mail store and the time React spent rendering them. */
export function countCommit(_id: string, _phase: string, actualDuration: number) {
  commits++
  commitMs += actualDuration
  counts.set('(commits)', commits)
  counts.set('(render ms)', Math.round(commitMs))
}

function dump() {
  const json = JSON.stringify(renderCounts(), null, 2)
  if (target === '1') process.stderr.write(`render counts ${json}\n`)
  else if (target) writeFileSync(target, json)
}

if (target) {
  process.on('exit', dump)
  if (target !== '1') setInterval(dump, 500).unref()
}
