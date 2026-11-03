import type { IconName } from './icons'

// ---------------------------------------------------------------------------
// Release notes for the "What's new" sheet, one entry per major.minor. Patch releases share
// their minor's notes, so a 0.6.1 update doesn't show the 0.6 sheet a second time.
// ---------------------------------------------------------------------------

export type ReleaseNotes = {
  version: string
  title: string
  intro: string
  items: Array<{ icon: IconName; title: string; body: string }>
}

export const WHATS_NEW: ReleaseNotes[] = [
  {
    version: '0.8',
    title: 'What’s new in Jefi 0.8',
    intro: 'Email that asks something of you can become a task, kept with the conversation it came from.',
    items: [
      {
        icon: 'circleCheck',
        title: 'Tasks, beside your mail',
        body: 'A Tasks app in the rail (⌘4) with statuses, priorities, projects and labels, as a list or a board. Type “Send the deck Friday 3pm” and the date is set for you.',
      },
      {
        icon: 'mail',
        title: 'Make a task from an email',
        body: 'Press T, or Make task in the reader. The subject and the next date the email mentions fill it in, and the task links back to the conversation.',
      },
      {
        icon: 'bell',
        title: 'Due dates on your calendar',
        body: 'Tasks with a due date show in the calendar and remind you when you choose in Settings → Tasks: at the due time, 30 minutes or an hour before.',
      },
      {
        icon: 'sparkles',
        title: 'Suggested action items',
        body: 'With AI turned on, Jefi can list what you’ve been asked to do in a conversation. Nothing is added until you choose it.',
      },
      {
        icon: 'sidebar',
        title: 'Tasks in the menu bar',
        body: 'Today’s tasks sit in the menu bar panel, ready to tick off. Start quick add with “Task:” to add one.',
      },
    ],
  },
  {
    version: '0.7',
    title: 'What’s new in Jefi 0.7',
    intro: 'Your calendar and notes now live next to your mail, and Jefi keeps you on time from the menu bar.',
    items: [
      {
        icon: 'calendarDays',
        title: 'A calendar in Jefi',
        body: 'Day, week, month and agenda views, with calendars kept on your Mac. Invitations from Google Calendar, Outlook and Apple Calendar get Accept, Maybe and Decline.',
      },
      {
        icon: 'calendarPlus',
        title: 'Dates in your mail',
        body: 'Jefi spots dates in the message you’re reading, on your Mac, and offers Add to calendar.',
      },
      {
        icon: 'bell',
        title: 'Event reminders',
        body: 'Set default alerts in Settings, or change them per event. Repeating events remind you every time.',
      },
      {
        icon: 'file',
        title: 'Notes beside your mail',
        body: 'Notes save as you type and link to conversations and events, so you can jump between them.',
      },
      {
        icon: 'sidebar',
        title: 'Jefi in the menu bar',
        body: 'Up next, today, invitations and quick add in one panel. Close the window and Jefi keeps running there.',
      },
    ],
  },
  {
    version: '0.6',
    title: 'What’s new in Jefi 0.6',
    intro: 'Mail arrives the moment it’s sent, and Jefi stays quiet while it keeps up.',
    items: [
      {
        icon: 'zap',
        title: 'New mail, right away',
        body: 'Jefi listens for new mail and shows it within a second or two, with its preview ready. Coming back from sleep catches up at once.',
      },
      {
        icon: 'circleCheck',
        title: 'A calmer sidebar',
        body: 'Background syncs no longer spin in the corner. You’ll see Up to date, and only hear about problems that last.',
      },
      {
        icon: 'shieldCheck',
        title: 'Your mail, all there',
        body: 'Fixed a problem that could hide mail after an interrupted sync. Anything missing downloads again automatically; nothing on your server was affected.',
      },
      {
        icon: 'download',
        title: 'Lighter downloads',
        body: 'Message text arrives in the background, newest first. Attachments download only when you open them.',
      },
      {
        icon: 'bell',
        title: 'Tidier notifications',
        body: 'Several new messages at once become one notification instead of a stack.',
      },
    ],
  },
]

/** "0.6.1" → "0.6"; anything unparseable (or empty) gives ''. */
export function majorMinor(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  return match ? `${Number(match[1])}.${Number(match[2])}` : ''
}

/** Whether `a` is an older version than `b` ("0.7.2" < "0.8.0"); unparseable versions are never older. */
export function olderThan(a: string, b: string): boolean {
  const parts = (v: string) => /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim())?.slice(1).map((n) => Number(n ?? 0))
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!
  return false
}

export const notesFor = (version: string, notes: ReleaseNotes[] = WHATS_NEW): ReleaseNotes | undefined =>
  notes.find((n) => n.version === majorMinor(version))

/** The notes for this build, or the newest there are (the palette can always show something). */
export const currentNotes = (version: string, notes: ReleaseNotes[] = WHATS_NEW): ReleaseNotes | undefined =>
  notesFor(version, notes) ?? notes[0]

/**
 * What to do at launch: 'show' the sheet, 'record' the version silently (a release without notes,
 * or a patch of one already seen), or 'nothing'. Before onboarding finishes it's always 'nothing':
 * finishing records the version itself, so fresh installs never see notes for the build they got.
 */
export function whatsNewDecision(
  { onboarded, lastSeenVersion, appVersion }: { onboarded: boolean; lastSeenVersion: string; appVersion: string },
  notes: ReleaseNotes[] = WHATS_NEW,
): 'show' | 'record' | 'nothing' {
  if (!onboarded || lastSeenVersion === appVersion) return 'nothing'
  if (majorMinor(lastSeenVersion) === majorMinor(appVersion)) return 'record'
  // Going back to an older build: its notes describe what the person already has.
  if (olderThan(appVersion, lastSeenVersion)) return 'record'
  return notesFor(appVersion, notes) ? 'show' : 'record'
}
