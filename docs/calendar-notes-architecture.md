# Calendar and notes: storage and engine API

Bead lume-fwl.1 (epic lume-fwl). This is the foundation the calendar UI, the notes UI, invite
handling and add-to-calendar suggestions build on. It covers the schema (migration 17 in
`src/engine/db.ts`), the engine API (`MailEngine` in `src/engine/types.ts`), and the store hooks
(`src/local-data.ts` plus actions on the mail store).

## Decisions

- **Jefi's calendar is its own.** Nothing syncs with Google or Microsoft. Calendars are local:
  one ("Personal") exists from the start, and people can add more ("Work"…), each with a name,
  a colour, hidden and default flags. `source: 'subscription'` is reserved for read-only iCal
  URL subscriptions later. The schema has `url`, `sync_state` and `refreshed_at` for them, but
  nothing fetches them yet.
- **Other calendars talk to Jefi by email (iTIP, RFC 5546).** Received invites (text/calendar
  parts) get Accept/Maybe/Decline, which sends a REPLY. Events with attendees send REQUEST and
  CANCEL. That sending isn't built yet, but events already carry what it needs: a stable `uid`,
  `sequence`, `organizer`, `attendees` with `partstat`/`rsvp`, the `accountId` they send as, and
  the `invite` message they came from.
- **Notes are local markdown.** They belong to no account and can link to threads, messages,
  events and contacts. A link keeps a snapshot (subject, sender, date; an event's title and
  start), so it still reads well once the target is gone.
- **Date detection runs on the device, in `src/detect/`** (a separate bead). This layer only stores
  the raw invite text and gives it back.
- **Account removal keeps calendars, events and notes.** Their links into the removed account's
  mail become *detached*: `account_id`, `target_ref` and `message_id_header` are set to NULL, and
  only the kind and snapshot are kept. Events forget the account as their identity
  (`account_id` → NULL). Stored invites go with the account's messages. `src/engine/account-removal.test.ts`
  checks all of this.

## Schema (migration 17)

All times are epoch ms UTC.

### `calendars`
| column | notes |
|---|---|
| `id` TEXT PK | `'local'` for the built-in one, `cal-<uuid>` otherwise |
| `source` | `'local'` or `'subscription'` |
| `name`, `color` | any CSS colour |
| `can_write` | 0 for subscriptions |
| `is_default` | exactly one row has 1, and it's always a local calendar (`ensureLocalCalendar` enforces this) |
| `hidden` | left out of `listEvents` unless its id is asked for |
| `url`, `sync_state`, `refreshed_at` | reserved for subscriptions |

There is always at least one local calendar. Deleting the last one is refused, and
`ensureLocalCalendar` recreates it if it's ever missing.

### `events`
| column | notes |
|---|---|
| `id` TEXT PK | `evt-<uuid>` |
| `calendar_id` | |
| `uid` | iCalendar UID. Jefi makes `<uuid>@jefi`; an event made from an invite keeps the organizer's. A series and its exceptions share it. Unique per `(calendar_id, uid, recurrence_id)` |
| `sequence` | iCalendar SEQUENCE |
| `account_id` | the Jefi account the event speaks as over email (not a foreign key; set to NULL when that account is removed) |
| `title`, `location`, `description` (plain/markdown), `url` | |
| `start_at`, `end_at` | `end_at` is exclusive. All-day events use UTC midnights (3 March = `03-03T00:00Z` → `03-04T00:00Z`) with `time_zone` NULL |
| `all_day`, `time_zone` (IANA) | a timed event's zone decides its recurrence's wall-clock time |
| `status` | `confirmed`, `tentative` or `cancelled`. Cancelled rows stay, so later updates still match, but they're left out of listings |
| `organizer_json`, `attendees_json` | `Organizer`, `Attendee[]` (see types) |
| `recurrence` | RRULE text (canonical, no `RRULE:` prefix) on a series master |
| `exdates_json` | removed occurrence starts |
| `recur_end` | the series' last end, or NULL if it never ends. Used for range filtering |
| `recurring_master_id`, `recurrence_id` | on an exception: its series, and the original start of the occurrence it replaces (RECURRENCE-ID) |

