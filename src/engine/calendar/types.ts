// ---------------------------------------------------------------------------
// Calendar and notes data as the engine hands it to the UI. Plain JSON: every value crosses the
// worker boundary. Times are epoch ms UTC; see docs/calendar-notes-architecture.md for the rules.
// ---------------------------------------------------------------------------

/**
 * 'local': Jefi's own calendars, the only kind that exists today. 'subscription' is reserved for
 * read-only iCal URL subscriptions (url + refresh state are in the schema; nothing fetches yet).
 */
export type CalendarSource = 'local' | 'subscription'

export type Calendar = {
  id: string
  source: CalendarSource
  name: string
  /** Any CSS colour the person picked. */
  color: string
  /** False for subscriptions. */
  canWrite: boolean
  /** Where new events go when the editor doesn't pick a calendar. Exactly one calendar is the default. */
  isDefault: boolean
  /** Left out of listEvents unless asked for by id. */
  hidden: boolean
  /** A subscription's iCal URL; null for local calendars. */
  url: string | null
  createdAt: number
  updatedAt: number
}

export type CalendarPatch = Partial<Pick<Calendar, 'name' | 'color' | 'hidden'>> & { isDefault?: true }

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'
export type Organizer = { email: string; name?: string }
/** iCalendar PARTSTAT, lowercased. */
export type PartStat = 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated'
export type Attendee = {
  email: string
  name?: string
  role?: 'required' | 'optional' | 'chair' | 'non-participant'
  partstat?: PartStat
  /** The organizer asked this attendee for a reply (RSVP=TRUE). */
  rsvp?: boolean
  /**
   * This attendee is the Jefi account the event speaks as (the address a received invite reached).
   * An event this attendee declined stays stored but is left out of listEvents.
   */
  self?: boolean
}

export type CalendarEvent = {
  id: string
  calendarId: string
  /**
   * iCalendar UID, stable for the event's life and shared by a series and its exceptions. Jefi makes
   * one for its own events; an event made from a received invite keeps the organizer's, which is how
   * the organizer's later updates, cancellations and attendees' replies find it (eventByUid).
   */
  uid: string
  /** iCalendar SEQUENCE: the organizer's revision. Jefi bumps it when it edits time, place or recurrence. */
  sequence: number
  /**
   * The Jefi account this event speaks as over email: the organizer's account when Jefi sends the
   * invitations, or the account that received the invite (whose address answers it). Null for a
   * private event nobody is invited to.
   */
  accountId: string | null
  title: string
  /**
   * Epoch ms. A timed event's instants; an all-day event's dates as UTC midnights, `endAt`
   * exclusive (a one-day event on 3 March is 3 March 00:00Z → 4 March 00:00Z) and `timeZone` null.
   */
  startAt: number
  endAt: number
  allDay: boolean
  /** IANA zone the event was made in, which recurrence follows; null for all-day events. */
  timeZone: string | null
  location: string | null
  /** Plain text or markdown. */
  description: string | null
  url: string | null
  status: EventStatus
  organizer: Organizer | null
  attendees: Attendee[]
  /** RRULE text (no `RRULE:` prefix) on a recurring series; null otherwise. */
  recurrence: string | null
  /** Occurrence starts removed from a series. */
  exdates: number[]
  /** For an exception to a series (one occurrence edited): its series. */
  recurringMasterId: string | null
  /** The start the occurrence had in its series before it was edited (RECURRENCE-ID). */
  recurrenceId: number | null
  /**
   * Alerts, in minutes before the start (negative: after it). An all-day event's count from local
   * midnight of its first day, so -540 is 9:00 on the day and 900 is 9:00 the day before. Null
   * means the person's default for the kind of event; [] means none.
   */
  alarms: number[] | null
  /** The received message this event came from (an invite), when there was one. */
  invite: EventLink | null
  createdAt: number
  updatedAt: number
}

/**
 * One occurrence in a listed range: the event itself for a single event (key = its id), or a copy
 * of the series with this occurrence's start and end (key = `${id}@${start}`). `recurring` marks
 * occurrences of a series, which edit and delete with a scope.
 */
export type EventOccurrence = CalendarEvent & { key: string; recurring: boolean; occurrenceStart: number }

