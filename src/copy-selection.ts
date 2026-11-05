import { copyText } from './native/mail-webview'

type KeyEvent = { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } }
type SelectionSource = { getSelectedText?: () => string | null; getFocusedElementId?: () => unknown }

/**
 * ⌘C with text selected anywhere in the window (a message, a summary, the assistant's replies) copies
 * it. GPUIX keeps the selection but leaves copying to the app. A focused field copies its own
 * selection, so it keeps the key. True when the key was used.
 */
export function copySelectionOnKey(event: KeyEvent, renderer: SelectionSource, copy: (text: string) => boolean = copyText) {
  const m = event.modifiers
  if (!m?.cmd || m.ctrl || m.alt || m.shift || event.key?.toLowerCase() !== 'c') return false
  if (renderer.getFocusedElementId?.() != null) return false
  const selected = renderer.getSelectedText?.() ?? ''
  if (!selected.trim()) return false
  return copy(selected)
}
