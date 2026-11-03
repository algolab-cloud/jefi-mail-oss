import { useRef, useState } from 'react'
import { useNow } from '../calendar/hooks'
import type { Task } from '../engine'
import { Icon, IconButton, type IconName } from '../icons'
import { useTaskLabels, useTaskProjects, useTasks } from '../local-data'
import { useMailActions } from '../store'
import { FONT, TOPBAR_HEIGHT, useSettings } from '../theme'
import { toast } from '../toast'
import { Menu, MenuItem } from '../ui'
import { openTaskComposer } from './composer'
import { VIEWS, dueDay, isClosed, type TaskView } from './model'
import { ProjectGlyph, SWATCHES } from './pickers'
import { showView, useTasksState } from './state'
import { startOfDay } from '../calendar/dates'

// ---------------------------------------------------------------------------
// The Tasks app's context column, like Linear's: New task, the views (with counts), projects and
// labels. Picking one shows it in the main pane (state.ts).
// ---------------------------------------------------------------------------

/** How many tasks each view holds, from every task (open and closed). */
function viewCounts(all: readonly Task[], now: number): Record<string, number> {
  const today = startOfDay(now)
  const open = all.filter((t) => !isClosed(t.status))
  const counts: Record<string, number> = {
    active: open.filter((t) => t.status === 'todo' || t.status === 'in_progress').length,
    today: open.filter((t) => { const d = dueDay(t); return d !== null && d <= today }).length,
    upcoming: open.filter((t) => { const d = dueDay(t); return d !== null && d > today }).length,
    backlog: open.filter((t) => t.status === 'backlog').length,
    all: open.length,
  }
  for (const t of open) {
    if (t.projectId) counts[`project:${t.projectId}`] = (counts[`project:${t.projectId}`] ?? 0) + 1
    for (const l of t.labels) counts[`label:${l.id}`] = (counts[`label:${l.id}`] ?? 0) + 1
  }
  return counts
}

export function TasksSidebar() {
  const { C } = useSettings()
  const view = useTasksState((s) => s.view)
  const now = useNow()
  const all = useTasks({ status: 'all' }) ?? []
  const projects = useTaskProjects() ?? []
  const labels = useTaskLabels() ?? []
  const counts = viewCounts(all, now)
  const [adding, setAdding] = useState<null | 'project' | 'label'>(null)
  const { saveTaskProject, saveTaskLabel } = useMailActions()

  const create = async (kind: 'project' | 'label', name: string) => {
    setAdding(null)
    if (!name.trim()) return
    const color = SWATCHES[(kind === 'project' ? projects.length : labels.length) % SWATCHES.length]!
    const made = kind === 'project' ? await saveTaskProject({ name, color }) : await saveTaskLabel({ name, color })
    if (made) showView(`${kind}:${made.id}` as TaskView)
  }

  return (
    <div testId="tasks-sidebar" style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, paddingLeft: 16, paddingRight: 12, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Tasks</text>
        <IconButton icon="pencil" size={15} pad={28} onClick={() => openTaskComposer()} tooltip="New task  C" testId="tasks-sidebar-new" />
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', paddingLeft: 8, paddingRight: 8, paddingBottom: 16, display: 'flex', flexDirection: 'column' }}>
        {VIEWS.map((v) => (
          <Row key={v.view} icon={v.icon} label={v.label} count={v.view === 'done' ? undefined : counts[v.view]} active={view === v.view} onSelect={() => showView(v.view)} testId={`tasks-view-${v.view}`} />
        ))}

        <Section label="Projects" onAdd={() => setAdding('project')} testId="tasks-projects-add" />
        {projects.map((p) => (
          <Row key={p.id} glyph={<ProjectGlyph project={p} size={15} />} label={p.name} count={counts[`project:${p.id}`]} active={view === `project:${p.id}`} onSelect={() => showView(`project:${p.id}`)} testId={`tasks-view-project-${p.id}`} menu={{ kind: 'project', id: p.id, name: p.name }} />
        ))}
        {adding === 'project' ? <NewRow placeholder="Project name" onDone={(name) => void create('project', name)} testId="tasks-project-name" /> : null}
        {!projects.length && adding !== 'project' ? <Hint text="Group tasks into projects" onPress={() => setAdding('project')} /> : null}

        <Section label="Labels" onAdd={() => setAdding('label')} testId="tasks-labels-add" />
        {labels.map((l) => (
          <Row key={l.id} dot={l.color} label={l.name} count={counts[`label:${l.id}`]} active={view === `label:${l.id}`} onSelect={() => showView(`label:${l.id}`)} testId={`tasks-view-label-${l.id}`} menu={{ kind: 'label', id: l.id, name: l.name }} />
        ))}
        {adding === 'label' ? <NewRow placeholder="Label name" onDone={(name) => void create('label', name)} testId="tasks-label-name" /> : null}
        {!labels.length && adding !== 'label' ? <Hint text="Tag tasks with labels" onPress={() => setAdding('label')} /> : null}
      </div>
    </div>
  )
}

