import React, { useEffect, useRef, useState } from 'react'
import { FONT, TOPBAR_HEIGHT, useSettings } from './theme'
import { Icon } from './icons'
import { Face } from './primitives'
import { initials } from './accounts'
import { useMail } from './store'
import { Spinner } from './toast'
import { Tooltip } from './tooltip'
import { Button } from './ui'
import type { ScrubGroup, ScrubGroupBy, ScrubStats } from './engine/scrub'
import { RowAction, ShareBar, TabChip, formatBytes, messageCount } from './cleanup-parts'
import { SmartClean } from './cleanup-smart'
import { subscribeSmartRequests, takeSmartRequest } from './smart-clean'

export { formatBytes, messageCount }

// ---------------------------------------------------------------------------
// Clean up (Scrub): the mailbox grouped by sender, newsletter, age or size, with one-click
// archive / delete (optionally keeping the newest) and unsubscribe. Reports come straight from the
// local database, so they're instant however big the mailbox is.
// ---------------------------------------------------------------------------

const TABS: Array<{ id: ScrubGroupBy; label: string; blurb: string }> = [
  { id: 'newsletters', label: 'Newsletters', blurb: 'Bulk senders and mailing lists. Unsubscribe, then clear what they already sent.' },
  { id: 'senders', label: 'Top senders', blurb: 'Who fills your mailbox, by number of messages.' },
  { id: 'age', label: 'Old mail', blurb: 'Everything received before a point in time.' },
  { id: 'size', label: 'Large mail', blurb: 'Messages that take the most space, mostly attachments.' },
]

const KEEP = [0, 1, 5]

const ROW_HEIGHT = 55
const WINDOW = 30
const OVERDRAW = 10

