import { afterEach, describe, expect, test } from 'bun:test'
import type { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { openDatabase, type MailDatabase } from './db'
import { ensureAccount, listMailboxes } from './mail-store'
import { discoverMailboxes, fetchBodies, parseReferences, snippetOf, storedBody, syncAccount, syncMailbox, syncOrder } from './sync'
import { rawMessage, startImapServer } from './testing/imap-server'
import { loadThreads } from './threads'

type Server = Awaited<ReturnType<typeof startImapServer>>
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(folders: Parameters<typeof startImapServer>[0]) {
  const server = await startImapServer(folders)
  const client = await server.connect()
  const db = openDatabase(':memory:')
  ensureAccount(db, server.account.id, server.account.email)
  cleanups.push(() => server.close(), () => client.logout().catch(() => client.close()), () => db.close())
  return { server, client, db, accountId: server.account.id }
}

const count = (db: MailDatabase, sql: string, ...params: unknown[]) => (db.query(sql).get(...(params as [])) as { n: number }).n
const box = (db: MailDatabase, accountId: string, path: string) => listMailboxes(db, accountId).find((b) => b.path === path)!
const many = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ raw: rawMessage({ n: from + i }) }))

describe('mailbox discovery', () => {
  test('persists folders with special-use, and follows removals on the server', async () => {
    const { server, client, db, accountId } = await setup({
      INBOX: [],
      Sent: { 'special-use': '\\Sent', messages: [] },
      Archive: { 'special-use': '\\Archive', messages: [{ raw: rawMessage({ n: 1 }) }] },
      Projects: [],
    })
    const boxes = await discoverMailboxes(client, db, accountId)
    expect(boxes.map((b) => [b.path, b.special_use])).toEqual([
      ['Archive', '\\Archive'],
      ['INBOX', '\\Inbox'],
      ['Projects', null],
      ['Sent', '\\Sent'],
    ])
    expect(syncOrder(boxes).map((b) => b.path)).toEqual(['INBOX', 'Sent', 'Archive', 'Projects'])

    await syncMailbox(client, db, accountId, box(db, accountId, 'Archive'))
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(1)

    server.removeFolder('Archive')
    await client.logout()
    const fresh = await server.connect()
    cleanups.push(() => fresh.logout().catch(() => fresh.close()))
    const after = await discoverMailboxes(fresh, db, accountId)
    expect(after.map((b) => b.path)).not.toContain('Archive')
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(0)
  })
})

