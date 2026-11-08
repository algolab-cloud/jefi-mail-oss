# Integrations: jefi:// links, the `jefi` CLI, the MCP server and the Raycast extension

One contract for everything outside Jefi that talks to it: Tinycast and Raycast (quicklinks and the
extension), the desktop widget, AI clients over MCP, and the Assistant's own `jefi://thread/` links.
Epic: lume-d6u (widget) and the integrations beads. Keep this file the source of truth; change it
before changing a route, a command or a JSON field.

Principles:
- **Actions go through the running app** (jefi:// links), so the person sees and confirms them.
  Nothing outside Jefi sends mail, and nothing outside it writes the database.
- **Reads are local and read-only**: the CLI and the MCP server open `mail.db` read-only (WAL lets
  them read while the app writes). No network port, no daemon.
- **The MCP server is off until the person turns it on** (Settings → Integrations), because it hands
  mail content to an AI model. The CLI reads the same data any local process could, but it too
  refuses when Jefi's config folder isn't there.

## 1. jefi:// links

Registered by the app bundle (`CFBundleURLTypes`, scheme `jefi`) and handled by the running app,
or by the app launching from quit (the handler must be installed before the first frame so a cold
launch doesn't lose the URL). Each opens/raises the main window first (`showMainWindow()`), then
routes. Unknown routes open Jefi and do nothing else. Query values are URL-encoded.

| Route | Does |
| --- | --- |
| `jefi://` · `jefi://inbox` · `jefi://inbox/<accountId>` | Mail, the (account's) inbox |
| `jefi://thread/<threadId>` | Opens that conversation (existing Assistant links) |
| `jefi://compose?to=&cc=&bcc=&subject=&body=&account=` | Compose, prefilled; never sends |
| `mailto:` is **not** claimed (the person's default mail app is theirs to choose) | |
| `jefi://search?q=` | Mail search with the query |
| `jefi://calendar` · `jefi://calendar?date=YYYY-MM-DD&view=day\|week\|month\|agenda` | Calendar |
| `jefi://event/<eventId>` · `jefi://event/<eventId>?start=<ms>` | That event (an occurrence when `start` is given) |
| `jefi://new-event?title=&start=<ISO>&end=<ISO>&allDay=1&location=&notes=` | Event editor, prefilled; the person saves |
| `jefi://quick-add?text=` | Event editor prefilled from a sentence ("Lunch with Nora Friday 1pm", src/detect/dates.ts) |
| `jefi://notes` · `jefi://note/<noteId>` | Notes, or that note |
| `jefi://new-note?title=&body=` | A new note, prefilled |
| `jefi://settings` · `jefi://settings/<section>` | Settings, on the page that holds `appearance`, `menubar`, `sync`, `keyboard`, `accounts`, `signin`, `mailbox`, `privacy`, `cleanup`, `ai`, `calendar`, `tasks`, `integrations` or `about`; without a section, the page last open |

## 2. The `jefi` CLI

The app's own executable in a headless mode: `/Applications/Jefi.app/Contents/MacOS/Jefi cli <command>`
(an `argv` check before anything GPUIX starts; exits without opening a window). Output is JSON on
stdout when `--json` is given (the extension always passes it), a short human table otherwise.
Errors: exit code 1 and `{ "error": "<message>" }` on stdout with `--json`. Honors `JEFI_CONFIG_DIR`.

| Command | JSON |
| --- | --- |
| `accounts` | `[{ id, name, email }]` |
| `unread` | `{ total, accounts: [{ id, email, unread }] }` (inbox unread) |
| `search <query> [--limit 20] [--account <id>]` | `[Thread]` newest first; the same search syntax as the app |
| `inbox [--limit 30] [--account <id>]` | `[Thread]` |
| `thread <threadId>` | `{ thread: Thread, messages: [{ id, from, to, cc, date, subject, text }] }` (plain text, capped 20k chars/message) |
| `today` · `agenda [--days 7]` | `[Event]` in start order, occurrences expanded |
| `events --from <ISO> --to <ISO>` | `[Event]` |
| `invites` | `[{ eventId, title, start, end, allDay, organizer, accountId, threadId }]` (awaiting reply) |
| `notes [--limit 30] [--query q]` | `[{ id, title, snippet, updatedAt, links }]` |
| `note <noteId>` | `{ id, title, body, updatedAt, links }` |
| `version` | `{ version }` |

Shapes:
- `Thread = { id, accountId, subject, from: { name, email }, snippet, date (ISO), unread, starred, hasAttachments, url: "jefi://thread/<id>" }`
- `Event = { id, occurrenceStart (ms), title, start (ISO), end (ISO), allDay, location, calendar: { id, name, color }, meetingUrl (a Zoom/Meet/Teams/https link found in location or notes, else null), url: "jefi://event/<id>?start=<ms>" }`
- Dates are ISO 8601 with offset; all-day events use the local date at 00:00.

## 3. The MCP server

`Jefi mcp` — stdio JSON-RPC (Model Context Protocol, protocol version 2025-06-18 or the newest the
client offers), same read-only data layer as the CLI. Refuses to start (a clear error on stderr and
exit 1) unless **Settings → Integrations → Allow AI apps to read Jefi (MCP)** is on.

Tools (read): `search_mail {query, limit?}`, `list_inbox {limit?, account?}`, `read_thread {threadId}`,
`list_events {from, to}`, `today`, `list_invites`, `search_notes {query?, limit?}`, `read_note {noteId}`.
Tools (act, all through jefi:// so the person confirms in Jefi): `draft_email {to, subject, body, cc?}`
→ opens Compose prefilled; `create_event {title, start, end?, allDay?, location?, notes?}` → opens the
event editor prefilled; `create_note {title, body}` → opens a new note prefilled. Each returns a short
confirmation text ("Opened a draft in Jefi for you to review and send."). No tool sends, deletes or
moves mail.

Setup snippets (shown in Settings → Integrations and on the website): the command is the app's
executable path with the argument `mcp`, e.g. for Claude Desktop / Tinycast / Codex.

## 4. The Raycast extension (works in Tinycast and Raycast)

Lives in `integrations/raycast/` (its own package.json; `@raycast/api`, MIT licence so it can go to the
Raycast Store). Locates Jefi at `/Applications/Jefi.app` (preference to override) and runs
`Jefi cli … --json` with `execFile`; actions `open("jefi://…")`.

Commands: **Search Mail** (list; ↵ opens in Jefi; ⌘C copies subject), **Inbox** (list, unread first),
**Today** (list of today's events + invitations; ↵ opens; ⌘J joins `meetingUrl`), **Compose Email** (form →
`jefi://compose`), **Quick Add Event** (argument text → `jefi://quick-add`), **Create Note** (form →
`jefi://new-note`), **Search Notes**, **Unread Mail** (menu-bar command, 2-minute interval: count +
next event, items open Jefi).

Tinycast constraints (docs/features/extensions.md in abue-ammar/tinycast): prebuilt CommonJS
bundle; supported components List/Grid/Detail/Form/ActionPanel and `child_process.execFile`,
`open`, `LocalStorage`, `showToast`, `getPreferenceValues`, `MenuBarExtra` via its menu runtime.
Don't depend on anything outside that list.
