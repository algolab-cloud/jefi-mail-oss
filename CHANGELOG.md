# Changelog

## 0.9.1 — 2026-11-05

- HTML mail is shown at its full height, so the conversation scrolls as one: nothing is cut off under the reply box, and scrolling over a message moves the conversation.
- Plain HTML mail follows the theme, so it reads light on a dark card in dark mode. Mail with its own design keeps its look.
- The AI summary header no longer overlaps the text, and a summary can be copied or taken to the assistant. The assistant uses Claude Sonnet 5.5.
- ⌘C copies selected text. Long menus, such as labels, fit the window and scroll. Toolbar tooltips no longer flicker.

[Full release notes](docs/releases/0.9.1.md)

## 0.9.0 — 2026-11-03

- Jefi Mail is free and open source under the GPL. The trial and licence keys are gone: everything works, with nothing to buy.
- All Inboxes and All Starred, for when you have more than one account.
- Sign-in codes appear beside the subject, in the menu bar and on the notification, and copy in one click.
- Tracking pixels stay blocked even after you show images, and the reader says how many it blocked. Messages can be translated into your language.
- Keyboard shortcuts can be single keys, ⌘ shortcuts or off, and each one can be changed in Settings.
- A cleaner reader: one message opens at a time in full, and the toolbar is grouped. Find in the conversation is ⌘F.
- Passwords and keys sit in one encrypted vault, so macOS asks for Keychain access once, not once per account.

[Full release notes](docs/releases/0.9.0.md)

## 0.8.15 — 2026-10-02

- Calendar events are solid, so the grid's hour lines no longer show through them, and the current-time line sits cleanly above the day's edge.

[Full release notes](docs/releases/0.8.15.md)

## 0.8.14 — 2026-10-02

- A new welcome: six short steps, each with its own illustration. Connect your mail or try a demo mailbox, pick a colour and a look, and you're in.
- A message whose server reply was lost is no longer sent again on its own. It waits in the Outbox as Not confirmed until you say it was sent or send it again.
- In Liquid Glass, the floating assistant and dialogs are solid, so the mail behind them no longer shows through.

[Full release notes](docs/releases/0.8.14.md)

## 0.8.13 — 2026-10-01

- Jefi is now Jefi Mail: the menu bar, Dock, Finder, window and Notifications say so. Your mail, settings and accounts stay as they are.
- In Liquid Glass, the task list no longer shows through a task's details.

[Full release notes](docs/releases/0.8.13.md)

## 0.8.12 — 2026-10-01

- A calmer look: lighter rows, softer text and borders, borderless cards and a violet accent. Jefi opens in Liquid Glass; Settings → Appearance → Style switches back to solid.
- Notes open rendered with checklists you can tick. Edit brings a formatting toolbar (⇧⌘L for a checklist item), and the list is grouped by when each note was last edited, with checklist progress.
- New-mail banners show the sender's photo or initials; task and event reminders show a checklist or calendar.

[Full release notes](docs/releases/0.8.12.md)

## 0.8.11 — 2026-09-27

- Right-click a message in the reader to copy the selection, the message text or the sender's address, or to reply, forward, add to notes, make a task or print. HTML mail in the full view keeps macOS's own menu.
- Right-click a task, in the list or on the board, to open it, mark it done or reopen it, set its status or priority, or delete it.
- Right-click a note to open, pin or unpin, or delete it.

[Full release notes](docs/releases/0.8.11.md)

## 0.8.10 — 2026-09-27

- Label counts and Mark all as read leave out Spam and Trash, like the label itself.
- Setup commands in Settings → Integrations wrap instead of running off the edge; Copy still copies them exactly.
- J and K in Tasks carry on from a task you just completed instead of jumping to the top, and a project shows the same count in the sidebar and its header.
- Invitations sent in UTC no longer show a second, duplicate time line.
- The notification permission row in Settings shows its status at once instead of "Checking with macOS…".

[Full release notes](docs/releases/0.8.10.md)

## 0.8.9 — 2026-09-27

- Archiving, deleting, moving and labelling go straight to the server without a sync of the whole mailbox afterwards, so archiving is more than twice as light, and the echo of your own change no longer sets off another sync.
- Moving through conversations keeps the reading pane in place and swaps only what changed, with the unread counts updating in the same step.

[Full release notes](docs/releases/0.8.9.md)

## 0.8.8 — 2026-09-27