export type EventInput = {
  /** Present to update an existing event (a series, an exception or a single event). */
  id?: string
  /**
   * Defaults to the default calendar. On an update, another calendar moves the event there: a
   * series moves with its exceptions, and one occurrence can't move on its own.
   */
  calendarId?: string
  /** Only when creating: the UID from a received invite. Jefi makes one otherwise. */
  uid?: string
  /** The organizer's SEQUENCE from an invite. Left out, Jefi bumps it on edits to time, place or recurrence. */
  sequence?: number
  accountId?: string | null
  title: string
  startAt: number
  endAt: number
  allDay?: boolean
  /** Defaults to the engine's zone for timed events; ignored for all-day ones. */
  timeZone?: string | null
  location?: string | null
  description?: string | null
  url?: string | null
  status?: EventStatus
  organizer?: Organizer | null
  attendees?: Attendee[]
  recurrence?: string | null
  /** See CalendarEvent.alarms; left out, an update keeps what the event had. */
  alarms?: number[] | null
  /** The received invite message the event is made from (or updated by): linked as the event's invite. */
  invite?: Extract<MailLinkTarget, { kind: 'message' }>
  /** Mail to link the event to as it's saved (an event made from an email). */
  links?: MailLinkTarget[]
}

/**
 * Which part of a series a change to an occurrence covers. `occurrenceStart` names the occurrence
 * (EventOccurrence.occurrenceStart); 'all' needs none.
 */
export type SeriesScope = 'this' | 'following' | 'all'
export type SaveEventOptions = { scope?: SeriesScope; occurrenceStart?: number }

// --- Reminders ----------------------------------------------------------------

/**
 * The person's alerts for events that don't choose their own, in CalendarEvent.alarms minutes, and
 * for tasks with a due time or date (Task.alarms minutes; none when left out).
 */
export type ReminderDefaults = { timed: number[]; allDay: number[]; taskTimed?: number[]; taskAllDay?: number[] }

/**
 * One alert of one occurrence, or of a task (`kind: 'task'`, `eventId` is the task's id and
 * `occurrenceStart`/`startAt` its due). `fireAt` is when it's due; the rest is what the banner shows.
 */
export type Reminder = {
  kind?: 'event' | 'task'
  eventId: string
  /** The occurrence's start (its key in a series); an all-day one's UTC midnight. */
  occurrenceStart: number
  title: string
  location: string | null
  startAt: number
  endAt: number
  allDay: boolean
  /** Whether the event is part of a series (the calendar opens the occurrence, not the series). */
  recurring: boolean
  minutesBefore: number
  fireAt: number
}

// --- Links ------------------------------------------------------------------

/**
 * Mail a note or event points at. Thread and message ids are the UI's (MailThread.id, Message.id);
 * the engine also keeps the Message-ID header, so a link survives re-threading and resyncs.
 */
export type MailLinkTarget = { kind: 'thread'; accountId: string; threadId: string } | { kind: 'message'; accountId: string; messageId: string }
export type LinkTarget = MailLinkTarget | { kind: 'event'; eventId: string } | { kind: 'contact'; email: string; name?: string }

/** What a link showed when it was made, so it still reads well when the mail or event is gone. */
export type LinkSnapshot = {
  subject?: string
  from?: { name?: string; email: string }
  /** Mail date, or an event's start. */
  date?: number
  title?: string
  name?: string
  email?: string
}

/** A mail link whose account was removed: only its kind and snapshot are left. */
export type DetachedTarget = { kind: 'thread' | 'message'; accountId: null }

export type Link = {
  id: string
  target: LinkTarget | DetachedTarget
  snapshot: LinkSnapshot
  /** Whether the target still exists; a detached link never is. */
  live: boolean
  createdAt: number
}
export type NoteLink = Link & { noteId: string }
export type EventLink = Link & { eventId: string; role: 'related' | 'invite' }

// --- Notes --------------------------------------------------------------------

export type Note = {
  id: string
  title: string
  /** Markdown. */
  body: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  links: NoteLink[]
}

export type NoteInput = { id?: string; title: string; body: string; pinned?: boolean; links?: LinkTarget[] }

// --- Tasks (docs/tasks-architecture.md) ---------------------------------------

/** A task's place in its workflow. Done and canceled are closed; the rest are open. */
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'canceled'
/** 0 no priority, 1 urgent, 2 high, 3 medium, 4 low (Linear's order). */
export type TaskPriority = 0 | 1 | 2 | 3 | 4
/** How a task was made: by hand, from an email, suggested by AI, or from the menu bar. */
export type TaskOrigin = 'manual' | 'email' | 'ai' | 'menubar'
export type TaskLink = Link & { taskId: string }
export type TaskLabel = { id: string; name: string; color: string }
export type TaskProject = { id: string; name: string; color: string; createdAt: number }

