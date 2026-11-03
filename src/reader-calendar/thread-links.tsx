import { useRef, useState } from 'react'
import type { MailThread, Message } from '../data'
import type { CalendarEvent, Note } from '../engine'
import { IconButton } from '../icons'
import { useCalendars, useNotes, useThreadEvents, useThreadNotes, useThreadTasks } from '../local-data'
import { useNow } from '../calendar/hooks'
import { TaskLinkChip, openTask } from '../tasks'
import { READ_PAD_LEFT, READ_PAD_RIGHT } from '../theme'
import { useMailActions } from '../store'
import { Menu, MenuItem, MenuLabel, MenuSeparator, useToggle } from '../ui'
import { addToNewNote, appendToNote } from './actions'
import { LinkChip } from './bits'
import { useReaderSeams } from './seams'
import { formatWhen, userTimeZone } from './suggest'

// Notes, events and tasks linked to the conversation, as chips under its subject, and the toolbar's
// "Add to notes".

/** What the chips show, events first (soonest first), then notes (latest edit first). */
export function threadChips(events: CalendarEvent[], notes: Note[], timeZone = userTimeZone(), locale?: string) {
  const live = events.filter((e) => e.status !== 'cancelled').sort((a, b) => a.startAt - b.startAt)
  return [
    ...live.map((event) => ({
      kind: 'event' as const,
      id: event.id,
      label: event.title || 'Untitled event',
      detail: formatWhen({ start: event.startAt, end: event.endAt, allDay: event.allDay }, event.allDay ? 'UTC' : timeZone, locale),
      calendarId: event.calendarId,
      event,
    })),
    ...[...notes].sort((a, b) => b.updatedAt - a.updatedAt).map((note) => ({ kind: 'note' as const, id: note.id, label: note.title || 'Untitled note', detail: undefined, calendarId: undefined, note })),
  ]
}

export function ThreadLinks({ thread }: { thread: MailThread }) {
  const { accountOf, notify, setTaskDone } = useMailActions()
  const seams = useReaderSeams()
  const now = useNow()
  const accountId = accountOf(thread.id).id
  const events = useThreadEvents(accountId, thread.id)
  const notes = useThreadNotes(accountId, thread.id)
  const tasks = useThreadTasks(accountId, thread.id) ?? []
  const calendars = useCalendars()
  const chips = threadChips(events ?? [], notes ?? [])
  if (!chips.length && !tasks.length) return null
  return (
    <div testId="thread-links" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: READ_PAD_LEFT, paddingRight: READ_PAD_RIGHT, paddingTop: 10 }}>
      {chips.map((chip) =>
        chip.kind === 'event' ? (
          <LinkChip
            key={chip.id}
            icon="calendar"
            dot={calendars.find((c) => c.id === chip.calendarId)?.color}
            label={chip.label}
            detail={chip.detail}
            testId={`thread-link-event-${chip.id}`}
            onPress={() => (seams.openEvent ? seams.openEvent(chip.event) : notify(`“${chip.label}” · ${chip.detail}`))}
          />
        ) : (
          <LinkChip
            key={chip.id}
            icon="file"
            label={chip.label}
            testId={`thread-link-note-${chip.id}`}
            // TODO(lume-fwl.4): the notes view, through ReaderCalendarSeams.openNote.
            onPress={() => (seams.openNote ? seams.openNote(chip.note) : notify(`Note “${chip.label}”`))}
          />
        ),
      )}
      {tasks.map((task) => (
        <TaskLinkChip key={task.id} task={task} now={now} onToggle={() => void setTaskDone(task.id, task.status !== 'done' && task.status !== 'canceled')} onOpen={() => openTask(task.id)} />
      ))}
    </div>
  )
}

/** The toolbar button: the latest message into a new note, or onto the end of a recent one. */
export function AddToNotesButton({ thread }: { thread: MailThread }) {
  const menu = useToggle()
  // The reader keeps this button from one conversation to the next: a menu open for the last one closes.
  const shownFor = useRef(thread.id)
  if (shownFor.current !== thread.id) {
    shownFor.current = thread.id
    if (menu.open) menu.close()
  }
  return (
    <div style={{ flexShrink: 0 }}>
      <IconButton icon="pencil" size={17} active={menu.open} tooltip="Add to notes" onClick={menu.toggle} testId="action-add-to-notes" />
      {menu.open ? <AddToNotesMenu thread={thread} message={latestMessage(thread)} onClose={menu.close} /> : null}
    </div>
  )
}

const latestMessage = (thread: MailThread): Message => [...thread.messages].reverse().find((m) => !m.status) ?? thread.messages.at(-1)!

function AddToNotesMenu({ thread, message, onClose }: { thread: MailThread; message: Message; onClose: () => void }) {
  const actions = useMailActions()
  const recent = (useNotes() ?? []).slice(0, 5)
  const [busy, setBusy] = useState(false)
  const done = (note: Note | null, verb: string) => {
    setBusy(false)
    onClose()
    if (!note) return
    // TODO(lume-fwl.4): offer "Open" once the notes view exists (seams.openNote).
    actions.notify(`${verb} “${note.title}”`)
  }
  const createNew = async () => {
    if (busy) return
    setBusy(true)
    done(await addToNewNote(actions, thread, message), 'Saved to')
  }
  const append = async (noteId: string) => {
    if (busy) return
    setBusy(true)
    done(await appendToNote(actions, noteId, thread, message), 'Added to')
  }
  return (
    <Menu open onClose={onClose} align="end" width={250} testId="add-to-notes-menu">
      <MenuLabel>Add this email to notes</MenuLabel>
      <MenuItem icon="plus" label="New note" testId="add-to-notes-new" onSelect={() => void createNew()} />
      {recent.length ? (
        <>
          <MenuSeparator />
          <MenuLabel>Add to a recent note</MenuLabel>
          {recent.map((note) => (
            <MenuItem key={note.id} icon="file" label={note.title || 'Untitled note'} testId={`add-to-notes-${note.id}`} onSelect={() => void append(note.id)} />
          ))}
        </>
      ) : null}
    </Menu>
  )
}

/** The message menu's "Add to notes": straight into a new note, no picker. */
export async function addMessageToNotes(actions: ReturnType<typeof useMailActions>, thread: MailThread, message: Message) {
  const note = await addToNewNote(actions, thread, message)
  if (note) actions.notify(`Saved to “${note.title}”`)
}