describe('mailbox sync', () => {
  test('initial sync stores envelopes, flags, threading headers and a checkpoint', async () => {
    const { client, db, accountId } = await setup({
      INBOX: [
        { raw: rawMessage({ n: 1, subject: 'Kickoff' }), flags: ['\\Seen', '$Important'] },
        { raw: rawMessage({ n: 2, subject: 'Re: Kickoff', inReplyTo: '<m1@example.com>', references: ['<m0@example.com>', '<m1@example.com>'] }), flags: ['\\Flagged'] },
      ],
    })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    const result = await syncMailbox(client, db, accountId, inbox!)
    expect(result).toMatchObject({ path: 'INBOX', fetched: 2, reset: false })

    const rows = db.query('SELECT * FROM messages ORDER BY date').all() as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.subject, r.message_id, r.from_email, r.from_name, r.seen, r.flagged])).toEqual([
      ['Kickoff', '<m1@example.com>', 'ada@example.com', 'Ada Lovelace', 1, 0],
      ['Re: Kickoff', '<m2@example.com>', 'ada@example.com', 'Ada Lovelace', 0, 1],
    ])
    expect(JSON.parse(rows[0]!.keywords_json as string)).toEqual(['$Important'])
    expect(rows[1]!.in_reply_to).toBe('<m1@example.com>')
    expect(JSON.parse(rows[1]!.references_json as string)).toEqual(['<m0@example.com>', '<m1@example.com>'])
    expect(JSON.parse(rows[0]!.to_json as string)).toEqual([{ name: 'Me', email: 'me@example.com' }])
    expect(rows[0]!.date).toBe(Date.UTC(2026, 0, 1, 9, 0, 1))

    const checkpoint = box(db, accountId, 'INBOX')
    expect(checkpoint.last_uid).toBe(2)
    expect(checkpoint.uidnext).toBe(3)
    expect(checkpoint.uidvalidity).toBeGreaterThan(0)
    expect(checkpoint.synced_at).toBeGreaterThan(0)
  })

  test('syncs in batches and only fetches new UIDs afterwards', async () => {
    const { server, client, db, accountId } = await setup({ INBOX: many(1, 25) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    expect((await syncMailbox(client, db, accountId, inbox!, { batchSize: 10 })).fetched).toBe(25)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(25)

    expect((await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))).fetched).toBe(0)

    server.append('INBOX', { raw: rawMessage({ n: 26 }) })
    server.append('INBOX', { raw: rawMessage({ n: 27 }) })
    await client.noop()
    expect((await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))).fetched).toBe(2)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(27)
    expect(box(db, accountId, 'INBOX').last_uid).toBe(27)
  })

  test('a first sync stores the newest slice first; interrupted there, it resumes without duplicates', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 30) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    const abort = new AbortController()
    let batches = 0
    const original = client.fetch.bind(client)
    ;(client as { fetch: ImapFlow['fetch'] }).fetch = ((...args: Parameters<ImapFlow['fetch']>) => {
      if (++batches === 1) queueMicrotask(() => abort.abort())
      return original(...args)
    }) as ImapFlow['fetch']

    const partial = await syncMailbox(client, db, accountId, inbox!, { batchSize: 10, newestFirst: 10, signal: abort.signal })
    expect(partial.fetched).toBe(10)
    // The newest ten are in, but the checkpoint hasn't moved: everything older is still to come.
    expect(count(db, "SELECT count(*) n FROM messages WHERE subject IN ('Message 30', 'Message 21')")).toBe(2)
    expect(box(db, accountId, 'INBOX').last_uid).toBe(0)

    ;(client as { fetch: ImapFlow['fetch'] }).fetch = original
    await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'), { batchSize: 10, newestFirst: 10 })
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(30)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(30)
    expect(box(db, accountId, 'INBOX').last_uid).toBe(30)
  })

  test('an interrupted sync resumes from its last committed batch', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 30) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    const abort = new AbortController()
    let batches = 0
    // Abort once the first batch has been fetched; the loop checks the signal before the next one.
    const original = client.fetch.bind(client)
    ;(client as { fetch: ImapFlow['fetch'] }).fetch = ((...args: Parameters<ImapFlow['fetch']>) => {
      if (++batches === 1) queueMicrotask(() => abort.abort())
      return original(...args)
    }) as ImapFlow['fetch']

    const partial = await syncMailbox(client, db, accountId, inbox!, { batchSize: 10, signal: abort.signal })
    expect(partial.fetched).toBe(10)
    expect(box(db, accountId, 'INBOX').last_uid).toBe(10)
    // Not caught up, so a later syncAccount must not take this folder for unchanged.
    expect(box(db, accountId, 'INBOX').exists_count).toBeNull()

    ;(client as { fetch: ImapFlow['fetch'] }).fetch = original
    const resumed = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'), { batchSize: 10 })
    expect(resumed.fetched).toBe(20)
    expect(box(db, accountId, 'INBOX').exists_count).toBe(30)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(30)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(30)
  })

  test('a UIDVALIDITY change resets the folder without leaving duplicates', async () => {
    const { server, client, db, accountId } = await setup({ INBOX: many(1, 5) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    await syncMailbox(client, db, accountId, inbox!)
    const before = box(db, accountId, 'INBOX')

    server.renumber('INBOX', before.uidvalidity! + 7)
    await client.logout()
    const fresh = await server.connect()
    cleanups.push(() => fresh.logout().catch(() => fresh.close()))

    const result = await syncMailbox(fresh, db, accountId, box(db, accountId, 'INBOX'))
    expect(result).toMatchObject({ path: 'INBOX', fetched: 5, reset: true })
    const after = box(db, accountId, 'INBOX')
    expect(after.uidvalidity).toBe(before.uidvalidity! + 7)
    expect(after.last_uid).toBe(1004)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(5)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(5)
    expect(count(db, 'SELECT min(uid) n FROM message_mailboxes')).toBe(1000)
  })

  test('duplicate copies of a message in one folder collapse to one, in the same batch and later', async () => {
    const twice = rawMessage({ n: 1, subject: 'Delivered twice', messageId: '<dup@example.com>' })
    const { server, client, db, accountId } = await setup({ INBOX: [{ raw: twice }, { raw: twice }] })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    const first = await syncMailbox(client, db, accountId, inbox!)
    expect(first.fetched).toBe(2)
    expect(first.skipped).toBe(0)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(1)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(1)

    // A third copy arriving later is another alias of the first link, still one row (lume-6fz).
    server.append('INBOX', { raw: twice })
    await client.noop()
    await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(1)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(1)
    expect(count(db, 'SELECT max(uid) n FROM message_mailboxes')).toBe(1)
    expect(count(db, 'SELECT count(*) n FROM mailbox_aliases')).toBe(2)
    expect(loadThreads(db, accountId).length).toBe(1)
  })

  test('the same message in two folders is one row with two links', async () => {
    const shared = rawMessage({ n: 1, subject: 'Filed twice' })
    const { client, db, accountId } = await setup({ INBOX: [{ raw: shared }], Archive: { 'special-use': '\\Archive', messages: [{ raw: shared, flags: ['\\Seen'] }] } })
    const result = await syncAccount(client, db, accountId)
    expect(result.results.map((r) => r.fetched)).toEqual([1, 1])
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(1)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(2)
  })
})

