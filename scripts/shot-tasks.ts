/**
 * Screenshots of tasks against the in-memory fixture mailbox: "Make task" from an email (the form,
 * then the task's chip in the reader), the tasks view with its groups, and quick add reading a date.
 *
 *   bun scripts/shot-tasks.ts [prefix] [--theme=dark|light] [--accent=violet] [--window=1200x750]
 *                                                              → <prefix>-<shot>-<theme>.png
 *
 * For the website: `--accent=violet --window=1200x750` matches scripts/shot-marketing.ts, and
 * scripts/marketing-images.ts turns the sheet and calendar shots into jefi-tasks*.webp/png.
 *
 * The first launch syncs the fixture mail; tasks linking to it are then written straight into that
 * run's private mail.db (never ~/.config/jefi), and a second launch takes the pictures.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { openDatabase } from '../src/engine/db'
import { uiThreadId } from '../src/engine/threading'
import { saveTask, saveTaskLabel, saveTaskProject } from '../src/engine/calendar/tasks'
import { saveEvent } from '../src/engine/calendar/store'

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--')) ?? `${process.cwd()}/tmp/tasks`
const only = args.find((a) => a.startsWith('--theme='))?.slice(8)
const accentArg = args.find((a) => a.startsWith('--accent='))?.slice(9)
const windowArg = args.find((a) => a.startsWith('--window='))?.slice(9)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DAY = 86_400_000

type App = Awaited<ReturnType<typeof launch>>
const hasText = (app: App, text: string) => async () => (await app.getByText(text).all()).length > 0
const hasId = (app: App, id: string) => async () => (await app.getByTestId(id).all()).length > 0
const until = async (app: App, what: () => Promise<boolean>, label: string) => {
  for (let i = 0; !(await what().catch(() => false)); i++) {
    if (i > 100) {
      await app.screenshot({ path: `${out}-timeout.png` }).catch(() => {})
      throw new Error(`timed out waiting for ${label}`)
    }
    await wait(200)
  }
}
/** Clicks the first element showing `text`, at its centre. */
const clickText = async (app: App, text: string) => {
  const [node] = await app.getByText(text).all()
  const b = node?.bounds
  if (b) await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
}
/** Clicks until `target` shows: the first clicks after launch can be lost. */
const reach = async (app: App, click: () => Promise<unknown>, target: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 20; i++) {
    if (await target().catch(() => false)) return
    await click().catch(() => {})
    await wait(600)
  }
  await app.screenshot({ path: `${out}-timeout.png` }).catch(() => {})
  throw new Error(`timed out waiting for ${label}`)
}

function seed(dir: string, accountId: string) {
  const db = openDatabase(`${dir}/mail.db`)
  const thread = (subject: string) => {
    const row = db.query('SELECT id, thread_id FROM messages WHERE account_id = ? AND subject = ? ORDER BY id LIMIT 1').get(accountId, subject) as { id: number; thread_id: string | null } | null
    if (!row) throw new Error(`fixture has no "${subject}"`)
    const threadId = uiThreadId(accountId, row.thread_id, row.id)
    return { kind: 'thread' as const, accountId, threadId }
  }
  const today = new Date()
  const utcDay = (offset: number) => Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  const at = (offset: number, hour: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, hour).getTime()
  // A plausible week around the tasks, so the calendar shot has events beside them.
  const event = (title: string, offset: number, hour: number, minutes = 60, location?: string) =>
    saveEvent(db, { title, startAt: at(offset, hour), endAt: at(offset, hour) + minutes * 60_000, location })
  event('Standup', -1, 9, 30, 'Zoom')
  event('Standup', 0, 9, 30, 'Zoom')
  event('Standup', 1, 9, 30, 'Zoom')
  event('Q3 product review', -2, 10, 90, 'Boardroom')
  event('Lunch with Nora', 0, 12, 60, 'Harbor Café')
  event('Design crit', 0, 14, 60, 'Studio 4B')
  event('Roadmap sync', 1, 11, 60)
  event('Hiring sync', 2, 15, 45)
  event('Focus: pricing model', -1, 14, 150)
  event('Yoga', -3, 8, 60)
  const launch = saveTaskProject(db, { name: 'Q4 launch', color: '#8B5CF6' })
  const site = saveTaskProject(db, { name: 'Website', color: '#12A594' })
  const [customers, design, finance] = [['Customers', '#3E63DD'], ['Design', '#D6409F'], ['Finance', '#F5A524']].map(([name, color]) => saveTaskLabel(db, { name: name!, color: color! }))
  saveTask(db, { title: 'Send Lea the pricing numbers', status: 'in_progress', priority: 1, dueAt: utcDay(-1), dueAllDay: true, projectId: launch.id, labelIds: [finance!.id], origin: 'email', links: [thread('Q3 product review')] })
  saveTask(db, { title: 'Review the new icon set', status: 'in_progress', priority: 3, dueAt: at(0, 21), labelIds: [design!.id], origin: 'ai', links: [thread('Design system updates')] })
  saveTask(db, { title: 'Reply to Nora about onboarding', status: 'todo', priority: 2, dueAt: utcDay(0), dueAllDay: true, labelIds: [customers!.id], origin: 'email', links: [thread('Customer feedback')] })
  saveTask(db, { title: 'Agree milestones for the launch', status: 'todo', priority: 2, dueAt: utcDay(2), dueAllDay: true, projectId: launch.id, origin: 'email', links: [thread('Upcoming launch plan')] })
  saveTask(db, { title: 'Book the offsite venue', status: 'todo', priority: 4, dueAt: utcDay(6), dueAllDay: true })
  saveTask(db, { title: 'Draft partnership one-pager', status: 'todo', priority: 0, projectId: site.id, origin: 'email', links: [thread('Partnership opportunities')] })
  saveTask(db, { title: 'Refresh the pricing page', status: 'backlog', priority: 3, projectId: site.id, labelIds: [design!.id] })
  saveTask(db, { title: 'Renew the domain', status: 'backlog', priority: 4, projectId: site.id })
  const shared = saveTask(db, { title: 'Share the analytics build', status: 'done', priority: 3, labelIds: [customers!.id], origin: 'email', links: [thread('Analytics dashboard v2')] })
  void shared
  saveTask(db, { title: 'Old vendor contract review', status: 'canceled', priority: 0 })
  db.run('UPDATE tasks SET created_at = created_at - ?', [2 * DAY])
  db.close()
}