### `event_links`
Links from an event to mail. `kind` is `thread` or `message`. `role` is `related` or `invite`,
and an event has at most one `invite`: saving from a newer invite replaces it. The other columns
are `account_id`, `target_ref` (the UI thread or message id), `message_id_header`,
`snapshot_json` and `created_at`.

### `notes`, `note_search`, `note_links`
- `notes`: `n` (INTEGER PK, the FTS rowid), `id` (`note-<uuid>`), `title`, `body` (markdown),
  `pinned`, `created_at`, `updated_at`.
- `note_search`: FTS5 over title and body (`unicode61 remove_diacritics 2`, like mail search),
  kept current by triggers.
- `note_links`: `kind` is `thread`, `message`, `event` or `contact`. `target_ref` holds the UI
  thread or message id, the event id, or the lowercased email. The other columns are
  `account_id`, `message_id_header` and `snapshot_json`.

### `invites`
`(message_id → messages.id, idx)` with `method` (the Content-Type `method=` parameter, else the
`METHOD:` line, uppercased), `filename` and `ics` (the raw text). Filled by `storeBody` for every
`text/calendar` or `application/ics` part up to 256 KB (`MAX_INVITE_BYTES`). The text-only body
path fetches those parts' content too, so an invite in a message with a big attachment is still
stored without downloading the attachment. Gmail and Outlook usually send the same invite twice,
once inline and once as `invite.ics`, and both are stored. Deduplicating them (by UID and
SEQUENCE) is the parser's job.

## Mail link identity