describe('changes made on the server', () => {
  const other = async (server: Server, path: string, fn: (client: ImapFlow) => Promise<unknown>) => {
    const client = await server.connect()
    try {
      await client.mailboxOpen(path)
      await fn(client)
    } finally {
      await client.logout()
    }
  }
  const flagsOf = (db: MailDatabase, subject: string) => db.query('SELECT seen, flagged FROM messages WHERE subject = ?').get(subject) as { seen: number; flagged: number }

  test('flags set in another client show up after the next sync', async () => {
    const { server, client, db, accountId } = await setup({ INBOX: many(1, 3) })
    await syncAccount(client, db, accountId)
    expect(flagsOf(db, 'Message 2')).toEqual({ seen: 0, flagged: 0 })

    await other(server, 'INBOX', (c) => c.messageFlagsAdd({ header: { subject: 'Message 2' } }, ['\\Seen', '\\Flagged']))
    const result = await syncAccount(client, db, accountId)
    expect(result.results[0]!.flagsChanged).toBe(1)
    expect(flagsOf(db, 'Message 2')).toEqual({ seen: 1, flagged: 1 })

    await other(server, 'INBOX', (c) => c.messageFlagsRemove({ header: { subject: 'Message 2' } }, ['\\Flagged']))
    await syncAccount(client, db, accountId)
    expect(flagsOf(db, 'Message 2')).toEqual({ seen: 1, flagged: 0 })
  })

  test('messages deleted elsewhere are removed locally', async () => {
    const { server, client, db, accountId } = await setup({ INBOX: many(1, 4) })
    await syncAccount(client, db, accountId)
    await other(server, 'INBOX', (c) => c.messageDelete({ header: { subject: 'Message 3' } }))
    const result = await syncAccount(client, db, accountId)
    expect(result.results[0]!.removed).toBe(1)
    expect((db.query('SELECT subject FROM messages ORDER BY subject').all() as Array<{ subject: string }>).map((r) => r.subject)).toEqual(['Message 1', 'Message 2', 'Message 4'])
  })

  test('a message moved elsewhere keeps its row and downloaded body', async () => {
    const { server, client, db, accountId } = await setup({ INBOX: many(1, 2), Archive: { 'special-use': '\\Archive', messages: [] } })
    await syncAccount(client, db, accountId)
    await fetchBodies(client, db, accountId, 10)
    const before = db.query("SELECT id FROM messages WHERE subject = 'Message 1'").get() as { id: number }
    await other(server, 'INBOX', (c) => c.messageMove({ header: { subject: 'Message 1' } }, 'Archive'))

    await syncAccount(client, db, accountId)
    const after = db.query(
      "SELECT m.id, mb.path, (SELECT count(*) FROM bodies b WHERE b.message_id = m.id) AS bodies FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE m.subject = 'Message 1'",
    ).all()
    expect(after).toEqual([{ id: before.id, path: 'Archive', bodies: 1 }])
  })

  test('local changes still queued are not overwritten by the server flags they are about to change', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 1) })
    await syncAccount(client, db, accountId)
    const { id } = db.query('SELECT id FROM messages').get() as { id: number }
    db.run('UPDATE messages SET flagged = 1 WHERE id = ?', [id])
    db.run("INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES (?, 'flags', ?, 1)", [accountId, JSON.stringify({ kind: 'flags', messageId: id, locations: [], add: ['\\Flagged'], remove: [] })])
    // Force a full flag read (no CONDSTORE shortcut).
    db.run('UPDATE mailboxes SET highestmodseq = NULL')
    await syncAccount(client, db, accountId)
    expect(flagsOf(db, 'Message 1').flagged).toBe(1)
  })
})

