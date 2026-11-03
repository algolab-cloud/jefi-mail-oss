import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import tls from 'node:tls'
import { SMTPServer } from 'smtp-server'

// ---------------------------------------------------------------------------
// In-process mail servers for engine tests: a scripted IMAPS server (enough of RFC 3501 for login,
// LIST, SELECT, FETCH and IDLE) and smtp-server. Certificates are self-signed and generated per run.
// ---------------------------------------------------------------------------

export type Credentials = { user: string; pass: string }

export function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(`${tmpdir()}/jefi-cert-`)
  try {
    const result = Bun.spawnSync([
      'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`,
    ])
    if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`)
    return { key: readFileSync(`${dir}/key.pem`, 'utf8'), cert: readFileSync(`${dir}/cert.pem`, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Listening = { port: number; close: () => Promise<void> }

const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))

const closer = (server: net.Server, sockets: Set<net.Socket>) => () =>
  new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  })

export async function startFakeImap(opts: { cert: { key: string; cert: string }; users: Credentials[] }): Promise<Listening> {
  const sockets = new Set<net.Socket>()
  const caps = 'IMAP4rev1 IDLE UIDPLUS'
  const server = tls.createServer({ key: opts.cert.key, cert: opts.cert.cert }, (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = ''
    const send = (line: string) => sock.write(`${line}\r\n`)
    send(`* OK [CAPABILITY ${caps}] fake imap ready`)
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        // Atoms and quoted strings (LOGIN sends passwords quoted when they contain spaces).
        const [tag, rawCommand = '', ...args] = (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((token) =>
          token.startsWith('"') ? token.slice(1, -1).replace(/\\(.)/g, '$1') : token,
        )
        const command = rawCommand.toUpperCase()
        if (command === 'CAPABILITY') {
          send(`* CAPABILITY ${caps}`)
          send(`${tag} OK done`)
        } else if (command === 'LOGIN') {
          const [user, pass] = args
          if (opts.users.some((u) => u.user === user && u.pass === pass)) send(`${tag} OK [CAPABILITY ${caps}] logged in`)
          else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
        } else if (command === 'LOGOUT') {
          send('* BYE')
          send(`${tag} OK bye`)
          sock.end()
        } else {
          send(`${tag} OK noop`)
        }
      }
    })
  })
  const port = await listen(server)
  return { port, close: closer(server, sockets) }
}

/**
 * `dataEnd`: what happens once a message's body has arrived. 'accept' (the default) replies 250;
 * 'drop' keeps the message but cuts the connection before replying, as when the 250 is lost on the
 * way back; 'reject' replies 554.
 */
export async function startFakeSmtp(opts: { cert: { key: string; cert: string }; users: Credentials[]; dataEnd?: 'accept' | 'drop' | 'reject' }): Promise<Listening & { received: string[]; envelopes: string[][] }> {
  const received: string[] = []
  /** RCPT TO addresses of each message in `received`: the only place Bcc recipients show. */
  const envelopes: string[][] = []
  const sockets = new Set<net.Socket>()
  const server = new SMTPServer({
    secure: true,
    key: opts.cert.key,
    cert: opts.cert.cert,
    logger: false,
    closeTimeout: 50,
    onAuth: (auth, _session, done) =>
      opts.users.some((u) => u.user === auth.username && u.pass === auth.password) ? done(null, { user: auth.username }) : done(new Error('Invalid credentials')),
    onData: (stream, session, done) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'))
        envelopes.push(session.envelope.rcptTo.map((r) => r.address))
        if (opts.dataEnd === 'drop') for (const socket of sockets) socket.destroy()
        else if (opts.dataEnd === 'reject') done(Object.assign(new Error('Message rejected as spam'), { responseCode: 554 }))
        else done()
      })
    },
  })
  server.on('error', () => {}) // aborted TLS handshakes from the untrusted-certificate checks
  server.server.on('connection', (socket: net.Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.server.address() as net.AddressInfo).port)))
  return { port, received, envelopes, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** A TCP server that accepts connections and then never speaks (for timeout checks). */
export async function startSilentServer(): Promise<Listening> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(sock))
  })
  const port = await listen(server)
  return { port, close: closer(server, sockets) }
}

/** A plaintext server that greets immediately, to catch TLS clients pointed at a non-TLS port. */
export async function startPlaintextServer(greeting = '* OK plaintext imap\r\n'): Promise<Listening> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(sock))
    sock.write(greeting)
  })
  const port = await listen(server)
  return { port, close: closer(server, sockets) }
}

/** A port with nothing listening on it. */
export async function freePort(): Promise<number> {
  const server = net.createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