- Opening a conversation and moving through the list with J and K take half the work they did: reading or starring mail no longer triggers a full sync of every folder, and a conversation opens with its messages in one step.
- Archiving or deleting shows the next conversation with its messages at once.
- Jefi skips redrawing when an update changes nothing on screen, and a star or label no longer redraws every message in the conversation.
- Toasts slide in faster and more lightly.

[Full release notes](docs/releases/0.8.8.md)

## 0.8.7 — 2026-09-27

- The calendar moves between weeks, days and months without rebuilding itself, sending a fraction of the work to the screen, and the agenda scrolls smoothly however long it is.
- Jefi redraws only what changed across the app: unchanged styles are no longer sent again on every update.
- Subjects and titles in Arabic, Hebrew or a mix with English read in the right order and are shortened at the right end, in the list, toasts, the reader and the calendar.
- A new event is shown where it landed, even when that's another week, instead of seeming to vanish.

[Full release notes](docs/releases/0.8.7.md)

## 0.8.6 — 2026-09-26

- Tasks and notes stay smooth however many you have: only what's on screen is drawn, so moving through 2,000 tasks with J and K is over ten times faster and opening one is instant.
- Typing is lighter everywhere: a keystroke no longer redraws the whole composer, reply, note or task, so long notes and task descriptions type without lag.
- Jefi does less while you're not doing anything: the Compose button's stripes move only under the pointer, and the sidebar and rail stop redrawing for changes they don't show.
- Links to a spot inside an HTML message (a table of contents, "back to top") scroll there instead of showing Link blocked.
- A mail link blocked for a hidden line break says so.

[Full release notes](docs/releases/0.8.6.md)

## 0.8.5 — 2026-09-26

- Labels on iCloud, Outlook, Fastmail and other non-Gmail accounts are kept on your Mac, so they stay after a sync or a restart, and can be renamed.
- With more than one account, choose which one a message is sent from; drafts remember it.
- Undo after Send and archive brings the conversation back too.
- Mail you move back to the Inbox, or bring back with Undo, is no longer announced as new mail or put through your rules again.
- Drafts kept on the server carry their reply headers and aren't uploaded again when nothing changed.
- Privacy: remote images in some HTML mail (those with a <header> element, or an image before the page head) could load before you allowed them. They're now always blocked until you do.
- Signing in with Microsoft or Google can be cancelled, and sign-in problems are explained in plain words.
- A new-mail notice names who wrote the new message, not everyone in the conversation, and the reader no longer jumps away from what you're reading when new mail arrives.
- "Task:" on its own in quick add opens a new task, and Manage accounts opens Settings at Accounts.

[Full release notes](docs/releases/0.8.5.md)

## 0.8.4 — 2026-09-26

- Events have a meeting-link field that recognises Zoom, Meet, Teams, Webex and more, and a Join button on the event card (also for meeting links in invitations). Invitations carry the link, and changing it updates your guests.
- A ready update shows as a card at the foot of the sidebar with Restart now or Download, and Later.
- Report a bug or request a feature from a new button in the rail, the command palette, or Settings → About.

[Full release notes](docs/releases/0.8.4.md)

## 0.8.3 — 2026-09-26

- Faster: a first sync threads mail in linear time and rebuilds each conversation once per batch (10,000 messages sync two to three times faster), Jefi now runs React's production build, and the mailbox re-renders far less during sync.
- The Assistant asks before archiving or changing many conversations, Enter sends and Stop really stops, and it says what's missing when AI isn't ready.
- Enter works in every text field: trusted domains, labels, keys, the account wizard, the palette, onboarding and new calendars.
- The account wizard gives up on a silent server after 30 seconds and can be cancelled.
- Editing a rule no longer duplicates it, and Clean up no longer gets stuck.
- jefi://settings/<section> scrolls to that section, and a search opened by a link fills in once mail arrives.
- A damaged settings.json or accounts.json no longer turns the window black or crashes Settings.
- Tasks: dates for today stay today after noon, Make task keeps the title you typed, tasks made in Today or Upcoming stay there, T-numbers are never reused, and "by Friday" in an email becomes the due date.
- Long notes, task notes and messages open at the top and use the whole pane.
- Task reminders follow a due date that gains or loses its time.
- Task and note lists stay quick with thousands of items.

[Full release notes](docs/releases/0.8.3.md)

## 0.8.2 — 2026-09-26

