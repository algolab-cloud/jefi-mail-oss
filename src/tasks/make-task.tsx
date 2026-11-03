import { useEffect, useRef, useState } from 'react'
import type { MailThread, Message } from '../data'
import type { Task } from '../engine'
import { IconButton } from '../icons'
import { useOverlay } from '../overlays'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'
import { toast } from '../toast'
import { Button } from '../ui'
import { aiErrorMessage, suggestTasks } from '../ai'
import { useAi } from '../use-ai'
import { Icon } from '../icons'
import { LinkAction, Pressable } from '../reader-calendar/bits'
import { userTimeZone } from '../reader-calendar/suggest'
import { dueShortcuts, dueText, taskDraftFromMessage, withDueDay, type TaskDraft, type TaskDue } from './model'
import { openTask } from './open'
import { parseTaskSuggestions, todayForPrompt, type TaskSuggestion } from './suggest'

// ---------------------------------------------------------------------------
// "Make task" from an email: the reader's toolbar button (and the `t` key, through
// requestMakeTask) opens a small form with the subject as the title and the first date the email
// mentions as the due; saving links the task to the message and its conversation.
// ---------------------------------------------------------------------------

/** The writes this needs (useMailActions() has them all). */
export type TaskWrites = Pick<ReturnType<typeof useMailActions>, 'saveTask' | 'threadTarget' | 'messageTarget'>

/** Saves a task made from `message`, linked to it and its conversation. */
export function saveTaskFromEmail(actions: TaskWrites, draft: TaskDraft, thread: Pick<MailThread, 'id'>, message: Pick<Message, 'id'>, origin: Task['origin'] = 'email') {
  return actions.saveTask({ ...draft, title: draft.title.trim(), origin, links: [actions.threadTarget(thread.id), actions.messageTarget(thread.id, message.id)] })
}

/** "Task added", with a way to open it. */
export const announceTask = (task: Task) => toast('Task added', { description: task.title, action: { label: 'Open', onClick: () => openTask(task.id) } })

const latestMessage = (thread: MailThread): Message => [...thread.messages].reverse().find((m) => !m.status) ?? thread.messages.at(-1)!

// The `t` key reaches whichever reader is showing that conversation.
const listeners = new Set<(threadId: string) => void>()
export function requestMakeTask(threadId: string) {
  for (const listener of listeners) listener(threadId)
}

