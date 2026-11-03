/**
 * Screenshots of the notes view in both themes, against the in-memory fixture mailbox: the empty
 * state, a note linked to email (and an event, and mail that's gone), and search results.
 *
 *   bun scripts/shot-notes.ts [prefix]   → <prefix>-<shot>-<theme>.png
 *
 * The first launch syncs the fixture mail; notes linking to it are then written straight into that
 * run's private mail.db (never ~/.config/jefi), and a second launch shows them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { openDatabase } from '../src/engine/db'
import { uiThreadId } from '../src/engine/threading'
import { saveNote } from '../src/engine/calendar/notes'
import { saveEvent } from '../src/engine/calendar/store'

const out = process.argv[2] ?? `${process.cwd()}/tmp/notes`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000

type App = Awaited<ReturnType<typeof launch>>
const until = async (app: App, what: () => Promise<boolean>, label: string) => {
  for (let i = 0; !(await what().catch(() => false)); i++) {
    if (i > 100) {
      await app.screenshot({ path: `${out}-timeout.png` }).catch(() => {})
      throw new Error(`timed out waiting for ${label}`)
    }
    await wait(200)
  }
}
const tap = async (app: App, id: string) => {
  const [node] = await app.getByTestId(id).all()
  const b = node?.bounds
  if (!b) throw new Error(`no ${id}`)
  await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
}
/** Opens the notes view and waits for `id`; the first click after launch can be lost, so it retries. */
const open = async (app: App, label: string, id: string) => {
  for (let i = 0; i < 20; i++) {
    if (await hasId(app, id)()) return
    await app.getByTestId('nav-notes').click().catch(() => {})
    await wait(600)
  }
  await app.screenshot({ path: `${out}-timeout.png` }).catch(() => {})
  throw new Error(`timed out waiting for ${label}`)
}
const hasText = (app: App, text: string) => async () => (await app.getByText(text).all()).length > 0
const hasId = (app: App, id: string) => async () => (await app.getByTestId(id).all()).length > 0

function seed(dir: string, accountId: string) {
  const db = openDatabase(`${dir}/mail.db`)
  const message = (subject: string) => {
    const row = db.query('SELECT id, thread_id FROM messages WHERE account_id = ? AND subject = ? ORDER BY id LIMIT 1').get(accountId, subject) as { id: number; thread_id: string | null } | null
    if (!row) throw new Error(`fixture has no "${subject}"`)
    const threadId = uiThreadId(accountId, row.thread_id, row.id)
    return { threadId, messageId: `${threadId}-${row.id}` }
  }
  const q3 = message('Q3 product review')
  const feedback = message('Customer feedback')
  const launchPlan = message('Upcoming launch plan')
  const tomorrow = new Date(Date.now() + 24 * HOUR).setHours(10, 0, 0, 0)
  const event = saveEvent(db, { title: 'Q3 review with Lea', startAt: tomorrow, endAt: tomorrow + HOUR })

  const now = Date.now()
  const note = (input: Parameters<typeof saveNote>[1], hoursAgo: number) => {
    const saved = saveNote(db, input)
    db.run('UPDATE notes SET updated_at = ?, created_at = ? WHERE id = ?', [now - hoursAgo * HOUR, now - (hoursAgo + 30) * HOUR, saved.id])
    return saved
  }
  const prep = note(
    {
      title: 'Q3 review prep',
      pinned: true,
      body: [
        "Lea's deck is in good shape. The pricing section still needs our numbers before tomorrow.",
        '',
        '> The pricing section still needs your numbers.',
        '>',
        '> — Lea Ortiz',
        '',
        '## To bring',
        '- Revenue by plan, **July–September**',
        '- Churn after the price change',
        '- Three customer quotes from Nora’s calls',
      ].join('\n'),
      links: [
        { kind: 'thread', accountId, threadId: q3.threadId },
        { kind: 'message', accountId, messageId: feedback.messageId },
        { kind: 'event', eventId: event.id },
      ],
    },
    0.4,
  )
  // Mail that has since gone: the link keeps its snapshot and shows muted.
  db.run('INSERT INTO note_links (id, note_id, kind, account_id, target_ref, message_id_header, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    'nlink-gone', prep.id, 'message', accountId, `${accountId}:gone-999999`, '<gone@example.com>',
    JSON.stringify({ subject: 'Pricing draft v1', from: { name: 'Kenji Ito', email: 'kenji@northlight.co' }, date: now - 20 * 24 * HOUR }), now,
  ])
  note({ title: 'Launch checklist', body: 'Freeze on Thursday.\n\n- [ ] Changelog\n- [ ] Pricing page\n- [x] Status page', links: [{ kind: 'thread', accountId, threadId: launchPlan.threadId }] }, 3)
  note({ title: 'Onboarding ideas', body: 'Setup, search and speed came up in every call.\nStart with a two-minute import.' }, 26)
  note({ title: '', body: 'Book the offsite venue before the launch week gets busy' }, 60)
  note({ title: 'Reading list', body: '- Shape Up\n- The Mom Test\n- Working in Public' }, 24 * 9)
  db.close()
}

for (const [theme, accent] of [['dark', 'violet'], ['light', 'blue']] as const) {
  const home = `${process.cwd()}/tmp/notes-home-${theme}`
  const fixture = await startFixture(home)
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true }))
  const start = () =>
    launch({
      command: 'bun',
      args: ['src/mail.tsx'],
      env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...fixture.env },
      cwd: process.cwd(),
    })
  try {
    // First run: sync the mail, and see the empty notes view.
    let app = await start()
    try {
      await until(app, hasText(app, 'Q3 product review'), 'the first sync')
      await wait(1500)
      await open(app, 'the empty state', 'notes-empty')
      await wait(800)
      await app.screenshot({ path: `${out}-empty-${theme}.png` })
    } finally {
      await app.close()
    }

    seed(dir, fixture.account.id)

    app = await start()
    try {
      await until(app, hasText(app, 'Q3 product review'), 'the mailbox')
      await open(app, 'the linked note', 'note-links')
      await wait(1000)
      await app.screenshot({ path: `${out}-linked-${theme}.png` })

      // It opened rendered; Edit shows the Markdown and the formatting toolbar.
      await tap(app, 'note-edit-toggle')
      await wait(700)
      await app.screenshot({ path: `${out}-edit-${theme}.png` })
      await tap(app, 'note-edit-toggle')

      // A checklist ticks in place, and its row shows how far along it is.
      const [row] = await app.getByText('Launch checklist').all()
      if (row?.bounds) await app.mouse.click({ x: row.bounds.x + row.bounds.width / 2, y: row.bounds.y + row.bounds.height / 2 })
      await until(app, async () => (await app.getByTestId('note-task-2').all()).length > 0, 'the checklist note')
      await tap(app, 'note-task-2')
      await wait(900)
      await app.screenshot({ path: `${out}-checklist-${theme}.png` })

      await app.getByTestId('notes-search').fill('launch')
      await until(app, async () => (await app.getByTestId('notes-list').all()).length > 0 && !(await hasText(app, 'Reading list')()), 'search results')
      await wait(800)
      await app.screenshot({ path: `${out}-search-${theme}.png` })
    } finally {
      await app.close()
    }
  } finally {
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