- Save and send invites now sends the invitations: it failed every time before. Editing an invitation you received no longer tries to send one.
- Deleting your own event with guests asks whether to tell them, and sends the cancellation if you choose to.
- Enter saves in the event editor and in quick add, and adds a typed guest; ⌘↩ no longer creates the event twice.
- Events on the day clocks change sit at the right time, a weekly event moved to another day repeats on that day, and repeat end dates are right in every time zone.
- Sending or saving a draft no longer hangs on some Markdown, and links with _ or * in them survive.
- The composer keeps what you typed when you switch conversation or account, a quick double-click on Send sends once, and a half-written reply waits for you when you come back.
- Undo send works for replies, and Discard can be undone.
- Recipients: Enter adds an address, pasted "Name <address>" becomes one recipient, an address you typed but didn't confirm is still sent to, and ↑↓ choose suggestions.
- Replies keep Bcc, an edited subject and their threading, and forwards carry the original date, To and Cc.
- A message that fails to send says why, and can go back to Drafts to be fixed.

[Full release notes](docs/releases/0.8.2.md)

## 0.8.1 — 2026-09-26

- Fixed apostrophes and other characters turning into boxes or disappearing in previews, search and message text for mail from senders such as Slack. Affected messages download again by themselves.
- Fixed a crash when opening a conversation that is in the Inbox and also in another folder.
- After archiving or deleting, the reader moves to the next conversation instead of jumping to the top, and E, #, S and U act on every checked conversation.
- Unsnoozing sticks, and archiving or deleting a snoozed conversation ends its snooze.
- Labels made on a Gmail account are real Gmail labels, so they no longer vanish at the next sync.
- Inbox badges count your whole Inbox, not just the conversations loaded so far.
- Enter creates a new label and steps through matches in Find.
- Plain-text replies fold their quoted history, previews stop before "On … wrote:", long subjects wrap in the reader, and the list follows J and K.

[Full release notes](docs/releases/0.8.1.md)

## 0.8.0 — 2026-09-26

- Tasks: a new app in the rail (⌘4) that works like an issue tracker. Each task has a status (Backlog, Todo, In Progress, Done, Canceled), a priority, a number like T-12, a project and labels. The views are Active, Today, Upcoming, Backlog, All tasks and Completed, and your projects and labels have views too. Filter by priority, label or project, and show tasks as a list or a board, grouped by status, priority, project or due date. A task's details open in a sheet beside the list, and New task (C) opens a composer with every property. Adding a task reads a due date out of what you type ("Send the deck Friday 3pm", "tomorrow", "in 2 weeks").
- Make task from an email: T or the reader's toolbar, the message menu, or the list's context menu. The subject and the next date the email mentions fill it in, and the task links back to the conversation; linked tasks show under the subject and can be ticked off there.
- Tasks with a due date show on the calendar, on a Tasks calendar you can hide, and remind you like events do. Settings → Tasks sets when (at the due time, 30 minutes or an hour before, 9:00 on the day, and more), and each task can choose its own.
- With AI turned on, Suggest tasks lists what you've been asked to do in a conversation. Nothing is added until you choose it.
- The menu bar panel lists what's overdue or due today, ticks tasks off in place, and adds one when quick add starts with "Task:".
- Tasks stay on your Mac, like your calendar and notes, and are kept if you remove an account.

[Full release notes](docs/releases/0.8.0.md)

## 0.7.1 — 2026-09-26

- jefi:// links open Jefi from other apps and scripts: a new message, a search, a day in the calendar, an event, quick add, a note or a section of Settings. Jefi doesn't take over mailto: links.
- A read-only command line: `Jefi.app/Contents/MacOS/Jefi cli` lists accounts, unread counts, search results, your inbox, a conversation, today's events, your agenda, invitations and notes, as text or JSON.
- An MCP server for AI apps such as Claude, Codex and Tinycast, off until you turn it on in Settings → Integrations. It reads your mail, calendar and notes; asked to write, it opens a draft, event or note in Jefi for you to check, and it never sends mail.
- An extension for Raycast and Tinycast is on its way.

[Full release notes](docs/releases/0.7.1.md)

## 0.7.0 — 2026-09-26