// lume-75z.4: syncAccount asks every folder's STATUS first and only opens the ones that changed.
describe('folders STATUS shows unchanged are skipped', () => {
  const folders = () => ({
    INBOX: many(1, 3),
    Archive: { 'special-use': '\\Archive', messages: many(4, 6) },
    Projects: many(7, 8),
    Empty: [],
  })
  const synced = (result: Awaited<ReturnType<typeof syncAccount>>) => result.results.map((r) => r.path).sort()
  const other = async (server: Server, path: string, fn: (client: ImapFlow) => Promise<unknown>) => {
    const client = await server.connect()
    try {
      await client.mailboxOpen(path)
      await fn(client)
    } finally {
      await client.logout()
    }
  }

  test('a second sync with nothing changed on the server opens no folder', async () => {
    const { client, db, accountId } = await setup(folders())
    const first = await syncAccount(client, db, accountId)
    expect(synced(first)).toEqual(['Archive', 'Empty', 'INBOX', 'Projects'])
    expect(first.foldersSkipped).toBe(0)

    const opened: string[] = []
    const original = client.getMailboxLock.bind(client)
    ;(client as { getMailboxLock: ImapFlow['getMailboxLock'] }).getMailboxLock = ((path, ...rest) => {
      opened.push(String(path))
      return original(path, ...rest)
    }) as ImapFlow['getMailboxLock']
    const second = await syncAccount(client, db, accountId)
    expect(second.results).toEqual([])
    expect(second.foldersSkipped).toBe(4)
    expect(opened).toEqual([])
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(8)
  })

  test('new mail, a deletion and a flag change each reopen only their folder', async () => {
    const { server, client, db, accountId } = await setup(folders())
    await syncAccount(client, db, accountId)

    server.append('Projects', { raw: rawMessage({ n: 9 }) })
    let result = await syncAccount(client, db, accountId)
    expect(synced(result)).toEqual(['Projects'])
    expect(result.results[0]!.fetched).toBe(1)
    expect(result.foldersSkipped).toBe(3)

    await other(server, 'Archive', (c) => c.messageDelete({ header: { subject: 'Message 5' } }))
    result = await syncAccount(client, db, accountId)
    expect(synced(result)).toEqual(['Archive'])
    expect(result.results[0]!.removed).toBe(1)
    expect(count(db, "SELECT count(*) n FROM messages WHERE subject = 'Message 5'")).toBe(0)

    // Flags don't move UIDNEXT or the count; CONDSTORE's HIGHESTMODSEQ is what gives them away.
    await other(server, 'Projects', (c) => c.messageFlagsAdd({ header: { subject: 'Message 7' } }, ['\\Flagged']))
    result = await syncAccount(client, db, accountId)
    expect(synced(result)).toEqual(['Projects'])
    expect(result.results[0]!.flagsChanged).toBe(1)
    expect(count(db, "SELECT flagged n FROM messages WHERE subject = 'Message 7'")).toBe(1)

    expect((await syncAccount(client, db, accountId)).results).toEqual([])
  })

  test('without CONDSTORE a flag change waits for the periodic full sync', async () => {
    const { server, client, db, accountId } = await setup(folders())
    await syncAccount(client, db, accountId)
    // Now STATUS can't report HIGHESTMODSEQ, as on a server without CONDSTORE.
    client.capabilities.delete('CONDSTORE')

    await other(server, 'Projects', (c) => c.messageFlagsAdd({ header: { subject: 'Message 7' } }, ['\\Flagged']))
    const recent = await syncAccount(client, db, accountId)
    expect(recent.results).toEqual([])
    expect(count(db, "SELECT flagged n FROM messages WHERE subject = 'Message 7'")).toBe(0)

    // Past the refresh window every folder is synced in full again, and the flag arrives.
    const stale = await syncAccount(client, db, accountId, { flagRefreshMs: 0 })
    expect(synced(stale)).toEqual(['Archive', 'Empty', 'INBOX', 'Projects'])
    expect(count(db, "SELECT flagged n FROM messages WHERE subject = 'Message 7'")).toBe(1)
  })

  test('a UIDVALIDITY change alone is enough to reopen the folder', async () => {
    const { server, client, db, accountId } = await setup(folders())
    await syncAccount(client, db, accountId)
    const before = box(db, accountId, 'Archive')
    server.renumber('Archive', before.uidvalidity! + 7)
    // Renumbering also moves UIDNEXT; line the stored one up so only UIDVALIDITY differs.
    db.run('UPDATE mailboxes SET uidnext = 1003 WHERE id = ?', [before.id])

    const result = await syncAccount(client, db, accountId)
    expect(synced(result)).toEqual(['Archive'])
    expect(result.results[0]).toMatchObject({ reset: true, fetched: 3 })
    expect(box(db, accountId, 'Archive').uidvalidity).toBe(before.uidvalidity! + 7)
  })

  test('a folder with a local gap is reopened and repaired', async () => {
    const { client, db, accountId } = await setup(folders())
    await syncAccount(client, db, accountId)
    const archive = box(db, accountId, 'Archive')
    db.run('DELETE FROM message_mailboxes WHERE mailbox_id = ?', [archive.id])
    db.run('DELETE FROM messages WHERE id NOT IN (SELECT message_id FROM message_mailboxes)')

    const result = await syncAccount(client, db, accountId)
    expect(synced(result)).toEqual(['Archive'])
    expect(result.results[0]!.repaired).toBe(3)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes WHERE mailbox_id = ?', archive.id)).toBe(3)
  })

  test('a folder with local changes still queued is always reopened', async () => {
    const { client, db, accountId } = await setup(folders())
    await syncAccount(client, db, accountId)
    const projects = box(db, accountId, 'Projects')
    const { id } = db.query("SELECT id FROM messages WHERE subject = 'Message 7'").get() as { id: number }
    db.run("INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES (?, 'flags', ?, 1)", [
      accountId,
      JSON.stringify({ kind: 'flags', messageId: id, locations: [{ mailboxId: projects.id, path: 'Projects', uid: 1 }], add: ['\\Seen'], remove: [] }),
    ])
    expect(synced(await syncAccount(client, db, accountId))).toEqual(['Projects'])
  })

  test('a failed, empty or INBOX-less folder list never drops folders or mail', async () => {
    const { client, db, accountId } = await setup(folders())
    await syncAccount(client, db, accountId)
    const original = client.list.bind(client)
    const inboxless = (await original()).filter((b) => b.path !== 'INBOX')
    for (const response of [false, [], inboxless]) {
      ;(client as { list: ImapFlow['list'] }).list = (async () => response) as ImapFlow['list']
      await expect(discoverMailboxes(client, db, accountId)).rejects.toThrow(/keeping the folders/)
      await expect(syncAccount(client, db, accountId)).rejects.toThrow(/keeping the folders/)
      expect(listMailboxes(db, accountId).map((b) => b.path)).toEqual(['Archive', 'Empty', 'INBOX', 'Projects'])
      expect(count(db, 'SELECT count(*) n FROM messages')).toBe(8)
    }
  })
})

