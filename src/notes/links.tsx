import { useState } from 'react'
import type { Link, Note } from '../engine'
import { Icon, IconButton } from '../icons'
import { useThreadNotes } from '../local-data'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'
import { Tooltip } from '../tooltip'
import { formatWhen, linkView, mailDestination, noteHeading, notePreview } from './model'
import { openNote } from './open'

// ---------------------------------------------------------------------------
// Link chips (what a note points at) and note chips (which notes point at a conversation). Both
// read from snapshots, so they still say something useful once the mail or event is gone.
// ---------------------------------------------------------------------------

/**
 * Opens what a link points at, if it can: live mail goes through showThread (which switches
 * account). Events open through `onEvent` when the calendar provides one.
 */
export function useOpenLink(onEvent?: (eventId: string) => void) {
  const { showThread } = useMailActions()
  return (link: Pick<Link, 'target' | 'live'>) => {
    if (!link.live) return
    const mail = mailDestination(link.target)
    if (mail) return showThread(mail.accountId, mail.threadId)
    if (link.target.kind === 'event') onEvent?.(link.target.eventId)
  }
}

/**
 * One link, as a chip: icon, who or what, and the subject or time. Live links open on click; gone
 * ones keep their snapshot in a muted style. `onRemove` adds the ×.
 */
export function LinkChip({
  link,
  onOpen,
  onRemove,
  eventsOpen = false,
  testId,
}: {
  link: Link
  onOpen?: (link: Link) => void
  onRemove?: () => void
  /** Whether event links can open (the calendar gave a way); otherwise they only show time and title. */
  eventsOpen?: boolean
  testId?: string
}) {
  const { C } = useSettings()
  const view = linkView(link)
  const live = view.state === 'live'
  const opens = live && !!onOpen && (link.target.kind === 'event' ? eventsOpen : link.target.kind !== 'contact')
  // Remove shows on hover only, so a row of chips reads as links rather than a row of × buttons.
  const [hovered, setHovered] = useState(false)
  const chip = (
    <div
      testId={testId}
      onClick={opens ? () => onOpen!(link) : undefined}
      onMouseEnter={onRemove ? () => setHovered(true) : undefined}
      onMouseLeave={onRemove ? () => setHovered(false) : undefined}
      style={{
        height: 30,
        maxWidth: 380,
        paddingLeft: 9,
        paddingRight: onRemove ? 4 : 11,
        borderRadius: 15,
        // A dead link keeps a faint outline so it still reads as a chip without a fill.
        borderWidth: live ? 0 : 1,
        borderColor: C.divider,
        backgroundColor: live ? C.overlay : undefined,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        cursor: opens ? 'pointer' : 'default',
        hover: opens ? { backgroundColor: C.overlayStrong } : undefined,
      }}
    >
      <div style={{ pointerEvents: 'none', display: 'flex' }}>
        <Icon name={view.icon} size={13} color={live ? (view.icon === 'calendar' ? C.accent : C.secondary) : C.ghost} />
      </div>
      <text style={{ flexShrink: 0, maxWidth: 150, fontSize: 12.5, fontWeight: 500, color: live ? C.text : C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
        {view.primary}
      </text>
      {view.secondary ? (
        <text style={{ flexShrink: 1, minWidth: 0, fontSize: 12.5, color: live ? C.secondary : C.ghost, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
          {view.secondary}
        </text>
      ) : null}
      {view.when ? <text style={{ flexShrink: 0, fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{view.when}</text> : null}
      {live ? null : (
        <text style={{ flexShrink: 0, fontSize: 11, fontWeight: 500, color: C.ghost, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {view.state === 'detached' ? 'Account removed' : 'Gone'}
        </text>
      )}
      {onRemove ? (
        // Its room is kept while hidden, so the chip doesn't change width under the pointer.
        <div style={{ width: 20, height: 20, flexShrink: 0, display: 'flex' }}>
          {hovered ? <IconButton icon="x" size={11} pad={20} onClick={onRemove} tooltip="Remove link" testId={testId ? `${testId}-remove` : undefined} /> : null}
        </div>
      ) : null}
    </div>
  )
  return view.note ? <Tooltip label={view.note}>{chip}</Tooltip> : chip
}

/** A small badge for a list row: the link's icon and who or what, nothing clickable. */
export function LinkBadge({ link }: { link: Link }) {
  const { C } = useSettings()
  const view = linkView(link)
  const live = view.state === 'live'
  return (
    <div style={{ height: 20, maxWidth: 150, paddingLeft: 6, paddingRight: 7, borderRadius: 10, backgroundColor: C.chip, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>
      <Icon name={view.icon} size={11} color={live ? C.secondary : C.ghost} />
      <text style={{ flexShrink: 1, minWidth: 0, fontSize: 11.5, color: live ? C.secondary : C.ghost, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{view.primary}</text>
    </div>
  )
}

/**
 * A note as a compact card: title, first line, when it was edited. For the reader's "Notes" section
 * beside an email; click opens it in the notes view (or `onOpen`, when given).
 */
export function NoteChip({ note, onOpen, testId }: { note: Note; onOpen?: (noteId: string) => void; testId?: string }) {
  const { C } = useSettings()
  const preview = notePreview(note)
  return (
    <div
      testId={testId ?? `note-chip-${note.id}`}
      onClick={() => (onOpen ?? openNote)(note.id)}
      style={{
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 9,
        paddingBottom: 9,
        borderRadius: 12,
        backgroundColor: C.raised,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        cursor: 'pointer',
        hover: { backgroundColor: C.raisedHover },
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, pointerEvents: 'none' }}>
        <Icon name={note.pinned ? 'pin' : 'file'} size={13} color={note.pinned ? C.accent : C.secondary} />
        <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{noteHeading(note)}</text>
        <text style={{ flexShrink: 0, fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{formatWhen(note.updatedAt)}</text>
      </div>
      {preview ? (
        <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{preview}</text>
      ) : null}
    </div>
  )
}

/**
 * The notes linked to a conversation (or any of its messages), as NoteChips; nothing at all when
 * there are none, so it can sit in the reader unconditionally.
 */
export function LinkedNotesList({ accountId, threadId, onOpen }: { accountId: string; threadId: string; onOpen?: (noteId: string) => void }) {
  const { C } = useSettings()
  const notes = useThreadNotes(accountId, threadId)
  if (!notes?.length) return null
  return (
    <div testId="thread-notes" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <text style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, fontFamily: FONT }}>{notes.length === 1 ? 'Note' : `Notes · ${notes.length}`}</text>
      {notes.map((note) => (
        <NoteChip key={note.id} note={note} onOpen={onOpen} />
      ))}
    </div>
  )
}
