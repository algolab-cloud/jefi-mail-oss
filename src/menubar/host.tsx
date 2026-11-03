import { useEffect, useMemo, useRef } from 'react'
import { useSettings } from '../theme'
import { useMailActions, useMailCounts } from '../store'
import { useEvents, useTasks } from '../local-data'
import { useCalendarMap, useNow, useWeekInfo } from '../calendar/hooks'
import { startOfDay } from '../calendar/dates'
import { timeText } from '../calendar/format'
import { openEventEditor, requestCalendar, showEvent } from '../calendar/state'
import { requestNotes } from '../notes'
import { openTask, openTaskComposer, requestTasks } from '../tasks'
import { dueText, groupTasks, parseTaskText } from '../tasks/model'
import { dispatchEventOpen, dispatchNotificationOpen } from '../native/notify'
import { copySignInCode } from '../sign-in-pill'
import { markRecentSeen } from '../menubar-data'
import { quitApp, showMainWindow } from '../native/app-lifecycle'
import { createStatusItem, type StatusItem } from '../native/status-item'
import { callPanel, closePanel, configurePanel, glassAvailable, panelShown, setPanelHeight, showPanel } from '../native/menubar-popover'
import { userTimeZone } from '../reader-calendar/suggest'
import { buildMenuBarModel, menuBarTitle, modelRange, parsePanelMessage, quickAddPrefill, quickAddTask, type MenuBarTask, type PanelMessage } from './model'
import { menuBarBody, menuBarHtml, type PanelTheme } from './panel-html'
import { useMenuBarFeeds } from './feeds'
import { requestWorkspace } from './requests'
import { installMenuBarDebug } from './debug'

// ---------------------------------------------------------------------------
// The menu bar item and its panel, mounted once in the app shell like DockBadge. It gathers the
// model from the app's own hooks, keeps the item's title current, and turns the panel's messages
// into the routes the rest of the app already has (notification opens, calendar, notes and tasks
// requests). Ticking a task off and adding one by quick add happen in place, with the panel open.
// ---------------------------------------------------------------------------

const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')