describe('bodies', () => {
  test('downloads newest bodies first with text, html, snippet and attachments', async () => {
    const { client, db, accountId } = await setup({
      INBOX: [
        { raw: rawMessage({ n: 1, text: 'Oldest one' }) },
        {
          raw: rawMessage({
            n: 2,
            text: 'Hi Mara,\n> quoted line that should not be in the snippet\nThe deck is attached.',
            html: '<p>Hi Mara,</p><p>The deck is attached.</p>',
            attachment: { filename: 'deck.txt', content: 'slides' },
          }),
        },
        { raw: rawMessage({ n: 3, text: 'Newest one' }) },
      ],
    })
    await syncAccount(client, db, accountId)
    // Syncing stores headers only; bodies are their own pass.
    expect(count(db, 'SELECT count(*) n FROM bodies')).toBe(0)
    expect(await fetchBodies(client, db, accountId, 2)).toBe(2)
    const bodies = db.query('SELECT m.subject, b.text FROM bodies b JOIN messages m ON m.id = b.message_id ORDER BY m.date').all() as Array<{ subject: string; text: string }>
    expect(bodies.map((b) => b.subject)).toEqual(['Message 2', 'Message 3'])

    const rich = db.query("SELECT m.snippet, m.has_attachments, b.html FROM messages m JOIN bodies b ON b.message_id = m.id WHERE m.subject = 'Message 2'").get() as Record<string, unknown>
    expect(rich.snippet).toBe('Hi Mara, The deck is attached.')
    expect(rich.has_attachments).toBe(1)
    expect(String(rich.html)).toContain('The deck is attached.')
    expect(db.query('SELECT filename, content_type FROM attachments').all()).toEqual([{ filename: 'deck.txt', content_type: 'text/plain' }])

    expect(await fetchBodies(client, db, accountId, 10)).toBe(1)
    expect(count(db, 'SELECT count(*) n FROM bodies')).toBe(3)
  })
})