A mail link is `{ kind: 'thread', accountId, threadId }` or
`{ kind: 'message', accountId, messageId }`, using the UI ids (`MailThread.id` =
`${accountId}:${key}`, `Message.id` = `${threadId}-${rowid}`). When a link is created, the engine
also stores the Message-ID header (the thread's first message for a thread link) and takes the
snapshot **from the database**, so callers don't need to supply it. On read (`Link`):

- `live` says whether the target still exists.
- If re-threading changed the UI ids, the target is looked up again by header, and `target`
  comes back with the **current** ids. Always navigate with the returned `target`, never with a
  stored copy.
- Detached links (their account was removed) have `target: { kind, accountId: null }` and
  `live: false`.

`notesForThread` and `eventsForThread` match links to the thread itself or to any of its
messages, by UI id or by header.

## Engine API (`MailEngine`)

Reads resolve with data. Through the worker, a read that fails resolves with `[]` or `null`.
Writes resolve with what was stored, and reject with a message you can show the person as is
(`'An event can’t end before it starts'`, `'This calendar is read-only'`, …). Every successful
write emits an engine event (next section).

### Calendars
- `listCalendars(): Promise<Calendar[]>`: local calendars first, the default first among them.
- `createLocalCalendar({ name, color }): Promise<Calendar>`
- `updateCalendar(id, { name?, color?, hidden?, isDefault?: true }): Promise<Calendar>`: setting
  `isDefault` takes the default from the previous calendar. Only local calendars can be the default.
- `deleteCalendar(id): Promise<void>`: deletes the calendar and its events. Refused for the last
  local calendar. The default moves on if the deleted one had it.

### Events
- `listEvents(from, to, calendarIds?): Promise<EventOccurrence[]>`: occurrences overlapping
  `[from, to)`, sorted by start. An occurrence counts as overlapping if it ends after `from` (or,
  when zero-length, starts at or after it) and starts before `to`. Without `calendarIds`, this
  covers every non-hidden calendar; with them, exactly those. Series are expanded. Each
  occurrence is the event with its own `startAt`/`endAt`, plus `key` (the event id for a single
  event, `${id}@${start}` for an occurrence of a series), `recurring` and `occurrenceStart` (pass
  this back as the scope anchor). Exceptions come back as their own rows, with
  `recurringMasterId` set.
- `getEvent(id)`, `eventByUid(uid, recurrenceId?)`: the second one finds the event an iTIP
  message is about. With `recurrenceId`, it returns that exception. It prefers writable local
  calendars.
- `saveEvent(input, options?)`: creates the event (no `id`) or updates it.
  - Defaults: the default calendar; the engine's time zone for timed events; `status: 'confirmed'`.
    Fields left `undefined` on an update keep their stored value, and `null` clears them.
  - All-day inputs snap to whole UTC days, with at least one day.
  - `recurrence` must be in the supported subset: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`,
    `COUNT` **or** `UNTIL` (`YYYYMMDD`, `YYYYMMDDTHHMMSS[Z]`), `WKST`, and `BYDAY` (plain
    weekdays, weekly only). Anything else is refused. Monthly on the 31st skips shorter months,
    and yearly on 29 February skips non-leap years (RFC 5545).
  - **Invites:** `uid`, `sequence`, `accountId`, `organizer`, `attendees` and
    `invite: { kind: 'message', accountId, messageId }`. When `uid` is given without an `id`, and
    the calendar already has an event with that UID, that event is **updated**. Importing an
    invite and applying the organizer's later update are therefore the same call.
  - **SEQUENCE:** if `sequence` is given, it's stored as is (the organizer's value). Otherwise it
    goes up by one whenever the start, end, all-day flag, zone, location, recurrence or status
    changes, and stays put for a new title, description or attendee `partstat` (a reply is not a
    revision). Removing or splitting off occurrences (`'this'`/`'following'` deletes and edits)
    bumps the series' SEQUENCE too.
  - **Series scopes:** `options = { scope, occurrenceStart }`, used when `id` is a series:
    - `'all'` (the default): edits the series. With `occurrenceStart`, the input's times are that
      occurrence's new times, and the whole series (and its EXDATEs) shifts by the same amount.
    - `'this'`: adds an EXDATE to the series and creates an exception row (same UID,
      `recurrenceId = occurrenceStart`). Returns the exception. To edit an existing exception,
      save it by its own `id`.
    - `'following'`: ends the series just before the occurrence (its COUNT becomes an UNTIL) and
      drops later exceptions. It then creates a new series from the input, with a **new UID** and
      the remaining COUNT when the rule had one. From the first occurrence, this is the same as
      `'all'`.
  - `links: MailLinkTarget[]` links mail as `related` in the same transaction.
- `deleteEvent(id, scope = 'all', occurrenceStart?)`: `'this'` adds an EXDATE, `'following'`
  truncates the series, `'all'` deletes the series and its exceptions. Deleting an exception
  with `'this'` drops it and leaves its occurrence excluded. Wider scopes apply to its series from
  its `recurrenceId`. To record an organizer's CANCEL, **save** the event with
  `status: 'cancelled'` (and their `sequence`) rather than deleting it.
- `eventLinks(eventId)`, `linkEvent(eventId, target)` (idempotent per target; returns the link),
  `unlinkEvent(linkId)`.
- `eventsForThread(accountId, threadId)`: events linked to the conversation or any of its
  messages, invites included.
- `invitesForMessage(accountId, messageId): Promise<Invite[]>`: `{ index, method, filename, ics }`,
  in the order they appear in the message. `messageId` is the UI `Message.id`.

### Notes
- `listNotes(query?)`: pinned first, then most recently edited. `query` searches titles and
  bodies, with every word treated as a prefix ("meet" finds "meeting") and any punctuation safe.
  Results are ranked by relevance within pinned and unpinned.
- `getNote(id)`, `saveNote({ id?, title, body, pinned?, links? })`: `links` are **added**, and
  existing links stay. Leaving out `pinned` on an update keeps its current value.
- `deleteNote(id)` also deletes its links.
- `linkNote(noteId, target)`: `target` is a thread, message, `{ kind: 'event', eventId }` or
  `{ kind: 'contact', email, name? }`. Linking the same target again refreshes its snapshot.
  Linking also moves the note to the top (it counts as an edit).
- `unlinkNote(linkId)`, `notesForThread(accountId, threadId)`, `notesForEvent(eventId)`.

### Engine events
- `{ type: 'calendarChanged', calendarIds? }`: after calendar or event writes and link changes.
  `calendarIds` lists the calendars touched; when it's missing, anything may have changed (a
  deleted calendar, a new default, an account removal).
- `{ type: 'notesChanged', noteIds? }`: after note writes, link or unlink, and account removal.

Both have `accountId?: undefined`, like `signInPage`.

## Store (UI)

Calendar and notes data lives **outside** `MailProvider`'s React state (`src/local-data.ts`), so a
saved event or note re-renders only the components that read calendar or notes data, never every
`useMail()` consumer. The provider feeds `calendarChanged` / `notesChanged` into it, which bumps a
revision per kind and refetches the calendar list.

Hooks (inside `MailProvider`):
- `useCalendars()`: the calendar list.
- `useCalendarRevision()`, `useNotesRevision()`: numbers that change on every change.
- `useEvents(from, to, calendarIds?)`: occurrences. They refetch on calendar changes or new
  arguments, keep the previous result while loading, and are `null` only before the first result.
- `useNotes(query?)`, `useThreadNotes(accountId, threadId)`, `useThreadEvents(accountId, threadId)`,
  `useEventNotes(eventId)`
- `useLocalQuery(kind, key, load)`: for any other read.

Writes are mail store actions. Take them from `useMailActions()` (stable, and they don't cause
re-renders): `createCalendar`, `updateCalendar`, `deleteCalendar`, `saveEvent`, `deleteEvent`,
`linkEvent`, `unlinkEvent`, `saveNote`, `deleteNote`, `linkNote` and `unlinkNote`. They return the
stored value, or `null`/`false` after a toast explains what failed. The one-off reads are
`listEvents`, `getEvent`, `eventByUid`, `eventLinks`, `getNote` and
`invitesForMessage(threadId, messageId)`. `threadTarget(threadId)` and
`messageTarget(threadId, messageId)` build link targets with the right account.

## How the next beads use this

- **Calendar UI (lume-fwl.3):**
  - Render `useEvents(rangeStart, rangeEnd)`, keyed by occurrence `key` and coloured by
    `useCalendars()`.
  - When editing an occurrence of a series, ask "this / following / all" and pass
    `{ scope, occurrenceStart }`.
  - Create all-day events with UTC-midnight dates.
  - The calendar sidebar is `useCalendars()` plus `createCalendar`, `updateCalendar` and
    `deleteCalendar`.
  - **Built** (`src/calendar/`, exported from `src/calendar/index.ts`):
    - `CalendarPane` = `CalendarSidebar` (new event, mini month, calendar list with colours,
      show/hide, rename, recolour, default, delete, "Up next") + `CalendarView` (toolbar, Day /
      Week / Month / Agenda, its keys). Both are self-contained (they read module state in
      `src/calendar/state.ts` and local-data hooks, take no props), so a new app shell can place
      them apart.
    - `openEventEditor(prefill?: EventPrefill)` opens the editor sheet from anywhere; it's mounted
      once at the shell (`EventEditorHost`). `EventPrefill` is `{ title, start, end, allDay,
      location, description, calendarId, attendees (emails), link: MailLinkTarget }`, times in
      epoch ms on the person's clock; for all-day, `start` is any instant on the first day and `end`
      the exclusive local midnight after the last (what `src/detect` reports). `link` is linked on
      save. `prefillFromInput(EventInput)` converts an engine input (the reader's quick add).
    - `showEvent(event)` / `requestCalendar({ date?, select? })` open the calendar view on a day with
      an occurrence's card open (`select` is an occurrence key); the workspace listens with
      `useCalendarRequests`. The reader's seams (`src/reader-calendar/seams.tsx`) default to these.
    - Invites: the editor saves attendees. `registerInviteSender(fn)` in `src/calendar/invites.ts`
      (marked `TODO(invites)`) is where sending plugs in: once registered, the editor's button
      becomes "Save and send invites" and calls `fn(savedEvent, 'request')`.
    - Moving an event to another calendar is now supported by `saveEvent` with a different
      `calendarId` on an update: a series moves with its exceptions; one occurrence alone is
      refused ('Only a whole series can move to another calendar'). SEQUENCE doesn't change.
- **Notes UI (lume-fwl.4):**
  - `useNotes(query)` for the list.
  - `saveNote` with `links: [threadTarget(id)]` for "Add to notes" from a conversation.
  - `useThreadNotes` shows notes in the reader.
  - Render links from `snapshot`, and let them navigate only when `live`, using the returned
    `target`.
- **Notes in the reader (built on `src/notes`, exported from `src/notes/index.ts`):**
  - `addEmailToNote(useMailActions(), { accountId, threadId, messageId?, excerpt? }, noteId?)`:
    without `noteId` it makes a new note titled with the subject; with one it appends. Either way
    the body gets the excerpt as a markdown quote credited to the sender, and the note links the
    message (or the conversation, without `messageId`). Resolves with the note, or null after a
    toast. `accountId` is `accountOf(threadId).id`.
  - `<LinkedNotesList accountId threadId />`: the notes linked to a conversation or its messages,
    as `NoteChip` cards (title, first line, edited time). Renders nothing when there are none.
  - `<NoteChip note />` on its own; clicking calls `openNote(note.id)`, which switches the
    workspace to the notes view on that note. `requestNotes({ create: true })` starts a new one.
  - `<LinkChip link onOpen onRemove />` and `useOpenLink()` render and open a single link
    (live mail through `showThread`; gone or detached links show their snapshot, muted).
  - The notes view itself is `NotesPane`, the `'notes'` tool in `src/mail.tsx`. Event links open
    only if a caller passes `onOpenEvent` (the calendar can wire it); otherwise they show title and time.
- **Suggestions / invites (lume-fwl.5 and the iTIP work):**
  - Call `invitesForMessage` and parse it with `src/detect`.
  - Look up `eventByUid(uid, recurrenceId?)`. If the event isn't there, `saveEvent` with
    `uid`, `sequence`, `organizer`, `attendees`, `accountId` (the account that received it) and
    `invite: messageTarget(...)`.
  - A later REQUEST with a higher SEQUENCE is the same `saveEvent` (the UID matches). A CANCEL
    saves `status: 'cancelled'`.
  - Accept/Maybe/Decline: update the person's own attendee `partstat` (SEQUENCE stays), then send
    the REPLY as mail from `event.accountId`.
  - For events Jefi organizes, send REQUEST/CANCEL using `uid` and `sequence` as stored.
- **Subscriptions (later):**
  - Insert a `source: 'subscription'`, `can_write: 0` calendar with its `url`.
  - Put the fetch state in `sync_state` and `refreshed_at`.
  - Upsert events by `(calendar_id, uid, recurrence_id)`. A feed's RRULE masters can be stored
    as they are, since `listEvents` expands every series.

## Email invites (iTIP / iMIP, lume-fwl.8)

`src/engine/calendar/invites.ts` does the iTIP work described above; `ics-write.ts` writes the
iCalendar. Manual interop steps are in `docs/invites-verification.md`.

- **Received invites are applied as bodies are stored.** After each body fetch (push, backfill,
  opening a conversation) the engine runs `applyNewInvites`, and `inviteForMessage` runs it too.
  `invite_state` (migration 18) records each message's outcome, so a message is applied once:
  `applied`, `pending`, `stale`, `own` or `ignored`.
  - The inline part and its invite.ics copy are one invite (dedupe by UID + SEQUENCE +
    RECURRENCE-ID). The method is the first iTIP one found, Content-Type `method=` first.
  - REQUEST: adds the event to the default calendar, or updates it in whatever calendar it's in.
    Our attendee line (`self: true`) starts at `needs-action`. A higher SEQUENCE updates it and
    resets our answer; the same SEQUENCE keeps it; a lower one is `stale`. A RECURRENCE-ID becomes an
    exception under the series, without touching the series' SEQUENCE.
  - CANCEL: `status: 'cancelled'` (or an EXDATE for one occurrence).
  - REPLY: on an event we organize, the sender's own ATTENDEE line updates their `partstat`. A line
    for someone else is ignored.
  - Updates and cancellations must come from the event's organizer. Our own sent copies are `own`.
  - From Junk, a blocked sender or one waiting in the Screener: `pending`. Nothing changes until the
    person answers.
  - "Us" is the account's address. Jefi has no aliases; `selfAddresses` is where they'd go.
- **`respondToInvite(accountId, messageId, response, comment?, { sendAt? })`** saves our answer
  and queues a REPLY to the organizer. A declined event stays stored, but `listEvents` leaves out
  events whose `self` attendee declined. The REPLY is multipart/alternative: text, then
  `text/calendar; charset=UTF-8; method=REPLY`. It carries only our ATTENDEE, the UID and
  SEQUENCE, DTSTAMP, RECURRENCE-ID and COMMENT, and threads under the invitation via In-Reply-To.
- **`sendEventInvites(eventId, 'request' | 'cancel', { sendAt? })`** sends from the event's
  `accountId`.
  - A missing organizer is set to that account. Every attendee but us gets RSVP=TRUE.
  - The mail is multipart/mixed: alternative (text, HTML, text/calendar) plus invite.ics. A series
    goes with its exceptions.
  - SEQUENCE is the stored one, since `saveEvent` already bumped it. For a CANCEL, the event is
    saved cancelled first, which bumps it again. Delete the event afterwards if you want it gone.
- **Everything goes through the outbox** as a `message` entry whose `calendar` field carries the
  method and text. So offline queueing, retries, Outbox and `cancelSend` work as they do for any
  mail. The store action holds a reply for the undo window (`sendAt`) and offers Undo.
- **Times written:** a one-off timed event is sent in UTC. Every client reads UTC, and no VTIMEZONE
  is needed. A series is sent with TZID plus a VTIMEZONE built from `Intl`, so its wall-clock time
  survives DST for every recipient. All-day events use VALUE=DATE.
- **Reader:** `src/calendar/invite-card.tsx` exports `InviteCard({ threadId, messageId })`. Mount it
  above a message body whose attachments include `text/calendar` or `application/ics`. It renders
  nothing for messages without an iTIP invite. It loads itself (`inviteForMessage`), refreshes on
  `calendarChanged`, and answers through `respondToInvite` / `deleteEvent`.

## Recurrence expansion

`src/engine/calendar/recurrence.ts` is a small expander written for this bead, not the `rrule`
package. The subset is small, and the part that's hard to get right is time zones. `rrule`
works in floating UTC dates and leaves DST to the caller, which is exactly what this code does
itself, with `Intl`:

- Occurrences keep the master's **wall-clock time in its IANA zone**. A 09:00 weekly meeting in
  New York is at 14:00Z in winter and 13:00Z in summer.
- A time that falls in the spring-forward gap moves forward by the size of the gap.
- A time that happens twice at fall-back takes its first instance.
- COUNT counts occurrences before EXDATEs remove any.
- Expansion stops at the end of the range, and after at most 100,000 candidate dates.
