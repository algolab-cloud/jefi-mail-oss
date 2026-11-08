import { countRender } from './render-counts'
import { useContextMenu } from './context-menu'
import { motion } from '@gpuix/react'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { FONT, TOPBAR_HEIGHT, mixHex, useSettings } from './theme'
import { Icon, IconButton, type IconName } from './icons'
import { AccountLabelChip, CountBadge, Face } from './primitives'
import { FOLDERS, type FolderId } from './data'
import { threadInView, type MailboxView } from './view'
import { useMailActions, useMailCounts, useMailSelector, useMailSnapshot } from './store'
import { useStableCallback } from './stable-callback'
import { usePaneWidth } from './resizer'
import { Menu, MenuItem, MenuLabel, MenuSeparator, useToggle } from './ui'
import { Spinner } from './toast'
import type { SyncView } from './store'
import { accountTone, providerFor } from './accounts'
import { useEvents, useTasks } from './local-data'
import { dueCount } from './tasks/model'
import { useNow as useMinute } from './calendar/hooks'
import { restartToUpdate, useUpdater } from './use-updater'
import { openFeedback } from './feedback'
import type { SettingsSection } from './deeplink'
import {
  CORE_FOLDERS,
  MORE_FOLDERS,
  SOON_MS,
  badgeText,
  mailBadge,
  sectionShown,
  startsSoon,
  syncSummary,
  toggleSection,
  updateCard,
  type AppName,
  type SidebarSection,
  type Tool,
} from './sidebar-state'

export { relativeTime } from './sidebar-state'

// ---------------------------------------------------------------------------
// Two columns on the left. The app rail (always there) switches between Mail, Calendar and Notes and
// holds what's app-wide: the assistant, search, sync, the account and Settings. Beside it, the
// context column shows the active app's navigation: mailboxes for Mail, the month and calendars for
// Calendar. Notes has none; its own list already is its navigation.
// ---------------------------------------------------------------------------

/** Rows are inset this much from the column's edges. */
const INSET = 10
const ROW_HEIGHT = 30

/**
 * Wide enough for the macOS window buttons above the rail's icons. They are about 60 pt across on
 * current macOS (larger than the old 54), so the rail is 84 wide and mail.tsx starts them at x = 12:
 * an even 12 pt margin on both sides, never over the column divider.
 */
export const RAIL_WIDTH = 84
/** Where the window buttons start; mail.tsx passes it to the window. */
export const TRAFFIC_LIGHT_X = 12

/** Re-renders every `ms` so relative timestamps stay fresh. */
export function useNow(ms = 10_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(handle)
  }, [ms])
  return now
}

