import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PublicInstance } from '@gpuix/react'
import { useContextMenu, type ContextEvent, type ContextItem } from '../context-menu'
import { useNow } from '../calendar/hooks'
import type { Task, TaskPriority } from '../engine'
import { Icon, IconButton, type IconName } from '../icons'
import { useKeys } from '../keys'
import { useTaskLabels, useTaskProjects, useTasks } from '../local-data'
import { overlaysOpen } from '../overlays'
import { useMailActions } from '../store'
import { FONT, TOPBAR_HEIGHT, mixHex, useSettings } from '../theme'
import { toast } from '../toast'
import { useStableCallback } from '../stable-callback'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui'
import { useOpenLink } from '../notes/links'
import { linkView, liveFirst, searchQuery } from '../notes/model'
import { openTaskComposer, type ComposerPrefill } from './composer'
import {
  NO_FILTER,
  PRIORITIES,
  STATUSES,
  VIEWS,
  dueText,
  filterCount,
  filterTasks,
  groupBy,
  isClosed,
  isOverdue,
  quickAddInput,
  viewPrefill,
  type TaskView,
  restorableTask,
  stepIndex,
  taskKey,
  viewCount,
  viewLabel,
  viewQuery,
  type GroupBy,
  type ListGroup,
  type OrderBy,
  type TaskFilter,
} from './model'
import type { TaskRequest } from './open'
import { LabelChip, PriorityIcon, PriorityPicker, ProjectGlyph, StatusPicker, toneColor } from './pickers'
import { TaskSheet } from './sheet'
import { getTasksState, setTasksState, useTasksState, type TasksLayout } from './state'
import { useRevealRow, useRowWindow } from '../virtual-window'

// ---------------------------------------------------------------------------
// The tasks view, like Linear: the view's header with New task, a toolbar with Filter and Display
// (list or board, grouping, ordering), then the tasks as a full-width table grouped by status (or
// a board of columns), and the selected task in a wide sheet sliding over from the right.
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 150