/** The toolbar button, and the form it opens for the latest message. */
export function MakeTaskButton({ thread }: { thread: MailThread }) {
  const [open, setOpen] = useState(false)
  const threadRef = useRef(thread.id)
  // The reader keeps this button from one conversation to the next: a popover open for the last one closes.
  if (threadRef.current !== thread.id && open) setOpen(false)
  threadRef.current = thread.id
  useEffect(() => {
    const listener = (threadId: string) => threadId === threadRef.current && setOpen(true)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
  return (
    <div style={{ flexShrink: 0 }}>
      <IconButton icon="circleCheck" size={17} active={open} tooltip="Make task  T" onClick={() => setOpen((v) => !v)} testId="action-make-task" />
      {open ? <MakeTaskPopover thread={thread} message={latestMessage(thread)} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

export function MakeTaskPopover({ thread, message, onClose }: { thread: MailThread; message: Message; onClose: () => void }) {
  const { C, settings } = useSettings()
  const actions = useMailActions()
  const [now] = useState(() => Date.now())
  const [initial] = useState(() => taskDraftFromMessage(thread, message, now))
  const [title, setTitle] = useState(initial.title)
  const [due, setDue] = useState<TaskDue>({ dueAt: initial.dueAt, dueAllDay: initial.dueAllDay })
  const [saving, setSaving] = useState(false)
  useOverlay(true)

  // The date the email mentions first, then the usual picks; "No date" last.
  const found = initial.dueAt !== null ? [{ key: 'found', label: dueText(initial, now), due: { dueAt: initial.dueAt, dueAllDay: initial.dueAllDay } }] : []
  const picks = [
    ...found,
    ...dueShortcuts(now).map((s) => ({ key: s.label.toLowerCase().replace(/\s+/g, '-'), label: s.label, due: withDueDay({ dueAt: null, dueAllDay: true }, s.day) })),
    { key: 'none', label: 'No date', due: { dueAt: null, dueAllDay: false } as TaskDue },
  ].filter((p, i, all) => all.findIndex((q) => q.due.dueAt === p.due.dueAt && q.due.dueAllDay === p.due.dueAllDay) === i)

  const add = async (typed = title) => {
    if (saving || !typed.trim()) return
    setSaving(true)
    const task = await saveTaskFromEmail(actions, { title: typed, ...due }, thread, message)
    setSaving(false)
    if (!task) return
    announceTask(task)
    onClose()
  }

  return (
    <anchored side="bottom" align="end" gap={6} fit="snap" deferred priority={2} occlude style={{ backgroundColor: C.raised, borderRadius: 12 }}>
      <div
        testId="make-task"
        onMouseDownOutside={onClose}
        style={{
          width: 340,
          borderRadius: 12,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: 0, color: settings.theme === 'dark' ? '#00000077' : '#00000026' },
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <text style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>Make a task</text>
        <input
          testId="make-task-title"
          autoFocus
          value={title}
          placeholder="What needs doing?"
          onChange={(event) => setTitle(event.value ?? '')}
          // Enter on a GPUIX input arrives as submit, not as a keydown, with the text as typed: the
          // title state can still be a keystroke behind when Enter follows quickly.
          onSubmit={(event) => void add(event.value ?? title)}
          onKeyDown={(event) => {
            if (event.key === 'escape') onClose()
          }}
          style={{ height: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 7, backgroundColor: C.overlay, fontSize: 13.5, fontFamily: FONT, color: C.text }}
        />
        <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted, fontFamily: FONT }}>Due</text>
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {picks.map((pick) => {
            const selected = pick.due.dueAt === due.dueAt && pick.due.dueAllDay === due.dueAllDay
            return (
              <Pressable
                key={pick.key}
                label={pick.label}
                testId={`make-task-due-${pick.key}`}
                onPress={() => setDue(pick.due)}
                style={{
                  height: 24,
                  paddingLeft: 9,
                  paddingRight: 9,
                  borderRadius: 12,
                  backgroundColor: selected ? C.overlayStrong : C.overlay,
                  display: 'flex',
                  alignItems: 'center',
                  hover: { backgroundColor: C.overlayStrong },
                }}
              >
                <text style={{ fontSize: 12, color: selected ? C.text : C.secondary, fontFamily: FONT, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{pick.label}</text>
              </Pressable>
            )
          })}
        </div>
        <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>The task links back to this email.</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <div style={{ flexGrow: 1 }} />
          <Button label="Cancel" variant="ghost" onClick={onClose} testId="make-task-cancel" />
          <Button label={saving ? 'Adding…' : 'Add task'} variant="primary" disabled={saving || !title.trim()} onClick={() => void add()} testId="make-task-save" />
        </div>
        <SuggestedTasks thread={thread} now={now} />
      </div>
    </anchored>
  )
}

/** The message a suggestion quotes, so its task links to the email that asked; the latest otherwise. */
function messageForQuote(thread: MailThread, quote: string): Message {
  const needle = quote.toLowerCase().replace(/\s+/g, ' ').trim()
  const text = (m: Message) => (m.markdown ?? m.paragraphs.map((p) => (Array.isArray(p) ? p.join(' ') : p)).join(' ')).toLowerCase().replace(/\s+/g, ' ')
  return (needle && [...thread.messages].reverse().find((m) => text(m).includes(needle))) || latestMessage(thread)
}

type SuggestState = { state: 'idle' | 'loading' | 'done' } | { state: 'error'; error: string }

/**
 * "Suggest tasks with Claude": the person's own model reads the conversation and proposes action
 * items; nothing is saved until one is added. Only offered with AI switched on (Settings).
 */
function SuggestedTasks({ thread, now }: { thread: MailThread; now: number }) {
  const { C } = useSettings()
  const ai = useAi()
  const actions = useMailActions()
  const [status, setStatus] = useState<SuggestState>({ state: 'idle' })
  const [items, setItems] = useState<TaskSuggestion[]>([])
  const [added, setAdded] = useState<ReadonlySet<number>>(new Set())
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  if (!ai.connection) return null
  const connection = ai.connection

  const run = () => {
    abort.current?.abort()
    const controller = (abort.current = new AbortController())
    const timeZone = userTimeZone()
    const me = actions.accountOf(thread.id)
    setStatus({ state: 'loading' })
    suggestTasks(connection, thread, { name: me.name, email: me.email }, { today: todayForPrompt(now, timeZone), timeZone }, { onText: () => {}, signal: controller.signal })
      .then((text) => {
        if (controller.signal.aborted) return
        setItems(parseTaskSuggestions(text, timeZone))
        setAdded(new Set())
        setStatus({ state: 'done' })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus({ state: 'error', error: aiErrorMessage(error) })
      })
  }

  const addOne = async (index: number) => {
    const item = items[index]
    if (!item || added.has(index)) return
    const task = await saveTaskFromEmail(actions, { title: item.title, dueAt: item.dueAt, dueAllDay: item.dueAllDay }, thread, messageForQuote(thread, item.quote), 'ai')
    if (task) setAdded((prev) => new Set(prev).add(index))
  }

  return (
    <div testId="make-task-suggestions" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTopWidth: 1, borderColor: C.divider }}>
      {status.state === 'idle' ? (
        <LinkAction icon="sparkles" label={`Suggest tasks with ${ai.providerName}`} onPress={run} testId="make-task-suggest" />
      ) : status.state === 'loading' ? (
        <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{`${ai.providerName} is reading the conversation…`}</text>
      ) : status.state === 'error' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <text style={{ fontSize: 12.5, color: C.accent, fontFamily: FONT }}>{status.error}</text>
          <LinkAction label="Try again" onPress={run} testId="make-task-suggest-retry" />
        </div>
      ) : items.length === 0 ? (
        <text testId="make-task-suggest-none" style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{`${ai.providerName} found nothing you’ve been asked to do.`}</text>
      ) : (
        <>
          <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted, fontFamily: FONT }}>{`Suggested by ${ai.providerName}`}</text>
          {items.map((item, index) => {
            const done = added.has(index)
            const due = dueText(item, now)
            return (
              <div key={index} testId={`make-task-suggestion-${index}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name={done ? 'circleCheck' : 'sparkles'} size={13} color={done ? C.green : C.purple} />
                <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <text style={{ fontSize: 13, color: done ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.title}</text>
                  {due ? <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{due}</text> : null}
                </div>
                {done ? <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>Added</text> : <LinkAction label="Add" onPress={() => void addOne(index)} testId={`make-task-suggestion-add-${index}`} />}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

/** The message menu's "Make task": straight in from the draft, no form. */
export async function makeTaskFromMessage(actions: TaskWrites, thread: MailThread, message: Message) {
  const task = await saveTaskFromEmail(actions, taskDraftFromMessage(thread, message, Date.now()), thread, message)
  if (task) announceTask(task)
}