// lume-75z.7: imapflow's search() returns `false` on any failure (dropped connection, NO/BAD,
// timeout) rather than throwing. Treating that as "no matches" used to make a sync unlink — and a
// later sync permanently delete — a whole folder's local copy while the checkpoint stayed put, so
// the mail was never re-fetched. These tests cover the fix (search failures fail the sync instead)
// and the self-heal (a database already damaged that way catches back up).
describe('a failed UID search does not lose mail', () => {
  /** Makes client.search() return `false` (as imapflow does on any failure) while `shouldFail` says
   * so, forwarding to the real implementation otherwise. Returns a function that undoes it. */
  const stubSearch = (client: ImapFlow, shouldFail: () => boolean) => {
    const original = client.search.bind(client)
    ;(client as { search: ImapFlow['search'] }).search = (async (...args: Parameters<ImapFlow['search']>) => (shouldFail() ? false : original(...args))) as ImapFlow['search']
    return () => {
      ;(client as { search: ImapFlow['search'] }).search = original
    }
  }

  test("refreshKnown's search failing errors the sync and leaves every link alone", async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 5) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    await syncMailbox(client, db, accountId, inbox!)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(5)

    // Fail only the second search of the sync — the "1:lastUid" refreshKnown call, as a connection
    // drop mid-sync would (the first search, for new UIDs above the checkpoint, still answers).
    let calls = 0
    const restore = stubSearch(client, () => ++calls === 2)
    await expect(syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))).rejects.toThrow()
    restore()

    // Nothing was unlinked, and nothing was deleted, by the failed attempt.
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(5)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(5)

    // The next sync, with a working connection, succeeds and finds nothing changed.
    const result = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(result.removed).toBe(0)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(5)
  })

  test('the new-mail search failing errors the sync too, rather than silently skipping new mail', async () => {
    const { server, client, db, accountId } = await setup({ INBOX: many(1, 3) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    await syncMailbox(client, db, accountId, inbox!)

    server.append('INBOX', { raw: rawMessage({ n: 4 }) })
    await client.noop()
    const restore = stubSearch(client, () => true)
    await expect(syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))).rejects.toThrow()
    restore()

    // The checkpoint didn't move, so the new message is still there to fetch next time.
    expect(box(db, accountId, 'INBOX').last_uid).toBe(3)
    const result = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(result.fetched).toBe(1)
  })

  test('sanity guard: EXISTS says mail is there but both UID searches come back empty — refuses to unlink', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 3) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    await syncMailbox(client, db, accountId, inbox!)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(3)

    // A well-formed but wrong response (not `false`): both ranges come back empty even though EXISTS
    // still reports 3 messages — a healthy server can't produce this, so it must not read as "delete
    // everything I know about".
    const original = client.search.bind(client)
    ;(client as { search: ImapFlow['search'] }).search = (async () => []) as ImapFlow['search']
    await expect(syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))).rejects.toThrow()
    ;(client as { search: ImapFlow['search'] }).search = original
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(3)

    const result = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(result.removed).toBe(0)
  })
})