export type Task = {
  id: string
  uid: string
  /** Shown as T-12; never reused. */
  number: number
  title: string
  /** Markdown. */
  notes: string
  status: TaskStatus
  priority: TaskPriority
  projectId: string | null
  labels: TaskLabel[]
  /** A timed due is the instant; a date-only one (`dueAllDay`) is that day's UTC midnight. */
  dueAt: number | null
  dueAllDay: boolean
  remindAt: number | null
  /**
   * Reminders, in minutes before the due (for a date-only task, before local midnight of the day, so
   * -540 is 9:00 on the day). Null means the person's default; [] means none.
   */
  alarms: number[] | null
  origin: TaskOrigin
  /** When it was closed (done or canceled). */
  completedAt: number | null
  createdAt: number
  updatedAt: number
  links: TaskLink[]
}

/**
 * Create (no `id`) or update. On an update, fields left undefined keep their value and `null`
 * clears `dueAt` / `remindAt` / `projectId`. `labelIds` replaces the task's labels; `links` are
 * added (unlinkTask removes one).
 */
export type TaskInput = {
  id?: string
  title?: string
  notes?: string
  status?: TaskStatus
  priority?: TaskPriority
  projectId?: string | null
  labelIds?: string[]
  dueAt?: number | null
  dueAllDay?: boolean
  remindAt?: number | null
  alarms?: number[] | null
  origin?: TaskOrigin
  links?: LinkTarget[]
  /** Creating only: a deleted task's number to give back (Undo), if it's free; otherwise the next one. */
  number?: number
}

/**
 * Which tasks: `open` (backlog, todo, in progress; the default), `closed` (done, canceled), `all`,
 * or exactly the statuses listed. Open ones by due date (none last), then priority, then newest;
 * closed ones latest closed first.
 */
export type TaskQuery = { status?: 'open' | 'closed' | 'all' | TaskStatus[]; projectId?: string; labelId?: string; search?: string; limit?: number }

// --- Invites ------------------------------------------------------------------

/** A text/calendar part of a received message, stored raw; parsing is src/detect's job. */
export type Invite = { index: number; method: string | null; filename: string | null; ics: string }

/** An answer to an invitation (iTIP PARTSTAT). */
export type InviteResponse = 'accepted' | 'tentative' | 'declined'

/**
 * What became of a received invite: 'new' (not looked at yet), 'applied' (the calendar has it),
 * 'pending' (from Junk, a blocked sender or the Screener: waits for the person to answer), 'stale'
 * (an older SEQUENCE than the calendar's), 'own' (our own copy) or 'ignored' (nothing to do).
 */
export type InviteState = 'new' | 'applied' | 'pending' | 'stale' | 'own' | 'ignored'

/** A message's invitation as the reader's invite card shows it (MailEngine.inviteForMessage). */
export type InviteView = {
  method: 'REQUEST' | 'CANCEL' | 'REPLY'
  state: InviteState
  uid: string
  sequence: number
  recurrenceId: number | null
  title: string
  /** Store conventions: all-day on UTC midnights, end exclusive. */
  startAt: number
  endAt: number
  allDay: boolean
  /** The organizer's zone for the event, when the invite named one. */
  timeZone: string | null
  location: string | null
  description: string | null
  /** RRULE text, for a series. */
  recurrence: string | null
  organizer: Organizer | null
  /** From the invite; ours is marked `self`. */
  attendees: Attendee[]
  /** The calendar's event for this invite, once it has one. */
  eventId: string | null
  calendarId: string | null
  /** Our current answer to a REQUEST once the calendar has it ('needs-action' until answered); null otherwise. */
  response: PartStat | null
  /** A CANCEL, or an event the organizer has since cancelled. */
  cancelled: boolean
  /** The calendar already has a newer revision than this message. */
  outdated: boolean
  /** For a REPLY: who answered, and how. */
  replyFrom?: Attendee
}

/**
 * An invitation received by email that the person hasn't answered yet (MailEngine.pendingInvites),
 * for the menu bar panel. For a series, `startAt`/`endAt` are its next occurrence.
 */
export type InviteSummary = {
  eventId: string
  title: string
  /** Store conventions: all-day on UTC midnights, end exclusive. */
  startAt: number
  endAt: number
  allDay: boolean
  timeZone: string | null
  location: string | null
  organizer: Organizer | null
  /** The account the invite reached, which answers it. */
  accountId: string
  /** The invite message's conversation and the message (UI ids), to open it. */
  threadId: string
  messageId: string
  recurring: boolean
}
