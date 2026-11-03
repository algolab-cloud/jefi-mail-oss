import { appIsActive } from './notify'
import { available, cls, msg, msgInt } from './objc'

// NSApplicationOcclusionStateVisible: some part of one of the app's windows is on screen.
const OCCLUSION_VISIBLE = 1 << 1

/**
 * Whether decorative motion should run: Jefi is in front, one of its windows is on screen, and the
 * person hasn't asked macOS to reduce motion. GPUIX has no reduced-motion or window-activity event,
 * so callers poll this (cheaply) instead. Off macOS it's always true, so animations look the same.
 */
export function decorativeMotionAllowed(): boolean {
  if (!available) return true
  try {
    const app = msg(cls('NSApplication'), 'sharedApplication')
    if (!appIsActive() || !(msgInt(app, 'occlusionState') & OCCLUSION_VISIBLE)) return false
    return msgInt(msg(cls('NSWorkspace'), 'sharedWorkspace'), 'accessibilityDisplayShouldReduceMotion') === 0
  } catch {
    return true
  }
}
