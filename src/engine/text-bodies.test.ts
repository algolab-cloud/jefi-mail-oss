import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { resolveAttachmentTarget, settleAttachmentSize } from './attachment-cache'
import { openDatabase, type MailDatabase } from './db'
import { ensureAccount, saveMailboxes, storeBatch } from './mail-store'
import { downloadAttachment, fetchBodies, fetchBodiesOf, storedBody, syncAccount } from './sync'
import { rawMessage, startImapServer } from './testing/imap-server'
import { uiThreadId } from './threading'

// lume-75z.9: bodies are fetched without their attachments (BODYSTRUCTURE, then text parts only),
// and must store exactly what parsing the whole source stores.

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const message = (n: number, contentType: string, body: string[], extra: string[] = []) =>
  [
    'From: Ada Lovelace <ada@example.com>',
    'To: Me <me@example.com>',
    `Subject: Fixture ${n}`,
    `Message-ID: <f${n}@example.com>`,
    `Date: ${new Date(Date.UTC(2026, 0, 2, 9, 0, n)).toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    ...extra,
    `Content-Type: ${contentType}`,
    '',
    ...body,
  ].join('\r\n')

const base64 = (bytes: Buffer) => bytes.toString('base64').replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '')
// Deterministic noise, so base64 can't shrink it and the byte counts below mean something.
const noise = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 2654435761 + seed * 40503) >>> 24))

const PDF = noise(200_000, 1)
const UNUSED_GIF = noise(60_000, 2)
const PNG = noise(300, 3)
const PHOTO = noise(900, 4)
const INNER = message(90, 'multipart/mixed; boundary="inner"', [
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The original message',
  '--inner',
  'Content-Type: text/csv; name="inner.csv"',
  'Content-Disposition: attachment; filename="inner.csv"',
  '',
  'a,b',
  '--inner--',
  '',
])

const FIXTURES = {
  plain: rawMessage({ n: 1, text: 'Plain and simple.\n> quoted\nThe end.' }),
  flowed: message(2, 'text/plain; charset=utf-8; format=flowed', ['Soft broken ', 'line, and a hard one.', 'Next line.', '']),
  alternative: rawMessage({ n: 3, text: 'Hi Mara,\nThe deck is attached.', html: '<p>Hi Mara,</p><p>The <b>deck</b> is attached.</p>' }),
  htmlOnly: message(4, 'text/html; charset=utf-8', ['<html><body><h1>Only HTML</h1><p>No text part here.</p></body></html>', '']),
  attachments: message(5, 'multipart/mixed; boundary="mix"', [
    '--mix',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The report and a photo.',
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>The report and a photo.</p>',
    '--alt--',
    '',
    '--mix',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    base64(PDF),
    '--mix',
    // octet-stream with a telling name: simpleParser reports it as image/jpeg.
    'Content-Type: application/octet-stream; name="photo.jpg"',
    'Content-Disposition: attachment; filename="photo.jpg"',
    'Content-Transfer-Encoding: base64',
    '',
    base64(PHOTO),
    '--mix',
    'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    '',
    'Attached notes, not body text.',
    '--mix--',
    '',
  ]),
  latin1: message(6, 'multipart/alternative; boundary="alt"', [
    '--alt',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Caf=E9 cr=E8me, na=EFve =',
    'fa=E7ade.',
    '--alt',
    'Content-Type: text/html; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>Caf=E9 cr=E8me, na=EFve fa=E7ade.</p>',
    '--alt--',
    '',
  ]),
  inlineImage: message(7, 'multipart/related; boundary="rel"', [
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Logo: <img src="cid:logo@example.com"></p><p>Gone: <img src="cid:missing@example.com"></p>',
    '--rel',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo@example.com>',
    'Content-Transfer-Encoding: base64',
    '',
    base64(PNG),
    '--rel',
    // Inline but never shown by the HTML: left out of the list, and never downloaded.
    'Content-Type: image/gif; name="unused.gif"',
    'Content-Disposition: inline; filename="unused.gif"',
    'Content-ID: <unused@example.com>',
    'Content-Transfer-Encoding: base64',
    '',
    base64(UNUSED_GIF),
    '--rel--',
    '',
  ]),
  forwarded: message(8, 'multipart/mixed; boundary="fwd"', [
    '--fwd',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'See the message below.',
    '--fwd',
    'Content-Type: message/rfc822; name="original.eml"',
    'Content-Disposition: attachment; filename="original.eml"',
    '',
    INNER,
    '--fwd--',
    '',
  ]),
  // An inline forwarded message is rendered into the body by simpleParser: this one takes the whole source.
  inlineForward: message(9, 'multipart/mixed; boundary="fwd"', [
    '--fwd',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Forwarded inline:',
    '--fwd',
    'Content-Type: message/rfc822',
    'Content-Disposition: inline',
    '',
    INNER,
    '--fwd--',
    '',
  ]),
}

async function setup() {
  const raws = Object.values(FIXTURES)
  const server = await startImapServer({ INBOX: raws.map((raw) => ({ raw })) })
  const client = await server.connect()
  const db = openDatabase(':memory:')
  ensureAccount(db, server.account.id, server.account.email)
  cleanups.push(() => server.close(), () => client.logout().catch(() => client.close()), () => db.close())
  await syncAccount(client, db, server.account.id)
  return { client, db, accountId: server.account.id }
}

/** Every FETCH the client sends, by its query. */
function recordFetches(client: ImapFlow) {
  const queries: Array<Record<string, unknown>> = []
  const fetch = client.fetch.bind(client)
  client.fetch = ((range: string, query: Record<string, unknown>, options: Record<string, unknown>) => {
    queries.push({ range, ...query })
    return fetch(range, query, options)
  }) as unknown as ImapFlow['fetch']
  return queries
}

const idOf = (db: MailDatabase, subject: string) => (db.query('SELECT id FROM messages WHERE subject = ?').get(subject) as { id: number }).id

function stored(db: MailDatabase, id: number) {
  const body = db.query('SELECT b.text, b.html, m.snippet FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.id = ?').get(id) as { text: string | null; html: string | null; snippet: string }
  const attachments = db.query('SELECT filename, content_type, content_id, size, size_estimated, part FROM attachments WHERE message_id = ? ORDER BY id').all(id) as Array<{
    filename: string | null
    content_type: string | null
    content_id: string | null
    size: number | null
    size_estimated: number
    part: string | null
  }>
  return { ...body, attachments }
}

test('text-only bodies store what the whole source would, without downloading attachments', async () => {
  const { client, db, accountId } = await setup()
  const queries = recordFetches(client)
  client.stats(true)
  expect(await fetchBodies(client, db, accountId, 100, undefined, 0)).toBe(Object.keys(FIXTURES).length)
  const received = client.stats().received

  // The 200 KB PDF and the 60 KB unused GIF stayed on the server.
  expect(received).toBeLessThan(40_000)
  expect(queries[0]).toMatchObject({ bodyStructure: true })
  // Only the inline forward needed its whole source.
  const whole = queries.filter((q) => q.source)
  expect(whole).toHaveLength(1)
  const inlineForwardUid = Object.keys(FIXTURES).indexOf('inlineForward') + 1
  expect(whole[0]!.range).toBe(String(inlineForwardUid))

  for (const [name, raw] of Object.entries(FIXTURES)) {
    const expected = storedBody(await simpleParser(raw))
    const actual = stored(db, idOf(db, (await simpleParser(raw)).subject!))
    expect({ name, text: actual.text, html: actual.html, snippet: actual.snippet }).toEqual({ name, text: expected.text, html: expected.html, snippet: expected.snippet })
    expect({ name, attachments: actual.attachments.map((a) => [a.filename, a.content_type, a.content_id]) }).toEqual({
      name,
      attachments: expected.attachments.map((a) => [a.filename ?? null, a.contentType ?? null, a.contentId ?? null]),
    })
  }

  // Spot checks on what the comparison above covers.
  const latin1 = stored(db, idOf(db, 'Fixture 6'))
  expect(latin1.text).toBe('Café crème, naïve façade.')
  const inline = stored(db, idOf(db, 'Fixture 7'))
  expect(inline.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`)
  expect(inline.html).toContain('cid:missing@example.com')
  expect(inline.attachments).toEqual([])

  const attached = stored(db, idOf(db, 'Fixture 5'))
  expect(attached.attachments.map((a) => [a.filename, a.content_type, a.part, a.size_estimated])).toEqual([
    ['report.pdf', 'application/pdf', '2', 1],
    ['photo.jpg', 'image/jpeg', '3', 1],
    ['notes.txt', 'text/plain', '4', 1],
  ])
  // Estimated from the base64 size: close enough to show.
  expect(Math.abs(attached.attachments[0]!.size! - PDF.length) / PDF.length).toBeLessThan(0.01)
  expect(attached.attachments[2]!.size).toBe(Buffer.byteLength('Attached notes, not body text.'))

  // The whole-source path still stores exact sizes.
  const forwardedInline = stored(db, idOf(db, 'Fixture 9'))
  expect(forwardedInline.attachments.map((a) => [a.filename, a.size, a.size_estimated])).toEqual([['inner.csv', 3, 0]])
})

