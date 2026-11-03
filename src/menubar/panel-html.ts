import { dayLine, dayNumber, monthShortDay, monthYear, timeText, weekdayLong, weekdayNarrow, whenText } from '../calendar/format'
import { allDayToLocal } from '../calendar/dates'
import { untilText, type InviteSummary, type MenuBarEvent, type MenuBarModel, type MenuBarTask, type RecentItem, type SignInCodeItem } from './model'

// ---------------------------------------------------------------------------
// The menu bar panel's page. The popover is a WKWebView over the popover's own material (Liquid Glass
// on macOS 26+), so the page is transparent and draws only text, translucent fills and hovers in
// system-like colours. Everything is rendered here, in TypeScript, from the model: the page's script only posts clicks back, keeps the
// countdown live and reports its height. Every string from mail or calendars is escaped, and the
// content security policy allows nothing but this page's own nonce-tagged script.
// ---------------------------------------------------------------------------

/**
 * The page follows the popover's appearance (the system's, like other menu bar extras) through
 * prefers-color-scheme, so only Jefi's accent comes from the theme. `glass` is macOS 26+, where the
 * popover is Liquid Glass and the page stays clear; before that the page lays its own near-opaque
 * surface over the older vibrant material, which let wallpapers turn light mode a muddy grey.
 */
export type PanelTheme = { accent: string; glass: boolean }

type Rgba = [number, number, number, number]
/**
 * Label colours close to AppKit's label/secondaryLabel/tertiaryLabel, a touch stronger than the
 * system's so that small text keeps AA contrast on glass over busy wallpapers.
 */
export const panelInk = (dark: boolean): Record<'text' | 'secondary' | 'muted', Rgba> =>
  dark ? { text: [255, 255, 255, 0.92], secondary: [255, 255, 255, 0.74], muted: [255, 255, 255, 0.64] } : { text: [0, 0, 0, 0.88], secondary: [0, 0, 0, 0.7], muted: [0, 0, 0, 0.64] }

/**
 * The popover's glass is clear enough that light glass over a dark window reads mid-grey (#979799)
 * and dark glass over a white one #7C7C7D, measured off scripts/shot-menubar.ts screenshots on
 * macOS 27. These worst cases (dark rounded up for pure white) are what contrast is checked against.
 */
export const GLASS_WORST = { light: '#979799', dark: '#828284' }

/** An appearance-matched wash over the glass: enough for AA in those worst cases, while the blur still shows. */
export const GLASS_SCRIM = { light: [255, 255, 255, 0.42] as Rgba, dark: [0, 0, 0, 0.42] as Rgba }

/** The pre-glass surface: the page's own background, nearly opaque. */
export const SOLID_SURFACE = { light: { color: '#F6F6F7', alpha: 0.97 }, dark: { color: '#262628', alpha: 0.95 } }

const rgba = ([r, g, b, a]: Rgba) => `rgba(${r},${g},${b},${a})`

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

const HEX = /^#[0-9a-f]{6}$/i
/** A calendar colour for CSS: only a plain hex gets through, anything else is the accent. */
const colour = (value: string, accent: string) => (HEX.test(value) ? value.toUpperCase() : accent)

// Lucide paths (the app's icon set), stroked in the text colour.
const ICON: Record<string, string> = {
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  event: '<path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18"/><path d="M16 19h6"/><path d="M19 16v6"/>',
  note: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  invite: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  quit: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  sparkle: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  task: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
}
const icon = (name: keyof typeof ICON, size = 15) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`

const relative = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

function upNextCard(event: MenuBarEvent | null, now: number, theme: PanelTheme): string {
  if (!event) {
    return `<div class="next empty"><div class="next-label">Up next</div><div class="next-title quiet">Nothing scheduled</div><div class="next-sub">Your week is clear</div></div>`
  }
  const hex = colour(event.color, theme.accent)
  const sub = [whenText({ startAt: event.start, endAt: event.end, allDay: event.allDay }), event.location].filter(Boolean).map((part) => escapeHtml(part!)).join(' · ')
  const later = event.start - now > 24 * 3600000 ? `${escapeHtml(dayLine(event.start, now))} · ` : ''
  return `<button class="next" style="--c:${hex}" data-action="open-event" data-arg="${escapeHtml(event.key)}">
  <div class="next-label"><span>Up next</span><span class="until" data-start="${event.start}" data-end="${event.end}">${untilText(event.start, event.end, now)}</span></div>
  <div class="next-title">${escapeHtml(event.title)}</div>
  <div class="next-sub">${later}${sub}</div>