describe('self-heal: gap-fill repairs a database already damaged by the old behavior', () => {
  test('a folder unlinked and orphaned but with the checkpoint left high heals completely', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 30) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    await syncMailbox(client, db, accountId, inbox!)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(30)

    // What the bug left behind: every link gone, the messages (now orphaned) deleted, but last_uid
    // — the checkpoint — untouched, so a normal sync would never look below it again.
    db.run('DELETE FROM message_mailboxes')
    db.run('DELETE FROM messages')
    expect(box(db, accountId, 'INBOX').last_uid).toBe(30)

    const result = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(result.repaired).toBe(30)
    expect(result.fetched).toBe(0)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(30)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(30)
    // The checkpoint is unchanged — it was never wrong, only what it protected was missing.
    expect(box(db, accountId, 'INBOX').last_uid).toBe(30)

    // Repairing twice in a row must not duplicate anything.
    const again = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(again.repaired).toBe(0)
    expect(count(db, 'SELECT count(*) n FROM message_mailboxes')).toBe(30)
  })

  test('repairLimit caps the repair to the newest UIDs, leaving the rest for an uncapped sync', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 20) })
    const [inbox] = await discoverMailboxes(client, db, accountId)
    await syncMailbox(client, db, accountId, inbox!)
    db.run('DELETE FROM message_mailboxes')
    db.run('DELETE FROM messages')

    const capped = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'), { repairLimit: 5 })
    expect(capped.repaired).toBe(5)
    const subjects = (db.query('SELECT subject FROM messages ORDER BY subject').all() as Array<{ subject: string }>).map((r) => r.subject)
    expect(subjects.sort()).toEqual(['Message 16', 'Message 17', 'Message 18', 'Message 19', 'Message 20'])
    expect(box(db, accountId, 'INBOX').last_uid).toBe(20)

    // The next, uncapped sync (a full sync behind it) finishes the job.
    const rest = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(rest.repaired).toBe(15)
    expect(count(db, 'SELECT count(*) n FROM messages')).toBe(20)
  })

  test('gap-fill does not resurrect a message a pending move already took out of this folder', async () => {
    const { client, db, accountId } = await setup({ INBOX: many(1, 3), Archive: { 'special-use': '\\Archive', messages: [] } })
    await discoverMailboxes(client, db, accountId)
    const inboxBox = box(db, accountId, 'INBOX')
    const archiveBox = box(db, accountId, 'Archive')
    await syncMailbox(client, db, accountId, inboxBox)
    const message = db.query("SELECT id FROM messages WHERE subject = 'Message 2'").get() as { id: number }

    // What queueMove does: the real link is replaced by a placeholder in the target, and the queued
    // op carries the source location the move will act on.
    db.run('DELETE FROM message_mailboxes WHERE message_id = ?', [message.id])
    db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, ?, ?)', [archiveBox.id, -message.id, message.id])
    db.run('INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)', [
      accountId,
      'move',
      JSON.stringify({ kind: 'move', messageId: message.id, locations: [{ mailboxId: inboxBox.id, path: 'INBOX', uid: 2 }], target: { mailboxId: archiveBox.id, path: 'Archive' } }),
      Date.now(),
    ])

    // The server still has it under uid 2 (the move hasn't replayed), which would otherwise look like
    // a gap-fill candidate for INBOX.
    const result = await syncMailbox(client, db, accountId, box(db, accountId, 'INBOX'))
    expect(result.repaired).toBe(0)
    const links = db.query('SELECT mailbox_id, uid FROM message_mailboxes WHERE message_id = ?').all(message.id) as Array<{ mailbox_id: number; uid: number }>
    expect(links).toEqual([{ mailbox_id: archiveBox.id, uid: -message.id }])
  })
})

