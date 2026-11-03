import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { composeFormatEdit, shortcutFormat, type ComposeFormat } from '../compose-format'
import { useContextMenu, type ContextEvent } from '../context-menu'
import type { Link, Note } from '../engine'
import { Icon, IconButton, type IconName } from '../icons'
import { isCmd, useKeys } from '../keys'
import { useNotes } from '../local-data'
import { MailMarkdown } from '../markdown'
import { overlaysOpen } from '../overlays'
import { usePaneWidth } from '../resizer'
import { notesKeyFor } from '../shortcuts'
import { useMailActions } from '../store'
import { FONT, TOPBAR_HEIGHT, useSettings } from '../theme'
import { toast } from '../toast'
import { useStableCallback } from '../stable-callback'
import { Tooltip } from '../tooltip'
import { Button } from '../ui'
import { readEditorSnapshot, replaceEditorSelection, type EditorSnapshot } from '../native/editor-selection'
import { useAutosave, type SaveState } from './autosave'
import { useRowWindow } from '../virtual-window'
import { useFollowEnd } from './follow-end'
import { LinkBadge, LinkChip, useOpenLink } from './links'
import { checklistProgress, formatWhen, rowTime, liveFirst, noteBlocks, noteGroup, noteHeading, notePreview, restorableTargets, searchQuery, toggleTask, wordCount, type NoteBlock } from './model'
import type { NoteRequest } from './open'

// ---------------------------------------------------------------------------
// The notes view: a searchable list (pinned first, then latest edited) beside an editor that saves
// as you type. Replaces the mail list and reader while open, like Clean up and Rules.
// ---------------------------------------------------------------------------

/** How long the search box waits after typing before asking the engine. */
const SEARCH_DEBOUNCE_MS = 150

