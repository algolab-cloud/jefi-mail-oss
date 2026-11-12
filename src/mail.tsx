/**
 * Jefi mail client. Sidebar, mail list, reading pane, compose, and settings.
 *
 * Run: bun --hot src/mail.tsx
 */

// First, before anything GPUIX loads: `Jefi cli …` and `Jefi mcp` run there and exit.
import './headless/gate'
import { countRender } from './render-counts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { applyMacCpuThrottleFromEnv, render } from '@gpuix/react'

import { FONT, SettingsContext, loadSettings, palette, saveSettings, useSettings, type Settings } from './theme'
import type { DraftFields, FolderId, MailThread } from './data'
import { InboxList, NO_FILTERS, type ListFilters, type Tab } from './list'
import { AppRail, ContextColumn, MailSidebar, TRAFFIC_LIGHT_X } from './sidebar'
import { appKeyFor, appOf, type AppName, type Tool } from './sidebar-state'
import { baseView, isUnified, threadInView, type MailboxView } from './view'
import { pagedRows } from './view-pages'
import { successor, unclickedThread } from './selection'
import { sameItems } from './store-equality'
import { ReadingPane, prepareForwardDraft } from './reading'
import { replyDraft } from './reply'
import { SettingsPane } from './settings'
import { SettingsSidebar } from './settings-sidebar'
import { CleanupPane } from './cleanup'
import { useScheduledCleanup } from './cleanup-schedule'
import { lockMailbox } from './instance-lock'
import { hardenDataDir } from './data-dir'
import { configDir } from './paths'
import { requestSmartView } from './smart-clean'
import { dispatchKey, isCmd, useKeys } from './keys'
import { CommandPalette, type Command } from './palette'
import { hintFor, shortcutFor, type Prefix, type ShortcutAction } from './shortcuts'
import { ShortcutSheet } from './shortcut-sheet'
import { WhatsNewSheet } from './whats-new-sheet'
import { NotificationPermissionSheet, useNotificationPermission, type PromptOutcome } from './notification-permission'
import { forcedNotificationPrompt, shouldShowNotificationPrompt } from './notification-prompt'
import { currentNotes, whatsNewDecision, WHATS_NEW } from './whats-new'
import { APP_NAME, APP_VERSION } from './version'
import { overlaysOpen } from './overlays'
import { RulesPane } from './rules'
import { NotesPane, requestNotes, useNoteRequests, type NoteRequest } from './notes'
import { TaskComposerHost, TasksPane, TasksSidebar, openTaskComposer, requestMakeTask, useTaskRequests, type TaskRequest } from './tasks'
import { ComposePane } from './compose'
import { AccountWizard } from './account-wizard'
import { FOLDER_NAMES, MailProvider, useMailActions, useMailCounts, useMailSelector } from './store'
import { Toaster, toast } from './toast'
import { Onboarding } from './onboarding'
import { JefiMark } from './brand'
import { Button } from './ui'
import { AssistantPanel } from './assistant-panel'
import { onHandoff } from './assistant-handoff'
import { copySelectionOnKey } from './copy-selection'
import { PaneResizer } from './resizer'
import { resolveNotificationThread } from './notification-routing'
import { useStableCallback } from './stable-callback'

/** External route resolution is mounted per request so cancellation unmounts and invalidates it. */
function useMountEffect(effect: () => void | (() => void)) {
  useEffect(effect, [])
}

function NotificationOpenResolver({
  request,
  threads,
  load,
  onResolved,
}: {
  request: string
  threads: readonly MailThread[]
  load: (id: string) => Promise<MailThread | null>
  onResolved: (thread: MailThread | null) => void
}) {
  useMountEffect(() => {
    let live = true
    void resolveNotificationThread(request, threads, load)
      .then((thread) => live && onResolved(thread))
      .catch(() => live && onResolved(null))
    return () => {
      live = false
    }
  })
  return null
}
import { restartToUpdate, useUpdater, watchForUpdates } from './use-updater'
import { applyDockBadge, applyDockIcon, dockIconPath } from './dock-icon'
import { ContextMenuHost, ContextMenuProvider } from './context-menu'
import { CalendarSidebar, CalendarView, EventEditorHost, openEventEditor, useCalendarRequests } from './calendar'
import { FeedbackHost } from './feedback-sheet'
import { openFeedback } from './feedback'
import { registerInviteSender } from './calendar/invites'
import { MenuBarHost } from './menubar/host'
import { useWorkspaceRequests } from './menubar/requests'
import { closePlan, configureLifecycle, onMainWindowShown, showMainWindow } from './native/app-lifecycle'
import { listenForLinks } from './native/links'
import { installWindowGlass } from './native/window-glass'
import { dispatchEventOpen } from './native/notify'
import { SETTINGS_SECTIONS, deferJefiRoute, routeJefiLink, subscribeJefiLinks, type LinkTargets, type SettingsSection } from './deeplink'
import { requestCalendar, showEvent } from './calendar/state'
import { quickAddPrefill, quickAddTask } from './menubar/model'
import { parseTaskText } from './tasks/model'
import { userTimeZone } from './reader-calendar/suggest'

/** How long a selected conversation waits for its bodies before showing without them (see select). */
const OPEN_WAIT_MS = 60
/** List snapshots carry previews: a synced conversation's bodies load when it's shown. */
const needsBodies = (thread: MailThread) => !thread.full && thread.folder !== 'drafts' && thread.id.includes(':')

type ComposeState = { key: number; initial?: Partial<DraftFields>; draftId?: string; replyTo?: string; parentMessageId?: string; title: string }

/** Mailbox jumps that have a `g` shortcut, for the command palette's hints. */
const GO_HINTS: Partial<Record<FolderId, string | undefined>> = {
  inbox: hintFor('goInbox'),
  starred: hintFor('goStarred'),
  drafts: hintFor('goDrafts'),
  sent: hintFor('goSent'),
}

