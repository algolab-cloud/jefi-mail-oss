/**
 * Check one account against its real servers and print what works.
 *
 *   bun scripts/diagnose.ts you@example.com
 *   bun scripts/diagnose.ts you@example.com --imap imap.fastmail.com:993 --smtp smtp.fastmail.com:465
 *
 * The password is read from the terminal (hidden) or JEFI_DIAGNOSE_PASSWORD, used only for these
 * connections, and never printed or written anywhere.
 */
import type { Account } from '../src/accounts'
import { guessServers, providerForEmail } from '../src/accounts'
import { checkAccount, createImapClient } from '../src/engine/connection'

const args = process.argv.slice(2)
const email = args.find((a) => a.includes('@'))
if (!email) {
  console.error('usage: bun scripts/diagnose.ts you@example.com [--imap host:port] [--smtp host:port]')
  process.exit(2)
}
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const hostPort = (value: string | undefined) => {
  if (!value) return undefined
  const [host, port] = value.split(':')
  return { host: host!, port: Number(port ?? 0) }
}

const provider = providerForEmail(email)
const base = provider?.servers ?? guessServers(email)
const imap = hostPort(flag('--imap'))
const smtp = hostPort(flag('--smtp'))
const account: Account = {
  id: 'diagnose',
  name: 'Diagnose',
  email,
  provider: provider?.id ?? 'imap',
  face: { letter: 'D' },
  servers: {
    ...base,
    ...(imap ? { imapHost: imap.host, imapPort: imap.port } : {}),
    ...(smtp ? { smtpHost: smtp.host, smtpPort: smtp.port, smtpSecurity: smtp.port === 465 ? ('ssl' as const) : ('starttls' as const) } : {}),
  },
}

const secret =
  process.env.JEFI_DIAGNOSE_PASSWORD ??
  (await (async () => {
    process.stdout.write(`Password or app password for ${email} (hidden): `)
    // Bun reads the line without echoing when the terminal allows it.
    Bun.spawnSync(['stty', '-echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
    try {
      for await (const line of console) return line
    } finally {
      Bun.spawnSync(['stty', 'echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
      process.stdout.write('\n')
    }
    return ''
  })())

if (!secret) {
  console.error('no password given')
  process.exit(2)
}

const { imapHost, imapPort, imapSecurity, smtpHost, smtpPort, smtpSecurity } = account.servers
console.log(`\nIMAP  ${imapHost}:${imapPort} (${imapSecurity})\nSMTP  ${smtpHost}:${smtpPort} (${smtpSecurity})\n`)

const report = await checkAccount(account, secret, { timeoutMs: 20_000 })
for (const [name, result] of Object.entries(report)) {
  console.log(result.ok ? `OK    ${name}` : `FAIL  ${name}: [${result.kind}] ${result.message}`)
}

if (report.imap.ok) {
  const client = createImapClient(account, secret, { timeoutMs: 20_000 })
  client.on('error', () => {})
  await client.connect()
  try {
    console.log('\nServer capabilities:', [...client.capabilities.keys()].join(' '))
    const boxes = await client.list()
    console.log(`\nFolders (${boxes.length}):`)
    for (const box of boxes) console.log(`  ${box.path}${box.specialUse ? `  ${box.specialUse}` : ''}${box.flags?.has('\\Noselect') ? '  (not selectable)' : ''}`)
    const inbox = boxes.find((b) => b.specialUse === '\\Inbox') ?? boxes.find((b) => b.path.toUpperCase() === 'INBOX')
    if (inbox) {
      const status = await client.status(inbox.path, { messages: true, uidNext: true, uidValidity: true, unseen: true })
      console.log(`\nINBOX: ${status.messages ?? '?'} messages, ${status.unseen ?? '?'} unseen, uidnext ${status.uidNext}, uidvalidity ${status.uidValidity}`)
    }
  } finally {
    await client.logout().catch(() => client.close())
  }
}
console.log('')
process.exit(report.imap.ok && report.smtp.ok ? 0 : 1)