export function NotesPane({ request, onOpenEvent }: { request?: (NoteRequest & { key: number }) | null; onOpenEvent?: (eventId: string) => void }) {
  const { C } = useSettings()
  const { saveNote, deleteNote } = useMailActions()
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchQuery(input)), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input])
  const notes = useNotes(query)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A note just made isn't in the list until the refetch lands; show it meanwhile.
  const [fresh, setFresh] = useState<Note | null>(null)
  const [searchKey, setSearchKey] = useState(0)
  const [composeKey, setComposeKey] = useState(0)

  const list = notes ?? []
  const selected = list.find((n) => n.id === selectedId) ?? (fresh && fresh.id === selectedId ? fresh : null) ?? (selectedId && !query ? null : list[0]) ?? null

  const create = async (prefill?: { title?: string; body?: string }) => {
    setInput('')
    setQuery('')
    const note = await saveNote({ title: prefill?.title ?? '', body: prefill?.body ?? '' })
    if (!note) return
    setFresh(note)
    setSelectedId(note.id)
    setComposeKey((n) => n + 1)
  }

  useEffect(() => {
    if (!request) return
    if ('create' in request) void create(request)
    else {
      setInput('')
      setQuery('')
      setSelectedId(request.noteId)
    }
  }, [request?.key])

  const remove = async (note: Note) => {
    const index = list.findIndex((n) => n.id === note.id)
    const next = list[index + 1] ?? list[index - 1]
    if (!(await deleteNote(note.id))) return
    // Deleting another note from its right-click menu leaves the open one open.
    if (note.id === selected?.id) setSelectedId(next?.id ?? null)
    toast('Note deleted', {
      description: noteHeading(note),
      action: {
        label: 'Undo',
        onClick: () =>
          void saveNote({ title: note.title, body: note.body, pinned: note.pinned, links: restorableTargets(note) }).then((restored) => {
            if (!restored) return
            setFresh(restored)
            setSelectedId(restored.id)
          }),
      },
    })
  }

  // The open note's editor holds text not yet saved: its pin and delete go through it (see NoteEditor).
  const editor = useRef<EditorActions | null>(null)
  const contextMenu = useContextMenu()
  const noteMenu = useStableCallback((note: Note, event: ContextEvent) => {
    const open = note.id === selected?.id ? editor.current : null
    contextMenu(() => [
      { label: 'Open', icon: 'file', onSelect: () => setSelectedId(note.id), testId: 'ctx-note-open' },
      {
        label: note.pinned ? 'Unpin' : 'Pin to top',
        icon: 'pin',
        onSelect: () => {
          if (open) return open.togglePin()
          // With none picked, the top note shows; pinning another would move it there and swap the editor.
          if (selected) setSelectedId(selected.id)
          void saveNote({ id: note.id, title: note.title, body: note.body, pinned: !note.pinned })
        },
        testId: 'ctx-note-pin',
      },
      'separator',
      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => (open ? open.remove() : void remove(note)), testId: 'ctx-note-delete' },
    ])(event)
  })

  useKeys((press, { typing }) => {
    if (overlaysOpen()) return false
    const key = notesKeyFor(press, { typing })
    if (key === 'search') {
      setSearchKey((n) => n + 1)
      return true
    }
    if (key === 'newNote') {
      void create()
      return true
    }
    // Esc clears a search first; with none, the workspace closes the notes view.
    if (key === 'escape' && input) {
      setInput('')
      return true
    }
    return false
  })

  const openLink = useOpenLink(onOpenEvent)
  const listWidth = usePaneWidth('list')
  const searching = !!query

  return (
    <div testId="notes" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'row' }}>
      <div style={{ width: listWidth, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.list, borderRightWidth: 1, borderColor: C.divider }}>
        <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 12, gap: 8 }}>
          <text style={{ fontSize: 19, fontWeight: 600, color: C.text, fontFamily: FONT }}>Notes</text>
          {notes && !searching && list.length ? <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>{list.length}</text> : null}
          <div style={{ flexGrow: 1 }} />
          <IconButton icon="plus" size={16} pad={28} onClick={() => void create()} tooltip="New note  N" testId="note-new" />
        </div>
        <div style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 8, flexShrink: 0 }}>
          <SearchBox value={input} onChange={setInput} focusKey={searchKey} />
        </div>
        {notes === null ? (
          <div testId="notes-list" style={{ flexGrow: 1, minHeight: 0 }} />
        ) : list.length === 0 ? (
          // With no notes at all, the page beside says so (and offers New note); only a search answers here.
          <div testId="notes-list" style={{ flexGrow: 1, minHeight: 0, paddingTop: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {searching ? <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>{`No notes match “${query}”`}</text> : null}
          </div>
        ) : (
          <NoteList notes={list} searching={searching} selectedId={selected?.id ?? null} onSelect={setSelectedId} onContext={noteMenu} resetKey={query} />
        )}
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: C.reading, display: 'flex', flexDirection: 'column' }}>
        {selected ? (
          <NoteEditor key={selected.id} actions={editor} note={selected} autoFocus={composeKey > 0 && selected.id === fresh?.id} onDelete={remove} onOpenLink={openLink} eventsOpen={!!onOpenEvent} />
        ) : notes === null ? null : searching ? (
          <EmptyState icon="search" title="No matching notes" detail={`Nothing in your notes mentions “${query}”.`} />
        ) : (
          <EmptyState
            icon="file"
            title="Your notes live here"
            detail="Jot down anything, or add an email from the reader to keep it with your thoughts."
            action={<Button label="New note" icon="plus" variant="primary" onClick={() => void create()} testId="notes-empty-new" />}
          />
        )}
      </div>
    </div>
  )
}

function SearchBox({ value, onChange, focusKey }: { value: string; onChange: (value: string) => void; focusKey: number }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 30, paddingLeft: 10, paddingRight: 6, gap: 8, borderRadius: 9, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <Icon name="search" size={15} color={C.muted} />
      <input
        key={focusKey}
        testId="notes-search"
        autoFocus={focusKey > 0}
        value={value}
        placeholder="Search notes"
        onChange={(event) => onChange(event.value ?? '')}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontFamily: FONT, color: C.text }}
      />
      {value ? <IconButton icon="x" size={12} pad={20} onClick={() => onChange('')} testId="notes-search-clear" /> : <text style={{ fontSize: 11.5, color: C.ghost, fontFamily: FONT }}>⌘F</text>}
    </div>
  )
}