function Workspace({ onAddAccount, wizardOpen }: { onAddAccount: () => void; wizardOpen: boolean }) {
  const { C, settings: prefs, update } = useSettings()
  // The keyboard the person chose in Settings (shortcuts.ts).
  const bindings = useMemo(() => ({ scheme: prefs.shortcutScheme, keys: prefs.shortcutKeys }), [prefs.shortcutScheme, prefs.shortcutKeys])
  countRender('Workspace')
  // What the workspace shows, not the whole store: a publish or sync event that changes none of it
  // (sync progress, contacts, the view query catching up) doesn't re-render the list and reader.
  const { ruleDraft, threads: accountThreads, allThreads, labels, folders, screenerOn, account, accounts, pageView, pageOrder, pageLoading, pageHasMore, hasOlder, openRequest } = useMailSelector((store) => ({
    ruleDraft: store.ruleDraft,
    threads: store.threads,
    allThreads: store.allThreads,
    labels: store.labels,
    folders: store.folders,
    screenerOn: store.screenerOn,
    account: store.account,
    accounts: store.accounts,
    pageView: store.viewPage.view,
    pageOrder: store.viewPage.order,
    pageLoading: store.viewPage.loading,
    pageHasMore: store.viewPage.hasMore,
    hasOlder: store.hasOlder,
    openRequest: store.openRequest,
  }))
  const viewPage = { view: pageView, order: pageOrder, loading: pageLoading, hasMore: pageHasMore }
  const { setView: setStoreView, loadOlder, syncNow, bulk, search, setUnread, move, toggleStar, send, reply, saveDraft, deleteForever, notify, getAttachment, fetchThread, openThread, clearOpenRequest, showThread, getEvent, switchAccount, accountOf } = useMailActions()

  const [view, setView] = useState<MailboxView>('inbox')
  // All Inboxes and All Starred list every account's conversations; everything else, this account's.
  // With one account left there is nothing to merge, so a unified view falls back to its own.
  const unified = isUnified(view) && accounts.length > 1
  const threads = unified ? allThreads : accountThreads
  useEffect(() => {
    if (isUnified(view) && accounts.length <= 1) setView(baseView(view))
  }, [view, accounts.length])
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** A section Settings was asked to show (jefi://settings/ai, the assistant's Open Settings). */
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSection; key: number } | null>(null)
  const [tool, setTool] = useState<null | 'cleanup' | 'rules' | 'notes' | 'calendar' | 'tasks'>(null)
  // "Open this note" or "New note" from anywhere (the reader, the palette) opens the notes view on it.
  const [noteRequest, setNoteRequest] = useState<(NoteRequest & { key: number }) | null>(null)
  useNoteRequests((request) => {
    clearOpenRequest()
    setCompose(null)
    setSettingsOpen(false)
    setTool('notes')
    setNoteRequest({ ...request, key: Date.now() })
  })
  // "Open this task" from anywhere (the reader's task chips, a toast, the menu bar) opens the tasks view on it.
  const [taskRequest, setTaskRequest] = useState<(TaskRequest & { key: number }) | null>(null)
  useTaskRequests((request) => {
    clearOpenRequest()
    setCompose(null)
    setSettingsOpen(false)
    setTool('tasks')
    setTaskRequest({ ...request, key: Date.now() })
  })
  // "Show in calendar" from anywhere (the reader's event chips) opens the calendar; it holds the date itself.
  useCalendarRequests(() => {
    clearOpenRequest()
    setCompose(null)
    setSettingsOpen(false)
    setTool('calendar')
  })
  // Compose and Settings from the menu bar panel.
  useWorkspaceRequests((request) => {
    if (request === 'settings') return openPane('settings')
    setTool(null)
    openCompose()
  })
  const setCleanupOpen = (open: boolean) => setTool(open ? 'cleanup' : null)
  // "Create rule…" from a context menu opens the Rules pane with the draft.
  useEffect(() => {
    if (!ruleDraft) return
    setSettingsOpen(false)
    setTool('rules')
  }, [ruleDraft?.id])
  // The context column's hidden state is a setting, so it survives restarts.
  const sidebarCollapsed = prefs.sidebar.collapsed
  const app = appOf(tool)
  const toggleSidebar = () => update({ sidebar: { ...prefs.sidebar, collapsed: !prefs.sidebar.collapsed } })
  const [tab, setTab] = useState<Tab>('Priority')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ListFilters>(NO_FILTERS)
  const [active, setActive] = useState<string | null>(null)
  const [history, setHistory] = useState<{ back: Array<{ view: MailboxView; id: string }>; forward: Array<{ view: MailboxView; id: string }> }>({ back: [], forward: [] })
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [forwarding, setForwarding] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  // A summary sent to the chat opens the assistant, where it waits for the person's question.
  useEffect(() => onHandoff(() => setAssistantOpen(true)), [])
  // New versions arrive in the background. The context column says so with a card (sidebar.tsx);
  // with no column showing (hidden, or in Notes), a toast says it once instead.
  const updates = useUpdater()
  const columnShown = !sidebarCollapsed && app !== 'notes'
  useEffect(() => watchForUpdates(prefs.autoUpdate), [prefs.autoUpdate])
  const toastedUpdate = useRef<string | null>(null)
  useEffect(() => {
    if (updates.status !== 'ready' || columnShown || toastedUpdate.current === updates.version) return
    toastedUpdate.current = updates.version
    toast.info(`Jefi ${updates.version} is ready`, {
      id: 'update-ready',
      description: 'It installs when you restart',
      action: { label: 'Restart now', onClick: () => void restartToUpdate() },
    })
  }, [updates.status === 'ready' ? updates.version : null, columnShown])

  // "What's new" after an update to a new minor version, once nothing else is asking for attention.
  // JEFI_FORCE_WHATS_NEW is for screenshots: it shows the newest notes whatever was seen before.
  // JEFI_SKIP_ONBOARDING starts scripts in a mailbox with nothing in front of it, so it skips them.
  const [whatsNewOpen, setWhatsNewOpen] = useState(false)
  const forceWhatsNew = process.env.JEFI_FORCE_WHATS_NEW === '1'
  const skipWhatsNew = process.env.JEFI_SKIP_ONBOARDING === '1'
  const whatsNew = forceWhatsNew ? 'show' : skipWhatsNew ? 'nothing' : whatsNewDecision({ onboarded: prefs.onboarded, lastSeenVersion: prefs.lastSeenVersion, appVersion: APP_VERSION })
  useEffect(() => {
    if (whatsNew === 'record') update({ lastSeenVersion: APP_VERSION })
    else if (whatsNew === 'show' && !wizardOpen) setWhatsNewOpen(true)
  }, [whatsNew, wizardOpen])
  const closeWhatsNew = () => {
    setWhatsNewOpen(false)
    if (prefs.lastSeenVersion !== APP_VERSION) update({ lastSeenVersion: APP_VERSION })
  }
  const notes = forceWhatsNew ? WHATS_NEW[0] : currentNotes(APP_VERSION)

  // The notification permission sheet, once the app is up and nothing else is asking: queued behind
  // onboarding, a wizard and What's new. Decided once per launch.
  const permission = useNotificationPermission()
  const [promptVariant, setPromptVariant] = useState<'undetermined' | 'denied' | null>(null)
  const promptDecided = useRef(false)
  const promptBusy = !prefs.onboarded || wizardOpen || whatsNewOpen || whatsNew === 'show'
  useEffect(() => {
    if (promptDecided.current || permission.status === null || promptBusy) return
    const timer = setTimeout(() => {
      promptDecided.current = true
      const forced = forcedNotificationPrompt()
      const variant = forced ?? shouldShowNotificationPrompt(permission.status!, prefs, Date.now(), { appVersion: APP_VERSION, busy: false })
      if (!variant) return
      if (variant === 'denied' && !forced) update({ notificationDeniedPromptVersion: APP_VERSION })
      setPromptVariant(variant)
    }, 1200)
    return () => clearTimeout(timer)
  }, [permission.status, promptBusy])
  const closePrompt = (outcome: PromptOutcome) => {
    setPromptVariant(null)
    if (outcome === 'later') update({ notificationPromptDismissedAt: Date.now() })
  }

  // Whole-mailbox search through the engine, a moment after typing stops, and again when mail lands
  // (a search opened by a link at first launch runs before anything has synced).
  const [results, setResults] = useState<{ query: string; ids: string[] } | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return setResults(null)
    let live = true
    const timer = setTimeout(() => void search(q).then((ids) => live && setResults({ query: q, ids })), 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, threads.length])
  const searching = !!results && results.query === query.trim()

  // The engine's page for this view. The store hears about a change a render after this does, so
  // until it catches up the view is treated as still loading rather than as empty.
  // The engine pages one account's view; a unified view lists what every account already holds.
  useEffect(() => setStoreView(baseView(view)), [view])
  const page = unified ? { view, order: null, loading: false, hasMore: false } : viewPage.view === view ? viewPage : { view, order: null, loading: true, hasMore: false }

  const source = useMemo(() => {
    if (searching) {
      const byId = new Map(threads.map((t) => [t.id, t]))
      return results!.ids.map((id) => byId.get(id)).filter((t): t is MailThread => !!t)
    }
    // Without a page (Snoozed, the Screener, the Outbox) the account's window is all there is.
    if (!page.order) return threads.filter((t) => threadInView(t, view))
    return pagedRows(threads, page.order, page.hasMore, view)
  }, [threads, view, searching, results, page.order, page.hasMore])

  const lastVisible = useRef<MailThread[]>([])
  const visibleThreads = useMemo(() => {
    const q = query.trim().toLowerCase()
    return source.filter((thread) => {
      // The open conversation stays while it's read: opening it marks it read, and it mustn't vanish from under the reader.
      if (tab === 'Unread' && !thread.unread && thread.id !== active) return false
      if (tab === 'Priority' && !thread.priority && !searching) return false
      if (filters.attachments && !thread.icons.includes('paperclip') && !thread.messages.some((m) => m.attachments?.length)) return false
      if (filters.starred && !thread.starred) return false
      if (filters.labeled && thread.labels.length === 0) return false
      // Engine results already matched bodies and operators; don't filter them again locally.
      if (!q || searching) return true
      return (
        thread.sender.toLowerCase().includes(q) ||
        thread.subject.toLowerCase().includes(q) ||
        thread.snippet.toLowerCase().includes(q) ||
        thread.messages.some((m) => m.from.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      )
    })
  }, [source, tab, query, filters, searching, tab === 'Unread' ? active : null])
  // The same rows as last time (a publish that changed nothing listed here) keep the list's props
  // as they were, so the memoized list skips the render.
  if (!sameItems(visibleThreads, lastVisible.current)) lastVisible.current = visibleThreads
  const listed = lastVisible.current

  // When the open conversation leaves this list (archived, deleted, moved, changed elsewhere), the
  // reader moves on to the one that took its place, not back to the top. Only within the same list:
  // a new search or tab starts over from its first conversation.
  const listKey = `${view}\u0000${tab}\u0000${query}\u0000${searching}\u0000${JSON.stringify(filters)}`
  const shown = useRef({ key: listKey, ids: [] as string[] })
  let thread = visibleThreads.find((t) => t.id === active)
  if (!thread && active && shown.current.key === listKey) {
    const next = successor(shown.current.ids, visibleThreads, active)
    if (next) {
      thread = next
      setActive(next.id)
    }
  }
  // Nothing clicked: the first conversation, then that same one while it's listed (selection.ts).
  const unclicked = useRef<string | null>(null)
  thread ??= unclickedThread(visibleThreads, shown.current.key === listKey ? unclicked.current : null)
  unclicked.current = active ? null : (thread?.id ?? null)
  shown.current = { key: listKey, ids: visibleThreads.map((t) => t.id) }
  // Load the displayed conversation's bodies however it came to be shown: clicked, or simply first
  // in the list. List snapshots carry previews only.
  useEffect(() => {
    if (thread && needsBodies(thread)) void openThread(thread.id)
  }, [thread?.id])
  const title = searching
    ? `Search · ${results!.ids.length === 300 ? '300+' : results!.ids.length}`
    : view.startsWith('label:')
    ? (labels.find((l) => `label:${l.id}` === view)?.label ?? 'Label')
    : view === 'all:inbox'
    ? 'All Inboxes'
    : view === 'all:starred'
    ? 'All Starred'
    : view === 'screener'
      ? 'Screener'
      : view.startsWith('folder:')
      ? (folders.find((f) => `folder:${f.path}` === view)?.name ?? 'Folder')
      : FOLDER_NAMES[view as FolderId]

  const goView = (next: MailboxView) => {
    clearOpenRequest()
    supersedeSelect()
    setView(next)
    setSettingsOpen(false)
    setCleanupOpen(false)
    setCompose(null)
    setActive(null)
    setTab(next === 'inbox' ? 'Priority' : 'All')
  }

  const openCompose = (initial?: Partial<DraftFields>, extra?: { draftId?: string; replyTo?: string; parentMessageId?: string; title?: string }) => {
    clearOpenRequest()
    supersedeSelect()
    setSettingsOpen(false)
    setCleanupOpen(false)
    // A reply keeps what it answers in its fields, so its saved draft reopens as the same reply.
    const replyTo = extra?.replyTo ?? initial?.replying?.threadId
    const parentMessageId = extra?.replyTo ? extra.parentMessageId : initial?.replying?.messageId
    const fields = replyTo ? { ...initial, replying: { threadId: replyTo, ...(parentMessageId ? { messageId: parentMessageId } : {}) } } : initial
    setCompose({ key: Date.now(), initial: fields, draftId: extra?.draftId, replyTo, parentMessageId, title: extra?.title ?? 'New message' })
  }

  // A selection waiting for its bodies (see select). Anything else that picks what the reader shows
  // supersedes it, so a late one can't land on top.
  const selecting = useRef<{ token: number; id: string | null }>({ token: 0, id: null })
  const supersedeSelect = () => {
    selecting.current = { token: selecting.current.token + 1, id: null }
  }
  const select = (id: string, record = true) => {
    const target = threads.find((t) => t.id === id)
    if (!target) return
    clearOpenRequest()
    supersedeSelect()
    if (target.folder === 'drafts') {
      openCompose(target.draft ?? { subject: target.subject }, { draftId: target.id, title: 'Draft' })
      return
    }
    const from = thread
    const show = () => {
      if (record && from && from.id !== id) setHistory((h) => ({ back: [...h.back, { view, id: from.id }], forward: [] }))
      setCompose(null)
      setActive(id)
      if (target.unread) setUnread(id, false)
    }
    if (!needsBodies(target)) return show()
    // Shown with its bodies in one commit: the conversation first and its bodies a moment later was
    // two, and GPUIX draws a whole-window frame for each. Stored bodies come in a few milliseconds;
    // ones still on the server don't hold the selection up past a short wait, and follow it.
    const token = selecting.current.token
    selecting.current = { token, id }
    const once = () => {
      if (selecting.current.token !== token || selecting.current.id !== id) return
      selecting.current = { token, id: null }
      show()
    }
    void openThread(id).then(once)
    setTimeout(once, OPEN_WAIT_MS)
  }

  /**
   * Moves a conversation out of the list. When it's the one on screen, the reader moves on to the one
   * that takes its place (selection.ts): that one's bodies are asked for first, so it shows with them
   * in the move's own commit rather than a frame later, waiting no longer than a selection does.
   */
  const moving = useRef<string | null>(null)
  const moveShown = (id: string, folder: FolderId) => {
    if (moving.current === id) return
    const ids = visibleThreads.map((t) => t.id)
    const next = id === thread?.id ? successor(ids, visibleThreads.filter((t) => t.id !== id), id) : null
    if (!next || !needsBodies(next)) return move(id, folder)
    moving.current = id
    const once = () => {
      if (moving.current !== id) return
      moving.current = null
      move(id, folder)
    }
    void openThread(next.id).then(once)
    setTimeout(once, OPEN_WAIT_MS)
  }

  /**
   * The conventional mail keys (shortcuts.ts). Everything they do already exists as a store action or
   * a state change here; this only routes an action to one.
   */
  const bulkShortcuts = useRef<((action: ShortcutAction) => boolean) | null>(null)
  const runShortcut = (action: ShortcutAction) => {
    // Checked conversations take the keys that act on a conversation (the list knows which).
    if (bulkShortcuts.current?.(action)) return
    const last = thread?.messages[thread.messages.length - 1]
    switch (action) {
      case 'next':
      case 'previous': {
        const step = action === 'next' ? 1 : -1
        // From the one about to show, if its bodies are still on their way.
        const current = selecting.current.id ?? thread?.id
        const from = visibleThreads.findIndex((t) => t.id === current)
        const next = visibleThreads[Math.min(Math.max(from + step, 0), visibleThreads.length - 1)]
        if (next) select(next.id)
        return
      }
      // The conversation is already on screen; Enter is how a draft is opened for editing.
      case 'open':
        if (thread) select(thread.id, false)
        return
      case 'archive':
      case 'trash':
        if (thread) moveShown(thread.id, action === 'archive' ? 'archive' : 'trash')
        return
      case 'reply':
      case 'replyAll':
        if (thread && last) openCompose(replyDraft(thread, last, action === 'reply' ? 'reply' : 'replyAll', accounts.map((item) => item.email)), { replyTo: thread.id, parentMessageId: last.id, title: 'Reply' })
        return
      case 'forward':
        if (thread && last && !forwarding) {
          setForwarding(true)
          if (last.attachments?.length) notify(`Preparing ${last.attachments.length === 1 ? last.attachments[0]!.name : `${last.attachments.length} attachments`}…`)
          void prepareForwardDraft(thread, last, getAttachment)
            .then((result) => {
              if (result.ok) openCompose(result.draft, { title: 'Forward' })
              else notify(`Couldn't prepare forward: ${result.error}`)
            })
            .catch((error) => notify(`Couldn't prepare forward: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => setForwarding(false))
        }
        return
      case 'compose':
        return openCompose()
      case 'makeTask':
        if (thread && thread.folder !== 'outbox') requestMakeTask(thread.id)
        return
      case 'star':
        if (thread) toggleStar(thread.id)
        return
      case 'unread':
        if (thread) setUnread(thread.id, !thread.unread)
        return
      // The field has no ref to focus, so it remounts with autoFocus, like the other fields here.
      case 'search':
        return setSearchFocus((n) => n + 1)
      case 'help':
        return setHelpOpen(true)
      case 'goInbox':
        return goView('inbox')
      case 'goStarred':
        return goView('starred')
      case 'goDrafts':
        return goView('drafts')
      case 'goSent':
        return goView('sent')
    }
  }

  // Command palette and window shortcuts.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchFocus, setSearchFocus] = useState(0)
  /** The `g` of `g i`, waiting for its letter. */
  const [prefix, setPrefix] = useState<Prefix>(null)
  useKeys((press, { typing }) => {
    // Leave Command-K to the focused composer so it can format the exact selection.
    if (!typing && isCmd(press, 'k')) {
      setPaletteOpen((open) => !open)
      return true
    }
    if (isCmd(press, 'j')) {
      setAssistantOpen((open) => !open)
      return true
    }
    const appKey = appKeyFor(press)
    if (appKey) {
      if (appKey === 'toggleSidebar') {
        if (app !== 'notes') toggleSidebar()
      } else switchApp(appKey)
      return true
    }
    if (isCmd(press, 'n')) {
      setSettingsOpen(false)
      setTool(null)
      openCompose()
      return true
    }
    if (press.key === 'escape' && paletteOpen) {
      setPaletteOpen(false)
      return true
    }
    if (press.key === 'escape' && (settingsOpen || tool)) {
      clearOpenRequest()
      setSettingsOpen(false)
      setTool(null)
      return true
    }
    // Single-key mail shortcuts: only with the mail list in charge of the keyboard. `overlaysOpen`
    // covers the palette, menus and the cheat sheet; `typing`, every text field including a reply.
    // The calendar takes its own keys first; of the mail keys, only ? and the `g` jumps apply there.
    const busy = settingsOpen || (!!tool && tool !== 'calendar') || !!compose || overlaysOpen()
    const shortcut = shortcutFor(press, { typing, busy, prefix, now: Date.now() }, bindings)
    if (!shortcut) return
    if (tool === 'calendar' && shortcut.action && shortcut.action !== 'help' && !shortcut.action.startsWith('go')) return
    setPrefix(shortcut.prefix)
    if (!shortcut.action) return
    runShortcut(shortcut.action)
    return true
  })
  const openPane = (next: 'cleanup' | 'rules' | 'notes' | 'calendar' | 'tasks' | 'settings') => {
    clearOpenRequest()
    setCompose(null)
    setSettingsOpen(next === 'settings')
    setSettingsFocus(null)
    setTool(next === 'settings' ? null : next)
  }
  // The scheduled clean-up; its "Review" opens Clean up on the Smart tab.
  useScheduledCleanup(() => {
    requestSmartView()
    openPane('cleanup')
  })
  /** Settings, scrolled to one section. */
  const openSettingsAt = (section: SettingsSection) => {
    openPane('settings')
    setSettingsFocus({ section, key: Date.now() })
  }
  /** Mail goes back to the mailbox that was open, leaving Settings and the mail tools. */
  const switchApp = (next: AppName) => {
    if (next !== 'mail') return openPane(next)
    clearOpenRequest()
    setSettingsOpen(false)
    setTool(null)
  }

  // jefi:// links (src/deeplink.ts). One for another account switches to it and waits for that
  // account's workspace, which takes it from the queue as it mounts.
  const linkTargets: LinkTargets = {
    showWindow: showMainWindow,
    inbox: (accountId) => {
      if (accountId && accountId !== account.id && accounts.some((a) => a.id === accountId)) return switchAccount(accountId)
      switchApp('mail')
      goView('inbox')
    },
    thread: (threadId) => {
      // Thread ids start with their account's id; an unknown one tries the account on screen.
      const prefix = threadId.slice(0, threadId.indexOf(':'))
      setTool(null)
      showThread(accounts.some((a) => a.id === prefix) ? prefix : account.id, threadId)
    },
    compose: (prefill) => {
      const wanted = prefill.account?.toLowerCase()
      const owner = wanted ? accounts.find((a) => a.id.toLowerCase() === wanted || a.email.toLowerCase() === wanted) : undefined
      if (owner && owner.id !== account.id) {
        deferJefiRoute({ kind: 'compose', prefill })
        return switchAccount(owner.id)
      }
      setTool(null)
      openCompose({ to: prefill.to, cc: prefill.cc, bcc: prefill.bcc, subject: prefill.subject, body: prefill.body })
    },
    search: (text) => {
      switchApp('mail')
      setCompose(null)
      setQuery(text)
    },
    calendar: (request) => requestCalendar(request),
    event: (eventId, start) => {
      if (start !== undefined) return void dispatchEventOpen({ eventId, occurrenceStart: start })
      void getEvent(eventId).then((event) => {
        if (event) showEvent(event)
        else toast.error("Couldn't open that event", { description: 'It is no longer in your calendar.' })
      })
    },
    editEvent: (prefill) => openEventEditor(prefill),
    quickAdd: (text) => {
      // "Task: …" is a task here too, as in the menu bar; a link only prefills it, never saves.
      const task = quickAddTask(text)
      if (task !== null) return openTaskComposer(task ? parseTaskText(task, Date.now()) : {})
      openEventEditor(quickAddPrefill(text, Date.now(), userTimeZone()))
    },
    notes: (noteId) => (noteId ? requestNotes({ noteId }) : openPane('notes')),
    newNote: (prefill) => requestNotes({ create: true, ...prefill }),
    settings: (section) => (section ? openSettingsAt(section) : openPane('settings')),
  }
  const linkTargetsRef = useRef(linkTargets)
  linkTargetsRef.current = linkTargets
  useEffect(() => subscribeJefiLinks((route) => routeJefiLink(route, linkTargetsRef.current)), [])

  const commands: Command[] = paletteOpen
    ? [
        { id: 'compose', label: 'New message', group: 'Actions', icon: 'pencil', hint: hintFor('compose', bindings), keywords: 'compose write email', run: () => openCompose() },
        { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Actions', icon: 'code', hint: hintFor('help', bindings), keywords: 'keys cheat sheet help', run: () => setHelpOpen(true) },
        ...(notes ? [{ id: 'whats-new', label: 'What’s new in Jefi', group: 'Actions', icon: 'sparkles', keywords: 'whats new release notes update changes version', run: () => setWhatsNewOpen(true) } as Command] : []),
        { id: 'assistant', label: assistantOpen ? 'Hide the assistant' : 'Ask the assistant', group: 'Actions', icon: 'sparkles', hint: '⌘J', keywords: 'ai claude chat help write', run: () => setAssistantOpen((open) => !open) },
        { id: 'sync', label: 'Sync now', group: 'Actions', icon: 'refresh', keywords: 'refresh fetch check mail', run: syncNow },
        {
          id: 'read-all',
          label: 'Mark Inbox as read',
          group: 'Actions',
          icon: 'mailOpen',
          run: () => bulk(threads.filter((t) => t.folder === 'inbox' && t.unread).map((t) => t.id), { unread: false }),
        },
        { id: 'theme', label: prefs.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', group: 'Actions', icon: prefs.theme === 'dark' ? 'sun' : 'moon', keywords: 'appearance mode', run: () => update({ theme: prefs.theme === 'dark' ? 'light' : 'dark' }) },
        ...(['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'archive', 'spam', 'trash', 'outbox'] as const).map(
          (id): Command => ({ id: `go-${id}`, label: `Go to ${FOLDER_NAMES[id]}`, group: 'Mailboxes', icon: 'inbox', hint: GO_HINTS[id], run: () => goView(id) }),
        ),
        ...(screenerOn ? [{ id: 'go-screener', label: 'Go to Screener', group: 'Mailboxes', icon: 'userPlus', run: () => goView('screener') } as Command] : []),
        ...labels.map((l): Command => ({ id: `label-${l.id}`, label: `Go to ${l.label}`, group: 'Labels', icon: 'tag', run: () => goView(`label:${l.id}`) })),
        ...folders.map((f): Command => ({ id: `folder-${f.path}`, label: `Go to ${f.name}`, group: 'Folders', icon: 'folder', run: () => goView(`folder:${f.path}`) })),
        { id: 'mail', label: 'Mail', group: 'Tools', icon: 'mail', hint: '⌘1', keywords: 'inbox mailboxes', run: () => switchApp('mail') },
        { id: 'notes', label: 'Notes', group: 'Tools', icon: 'file', hint: '⌘3', keywords: 'notebook jot memo', run: () => openPane('notes') },
        { id: 'tasks', label: 'Tasks', group: 'Tools', icon: 'circleCheck', hint: '⌘4', keywords: 'todo to-do reminders action items checklist', run: () => openPane('tasks') },
        { id: 'new-task', label: 'New task', group: 'Actions', icon: 'circleCheck', keywords: 'todo to-do reminder action item create', run: () => openTaskComposer() },
        { id: 'toggle-sidebar', label: sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar', group: 'Actions', icon: 'sidebar', hint: '⌘\\', keywords: 'collapse expand panel', run: toggleSidebar },
        { id: 'new-note', label: 'New note', group: 'Actions', icon: 'file', hint: hintFor('newNote', bindings), keywords: 'notes jot memo', run: () => requestNotes({ create: true }) },
        { id: 'calendar', label: 'Calendar', group: 'Tools', icon: 'calendar', hint: '⌘2', keywords: 'events schedule agenda meetings', run: () => openPane('calendar') },
        { id: 'new-event', label: 'New event', group: 'Actions', icon: 'calendarPlus', keywords: 'calendar meeting schedule appointment', run: () => openEventEditor() },
        { id: 'cleanup', label: 'Clean up mailbox', group: 'Tools', icon: 'broom', keywords: 'scrub unsubscribe newsletters delete old large junk smart ai', run: () => openPane('cleanup') },
        { id: 'rules', label: 'Rules', group: 'Tools', icon: 'sliders', keywords: 'filters automate', run: () => openPane('rules') },
        { id: 'settings', label: 'Settings', group: 'Tools', icon: 'settings', keywords: 'preferences accounts', run: () => openPane('settings') },
        { id: 'report-bug', label: 'Report a bug', group: 'Actions', icon: 'alertCircle', keywords: 'feedback problem issue broken crash support', run: () => openFeedback('bug') },
        { id: 'request-feature', label: 'Request a feature', group: 'Actions', icon: 'sparkles', keywords: 'feedback idea suggestion wish', run: () => openFeedback('feature') },
        ...threads
          .filter((t) => t.folder !== 'drafts' && t.folder !== 'trash')
          .slice(0, 400)
          .map((t): Command => ({ id: `open-${t.id}`, label: t.subject || '(no subject)', group: 'Mail', icon: 'mail', hint: t.sender, keywords: t.sender, run: () => { goView(t.folder === 'outbox' ? 'outbox' : t.screened ? 'screener' : t.onlyInFolders ? `folder:${t.folders?.[0]}` : t.folder); select(t.id, false) } })),
      ]
    : []

  const travel = (direction: 'back' | 'forward') => {
    const stack = history[direction]
    const entry = stack[stack.length - 1]
    if (!entry || !thread) return
    clearOpenRequest()
    supersedeSelect()
    const other = direction === 'back' ? 'forward' : 'back'
    setHistory((h) => ({ ...h, [direction]: stack.slice(0, -1), [other]: [...h[other], { view, id: thread.id }] }))
    if (entry.view !== view) {
      setView(entry.view)
      setTab('All')
    }
    setCompose(null)
    setActive(entry.id)
  }

  // Toast and native banner actions reveal an exact thread. The resolver first checks the current
  // snapshot, then asks the engine directly so cold-start routes need not wait for a list publish.
  const revealRequestedThread = (target: MailThread | null) => {
    clearOpenRequest()
    supersedeSelect()
    if (!target) {
      // Banners and jefi://thread links both land here, so the wording fits either.
      toast.error("Couldn't open that conversation", { description: 'It is no longer in your mailbox.' })
      return
    }
    setSettingsOpen(false)
    setCleanupOpen(false)
    setView(target.folder)
    setTab('All')
    setQuery('')
    setFilters(NO_FILTERS)
    if (target.folder === 'drafts') openCompose(target.draft ?? { subject: target.subject }, { draftId: target.id, title: 'Draft' })
    else {
      setCompose(null)
      setActive(target.id)
      if (target.unread) setUnread(target.id, false)
    }
  }

  // The draft an autosave just made, by composer: a Send or Discard that comes before that state
  // update is drawn must still see it, or the send leaves the autosaved copy behind in Drafts.
  const savedDraftIds = useRef(new Map<number, string>())
  const draftIdOf = (state: ComposeState) => savedDraftIds.current.get(state.key) ?? state.draftId

  // One identity each for the memoized rail and sidebar, so the store publishes and selection changes
  // that re-render the workspace don't re-render (and resend every style of) the whole shell.
  const onAppStable = useStableCallback(switchApp)
  const onViewStable = useStableCallback(goView)
  const toggleAssistant = useStableCallback(() => setAssistantOpen((open) => !open))
  const openPalette = useStableCallback(() => setPaletteOpen(true))
  // Only a real section name opens a page; anything else (a click event handed through) reopens the last one.
  const openSettingsPane = useStableCallback((section?: SettingsSection) => (typeof section === 'string' && SETTINGS_SECTIONS.includes(section) ? openSettingsAt(section) : openPane('settings')))
  const openTool = useStableCallback((next: Tool) => openPane(next))
  const composeNew = useStableCallback(() => openCompose())
  const addAccount = useStableCallback(() => onAddAccount())
  const toggleSidebarStable = useStableCallback(toggleSidebar)

  // The list and the reader are memoized: with these they skip the workspace renders that don't
  // change what they show (a publish of mail elsewhere, the view query catching up).
  const onTabStable = useStableCallback((next: Tab) => {
    clearOpenRequest()
    setTab(next)
  })
  const onQueryStable = useStableCallback((next: string) => {
    clearOpenRequest()
    setQuery(next)
  })
  const onFiltersStable = useStableCallback((next: ListFilters) => {
    clearOpenRequest()
    setFilters(next)
  })
  const onSelectStable = useStableCallback((id: string) => select(id))
  const travelBack = useStableCallback(() => travel('back'))
  const travelForward = useStableCallback(() => travel('forward'))
  const showAll = useStableCallback(() => {
    clearOpenRequest()
    setTab('All')
  })
  const clearSearch = useStableCallback(() => {
    clearOpenRequest()
    setQuery('')
    setFilters(NO_FILTERS)
  })
  const emptyView = useMemo(() => (searching ? undefined : { name: title, loading: page.loading, hasMore: page.hasMore }), [searching, title, page.loading, page.hasMore])
  const emptyKind = tab !== 'All' && source.length > 0 ? 'all' : query || filters !== NO_FILTERS ? 'clear' : null
  const emptyAction = useMemo(
    () => (emptyKind === 'all' ? { label: 'Show all conversations', run: showAll } : emptyKind === 'clear' ? { label: 'Clear search and filters', run: clearSearch } : undefined),
    [emptyKind],
  )
  const moveFromReader = useStableCallback((id: string, folder: FolderId) => moveShown(id, folder))
  const composeFromReader = useStableCallback((initial: DraftFields, replyTo?: string, parentMessageId?: string) =>
    openCompose(initial, { replyTo, parentMessageId, title: replyTo ? 'Reply' : 'Forward' }),
  )

  const composeView = compose ? (
    <ComposePane
      key={compose.key}
      initial={compose.initial}
      title={compose.title}
      onClose={() => setCompose(null)}
      onDiscard={(mail) => {
        // The trash sits next to ×: one click away from losing a long message, so it can be undone.
        const { replyTo, parentMessageId, title } = compose
        const hasContent = mail.to.length + mail.cc.length + mail.bcc.length > 0 || mail.subject.trim() !== '' || mail.body.trim() !== '' || Boolean(mail.attachments?.length)
        const restore = () => openCompose(mail, { draftId: saveDraft(mail, undefined, true), replyTo, parentMessageId, title })
        const draftId = draftIdOf(compose)
        if (draftId) deleteForever(draftId, hasContent ? restore : undefined)
        else notify('Message discarded', hasContent ? restore : undefined)
        setCompose(null)
      }}
      onAutosave={(mail) => {
        const id = saveDraft(mail, draftIdOf(compose), true)
        savedDraftIds.current.set(compose.key, id)
        // The composer also saves as it unmounts, possibly because another one is replacing it.
        if (id !== compose.draftId) setCompose((current) => (current?.key === compose.key ? { ...current, draftId: id } : current))
      }}
      onSaveDraft={(mail) => {
        const id = saveDraft(mail, draftIdOf(compose))
        setCompose(null)
        setView('drafts')
        setTab('All')
        setActive(id)
      }}
      onSend={(mail, sendAt) => {
        setCompose(null)
        // A reply from another account than the conversation's goes out as a message from that one,
        // still threaded by its headers (the engine finds the parent in the conversation's account).
        // The conversation's own account, which in All Inboxes needn't be the one selected.
        const owner = compose.replyTo ? accountOf(compose.replyTo).id : account.id
        if (!sendAt && compose.replyTo && threads.some((t) => t.id === compose.replyTo) && (!mail.from || mail.from === owner)) {
          const { replyTo, parentMessageId } = compose
          const sent = reply(replyTo, { body: mail.body, to: mail.to, cc: mail.cc, bcc: mail.bcc, subject: mail.subject, attachments: mail.attachments, parentMessageId }, {
            draftId: draftIdOf(compose),
            // Undo reopens the reply as it was sent, saved as a draft again so closing it can't lose it.
            onUndo: () => openCompose(mail, { draftId: saveDraft(mail, undefined, true), replyTo, parentMessageId, title: 'Reply' }),
          })
          // Not sent (the conversation is gone): keep it as a draft rather than lose it with the composer.
          if (!sent) saveDraft(mail, draftIdOf(compose), true)
          setActive(compose.replyTo)
          return
        }
        // Stay put like Gmail: the send toast offers Undo, then View once delivered.
        send(mail, draftIdOf(compose), sendAt)
      }}
    />
  ) : null

  return (
    <>
      {openRequest ? (
        <NotificationOpenResolver key={openRequest} request={openRequest} threads={threads} load={fetchThread} onResolved={revealRequestedThread} />
      ) : null}
      <AppRail
        app={app}
        settingsOpen={settingsOpen}
        onApp={onAppStable}
        assistantOpen={assistantOpen}
        onAssistant={toggleAssistant}
        onPalette={openPalette}
        onSettings={openSettingsPane}
        onAddAccount={addAccount}
        collapsed={sidebarCollapsed}
        canCollapse={app !== 'notes'}
        onToggleCollapsed={toggleSidebarStable}
      />
      {/* Notes has no context column: its own list (search, pinned first) already is its navigation. */}
      {sidebarCollapsed || app === 'notes' ? null : (
        <>
          {settingsOpen ? (
            // Settings brings its own navigation, the way Calendar and Tasks do.
            <ContextColumn testId="settings-context">
              <SettingsSidebar />
            </ContextColumn>
          ) : app === 'calendar' ? (
            <ContextColumn testId="calendar-context">
              <CalendarSidebar embedded />
            </ContextColumn>
          ) : app === 'tasks' ? (
            <ContextColumn testId="tasks-context">
              <TasksSidebar />
            </ContextColumn>
          ) : (
            <MailSidebar
              view={view}
              onView={onViewStable}
              settingsOpen={settingsOpen}
              onSettings={openSettingsPane}
              tool={tool}
              onTool={openTool}
              onCompose={composeNew}
              onAddAccount={addAccount}
            />
          )}
          <PaneResizer pane="sidebar" />
        </>
      )}
      {settingsOpen ? (
        <SettingsPane onAddAccount={onAddAccount} focus={settingsFocus} nav={sidebarCollapsed || app === 'notes'} />
      ) : tool === 'cleanup' ? (
        <CleanupPane />
      ) : tool === 'rules' ? (
        <RulesPane />
      ) : tool === 'notes' ? (
        <NotesPane request={noteRequest} />
      ) : tool === 'tasks' ? (
        <TasksPane request={taskRequest} onOpenEvent={(eventId) => linkTargets.event(eventId)} />
      ) : tool === 'calendar' ? (
        <div testId="calendar-pane" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'row' }}>
          <CalendarView />
        </div>
      ) : (
        <>
          <InboxList
            title={title}
            threads={listed}
            active={compose ? (compose.draftId ?? null) : (thread?.id ?? null)}
            tab={tab}
            query={query}
            filters={filters}
            onTab={onTabStable}
            onQuery={onQueryStable}
            searchFocus={searchFocus}
            hasOlder={unified ? false : page.order ? page.hasMore : hasOlder}
            showAccounts={unified}
            onLoadOlder={loadOlder}
            emptyView={emptyView}
            onFilters={onFiltersStable}
            onSelect={onSelectStable}
            onBack={history.back.length ? travelBack : undefined}
            onForward={history.forward.length ? travelForward : undefined}
            bulkShortcuts={bulkShortcuts}
            emptyAction={emptyAction}
          />
          <PaneResizer pane="list" />
          {composeView ??
            (thread ? (
              <ReadingPane thread={thread} onCompose={composeFromReader} onMove={moveFromReader} />
            ) : (
              <div testId="reading-empty" style={{ flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: C.reading, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <text style={{ fontSize: 13.5, color: C.muted, fontFamily: FONT }}>No conversation selected</text>
              </div>
            ))}
        </>
      )}
      {assistantOpen && prefs.assistantPinned ? <PaneResizer pane="assistant" edge="left" /> : null}
      {assistantOpen ? (
        <AssistantPanel
          onClose={() => setAssistantOpen(false)}
          onOpenThread={(id) => {
            setSettingsOpen(false)
            setTool(null)
            select(id)
          }}
          onCompose={(initial, extra) => {
            setTool(null)
            openCompose(initial, extra)
          }}
          onOpenSettings={() => openSettingsAt('ai')}
          view={title}
          openThread={compose ? null : (thread ?? null)}
        />
      ) : null}
      {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
      {helpOpen ? <ShortcutSheet onClose={() => setHelpOpen(false)} /> : null}
      {/* Shown once per launch when a key is needed; "Keep reading" puts it away until next time. */}
      {whatsNewOpen && notes ? <WhatsNewSheet notes={notes} onClose={closeWhatsNew} /> : null}
      {promptVariant && !whatsNewOpen ? <NotificationPermissionSheet variant={promptVariant} onClose={closePrompt} /> : null}
    </>
  )
}

/** First run, or after the last account is removed: nothing to show but a way in. */
function NoAccounts({ onAdd }: { onAdd: () => void }) {
  const { C } = useSettings()
  return (
    <div
      testId="no-accounts"
      style={{ flexGrow: 1, height: '100%', backgroundColor: C.reading, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}
    >
      <JefiMark size={56} color={C.text} />
      <text style={{ fontSize: 19, fontWeight: 600, color: C.text, fontFamily: FONT }}>Welcome to Jefi Mail</text>
      <text style={{ fontSize: 13.5, color: C.muted, fontFamily: FONT }}>Connect a mailbox to get started.</text>
      <div style={{ paddingTop: 6 }}>
        <Button label="Add an account" variant="primary" onClick={onAdd} testId="empty-add-account" />
      </div>
    </div>
  )
}

/**
 * The Dock badge: unread Inbox conversations across every account (screened mail doesn't count, as
 * it hasn't been let in yet). Only the real app window owns the Dock icon, and the badge is written
 * when the number changes, not on every render.
 */
function DockBadge() {
  countRender('DockBadge')
  const { inboxUnread } = useMailCounts()
  const unread = Object.values(inboxUnread).reduce((total, count) => total + count, 0)
  useEffect(() => {
    if (isEntryPoint) applyDockBadge(unread > 0 ? String(unread) : '')
  }, [unread])
  return null
}

function Shell() {
  const { C, settings } = useSettings()
  countRender('Shell')
  const { account, hasAccounts } = useMailSelector((store) => ({ account: store.account, hasAccounts: store.hasAccounts }))
  const { switchAccount, sendEventInvites } = useMailActions()
  const [wizardOpen, setWizardOpen] = useState(false)
  // The calendar editor offers "Save and send invites" once a sender is registered (lume-fwl.8).
  useEffect(() => {
    registerInviteSender(async (event, method) => {
      if (!(await sendEventInvites(event.id, method))) throw new Error('The invitations were not sent')
    })
    return () => registerInviteSender(null)
  }, [sendEventInvites])
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        backgroundColor: C.list,
        fontFamily: FONT,
        color: C.text,
        position: 'relative',
      }}
    >
      {/* Remount per account so selection, history and drafts-in-progress don't leak across mailboxes. */}
      {hasAccounts ? <Workspace key={account.id} onAddAccount={() => setWizardOpen(true)} wizardOpen={wizardOpen} /> : <NoAccounts onAdd={() => setWizardOpen(true)} />}
      {settings.onboarded ? null : <Onboarding onFinish={() => {}} />}
      <DockBadge />
      <MenuBarHost enabled={isEntryPoint} />
      {hasAccounts ? <EventEditorHost /> : null}
      {hasAccounts ? <TaskComposerHost /> : null}
      <FeedbackHost />
      <Toaster />
      <ContextMenuHost />
      {wizardOpen ? (
        <AccountWizard
          onClose={() => setWizardOpen(false)}
          onDone={(id) => {
            setWizardOpen(false)
            switchAccount(id)
          }}
        />
      ) : null}
    </div>
  )
}

export function MailApp() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  // The window's blur is fixed when it opens, so the palette keeps the style it launched with.
  const [windowStyle] = useState(() => settings.style)
  const C = palette(settings.theme, settings.accent, windowStyle)
  const update = (patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch }))
  useEffect(() => saveSettings(settings), [settings])

  // The Dock icon's tile follows the accent. Only the real app window owns the Dock icon.
  useEffect(() => {
    if (!isEntryPoint) return
    const timer = setTimeout(() => applyDockIcon(dockIconPath(settings.accent)), 300)
    return () => clearTimeout(timer)
  }, [settings.accent])
  // The Dock tile can reset when the Dock icon comes back after the window was closed without it.
  useEffect(() => (isEntryPoint ? onMainWindowShown(() => applyDockIcon(dockIconPath(settings.accent))) : undefined), [settings.accent])

  // Closing the window hides it while the menu bar item is on, so sync and banners carry on.
  useEffect(() => {
    if (isEntryPoint) configureLifecycle(closePlan(settings))
  }, [settings.menuBar, settings.hideDockWhenClosed])

  return (
    <SettingsContext.Provider value={{ settings, update, C, windowStyle }}>
      <MailProvider>
        <ContextMenuProvider>
          <Shell />
        </ContextMenuProvider>
      </MailProvider>
    </SettingsContext.Provider>
  )
}

const isEntryPoint =
  typeof Bun !== 'undefined'
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof process !== 'undefined' && process.argv[1]?.endsWith('mail.tsx')

// One Jefi per mailbox: a second one (the installed app beside a dev build, say) brings the first
// forward and closes before it opens a window or touches mail.db.
const mailbox = isEntryPoint ? configDir() : null
// Before anything reads or writes it: mail, accounts and settings are this user's alone (an older
// build left the folder 0755 and its files 0644).
if (mailbox) hardenDataDir(mailbox)
if (mailbox && !lockMailbox(mailbox, { checkUnlocked: !process.env.JEFI_CONFIG_DIR })) process.exit(0)

if (isEntryPoint) {
  applyMacCpuThrottleFromEnv()
  // Before the first frame: a jefi:// link that launched Jefi arrives as soon as AppKit runs.
  listenForLinks()
  const initial = loadSettings()
  // JEFI_WINDOW=1040x620 opens at another size, for screenshots of small windows.
  const [width, height] = (process.env.JEFI_WINDOW ?? '').split('x').map(Number)
  render(<MailApp />, {
    // Retained focus belongs to an input or explicit control and suppresses global letter
    // shortcuts. Native inline-link focus is handled through its own key action first.
    onKeyDown: (event, renderer) => {
      if (event.key === 'tab' && !event.modifiers?.cmd && !event.modifiers?.ctrl && !event.modifiers?.alt) {
        if (event.modifiers?.shift) renderer.focusPrevious?.()
        else renderer.focusNext?.()
        return
      }
      if (copySelectionOnKey(event, renderer)) return
      dispatchKey(event, { typing: renderer.getFocusedElementId?.() != null })
    },
    title: APP_NAME,
    appName: APP_NAME,
    // Screenshot scripts open smaller windows (JEFI_WINDOW=WxH, or JEFI_WINDOW_WIDTH) to check layouts.
    width: width || Number(process.env.JEFI_WINDOW_WIDTH) || 1440,
    height: height || 900,
    minWidth: 1040,
    minHeight: 620,
    titlebarTransparent: true,
    // Liquid Glass opens a see-through window and puts a native blur under it (see window-glass.ts).
    windowBackground: initial.style === 'glass' ? 'transparent' : 'opaque',
    trafficLightX: TRAFFIC_LIGHT_X,
    trafficLightY: 18,
    focus: process.env.GPUIX_BACKGROUND !== '1',
  })
  if (initial.style === 'glass') installWindowGlass()
}