- A calendar inside Jefi: day, week, month and agenda views, local calendars on your Mac, and an event editor with guests and repeats. Nothing syncs with an account.
- Invitations by email that work with Google Calendar, Outlook and Apple Calendar: Accept, Maybe or Decline from the message, and invite guests to your own events from your own address.
- Dates in a message are found on your Mac, with Add to calendar beside them.
- Event reminders, with default alerts in Settings, alerts per event, and reminders for repeating events.
- Notes that save as you type and link to conversations and events.
- A new app rail for Mail, Calendar, Notes and the Assistant, each with its own sidebar.
- A menu bar item with a Liquid Glass panel: up next, today, a month view, invitations, recent mail and reminders, quick add, and a new message, event or note. Closing the window keeps Jefi running there; Settings choose the menu bar title and can hide the Dock icon.
- A notification permission step in setup, and its status in Settings.
- The Assistant can catch up on unread mail across all your accounts.
- A new logo and app icon, and compact attachment cards of one size.
- Fixed attachment actions blinking on hover, dark corners around popovers, and calendar invitations showing as attachments.

[Full release notes](docs/releases/0.7.0.md)

## 0.6.5 — 2026-09-25

- Licence messages say what went wrong and what to do next: an unrecognised key, a key already active on three Macs, or a revoked key. If a background check removes a licence, Jefi now says why.
- With AI features turned off, Jefi makes no connection to any AI provider.
- Clearer AI errors for an invalid key, rate limits, network problems, and the Codex CLI being signed out or missing.
- Summaries and reply drafts now default to Claude Sonnet 5; Opus remains available under Model.

[Full release notes](docs/releases/0.6.5.md)

## 0.6.4 — 2026-09-24

- Mail lists open and scroll much faster in large mailboxes: each page is read from a per-conversation index instead of regrouping the whole mailbox.
- Search results appear faster, especially for broad searches.
- Fewer parts of the window redraw when mail syncs or you type, so Jefi does less work while you read and write.
- Fixed an extra blank line at the end of some Outlook messages.

The first launch after updating spends a few seconds preparing the new index before the first sync.

[Full release notes](docs/releases/0.6.4.md)

## 0.6.3 — 2026-09-24

- Fixed the mail list jumping back while scrolling through a large mailbox.
- Find in conversation keeps up with typing, even in long threads.
- Jefi uses less power while idle: open HTML messages check their position less often, and the Compose animation pauses when Jefi is in the background or Reduce motion is on.

[Full release notes](docs/releases/0.6.3.md)

## 0.6.2 — 2026-09-24

- Scrolling far back in a large mailbox is much faster: each older page loads on its own instead of reloading everything above it.
- Jefi does less work when nothing has changed, so large accounts stay responsive while syncing.
- The optional phishing list now loads and updates in the background, so link review and Link Protection settings no longer pause while it is prepared.

[Full release notes](docs/releases/0.6.2.md)

## 0.6.1 — 2026-09-24

- Fixed an HTML email covering the What's new sheet, and other dialogs opened while a message was loading. The message now waits behind the dialog and reappears when it closes.

[Full release notes](docs/releases/0.6.1.md)

## 0.6.0 — 2026-09-24

- New mail appears within a second or two of arriving, with its preview ready. Jefi catches up at once after your Mac wakes from sleep.
- Background syncing no longer animates the sidebar. It reads Up to date, and only reports problems that persist.
- Fixed mail disappearing from Jefi after an interrupted sync. Missing mail is downloaded again automatically; nothing on your mail server was affected.
- Message text downloads in the background, newest first, and never delays new mail. Attachments download only when you open them.
- Folders that haven't changed are skipped, and each account keeps one connection open, so routine syncs do far less work.
- Several new messages at once become one notification.
- Removing an account now removes its downloaded mail as well.
- A What's new sheet introduces changes after an update.

[Full release notes](docs/releases/0.6.0.md)

## 0.5.1 — 2026-09-21

- Fixed the HTML email canvas disappearing when a link popover opens. The formatted message remains visible behind the review.
- Made link review compact, with the destination, relevant warnings, Copy, Cancel, and Open anyway when a warning applies.
- Made phishing-list downloads an explicit Settings opt-in, off by default. Google Web Risk remains optional and uses your own API key; neither service is required to open links.
- Removed API-key setup prompts and routine list-status messages from link popovers. Reported threats still display a warning.
- Improved link scanning performance in long messages and released temporary canvas images after popovers close.

[Full release notes](docs/releases/0.5.1.md)

## 0.5.0

Added link destination review, trusted domains, optional Google Web Risk checks, composer formatting, reader tools, and improvements to sending, recovery, and updates.

[Full release notes](docs/releases/0.5.0.md)