export function MenuBarHost({ enabled }: { enabled: boolean }) {
  const { settings, C } = useSettings()
  const on = enabled && settings.menuBar
  const { inboxUnread } = useMailCounts()
  const unread = Object.values(inboxUnread).reduce((total, count) => total + count, 0)
  const now = useNow()
  const { firstDay } = useWeekInfo()
  const day = startOfDay(now)
  const range = useMemo(() => modelRange(now, firstDay), [day, firstDay])
  const occurrences = useEvents(range.from, range.to)
  const calendars = useCalendarMap()
  const feeds = useMenuBarFeeds()
  const { saveTask, setTaskDone } = useMailActions()
  const openTasks = useTasks()
  const tasks = useMemo(
    () =>
      groupTasks(openTasks ?? [], now)
        .filter((g) => g.key === 'overdue' || g.key === 'today')
        // Under "Tasks" in a panel headed with today's date, a time says enough for today's.
        .flatMap((g) => g.tasks.map((t): MenuBarTask => ({ id: t.id, title: t.title, due: g.key === 'today' && !t.dueAllDay ? timeText(t.dueAt!, true) : dueText(t, now), overdue: g.key === 'overdue' }))),
    [openTasks, now],
  )
  const model = useMemo(
    () =>
      buildMenuBarModel({
        now,
        unread,
        occurrences: occurrences ?? [],
        colorOf: (id) => calendars.get(id)?.color ?? C.accent,
        firstDay,
        recent: feeds.recent,
        pendingInvites: feeds.pendingInvites,
        tasks,
      }),
    [now, unread, occurrences, calendars, firstDay, feeds.recent, feeds.pendingInvites, tasks, C.accent],
  )
  // Only the accent is Jefi's: the panel otherwise follows the system appearance, like other menu bar extras.
  const theme: PanelTheme = useMemo(() => ({ accent: C.accent, glass: glassAvailable() }), [C.accent])
  const title = menuBarTitle({ mode: settings.menuBarTitle, unread, events: model.upNext ? [model.upNext, ...model.today] : model.today, now })

  // The latest of everything for the AppKit callbacks, which outlive renders.
  const latest = useRef({ model, theme, occurrences })
  latest.current = { model, theme, occurrences }
  const item = useRef<StatusItem | null>(null)

  const open = () => {
    const button = item.current?.button
    if (!button) return
    if (panelShown()) return closePanel()
    const { model, theme } = latest.current
    showPanel(button, menuBarHtml(model, theme, nonce()))
    markRecentSeen()
  }

  const act = (message: PanelMessage) => {
    if (message.type === 'height') return setPanelHeight(Number(message.arg) || 0)
    // In place: the panel refreshes with the model (jefiReplace) and stays open.
    if (message.type === 'toggle-task') return void setTaskDone(message.arg, true)
    const task = message.type === 'quick-add' ? quickAddTask(message.arg) : null
    if (task) return void saveTask({ ...parseTaskText(task, Date.now()), origin: 'menubar' })
    closePanel()
    // "Task:" and nothing else: the task composer, to write it there.
    if (task === '') {
      showMainWindow()
      return openTaskComposer({ origin: 'menubar' })
    }
    if (message.type === 'quit') return quitApp()
    showMainWindow()
    const { model, occurrences } = latest.current
    switch (message.type) {
      case 'open-event': {
        const occurrence = occurrences?.find((o) => o.key === message.arg)
        if (occurrence) showEvent(occurrence)
        return
      }
      case 'open-day': {
        const date = Number(message.arg)
        if (Number.isFinite(date)) requestCalendar({ date })
        return
      }
      case 'open-invite': {
        const invite = model.pendingInvites.find((i) => i.eventId === message.arg)
        if (invite) showEvent({ id: invite.eventId, startAt: invite.start, allDay: invite.allDay, recurrence: null })
        return
      }
      case 'copy-code': {
        const code = model.codes.find((c) => c.id === message.arg)?.code
        if (code) copySignInCode(code)
        return
      }
      case 'open-recent': {
        const route = model.recent.find((r) => r.id === message.arg)?.route
        if (route?.type === 'thread') dispatchNotificationOpen({ accountId: route.accountId, threadId: route.threadId })
        else if (route) dispatchEventOpen({ eventId: route.eventId, occurrenceStart: route.occurrenceStart })
        return
      }
      case 'compose':
      case 'settings':
        return requestWorkspace(message.type)
      case 'new-event':
        return openEventEditor()
      case 'new-note':
        return requestNotes({ create: true })
      case 'open-task':
        return openTask(message.arg)
      case 'open-tasks':
        return requestTasks({ list: true })
      case 'new-task':
        return openTaskComposer()
      case 'quick-add':
        return openEventEditor(quickAddPrefill(message.arg, Date.now(), userTimeZone()))
    }
  }
  const actRef = useRef(act)
  actRef.current = act
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!on) return
    item.current = createStatusItem(() => openRef.current())
    configurePanel({
      onMessage: (raw) => {
        const message = parsePanelMessage(raw)
        if (message) actRef.current(message)
      },
      onClosed: () => {},
    })
    const stopDebug = installMenuBarDebug({ click: () => item.current?.click(), itemFrame: () => item.current?.screenFrame() ?? null, snapshot: (path) => void item.current?.snapshot(path), act: (message) => actRef.current(message) })
    return () => {
      stopDebug()
      closePanel()
      item.current?.remove()
      item.current = null
    }
  }, [on])

  useEffect(() => {
    if (on) item.current?.setTitle(title)
  }, [on, title])

  // An open panel follows the data (new mail, a saved event) without reloading its quick-add field.
  useEffect(() => {
    if (on && panelShown()) callPanel('jefiReplace', menuBarBody(model, theme))
  }, [on, model, theme])

  return null
}
