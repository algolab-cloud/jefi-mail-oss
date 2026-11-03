// Anything that may move the reader's layout (scrolling, pane drags) says so here, so views that
// follow GPUIX geometry from outside its tree (the Full HTML web view) poll quickly only then.
const listeners = new Set<() => void>()

export function geometryMayChange() {
  for (const listener of listeners) listener()
}

export function onGeometryMayChange(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