type NoteItem = { key: string; label?: string; note?: Note }
/** Opens a note's right-click menu (see NotesPane). */
type NoteContext = (note: Note, event: ContextEvent) => void

/**
 * The notes, pinned first, in a virtual list: only the rows near the viewport mount and paint, so a
 * long list doesn't make every frame (each keystroke in the editor beside it) cost more.
 */
function NoteList({ notes, searching, selectedId, onSelect, onContext, resetKey }: { notes: Note[]; searching: boolean; selectedId: string | null; onSelect: (id: string) => void; onContext: NoteContext; resetKey: string }) {
  // Pinned first, then by when each was last edited; search results come by relevance, ungrouped.
  const items = useMemo(() => {
    const now = Date.now()
    const out: NoteItem[] = []
    let heading = ''
    for (const note of notes) {
      const group = searching ? '' : note.pinned ? 'Pinned' : noteGroup(note.updatedAt, now)
      if (group && group !== heading) out.push({ key: `label-${group}`, label: group })
      heading = group
      out.push({ key: note.id, note })
    }
    out.push({ key: 'end' })
    return out
  }, [notes, searching])
  const { start, end, generation, onVisibleRange } = useRowWindow(items.length, resetKey)
  return (
    <virtual-list testId="notes-list" key={generation} itemCount={items.length} estimatedItemHeight={62} windowStart={start} onVisibleRange={onVisibleRange} style={{ flexGrow: 1, minHeight: 0 }}>
      {items.slice(start, end).map((item) => (
        // The list has no padding or gap of its own: each row brings its share.
        <div key={item.key} style={{ width: '100%', paddingLeft: 8, paddingRight: 8, paddingBottom: item.note ? 2 : 0, display: 'flex', flexDirection: 'column' }}>
          {item.note ? <NoteRow note={item.note} active={item.note.id === selectedId} grouped={!searching} onSelect={onSelect} onContext={onContext} /> : item.label ? <GroupLabel label={item.label} /> : <div style={{ height: 10 }} />}
        </div>
      ))}
    </virtual-list>
  )
}

function GroupLabel({ label }: { label: string }) {
  const { C } = useSettings()
  return <text style={{ paddingLeft: 12, paddingTop: 10, paddingBottom: 4, fontSize: 11.5, fontWeight: 600, color: C.muted, fontFamily: FONT }}>{label}</text>
}

