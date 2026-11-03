import type { EditorReplacement, EditorSelection } from './native/editor-selection'

export type InlineFormat = { kind: 'inline'; before: string; after: string; placeholder: string }
export type LineFormat = { kind: 'line'; prefix: string; placeholder: string }
export type ComposeFormat = InlineFormat | LineFormat

function utf16Boundary(value: string, index: number) {
  if (index <= 0 || index >= value.length) return true
  const previous = value.charCodeAt(index - 1)
  const current = value.charCodeAt(index)
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
}

export function validEditorSelection(value: string, selection: EditorSelection) {
  const end = selection.location + selection.length
  return (
    Number.isSafeInteger(selection.location) &&
    Number.isSafeInteger(selection.length) &&
    selection.location >= 0 &&
    selection.length >= 0 &&
    end <= value.length &&
    utf16Boundary(value, selection.location) &&
    utf16Boundary(value, end)
  )
}

/** Builds one native replacement from the exact Cocoa UTF-16 selection. */
export function composeFormatEdit(value: string, selection: EditorSelection, format: ComposeFormat): EditorReplacement | null {
  if (!validEditorSelection(value, selection)) return null
  const end = selection.location + selection.length
  if (format.kind === 'inline') {
    const selected = value.slice(selection.location, end) || format.placeholder
    return { range: selection, text: `${format.before}${selected}${format.after}` }
  }

  const lineStart = selection.location === 0 ? 0 : value.lastIndexOf('\n', selection.location - 1) + 1
  const lineEnd = selection.length
    ? end
    : (value.indexOf('\n', selection.location) === -1 ? value.length : value.indexOf('\n', selection.location))
  const current = value.slice(lineStart, lineEnd)
  const text = current ? `${format.prefix}${current.replace(/\n(?=.)/g, `\n${format.prefix}`)}` : `${format.prefix}${format.placeholder}`
  return { range: { location: lineStart, length: lineEnd - lineStart }, text }
}

export function shortcutFormat(
  event: { key?: string; modifiers?: { cmd: boolean; ctrl: boolean; shift: boolean } },
  platform: 'darwin' | 'other' = process.platform === 'darwin' ? 'darwin' : 'other',
): ComposeFormat | null {
  const modifiers = event.modifiers
  if (!modifiers) return null
  const primary = platform === 'darwin' ? modifiers.cmd : modifiers.ctrl
  if (!primary) return null
  const key = event.key?.toLowerCase()
  if (key === 'b' && !modifiers.shift) return { kind: 'inline', before: '**', after: '**', placeholder: 'bold text' }
  if (key === 'i' && !modifiers.shift) return { kind: 'inline', before: '_', after: '_', placeholder: 'italic text' }
  if (key === 'k' && !modifiers.shift) return { kind: 'inline', before: '[', after: '](https://)', placeholder: 'link text' }
  if (key === 'x' && modifiers.shift) return { kind: 'inline', before: '~~', after: '~~', placeholder: 'strikethrough' }
  // Apple Notes' checklist shortcut.
  if (key === 'l' && modifiers.shift) return { kind: 'line', prefix: '- [ ] ', placeholder: 'Task' }
  return null
}