</button>`
}

function agenda(today: readonly MenuBarEvent[], now: number, theme: PanelTheme): string {
  if (!today.length) return `<div class="empty-line">Nothing on today</div>`
  const shown = today.slice(0, 5)
  const rows = shown
    .map((e) => {
      const past = !e.allDay && e.end <= now
      const current = !e.allDay && e.start <= now && e.end > now
      return `<button class="row${past ? ' past' : ''}${current ? ' current' : ''}" data-action="open-event" data-arg="${escapeHtml(e.key)}">
  <span class="bar" style="--c:${colour(e.color, theme.accent)}"></span>
  <span class="time">${e.allDay ? 'All day' : escapeHtml(timeText(e.start, true))}</span>
  <span class="title">${escapeHtml(e.title)}</span>
</button>`
    })
    .join('')
  const more = today.length - shown.length
  return `${rows}${more > 0 ? `<button class="more" data-action="open-day" data-arg="${now}">${more} more today</button>` : ''}`
}

function monthGridHtml(model: MenuBarModel): string {
  const { days } = model.month
  const heads = days.slice(0, 7).map((d) => `<span class="wd">${escapeHtml(weekdayNarrow(d.date))}</span>`).join('')
  // Six rows only when the month needs them.
  const rows = days.slice(35).some((d) => d.inMonth) ? 6 : 5
  const cells = days
    .slice(0, rows * 7)
    .map(
      (d) =>
        `<button class="day${d.inMonth ? '' : ' out'}${d.today ? ' today' : ''}" data-action="open-day" data-arg="${d.date}"><span>${escapeHtml(dayNumber(d.date))}</span>${d.busy ? '<i></i>' : ''}</button>`,
    )
    .join('')
  return `<div class="month">
  <div class="month-head"><span>${escapeHtml(monthYear(model.month.start))}</span></div>
  <div class="grid">${heads}${cells}</div>
</div>`
}

function inviteRows(invites: readonly InviteSummary[], now: number): string {
  return invites
    .map(
      (invite) => `<button class="item" data-action="open-invite" data-arg="${escapeHtml(invite.eventId)}">
  <span class="badge invite">${icon('invite', 13)}</span>
  <span class="item-text"><span class="item-title">${escapeHtml(invite.title)}</span><span class="item-sub">${escapeHtml([invite.organizer, invite.allDay ? dayLine(allDayToLocal(invite.start), now) : `${dayLine(invite.start, now)}, ${timeText(invite.start, true)}`].filter(Boolean).join(' · '))}</span></span>
  <span class="pill">Reply</span>
</button>`,
    )
    .join('')
}

/** Overdue and due-today tasks: the circle ticks one off in place, the title opens it in Jefi. */
function taskRows(tasks: readonly MenuBarTask[], more: number): string {
  const rows = tasks
    .map(
      (task) => `<div class="task">
  <button class="check" data-action="toggle-task" data-arg="${escapeHtml(task.id)}" aria-label="Complete ${escapeHtml(task.title)}"><span></span></button>
  <button class="task-open" data-action="open-task" data-arg="${escapeHtml(task.id)}"><span class="title">${escapeHtml(task.title)}</span><span class="due${task.overdue ? ' late' : ''}">${escapeHtml(task.due)}</span></button>
</div>`,
    )
    .join('')
  return `${rows}${more > 0 ? `<button class="more tasks-more" data-action="open-tasks">${more} more</button>` : ''}`
}

function codeRows(codes: readonly SignInCodeItem[], now: number): string {
  return codes
    .map(
      (item) => `<button class="item" data-action="copy-code" data-arg="${escapeHtml(item.id)}" title="Copy ${escapeHtml(item.code)}">
  <span class="badge mail">${icon('mail', 13)}</span>
  <span class="item-text"><span class="item-title">${escapeHtml(item.code)}</span><span class="item-sub">${escapeHtml(item.title)} · ${relative(item.at, now)}</span></span>
  <span class="ago">Copy</span>
