# Sync performance

Figures for a first sync (headers, then the body backfill) on an Apple silicon Mac. Two harnesses:

- `scripts/testing/sync-benchmark.ts [count]`: the real engine worker against a local IMAP fixture.
  It measures engine work alone, with no network latency or provider throttling.
- `scripts/testing/real-sync-measure.ts <account-id> [max-minutes]`: one live account through the
  real engine in its own process, with a temporary config dir, read-only Keychain secrets and every
  IMAP write method blocked. See the script header for the safety rules.

## Synthetic (local fixture)

| Messages | First threads | Full first sync | RSS baseline / sampled peak |
| --- | --- | --- | --- |
| 5,000 (main, v0.6.x) | ~1.75 s | 5.2–5.6 s | not recorded |
| 10,012 (2026-09-20) | 1.60 s | 12.9 s | 19 / 157 MiB |

## Live first sync, measured (2026-09-25, dev build on main after v0.6.4)

Work Gmail `acct-mu7y9cl1`: 668 messages (INBOX 587, All Mail 630, Sent 31, Trash 28, Spam 10,
Drafts 4 locations).

| Metric | Value |
| --- | --- |
| First thread publication | 6.6 s |
| Headers complete (sync idle) | 13.3 s (~50 messages/s) |
| Bodies complete (668 of 668) | 120 s from start, ~6.2 bodies/s after headers |
| Engine process RSS | 75 MiB at start, 133 MiB peak during headers, 172 MiB peak overall, 100 MiB settled |
| CPU (one core = 100%) | 10% during headers, 7% overall |
| mail.db (+WAL) | 31 MiB |
| IMAP connections | 2 (sync + backfill; push was off) |
| Server writes | none attempted |

The start RSS includes imapflow and the engine modules, loaded before the first sample. The work is
network-bound: CPU stays near 10% throughout.

Outlook `acct-mu7zb63y` (~12k messages, INBOX ~6.9k) was not measured: reading its Keychain entry
blocked (no answer within 30 s, which looks like a macOS Keychain access prompt waiting for a click),
so the engine never connected. Re-run `bun scripts/testing/real-sync-measure.ts acct-mu7zb63y 45`
with someone at the machine to allow access.

## Live repair sync (2026-09-24)

After a data-loss bug, the dev build refilled the user's real accounts. That is a first sync in
effect, since the folders were nearly empty:

| Account / folder | Before → after (of server total) | Time |
| --- | --- | --- |
| Second Gmail INBOX | 8 → 38,591 (+48 duplicate aliases) of 38,639 | ~30 min |
| Second Gmail [Gmail]/All Mail | 128 → 57,718 (+60) of 57,778 | ~20 min more |
| Outlook INBOX | 2 → 6,890 of 6,893 | ~3 min |

Later, the body backfill ran at about 7–8 bodies/s after lume-d68. That is in line with the ~6
bodies/s measured on the small Gmail account above.