export function TasksPane({ request, onOpenEvent }: { request?: (TaskRequest & { key: number }) | null; onOpenEvent?: (eventId: string) => void }) {
  const { C } = useSettings()
  // Stable, so the effects below can use it without listing it.
  const { saveTask, setTaskDone, deleteTask } = useMailActions()
  const now = useNow()
  const { view, layout, groupBy: by, orderBy, filter, open } = useTasksState((s) => s)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchQuery(input)), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input])
  const projects = useTaskProjects() ?? []
  const labels = useTaskLabels() ?? []
  const { query: engineQuery, keep } = viewQuery(view, now)
  const fetched = useTasks({ ...engineQuery, search: query || undefined })
  // Every task, for the sheet: it stays open on a task the view no longer lists (just completed).
  const everything = useTasks({ status: 'all' })
  const [addKey, setAddKey] = useState(0)
  const [highlight, setHighlight] = useState<string | null>(null)

  // Memoized: a search keystroke or J/K re-renders the pane, and sorting thousands of tasks each time adds up.
  const tasks = useMemo(() => filterTasks(keep ? (fetched ?? []).filter(keep) : (fetched ?? []), filter), [fetched, filter, view, now])
  // A board keeps its status (or priority) columns even when empty.
  const groups = useMemo(() => groupBy(tasks, by, orderBy, { now, projects, empty: layout === 'board' && (by === 'status' || by === 'priority') }), [tasks, by, orderBy, now, projects, layout])
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups])
  const sheetTask = open ? (everything?.find((t) => t.id === open) ?? tasks.find((t) => t.id === open) ?? null) : null

  useEffect(() => {
    if (!request) return
    setInput('')
    setQuery('')
    if ('taskId' in request) setTasksState({ open: request.taskId })
    else setAddKey((n) => n + 1)
  }, [request?.key])

  // Stable, so the memoized rows don't all re-render when the pane does (a search keystroke, J/K).
  const openTask = useStableCallback((id: string | null) => {
    setTasksState({ open: id })
    if (id) setHighlight(id)
  })
  // Where the current task was last seen in the list, so J/K step on from there once it leaves the
  // view (completed with its sheet open) instead of jumping back to the top.
  const current = open ?? highlight
  const lastSeen = useRef<{ id: string; at: number } | null>(null)
  useEffect(() => {
    const at = current ? flat.findIndex((t) => t.id === current) : -1
    if (current && at >= 0) lastSeen.current = { id: current, at }
  }, [flat, current])
  const step = (by: 1 | -1) => {
    const at = flat.findIndex((t) => t.id === current)
    const seen = lastSeen.current
    const next = flat[stepIndex(flat.length, at, by, seen && seen.id === current ? seen.at : null)]
    if (!next) return
    setHighlight(next.id)
    if (open) setTasksState({ open: next.id })
  }

  const add = async (text: string) => {
    const input = quickAddInput(text, view, Date.now())
    if (!input.title) return false
    return !!(await saveTask(input))
  }

  const remove = async (task: Task) => {
    if (!(await deleteTask(task.id))) return
    if (getTasksState().open === task.id) setTasksState({ open: null })
    toast(`Deleted ${taskKey(task)}`, {
      description: task.title,
      action: { label: 'Undo', onClick: () => void saveTask(restorableTask(task)) },
    })
  }

  const complete = async (task: Task) => {
    const saved = await setTaskDone(task.id, !isClosed(task.status))
    if (saved && isClosed(saved.status)) toast(`Completed ${taskKey(task)}`, { description: task.title, action: { label: 'Undo', onClick: () => void saveTask({ id: task.id, status: task.status }) } })
  }

  // Right-click on a row or card: the sheet's everyday actions without opening it.
  const contextMenu = useContextMenu()
  const taskMenu = useStableCallback((task: Task, event: ContextEvent) =>
    contextMenu((): ContextItem[] => [
      { label: 'Open', icon: 'externalLink', onSelect: () => openTask(task.id), testId: 'ctx-task-open' },
      isClosed(task.status)
        ? { label: 'Reopen', icon: 'undo', onSelect: () => void complete(task), testId: 'ctx-task-done' }
        : { label: 'Mark as done', icon: 'circleCheck', onSelect: () => void complete(task), testId: 'ctx-task-done' },
      'separator',
      { heading: 'Status' },
      ...STATUSES.map((s): ContextItem => ({ label: s.label, icon: s.icon, checked: task.status === s.status, onSelect: () => void saveTask({ id: task.id, status: s.status }), testId: `ctx-task-status-${s.status}` })),
      'separator',
      { heading: 'Priority' },
      ...PRIORITIES.map((p): ContextItem => ({ label: p.label, icon: p.icon, checked: task.priority === p.priority, onSelect: () => void saveTask({ id: task.id, priority: p.priority }), testId: `ctx-task-priority-${p.priority}` })),
      'separator',
      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(task), testId: 'ctx-task-delete' },
    ])(event),
  )

  // Linear's keys: C new task, ⌘F search, J/K to move, Enter to open, X to complete.
  useKeys((press, { typing }) => {
    if (overlaysOpen() || open) return false
    const m = press.modifiers ?? {}
    const key = press.key?.toLowerCase()
    if ((m.cmd || m.ctrl) && !m.alt && !m.shift && key === 'f') {
      setSearchOpen(true)
      return true
    }
    if (key === 'escape' && (input || searchOpen)) {
      setInput('')
      setSearchOpen(false)
      return true
    }
    if (typing || m.cmd || m.ctrl || m.alt) return false
    if (key === 'c' || key === 'n') return (openTaskComposer(scopePrefill(view)), true)
    if (key === 'j' || key === 'down') return (step(1), true)
    if (key === 'k' || key === 'up') return (step(-1), true)
    if ((key === 'enter' || key === 'return') && highlight) return (openTask(highlight), true)
    const target = flat.find((t) => t.id === highlight)
    if (key === 'x' && target) return (void complete(target), true)
    return false
  })

  const openLink = useOpenLink(onOpenEvent)
  // Another view, grouping, ordering, filter or search is another list: it starts at the top.
  const listKey = `${view}\u0000${by}\u0000${orderBy}\u0000${query}\u0000${JSON.stringify(filter)}`
  const title = viewLabel(view, projects, labels)
  const viewIcon: IconName = VIEWS.find((v) => v.view === view)?.icon ?? (view.startsWith('label:') ? 'tag' : 'folder')
  const project = view.startsWith('project:') ? projects.find((p) => p.id === view.slice(8)) : undefined
  const label = view.startsWith('label:') ? labels.find((l) => l.id === view.slice(6)) : undefined

  return (
    <div testId="tasks" style={{ position: 'relative', flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.list }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 22, paddingRight: 14, gap: 9 }}>
        {project ? <ProjectGlyph project={project} size={16} /> : label ? <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: label.color }} /> : <Icon name={viewIcon} size={16} color={C.secondary} />}
        <text testId="tasks-title" style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</text>
        {fetched ? <text testId="tasks-count" style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>{String(viewCount(view, tasks))}</text> : null}
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="search" size={15} pad={30} active={searchOpen} onClick={() => setSearchOpen((v) => !v)} tooltip="Search  ⌘F" testId="tasks-search-toggle" />
        <NewTaskButton onPress={() => openTaskComposer(scopePrefill(view))} />
      </div>
      <Toolbar filter={filter} projects={projects} labels={labels} layout={layout} by={by} orderBy={orderBy} />
      {searchOpen || input ? <SearchBox value={input} onChange={setInput} /> : null}
      {layout === 'board' ? (
        <Board groups={groups} now={now} onOpen={openTask} onContext={taskMenu} open={open} projects={projects} scope={scopePrefill(view)} resetKey={listKey} />
      ) : (
        <div testId="tasks-list" style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {view !== 'done' && !query ? <AddLine onAdd={add} focusKey={addKey} now={now} view={view} /> : null}
          {fetched === null ? null : !groups.length ? (
            <Empty searching={!!query} filtered={filterCount(filter) > 0} view={title} completed={view === 'done'} />
          ) : (
            <TaskList groups={groups} now={now} active={open ?? highlight} projects={projects} onOpen={openTask} onContext={taskMenu} onAdd={(group) => openTaskComposer({ ...scopePrefill(view), ...group.prefill })} resetKey={listKey} />
          )}
        </div>
      )}
      {sheetTask ? (
        <TaskSheet key={sheetTask.id} task={sheetTask} now={now} onClose={() => setTasksState({ open: null })} onStep={flat.some((t) => t.id !== sheetTask.id) ? step : undefined} onDelete={remove} onOpenLink={openLink} eventsOpen={!!onOpenEvent} />
      ) : null}
    </div>
  )
}