describe('helpers', () => {
  test('parseReferences handles folded headers', () => {
    expect(parseReferences('References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\n')).toEqual(['<a@x>', '<b@x>', '<c@x>'])
    expect(parseReferences('')).toEqual([])
  })

  test('snippetOf drops quoted lines and collapses whitespace', () => {
    expect(snippetOf('Hello\n\n> old\n  there  ')).toBe('Hello there')
    // A reply's attribution line goes with the quote it introduces.
    expect(snippetOf('Sounds good to me.\r\n\r\nOn Tue, Lea Ortiz wrote:\r\n> Are we still on?\r\n')).toBe('Sounds good to me.')
  })

  // Slack, Resend and others send raw UTF-8 in parts labelled quoted-printable (lume-02d).
  test('storedBody keeps raw 8-bit UTF-8 in a quoted-printable part', async () => {
    const raw = Buffer.from('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nYou\u2019ve got caf=C3=A9 \u034f\u200c\r\n')
    const body = storedBody(await simpleParser(raw))
    expect(body.text).toBe('You\u2019ve got caf\u00e9 \u034f\u200c\n')
    expect(body.snippet).toBe('You\u2019ve got caf\u00e9 \u034f\u200c')
  })
})

test('initial sync of 2,000 messages stays quick', async () => {
  const { client, db, accountId } = await setup({ INBOX: many(1, 2000) })
  const started = performance.now()
  const result = await syncAccount(client, db, accountId, { batchSize: 500 })
  const elapsed = performance.now() - started
  expect(result.results[0]!.fetched).toBe(2000)
  expect(count(db, 'SELECT count(*) n FROM messages')).toBe(2000)
  console.log(`2,000 envelopes synced in ${Math.round(elapsed)}ms`)
  expect(elapsed).toBeLessThan(20_000)
}, 30_000)