/** Memoized: with a stable onSelect and onContext, a search keystroke or a save elsewhere leaves unchanged rows alone. */
const NoteRow = memo(function NoteRow({ note, active, grouped, onSelect, onContext }: { note: Note; active: boolean; grouped: boolean; onSelect: (id: string) => void; onContext: NoteContext }) {
  const { C } = useSettings()
  const preview = notePreview(note)
  const progress = useMemo(() => checklistProgress(note.body), [note.body])
  const shown = liveFirst(note.links).slice(0, 2)
  const more = note.links.length - shown.length
  return (
    <div
      testId={`note-row-${note.id}`}
      onClick={() => onSelect(note.id)}
      onAuxClick={(event) => onContext(note, event)}
      style={{
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 9,
        paddingBottom: 9,
        borderRadius: 10,
        backgroundColor: active ? C.navSelected : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        cursor: 'pointer',
        hover: active ? undefined : { backgroundColor: C.overlay },
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, pointerEvents: 'none' }}>
        {note.pinned ? <Icon name="pin" size={12} color={C.accent} /> : null}
        <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: note.title.trim() || note.body.trim() ? C.text : C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {noteHeading(note)}
        </text>
        <text style={{ flexShrink: 0, fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{grouped ? rowTime(note.updatedAt) : formatWhen(note.updatedAt)}</text>
      </div>
      {preview ? <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{preview}</text> : null}
      {shown.length || progress ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingTop: 3, pointerEvents: 'none' }}>
          {progress ? <ChecklistBadge {...progress} /> : null}
          {shown.map((link) => (
            <LinkBadge key={link.id} link={link} />
          ))}
          {more > 0 ? <text style={{ flexShrink: 0, fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{`+${more}`}</text> : null}
        </div>
      ) : null}
    </div>
  )
})

/** "2/3" with a tick: how far along a note's checklist is, green once it's all done. */
function ChecklistBadge({ done, total }: { done: number; total: number }) {
  const { C } = useSettings()
  const complete = done === total
  return (
    <div testId="note-row-checklist" style={{ height: 20, paddingLeft: 6, paddingRight: 7, borderRadius: 6, backgroundColor: C.chip, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <Icon name="circleCheck" size={11} color={complete ? C.green : C.secondary} />
      <text style={{ fontSize: 11.5, color: complete ? C.green : C.secondary, fontFamily: FONT, whiteSpace: 'nowrap' }}>{`${done}/${total}`}</text>
    </div>
  )
}

/** What the list's right-click menu asks of the open note's editor. */
type EditorActions = { togglePin: () => void; remove: () => void }

const SAVE_LABEL: Record<SaveState, string> = { idle: '', pending: 'Editing…', saving: 'Saving…', saved: 'Saved', failed: 'Not saved' }

/** The editor's text column: the header, title, links and body all line up on it. */
const COLUMN = { width: '100%', maxWidth: 760, paddingLeft: 44, paddingRight: 44 } as const

type FormatButton = { icon?: IconName; label?: string; tip: string; format: ComposeFormat; testId: string }
/** The toolbar, in groups; each tip names the shortcut where there is one (see shortcutFormat). */
const FORMATS: FormatButton[][] = [
  [
    { label: 'H', tip: 'Heading', format: { kind: 'line', prefix: '## ', placeholder: 'Heading' }, testId: 'note-format-heading' },
    { icon: 'bold', tip: 'Bold  ⌘B', format: { kind: 'inline', before: '**', after: '**', placeholder: 'bold text' }, testId: 'note-format-bold' },
    { icon: 'italic', tip: 'Italic  ⌘I', format: { kind: 'inline', before: '_', after: '_', placeholder: 'italic text' }, testId: 'note-format-italic' },
    { icon: 'strikethrough', tip: 'Strikethrough  ⇧⌘X', format: { kind: 'inline', before: '~~', after: '~~', placeholder: 'strikethrough' }, testId: 'note-format-strike' },
  ],
  [
    { icon: 'list', tip: 'Bulleted list', format: { kind: 'line', prefix: '- ', placeholder: 'Item' }, testId: 'note-format-bullets' },
    { icon: 'listOrdered', tip: 'Numbered list', format: { kind: 'line', prefix: '1. ', placeholder: 'Item' }, testId: 'note-format-numbers' },
    { icon: 'listTodo', tip: 'Checklist  ⇧⌘L', format: { kind: 'line', prefix: '- [ ] ', placeholder: 'Task' }, testId: 'note-format-checklist' },
    { icon: 'quote', tip: 'Quote', format: { kind: 'line', prefix: '> ', placeholder: 'Quote' }, testId: 'note-format-quote' },
  ],
  [{ icon: 'link', tip: 'Link  ⌘K', format: { kind: 'inline', before: '[', after: '](https://)', placeholder: 'link text' }, testId: 'note-format-link' }],
]

function FormatBar({ onFormat }: { onFormat: (format: ComposeFormat) => void }) {
  const { C } = useSettings()
  return (
    <div testId="note-format-bar" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -6 }}>
      {FORMATS.map((group, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          {i > 0 ? <div style={{ width: 1, height: 16, backgroundColor: C.divider, marginLeft: 4, marginRight: 4 }} /> : null}
          {group.map((button) =>
            button.icon ? (
              <IconButton key={button.testId} icon={button.icon} size={15} pad={28} onClick={() => onFormat(button.format)} tooltip={button.tip} testId={button.testId} />
            ) : (
              <Tooltip key={button.testId} label={button.tip}>
                <div
                  testId={button.testId}
                  onClick={() => onFormat(button.format)}
                  style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
                >
                  <text style={{ fontSize: 14, fontWeight: 700, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>{button.label}</text>
                </div>
              </Tooltip>
            ),
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The open note. It opens to read, rendered, with checklist items to tick; a new or empty one opens
 * to write. Edit (or Enter, or a double-click on the text) writes, with a formatting toolbar in the
 * header; Done (or Esc, or ⌘Enter) goes back to reading. Everything saves as it changes.
 */
function NoteEditor({
  actions,
  note,
  autoFocus,
  onDelete,
  onOpenLink,
  eventsOpen,
}: {
  actions: { current: EditorActions | null }
  note: Note
  autoFocus: boolean
  onDelete: (note: Note) => void
  onOpenLink: (link: Link) => void
  eventsOpen: boolean
}) {
  const { C } = useSettings()
  const renderer = useGpuixRequired()
  const { saveNote, deleteNote, unlinkNote, notify } = useMailActions()
  const [title, setTitle] = useState(note.title)
  // Typing in the body doesn't re-render the editor (a render per keystroke cost a whole extra frame):
  // the field keeps its text, and this holds the latest of it for saving, reading and deleting.
  const body = useRef(note.body)
  const [editing, setEditing] = useState(autoFocus || !note.body.trim())
  // Whether the body field takes focus when it mounts: yes once asked to edit, not for a new note
  // (its title has it).
  const [focusBody, setFocusBody] = useState(false)
  // Remounts the body field when its text changes from outside it (formatting with nothing to wrap).
  const [bodyKey, setBodyKey] = useState(0)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const current = useRef({ title, body: body.current, links: note.links.length })
  current.current = { title, body: body.current, links: note.links.length }

  const autosave = useAutosave((value: { title: string; body: string }) => saveNote({ id: note.id, ...value }), {
    // A note left blank isn't worth keeping: leaving it deletes it rather than saving it.
    onUnmount: (saver) => {
      const { title, body, links } = current.current
      if (!title.trim() && !body.trim() && !links) {
        saver.cancel()
        void deleteNote(note.id)
      } else void saver.flush()
    },
  })
  // The page scrolls, not the body field (see follow-end.ts).
  const { page, field, follow } = useFollowEnd()
  const edit = (next: { title?: string; body?: string }) => {
    if (next.body !== undefined) {
      follow(body.current, next.body)
      body.current = current.current.body = next.body
    }
    const value = { title: next.title ?? title, body: body.current }
    if (next.title !== undefined) setTitle(next.title)
    autosave.schedule(value)
  }
  /** The body changed from outside the field: a ticked checkbox, or a format added at the end. */
  const setBody = (next: string) => {
    body.current = current.current.body = next
    autosave.schedule({ title, body: next })
    setBodyKey((n) => n + 1)
    rerender()
  }
  const startEditing = () => {
    setFocusBody(true)
    setEditing(true)
  }
  const stopEditing = () => setEditing(false)

  // Formatting goes through the field's native selection (see compose.tsx), so undo and the caret
  // behave; the field keeps focus through a toolbar click.
  const selection = () => {
    const id = field.current?.id
    return id !== undefined && renderer.getFocusedElementId?.() === id ? readEditorSnapshot() : null
  }
  const apply = (captured: EditorSnapshot, format: ComposeFormat) => {
    const replacement = composeFormatEdit(captured.value, { location: captured.location, length: captured.length }, format)
    return Boolean(replacement && replaceEditorSelection(captured, replacement))
  }
  const format = (format: ComposeFormat) => {
    const captured = selection()
    if (captured) {
      if (!apply(captured, format)) notify('The selection changed — try formatting again')
      return
    }
    // The field isn't focused (or there's no native bridge): add the format at the end.
    const prev = body.current
    setFocusBody(true)
    setBody(
      format.kind === 'inline'
        ? `${prev}${!prev || /\s$/.test(prev) ? '' : ' '}${format.before}${format.placeholder}${format.after}`
        : `${prev}${!prev || prev.endsWith('\n') ? '' : '\n'}${format.prefix}${format.placeholder}`,
    )
  }
  // A shortcut's range is captured during keyDown and applied once GPUI has finished the key event.
  const formatKey = (format: ComposeFormat) => {
    const captured = selection()
    const id = field.current?.id
    if (!captured) return
    setTimeout(() => {
      if (field.current?.id === id && renderer.getFocusedElementId?.() === id && !apply(captured, format)) notify('The selection changed — try formatting again')
    }, 0)
  }

  useKeys((press, { typing }) => {
    if (overlaysOpen()) return false
    const key = press.key?.toLowerCase()
    const m = press.modifiers ?? {}
    const enter = key === 'enter' || key === 'return'
    if (editing && (key === 'escape' || ((m.cmd || m.ctrl) && enter))) return (stopEditing(), true)
    if (!editing && !typing && !m.cmd && !m.ctrl && !m.alt && (enter || key === 'e')) return (startEditing(), true)
    return false
  })

  const togglePin = async () => {
    autosave.cancel()
    await saveNote({ id: note.id, title, body: body.current, pinned: !note.pinned })
  }

  const remove = () => {
    autosave.cancel()
    onDelete({ ...note, title, body: body.current })
  }
  actions.current = { togglePin: () => void togglePin(), remove }

  const saving = SAVE_LABEL[autosave.state]
  const words = editing ? 0 : wordCount(body.current)
  const footer = [`Created ${formatWhen(note.createdAt)}`, words ? `${words} ${words === 1 ? 'word' : 'words'}` : '', note.links.length ? `${note.links.length} ${note.links.length === 1 ? 'link' : 'links'}` : '']

  return (
    <div testId="note-editor" style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', justifyContent: 'center' }}>
        <div style={{ ...COLUMN, height: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {editing ? (
            <FormatBar onFormat={format} />
          ) : (
            <text testId="note-save-state" style={{ fontSize: 12.5, color: autosave.state === 'failed' ? C.accent : C.muted, fontFamily: FONT }}>
              {saving || `Edited ${formatWhen(note.updatedAt)}`}
            </text>
          )}
          <div style={{ flexGrow: 1 }} />
          {editing && saving ? (
            <text testId="note-save-state" style={{ fontSize: 12, color: autosave.state === 'failed' ? C.accent : C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>
              {saving}
            </text>
          ) : null}
          <IconButton icon="pin" size={15} pad={30} active={note.pinned} color={note.pinned ? C.accent : undefined} onClick={() => void togglePin()} tooltip={note.pinned ? 'Unpin' : 'Pin to top'} testId="note-pin" />
          <IconButton icon="trash" size={15} pad={30} onClick={remove} tooltip="Delete note" testId="note-delete" />
          <div style={{ marginLeft: 4 }}>
            <Button label={editing ? 'Done' : 'Edit'} icon={editing ? 'check' : 'pencil'} variant={editing ? 'primary' : 'secondary'} onClick={editing ? stopEditing : startEditing} testId="note-edit-toggle" />
          </div>
        </div>
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div ref={page} style={{ ...COLUMN, flexGrow: 1, minHeight: 0, paddingTop: 14, paddingBottom: 24, overflowY: 'scroll', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            testId="note-title"
            autoFocus={autoFocus}
            value={title}
            placeholder="Title"
            onChange={(event) => edit({ title: event.value ?? '' })}
            style={{ fontSize: 26, fontWeight: 700, fontFamily: FONT, color: C.text, height: 38 }}
          />
          {note.links.length ? (
            <div testId="note-links" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {liveFirst(note.links).map((link) => (
                <LinkChip key={link.id} link={link} onOpen={onOpenLink} eventsOpen={eventsOpen} onRemove={() => void unlinkNote(link.id)} testId={`note-link-${link.id}`} />
              ))}
            </div>
          ) : null}
          <div style={{ height: 1, flexShrink: 0, backgroundColor: C.divider, marginTop: 2 }} />
          {editing ? (
            <textarea
              key={bodyKey}
              ref={field}
              testId="note-body"
              autoFocus={focusBody}
              value={body.current}
              placeholder="Start writing. Markdown works, or use the toolbar above."
              minRows={10}
              // Grows with the text; the page around it scrolls.
              maxRows={100000}
              onChange={(event) => edit({ body: event.value ?? '' })}
              onKeyDown={(event) => {
                const shortcut = shortcutFormat(event)
                if (shortcut) formatKey(shortcut)
              }}
              // Its own height, not stretched to the page: a stretched child made the page scroll by its padding.
              style={{ flexShrink: 0, fontSize: 15, lineHeight: 24, fontFamily: FONT, color: C.text }}
            />
          ) : (
            <NoteReader
              source={body.current}
              onToggle={(line) => {
                // A tick is a finished change: saved now, so the list's progress follows at once.
                setBody(toggleTask(body.current, line))
                void autosave.flush()
              }}
              onEdit={startEditing}
            />
          )}
          {editing ? null : (
            <text testId="note-footer" style={{ flexShrink: 0, fontSize: 12, color: C.ghost, fontFamily: FONT }}>
              {footer.filter(Boolean).join(' · ')}
            </text>
          )}
        </div>
      </div>
    </div>
  )
}

/** The note rendered: its Markdown, with checklist items as boxes that tick in place. */
function NoteReader({ source, onToggle, onEdit }: { source: string; onToggle: (line: number) => void; onEdit: () => void }) {
  const { C } = useSettings()
  const blocks = useMemo(() => noteBlocks(source), [source])
  return (
    <div
      testId="note-read"
      // A double-click on the text starts editing, like opening a document to change it.
      onClick={(event) => {
        if ((event.clickCount ?? 1) >= 2) onEdit()
      }}
      style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {blocks.map((block, i) =>
        block.kind === 'text' ? <MailMarkdown key={`text-${i}`} source={block.source} /> : <ChecklistItem key={`task-${block.line}`} task={block} onToggle={onToggle} />,
      )}
      {/* The page under the text is where you'd start writing: a click there edits. */}
      <div testId="note-read-rest" onClick={onEdit} style={{ height: 160, paddingTop: 4, cursor: 'text' }}>
        {blocks.length ? null : <text style={{ fontSize: 14, color: C.ghost, fontFamily: FONT, pointerEvents: 'none' }}>Empty note. Click to write.</text>}
      </div>
    </div>
  )
}

function ChecklistItem({ task, onToggle }: { task: Extract<NoteBlock, { kind: 'task' }>; onToggle: (line: number) => void }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingLeft: task.indent * 24 }}>
      <div
        testId={`note-task-${task.line}`}
        role="button"
        aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
        onClick={() => onToggle(task.line)}
        style={{
          width: 18,
          height: 18,
          marginTop: 2,
          flexShrink: 0,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: task.done ? C.accent : C.muted,
          backgroundColor: task.done ? C.accent : undefined,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          hover: { borderColor: C.accent },
        }}
      >
        {task.done ? <Icon name="check" size={12} color={C.onAccent} /> : null}
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, opacity: task.done ? 0.5 : 1 }}>
        {task.text ? <MailMarkdown source={task.text} /> : <text style={{ fontSize: 14, color: C.ghost, fontFamily: FONT }}>Task</text>}
      </div>
    </div>
  )
}

function EmptyState({ icon, title, detail, action }: { icon: 'file' | 'search'; title: string; detail: string; action?: React.ReactNode }) {
  const { C } = useSettings()
  return (
    <div testId="notes-empty" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, paddingBottom: 40 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: C.raised, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
        <Icon name={icon} size={24} color={C.secondary} />
      </div>
      <text style={{ fontSize: 17, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</text>
      <text style={{ maxWidth: 340, fontSize: 13.5, lineHeight: 20, color: C.muted, fontFamily: FONT, textAlign: 'center' }}>{detail}</text>
      {action ? <div style={{ paddingTop: 8 }}>{action}</div> : null}
      {action ? <text style={{ fontSize: 12, color: C.ghost, fontFamily: FONT }}>or press N</text> : null}
    </div>
  )
}