function Row({
  icon,
  glyph,
  dot,
  label,
  count,
  active,
  onSelect,
  testId,
  menu,
}: {
  icon?: IconName
  glyph?: React.ReactNode
  dot?: string
  label: string
  count?: number
  active: boolean
  onSelect: () => void
  testId: string
  menu?: { kind: 'project' | 'label'; id: string; name: string }
}) {
  const { C } = useSettings()
  const [open, setOpen] = useState(false)
  const { deleteTaskProject, deleteTaskLabel } = useMailActions()
  const view = useTasksState((s) => s.view)
  const remove = async () => {
    setOpen(false)
    if (!menu) return
    const ok = menu.kind === 'project' ? await deleteTaskProject(menu.id) : await deleteTaskLabel(menu.id)
    if (!ok) return
    if (view === `${menu.kind}:${menu.id}`) showView('active')
    toast(`Deleted ${menu.kind} “${menu.name}”`, { description: menu.kind === 'project' ? 'Its tasks are kept, without a project' : 'It’s off every task' })
  }
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div
        testId={testId}
        onClick={onSelect}
        onAuxClick={menu ? () => setOpen(true) : undefined}
        style={{ height: 30, flexShrink: 0, marginBottom: 1, paddingLeft: 8, paddingRight: 8, gap: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', borderRadius: 7, cursor: 'pointer', backgroundColor: active ? C.navSelected : undefined, hover: active ? undefined : { backgroundColor: C.overlay } }}
      >
        <div style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          {dot ? <div style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: dot }} /> : glyph ?? (icon ? <Icon name={icon} size={16} color={active ? C.accent : C.secondary} /> : null)}
        </div>
        <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontWeight: active ? 600 : 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{label}</text>
        {count ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{String(count)}</text> : null}
      </div>
      {menu ? (
        <Menu open={open} onClose={() => setOpen(false)} width={200} align="end" testId={`${testId}-menu`}>
          <MenuItem icon="trash" danger label={`Delete ${menu.kind}`} onSelect={() => void remove()} testId={`${testId}-delete`} />
        </Menu>
      ) : null}
    </div>
  )
}

function Section({ label, onAdd, testId }: { label: string; onAdd: () => void; testId: string }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 30, marginTop: 16, paddingLeft: 8, paddingRight: 2, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <text style={{ flexGrow: 1, fontSize: 12, fontWeight: 600, color: C.muted, fontFamily: FONT }}>{label}</text>
      <IconButton icon="plus" size={13} pad={24} onClick={onAdd} tooltip={`New ${label.toLowerCase().replace(/s$/, '')}`} testId={testId} />
    </div>
  )
}

function NewRow({ placeholder, onDone, testId }: { placeholder: string; onDone: (name: string) => void; testId: string }) {
  const { C } = useSettings()
  const [text, setText] = useState('')
  // Enter, then the blur as the field goes away: finish once.
  const finished = useRef(false)
  const finish = (name: string) => {
    if (finished.current) return
    finished.current = true
    onDone(name)
  }
  return (
    <div style={{ height: 30, paddingLeft: 8, paddingRight: 8, gap: 10, borderRadius: 7, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <Icon name="plus" size={14} color={C.muted} />
      <input
        testId={testId}
        autoFocus
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.value ?? '')}
        // Enter on a GPUIX input arrives as submit; leaving the field without a name cancels.
        onSubmit={(event) => finish(event.value ?? text)}
        onBlur={() => finish(text)}
        onKeyDown={(event) => {
          if (event.key === 'escape') finish('')
        }}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
    </div>
  )
}

function Hint({ text, onPress }: { text: string; onPress: () => void }) {
  const { C } = useSettings()
  return (
    <div onClick={onPress} style={{ height: 28, paddingLeft: 34, display: 'flex', alignItems: 'center', cursor: 'pointer', borderRadius: 7, hover: { backgroundColor: C.overlay } }}>
      <text style={{ fontSize: 12.5, color: C.ghost, fontFamily: FONT, pointerEvents: 'none' }}>{text}</text>
    </div>
  )
}
