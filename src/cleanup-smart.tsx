import React, { useEffect, useRef, useState } from 'react'
import { FONT, useSettings } from './theme'
import { Icon } from './icons'
import { Face } from './primitives'
import { initials } from './accounts'
import { useMail } from './store'
import { useAi } from './use-ai'
import { aiErrorMessage, classifySenders, cleanupConnection, findWorthKeeping } from './ai'
import { Spinner } from './toast'
import { Tooltip } from './tooltip'
import { Button } from './ui'
import { RowAction, TabChip, formatBytes, messageCount } from './cleanup-parts'
import { keepersOf, saveSmartResult, smartResult, smartScan, subscribeSmartResults, updateSmartResult, type ScanStage, type SmartGroup, type SpamRescue, type Verdict } from './smart-clean'
import { useCleanupRunning } from './cleanup-schedule'

// ---------------------------------------------------------------------------
// Clean up → Smart: the person's AI sorts the senders in their Inbox into junk, not sure, and
// important. Junk can be archived or moved to Trash in one go (one Undo); a sender wrongly called
// junk can be kept, and stays kept on later sorts. A junk sender's conversations that look worth
// keeping (receipts, codes, account notices) are marked and always left where they are. "From
// Spam" lists real-looking mail found in Spam, each moved out only when the person says so.
// ---------------------------------------------------------------------------

type Filter = Verdict | 'spam'

const FILTERS: Array<{ id: Filter; label: string; empty: string }> = [
  { id: 'junk', label: 'Junk', empty: 'No junk found. Your Inbox looks tidy.' },
  { id: 'unsure', label: 'Not sure', empty: 'Nothing the AI was unsure about.' },
  { id: 'important', label: 'Important', empty: 'No senders marked important.' },
  { id: 'spam', label: 'From Spam', empty: 'Nothing in Spam looks like real mail.' },
]

const STAGES: Record<ScanStage, (done: number, total: number) => string> = {
  senders: (done, total) => `Sorting ${done.toLocaleString()} of ${total.toLocaleString()} senders…`,
  keepers: (done, total) => `Checking junk for anything important: ${done.toLocaleString()} of ${total.toLocaleString()} conversations…`,
  spam: (done, total) => `Checking Spam for real mail: ${done.toLocaleString()} of ${total.toLocaleString()}…`,
}

const KEEP = [0, 1, 5]
const ROW_HEIGHT = 55
const WINDOW = 30
const OVERDRAW = 10
const KEPT_REASON = 'You chose to keep them'

