import { countRender } from './render-counts'
import { FONT, LIST_WIDTH, TOPBAR_HEIGHT, mixHex, useSettings } from './theme'
import { Icon, IconButton, type IconName } from './icons'
import { AccountLabelChip, Face } from './primitives'
import { accountTone } from './accounts'
import { GROUPS, type MailThread } from './data'
import { useMailActions, useMailSelector, type BulkAction } from './store'
import { makeTaskFromMessage } from './tasks'
import { useStableCallback } from './stable-callback'
import { listEmptyState } from './list-empty'
import { usePaneWidth } from './resizer'
import { Menu, MenuItem, MenuLabel, MenuSeparator, useToggle } from './ui'
import { Spinner } from './toast'
import { SignInCodePill, freshCode } from './sign-in-pill'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useContextMenu, type ContextItem } from './context-menu'
import { useKeys } from './keys'
import type { ShortcutAction } from './shortcuts'

export type ListFilters = { attachments: boolean; starred: boolean; labeled: boolean }
export const NO_FILTERS: ListFilters = { attachments: false, starred: false, labeled: false }

/** `focusKey` remounts the field so autoFocus puts the caret in it: what "/" does. */
function SearchField({ value, onChange, focusKey }: { value: string; onChange: (value: string) => void; focusKey: number }) {
  const { C } = useSettings()
  return (
    <div
      style={{
        height: 30,
        flexGrow: 1,
        minWidth: 0,
        paddingLeft: 10,
        paddingRight: 10,
        gap: 8,
        borderRadius: 9,
        backgroundColor: C.overlay,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <Icon name="search" size={15} color={C.muted} />
      <input
        key={focusKey}
        testId="search"
        autoFocus={focusKey > 0}
        value={value}
        placeholder="Search mail"
        onChange={(event) => onChange(event.value ?? '')}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
      {value ? <IconButton icon="x" size={12} pad={20} onClick={() => onChange('')} testId="search-clear" /> : null}
    </div>
  )
}

/** Rows mounted around the viewport, and the average row height the list lays out with. */
/** The heading row and the bulk bar that replaces it share one height, so selecting doesn't shift the list. */
const HEADING_HEIGHT = 34
const WINDOW = 40
const OVERDRAW = 12
const ROW_HEIGHT = 68

/**
 * What a mail key does to the checked conversations: a bulk action, null when it is theirs but has
 * nothing to do, undefined when the key isn't one for a selection. # never deletes for good.
 */
export function bulkActionFor(action: ShortcutAction, picked: { anyUnread: boolean; allStarred: boolean; inTrash: boolean }): BulkAction | null | undefined {
  if (action === 'archive') return { move: 'archive' }
  if (action === 'trash') return picked.inTrash ? null : { move: 'trash' }
  if (action === 'star') return { starred: !picked.allStarred }
  if (action === 'unread') return { unread: !picked.anyUnread }
  return undefined
}

/** A day heading's height in the list (its padding and one line of text), for placing rows. */
const GROUP_HEIGHT = 27

/**
 * Where row `index` sits against the viewport of a virtual list scrolled to `top` (the item at its
 * top edge and how far into it), from the rows' heights: fully on screen, or cut off above or below.
 */
export function rowPlacement(heights: readonly number[], index: number, top: { index: number; offset: number; viewport: number }): 'visible' | 'above' | 'below' {
  if (index < top.index) return 'above'
  let y = -top.offset
  for (let i = top.index; i < index; i++) y += heights[i] ?? 0
  if (y < 0) return 'above'
  return y + (heights[index] ?? 0) > top.viewport ? 'below' : 'visible'
}

export type Tab = 'Priority' | 'All' | 'Unread'
const TABS: Tab[] = ['Priority', 'All', 'Unread']
/** The tabs as icon buttons beside refresh. */
const TAB_ICONS: Array<{ tab: Tab; icon: IconName }> = [
  { tab: 'Priority', icon: 'sparkles' },
  { tab: 'All', icon: 'inbox' },
  { tab: 'Unread', icon: 'mail' },
]

export function Segmented({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  const { C } = useSettings()
  return (
    <div
      style={{
        width: 270,
        height: 28,
        padding: 2,
        borderRadius: 14,
        backgroundColor: C.overlay,
        display: 'flex',
        flexDirection: 'row',
        flexShrink: 0,
      }}
    >
      {TABS.map((tab) => {
        const active = tab === value
        return (
          <div
            key={tab}
            testId={`tab-${tab.toLowerCase()}`}
            onClick={() => onChange(tab)}
            style={{
              flexGrow: 1,
              flexBasis: 0,
              height: 24,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              backgroundColor: active ? C.overlayStrong : undefined,
            }}
          >
            <text style={{ fontSize: 12.5, fontWeight: active ? 500 : 400, color: active ? C.text : C.muted, fontFamily: FONT }}>
              {tab}
            </text>
          </div>
        )
      })}
    </div>
  )
}

type Modifiers = { cmd?: boolean; shift?: boolean; ctrl?: boolean }

/** Memoized with id-taking handlers, so a store change or a click re-renders only the rows it touches. */
const ThreadRow = memo(function ThreadRow({
  thread,
  selected,
  picked,
  picking,
  onSelect,
  onPick,
  onContext,
  account,
}: {
  thread: MailThread
  /** Which account it's from, in a list that holds several (All Inboxes). */
  account?: { label: string; color: string }
  selected: boolean
  /** Checked for a bulk action. */
  picked: boolean
  /** Something is checked: clicks toggle instead of opening. */
  picking: boolean
  onSelect: (id: string) => void
  onPick: (id: string, modifiers: Modifiers) => void
  onContext: (thread: MailThread, event: { isRightClick?: boolean; button?: number; x?: number; y?: number }) => void
}) {
  const { settings, C } = useSettings()
  countRender('ThreadRow')
  const { toggleStar } = useMailActions()
  // A sign-in code in the newest message, copied straight from the list.
  const code = freshCode(thread)
  const labels = useMailSelector((store) => store.labels)
  const statusIcons = thread.icons.filter((icon) => icon !== 'star')
  const threadLabels = labels.filter((l) => thread.labels.includes(l.id))
  return (
    <div
      testId={`thread-${thread.id}`}
      onClick={(event) => {
        const mods = (event as { modifiers?: Modifiers }).modifiers ?? {}
        if (mods.cmd || mods.ctrl || mods.shift || picking) onPick(thread.id, mods)
        else onSelect(thread.id)
      }}
      onAuxClick={(event) => onContext(thread, event)}
      style={{
        height: settings.snippets ? 68 : 52,
        // Rows in the virtual list size to their content unless told to fill the column.
        width: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingLeft: 10,
        paddingRight: 8,
        paddingTop: 7,
        borderRadius: 8,
        // A gap in the list's own colour, so two highlighted neighbours read as two rows. A translucent
        // list colour would stack into a visible line on every row, so glass leaves the gap clear.
        borderBottomWidth: 2,
        borderColor: C.list.length > 7 ? 'transparent' : C.list,
        cursor: 'pointer',
        backgroundColor: picked ? mixHex(C.list, C.accent, 0.14) : selected ? C.rowSelected : undefined,
        hover: selected || picked ? undefined : { backgroundColor: C.overlay },
      }}
    >
      {/* The avatar doubles as the checkbox: click it to start selecting. */}
      <div style={{ width: 36, height: 36, flexShrink: 0, position: 'relative' }}>
        {picked ? (
          <div style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <Icon name="check" size={18} color="#FFFFFF" />
          </div>
        ) : (
          <div style={{ pointerEvents: 'none' }}>
            <Face {...thread.face} size={36} />
          </div>
        )}
        {/* Clicks land on the topmost painted element, so the hit target sits over the avatar. */}
        <div
          testId={`pick-${thread.id}`}
          onClick={() => onPick(thread.id, { cmd: true })}
          style={{ position: 'absolute', top: 0, left: 0, width: 36, height: 36, borderRadius: 18, cursor: 'pointer', backgroundColor: '#00000001', hover: { backgroundColor: '#FFFFFF22' } }}
        />
      </div>
      <div style={{ width: 30, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 11 }}>
        {thread.unread ? <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.accent }} /> : null}
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, height: 18 }}>
          <text
            style={{
              flexShrink: 1,
              minWidth: 0,
              fontSize: 13.5,
              lineHeight: 18,
              fontWeight: thread.unread ? 600 : 400,
              color: thread.unread ? C.text : C.secondary,
              fontFamily: FONT,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {thread.folder === 'drafts' ? 'Draft' : thread.sender}
          </text>
          {threadLabels.map((label) => (
            <div key={label.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C[label.color], flexShrink: 0 }} />
          ))}
          {account ? <AccountLabelChip label={account.label} color={account.color} /> : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <text
            style={{
              flexShrink: 1,
              minWidth: 0,
              fontSize: 13.5,
              lineHeight: 18,
              fontWeight: thread.unread ? 500 : 400,
              color: thread.unread ? C.text : C.secondary,
              fontFamily: FONT,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {thread.subject}
          </text>
          {code ? <SignInCodePill code={code} testId={`sign-in-code-${thread.id}`} /> : null}
        </div>
        {settings.snippets ? (
          <text
            style={{
              fontSize: 12.5,
              lineHeight: 18,
              color: C.muted,
              fontFamily: FONT,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {thread.snoozeUntil ? `Snoozed until ${thread.snoozeUntil} · ${thread.snippet}` : thread.snippet}
          </text>
        ) : null}
      </div>
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', paddingLeft: 10 }}>
        {thread.sendState ? (
          <div style={{ height: 18, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: 4 }}>
            {thread.sendState === 'failed' ? null : <Spinner size={12} color={C.accent} />}
            <text style={{ fontSize: 12, lineHeight: 18, fontWeight: 500, color: thread.sendState === 'failed' ? C.accent : C.secondary, fontFamily: FONT, whiteSpace: 'nowrap' }}>
              {thread.sendState === 'failed' ? (thread.sendUnconfirmed ? 'Not confirmed' : 'Not sent') : thread.sendState === 'sending' ? 'Sending' : thread.scheduledFor ? 'Scheduled' : 'Queued'}
            </text>
          </div>
        ) : (
          <text style={{ fontSize: 12, lineHeight: 18, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', paddingRight: 4 }}>{thread.date}</text>
        )}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, height: 22 }}>
          {statusIcons.map((icon) => (
            <Icon key={icon} name={icon} size={14} color={C.secondary} />
          ))}
          <div
            testId={`star-${thread.id}`}
            onClick={() => toggleStar(thread.id)}
            style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
          >
            <Icon name={thread.starred ? 'starFilled' : 'star'} size={14} color={thread.starred ? C.star : C.ghost} />
          </div>
        </div>
      </div>
    </div>
  )
})

/** Memoized: the workspace hands it stable handlers, so it renders when what it shows changes. */
export const InboxList = memo(InboxListView)

function InboxListView({
  title,
  threads,
  active,
  tab,
  query,
  filters,
  searchFocus,
  hasOlder,
  onLoadOlder,
  emptyView,
  onTab,
  onQuery,
  onFilters,
  onSelect,
  onBack,
  onForward,
  emptyAction,
  bulkShortcuts,
  showAccounts = false,
}: {
  title: string
  threads: MailThread[]
  active: string | null
  tab: Tab
  query: string
  filters: ListFilters
  /** Bumped to put the caret in the search field ("/"). */
  searchFocus: number
  /** Conversations older than these are stored, and `onLoadOlder` fetches the next page of them. */
  hasOlder: boolean
  onLoadOlder: () => void
  /** How this view's own query is doing, so an empty list never claims more than it knows. */
  emptyView?: { name: string; loading: boolean; hasMore: boolean }
  onTab: (tab: Tab) => void
  onQuery: (value: string) => void
  onFilters: (filters: ListFilters) => void
  onSelect: (id: string) => void
  onBack?: () => void
  onForward?: () => void
  emptyAction?: { label: string; run: () => void }
  /** Filled in with a handler that runs a mail key on the checked conversations; true when it did. */
  bulkShortcuts?: { current: ((action: ShortcutAction) => boolean) | null }
  /** The rows come from several accounts: each says which. */
  showAccounts?: boolean
}) {
  const { C, settings } = useSettings()
  countRender('InboxList')
  const { account, accounts, sync, offline } = useMailSelector((store) => ({ account: store.account, accounts: store.accounts, sync: store.sync, offline: store.offline }))
  // One chip per account, made once, so rows don't re-render for a new object each time.
  const accountChips = useMemo(
    () => new Map(accounts.map((a) => [a.id, { label: a.label || a.email, color: C[accountTone(a, accounts)] }])),
    [accounts, C],
  )
  const chipOf = (thread: MailThread) => (showAccounts ? accountChips.get(thread.id.split(':')[0]!) : undefined)
  const { syncNow, bulk } = useMailActions()
  const filterMenu = useToggle()
  // Mail lists run to thousands of conversations: <virtual-list> paints only the rows near the
  // viewport, and we mount only the slice it asks for (plus a little overdraw for smooth scrolling).
  const items = useMemo(() => {
    const out: Array<{ key: string; group?: MailThread['group']; thread?: MailThread }> = []
    for (const group of GROUPS) {
      const inGroup = threads.filter((t) => t.group === group)
      if (inGroup.length === 0) continue
      out.push({ key: `group-${group}`, group })
      for (const thread of inGroup) out.push({ key: thread.id, thread })
    }
    return out
  }, [threads])

  const [window, setWindow] = useState({ start: 0, end: WINDOW })
  // Bumped to remount the native list at the top: its scroll offset outlives the rows it was showing,
  // so after a bulk delete it could sit past the end of a much shorter list and paint nothing.
  const [generation, setGeneration] = useState(0)
  const key = `${account.id}:${title}:${tab}`
  const lastKey = useRef(key)
  const lastLength = useRef(items.length)
  if (lastKey.current !== key) {
    lastKey.current = key
    lastLength.current = items.length
    // A different list: the native scroll offset belongs to the old one, so start over at the top.
    setWindow({ start: 0, end: WINDOW })
    setGeneration((g) => g + 1)
  } else if (lastLength.current !== items.length) {
    const shrank = items.length < lastLength.current
    lastLength.current = items.length
    if (shrank && window.start > 0 && window.start + OVERDRAW >= items.length) {
      setWindow({ start: 0, end: WINDOW })
      setGeneration((g) => g + 1)
    }
  }
  const listRef = useRef<PublicInstance>(null)
  const renderer = useGpuixRequired()
  const onVisibleRange = (event: { startIndex?: number; endIndex?: number }) => {
    const start = Math.max(0, (event.startIndex ?? 0) - OVERDRAW)
    // Never narrower than a screenful, and not clamped to today's length: a range reported while the
    // list was empty (or short) must still show mail that streams in afterwards.
    const end = Math.max(start + WINDOW, (event.endIndex ?? 0) + OVERDRAW)
    if (start !== window.start || end !== window.end) setWindow({ start, end })
    // Scrolled within an overdraw of the last loaded row: fetch the next page of older conversations.
    if (hasOlder && (event.endIndex ?? 0) >= items.length - OVERDRAW) onLoadOlder()
  }
  // J/K (or a click on a row cut off at an edge) opens a conversation the list must then show: bring
  // its row fully into view, at the top when it's above the viewport and at the bottom when below.
  const activeIndex = active ? items.findIndex((item) => item.thread?.id === active) : -1
  const rowHeight = settings.snippets ? 68 : 52
  useEffect(() => {
    const list = listRef.current
    if (activeIndex < 0 || !list || !renderer.scrollToItem) return
    const anchor = renderer.getListScrollTop?.(list.id)
    if (!anchor || anchor.length < 3) return
    const heights = items.map((item) => (item.thread ? rowHeight : GROUP_HEIGHT))
    const where = rowPlacement(heights, activeIndex, { index: anchor[0]!, offset: anchor[1]!, viewport: anchor[2]! })
    if (where === 'above') renderer.scrollToItem(list.id, activeIndex, 0)
    else if (where === 'below') renderer.scrollToItem(list.id, activeIndex, -(anchor[2]! - rowHeight - 4))
    // Only when the open conversation changes: new mail shifting its row mustn't pull a list someone scrolled.
  }, [active])

  // Bulk selection: cleared whenever the list itself changes (folder, tab, search).
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const pickKey = `${title}:${tab}:${query}`
  const lastPickKey = useRef(pickKey)
  if (lastPickKey.current !== pickKey) {
    lastPickKey.current = pickKey
    if (picked.size) setPicked(new Set())
  }
  // In on-screen order (grouped by day), so Shift-click ranges match what you see.
  const visibleIds = items.flatMap((item) => (item.thread ? [item.thread.id] : []))
  const pickedHere = visibleIds.filter((id) => picked.has(id))
  const pick = (id: string, mods: Modifiers) => {
    // Read the anchor now: the updater below runs later, after it has moved to `id`.
    const from = anchor.current
    setPicked((prev) => {
      const next = new Set(prev)
      if (mods.shift && from && visibleIds.includes(from)) {
        const [a, b] = [visibleIds.indexOf(from), visibleIds.indexOf(id)].sort((x, y) => x - y)
        for (const between of visibleIds.slice(a, b + 1)) next.add(between)
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchor.current = id
  }
  // Esc clears a selection (registered after the shell, so it gets the key first).
  useKeys((press) => {
    if (press.key !== 'escape' || picked.size === 0) return false
    setPicked(new Set())
    return true
  })
  const act = (action: Parameters<typeof bulk>[1]) => {
    bulk(pickedHere, action)
    setPicked(new Set())
    // Rows are leaving this list: start again from the top rather than from a window that may be gone.
    if (action === 'deleteForever' || 'move' in action) {
      setWindow({ start: 0, end: WINDOW })
      setGeneration((g) => g + 1)
    }
  }
  const labels = useMailSelector((store) => store.labels)
  const mailActions = useMailActions()
  const { toggleLabel, startRule } = mailActions
  const contextMenu = useContextMenu()
  /** Right-click acts on the selection when the row is part of it, otherwise on that row alone. */
  const rowMenu = (thread: MailThread) =>
    contextMenu(() => {
      const ids = picked.has(thread.id) && pickedHere.length > 1 ? pickedHere : [thread.id]
      const targets = threads.filter((t) => ids.includes(t.id))
      const many = ids.length > 1
      const run = (action: Parameters<typeof bulk>[1]) => {
        bulk(ids, action)
        if (many) setPicked(new Set())
      }
      const unread = targets.some((t) => t.unread)
      const starred = targets.every((t) => t.starred)
      const inTrash = targets.every((t) => t.folder === 'trash')
      const items: ContextItem[] = [
        ...(many ? [{ heading: `${ids.length} conversations` } as ContextItem] : [{ label: 'Open', icon: 'mailOpen', onSelect: () => onSelect(thread.id) } as ContextItem, 'separator' as const]),
        { label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? 'mailOpen' : 'mail', onSelect: () => run({ unread: !unread }), testId: 'ctx-read' },
        { label: starred ? 'Remove star' : 'Add star', icon: 'star', onSelect: () => run({ starred: !starred }), testId: 'ctx-star' },
        ...(!many && thread.folder !== 'outbox' && thread.messages.length
          ? [{ label: 'Make task', icon: 'circleCheck', onSelect: () => void makeTaskFromMessage(mailActions, thread, thread.messages.at(-1)!), testId: 'ctx-make-task' } as ContextItem]
          : []),
        'separator',
        { label: 'Archive', icon: 'archive', onSelect: () => run({ move: 'archive' }), testId: 'ctx-archive' },
        inTrash
          ? { label: 'Delete forever', icon: 'trash', danger: true, onSelect: () => run('deleteForever'), testId: 'ctx-delete' }
          : { label: 'Delete', icon: 'trash', onSelect: () => run({ move: 'trash' }), testId: 'ctx-delete' },
        { label: 'Report spam', icon: 'alertCircle', onSelect: () => run({ move: 'spam' }) },
        ...(targets.some((t) => t.folder !== 'inbox') ? [{ label: 'Move to Inbox', icon: 'inbox', onSelect: () => run({ move: 'inbox' }) } as ContextItem] : []),
      ]
      if (labels.length) {
        items.push('separator', { heading: 'Labels' })
        for (const label of labels) {
          const has = targets.every((t) => t.labels.includes(label.id))
          items.push({
            label: label.label,
            icon: 'tag',
            checked: has,
            onSelect: () => targets.forEach((t) => (t.labels.includes(label.id) === has ? toggleLabel(t.id, label.id) : undefined)),
          })
        }
      }
      if (!many) {
        const email = thread.messages.at(-1)?.email ?? ''
        const name = thread.sender.replace(/ \(\d+\)$/, '')
        items.push('separator', {
          label: `Create rule for ${name}…`,
          icon: 'sliders',
          testId: 'ctx-create-rule',
          onSelect: () => startRule({ name: `Mail from ${name}`, match: { from: email }, actions: { moveTo: 'archive' } }),
        })
        items.push({
          label: `Select all from ${thread.sender.replace(/ \(\d+\)$/, '')}`,
          icon: 'user',
          testId: 'ctx-select-sender',
          onSelect: () => {
            const email = thread.messages.at(-1)?.email
            setPicked(new Set(threads.filter((t) => t.messages.some((m) => m.email === email)).map((t) => t.id)))
          },
        })
      }
      return items
    })

  const pickedThreads = threads.filter((t) => picked.has(t.id))
  const anyUnread = pickedThreads.some((t) => t.unread)
  const allStarred = pickedThreads.length > 0 && pickedThreads.every((t) => t.starred)
  const inTrash = pickedThreads.length > 0 && pickedThreads.every((t) => t.folder === 'trash')
  // With conversations checked, E, #, S and U act on them (as the bulk bar does), not on the open one.
  if (bulkShortcuts) {
    bulkShortcuts.current = (action) => {
      if (pickedHere.length === 0) return false
      const bulkAction = bulkActionFor(action, { anyUnread, allStarred, inTrash })
      if (bulkAction === undefined) return false
      if (bulkAction) act(bulkAction)
      return true
    }
  }

  const activeFilters = Object.values(filters).filter(Boolean).length
  const empty = listEmptyState({ filtered: !!query.trim() || activeFilters > 0 || tab !== 'All', offline, sync, synced: !!sync.lastSyncedAt, view: emptyView })
  const listWidth = usePaneWidth('list')
  // One identity each across renders, so memoized rows skip renders their own props don't need.
  const selectRow = useStableCallback((id: string) => onSelect(id))
  const pickRow = useStableCallback((id: string, mods: Modifiers) => pick(id, mods))
  const contextRow = useStableCallback((thread: MailThread, event: Parameters<ReturnType<typeof rowMenu>>[0]) => rowMenu(thread)(event))
  return (
    <div
      style={{
        width: listWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: C.list,
        borderRightWidth: 1,
        borderColor: C.divider,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: TOPBAR_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 12,
          paddingRight: 10,
          gap: 10,
        }}
      >
        <div
          style={{
            height: 28,
            flexShrink: 0,
            borderRadius: 7,
            backgroundColor: C.raised,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <IconButton icon="arrowLeft" size={15} pad={26} dimmed={!onBack} onClick={onBack} testId="nav-back" tooltip="Back" />
          <IconButton icon="arrowRight" size={15} pad={26} dimmed={!onForward} onClick={onForward} testId="nav-forward" tooltip="Forward" />
        </div>
        <SearchField value={query} onChange={onQuery} focusKey={searchFocus} />
        <div style={{ flexShrink: 0, position: 'relative' }}>
          <IconButton icon="sliders" size={16} pad={28} active={filterMenu.open || activeFilters > 0} onClick={filterMenu.toggle} testId="filters" tooltip="Filters" />
          {activeFilters > 0 ? (
            <div style={{ position: 'absolute', top: 3, right: 3, width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.accent, pointerEvents: 'none' }} />
          ) : null}
          <Menu open={filterMenu.open} onClose={filterMenu.close} align="end" width={210} testId="filter-menu">
            <MenuLabel>Show only</MenuLabel>
            <MenuItem icon="paperclip" label="Has attachments" checked={filters.attachments} testId="filter-attachments" onSelect={() => onFilters({ ...filters, attachments: !filters.attachments })} />
            <MenuItem icon="star" label="Starred" checked={filters.starred} testId="filter-starred" onSelect={() => onFilters({ ...filters, starred: !filters.starred })} />
            <MenuItem icon="tag" label="Labeled" checked={filters.labeled} testId="filter-labeled" onSelect={() => onFilters({ ...filters, labeled: !filters.labeled })} />
            {activeFilters > 0 ? (
              <>
                <MenuSeparator />
                <MenuItem icon="x" label="Clear filters" testId="filter-clear" onSelect={() => { onFilters(NO_FILTERS); filterMenu.close() }} />
              </>
            ) : null}
          </Menu>
        </div>
      </div>

      {/* Heading + tabs; while conversations are checked, the heading becomes the bulk bar */}
      {pickedHere.length > 0 ? (
        <div testId="bulk-bar" style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 4, height: HEADING_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <IconButton icon="x" size={15} pad={26} onClick={() => setPicked(new Set())} testId="bulk-clear" tooltip="Clear selection" />
          <text style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: FONT, marginLeft: 4, whiteSpace: 'nowrap' }}>{`${pickedHere.length} selected`}</text>
          <div
            testId="bulk-select-all"
            onClick={() => setPicked(new Set(pickedHere.length === visibleIds.length ? [] : visibleIds))}
            style={{ height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 6, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
          >
            <text style={{ fontSize: 12.5, color: C.accent, fontFamily: FONT, whiteSpace: 'nowrap' }}>{pickedHere.length === visibleIds.length ? 'Select none' : 'Select all'}</text>
          </div>
          <div style={{ flexGrow: 1 }} />
          <IconButton icon="archive" size={16} pad={28} onClick={() => act({ move: 'archive' })} testId="bulk-archive" tooltip="Archive" />
          <IconButton icon="trash" size={16} pad={28} onClick={() => act(inTrash ? 'deleteForever' : { move: 'trash' })} testId="bulk-delete" tooltip={inTrash ? 'Delete forever' : 'Delete'} />
          <IconButton icon={anyUnread ? 'mailOpen' : 'mail'} size={16} pad={28} onClick={() => act({ unread: !anyUnread })} testId="bulk-read" tooltip={anyUnread ? 'Mark as read' : 'Mark as unread'} />
          <IconButton icon={allStarred ? 'starFilled' : 'star'} size={16} pad={28} onClick={() => act({ starred: !allStarred })} testId="bulk-star" tooltip={allStarred ? 'Unstar' : 'Star'} />
        </div>
      ) : (
      <div style={{ paddingLeft: 16, paddingRight: 12, paddingTop: 4, height: HEADING_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ flexGrow: 1, minWidth: 0, fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: C.text, fontFamily: FONT }}>{title}</text>
        {TAB_ICONS.map(({ tab: t, icon }) => (
          <IconButton key={t} icon={icon} size={15} pad={26} active={tab === t} onClick={() => onTab(t)} testId={`tab-${t.toLowerCase()}`} tooltip={t} />
        ))}
        <div style={{ width: 1, height: 14, backgroundColor: C.divider }} />
        <IconButton icon="refresh" size={15} pad={26} onClick={syncNow} testId="sync-now" tooltip="Check for new mail" />
      </div>
      )}
      <div style={{ height: 8, flexShrink: 0 }} />

      {/* Rows */}
      <div style={{ flexGrow: 1, minHeight: 0, paddingLeft: 6, paddingRight: 10, paddingBottom: 10, display: 'flex', flexDirection: 'column' }}>
        {threads.length === 0 ? (
          <div testId="list-empty" style={{ paddingTop: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            {empty.busy ? <Spinner size={14} color={C.muted} /> : null}
            <text testId="list-empty-title" style={{ fontSize: 13.5, color: C.muted, fontFamily: FONT }}>{empty.title}</text>
            {empty.detail ? (
              <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, opacity: 0.8, textAlign: 'center' }}>{empty.detail}</text>
            ) : null}
            {/* One thing worth doing: clear what they typed, or try the server again. */}
            {empty.action === 'clear' && emptyAction ? (
              <div testId="empty-action" onClick={emptyAction.run} style={{ cursor: 'pointer', hover: { opacity: 0.7 } }}>
                <text style={{ fontSize: 13, color: C.accent, fontFamily: FONT }}>{emptyAction.label}</text>
              </div>
            ) : empty.action === 'retry' ? (
              <div testId="empty-action" onClick={syncNow} style={{ cursor: 'pointer', hover: { opacity: 0.7 } }}>
                <text style={{ fontSize: 13, color: C.accent, fontFamily: FONT }}>Try again</text>
              </div>
            ) : null}
          </div>
        ) : null}
        {items.length > 0 ? (
          <virtual-list
            ref={listRef}
            key={generation}
            itemCount={items.length}
            estimatedItemHeight={ROW_HEIGHT}
            windowStart={window.start}
            onVisibleRange={onVisibleRange}
            style={{ flexGrow: 1, minHeight: 0 }}
            testId="thread-list"
          >
            {items.slice(window.start, window.end).map((item) =>
              item.thread ? (
                <ThreadRow
                  key={item.key}
                  thread={item.thread}
                  selected={item.thread.id === active}
                  picked={picked.has(item.thread.id)}
                  picking={pickedHere.length > 0}
                  onSelect={selectRow}
                  onPick={pickRow}
                  onContext={contextRow}
                  account={chipOf(item.thread)}
                />
              ) : (
                <div key={item.key} style={{ paddingLeft: 10, paddingTop: 4, paddingBottom: 5 }}>
                  <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>{item.group}</text>
                </div>
              ),
            )}
          </virtual-list>
        ) : null}
        {/* Older mail is on this Mac but outside the list's window. Scrolling to the end asks for the
            next page on its own; the button is for views that filter it down to almost nothing (an old
            folder, a label), where there is nothing to scroll. */}
        {hasOlder ? (
          <div
            testId="load-older"
            onClick={onLoadOlder}
            style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { opacity: 0.7 } }}
          >
            <text style={{ fontSize: 12.5, color: C.accent, fontFamily: FONT }}>Load older mail</text>
          </div>
        ) : null}
      </div>
    </div>
  )
}
