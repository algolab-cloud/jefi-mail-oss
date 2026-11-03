import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Account } from '../accounts'
import { checkAccount, checkImap, checkSmtp } from './connection'
import { freePort, selfSignedCert, startFakeImap, startFakeSmtp, startPlaintextServer, startSilentServer } from './testing/fake-servers'

const USER = { user: 'ada@example.com', pass: 'correct horse' }
const trustTestCerts = { allowInvalidCerts: true, timeoutMs: 3000 }

let imap: Awaited<ReturnType<typeof startFakeImap>>
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>

const account = (servers: Partial<Account['servers']> = {}): Account => ({
  id: 'acct-test',
  name: 'Ada',
  email: USER.user,
  provider: 'imap',
  face: { letter: 'A' },
  servers: {
    imapHost: '127.0.0.1',
    imapPort: imap.port,
    imapSecurity: 'ssl',
    smtpHost: '127.0.0.1',
    smtpPort: smtp.port,
    smtpSecurity: 'ssl',
    ...servers,
  },
})

beforeAll(async () => {
  const cert = selfSignedCert()
  imap = await startFakeImap({ cert, users: [USER] })
  smtp = await startFakeSmtp({ cert, users: [USER] })
})
afterAll(async () => {
  await imap.close()
  await smtp.close()
})

describe('IMAP connection check', () => {
  test('signs in over TLS to an IP-literal host (Bun servername regression)', async () => {
    expect(await checkImap(account(), USER.pass, trustTestCerts)).toEqual({ ok: true })
  })

  test('signs in by hostname', async () => {
    expect(await checkImap(account({ imapHost: 'localhost' }), USER.pass, trustTestCerts)).toEqual({ ok: true })
  })

  test('wrong password is an auth failure', async () => {
    const result = await checkImap(account(), 'wrong', trustTestCerts)
    expect(result).toMatchObject({ ok: false, kind: 'auth' })
  })

  test('an untrusted certificate is a TLS failure', async () => {
    const result = await checkImap(account({ imapHost: 'localhost' }), USER.pass, { timeoutMs: 3000 })
    expect(result).toMatchObject({ ok: false, kind: 'tls' })
  })

  test('TLS against a plaintext port is a TLS failure', async () => {
    const plain = await startPlaintextServer()
    try {
      const result = await checkImap(account({ imapPort: plain.port }), USER.pass, trustTestCerts)
      expect(result.ok).toBe(false)
      expect(['tls', 'network']).toContain((result as { kind: string }).kind)
    } finally {
      await plain.close()
    }
  })

  test('nothing listening is refused', async () => {
    const result = await checkImap(account({ imapPort: await freePort() }), USER.pass, trustTestCerts)
    expect(result).toMatchObject({ ok: false, kind: 'refused' })
  })

  test('unknown host', async () => {
    const result = await checkImap(account({ imapHost: 'no-such-host.invalid' }), USER.pass, trustTestCerts)
    expect(result).toMatchObject({ ok: false, kind: 'host' })
  })

  test('a server that never greets times out', async () => {
    const silent = await startSilentServer()
    try {
      const started = Date.now()
      const result = await checkImap(account({ imapPort: silent.port, imapSecurity: 'none' }), USER.pass, { timeoutMs: 600 })
      expect(result).toMatchObject({ ok: false, kind: 'timeout' })
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await silent.close()
    }
  })
})

test('an IMAP server that greets and then never answers times out instead of hanging for minutes', async () => {
  const stalled = await startPlaintextServer()
  try {
    const started = Date.now()
    const result = await checkImap(account({ imapPort: stalled.port, imapSecurity: 'none' }), USER.pass, { timeoutMs: 400 })
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3000)
  } finally {
    await stalled.close()
  }
})

test('plaintext IMAP against an SSL/TLS port points at the security setting', async () => {
  const result = await checkImap(account({ imapSecurity: 'none' }), USER.pass, { timeoutMs: 400 })
  expect(result).toMatchObject({ ok: false, kind: 'timeout' })
  expect(!result.ok && result.message).toContain('check the port and security setting')
})

describe('SMTP connection check', () => {
  test('signs in over TLS to an IP-literal host', async () => {
    expect(await checkSmtp(account(), USER.pass, trustTestCerts)).toEqual({ ok: true })
  })

  test('wrong password is an auth failure', async () => {
    expect(await checkSmtp(account(), 'wrong', trustTestCerts)).toMatchObject({ ok: false, kind: 'auth' })
  })

  test('nothing listening is refused', async () => {
    expect(await checkSmtp(account({ smtpPort: await freePort() }), USER.pass, trustTestCerts)).toMatchObject({ ok: false, kind: 'refused' })
  })

  test('an untrusted certificate is a TLS failure', async () => {
    expect(await checkSmtp(account(), USER.pass, { timeoutMs: 3000 })).toMatchObject({ ok: false, kind: 'tls' })
  })

  test('a server that never greets times out', async () => {
    const silent = await startSilentServer()
    try {
      const result = await checkSmtp(account({ smtpPort: silent.port, smtpSecurity: 'none' }), USER.pass, { timeoutMs: 600 })
      expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    } finally {
      await silent.close()
    }
  })
})

test('checkAccount reports both protocols independently', async () => {
  const report = await checkAccount(account({ smtpPort: await freePort() }), USER.pass, trustTestCerts)
  expect(report.imap).toEqual({ ok: true })
  expect(report.smtp).toMatchObject({ ok: false, kind: 'refused' })
})