test('an attachment downloads by its index after a text-only backfill, and its exact size replaces the estimate', async () => {
  const { client, db, accountId } = await setup()
  await fetchBodies(client, db, accountId, 100, undefined, 0)
  const root = mkdtempSync(`${tmpdir()}/jefi-text-bodies-`)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const messageIdOf = (subject: string) => {
    const row = db.query('SELECT id, thread_id FROM messages WHERE subject = ?').get(subject) as { id: number; thread_id: string | null }
    return `${uiThreadId(accountId, row.thread_id, row.id)}-${row.id}`
  }

  const report = resolveAttachmentTarget(db, root, accountId, messageIdOf('Fixture 5'), 0)!
  // An estimate can't vouch for the bytes, so it isn't checked against them.
  expect(report.size).toBeNull()
  expect(readFileSync(await downloadAttachment(client, report))).toEqual(PDF)
  settleAttachmentSize(db, report, PDF.length)
  expect(resolveAttachmentTarget(db, root, accountId, messageIdOf('Fixture 5'), 0)!.size).toBe(PDF.length)

  const photo = resolveAttachmentTarget(db, root, accountId, messageIdOf('Fixture 5'), 1)!
  expect(photo.name).toBe('photo.jpg')
  expect(readFileSync(await downloadAttachment(client, photo))).toEqual(PHOTO)

  // Now exact, the size is checked again: a mismatch is refused.
  const settled = resolveAttachmentTarget(db, root, accountId, messageIdOf('Fixture 5'), 0)!
  await expect(downloadAttachment(client, { ...settled, size: PDF.length + 1 })).rejects.toThrow('changed on the server')

  const forwarded = resolveAttachmentTarget(db, root, accountId, messageIdOf('Fixture 8'), 0)!
  expect(forwarded.name).toBe('original.eml')
  expect(readFileSync(await downloadAttachment(client, forwarded), 'utf8')).toBe(INNER)
})