for (const [theme, themeAccent] of ([['dark', 'violet'], ['light', 'violet']] as const).filter(([t]) => !only || t === only)) {
  const accent = accentArg ?? themeAccent
  const home = `${process.cwd()}/tmp/tasks-home-${theme}`
  // calendar: the fixture's mail that mentions dates ("Thursday at 3pm").
  const fixture = await startFixture(home, { calendar: true })
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir?.startsWith(`${process.cwd()}/tmp/`)) throw new Error('refusing to seed outside the temporary fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true }))
  const start = () =>
    launch({
      command: 'bun',
      args: ['src/mail.tsx'],
      env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...(windowArg ? { JEFI_WINDOW: windowArg } : {}), ...fixture.env },
      cwd: process.cwd(),
    })
  try {
    let app = await start()
    try {
      await until(app, hasText(app, 'Q3 product review'), 'the first sync')
      await wait(1500)
    } finally {
      await app.close()
    }

    seed(dir, fixture.account.id)

    app = await start()
    try {
      await until(app, hasText(app, 'Design review'), 'the mailbox')
      await wait(2000)
      // An email that asks for Thursday at 3pm: the form reads the date out of it.
      // The reader opens on the first conversation by itself, so wait for this one's subject there too
      // (list row + reader title), not just for a Make task button.
      const designReview = async () => (await app.getByText('Design review').all()).length
      await reach(app, () => clickText(app, 'Design review'), async () => (await designReview()) >= 2 && (await hasId(app, 'action-make-task')()), 'the reader')
      await wait(800)
      await reach(app, () => app.getByTestId('action-make-task').click(), hasId(app, 'make-task'), 'the Make task form')
      await wait(700)
      await app.screenshot({ path: `${out}-make-task-${theme}.png` })
      await app.getByTestId('make-task-save').click()
      await until(app, async () => (await designReview()) > 2, 'the task chip')
      await wait(1200)
      await app.mouse.move({ x: 20, y: 700 }).catch(() => {})
      await app.screenshot({ path: `${out}-reader-chip-${theme}.png` })

      await reach(app, () => app.getByTestId('nav-tasks').click(), hasId(app, 'tasks-list'), 'the tasks view')
      await reach(app, () => app.getByTestId('tasks-view-all').click(), async () => (await app.getByText('Refresh the pricing page').all()).length > 0, 'All tasks')
      await app.mouse.move({ x: 1190, y: 740 }).catch(() => {})
      await wait(1200)
      await app.screenshot({ path: `${out}-list-${theme}.png` })

      // Enter in the add line adds a task.
      await app.getByTestId('task-quick-add').fill('Send the deck Friday 3pm')
      await until(app, hasId(app, 'task-quick-add-due'), 'the parsed due date')
      await app.getByTestId('task-quick-add').press('enter')
      await until(app, async () => (await app.getByText('Send the deck').all()).length > 0, 'the added task')
      await wait(600)

      await reach(app, () => clickText(app, 'Send Lea the pricing numbers'), hasId(app, 'task-sheet'), 'the task sheet')
      await wait(900)
      await app.screenshot({ path: `${out}-sheet-${theme}.png` })
      await app.getByTestId('task-sheet-close').click()
      await wait(500)

      await app.getByTestId('tasks-display').click()
      await reach(app, () => app.getByTestId('tasks-layout-board').click(), hasId(app, 'tasks-board'), 'the board')
      // Close the Display menu (it would cover a column), then keep the pointer off the cards.
      await app.getByTestId('tasks-display').click()
      await until(app, async () => !(await hasId(app, 'tasks-display-menu')()), 'the Display menu to close')
      await app.mouse.move({ x: 1190, y: 740 }).catch(() => {})
      await wait(1000)
      await app.screenshot({ path: `${out}-board-${theme}.png` })

      await reach(app, () => app.getByTestId('task-new').click(), hasId(app, 'task-composer'), 'the composer')
      await app.getByTestId('task-composer-title').fill('Prepare the board deck by Thursday')
      await app.getByTestId('task-composer-status').click()
      await wait(700)
      await app.screenshot({ path: `${out}-composer-${theme}.png` })
      await app.getByTestId('task-composer-close').click()
      await wait(500)

      // Tasks with a due date on the calendar, and the card one opens.
      await reach(app, () => app.getByTestId('nav-calendar').click(), hasId(app, 'calendar-view'), 'the calendar')
      await until(app, hasText(app, 'Reply to Nora about onboarding'), 'tasks on the calendar')
      await wait(1000)
      await app.screenshot({ path: `${out}-calendar-${theme}.png` })
      await reach(app, () => clickText(app, 'Reply to Nora about onboarding'), hasId(app, 'task-calendar-card'), 'the task card')
      await wait(700)
      await app.screenshot({ path: `${out}-calendar-card-${theme}.png` })
    } finally {
      await app.close()
    }
  } finally {
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
