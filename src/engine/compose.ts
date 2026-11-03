import { createImapEngine } from './imap-engine'
import type { MailEngine } from './types'

/** The engine Jefi runs: every account syncs over IMAP. */
export function createAppEngine(): MailEngine {
  return createImapEngine()
}
