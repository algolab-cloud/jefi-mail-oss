import { withDemoFace } from './demo-faces'
import { configDir } from './paths'
import type { FaceSpec, LabelTone } from './data'

// ---------------------------------------------------------------------------
// Accounts + provider presets
// ---------------------------------------------------------------------------

export type ProviderId = 'gmail' | 'outlook' | 'icloud' | 'fastmail' | 'yahoo' | 'zoho' | 'imap'
export type Security = 'ssl' | 'starttls' | 'none'

export type ServerSettings = {
  imapHost: string
  imapPort: number
  imapSecurity: Security
  smtpHost: string
  smtpPort: number
  smtpSecurity: Security
}

export type Account = {
  id: string
  name: string
  email: string
  provider: ProviderId
  face: FaceSpec
  servers: ServerSettings
  /** How it signs in; absent on accounts added before this was recorded (inferred from provider). */
  auth?: 'oauth' | 'password'
  /** A short name the person chose ("Work", "Personal"), shown wherever the app names the account. */
  label?: string
  /** The label's colour; without one, accounts take colours in order. */
  color?: LabelTone
}

export const ACCOUNT_TONES: LabelTone[] = ['blue', 'green', 'amber', 'pink', 'teal', 'purple']

/** How the app names an account: its label if it has one, else its address. */
export const accountName = (account: Pick<Account, 'label' | 'email'>) => account.label?.trim() || account.email

/** The account's colour: chosen, or by its place in the list so each account keeps a distinct one. */
export const accountTone = (account: Account, accounts: Account[]): LabelTone =>
  account.color ?? ACCOUNT_TONES[Math.max(0, accounts.findIndex((a) => a.id === account.id)) % ACCOUNT_TONES.length]!

export type Provider = {
  id: ProviderId
  label: string
  domains: string[]
  /** What the password field is called for this provider. */
  secretLabel: string
  secretHint?: string
  servers?: ServerSettings
  /** Account type and region affect this provider's servers, so confirm them before connecting. */
  reviewServers?: boolean
}

const ssl = (imapHost: string, smtpHost: string, smtpPort = 465, smtpSecurity: Security = 'ssl'): ServerSettings => ({
  imapHost,
  imapPort: 993,
  imapSecurity: 'ssl',
  smtpHost,
  smtpPort,
  smtpSecurity,
})

export const PROVIDERS: Provider[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    secretLabel: 'App password',
    secretHint: 'Create one at myaccount.google.com → Security → App passwords.',
    servers: ssl('imap.gmail.com', 'smtp.gmail.com'),
  },
  {
    id: 'outlook',
    label: 'Outlook',
    domains: ['outlook.com', 'hotmail.com', 'live.com'],
    secretLabel: 'Password',
    servers: ssl('outlook.office365.com', 'smtp.office365.com', 587, 'starttls'),
  },
  {
    id: 'icloud',
    label: 'iCloud',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    secretLabel: 'App-specific password',
    secretHint: 'Generate one at account.apple.com → Sign-In and Security.',
    servers: ssl('imap.mail.me.com', 'smtp.mail.me.com', 587, 'starttls'),
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    secretLabel: 'App password',
    secretHint: 'Create one in Fastmail under Settings → Privacy & Security.',
    servers: ssl('imap.fastmail.com', 'smtp.fastmail.com'),
  },
  {
    id: 'yahoo',
    label: 'Yahoo',
    domains: ['yahoo.com', 'ymail.com'],
    secretLabel: 'App password',
    servers: ssl('imap.mail.yahoo.com', 'smtp.mail.yahoo.com'),
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domains: ['zohomail.com', 'zoho.com', 'zohomail.eu', 'zohomail.in'],
    secretLabel: 'App password',
    secretHint: 'Enable IMAP in Zoho Mail and use an app password when two-factor authentication is on. New free accounts do not include IMAP.',
    servers: ssl('imappro.zoho.com', 'smtppro.zoho.com'),
    reviewServers: true,
  },
  { id: 'imap', label: 'Other IMAP', domains: [], secretLabel: 'Password', reviewServers: true },
]

export const DEFAULT_PORTS: Record<'imap' | 'smtp', Record<Security, number>> = {
  imap: { ssl: 993, starttls: 143, none: 143 },
  smtp: { ssl: 465, starttls: 587, none: 25 },
}