export function NavRow({
  icon,
  label,
  active,
  count,
  total,
  facts,
  tone,
  dot,
  onSelect,
  testId,
  trailing,
  onContext,
  quiet,
}: {
  /** Right-click handler (see useContextMenu). */
  onContext?: (event: { isRightClick?: boolean; button?: number; x?: number; y?: number }) => void
  icon?: IconName
  label: string
  active?: boolean
  count?: number
  /** Everything in the folder, so the unread badge can show its share; `facts` fill its hover popover. */
  total?: number
  facts?: string[]
  tone?: 'red' | 'muted'
  dot?: string
  onSelect?: () => void
  testId?: string
  trailing?: ReactNode
  /** A secondary row (More, Add label): dimmer text. */
  quiet?: boolean
}) {
  const { settings, C } = useSettings()
  return (
    <div
      testId={testId ?? `nav-${label.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={onSelect}
      onAuxClick={onContext}
      style={{
        height: ROW_HEIGHT,
        flexShrink: 0,
        marginBottom: 1,
        paddingLeft: 8,
        paddingRight: 8,
        gap: 10,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 7,
        cursor: 'pointer',
        backgroundColor: active ? C.navSelected : undefined,
        hover: active ? undefined : { backgroundColor: C.overlay },
      }}
    >
      <div style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        {dot ? (
          <div style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: dot }} />
        ) : icon ? (
          <Icon name={icon} size={16} color={active ? C.accent : quiet ? C.muted : C.secondary} />
        ) : null}
      </div>
      <text
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: 13.5,
          fontWeight: active ? 550 : 400,
          color: active ? C.text : quiet ? C.muted : C.secondary,
          fontFamily: FONT,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
      {count !== undefined && (tone !== 'red' || settings.unreadCounts) ? (
        <CountBadge count={count} tone={tone ?? 'muted'} total={total} facts={facts} />
      ) : null}
      {trailing}
    </div>
  )
}

/** A section's title; with `onToggle` it folds the rows under it, and remembers. */
export function SectionHeader({ label, open, onToggle, testId, action }: { label: string; open?: boolean; onToggle?: () => void; testId?: string; action?: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 28, marginTop: 14, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <div
        testId={testId}
        onClick={onToggle}
        style={{ flexGrow: 1, height: 26, paddingLeft: 8, paddingRight: 6, gap: 4, borderRadius: 6, display: 'flex', flexDirection: 'row', alignItems: 'center', cursor: onToggle ? 'pointer' : undefined, hover: onToggle ? { backgroundColor: C.overlay } : undefined }}
      >
        <text style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
        {onToggle ? (
          <div style={{ pointerEvents: 'none', display: 'flex', paddingTop: 1 }}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} color={C.ghost} />
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

const COMPOSE_HEIGHT = 34
/** The primary action: the column's width, inverted against the sidebar so it's the one solid thing in it. */
function ComposeButton({ width, onClick }: { width: number; onClick: () => void }) {
  const { C } = useSettings()
  const w = Math.max(60, Math.round(width))
  return (
    <div
      testId="compose"
      onClick={onClick}
      style={{ width: w, height: COMPOSE_HEIGHT, borderRadius: COMPOSE_HEIGHT / 2, backgroundColor: C.text, flexShrink: 0, cursor: 'pointer', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, hover: { backgroundColor: mixHex(C.text, C.sidebar, 0.1) }, active: { backgroundColor: mixHex(C.text, C.sidebar, 0.2) } }}
    >
      <div style={{ pointerEvents: 'none', display: 'flex' }}>
        <Icon name="pencil" size={14} color={C.onText} />
      </div>
      <text style={{ fontSize: 13, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none' }}>Compose</text>
    </div>
  )
}

const syncHint = (state: SyncView) => (state.status === 'syncing' ? 'Syncing…' : state.status === 'error' ? 'Sync failed' : null)

/** Every account, then adding and managing them. Opened from the rail's avatar and the Mail header. */
function AccountMenu({ open, onClose, side, align, onAddAccount, onManage }: { open: boolean; onClose: () => void; side: 'right' | 'bottom'; align?: 'start' | 'end'; onAddAccount: () => void; onManage: () => void }) {
  const accounts = useMailSelector((store) => store.accounts)
  const account = useMailSelector((store) => store.account)
  const hints = useMailSelector((store) => store.accounts.map((a) => syncHint(store.syncStateOf(a.id))))
  const { inboxUnread } = useMailCounts()
  const { switchAccount } = useMailActions()
  return (
    <Menu open={open} onClose={onClose} width={280} side={side} align={align} testId="account-menu">
      <MenuLabel>Accounts</MenuLabel>
      {accounts.map((item, index) => {
        const unread = inboxUnread[item.id] ?? 0
        return (
          <MenuItem
            key={item.id}
            testId={`account-${item.email}`}
            label={item.label ? `${item.label} · ${item.email}` : item.email}
            hint={hints[index] ?? (unread > 0 ? `${unread.toLocaleString()} unread` : index === 0 ? 'Primary' : providerFor(item.provider).label)}
            checked={item.id === account.id}
            leading={<Face {...item.face} size={22} />}
            onSelect={() => {
              switchAccount(item.id)
              onClose()
            }}
          />
        )
      })}
      <MenuSeparator />
      <MenuItem
        icon="userPlus"
        label="Add account…"
        testId="account-add"
        onSelect={() => {
          onClose()
          onAddAccount()
        }}
      />
      <MenuItem
        icon="settings"
        label="Manage accounts"
        testId="account-manage"
        onSelect={() => {
          onClose()
          onManage()
        }}
      />
    </Menu>
  )
}

/** The Mail column's title: whose mail this is, and the way to someone else's. */
const AccountHeader = memo(function AccountHeader({ onAddAccount, onManage }: { onAddAccount: () => void; onManage: () => void }) {
  const { C } = useSettings()
  countRender('AccountSwitcher')
  const accounts = useMailSelector((store) => store.accounts)
  const account = useMailSelector((store) => store.account)
  const menu = useToggle()
  return (
    <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, paddingLeft: INSET - 2, paddingRight: INSET - 2, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <div
        testId="account-switcher"
        onClick={menu.toggle}
        style={{ flexGrow: 1, minWidth: 0, height: 40, paddingLeft: 6, paddingRight: 8, gap: 9, borderRadius: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', cursor: 'pointer', backgroundColor: menu.open ? C.overlay : undefined, hover: { backgroundColor: C.overlay } }}
      >
        <div style={{ pointerEvents: 'none', display: 'flex' }}>
          <Face {...account.face} size={26} />
        </div>
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <text style={{ flexShrink: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{account.name}</text>
            {account.label ? <AccountLabelChip label={account.label} color={C[accountTone(account, accounts)]} /> : null}
          </div>
          <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{account.email}</text>
        </div>
        <div style={{ pointerEvents: 'none', display: 'flex' }}>
          <Icon name="chevronDown" size={14} color={C.muted} />
        </div>
        <AccountMenu open={menu.open} onClose={menu.close} side="bottom" onAddAccount={onAddAccount} onManage={onManage} />
      </div>
    </div>
  )
})

const AddLabelRow = memo(function AddLabelRow() {
  countRender('AddLabelRow')
  const { addLabel } = useMailActions()
  const [editing, setEditing] = useState(false)
  if (!editing) return <NavRow icon="plus" label="New label" testId="nav-add-label" quiet onSelect={() => setEditing(true)} />
  return (
    <LabelNameInput
      testId="new-label-input"
      onDone={(value) => {
        if (value.trim()) addLabel(value)
        setEditing(false)
      }}
    />
  )
})

/** A label's name being typed (a new label, or a rename): Enter or leaving the field commits, Escape cancels (null). */
function LabelNameInput({ testId, initial = '', onDone }: { testId: string; initial?: string; onDone: (value: string) => void }) {
  const { C } = useSettings()
  const [name, setName] = useState(initial)
  const done = useRef(false)
  const commit = (value = name) => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  return (
    <div style={{ height: ROW_HEIGHT, paddingLeft: 8, paddingRight: 8, gap: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
      <div style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="tag" size={14} color={C.secondary} />
      </div>
      <input
        testId={testId}
        autoFocus
        value={name}
        placeholder="Label name"
        onChange={(event) => setName(event.value ?? '')}
        // Enter in an <input> arrives as a submit, not a key down.
        onSubmit={(event) => commit(event.value ?? name)}
        onKeyDown={(event) => {
          if (event.key === 'escape') commit(initial)
        }}
        onBlur={() => commit()}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
    </div>
  )
}

/** A Gmail label (`gm:<account>:<name>`, see the engine's gmailLabelId) rather than one Jefi keeps itself. */
export const isServerLabel = (id: string) => id.startsWith('gm:')

const LabelRow = memo(function LabelRow({ id, label, color, active, count, onOpen }: { id: string; label: string; color: string; active: boolean; count: number; onOpen: (id: string) => void }) {
  const { C } = useSettings()
  countRender('LabelRow')
  const { removeLabel, renameLabel, bulk } = useMailActions()
  const menu = useToggle()
  const contextMenu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const snapshot = useMailSnapshot()
  // Read when chosen: a selector here scanned every conversation for every label on each publish.
  // What the label's view lists, and its count counts: not what's in the trash or spam.
  const unreadHere = () => snapshot().threads.filter((t) => t.unread && threadInView(t, `label:${id}`)).map((t) => t.id)
  const onSelect = () => onOpen(id)
  // Gmail labels live on the server, and Jefi can't delete or rename one there yet: offering it would
  // only hide the change until the next sync undid it.
  const deletable = !isServerLabel(id)
  if (renaming) {
    return (
      <LabelNameInput
        testId={`rename-label-input-${id}`}
        initial={label}
        onDone={(value) => {
          renameLabel(id, value)
          setRenaming(false)
        }}
      />
    )
  }
  return (
    <NavRow
      onContext={contextMenu(() => [
        { label: 'Open', icon: 'tag', onSelect },
        { label: 'Mark all as read', icon: 'mailOpen', onSelect: () => bulk(unreadHere(), { unread: false }) },
        ...(deletable
          ? [
              'separator' as const,
              { label: 'Rename label', icon: 'pencil' as const, onSelect: () => setRenaming(true), testId: `ctx-rename-label-${id}` },
              { label: 'Delete label', icon: 'trash' as const, danger: true, onSelect: () => removeLabel(id), testId: `ctx-delete-label-${id}` },
            ]
          : []),
      ])}
      testId={`label-${id}`}
      label={label}
      dot={color}
      active={active}
      count={count || undefined}
      onSelect={onSelect}
      trailing={
        deletable ? (
          <div style={{ flexShrink: 0 }}>
            <div
              testId={`label-menu-${id}`}
              onClick={menu.toggle}
              style={{ width: 20, height: 20, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: menu.open ? 1 : 0.45, hover: { backgroundColor: C.overlayStrong, opacity: 1 } }}
            >
              <div style={{ pointerEvents: 'none', display: 'flex' }}>
                <Icon name="more" size={13} color={C.muted} />
              </div>
            </div>
            <Menu open={menu.open} onClose={menu.close} width={170} align="end">
              <MenuItem
                icon="pencil"
                label="Rename label"
                testId={`label-rename-${id}`}
                onSelect={() => {
                  menu.close()
                  setRenaming(true)
                }}
              />
              <MenuItem
                icon="trash"
                label="Delete label"
                danger
                testId={`label-delete-${id}`}
                onSelect={() => {
                  menu.close()
                  removeLabel(id)
                }}
              />
            </Menu>
          </div>
        ) : undefined
      }
    />
  )
})

// ---------------------------------------------------------------------------
// The app rail
// ---------------------------------------------------------------------------

/** Beside a rail item while it's hovered: its name, and its shortcut or state underneath. */
function RailTip({ label, hint, lines }: { label: string; hint?: string; lines?: string[] }) {
  const { C } = useSettings()
  return (
    <anchored side="right" align="center" gap={10} fit="snap" deferred priority={3} style={{ backgroundColor: C.raised, borderRadius: 7 }}>
      <div
        testId="rail-tip"
        style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 8, backgroundColor: C.raised, borderWidth: 1, borderColor: C.overlayStrong, boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 14, spreadRadius: 0, color: '#00000044' }, display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: 'none' }}
      >
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <text style={{ fontSize: 12.5, fontWeight: 550, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
          {hint ? <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{hint}</text> : null}
        </div>
        {(lines ?? []).map((line, i) => (
          <text key={i} style={{ fontSize: 11.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap' }}>{line}</text>
        ))}
      </div>
    </anchored>
  )
}

/**
 * An icon-only rail entry. GPUIX sends hover only to the element under the pointer, so the item
 * tracks its own hover and shows its name beside it instead of using a Tooltip trigger. The active
 * app gets an accent bar on the rail's edge, like a tab.
 */
function RailItem({
  label,
  hint,
  lines,
  active,
  onSelect,
  testId,
  badge,
  dot,
  height = 40,
  children,
}: {
  label: string
  hint?: string
  lines?: string[]
  active?: boolean
  onSelect: () => void
  testId: string
  badge?: number
  /** A small accent dot in the corner: something needs a glance, without a number. */
  dot?: boolean
  height?: number
  children: ReactNode
}) {
  const { C } = useSettings()
  const [hover, setHover] = useState(false)
  return (
    <div style={{ width: RAIL_WIDTH, height, marginBottom: 4, position: 'relative', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {active ? <div style={{ position: 'absolute', left: 0, top: (height - 20) / 2, width: 3, height: 20, borderTopRightRadius: 2, borderBottomRightRadius: 2, backgroundColor: C.accent, pointerEvents: 'none' }} /> : null}
      <div
        testId={testId}
        onClick={onSelect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 42,
          height,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          backgroundColor: active ? C.navSelected : undefined,
          hover: active ? undefined : { backgroundColor: C.overlay },
        }}
      >
        <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{children}</div>
      </div>
      {badge ? (
        <div
          testId={`${testId}-badge`}
          style={{ position: 'absolute', top: 1, left: RAIL_WIDTH / 2 + 4, minWidth: 18, height: 18, paddingLeft: 5, paddingRight: 5, borderRadius: 9, backgroundColor: C.accent, borderWidth: 2, borderColor: C.sidebar, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}
        >
          <text style={{ fontSize: 10, fontWeight: 700, color: C.onAccent, fontFamily: FONT }}>{badgeText(badge)}</text>
        </div>
      ) : dot ? (
        <div style={{ position: 'absolute', top: 5, left: RAIL_WIDTH / 2 + 9, width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent, borderWidth: 2, borderColor: C.sidebar, pointerEvents: 'none' }} />
      ) : null}
      {hover ? <RailTip label={label} hint={hint} lines={lines} /> : null}
    </div>
  )
}

/** A calendar page with today's date on it, drawn so the number is always today's. */
function CalendarGlyph({ color, now }: { color: string; now: number }) {
  const { C } = useSettings()
  return (
    <div style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: color, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', height: 4, backgroundColor: color }} />
      <div style={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <text style={{ fontSize: 9.5, fontWeight: 700, color, fontFamily: FONT, lineHeight: 1 }}>{String(new Date(now).getDate())}</text>
      </div>
    </div>
  )
}

const CalendarRailItem = memo(function CalendarRailItem({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  const { C } = useSettings()
  const now = useMinute()
  // A dot when something starts within a quarter of an hour: worth a glance from anywhere in Jefi.
  const soon = useEvents(now, now + SOON_MS)
  const next = soon?.find((e) => !e.allDay && e.startAt > now)
  const soonNow = startsSoon(soon ?? [], now)
  return (
    <RailItem
      label="Calendar"
      hint="⌘2"
      lines={soonNow && next ? [`${next.title || 'Untitled event'} in ${Math.max(1, Math.round((next.startAt - now) / 60_000))} min`] : undefined}
      active={active}
      onSelect={onSelect}
      testId="nav-calendar"
      dot={soonNow}
    >
      <CalendarGlyph color={active ? C.text : C.secondary} now={now} />
    </RailItem>
  )
})

const TasksRailItem = memo(function TasksRailItem({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  const { C } = useSettings()
  const now = useMinute()
  // Overdue and due today: the number worth a glance from anywhere, like unread mail.
  const due = dueCount(useTasks() ?? [], now)
  return (
    <RailItem label="Tasks" hint="⌘4" lines={due > 0 ? [`${due} due today or overdue`] : undefined} active={active} onSelect={onSelect} testId="nav-tasks" badge={due}>
      <Icon name="circleCheck" size={19} color={active ? C.text : C.secondary} />
    </RailItem>
  )
})

const MailRailItem = memo(function MailRailItem({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  const { C, settings } = useSettings()
  const { inboxUnread } = useMailCounts()
  const unread = mailBadge(inboxUnread)
  const several = Object.keys(inboxUnread).length > 1
  return (
    <RailItem
      label="Mail"
      hint="⌘1"
      lines={unread > 0 ? [`${unread.toLocaleString()} unread in ${several ? 'your inboxes' : 'your inbox'}`] : undefined}
      active={active}
      onSelect={onSelect}
      testId="nav-mail"
      badge={settings.unreadCounts ? unread : 0}
    >
      <Icon name="mail" size={19} color={active ? C.text : C.secondary} />
    </RailItem>
  )
})

/** Sync as one small dot: quiet while all's well, red only once failures persist (sync-view.ts gates them). */
const RailSync = memo(function RailSync({ onSettings }: { onSettings: () => void }) {
  const { C } = useSettings()
  countRender('RailSync')
  const { sync, offline, account, needsSignIn, outbox } = useMailSelector((store) => ({
    sync: store.sync,
    offline: store.offline,
    account: store.account,
    needsSignIn: store.needsSignInOf(store.account.id),
    outbox: store.threads.filter((t) => t.folder === 'outbox').length,
  }))
  const { syncNow, reconnect } = useMailActions()
  const now = useNow()
  const summary = syncSummary({ sync, offline, needsSignIn, outbox, email: account.email, now })
  // A click does whatever gets mail flowing again: sign in, or check the server now.
  const run = () => {
    if (summary.dot === 'signIn') void reconnect(account.id).then((handled) => handled || onSettings())
    else if (summary.dot !== 'syncing' && summary.dot !== 'offline') syncNow()
  }
  const dot = (color: string) => <div testId="sync-dot" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
  return (
    <div testId="sync-status" style={{ display: 'flex' }}>
      <RailItem label={summary.line} lines={[summary.hint]} onSelect={run} testId="rail-sync" height={30}>
        {summary.dot === 'syncing' ? (
          <Spinner size={12} color={C.muted} />
        ) : summary.dot === 'offline' ? (
          <Icon name="cloudOff" size={15} color={C.muted} />
        ) : summary.dot === 'signIn' ? (
          <Icon name="lock" size={14} color={C.accent} />
        ) : summary.dot === 'failed' ? (
          dot(C.accent)
        ) : summary.dot === 'never' ? (
          dot(C.ghost)
        ) : (
          dot(C.green)
        )}
      </RailItem>
    </div>
  )
})

const RailAccount = memo(function RailAccount({ onAddAccount, onManage }: { onAddAccount: () => void; onManage: () => void }) {
  const { C } = useSettings()
  const account = useMailSelector((store) => store.account)
  const menu = useToggle()
  const [hover, setHover] = useState(false)
  return (
    <div style={{ width: RAIL_WIDTH, height: 40, marginBottom: 4, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 36, height: 36, borderRadius: 18, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: menu.open ? C.accent : hover ? C.border : '#00000000' }}>
        <Face {...account.face} size={28} />
        {/* The photo is an image, which takes the pointer whatever its parent says, so the click
            target is a clear layer over it. */}
        <div
          testId="rail-account"
          onClick={menu.toggle}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{ position: 'absolute', top: -2, left: -2, width: 36, height: 36, borderRadius: 18, cursor: 'pointer', backgroundColor: '#00000001' }}
        />
      </div>
      {/* Anchored to the rail's full width, so the menu opens beside the rail rather than over it. */}
      <AccountMenu open={menu.open} onClose={menu.close} side="right" align="end" onAddAccount={onAddAccount} onManage={onManage} />
      {hover && !menu.open ? <RailTip label={account.name} lines={[account.email]} /> : null}
    </div>
  )
})

export const AppRail = memo(function AppRail({
  app,
  settingsOpen,
  onApp,
  assistantOpen,
  onAssistant,
  onPalette,
  onSettings,
  onAddAccount,
  collapsed,
  canCollapse,
  onToggleCollapsed,
}: {
  app: AppName
  settingsOpen: boolean
  onApp: (app: AppName) => void
  assistantOpen: boolean
  onAssistant: () => void
  /** Opens the command palette (⌘K). */
  onPalette: () => void
  /** Settings, at `section` when given (Manage accounts opens it at Accounts). */
  onSettings: (section?: SettingsSection) => void
  onAddAccount: () => void
  collapsed: boolean
  /** The active app has a context column to hide (Notes doesn't). */
  canCollapse: boolean
  onToggleCollapsed: () => void
}) {
  const { C } = useSettings()
  countRender('AppRail')
  const addAccount = useStableCallback(() => onAddAccount())
  const openSettings = useStableCallback(() => onSettings())
  const manageAccounts = useStableCallback(() => onSettings('accounts'))
  const pick = (next: AppName) => () => onApp(next)
  const current = (name: AppName) => !settingsOpen && app === name
  return (
    <div
      testId="app-rail"
      style={{ width: RAIL_WIDTH, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: C.sidebar, borderRightWidth: 1, borderColor: C.divider, userSelect: 'none' }}
    >
      {/* The window buttons live in this band. */}
      <div style={{ height: 52, flexShrink: 0 }} />

      <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <MailRailItem active={current('mail')} onSelect={pick('mail')} />
        <CalendarRailItem active={current('calendar')} onSelect={pick('calendar')} />
        <RailItem label="Notes" hint="⌘3" active={current('notes')} onSelect={pick('notes')} testId="nav-notes">
          <Icon name="file" size={19} color={current('notes') ? C.text : C.secondary} />
        </RailItem>
        <TasksRailItem active={current('tasks')} onSelect={pick('tasks')} />
        <RailItem label={assistantOpen ? 'Hide the assistant' : 'Assistant'} hint="⌘J" active={assistantOpen} onSelect={onAssistant} testId="nav-assistant">
          <Icon name="sparkles" size={19} color={assistantOpen ? C.accent : C.secondary} />
        </RailItem>
      </div>

      <div style={{ paddingTop: 8, paddingBottom: 12, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {canCollapse ? (
          <RailItem label={collapsed ? 'Show sidebar' : 'Hide sidebar'} hint="⌘\" onSelect={onToggleCollapsed} testId="sidebar-toggle" height={34}>
            <Icon name="sidebar" size={17} color={C.muted} />
          </RailItem>
        ) : null}
        <RailItem label="Search or jump to" hint="⌘K" onSelect={onPalette} testId="command-bar" height={34}>
          <Icon name="search" size={17} color={C.muted} />
        </RailItem>
        <RailItem label="Send feedback" lines={['Report a bug or request a feature']} onSelect={() => openFeedback('bug')} testId="rail-feedback" height={34}>
          <Icon name="messageSquare" size={17} color={C.secondary} />
        </RailItem>
        <RailSync onSettings={openSettings} />
        <div style={{ width: 24, height: 1, backgroundColor: C.divider, marginTop: 4, marginBottom: 8, flexShrink: 0 }} />
        <RailAccount onAddAccount={addAccount} onManage={manageAccounts} />
        <RailItem label="Settings" active={settingsOpen} onSelect={() => onSettings()} testId="nav-settings" height={34}>
          <Icon name="settings" size={18} color={settingsOpen ? C.text : C.secondary} />
        </RailItem>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// The context column
// ---------------------------------------------------------------------------

/** The context column's frame: the resizable width and the sidebar's colour. */
export function ContextColumn({ children, testId }: { children: ReactNode; testId?: string }) {
  const { C } = useSettings()
  const width = usePaneWidth('sidebar')
  return (
    <div testId={testId} style={{ width, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.sidebar, userSelect: 'none' }}>
      {children}
      <UpdateCard />
    </div>
  )
}

/** "Later" on the update card, for this run: the column remounts as apps switch, so it lives out here. */
let laterFor: string | null = null

/** A newer Jefi, at the foot of whichever context column is showing, with the one thing to do about it. */
function UpdateCard() {
  const { C, settings } = useSettings()
  const [dismissed, setDismissed] = useState(laterFor)
  const card = updateCard(useUpdater(), dismissed)
  if (!card) return null
  const later = () => {
    laterFor = card.version
    setDismissed(card.version)
  }
  const act = () => (card.action === 'restart' ? void restartToUpdate() : void Bun.spawn(['open', card.url!], { stdout: 'ignore', stderr: 'ignore' }))
  return (
    <div style={{ paddingLeft: INSET, paddingRight: INSET, paddingBottom: 12, flexShrink: 0 }}>
      <motion.div initial={{ opacity: 0, top: 8 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: 0.24, ease: 'easeOut' }} style={{ position: 'relative' }}>
        <div
          testId="update-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 12,
            backgroundColor: C.raised,
            boxShadow: { offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: 0, color: settings.theme === 'dark' ? '#00000066' : '#0000001F' },
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: `${C.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name={card.action === 'restart' ? 'sparkles' : 'download'} size={15} color={C.accent} />
            </div>
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <text testId="update-card-title" style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{card.title}</text>
              <text style={{ fontSize: 11.5, color: C.secondary, fontFamily: FONT }}>{card.detail}</text>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <div
              testId="update-card-action"
              onClick={act}
              style={{ flexGrow: 1, height: 28, borderRadius: 14, backgroundColor: C.text, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) }, active: { backgroundColor: mixHex(C.text, C.reading, 0.22) } }}
            >
              <text style={{ fontSize: 12.5, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none' }}>{card.action === 'restart' ? 'Restart now' : 'Download'}</text>
            </div>
            <div
              testId="update-card-later"
              onClick={later}
              style={{ height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 14, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
            >
              <text style={{ fontSize: 12.5, fontWeight: 500, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>Later</text>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

const FOLDER_BY_ID = new Map(FOLDERS.map((f) => [f.id, f]))

/** Memoized, with its counts selected: a publish that changes none of them doesn't reach it. */
export const MailSidebar = memo(function MailSidebar({
  view,
  onView,
  settingsOpen,
  tool = null,
  onTool,
  onCompose,
  onSettings,
  onAddAccount,
}: {
  view: MailboxView
  onView: (view: MailboxView) => void
  settingsOpen: boolean
  /** Settings, at `section` when given (Manage accounts opens it at Accounts). */
  onSettings: (section?: SettingsSection) => void
  tool?: Tool | null
  onTool: (tool: Tool) => void
  onCompose: () => void
  onAddAccount: () => void
}) {
  const { C, settings, update } = useSettings()
  countRender('Sidebar')
  const { labels, folders, screenerOn, accountId, accountIds, listComplete } = useMailSelector((store) => ({
    labels: store.labels,
    folders: store.folders,
    screenerOn: store.screenerOn,
    accountId: store.account.id,
    accountIds: store.accounts.map((a) => a.id).join('\u001f'),
    listComplete: store.listComplete,
  }))
  const counted = useMailCounts()
  const tally = counted.sidebar
  const inboxUnread = counted.inboxUnread[accountId] ?? 0
  // With two accounts or more, their Inboxes and Starred also show together, above this account's own.
  const everyAccount = accountIds ? accountIds.split('\u001f') : []
  const unifiedUnread = everyAccount.reduce((sum, id) => sum + (counted.inboxUnread[id] ?? 0), 0)
  const { bulk } = useMailActions()
  const snapshot = useMailSnapshot()
  // Stable handlers for the memoized rows below, which would otherwise render with every sidebar render.
  const openLabel = useStableCallback((id: string) => onView(`label:${id}`))
  const addAccount = useStableCallback(() => onAddAccount())
  const openSettings = useStableCallback(() => onSettings())
  const manageAccounts = useStableCallback(() => onSettings('accounts'))
  const contextMenu = useContextMenu()
  const width = usePaneWidth('sidebar')
  const toggle = (section: SidebarSection) => update({ sidebar: toggleSection(settings.sidebar, section) })
  const onMail = !settingsOpen && !tool

  const screenedCount = tally.screened
  const counts: Partial<Record<FolderId, number>> = {
    inbox: inboxUnread,
    outbox: tally.outbox,
    drafts: tally.drafts,
    spam: tally.spamUnread,
  }
  /** Read vs unread for the folders whose badge counts unread mail. */
  const unreadStats = (folder: FolderId) => {
    const { all, unread, today, older, starred } = tally.stats[folder] ?? { all: 0, unread: 0, today: 0, older: 0, starred: 0 }
    const facts = [
      today ? `${today.toLocaleString()} unread from today` : '',
      older ? `${older.toLocaleString()} unread for over a week` : '',
      starred ? `${starred.toLocaleString()} unread and starred` : '',
    ].filter(Boolean)
    // "N unread of M" only when the list holds the whole mailbox: the badge counts past the window.
    return { total: listComplete && unread === counts[folder] ? all : undefined, facts }
  }
  const folderRow = (id: FolderId) => {
    const item = FOLDER_BY_ID.get(id)!
    return (
      <NavRow
        key={id}
        onContext={contextMenu(() => [
          { label: `Open ${item.label}`, icon: item.icon, onSelect: () => onView(id) },
          {
            label: 'Mark all as read',
            icon: 'mailOpen',
            testId: `ctx-read-all-${id}`,
            onSelect: () => bulk(snapshot().threads.filter((t) => t.folder === id && !t.onlyInFolders && t.unread).map((t) => t.id), { unread: false }),
          },
        ])}
        icon={item.icon}
        label={item.label}
        testId={`nav-${id}`}
        active={onMail && view === id}
        count={counts[id]}
        {...(item.tone === 'red' ? unreadStats(id) : {})}
        tone={item.tone}
        onSelect={() => onView(id)}
      />
    )
  }
  const core = CORE_FOLDERS.filter((id) => id !== 'outbox' || (counts.outbox ?? 0) > 0)
  const toolActive = !settingsOpen && (tool === 'cleanup' || tool === 'rules')
  const moreActive = (onMail && MORE_FOLDERS.includes(view as FolderId)) || toolActive
  const moreShown = sectionShown(settings.sidebar, 'more', moreActive)
  const labelsShown = sectionShown(settings.sidebar, 'labels', onMail && view.startsWith('label:'))
  const foldersShown = sectionShown(settings.sidebar, 'folders', onMail && view.startsWith('folder:'))
  const spamUnread = counts.spam ?? 0

  return (
    <ContextColumn testId="mail-sidebar">
      <AccountHeader onAddAccount={addAccount} onManage={manageAccounts} />
      <div style={{ paddingLeft: INSET, paddingRight: INSET, paddingTop: 2, paddingBottom: 10, flexShrink: 0 }}>
        <ComposeButton width={width - INSET * 2} onClick={onCompose} />
      </div>

      <div testId="sidebar-nav" style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', paddingLeft: INSET, paddingRight: INSET, paddingTop: 4, paddingBottom: 12 }}>
        {everyAccount.length > 1 ? (
          <>
            <NavRow icon={FOLDER_BY_ID.get('inbox')!.icon} label="All Inboxes" testId="nav-all-inbox" active={onMail && view === 'all:inbox'} count={unifiedUnread || undefined} tone={FOLDER_BY_ID.get('inbox')!.tone} onSelect={() => onView('all:inbox')} />
            <NavRow icon={FOLDER_BY_ID.get('starred')!.icon} label="All Starred" testId="nav-all-starred" active={onMail && view === 'all:starred'} onSelect={() => onView('all:starred')} />
            <div style={{ height: 10, flexShrink: 0 }} />
          </>
        ) : null}
        {core.map(folderRow)}
        {screenerOn ? (
          <NavRow icon="userPlus" label="Screener" testId="nav-screener" active={onMail && view === 'screener'} count={screenedCount || undefined} onSelect={() => onView('screener')} />
        ) : null}
        <NavRow
          icon={moreShown ? 'chevronDown' : 'chevronRight'}
          label="More"
          testId="nav-more"
          quiet
          count={!moreShown && spamUnread ? spamUnread : undefined}
          tone="muted"
          onSelect={() => toggle('more')}
        />
        {moreShown ? (
          <>
            {MORE_FOLDERS.map(folderRow)}
            {/* The tools sit with the mailboxes you open now and then, not pinned under every list. */}
            <NavRow icon="broom" label="Clean up" testId="nav-cleanup" active={!settingsOpen && tool === 'cleanup'} onSelect={() => onTool('cleanup')} />
            <NavRow icon="sliders" label="Rules" testId="nav-rules" active={!settingsOpen && tool === 'rules'} onSelect={() => onTool('rules')} />
          </>
        ) : null}

        <SectionHeader label="Labels" open={labelsShown} onToggle={() => toggle('labels')} testId="section-labels" />
        {labelsShown ? (
          <>
            {labels.map((item) => (
              <LabelRow
                key={item.id}
                id={item.id}
                label={item.label}
                color={C[item.color]}
                active={onMail && view === `label:${item.id}`}
                count={tally.labels[item.id] ?? 0}
                onOpen={openLabel}
              />
            ))}
            <AddLabelRow />
          </>
        ) : null}
        {folders.length > 0 ? (
          <>
            <SectionHeader label="Folders" open={foldersShown} onToggle={() => toggle('folders')} testId="section-folders" />
            {foldersShown
              ? folders.map((item) => (
                  <div key={item.path} style={{ paddingLeft: Math.min(item.depth, 3) * 14, flexShrink: 0 }}>
                    <NavRow
                      onContext={contextMenu(() => [
                        { label: 'Open', icon: 'folder', onSelect: () => onView(`folder:${item.path}`) },
                        {
                          label: 'Mark all as read',
                          icon: 'mailOpen',
                          onSelect: () => bulk(snapshot().threads.filter((t) => t.folders?.includes(item.path) && t.unread).map((t) => t.id), { unread: false }),
                        },
                      ])}
                      icon="folder"
                      label={item.name}
                      testId={`folder-${item.path}`}
                      active={onMail && view === `folder:${item.path}`}
                      count={tally.folders[item.path] || undefined}
                      onSelect={() => onView(`folder:${item.path}`)}
                    />
                  </div>
                ))
              : null}
          </>
        ) : null}
      </div>
    </ContextColumn>
  )
})