export function CleanupPane() {
  const { C } = useSettings()
  const { scrubReport, scrubStats, scrub, unsubscribe, account } = useMail()
  const [stats, setStats] = useState<ScrubStats | null>(null)
  const [tab, setTab] = useState<ScrubGroupBy>('newsletters')
  // Insights and Smart are views of their own; the rest are reports grouped by `tab`.
  const [view, setView] = useState<'insights' | 'smart' | 'report'>(() => (takeSmartRequest() ? 'smart' : 'insights'))
  // "Review" on a scheduled clean-up's toast, while Clean up is already open.
  useEffect(() => subscribeSmartRequests(() => takeSmartRequest() && setView('smart')), [])
  const [keep, setKeep] = useState(0)
  const [groups, setGroups] = useState<ScrubGroup[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  // Rows the person has dealt with: gone from the list the moment they act, before the mail has
  // finished moving. Keyed by group, so a re-read of the report can't bring them back mid-flight.
  const [cleared, setCleared] = useState<Set<string>>(new Set())
  // Purging is the one action with no way back, so it asks first.
  const [confirming, setConfirming] = useState<ScrubGroup | null>(null)

  // Mailboxes can have thousands of senders: mount only the rows near the viewport, like the mail list.
  const [range, setRange] = useState({ start: 0, end: WINDOW })
  const onVisibleRange = (event: { startIndex?: number; endIndex?: number }) => {
    const start = Math.max(0, (event.startIndex ?? 0) - OVERDRAW)
    const end = Math.min(shown?.length ?? 0, (event.endIndex ?? WINDOW) + OVERDRAW)
    if (start !== range.start || end !== range.end) setRange({ start, end })
  }

  // Groups still being archived or deleted: a report read meanwhile must not bring them back.
  const inFlight = useRef(new Set<string>())
  const [statsFailed, setStatsFailed] = useState(false)

  // Another tab or account starts from a clean slate.
  useEffect(() => {
    setCleared(new Set())
    setGroups(null)
    setStats(null)
    setRange({ start: 0, end: WINDOW })
  }, [tab, account.id])
  // Read again after every finished action, in place: no spinner, no jump back to the top.
  useEffect(() => {
    let live = true
    setStatsFailed(false)
    void scrubReport(tab)
      .then((result) => {
        if (!live) return
        setGroups(result)
        // What finished is now whatever the report says (a sender with its newest kept stays).
        setCleared((prev) => new Set([...prev].filter((key) => inFlight.current.has(key))))
      })
      .catch(() => live && setGroups((current) => current ?? []))
    void scrubStats()
      .then((result) => live && setStats(result))
      .catch(() => live && setStatsFailed(true))
    return () => {
      live = false
    }
  }, [tab, account.id, version])

  const run = async (group: ScrubGroup, action: 'archive' | 'trash' | 'purge' | 'unsubscribe') => {
    // Unsubscribing leaves the mail where it is, so the row stays; the rest take it away.
    if (action === 'unsubscribe') {
      setBusy(`${group.key}:${action}`)
      try {
        await unsubscribe(group)
      } finally {
        setBusy(null)
      }
      return
    }
    // Gone from the list now; the mail moves in the background and the report catches up after.
    setCleared((prev) => new Set(prev).add(group.key))
    inFlight.current.add(group.key)
    try {
      await scrub(group, action, group.selector && 'sender' in group.selector ? keep : 0)
      inFlight.current.delete(group.key)
      setVersion((v) => v + 1)
    } catch {
      inFlight.current.delete(group.key)
      // It didn't happen, so the row comes back rather than leaving a gap the person can't act on.
      setCleared((prev) => {
        const next = new Set(prev)
        next.delete(group.key)
        return next
      })
    }
  }

  const about = TABS.find((t) => t.id === tab)!
  // What's left to act on: the report minus the rows already sent on their way.
  const shown = groups?.filter((group) => !cleared.has(group.key)) ?? null
  const totals = (shown ?? []).reduce((sum, g) => ({ messages: sum.messages + g.messages, bytes: sum.bytes + g.bytes }), { messages: 0, bytes: 0 })
  const maxMessages = Math.max(1, ...(shown ?? []).map((g) => g.messages))
  const bySender = tab === 'senders' || tab === 'newsletters'

  return (
    <div testId="cleanup" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.list }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 16, gap: 10 }}>
        <Icon name="broom" size={17} color={C.secondary} />
        <text style={{ fontSize: 19, fontWeight: 600, color: C.text, fontFamily: FONT }}>Clean up</text>
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '100%', maxWidth: 760, flexGrow: 1, minHeight: 0, paddingLeft: 24, paddingRight: 24, paddingBottom: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Tabs */}
          <div style={{ display: 'flex', flexDirection: 'row', gap: 6, paddingTop: 6 }}>
            <TabChip label="Insights" active={view === 'insights'} onClick={() => setView('insights')} testId="cleanup-tab-insights" />
            <TabChip label="Smart" active={view === 'smart'} onClick={() => setView('smart')} testId="cleanup-tab-smart" />
            {TABS.map((t) => (
              <div
                key={t.id}
                testId={`cleanup-tab-${t.id}`}
                onClick={() => {
                  setView('report')
                  setTab(t.id)
                }}
                style={{
                  height: 30,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  backgroundColor: view === 'report' && tab === t.id ? C.chip : undefined,
                  hover: { backgroundColor: C.overlay },
                }}
              >
                <text style={{ fontSize: 13, fontWeight: 500, color: view === 'report' && tab === t.id ? C.text : C.secondary, fontFamily: FONT }}>{t.label}</text>
              </div>
            ))}
          </div>

          {view === 'smart' ? (
            <SmartClean />
          ) : view === 'insights' ? (
            stats ? (
              <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column' }}>
                <Overview stats={stats} />
              </div>
            ) : (
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {statsFailed ? (
                  <text testId="cleanup-stats-error" style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>Couldn't read your mailbox. Try again in a moment.</text>
                ) : (
                  <Spinner size={16} color={C.accent} />
                )}
              </div>
            )
          ) : (
            <>
          {/* Summary + keep-newest */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>{about.blurb}</text>
              {shown && shown.length ? (
                <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>
                  {bySender ? `${shown.length.toLocaleString()} ${shown.length === 1 ? 'sender' : 'senders'} · ${messageCount(totals.messages)} · ${formatBytes(totals.bytes)}` : 'Each rule includes the ones below it.'}
                </text>
              ) : null}
            </div>
            {bySender ? (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, marginRight: 4 }}>Keep newest</text>
                {KEEP.map((n) => (
                  <div
                    key={n}
                    testId={`cleanup-keep-${n}`}
                    onClick={() => setKeep(n)}
                    style={{ height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 13, display: 'flex', alignItems: 'center', cursor: 'pointer', backgroundColor: keep === n ? C.chip : undefined, hover: { backgroundColor: C.overlay } }}
                  >
                    <text style={{ fontSize: 12, fontWeight: 500, color: keep === n ? C.text : C.secondary, fontFamily: FONT }}>{n === 0 ? 'None' : String(n)}</text>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* Groups */}
          <div style={{ flexShrink: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 12, backgroundColor: C.raised, overflow: 'hidden' }}>
            {shown === null ? (
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Spinner size={16} color={C.accent} />
              </div>
            ) : shown.length === 0 ? (
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>Nothing to clean up here</text>
              </div>
            ) : (
              <virtual-list
                itemCount={shown.length}
                estimatedItemHeight={ROW_HEIGHT}
                windowStart={range.start}
                onVisibleRange={onVisibleRange}
                // As tall as its rows, shrinking to scroll once they outgrow the pane.
                style={{ height: shown.length * ROW_HEIGHT, flexShrink: 1, minHeight: 0 }}
                testId="cleanup-list"
              >
                {shown.slice(range.start, range.end).map((group, i) => {
                  const index = range.start + i
                  return (
                <div
                      key={group.key}
                      testId={`cleanup-row-${group.key}`}
                      style={{
                        height: ROW_HEIGHT,
                        // Rows in the virtual list size to their content unless told to fill the column.
                        width: '100%',
                        flexShrink: 0,
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        paddingLeft: 14,
                        paddingRight: 10,
                        borderTopWidth: index === 0 ? 0 : 1,
                        borderColor: C.divider,
                      }}
                    >
                      {bySender ? (
                        <Face letter={initials(group.label)} size={34} />
                      ) : (
                        <div style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.chip, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Icon name={tab === 'age' ? 'clock' : 'paperclip'} size={16} color={C.secondary} />
                        </div>
                      )}
                      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{group.label}</text>
                        <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                          {`${messageCount(group.messages)} · ${formatBytes(group.bytes)}${group.unread ? ` · ${group.unread.toLocaleString()} unread` : ''}${bySender ? ` · ${group.detail}` : ''}`}
                        </text>
                      </div>
                      <ShareBar share={group.messages / maxMessages} />
                      {bySender && (group.canUnsubscribe || tab === 'newsletters') ? (
                        <RowAction label="Unsubscribe" busy={busy === `${group.key}:unsubscribe`} onClick={() => void run(group, 'unsubscribe')} testId={`cleanup-unsubscribe-${group.key}`} />
                      ) : null}
                      <RowAction label="Archive" busy={busy === `${group.key}:archive`} onClick={() => void run(group, 'archive')} testId={`cleanup-archive-${group.key}`} />
                      <RowAction label="Delete" danger busy={busy === `${group.key}:trash`} onClick={() => void run(group, 'trash')} testId={`cleanup-delete-${group.key}`} />
                      <RowAction label="Delete forever" danger onClick={() => setConfirming(group)} testId={`cleanup-purge-${group.key}`} />
                    </div>
                  )
                })}
              </virtual-list>
            )}
          </div>
            </>
          )}
        </div>
      </div>
      {confirming ? (
        <PurgeConfirm
          group={confirming}
          keep={confirming.selector && 'sender' in confirming.selector ? keep : 0}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const group = confirming
            setConfirming(null)
            void run(group, 'purge')
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Deleting on the server can't be taken back, so it asks first and says exactly how much is at
 * stake. Everything else in Clean up moves mail, and moving can be undone.
 */
function PurgeConfirm({ group, keep, onCancel, onConfirm }: { group: ScrubGroup; keep: number; onCancel: () => void; onConfirm: () => void }) {
  const { C } = useSettings()
  const { title, body } = purgeCopy(group, keep)
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000000AA' }} onClick={onCancel} />
      <div
        testId="cleanup-purge-confirm"
        style={{
          width: 440,
          borderRadius: 16,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 48, spreadRadius: 0, color: '#00000077' },
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          paddingLeft: 24,
          paddingRight: 24,
          paddingTop: 22,
          paddingBottom: 18,
        }}
      >
        <text style={{ fontSize: 16.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</text>
        <text style={{ fontSize: 13.5, lineHeight: 19, color: C.secondary, fontFamily: FONT }}>{body}</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 }}>
          <Button label="Delete forever" variant="danger" onClick={onConfirm} testId="cleanup-purge-confirm-go" />
          <div style={{ flexGrow: 1 }} />
          <Button label="Keep them" variant="ghost" onClick={onCancel} testId="cleanup-purge-cancel" />
        </div>
      </div>
    </div>
  )
}

/**
 * What "Delete forever" says it will do. A sender's group can keep its newest conversations (Keep
 * newest), and the age and size groups are described by their rule, not as someone mail is "from".
 */
export function purgeCopy(group: Pick<ScrubGroup, 'label' | 'messages' | 'bytes' | 'selector'>, keep: number) {
  const bySender = !!group.selector && 'sender' in group.selector
  const kept = bySender && keep > 0
  const title = kept ? `Delete all but the newest ${keep} for good?` : `Delete ${messageCount(group.messages)} for good?`
  const what = !bySender
    ? `Every message ${group.label.charAt(0).toLowerCase()}${group.label.slice(1)}`
    : kept
      ? `Everything from ${group.label} except its newest ${keep === 1 ? 'conversation' : `${keep} conversations`}`
      : `Everything from ${group.label}`
  const body = `${what} is erased on the server as well as here, whole conversations included, and not moved to Trash, so there is nothing to restore it from. It frees ${kept ? 'up to ' : ''}${formatBytes(group.bytes)}.`
  return { title, body }
}
const DAY = 86_400_000
const CELL = 10
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** One hue, five steps: empty, then quartiles of the busiest day. */
const LEVELS = [0, 0.3, 0.5, 0.75, 1]

/** A year of mail, one square per day, a column per week (like a contribution graph). */
function ActivityGraph({ daily }: { daily: Record<string, number> }) {
  const { C } = useSettings()
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const first = new Date(today.getTime() - (52 * 7 + today.getDay()) * DAY)
  const peak = Math.max(1, ...Object.values(daily))
  const level = (count: number) => (count === 0 ? 0 : Math.min(4, Math.ceil((count / peak) * 4)))
  const weeks = Array.from({ length: 53 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = new Date(first.getTime() + (w * 7 + d) * DAY)
      return date > today ? null : { date, count: daily[dayKey(date)] ?? 0 }
    }),
  )
  const total = Object.values(daily).reduce((a, b) => a + b, 0)
  const busiest = Object.entries(daily).sort((a, b) => b[1] - a[1])[0]
  return (
    <Card title={`${total.toLocaleString()} messages in the last year`} right={busiest ? `Busiest day: ${new Date(`${busiest[0]}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${busiest[1]}` : undefined}>
      <div testId="cleanup-activity" style={{ display: 'flex', flexDirection: 'row', gap: 2 }}>
        <div style={{ width: 26, display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 16 }}>
          {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) => (
            <div key={i} style={{ height: CELL, display: 'flex', alignItems: 'center' }}>
              <text style={{ fontSize: 9.5, color: C.muted, fontFamily: FONT }}>{d}</text>
            </div>
          ))}
        </div>
        {weeks.map((week, w) => {
          const start = week[0]?.date
          const newMonth = start && start.getDate() <= 7
          return (
            <div key={w} style={{ width: CELL, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ height: 14, width: CELL, overflow: 'visible' }}>
                {newMonth ? <text style={{ fontSize: 9.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{MONTHS[start.getMonth()]!}</text> : null}
              </div>
              {week.map((day, d) => {
                const l = day ? level(day.count) : -1
                const cell = <div style={{ width: CELL, height: CELL, borderRadius: 2, backgroundColor: l < 0 ? undefined : l === 0 ? C.chip : C.accent, opacity: l > 0 ? LEVELS[l] : 1, pointerEvents: 'none' }} />
                return day ? (
                  <Tooltip key={d} delay={0} label={day.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} detail={messageCount(day.count)}>
                    {cell}
                  </Tooltip>
                ) : (
                  <div key={d}>{cell}</div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
        <text style={{ fontSize: 10.5, color: C.muted, fontFamily: FONT, marginRight: 3 }}>Less</text>
        {LEVELS.map((o, i) => (
          <div key={i} style={{ width: CELL, height: CELL, borderRadius: 2, backgroundColor: i === 0 ? C.chip : C.accent, opacity: i === 0 ? 1 : o }} />
        ))}
        <text style={{ fontSize: 10.5, color: C.muted, fontFamily: FONT, marginLeft: 3 }}>More</text>
      </div>
    </Card>
  )
}

function Card({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, borderRadius: 12, backgroundColor: C.raised, paddingLeft: 14, paddingRight: 14, paddingTop: 12, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <text style={{ flexGrow: 1, fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</text>
        {right ? <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{right}</text> : null}
      </div>
      {children}
    </div>
  )
}

/** Single-series bars on one baseline; the tallest is labelled. Axis labels sit in their own row so they can't widen or lift a bar. */
function Bars({ values, labels, names, testId }: { values: number[]; labels: string[]; /** Full name of each bar, for its tooltip. */ names: string[]; testId: string }) {
  const { C } = useSettings()
  const peak = Math.max(1, ...values)
  // Sparse labels (every 6 hours) span the columns up to the next label.
  const spans = labels.flatMap((label, i) => {
    if (!label) return []
    let next = i + 1
    while (next < labels.length && !labels[next]) next++
    return [{ label, span: next - i }]
  })
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 62 }}>
        {values.map((v, i) => (
          <Tooltip key={i} grow delay={0} label={names[i]} detail={messageCount(v)}>
          <div style={{ flexGrow: 1, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
            {v === peak && v > 0 ? (
              <div style={{ width: 0, height: 12, display: 'flex', flexDirection: 'row', justifyContent: 'center', overflow: 'visible' }}>
                <text style={{ fontSize: 9.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0 }}>{v.toLocaleString()}</text>
              </div>
            ) : null}
            <div style={{ width: '100%', maxWidth: 26, height: v ? Math.max(2, Math.round((v / peak) * 48)) : 1, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: v ? C.accent : C.divider, pointerEvents: 'none' }} />
          </div>
          </Tooltip>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 2 }}>
        {spans.map(({ label, span }) => (
          <div key={label} style={{ flexGrow: span, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'row', justifyContent: span === 1 ? 'center' : 'flex-start' }}>
            <text style={{ fontSize: 9.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
          </div>
        ))}
      </div>
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CHART_HEIGHT = 84

function Overview({ stats }: { stats: ScrubStats }) {
  const { C } = useSettings()
  const pct = (part: number) => `${Math.round((part / Math.max(1, stats.messages)) * 100)}%`
  const tiles = [
    { label: 'Mailbox', value: formatBytes(stats.bytes), sub: `${stats.messages.toLocaleString()} messages · ${stats.senders.toLocaleString()} senders` },
    { label: 'Newsletters', value: pct(stats.bulk.messages), sub: `${stats.bulk.messages.toLocaleString()} messages · ${formatBytes(stats.bulk.bytes)}` },
    { label: 'Never opened', value: pct(stats.unread), sub: `${stats.unread.toLocaleString()} unread` },
    { label: 'Over a year old', value: formatBytes(stats.old.bytes), sub: `${stats.old.messages.toLocaleString()} messages` },
    { label: 'Over 5 MB', value: formatBytes(stats.large.bytes), sub: `${stats.large.messages.toLocaleString()} messages` },
  ]
  const peak = Math.max(1, ...stats.monthly.map((m) => m.bulk + m.other))
  const h = (count: number) => (count ? Math.max(2, Math.round((count / peak) * CHART_HEIGHT)) : 0)
  const total12 = stats.monthly.reduce((sum, m) => sum + m.bulk + m.other, 0)
  return (
    <div testId="cleanup-overview" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6, flexShrink: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
        {tiles.map((tile) => (
          <div key={tile.label} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, borderRadius: 12, backgroundColor: C.raised, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{tile.label}</text>
            <text style={{ fontSize: 20, fontWeight: 600, color: C.text, fontFamily: FONT }}>{tile.value}</text>
            <text style={{ fontSize: 11, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{tile.sub}</text>
          </div>
        ))}
      </div>
      <div style={{ borderRadius: 12, backgroundColor: C.raised, paddingLeft: 14, paddingRight: 14, paddingTop: 12, paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <text style={{ flexGrow: 1, fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{`Mail received · last 12 months · ${total12.toLocaleString()}`}</text>
          <Legend color={C.accent} label="Newsletters" />
          <Legend color={C.muted} label="Everything else" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: CHART_HEIGHT + 16 }}>
          {stats.monthly.map((m) => (
            <Tooltip key={m.month} grow delay={0} label={new Date(`${m.month}-15T12:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} detail={`${messageCount(m.bulk + m.other)} · ${m.bulk.toLocaleString()} newsletters`}>
            <div testId={`cleanup-month-${m.month}`} style={{ flexGrow: 1, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
              {m.other ? <div style={{ width: '100%', maxWidth: 28, height: h(m.other), borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: C.muted, pointerEvents: 'none' }} /> : null}
              {m.bulk ? <div style={{ width: '100%', maxWidth: 28, height: h(m.bulk), borderTopLeftRadius: m.other ? 0 : 4, borderTopRightRadius: m.other ? 0 : 4, backgroundColor: C.accent, pointerEvents: 'none' }} /> : null}
              {!m.bulk && !m.other ? <div style={{ width: '100%', maxWidth: 28, height: 1, backgroundColor: C.divider, pointerEvents: 'none' }} /> : null}
              <text style={{ fontSize: 10.5, color: C.muted, fontFamily: FONT, marginTop: 2 }}>{MONTHS[Number(m.month.slice(5)) - 1]!}</text>
            </div>
            </Tooltip>
          ))}
        </div>
      </div>
      <ActivityGraph daily={stats.daily} />
      <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
        <Card title="By day of the week">
          <Bars testId="cleanup-weekdays" names={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']} values={stats.weekdays} labels={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']} />
        </Card>
        <Card title="By hour of the day">
          <Bars testId="cleanup-hours" names={stats.hours.map((_, h) => `${h}:00 – ${h + 1}:00`)} values={stats.hours} labels={stats.hours.map((_, h) => (h % 6 === 0 ? `${h}:00` : ''))} />
        </Card>
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <text style={{ fontSize: 11.5, color: C.secondary, fontFamily: FONT }}>{label}</text>
    </div>
  )
}
