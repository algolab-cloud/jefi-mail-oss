// @ts-expect-error hoodiecrow-imap ships no types
import hoodiecrow from 'hoodiecrow-imap'
import type { Account } from '../../accounts'
import { createImapClient } from '../connection'

// ---------------------------------------------------------------------------
// A scriptable in-memory IMAP server (hoodiecrow) for sync tests: real protocol, plain TCP.
// Messages can be appended, folders removed, and UIDVALIDITY bumped while a test runs.
// ---------------------------------------------------------------------------

export type TestMessage = { raw: string; flags?: string[]; internaldate?: string; 'X-GM-MSGID'?: string; 'X-GM-LABELS'?: string[] }
type Folder = { 'special-use'?: string; messages: TestMessage[]; uidvalidity?: number }

export const USER = { user: 'me@example.com', pass: 'secret' }

export function rawMessage(opts: {
  n: number
  fromName?: string
  fromEmail?: string
  subject?: string
  messageId?: string
  inReplyTo?: string
  references?: string[]
  date?: Date
  text?: string
  html?: string
  attachment?: { filename: string; content: string }
  attachments?: Array<{ filename: string; content: string }>
  /** Extra header lines, e.g. List-Unsubscribe. */
  extraHeaders?: string[]
}) {
  const date = opts.date ?? new Date(Date.UTC(2026, 0, 1, 9, 0, opts.n))
  const headers = [
    `From: ${opts.fromName ?? 'Ada Lovelace'} <${opts.fromEmail ?? 'ada@example.com'}>`,
    'To: Me <me@example.com>',
    `Subject: ${opts.subject ?? `Message ${opts.n}`}`,
    `Message-ID: ${opts.messageId ?? `<m${opts.n}@example.com>`}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references?.length ? [`References: ${opts.references.join(' ')}`] : []),
    ...(opts.extraHeaders ?? []),
    'MIME-Version: 1.0',
  ]
  const text = opts.text ?? `Body of message ${opts.n}`
  const files = opts.attachments ?? (opts.attachment ? [opts.attachment] : [])
  if (!opts.html && files.length === 0) return [...headers, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n')
  const alternative = (boundary: string) =>
    opts.html
      ? [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', opts.html, `--${boundary}--`, '']
      : null
  if (files.length === 0) return [...headers, `Content-Type: multipart/alternative; boundary="alt${opts.n}"`, '', ...alternative(`alt${opts.n}`)!].join('\r\n')

  const boundary = `mix${opts.n}`
  const body = opts.html
    ? [`--${boundary}`, `Content-Type: multipart/alternative; boundary="alt${opts.n}"`, '', ...alternative(`alt${opts.n}`)!]
    : [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text]
  const attachments = files.flatMap((attachment) => [
    `--${boundary}`,
    `Content-Type: text/plain; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    attachment.content,
  ])
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...body, ...attachments, `--${boundary}--`, ''].join('\r\n')
}

// hoodiecrow keeps a message as a binary string, one char per byte, and serves each char's low byte:
// a raw message written as ordinary text (a '’' in it) goes over the wire as UTF-8 only once encoded.
/** A client's first line: a tag, then a command (`1 CAPABILITY`). An HTTP or TLS probe isn't one. */
const IMAP_COMMAND = /^[A-Za-z0-9.]+ [A-Z]+/

const asBytes = (message: TestMessage): TestMessage => ({ ...message, raw: Buffer.from(message.raw, 'utf8').toString('latin1') })

