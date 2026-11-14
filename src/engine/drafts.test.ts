import { afterEach, expect, test } from 'bun:test'
import { ImapFlow } from 'imapflow'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { getOutgoing } from './outbox'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import { loadThreads } from './threads'
import type { EngineEvent, MailEngine } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const draft = { to: ['kenji@example.com'], cc: [], bcc: [], subject: 'Half-written', body: 'Thinking out loud\n\nmore later' }

async function setup() {
  const server = await startImapServer({ INBOX: [{ raw: rawMessage({ n: 1 }) }] })
  const db = openDatabase(':memory:')
  cleanups.push(() => server.close(), () => db.close())
  const secrets: SecretStore = { get: async () => USER.pass, set: async () => {}, delete: async () => {} }
  const start = () => {
    const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false })
    const events: EngineEvent[] = []
    engine.subscribe((b) => events.push(...b))
    engine.setAccounts([server.account])
    cleanups.push(() => engine.dispose())
    return { engine, events }
  }
  return { server, db, account: server.account, start }
}

const drafts = (db: ReturnType<typeof openDatabase>, accountId: string) =>
  loadThreads(db, accountId, { account: { name: 'Mara', email: 'me@example.com' } }).filter((t) => t.folder === 'drafts')

test('a draft survives a restart and reopens with its fields', async () => {
  const { db, account, start } = await setup()
  const first = start()
  first.engine.saveDraft(account.id, 'draft-1', draft)
  first.engine.dispose()

  start()
  const [saved] = drafts(db, account.id)
  expect(saved).toMatchObject({ id: 'draft-1', folder: 'drafts', sender: 'Draft', subject: 'Half-written', snippet: 'Thinking out loud' })
  expect(saved!.draft).toEqual(draft)
  expect(saved!.messages[0]!.markdown).toBe(draft.body)
})