</button>`,
    )
    .join('')
}

function recentRows(recent: readonly RecentItem[], now: number): string {
  if (!recent.length) return `<div class="empty-line">No new notifications</div>`
  return recent
    .map(
      (item) => `<button class="item" data-action="open-recent" data-arg="${escapeHtml(item.id)}">
  <span class="badge ${item.kind}">${icon(item.kind === 'mail' ? 'mail' : item.kind === 'invite' ? 'invite' : 'bell', 13)}</span>
  <span class="item-text"><span class="item-title">${escapeHtml(item.title)}</span><span class="item-sub">${escapeHtml(item.detail)}</span></span>
  <span class="ago">${relative(item.at, now)}</span>
</button>`,
    )
    .join('')
}

/** Everything that changes with the model; `jefiReplace` swaps it in while the panel is open. */
export function menuBarBody(model: MenuBarModel, theme: PanelTheme): string {
  const { now } = model
  const unread = model.unread > 0 ? `<button class="unread" data-action="open-jefi" title="Unread in Inbox">${icon('mail', 13)}<span>${model.unread > 999 ? '999+' : model.unread}</span></button>` : ''
  const invites = model.pendingInvites.length
    ? `<section><h2>Invitations <span class="count">${model.pendingInvites.length}</span></h2>${inviteRows(model.pendingInvites, now)}</section>`
    : ''
  return `<header><div class="date"><span class="weekday">${escapeHtml(weekdayLong(now))}</span><span class="rest">${escapeHtml(monthShortDay(now))}</span></div>${unread}</header>
${model.codes.length ? `<section><h2>Sign-in codes</h2>${codeRows(model.codes, now)}</section>` : ''}
${upNextCard(model.upNext, now, theme)}
<section><h2>Today</h2>${agenda(model.today, now, theme)}</section>
${model.tasks.length ? `<section><h2>Tasks <span class="count">${model.tasks.length + model.tasksMore}</span></h2>${taskRows(model.tasks, model.tasksMore)}</section>` : ''}
${monthGridHtml(model)}
${invites}
<section><h2>Recent</h2>${recentRows(model.recent, now)}</section>`
}

function styles({ accent, glass }: PanelTheme): string {
  const light = panelInk(false)
  const dark = panelInk(true)
  const solid = (look: 'light' | 'dark') => {
    const { color, alpha } = SOLID_SURFACE[look]
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    return rgba([r!, g!, b!, alpha])
  }
  // Two sets of system-like colours; the popover's appearance picks one through prefers-color-scheme.
  return `