export function SmartClean() {
  const { C, settings, update } = useSettings()
  const ai = useAi()
  const { senderProfiles, senderThreads, spamThreads, scrub, scrubAll, unsubscribe, notSpam, account } = useMail()
  const [result, setResult] = useState(() => smartResult(account.id))
  const [filter, setFilter] = useState<Filter>('junk')
  /** Non-null while sorting: which step, and how far along it is. */
  const [progress, setProgress] = useState<{ stage: ScanStage; done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [keep, setKeep] = useState(0)
  const abort = useRef<AbortController | null>(null)

  const [range, setRange] = useState({ start: 0, end: WINDOW })
  const groups = result?.groups ?? []
  const spam = result?.spam ?? []
  const shown = filter === 'spam' ? [] : groups.filter((g) => g.verdict === filter)
  const rows = filter === 'spam' ? spam.length : shown.length
  const onVisibleRange = (event: { startIndex?: number; endIndex?: number }) => {
    const start = Math.max(0, (event.startIndex ?? 0) - OVERDRAW)
    const end = Math.min(rows, (event.endIndex ?? WINDOW) + OVERDRAW)
    if (start !== range.start || end !== range.end) setRange({ start, end })
  }

  // Another account has its own result; a sort still running for the last one is dropped.
  useEffect(() => {
    abort.current?.abort()
    abort.current = null
    setProgress(null)
    setError(null)
    setResult(smartResult(account.id))
  }, [account.id])
  useEffect(() => () => abort.current?.abort(), [])
  // A scheduled run that finishes while this is open shows at once.
  useEffect(() => subscribeSmartResults((id) => id === account.id && setResult(smartResult(id))), [account.id])
  const scheduledRunning = useCleanupRunning()
  useEffect(() => setRange({ start: 0, end: WINDOW }), [filter, account.id])

  const sort = async () => {
    if (!ai.connection || abort.current) return
    const connection = cleanupConnection(ai.connection, settings.cleanupModels)
    const controller = (abort.current = new AbortController())
    const accountId = account.id
    const me = { name: account.name, email: account.email }
    const stream = { onText: () => {}, signal: controller.signal }
    setError(null)
    setProgress({ stage: 'senders', done: 0, total: 0 })
    try {
      const scan = await smartScan({
        profiles: () => senderProfiles(accountId),
        senderThreads: (senders) => senderThreads(senders, accountId),
        spamThreads: () => spamThreads(accountId),
        keep: new Set(settings.cleanupKeepSenders),
        askSenders: (block) => classifySenders(connection, block, me, stream),
        askKeepers: (block) => findWorthKeeping(connection, block, me, 'junk', stream),
        askSpam: (block) => findWorthKeeping(connection, block, me, 'spam', stream),
        onProgress: (stage, done, total) => !controller.signal.aborted && setProgress({ stage, done, total }),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      saveSmartResult(accountId, scan)
      const has = (verdict: Verdict) => scan.groups.some((g) => g.verdict === verdict)
      setFilter(has('junk') ? 'junk' : scan.spam.length ? 'spam' : has('unsure') ? 'unsure' : 'important')
    } catch (err) {
      if (!controller.signal.aborted) setError(aiErrorMessage(err))
    } finally {
      if (abort.current === controller) {
        abort.current = null
        setProgress(null)
      }
    }
  }

  const stop = () => {
    abort.current?.abort()
    abort.current = null
    setProgress(null)
  }

  /** Gone from the list now; the mail moves in the background (and the toast can undo it). */
  const drop = (keys: Set<string>) => updateSmartResult(account.id, (scan) => ({ groups: scan.groups.filter((g) => !keys.has(g.key)) }))

  const act = async (group: SmartGroup, action: 'archive' | 'trash' | 'unsubscribe') => {
    if (action === 'unsubscribe') {
      setBusy(`${group.key}:unsubscribe`)
      try {
        await unsubscribe(group)
      } finally {
        setBusy(null)
      }
      return
    }
    drop(new Set([group.key]))
    await scrub(group, action, keep, keepersOf([group]))
  }

  const actAll = async (action: 'archive' | 'trash') => {
    const all = shown
    if (!all.length) return
    drop(new Set(all.map((g) => g.key)))
    await scrubAll(all, action, keep, { except: keepersOf(all) })
  }

  const setVerdict = (group: SmartGroup, verdict: Verdict, reason: string) =>
    updateSmartResult(account.id, (scan) => ({ groups: scan.groups.map((g) => (g.key === group.key ? { ...g, verdict, reason } : g)) }))

  /** Not junk after all: kept now, and on every later sort. */
  const keepSender = (group: SmartGroup) => {
    const address = group.detail.toLowerCase()
    if (!settings.cleanupKeepSenders.includes(address)) update({ cleanupKeepSenders: [...settings.cleanupKeepSenders, address] })
    setVerdict(group, 'important', KEPT_REASON)
  }

  const forgetKept = (group: SmartGroup) => {
    const address = group.detail.toLowerCase()
    update({ cleanupKeepSenders: settings.cleanupKeepSenders.filter((a) => a !== address) })
    setVerdict(group, 'unsure', '')
  }

  const dropSpam = (thread: SpamRescue) => updateSmartResult(account.id, (scan) => ({ spam: scan.spam.filter((t) => t.threadId !== thread.threadId) }))
  const rescue = (thread: SpamRescue) => {
    dropSpam(thread)
    notSpam([thread], account.id)
  }

  if (!ai.connection) {
    return (
      <div testId="cleanup-smart-off" style={{ borderRadius: 12, backgroundColor: C.raised, paddingLeft: 24, paddingRight: 24, paddingTop: 28, paddingBottom: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <Icon name="sparkles" size={22} color={C.muted} />
        <text style={{ fontSize: 13.5, color: C.secondary, fontFamily: FONT, textAlign: 'center' }}>
          Turn on AI features in Settings → AI, and Jefi can tell junk from the mail that matters, sender by sender.
        </text>
      </div>
    )
  }

  const totals = shown.reduce((sum, g) => ({ messages: sum.messages + g.messages, bytes: sum.bytes + g.bytes, kept: sum.kept + g.keepers.length }), { messages: 0, bytes: 0, kept: 0 })
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, f.id === 'spam' ? spam.length : groups.filter((g) => g.verdict === f.id).length])) as Record<Filter, number>
  const about = FILTERS.find((f) => f.id === filter)!
  const rowStyle = (index: number) =>
    ({ height: ROW_HEIGHT, width: '100%', flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: 10, borderTopWidth: index === 0 ? 0 : 1, borderColor: C.divider }) as const

  return (
    <>
      {/* What it does, and the button that does it */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>{`${ai.providerName} sorts the senders in your Inbox into junk and mail worth keeping, and checks Spam for real mail. Nothing moves until you choose.`}</text>
          <text testId="cleanup-smart-status" style={{ fontSize: 12, color: error ? C.accent : C.muted, fontFamily: FONT }}>
            {error
              ? error
              : progress
                ? progress.total
                  ? STAGES[progress.stage](progress.done, progress.total)
                  : 'Reading your mailbox…'
                : scheduledRunning
                  ? 'A scheduled clean-up is running…'
                  : result
                    ? `Last sorted at ${new Date(result.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
                    : 'Only sender names, addresses, subject lines and short previews are sent. Full messages stay on your Mac.'}
          </text>
        </div>
        {progress ? (
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Spinner size={14} color={C.accent} />
            <Button label="Stop" variant="ghost" onClick={stop} testId="cleanup-smart-stop" />
          </div>
        ) : (
          <Button label={result ? 'Sort again' : 'Sort my Inbox'} variant={result ? 'secondary' : 'primary'} icon="sparkles" disabled={scheduledRunning} onClick={() => void sort()} testId="cleanup-smart-sort" />
        )}
      </div>

      {result ? (
        <>
          {/* Junk / Not sure / Important / From Spam */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {FILTERS.map((f) => (
              <TabChip key={f.id} label={`${f.label} · ${counts[f.id].toLocaleString()}`} active={filter === f.id} onClick={() => setFilter(f.id)} testId={`cleanup-smart-${f.id}`} />
            ))}
            <div style={{ flexGrow: 1 }} />
            {(filter === 'junk' || filter === 'unsure') && shown.length ? (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, marginRight: 4 }}>Keep newest</text>
                {KEEP.map((n) => (
                  <div
                    key={n}
                    testId={`cleanup-smart-keep-${n}`}
                    onClick={() => setKeep(n)}
                    style={{ height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 13, display: 'flex', alignItems: 'center', cursor: 'pointer', backgroundColor: keep === n ? C.chip : undefined, hover: { backgroundColor: C.overlay } }}
                  >
                    <text style={{ fontSize: 12, fontWeight: 500, color: keep === n ? C.text : C.secondary, fontFamily: FONT }}>{n === 0 ? 'None' : String(n)}</text>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* Totals, and the one-go actions for junk */}
          {filter === 'spam' ? (
            spam.length ? (
              <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>
                Mail in Spam that looks real. Check each one before moving it: phishing is made to look genuine.
              </text>
            ) : null
          ) : shown.length ? (
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <text style={{ flexGrow: 1, fontSize: 12, color: C.muted, fontFamily: FONT }}>
                {[`${shown.length.toLocaleString()} ${shown.length === 1 ? 'sender' : 'senders'}`, messageCount(totals.messages), formatBytes(totals.bytes), totals.kept ? `${totals.kept.toLocaleString()} important ${totals.kept === 1 ? 'one stays' : 'ones stay'}` : null].filter(Boolean).join(' · ')}
              </text>
              {filter === 'junk' ? (
                <>
                  <Button label="Archive all" variant="secondary" onClick={() => void actAll('archive')} testId="cleanup-smart-archive-all" />
                  <Button label="Move all to Trash" variant="danger" onClick={() => void actAll('trash')} testId="cleanup-smart-trash-all" />
                </>
              ) : null}
            </div>
          ) : null}

          {/* Senders, or rescued Spam */}
          <div style={{ flexShrink: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 12, backgroundColor: C.raised, overflow: 'hidden' }}>
            {rows === 0 ? (
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>{about.empty}</text>
              </div>
            ) : (
              <virtual-list
                itemCount={rows}
                estimatedItemHeight={ROW_HEIGHT}
                windowStart={range.start}
                onVisibleRange={onVisibleRange}
                style={{ height: rows * ROW_HEIGHT, flexShrink: 1, minHeight: 0 }}
                testId="cleanup-smart-list"
              >
                {filter === 'spam'
                  ? spam.slice(range.start, range.end).map((thread, i) => (
                      <div key={thread.threadId} testId={`cleanup-smart-spam-${thread.threadId}`} style={rowStyle(range.start + i)}>
                        <Face letter={initials(thread.fromName)} size={34} />
                        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{thread.subject || '(no subject)'}</text>
                          <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                            {[thread.reason, thread.fromName, thread.sender].filter(Boolean).join(' · ')}
                          </text>
                        </div>
                        <RowAction label="Not spam" onClick={() => rescue(thread)} testId={`cleanup-smart-notspam-${thread.threadId}`} />
                        <RowAction label="Leave in Spam" onClick={() => dropSpam(thread)} testId={`cleanup-smart-leave-${thread.threadId}`} />
                      </div>
                    ))
                  : shown.slice(range.start, range.end).map((group, i) => {
                      const kept = group.reason === KEPT_REASON
                      return (
                        <div key={group.key} testId={`cleanup-smart-row-${group.key}`} style={rowStyle(range.start + i)}>
                          <Face letter={initials(group.label)} size={34} />
                          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{group.label}</text>
                            <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                              {[group.reason, messageCount(group.messages), group.unread ? `${group.unread.toLocaleString()} unread` : null, group.detail].filter(Boolean).join(' · ')}
                            </text>
                          </div>
                          {group.keepers.length ? <KeepersChip group={group} /> : null}
                          {group.verdict !== 'important' ? <RowAction label="Keep" onClick={() => keepSender(group)} testId={`cleanup-smart-keep-${group.key}`} /> : null}
                          {kept ? <RowAction label="Don't keep" onClick={() => forgetKept(group)} testId={`cleanup-smart-forget-${group.key}`} /> : null}
                          {group.canUnsubscribe && group.verdict !== 'important' ? (
                            <RowAction label="Unsubscribe" busy={busy === `${group.key}:unsubscribe`} onClick={() => void act(group, 'unsubscribe')} testId={`cleanup-smart-unsubscribe-${group.key}`} />
                          ) : null}
                          <RowAction label="Archive" onClick={() => void act(group, 'archive')} testId={`cleanup-smart-archive-${group.key}`} />
                          <RowAction label="Delete" danger onClick={() => void act(group, 'trash')} testId={`cleanup-smart-delete-${group.key}`} />
                        </div>
                      )
                    })}
              </virtual-list>
            )}
          </div>
        </>
      ) : null}
    </>
  )
}

/** "2 stay": the junk sender's conversations that look important, listed on hover; clean-ups leave them be. */
function KeepersChip({ group }: { group: SmartGroup }) {
  const { C } = useSettings()
  const n = group.keepers.length
  return (
    <Tooltip
      delay={0}
      label={`${n === 1 ? 'This one stays' : `These ${n} stay`} when you clean up`}
      lines={group.keepers.slice(0, 6).map((k) => `${k.reason}: ${k.subject || '(no subject)'}`).concat(n > 6 ? [`and ${n - 6} more`] : [])}
      testId={`cleanup-smart-keepers-tip-${group.key}`}
    >
      <div testId={`cleanup-smart-keepers-${group.key}`} style={{ height: 24, paddingLeft: 8, paddingRight: 9, gap: 5, borderRadius: 12, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: C.chip, pointerEvents: 'none' }}>
        <Icon name="shieldCheck" size={13} color={C.green} />
        <text style={{ fontSize: 12, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{`${n} stay${n === 1 ? 's' : ''}`}</text>
      </div>
    </Tooltip>
  )
}