export async function startImapServer(
  folders: { INBOX: TestMessage[] } & Record<string, TestMessage[] | Folder>,
  options: {
    gmail?: boolean
    xoauth2Token?: string
    /** The login it accepts; USER by default. */
    user?: { user: string; pass: string }
    /** Extensions to leave out, to test a server without them (e.g. UIDPLUS). */
    without?: string[]
  } = {},
) {
  const { INBOX, ...rest } = folders
  const subfolders: Record<string, Folder> = {}
  for (const [path, value] of Object.entries(rest)) subfolders[path] = Array.isArray(value) ? { messages: value.map(asBytes) } : { ...value, messages: value.messages.map(asBytes) }
  const server = hoodiecrow({
    plugins: [
      'IDLE', 'UNSELECT', 'ENABLE', 'CONDSTORE', 'SPECIAL-USE', 'UIDPLUS', 'LITERALPLUS', 'NAMESPACE', 'MOVE',
      ...(options.gmail ? ['X-GM-EXT-1'] : []),
      ...(options.xoauth2Token ? ['SASL-IR', 'XOAUTH2'] : []),
    ].filter((plugin) => !options.without?.includes(plugin)),
    storage: { INBOX: { messages: INBOX.map(asBytes) }, '': { separator: '/', folders: subfolders } },
    users: { [(options.user ?? USER).user]: { password: (options.user ?? USER).pass, ...(options.xoauth2Token ? { xoauth2: { accessToken: options.xoauth2Token } } : {}) } },
  })
  // hoodiecrow's X-GM-EXT-1 plugin installs its FETCH/STORE handlers but never advertises the capability.
  if (options.gmail) server.registerCapability('X-GM-EXT-1')
  const sockets = new Set<import('node:net').Socket>()
  /** The sockets that are IMAP clients, out of everything that connected. */
  const clients = new Set<import('node:net').Socket>()
  // A running total, not clients.size: a test wants to know how many connections were ever opened
  // (does a push reuse the watcher's?), and a closed one dropping out of the live set would hide that.
  let totalConnections = 0
  server.server.on('connection', (socket: import('node:net').Socket) => {
    // Counted once it speaks IMAP (a tagged command). Some developer tools probe every new local
    // port with HTTP and TLS a moment after it opens; those must not look like extra clients.
    sockets.add(socket)
    socket.once('data', (chunk: Buffer) => {
      if (!IMAP_COMMAND.test(chunk.toString('latin1'))) return
      totalConnections++
      clients.add(socket)
    })
    socket.on('close', () => {
      sockets.delete(socket)
      clients.delete(socket)
    })
  })
  // Port 0: the kernel hands over a port that is ours from the start. Picking a free one first and
  // listening on it afterwards loses a race whenever anything else on the machine opens a socket
  // in between (another test run, the app itself), which showed up as a rare EADDRINUSE.
  // On 127.0.0.1, not the wildcard: macOS lets a wildcard listener share a port number with one bound
  // to 127.0.0.1 (the fake SMTP servers are), and a client dialling 127.0.0.1 then reaches that one
  // instead. A TLS server hangs up on plain IMAP: a rare "Unexpected close" in whichever test lost.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.server.address() as import('node:net').AddressInfo).port

  const account: Account = {
    id: 'acct-sync',
    name: 'Me',
    email: USER.user,
    provider: 'imap',
    face: { letter: 'M' },
    servers: { imapHost: '127.0.0.1', imapPort: port, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' },
  }

  return {
    port,
    account,
    /** How many TCP connections this server has ever accepted, for tests that care whether push reused one. */
    connectionCount: () => totalConnections,
    /** Connections open right now, for tests that care how many run at once. */
    openConnections: () => clients.size,
    connect: async () => {
      const client = createImapClient(account, USER.pass, { timeoutMs: 5000 })
      client.on('error', () => {})
      await client.connect()
      return client
    },
    append: (path: string, message: TestMessage) => server.appendMessage(path, message.flags ?? [], message.internaldate ?? new Date().toUTCString(), asBytes(message).raw),
    /** Simulate a server rebuilding a folder: new UIDVALIDITY and renumbered UIDs. */
    renumber: (path: string, uidvalidity: number) => {
      const mailbox = server.getMailbox(path)
      mailbox.uidvalidity = uidvalidity
      let uid = 1000
      for (const message of mailbox.messages) message.uid = uid++
      mailbox.uidnext = uid
    },
    /** Drop a message without telling anyone, so a client that already listed it fetches nothing. */
    vanish: (path: string, uid: number) => {
      const mailbox = server.getMailbox(path)
      mailbox.messages = mailbox.messages.filter((m: { uid: number }) => m.uid !== uid)
    },
    removeFolder: (path: string) => {
      delete server.folderCache[path]
      const root = server.getMailbox('INBOX') && server.referenceNamespace !== undefined ? server.storage[''] : null
      if (root?.folders) delete root.folders[path]
    },
    /** Cut every open connection, as a network drop would; the server keeps listening. */
    dropConnections: () => {
      for (const socket of sockets) socket.destroy()
    },
    /** Stop accepting connections and cut existing ones (server unreachable). */
    pause: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.server.close(() => resolve())
      }),
    resume: () => new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        if (!server.server.listening) return resolve()
        server.close(() => resolve())
      }),
  }
}