// lume-d68: small messages come whole, a batch in one FETCH; big or unsized ones stay text-only.

const BIG = message(20, 'multipart/mixed; boundary="big"', [
  '--big',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'A big attachment follows.',
  '--big',
  'Content-Type: application/octet-stream; name="big.bin"',
  'Content-Disposition: attachment; filename="big.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  base64(noise(400_000, 5)),
  '--big--',
  '',
])

async function serve(raws: string[]) {
  const server = await startImapServer({ INBOX: raws.map((raw) => ({ raw })) })
  const client = await server.connect()
  const db = openDatabase(':memory:')
  ensureAccount(db, server.account.id, server.account.email)
  cleanups.push(() => server.close(), () => client.logout().catch(() => client.close()), () => db.close())
  await syncAccount(client, db, server.account.id)
  return { client, db, accountId: server.account.id }
}

test('small messages are fetched whole in one FETCH, a big one text-only, and all store what the source would', async () => {
  const small = [FIXTURES.plain, FIXTURES.alternative, FIXTURES.latin1, FIXTURES.inlineImage, FIXTURES.forwarded]
  const { client, db, accountId } = await serve([...small, BIG])

  const queries = recordFetches(client)
  client.stats(true)
  expect(await fetchBodies(client, db, accountId, 100)).toBe(small.length + 1)
  // The 400 KB attachment stayed on the server.
  expect(client.stats().received).toBeLessThan(150_000)

  const whole = queries.filter((q) => q.source)
  expect(whole).toHaveLength(1)
  expect(String(whole[0]!.range).split(',').map(Number).sort()).toEqual([1, 2, 3, 4, 5])
  expect(queries.filter((q) => q.bodyStructure).map((q) => q.range)).toEqual(['6'])

  for (const raw of small) {
    const expected = storedBody(await simpleParser(raw))
    const actual = stored(db, idOf(db, (await simpleParser(raw)).subject!))
    expect({ text: actual.text, html: actual.html, snippet: actual.snippet }).toEqual({ text: expected.text, html: expected.html, snippet: expected.snippet })
    // Exact sizes, as the whole source gives them.
    expect(actual.attachments.map((a) => [a.filename, a.content_type, a.content_id, a.size, a.size_estimated])).toEqual(
      expected.attachments.map((a) => [a.filename ?? null, a.contentType ?? null, a.contentId ?? null, a.size ?? null, 0]),
    )
  }
  const big = stored(db, idOf(db, 'Fixture 20'))
  expect(big.text).toBe(storedBody(await simpleParser(BIG)).text)
  expect(big.attachments.map((a) => [a.filename, a.size_estimated])).toEqual([['big.bin', 1]])
})

