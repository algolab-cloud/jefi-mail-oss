# Jefi performance audit — 21 September 2026

Baseline: Jefi 0.5.0 / commit `8ac48270`, Apple M1 Pro, macOS 26.6.2, Bun 1.4.0.
These are local synthetic benchmarks, not measurements of a customer's mailbox or production network.
Sol agents reviewed the engine and rendering paths; the root agent reviewed findings and checked the highest-impact paths.

## Measured findings

| Area | Evidence | Improvement | Tracking |
| --- | --- | --- | --- |
| Markdown link extraction | The scanner joined the whole character mask for every input character. Same-process, three-run medians: 5.7 KB **97.6 → 0.44 ms**; 28.5 KB **2,381 → 1.96 ms**. A 114 KB message takes **8.88 ms** after the change. | Materialize the mask once after code, definitions and images are excluded. Implemented locally with extraction regression coverage. | `lume-1nu` |
| Optional phishing cache | Synthetic 400k domains + 800k URLs, 74.36 MB JSON: four fresh-process loads **1.79–2.43 s**; maximum 5 ms heartbeat gaps **85–221 ms**; immediate RSS increase **327–449 MiB**, including transient allocations. 10k lookups took **10–18 ms**. | Keep disabled services unloaded. For enabled services, move parsing/validation/persistence to a worker; evaluate an indexed disk representation to reduce full-feed memory use. | `lume-hdw` |
| Mailbox history pagination | On 50k single-message threads, normal Inbox `loadView` medians over three warm runs: 200 threads **150 ms / 0.12 MiB**; 1k **192 ms / 0.63 MiB**; 5k **433 ms / 3.19 MiB**. | Cursor pages should return only the next page, rather than rebuilding the entire loaded prefix. Fetch one extra row for `hasMore`. | `lume-2vz` |
| Account snapshots | At 50k rows: account fingerprint **15.47 ms**, default 200-thread materialization **52.31 ms**, `hasOlder` **20.21 ms**, clone **0.88 ms**. | Maintain an account revision in transactions, avoid repeated count queries, publish changes instead of full replacements, and refresh metadata only when changed. | `lume-2vz` |
| Search hydration | At 50k rows, FTS keys **27.99 ms** plus thread hydration **51.86 ms**. Query plans show account scanning and temporary B-trees in hydration. | Start from matching keys and hydrate through indexed joins. | `lume-c3g` |
| Reader find | Synthetic 24-message / 2.9 MiB thread: rebuilding message parts and searchable rows **9.76 ms median / 11.05 ms p95** for every query edit, then **0.69–1.45 ms** for matching. | Memoize parts using find-active state and body revision; cache normalized search text. | `lume-c0k` |

The normal Inbox pagination path uses `store.tsx` page limits and `loadView`. The engine's separate growing account window is used by fallback views; these are distinct paths.
Snapshot timings are component costs, not measured UI frame time. Serialized sizes are JSON estimates; the actual worker uses structured cloning.
Phishing-cache heartbeat gaps indicate JavaScript responsiveness, not measured rendered-frame latency. The memory readings include allocator and garbage-collection effects and are not a leak measurement.

## Source-confirmed opportunities needing measurement

- `src/sidebar.tsx` animates the Compose button with a 50 ms state timer even while idle. Gate decorative animation on visibility/focus and reduced-motion preferences.
- `src/html-view.tsx` polls native view bounds every 60 ms. Prefer layout/scroll/resize events where native APIs support them, retaining correctness around overlays.
- `src/store.tsx` exposes state and newly created action closures through one large context. Measure component commits during background sync before splitting contexts or adopting selectors.
- `src/engine/sync.ts` reconciles all known UIDs per mailbox, even on recurring sync. Use provider-supported incremental deletion/flag mechanisms where available, with a correct fallback audit strategy.

List rows are already virtualized and engine work already runs in a worker. Replacing either system wholesale is not the first recommendation.

## Validation and limits

The existing `scripts/testing/sync-benchmark.ts` was executed against disposable local IMAP fixtures:
1,012 messages completed first sync in 1.06 s; 10,012 messages showed the first list in 1.96 s and completed sync in 18.35 s.
These figures include local protocol/test-server work and do not attribute that time to one bottleneck.

Three isolated published-binary launches reached the workspace in 2.40–6.60 s, with high variance in automated Compose timing. The sample includes fixture and automation overhead and is insufficient for a startup regression threshold.

Session reproducers and raw evidence are in `tmp/markdown-perf-comparison.ts`, `tmp/markdown-perf-comparison.jsonl`, `tmp/phishing-perf-audit.ts`, and `tmp/phishing-perf-audit-results.jsonl`; engine microbenchmarks are `/tmp/lume-engine-audit.ts`, `/tmp/lume-view-audit.ts`, and `/tmp/lume-engine-plans.ts`.
These temporary files are local audit evidence, not shipped benchmark infrastructure.

After the audit, the user requested a compact link popover and explicitly optional Google/phishing-list features. That correction is tracked in `lume-qem`; the larger performance work remains in the issues above.
