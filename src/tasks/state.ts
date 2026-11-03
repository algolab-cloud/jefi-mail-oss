import { useSyncExternalStore } from 'react'
import { NO_FILTER, type GroupBy, type OrderBy, type TaskFilter, type TaskView } from './model'

// ---------------------------------------------------------------------------
// The tasks app's view state, shared by its sidebar (which view) and the main pane (how it's
// shown, and which task's sheet is open). Module state like the calendar's: it outlives the pane
// remounting when the person switches apps, for the length of the run.
// ---------------------------------------------------------------------------

export type TasksLayout = 'list' | 'board'

export type TasksState = {
  view: TaskView
  layout: TasksLayout
  groupBy: GroupBy
  orderBy: OrderBy
  filter: TaskFilter
  /** The task whose detail sheet is open. */
  open: string | null
}

let state: TasksState = { view: 'active', layout: 'list', groupBy: 'status', orderBy: 'priority', filter: NO_FILTER, open: null }
const listeners = new Set<() => void>()

export function setTasksState(patch: Partial<TasksState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export const getTasksState = () => state

export function useTasksState<T>(select: (s: TasksState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => select(state),
  )
}

/** Switching views clears the filters and closes the sheet, like picking a view in Linear. */
export const showView = (view: TaskView) => setTasksState({ view, filter: NO_FILTER, open: null })