:root{color-scheme:light dark;--accent:${accent};--text:${rgba(light.text)};--secondary:${rgba(light.secondary)};--muted:${rgba(light.muted)};--faint:rgba(0,0,0,.28);--fill:rgba(255,255,255,.5);--fill-edge:rgba(0,0,0,.06);--hover:rgba(0,0,0,.06);--press:rgba(0,0,0,.1);--hairline:rgba(0,0,0,.1);--field:rgba(255,255,255,.62);--accent-text:color-mix(in srgb,var(--accent) 82%,black);--green:#248A3D;--orange:#C93400;--surface:${solid('light')};--scrim:${rgba(GLASS_SCRIM.light)};--ink-mix:black}
@media (prefers-color-scheme:dark){:root{--text:${rgba(dark.text)};--secondary:${rgba(dark.secondary)};--muted:${rgba(dark.muted)};--faint:rgba(255,255,255,.3);--fill:rgba(255,255,255,.08);--fill-edge:rgba(255,255,255,.06);--hover:rgba(255,255,255,.09);--press:rgba(255,255,255,.14);--hairline:rgba(255,255,255,.12);--field:rgba(255,255,255,.08);--accent-text:color-mix(in srgb,var(--accent) 62%,white);--green:#30D158;--orange:#FF9F0A;--surface:${solid('dark')};--scrim:${rgba(GLASS_SCRIM.dark)};--ink-mix:white}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent}
body{background:var(--${glass ? 'scrim' : 'surface'})}
body{font:13px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default;overflow:hidden}
#panel{padding:14px 12px 8px}
button{font:inherit;color:inherit;background:none;border:0;text-align:left;cursor:default;display:flex;align-items:center;width:100%;border-radius:8px}
button:hover{background:var(--hover)}button:active{background:var(--press)}
.i{flex-shrink:0}
header{display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px}
.date{display:flex;align-items:baseline;gap:6px;min-width:0}
.weekday{font-size:15px;font-weight:700;letter-spacing:-.01em}
.rest{font-size:13px;color:var(--secondary);white-space:nowrap}
.unread{width:auto;gap:5px;padding:3px 8px;border-radius:999px;background:var(--accent);color:#fff;font-size:11.5px;font-weight:600}
.unread:hover{background:var(--accent);filter:brightness(1.08)}
.next{display:block;position:relative;padding:10px 12px 11px 17px;border-radius:12px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--fill-edge);overflow:hidden}
.next::before{content:"";position:absolute;left:7px;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--c)}
.next:hover{background:color-mix(in srgb,var(--c) 10%,var(--fill))}
.next.empty::before{display:none}.next.empty{padding-left:12px}
.next-label{display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:600;color:var(--secondary)}
.until{font-size:11.5px;font-weight:600;color:var(--accent-text);font-variant-numeric:tabular-nums}
.next-title{margin-top:2px;font-size:15px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.next-title.quiet{color:var(--secondary)}
.next-sub{margin-top:1px;font-size:12px;color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
section{margin-top:12px}
h2{display:flex;align-items:center;gap:6px;padding:0 6px 4px;font-size:11px;font-weight:600;color:var(--secondary)}
.count{min-width:16px;height:16px;padding:0 5px;border-radius:8px;background:var(--accent);color:#fff;font-size:10px;display:inline-flex;align-items:center;justify-content:center}
.row{gap:9px;height:28px;padding:0 6px}
.bar{width:3px;height:15px;border-radius:2px;background:var(--c);flex-shrink:0}
.time{width:58px;flex-shrink:0;color:var(--secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.past .title,.row.past .time{color:var(--muted)}.row.past .bar{opacity:.45}
.row.current .title{font-weight:600}
.more{height:24px;padding:0 6px 0 76px;font-size:12px;color:var(--secondary)}
.task{display:flex;align-items:center;gap:2px;height:28px}
.check{width:24px;height:24px;flex-shrink:0;justify-content:center;border-radius:12px}
.check span{width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--muted)}
.check:hover span{box-shadow:inset 0 0 0 1.5px var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent)}
.task-open{flex:1;min-width:0;gap:8px;height:28px;padding:0 6px}
.due{flex-shrink:0;font-size:12px;color:var(--secondary);white-space:nowrap}
.due.late{color:var(--orange)}
.tasks-more{padding-left:32px}
.empty-line{padding:4px 6px 2px;font-size:12.5px;color:var(--secondary)}
.month{margin-top:12px;padding:8px 6px 6px;border-radius:12px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--fill-edge)}
.month-head{padding:0 4px 4px;font-size:12.5px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(7,1fr);row-gap:1px}
.wd{height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:var(--muted)}
.day{position:relative;height:26px;justify-content:center;font-size:12px;color:var(--text);font-variant-numeric:tabular-nums;border-radius:13px;width:26px;margin:0 auto}
.day.out{color:var(--faint)}
.day.today{background:var(--accent);color:#fff;font-weight:650}
.day i{position:absolute;bottom:2px;left:50%;width:3px;height:3px;margin-left:-1.5px;border-radius:50%;background:var(--muted)}
.day.today i{background:#fff}
.item{gap:10px;padding:5px 6px;min-height:40px}
.badge{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--fill);color:var(--secondary)}
.badge.mail{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent-text)}
.badge.invite{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.badge.reminder{background:color-mix(in srgb,var(--orange) 18%,transparent);color:var(--orange)}
.item-text{flex:1;min-width:0;display:flex;flex-direction:column}
.item-title{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item-sub{font-size:12px;color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ago{font-size:11.5px;color:var(--muted);flex-shrink:0}
.pill{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--fill-edge);color:var(--text);flex-shrink:0}
.quick{margin-top:14px;padding-top:12px;border-top:.5px solid var(--hairline)}
form{display:flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:999px;background:var(--field);box-shadow:inset 0 0 0 .5px var(--hairline)}
form:focus-within{box-shadow:inset 0 0 0 1px var(--accent),0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
form .i{color:var(--secondary)}
input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;color:var(--text)}
input::placeholder{color:var(--muted)}
.actions{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
.action{flex-direction:column;justify-content:center;gap:4px;height:52px;border-radius:12px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--fill-edge);font-size:11.5px;font-weight:550;color:var(--text)}
.action:hover{background:var(--press)}
footer{display:flex;gap:2px;margin-top:10px;padding-top:6px;border-top:.5px solid var(--hairline)}
footer button{width:auto;gap:6px;height:28px;padding:0 8px;font-size:12.5px;color:var(--text)}
footer button .i{color:var(--secondary)}
footer .open{font-weight:600}
footer .spacer{flex:1}
`
}

/** The page script: clicks → messages, the live countdown, and the height the popover should be. */
function script(): string {
  return `
const until = ${untilText.toString()};
const post = (type, arg) => window.webkit.messageHandlers.jefi.postMessage(JSON.stringify(arg === undefined ? { type } : { type, arg: String(arg) }));
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) post(target.dataset.action, target.dataset.arg);
});
const form = document.getElementById('quick');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const field = form.elements.text;
  if (!field.value.trim()) return;
  post('quick-add', field.value);
  field.value = '';
});
const tick = () => {
  for (const el of document.querySelectorAll('[data-start]')) el.textContent = until(Number(el.dataset.start), Number(el.dataset.end), Date.now());
};
setInterval(tick, 15000);
let height = 0;
const measure = () => {
  const next = Math.ceil(document.getElementById('panel').getBoundingClientRect().height);
  if (next !== height) post('height', height = next);
};
new ResizeObserver(measure).observe(document.getElementById('panel'));
window.jefiReplace = (html) => { document.getElementById('body').innerHTML = html; tick(); measure(); };
window.jefiFocus = () => form.elements.text.focus();
measure();
`
}

/** The whole page. `nonce` tags the one script the policy allows; a fresh one per load. */
export function menuBarHtml(model: MenuBarModel, theme: PanelTheme, nonce: string): string {
  const safeNonce = nonce.replace(/[^A-Za-z0-9+/=_-]/g, '')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${safeNonce}'; img-src data:; form-action 'none'; base-uri 'none'">
<style>${styles(theme)}</style></head>
<body><div id="panel">
<div id="body">${menuBarBody(model, theme)}</div>
<div class="quick">
<form id="quick" autocomplete="off">${icon('sparkle', 14)}<input name="text" maxlength="500" placeholder="Add an event, or “Task: Call Kenji”" spellcheck="false" aria-label="Quick add an event, or a task starting with Task:"></form>
<div class="actions">
<button class="action" data-action="compose">${icon('compose', 16)}<span>Compose</span></button>
<button class="action" data-action="new-event">${icon('event', 16)}<span>New event</span></button>
<button class="action" data-action="new-note">${icon('note', 16)}<span>New note</span></button>
<button class="action" data-action="new-task">${icon('task', 16)}<span>New task</span></button>
</div>
</div>
<footer>
<button class="open" data-action="open-jefi">${icon('open', 14)}<span>Open Jefi Mail</span></button>
<span class="spacer"></span>
<button data-action="settings">${icon('settings', 14)}<span>Settings</span></button>
<button data-action="quit">${icon('quit', 14)}<span>Quit</span></button>
</footer>
</div>
<script nonce="${safeNonce}">${script()}</script>
</body></html>`
}
