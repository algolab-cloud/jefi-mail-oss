import { createAppEngine } from './compose'
import { createWorkerEngine } from './worker-client'
import type { MailEngine } from './types'

export type * from './types'
export type { CheckResult, ConnectionFailure, ConnectionReport } from './connection'
export { isSignInCancelled, oauthProviderFor, openInBrowser, type OAuthProviderId } from './oauth'
export { VIEW_PAGE } from './threads'
export { gmailLabelId } from './pending-ops'
export { localLabelId } from './local-labels'

/**
 * The mail engine for this run. Defaults to the engine worker; JEFI_ENGINE=inline runs the same
 * engine on the UI thread (handy when debugging the store without a worker).
 */
export function createEngine(): MailEngine {
  const mode = typeof process !== 'undefined' ? process.env.JEFI_ENGINE : undefined
  return mode === 'inline' ? createAppEngine() : createWorkerEngine()
}