/** A new task starts in the view it was made in (see viewPrefill). */
const scopePrefill = (view: TaskView): ComposerPrefill => viewPrefill(view, Date.now())

function NewTaskButton({ onPress }: { onPress: () => void }) {
  const { C } = useSettings()
  return (
    <div
      testId="task-new"
      role="button"
      tabIndex={0}
      aria-label="New task"
      onClick={onPress}
      onKeyDown={(event) => {
        if (event.key === 'space' || event.key === ' ') onPress()
      }}
      style={{ height: 30, paddingLeft: 10, paddingRight: 12, borderRadius: 15, backgroundColor: C.text, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer', hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) }, active: { backgroundColor: mixHex(C.text, C.reading, 0.22) } }}
    >
      <div style={{ display: 'flex', pointerEvents: 'none' }}>
        <Icon name="plus" size={14} color={C.onText} />
      </div>
      <text style={{ fontSize: 13, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none' }}>New task</text>
    </div>
  )
}

// --- Toolbar: Filter and Display -------------------------------------------------------

function ToolButton({ icon, label, onPress, active, badge, testId }: { icon: IconName; label: string; onPress: () => void; active: boolean; badge?: number; testId: string }) {
  const { C } = useSettings()
  return (
    <div testId={testId} role="button" onClick={onPress} style={{ height: 28, paddingLeft: 9, paddingRight: 10, borderRadius: 14, backgroundColor: active ? C.overlayStrong : undefined, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}>
      <div style={{ display: 'flex', pointerEvents: 'none' }}>
        <Icon name={icon} size={14} color={C.muted} />
      </div>
      <text style={{ fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
      {badge ? (
        <div style={{ minWidth: 16, height: 16, paddingLeft: 4, paddingRight: 4, borderRadius: 8, backgroundColor: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <text style={{ fontSize: 10.5, fontWeight: 600, color: C.onAccent, fontFamily: FONT }}>{String(badge)}</text>
        </div>
      ) : null}
    </div>
  )
}

const GROUPS: Array<{ by: GroupBy; label: string }> = [
  { by: 'status', label: 'Status' },
  { by: 'priority', label: 'Priority' },
  { by: 'project', label: 'Project' },
  { by: 'due', label: 'Due date' },
  { by: 'none', label: 'No grouping' },
]
const ORDERS: Array<{ order: OrderBy; label: string }> = [
  { order: 'priority', label: 'Priority' },
  { order: 'due', label: 'Due date' },
  { order: 'created', label: 'Created' },
  { order: 'updated', label: 'Updated' },
]

function Toolbar({ filter, projects, labels, layout, by, orderBy }: { filter: TaskFilter; projects: ReturnType<typeof useTaskProjects> & object; labels: ReturnType<typeof useTaskLabels> & object; layout: TasksLayout; by: GroupBy; orderBy: OrderBy }) {
  const { C } = useSettings()
  const [menu, setMenu] = useState<null | 'filter' | 'display'>(null)
  const set = (next: TaskFilter) => setTasksState({ filter: next })
  const toggle = <T,>(list: readonly T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])
  const chips: Array<{ key: string; label: string; leading: ReactNode; remove: () => void }> = [
    ...filter.priorities.map((p) => ({ key: `p${p}`, label: PRIORITIES.find((x) => x.priority === p)!.label, leading: <PriorityIcon priority={p} size={12} />, remove: () => set({ ...filter, priorities: filter.priorities.filter((x) => x !== p) }) })),
    ...filter.labelIds.map((id) => {
      const l = labels.find((x) => x.id === id)
      return { key: `l${id}`, label: l?.name ?? 'Label', leading: <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: l?.color ?? C.muted }} />, remove: () => set({ ...filter, labelIds: filter.labelIds.filter((x) => x !== id) }) }
    }),
    ...filter.projectIds.map((id) => {
      const p = projects.find((x) => x.id === id)
      return { key: `j${id}`, label: p?.name ?? 'Project', leading: <ProjectGlyph project={p ?? null} size={12} />, remove: () => set({ ...filter, projectIds: filter.projectIds.filter((x) => x !== id) }) }
    }),
  ]
  return (
    <div style={{ height: 42, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 14, gap: 6, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.divider }}>
      <div style={{ position: 'relative', display: 'flex' }}>
        <ToolButton icon="sliders" label="Filter" onPress={() => setMenu(menu === 'filter' ? null : 'filter')} active={menu === 'filter'} badge={filterCount(filter)} testId="tasks-filter" />
        <Menu open={menu === 'filter'} onClose={() => setMenu(null)} width={240} testId="tasks-filter-menu">
          <MenuLabel>Priority</MenuLabel>
          {PRIORITIES.map((p) => (
            <MenuItem key={p.priority} label={p.label} leading={<PriorityIcon priority={p.priority} size={14} />} checked={filter.priorities.includes(p.priority)} onSelect={() => set({ ...filter, priorities: toggle(filter.priorities, p.priority as TaskPriority) })} testId={`tasks-filter-priority-${p.priority}`} />
          ))}
          {labels.length ? (
            <>
              <MenuSeparator />
              <MenuLabel>Labels</MenuLabel>
              {labels.map((l) => (
                <MenuItem key={l.id} label={l.name} dot={l.color} checked={filter.labelIds.includes(l.id)} onSelect={() => set({ ...filter, labelIds: toggle(filter.labelIds, l.id) })} testId={`tasks-filter-label-${l.id}`} />
              ))}
            </>
          ) : null}
          {projects.length ? (
            <>
              <MenuSeparator />
              <MenuLabel>Projects</MenuLabel>
              {projects.map((p) => (
                <MenuItem key={p.id} label={p.name} leading={<ProjectGlyph project={p} />} checked={filter.projectIds.includes(p.id)} onSelect={() => set({ ...filter, projectIds: toggle(filter.projectIds, p.id) })} testId={`tasks-filter-project-${p.id}`} />
              ))}
            </>
          ) : null}
          {filterCount(filter) ? (
            <>
              <MenuSeparator />
              <MenuItem icon="x" label="Clear filters" onSelect={() => (set(NO_FILTER), setMenu(null))} testId="tasks-filter-clear" />
            </>
          ) : null}
        </Menu>
      </div>
      {chips.map((chip) => (
        <div key={chip.key} style={{ height: 24, paddingLeft: 8, paddingRight: 4, borderRadius: 12, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {chip.leading}
          <text style={{ fontSize: 12, color: C.text, fontFamily: FONT }}>{chip.label}</text>
          <IconButton icon="x" size={10} pad={18} onClick={chip.remove} tooltip="Remove filter" />
        </div>
      ))}
      <div style={{ flexGrow: 1 }} />
      <div style={{ position: 'relative', display: 'flex' }}>
        <ToolButton icon={layout === 'board' ? 'calendarDays' : 'list'} label="Display" onPress={() => setMenu(menu === 'display' ? null : 'display')} active={menu === 'display'} testId="tasks-display" />
        <Menu open={menu === 'display'} onClose={() => setMenu(null)} width={230} align="end" testId="tasks-display-menu">
          <MenuLabel>Layout</MenuLabel>
          <MenuItem icon="list" label="List" checked={layout === 'list'} onSelect={() => setTasksState({ layout: 'list' })} testId="tasks-layout-list" />
          <MenuItem icon="calendarDays" label="Board" checked={layout === 'board'} onSelect={() => setTasksState({ layout: 'board' })} testId="tasks-layout-board" />
          <MenuSeparator />
          <MenuLabel>Grouping</MenuLabel>
          {GROUPS.map((g) => (
            <MenuItem key={g.by} label={g.label} checked={by === g.by} onSelect={() => setTasksState({ groupBy: g.by })} testId={`tasks-group-by-${g.by}`} />
          ))}
          <MenuSeparator />
          <MenuLabel>Ordering</MenuLabel>
          {ORDERS.map((o) => (
            <MenuItem key={o.order} label={o.label} checked={orderBy === o.order} onSelect={() => setTasksState({ orderBy: o.order })} testId={`tasks-order-by-${o.order}`} />
          ))}
        </Menu>
      </div>
    </div>
  )
}

// --- List ----------------------------------------------------------------------------

/** The always-there line at the top: type, Enter, done. The date is read out of the text first. */
function AddLine({ onAdd, focusKey, now, view }: { onAdd: (text: string) => Promise<boolean>; focusKey: number; now: number; view: TaskView }) {
  const { C } = useSettings()
  const [text, setText] = useState('')
  const [key, setKey] = useState(0)
  // The due it will get: the typed date, or the view's (Today, Upcoming).
  const parsed = text.trim() ? quickAddInput(text, view, now) : null
  const due = parsed && parsed.dueAt != null ? dueText({ dueAt: parsed.dueAt, dueAllDay: parsed.dueAllDay ?? true }, now) : ''
  const submit = async (typed: string) => {
    if (!typed.trim()) return
    if (await onAdd(typed)) {
      setText('')
      // Clearing a controlled GPUIX field needs a remount; focus stays for the next one.
      setKey((k) => k + 1)
    }
  }
  return (
    <div style={{ height: 42, flexShrink: 0, paddingLeft: 22, paddingRight: 16, gap: 12, borderBottomWidth: 1, borderColor: C.divider, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <Icon name="plus" size={15} color={C.muted} />
      <input
        key={`${focusKey}-${key}`}
        testId="task-quick-add"
        autoFocus={focusKey > 0 || key > 0}
        value={text}
        placeholder="Add a task…  “Send the deck Friday 3pm”, then Enter"
        onChange={(event) => setText(event.value ?? '')}
        // Enter on a GPUIX input arrives as submit (never as a keydown), with the text as typed.
        onSubmit={(event) => void submit(event.value ?? text)}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
      {due ? (
        <div testId="task-quick-add-due" style={{ height: 22, paddingLeft: 7, paddingRight: 8, borderRadius: 11, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <Icon name="calendar" size={11} color={C.accent} />
          <text style={{ fontSize: 11.5, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{due}</text>
        </div>
      ) : null}
      {text.trim() ? <text style={{ fontSize: 11.5, color: C.ghost, fontFamily: FONT }}>↵</text> : null}
    </div>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 38, flexShrink: 0, paddingLeft: 22, paddingRight: 14, gap: 10, borderBottomWidth: 1, borderColor: C.divider, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <Icon name="search" size={14} color={C.muted} />
      <input testId="tasks-search" autoFocus value={value} placeholder="Search tasks" onChange={(event) => onChange(event.value ?? '')} style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }} />
      {value ? <IconButton icon="x" size={12} pad={20} onClick={() => onChange('')} testId="tasks-search-clear" /> : null}
    </div>
  )
}

function GroupIcon({ group, size = 14 }: { group: ListGroup; size?: number }) {
  const { C } = useSettings()
  if (group.color) return <ProjectGlyph project={{ color: group.color }} size={size} />
  return group.icon ? <Icon name={group.icon} size={size} color={toneColor(group.tone, C)} /> : null
}

function GroupHeader({ group, onAdd }: { group: ListGroup; onAdd: () => void }) {
  const { C } = useSettings()
  return (
    <div testId={`tasks-group-${group.key}`} style={{ height: GROUP_HEADER_HEIGHT, width: '100%', flexShrink: 0, paddingLeft: 22, paddingRight: 12, backgroundColor: C.overlay, borderBottomWidth: 1, borderColor: C.divider, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      <GroupIcon group={group} />
      <text style={{ fontSize: 13, fontWeight: 600, color: group.tone === 'red' ? C.red : C.text, fontFamily: FONT }}>{group.label}</text>
      <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{String(group.tasks.length)}</text>
      <div style={{ flexGrow: 1 }} />
      <IconButton icon="plus" size={14} pad={26} onClick={onAdd} tooltip={`New task in ${group.label}`} testId={`tasks-group-add-${group.key}`} />
    </div>
  )
}

type ListItem = { key: string; group?: ListGroup; task?: Task }
/** Opens a task's right-click menu (see TasksPane). */
type TaskContext = (task: Task, event: ContextEvent) => void
const GROUP_HEADER_HEIGHT = 38
const TASK_ROW_HEIGHT = 44

/**
 * The table: group headers and their rows in one virtual list, so thousands of tasks mount and paint
 * only the screenful in view (see virtual-window.ts). J/K keep the highlighted row on screen.
 */
function TaskList({ groups, now, active, projects, onOpen, onContext, onAdd, resetKey }: { groups: ListGroup[]; now: number; active: string | null; projects: ReturnType<typeof useTaskProjects> & object; onOpen: (id: string) => void; onContext: TaskContext; onAdd: (group: ListGroup) => void; resetKey: string }) {
  const items = useMemo(() => {
    const out: ListItem[] = []
    for (const group of groups) {
      if (group.label) out.push({ key: `group-${group.key}`, group })
      for (const task of group.tasks) out.push({ key: task.id, group, task })
    }
    // Room under the last row, as the page had.
    out.push({ key: 'end' })
    return out
  }, [groups])
  const { start, end, generation, onVisibleRange } = useRowWindow(items.length, resetKey)
  const listRef = useRef<PublicInstance>(null)
  const activeIndex = active ? items.findIndex((item) => item.task?.id === active) : -1
  useRevealRow(listRef, activeIndex, (i) => (items[i]?.task ? TASK_ROW_HEIGHT : items[i]?.group ? GROUP_HEADER_HEIGHT : 24))
  return (
    <virtual-list ref={listRef} key={generation} itemCount={items.length} estimatedItemHeight={TASK_ROW_HEIGHT} windowStart={start} onVisibleRange={onVisibleRange} style={{ flexGrow: 1, minHeight: 0 }}>
      {items.slice(start, end).map((item) =>
        item.task ? (
          <TaskRow key={item.key} task={item.task} now={now} active={item.task.id === active} projects={projects} onOpen={onOpen} onContext={onContext} />
        ) : item.group ? (
          <GroupHeader key={item.key} group={item.group} onAdd={() => onAdd(item.group!)} />
        ) : (
          <div key={item.key} style={{ height: 24, width: '100%' }} />
        ),
      )}
    </virtual-list>
  )
}

/** One table row, like a Linear issue: priority, id, status, title, then labels, project, email and due. */
const TaskRow = memo(function TaskRow({ task, now, active, projects, onOpen, onContext }: { task: Task; now: number; active: boolean; projects: ReturnType<typeof useTaskProjects> & object; onOpen: (id: string) => void; onContext: TaskContext }) {
  const { C } = useSettings()
  const { saveTask } = useMailActions()
  const closed = isClosed(task.status)
  const mail = liveFirst(task.links).find((l) => l.target.kind === 'thread' || l.target.kind === 'message')
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined
  const due = closed ? '' : dueText(task, now)
  const late = isOverdue(task, now)
  return (
    <div
      testId={`task-row-${task.id}`}
      onClick={() => onOpen(task.id)}
      onAuxClick={(event) => onContext(task, event)}
      style={{
        height: TASK_ROW_HEIGHT,
        // Rows in the virtual list size to their content unless told to fill it.
        width: '100%',
        flexShrink: 0,
        paddingLeft: 14,
        paddingRight: 18,
        borderBottomWidth: 1,
        borderColor: C.divider,
        backgroundColor: active ? C.navSelected : undefined,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        hover: active ? undefined : { backgroundColor: C.overlay },
      }}
    >
      <PriorityPicker priority={task.priority} onChange={(priority) => void saveTask({ id: task.id, priority })} variant="icon" testId={`task-priority-${task.id}`} />
      <text style={{ width: 50, flexShrink: 0, fontSize: 12.5, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{taskKey(task)}</text>
      <StatusPicker status={task.status} onChange={(status) => void saveTask({ id: task.id, status })} variant="icon" testId={`task-status-${task.id}`} />
      <text style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, paddingLeft: 4, fontSize: 13.5, fontWeight: 500, color: closed ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{task.title}</text>
      {task.origin === 'ai' ? <Icon name="sparkles" size={12} color={C.purple} /> : null}
      {task.labels.slice(0, 2).map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
      {task.labels.length > 2 ? <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{`+${task.labels.length - 2}`}</text> : null}
      {project ? <Pill leading={<ProjectGlyph project={project} size={11} />} text={project.name} /> : null}
      {mail ? <Pill leading={<Icon name="mail" size={11} color={C.muted} />} text={linkView(mail, now).primary} /> : null}
      <text style={{ width: 132, flexShrink: 0, fontSize: 12, color: late ? C.red : C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'right', pointerEvents: 'none' }}>{due}</text>
    </div>
  )
})

function Pill({ leading, text }: { leading: ReactNode; text: string }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 22, maxWidth: 150, paddingLeft: 7, paddingRight: 8, borderRadius: 11, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0, pointerEvents: 'none' }}>
      {leading}
      <text style={{ fontSize: 11.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>{text}</text>
    </div>
  )
}

function Empty({ searching, filtered, view, completed }: { searching: boolean; filtered: boolean; view: string; completed: boolean }) {
  const { C } = useSettings()
  return (
    <div testId="tasks-empty" style={{ paddingTop: 80, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 52, height: 52, borderRadius: 15, backgroundColor: C.raised, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
        <Icon name={searching ? 'search' : 'circleCheck'} size={22} color={C.secondary} />
      </div>
      <text style={{ fontSize: 16, fontWeight: 600, color: C.text, fontFamily: FONT }}>{searching ? 'No matching tasks' : filtered ? 'Nothing matches these filters' : `Nothing in ${view}`}</text>
      <text style={{ maxWidth: 380, fontSize: 13.5, lineHeight: 20, color: C.muted, fontFamily: FONT, textAlign: 'center' }}>
        {searching || filtered
          ? 'Try another search, or clear the filters.'
          : completed
            ? 'Tasks you mark done or cancel show up here.'
            : 'Type a task above, press C for a new one, or press T on an email to make it a task that links back to the conversation.'}
      </text>
    </div>
  )
}

// --- Board ---------------------------------------------------------------------------

function Board({ groups, now, onOpen, onContext, open, projects, scope, resetKey }: { groups: ListGroup[]; now: number; onOpen: (id: string) => void; onContext: TaskContext; open: string | null; projects: ReturnType<typeof useTaskProjects> & object; scope: ComposerPrefill; resetKey: string }) {
  return (
    <div testId="tasks-board" style={{ flexGrow: 1, minHeight: 0, overflowX: 'scroll', display: 'flex', flexDirection: 'row', gap: 12, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }}>
      {groups.map((group) => (
        <Column key={group.key} group={group} now={now} onOpen={onOpen} onContext={onContext} open={open} projects={projects} scope={scope} resetKey={resetKey} />
      ))}
    </div>
  )
}

/** Cards vary in height (a long title wraps, chips add a line); the list measures them as they lay out. */
const CARD_HEIGHT = 96
const CARD_GAP = 8

/** A board column: its cards in a virtual list, so a column of hundreds paints only what's in view. */
function Column({ group, now, onOpen, onContext, open, projects, scope, resetKey }: { group: ListGroup; now: number; onOpen: (id: string) => void; onContext: TaskContext; open: string | null; projects: ReturnType<typeof useTaskProjects> & object; scope: ComposerPrefill; resetKey: string }) {
  const { C } = useSettings()
  const { start, end, generation, onVisibleRange } = useRowWindow(group.tasks.length, resetKey)
  return (
    <div testId={`tasks-column-${group.key}`} style={{ width: 300, flexShrink: 0, height: '100%', borderRadius: 12, backgroundColor: C.overlay, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 40, flexShrink: 0, paddingLeft: 14, paddingRight: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <GroupIcon group={group} />
        <text style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: FONT }}>{group.label || 'Tasks'}</text>
        <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{String(group.tasks.length)}</text>
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="plus" size={14} pad={26} onClick={() => openTaskComposer({ ...scope, ...group.prefill })} tooltip={`New task in ${group.label || 'this column'}`} testId={`tasks-column-add-${group.key}`} />
      </div>
      {group.tasks.length ? (
        <virtual-list key={generation} itemCount={group.tasks.length} estimatedItemHeight={CARD_HEIGHT + CARD_GAP} windowStart={start} onVisibleRange={onVisibleRange} style={{ flexGrow: 1, minHeight: 0 }}>
          {group.tasks.slice(start, end).map((task) => (
            // The list has no gap or padding of its own: each card brings its share.
            <div key={task.id} style={{ width: '100%', paddingLeft: 8, paddingRight: 8, paddingBottom: CARD_GAP }}>
              <Card task={task} now={now} active={task.id === open} onOpen={onOpen} onContext={onContext} projects={projects} />
            </div>
          ))}
        </virtual-list>
      ) : (
        <div style={{ flexGrow: 1 }} />
      )}
    </div>
  )
}

const Card = memo(function Card({ task, now, active, onOpen, onContext, projects }: { task: Task; now: number; active: boolean; onOpen: (id: string) => void; onContext: TaskContext; projects: ReturnType<typeof useTaskProjects> & object }) {
  const { C } = useSettings()
  const { saveTask } = useMailActions()
  const closed = isClosed(task.status)
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined
  const due = closed ? '' : dueText(task, now)
  const late = isOverdue(task, now)
  const mail = liveFirst(task.links).find((l) => l.target.kind === 'thread' || l.target.kind === 'message')
  return (
    <div
      testId={`task-card-${task.id}`}
      onClick={() => onOpen(task.id)}
      onAuxClick={(event) => onContext(task, event)}
      style={{ flexShrink: 0, borderRadius: 12, borderWidth: 1, borderColor: active ? C.accent : '#00000000', backgroundColor: C.reading, paddingLeft: 12, paddingRight: 10, paddingTop: 10, paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', hover: { backgroundColor: C.raisedHover } }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <text style={{ flexGrow: 1, fontSize: 12, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{taskKey(task)}</text>
        <PriorityPicker priority={task.priority} onChange={(priority) => void saveTask({ id: task.id, priority })} variant="icon" testId={`task-card-priority-${task.id}`} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
        <StatusPicker status={task.status} onChange={(status) => void saveTask({ id: task.id, status })} variant="icon" testId={`task-card-status-${task.id}`} />
        <text style={{ flexGrow: 1, minWidth: 0, paddingTop: 3, fontSize: 13.5, lineHeight: 19, fontWeight: 500, color: closed ? C.muted : C.text, fontFamily: FONT, pointerEvents: 'none' }}>{task.title}</text>
      </div>
      {task.labels.length || project || mail || due ? (
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
          {task.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
          {project ? <Pill leading={<ProjectGlyph project={project} size={11} />} text={project.name} /> : null}
          {mail ? <Pill leading={<Icon name="mail" size={11} color={C.muted} />} text={linkView(mail, now).primary} /> : null}
          {due ? <Pill leading={<Icon name="calendar" size={11} color={late ? C.red : C.muted} />} text={due} /> : null}
        </div>
      ) : null}
    </div>
  )
})