test('a draft keeps the files attached to it across a restart', async () => {
  const { db, account, start } = await setup()
  const dir = mkdtempSync(join(tmpdir(), 'jefi-draft-attach-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'roadmap.txt')
  writeFileSync(path, 'Q4 plan')
  const withFile = { ...draft, attachments: [{ name: 'roadmap.txt', size: '7 B', path }] }

  const first = start()
  first.engine.saveDraft(account.id, 'draft-1', withFile)
  first.engine.dispose()

  start()
  const [saved] = drafts(db, account.id)
  expect(saved!.draft).toEqual(withFile)
  expect(saved!.draft!.attachments![0]!.path).toBe(path)
})

test('editing a draft replaces it rather than piling up copies', async () => {
  const { db, account, start } = await setup()
  const { engine } = start()
  engine.saveDraft(account.id, 'draft-1', draft)
  engine.saveDraft(account.id, 'draft-1', { ...draft, subject: 'Now finished' })
  expect(drafts(db, account.id).map((t) => t.subject)).toEqual(['Now finished'])
})

test('discarding a draft removes it and publishes the change', async () => {
  const { db, account, start } = await setup()
  const { engine, events } = start()
  engine.saveDraft(account.id, 'draft-1', draft)
  const mark = events.length
  engine.deleteForever(account.id, 'draft-1')
  expect(drafts(db, account.id)).toEqual([])
  // Publishing is coalesced (one list update per second), so wait for it.
  const started = Date.now()
  while (Date.now() - started < 4000 && !events.slice(mark).some((e) => e.type === 'threadsChanged' && e.replaceAll)) await Bun.sleep(50)
  expect(events.slice(mark).some((e) => e.type === 'threadsChanged' && e.replaceAll)).toBe(true)
})

test('sending a draft consumes it; undo puts it back', async () => {
  const { db, account, start } = await setup()
  const { engine } = start()
  engine.saveDraft(account.id, 'draft-1', draft)
  engine.setOffline(true) // keep it queued rather than delivered
  engine.send(account.id, 'draft-1', draft)
  expect(drafts(db, account.id)).toEqual([])
  expect(getOutgoing(db, 'draft-1')?.mail).toEqual(draft)

  expect(await (engine as MailEngine).cancelSend(account.id, 'draft-1')).toBe(true)
  engine.saveDraft(account.id, 'draft-1', draft) // what the store does after a cancelled send
  expect(drafts(db, account.id).map((t) => t.id)).toEqual(['draft-1'])
})

// --- Remote Drafts (lume-zjv.4) ----------------------------------------------------------------

async function withDraftsFolder(options: { draftsFolder?: boolean } = {}) {
  const server = await startImapServer({
    INBOX: [{ raw: rawMessage({ n: 1 }) }],
    ...(options.draftsFolder === false
      ? {}
      : {
          // A draft another mail app saved: it has to stay visible.
          Drafts: { 'special-use': '\\Drafts', messages: [{ raw: rawMessage({ n: 2, subject: 'From my phone', messageId: '<phone@example.com>' }), flags: ['\\Draft', '\\Seen'] }] },
        }),
  })
  const db = openDatabase(':memory:')
  const secrets: SecretStore = { get: async () => USER.pass, set: async () => {}, delete: async () => {} }
  // A long delay: these tests drive syncs themselves.
  const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false, draftSyncDelayMs: 60_000 })
  const events: EngineEvent[] = []
  engine.subscribe((b) => events.push(...b))
  engine.setAccounts([server.account])
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  const account = server.account

  const sync = async () => {
    const mark = events.length
    engine.syncNow(account.id, true)
    for (let i = 0; i < 250; i++) {
      const done = events.slice(mark).find((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error'))
      if (done) return done
      await Bun.sleep(20)
    }
    throw new Error('sync did not finish')
  }
  /** What the server's Drafts mailbox holds. */
  const remote = async () => {
    const client = await server.connect()
    try {
      const lock = await client.getMailboxLock('Drafts')
      try {
        const out: Array<{ subject: string; messageId: string; flags: string[]; uid: number; inReplyTo: string; references: string }> = []
        for await (const m of client.fetch('1:*', { envelope: true, flags: true, uid: true, headers: ['references'] })) {
          const references = (m.headers?.toString() ?? '').replace(/^references:\s*/i, '').trim()
          out.push({ subject: m.envelope?.subject ?? '', messageId: m.envelope?.messageId ?? '', flags: [...(m.flags ?? [])].sort(), uid: m.uid, inReplyTo: m.envelope?.inReplyTo ?? '', references })
        }
        return out
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }
  }
  const listed = () => drafts(db, account.id).map((t) => t.subject).sort()
  return { server, db, engine, account, sync, remote, listed }
}

test('a draft is copied to the server Drafts mailbox, shown once, and updated in place', async () => {
  const { engine, account, sync, remote, listed } = await withDraftsFolder()
  await sync()
  engine.saveDraft(account.id, 'draft-1', draft)
  await sync()

  const first = await remote()
  expect(first.map((m) => m.subject).sort()).toEqual(['From my phone', 'Half-written'])
  const copy = first.find((m) => m.subject === 'Half-written')!
  expect(copy.flags).toEqual(['\\Draft', '\\Seen'])
  // The local draft and the other app's draft; the server copy of ours isn't listed twice.
  expect(listed()).toEqual(['From my phone', 'Half-written'])

  engine.saveDraft(account.id, 'draft-1', { ...draft, subject: 'Now finished' })
  await sync()
  const second = await remote()
  expect(second.map((m) => m.subject).sort()).toEqual(['From my phone', 'Now finished'])
  // Same draft, same Message-ID: replaced, not piled up.
  expect(second.find((m) => m.subject === 'Now finished')!.messageId).toBe(copy.messageId)
  expect(listed()).toEqual(['From my phone', 'Now finished'])

  // Nothing changed: no new APPEND.
  await sync()
  expect((await remote()).length).toBe(2)
})

test('a refused removal of the old server copy leaves the draft to retry, rather than uploading a duplicate', async () => {
  const { engine, account, sync, remote } = await withDraftsFolder()
  await sync()
  engine.saveDraft(account.id, 'draft-1', draft)
  await sync()
  expect((await remote()).map((m) => m.subject).sort()).toEqual(['From my phone', 'Half-written'])

  // The server refuses the EXPUNGE of the old copy: imapflow resolves messageDelete with false.
  const original = ImapFlow.prototype.messageDelete
  ImapFlow.prototype.messageDelete = async () => false
  try {
    engine.saveDraft(account.id, 'draft-1', { ...draft, subject: 'Now finished' })
    await sync()
    // The old copy is still there, so the new one must not go up beside it.
    expect((await remote()).map((m) => m.subject).sort()).toEqual(['From my phone', 'Half-written'])
  } finally {
    ImapFlow.prototype.messageDelete = original
  }
  // Next time round it goes through: replaced, not piled up.
  await sync()
  expect((await remote()).map((m) => m.subject).sort()).toEqual(['From my phone', 'Now finished'])
})

test('a reply’s draft copy threads like the reply, and saving it unchanged doesn’t upload it again', async () => {
  const { db, engine, account, sync, remote } = await withDraftsFolder()
  await sync()
  const parent = loadThreads(db, account.id).find((t) => t.subject === 'Message 1')!
  const reply = { ...draft, subject: 'Re: Message 1', replying: { threadId: parent.id } }
  engine.saveDraft(account.id, 'draft-1', reply)
  await sync()
  const copy = (await remote()).find((m) => m.subject === 'Re: Message 1')!
  expect(copy.inReplyTo).toBe('<m1@example.com>')
  expect(copy.references).toBe('<m1@example.com>')

  // The same draft saved again (Save draft twice, reopened and closed): the server copy stays put.
  engine.saveDraft(account.id, 'draft-1', reply)
  await sync()
  expect((await remote()).find((m) => m.subject === 'Re: Message 1')!.uid).toBe(copy.uid)
  // A real edit still goes up.
  engine.saveDraft(account.id, 'draft-1', { ...reply, body: 'Changed my mind' })
  await sync()
  expect((await remote()).find((m) => m.subject === 'Re: Message 1')!.uid).not.toBe(copy.uid)
})

test('discarding or sending a draft removes its server copy on the next sync', async () => {
  const { engine, account, sync, remote, listed } = await withDraftsFolder()
  await sync()
  engine.saveDraft(account.id, 'draft-1', draft)
  engine.saveDraft(account.id, 'draft-2', { ...draft, subject: 'Second thoughts' })
  await sync()
  expect((await remote()).length).toBe(3)

  engine.deleteForever(account.id, 'draft-1')
  // Gone from the list at once, even before the server hears about it.
  expect(listed()).toEqual(['From my phone', 'Second thoughts'])
  engine.setOffline(true) // keep the send queued; only the draft's removal matters here
  engine.send(account.id, 'draft-2', { ...draft, subject: 'Second thoughts' })
  expect(listed()).toEqual(['From my phone'])
  engine.setOffline(false)
  await sync()
  expect((await remote()).map((m) => m.subject)).toEqual(['From my phone'])
  expect(listed()).toEqual(['From my phone'])
})

test('an unreachable server never costs the local draft; it goes up once the server is back', async () => {
  const { server, db, engine, account, sync, remote, listed } = await withDraftsFolder()
  await sync()
  await server.pause()
  engine.saveDraft(account.id, 'draft-1', draft)
  const failed = await sync()
  expect(failed.type === 'syncState' && failed.state.status).toBe('error')
  expect(listed()).toEqual(['From my phone', 'Half-written'])
  expect((db.query("SELECT remote_synced_at FROM drafts WHERE id = 'draft-1'").get() as { remote_synced_at: number | null }).remote_synced_at).toBeNull()

  await server.resume()
  await sync()
  expect((await remote()).map((m) => m.subject).sort()).toEqual(['From my phone', 'Half-written'])
})

test('a draft whose attachment has moved is skipped, and the rest still go up', async () => {
  const { engine, account, sync, remote, listed } = await withDraftsFolder()
  await sync()
  engine.saveDraft(account.id, 'draft-1', { ...draft, subject: 'Has a ghost file', attachments: [{ name: 'gone.txt', size: '7 B', path: join(tmpdir(), 'jefi-never-written.txt') }] })
  engine.saveDraft(account.id, 'draft-2', { ...draft, subject: 'Plain text only' })

  const done = await sync()
  expect(done.type === 'syncState' && done.state.status).toBe('idle')
  expect((await remote()).map((m) => m.subject).sort()).toEqual(['From my phone', 'Plain text only'])
  // Nothing was lost locally: the draft is still there with its attachment listed.
  expect(listed()).toEqual(['From my phone', 'Has a ghost file', 'Plain text only'])
})

test('without a Drafts mailbox, drafts stay local and syncing still works', async () => {
  const { engine, account, sync, listed } = await withDraftsFolder({ draftsFolder: false })
  await sync()
  engine.saveDraft(account.id, 'draft-1', draft)
  const done = await sync()
  expect(done.type === 'syncState' && done.state.status).toBe('idle')
  expect(listed()).toEqual(['Half-written'])
})

test('a draft whose From changes moves to that account, and its server copy is taken away from the first', async () => {
  const { db, account, server } = await setup()
  const other = { ...server.account, id: `${account.id}-work`, email: 'mara@work.example' }
  const secrets: SecretStore = { get: async () => USER.pass, set: async () => {}, delete: async () => {} }
  const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false })
  engine.setAccounts([account, other])
  cleanups.push(() => engine.dispose())

  engine.saveDraft(account.id, 'draft-1', draft)
  // As if it had been pushed to the first account's Drafts.
  db.run("UPDATE drafts SET remote_message_id = '<draft-1@jefi>' WHERE id = 'draft-1'")
  engine.saveDraft(other.id, 'draft-1', { ...draft, from: other.id })

  expect(drafts(db, account.id)).toEqual([])
  const [moved] = drafts(db, other.id)
  expect(moved!.draft).toEqual({ ...draft, from: other.id })
  expect(db.query('SELECT account_id, message_id FROM draft_removals').all()).toEqual([{ account_id: account.id, message_id: '<draft-1@jefi>' }])
})