export const providerFor = (id: ProviderId) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]!

export const providerForEmail = (email: string) => {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? ''
  return PROVIDERS.find((p) => p.domains.includes(domain))
}

/** Best-guess servers for a custom domain: imap.<domain> / smtp.<domain>. */
export const guessServers = (email: string): ServerSettings => {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? ''
  return domain ? ssl(`imap.${domain}`, `smtp.${domain}`, 587, 'starttls') : ssl('', '', 587, 'starttls')
}

// ---------------------------------------------------------------------------
// Persistence (non-secret fields only — passwords never touch disk here)
// ---------------------------------------------------------------------------

export type AccountsFile = { accounts: Account[]; activeId: string }
/**
 * `loaded` is true only when accounts.json was there and read cleanly, not for a fallback.
 * `backup` is where an unreadable accounts.json was moved, so the next save can't overwrite it.
 */
export type LoadedAccounts = AccountsFile & { loaded: boolean; backup?: string }

/** An unreadable accounts.json that couldn't be moved aside: saves skip it rather than overwrite it. */
let stuckFile: string | null = null

function accountsFile(): string | null {
  const dir = configDir()
  return dir ? `${dir}/accounts.json` : null
}

/**
 * An entry as the app can use it. A hand-edited one can lack its servers, which Settings and the
 * engine read unguarded: those come back as the provider's (or a guess from the address). Entries
 * are repaired, never dropped: accountsToKeep would take a dropped one's mail with it.
 */
function repaired(a: Account): Account {
  const email = typeof a.email === 'string' ? a.email : ''
  const servers = a.servers && typeof a.servers === 'object' ? a.servers : (providerForEmail(email)?.servers ?? guessServers(email))
  return { ...a, email, servers, face: withDemoFace(email, a.face) }
}

export function loadAccounts(): LoadedAccounts {
  // A fresh install has no accounts: the app opens the wizard instead of a mailbox.
  const fallback: LoadedAccounts = { accounts: [], activeId: '', loaded: false }
  const file = accountsFile()
  if (!file) return fallback
  const fs = require('node:fs')
  stuckFile = null
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    // There but unreadable (permissions, a directory): leave it where it is and save nothing over it.
    stuckFile = file
    return fallback
  }
  try {
    const raw = JSON.parse(text) as Partial<AccountsFile>
    if (Array.isArray(raw.accounts)) {
      const accounts = raw.accounts.map(repaired)
      const activeId = accounts.some((a) => a.id === raw.activeId) ? raw.activeId! : (accounts[0]?.id ?? '')
      return { accounts, activeId, loaded: true }
    }
  } catch {}
  // Present but not a list we wrote: move it aside before the app saves an empty list over it,
  // so the accounts can still be recovered by hand. Renaming here, before the store exists, means
  // no save can get in first.
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    fs.renameSync(file, backup)
    return { ...fallback, backup }
  } catch {
    stuckFile = file
    return fallback
  }
}

/**
 * The account ids the engine may keep when it drops mail stored for accounts no longer listed, or
 * null when it must not drop anything. Deleting mail is only safe against a list known to be
 * complete: accounts.json read cleanly, with at least one account, each with an id. A missing or
 * unreadable file, or an empty list (which is also what gets saved after a failed load), purges nothing.
 */
export function accountsToKeep(file: LoadedAccounts): string[] | null {
  if (!file.loaded || !file.accounts.length) return null
  const ids = file.accounts.map((a) => (a as Partial<Account>)?.id)
  return ids.every((id): id is string => typeof id === 'string' && id.length > 0) ? ids : null
}

export function saveAccounts(data: AccountsFile) {
  const file = accountsFile()
  if (!file || file === stuckFile) return
  try {
    const fs = require('node:fs')
    fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true, mode: 0o700 })
    // Write beside it and rename over, so a crash mid-write leaves the old file rather than half a new one.
    const temp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temp, file)
    } catch {
      fs.rmSync(temp, { force: true })
    }
  } catch {}
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '')
    // Emoji and symbols are skipped: indexing a string could split an emoji in half.
    .filter(Boolean)
    .slice(0, 2)
    .join('') || '?'