test('a message of unknown size takes the text-only path', async () => {
  const { client, db, accountId } = await serve([FIXTURES.plain, FIXTURES.alternative])
  db.run('UPDATE messages SET size = NULL WHERE subject = ?', ['Message 1'])

  const queries = recordFetches(client)
  expect(await fetchBodies(client, db, accountId, 100)).toBe(2)
  expect(queries.filter((q) => q.source).map((q) => q.range)).toEqual(['2'])
  expect(queries.filter((q) => q.bodyStructure).map((q) => q.range)).toEqual(['1'])
  expect(stored(db, idOf(db, 'Message 1')).text).toBe(storedBody(await simpleParser(FIXTURES.plain)).text)
})

test('whole-source FETCHes are split to stay under their byte budget', async () => {
  // About 200 KB each: all small, but 30 of them are more than one FETCH may ask for.
  const { client, db, accountId } = await serve(Array.from({ length: 30 }, (_, i) => rawMessage({ n: 100 + i, text: noise(150_000, i).toString('base64') })))

  const queries = recordFetches(client)
  expect(await fetchBodies(client, db, accountId, 100)).toBe(30)
  expect(queries.filter((q) => q.source)).toHaveLength(2)
  expect(queries.filter((q) => q.bodyStructure)).toEqual([])
})

// lume-3d4: Exchange sends each BODY[n] with the CRLF of the boundary line after it, two bytes over
// BODYSTRUCTURE's size; that CRLF isn't the part's and must not reach the stored body.

/** Makes the server answer like Exchange: every numbered part body (not its MIME header) gains a trailing CRLF. */
function exchangeStyle(client: ImapFlow) {
  const fetch = client.fetch.bind(client)
  client.fetch = (async function* (range: string, query: Record<string, unknown>, options: Record<string, unknown>) {
    for await (const message of fetch(range, query as never, options as never)) {
      for (const [section, value] of message.bodyParts ?? []) {
        if (value && /^[\d.]+$/.test(section)) message.bodyParts!.set(section, Buffer.concat([value, Buffer.from('\r\n')]))
      }
      yield message
    }
  }) as unknown as ImapFlow['fetch']
}

// Parts whose own bytes end in CRLF: the text part's final blank line is its content, not the boundary's.
const TRAILING = message(30, 'multipart/alternative; boundary="alt"', [
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Ends with blank lines.',
  '',
  '',
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Also trailing</p>',
  '',
  '--alt--',
  '',
])

for (const mode of ['gmail-like', 'exchange-style'] as const) {
  test(`text-only bodies match the whole source when the server is ${mode}`, async () => {
    const raws = [...Object.values(FIXTURES), TRAILING]
    const { client, db, accountId } = await serve(raws)
    if (mode === 'exchange-style') exchangeStyle(client)
    expect(await fetchBodies(client, db, accountId, 100, undefined, 0)).toBe(raws.length)
    for (const raw of raws) {
      const parsed = await simpleParser(raw)
      const expected = storedBody(parsed)
      const actual = stored(db, idOf(db, parsed.subject!))
      expect({ subject: parsed.subject, text: actual.text, html: actual.html, snippet: actual.snippet }).toEqual({ subject: parsed.subject, text: expected.text, html: expected.html, snippet: expected.snippet })
    }
  })
}

test('bodies that arrived before a FETCH failed are still stored, and the failure still surfaces', async () => {
  const db = openDatabase(':memory:')
  ensureAccount(db, 'acct', 'me@example.com')
  const [box] = saveMailboxes(db, 'acct', [{ path: 'INBOX', specialUse: '\\Inbox' }])
  storeBatch(db, 'acct', { id: box!.id, uidvalidity: 1 }, [1, 2, 3].map((uid) => ({ uid, messageId: `<f${uid}@example.com>`, subject: `Fixture ${uid}`, date: uid, size: 100, to: [], cc: [], bcc: [], replyTo: [], references: [], flags: [] })), { lastUid: 3 })
  const ids = (db.query('SELECT id FROM messages ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
  const client = {
    getMailboxLock: async () => ({ release: () => {} }),
    async *fetch() {
      yield { uid: 1, source: Buffer.from(message(1, 'text/plain; charset=utf-8', ['First body'])) }
      yield { uid: 2, source: Buffer.from(message(2, 'text/plain; charset=utf-8', ['Second body'])) }
      throw new Error('connection lost')
    },
  } as unknown as ImapFlow
  const pending = ids.map((id, i) => ({ id, path: 'INBOX', uid: i + 1, size: 100 }))
  await expect(fetchBodiesOf(client, db, pending)).rejects.toThrow('connection lost')
  expect((db.query('SELECT message_id, text FROM bodies ORDER BY message_id').all() as Array<{ message_id: number; text: string }>).map((r) => [r.message_id, r.text.trim()])).toEqual([
    [ids[0], 'First body'],
    [ids[1], 'Second body'],
  ])
})

