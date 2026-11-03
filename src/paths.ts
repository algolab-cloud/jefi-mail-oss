/**
 * Where Jefi keeps accounts.json, settings.json and mail.db: ~/.config/jefi, or JEFI_CONFIG_DIR.
 * Test scripts set JEFI_CONFIG_DIR instead of overriding HOME, because the macOS Keychain is found
 * through HOME and Keychain calls hang against a fake one. Null outside Bun/Node.
 */
export function configDir(): string | null {
  if (typeof process === 'undefined' || !process.versions?.node) return null
  if (process.env.JEFI_CONFIG_DIR) return process.env.JEFI_CONFIG_DIR
  // Under `bun test` the real ~/.config/jefi is never the answer: a test that forgot JEFI_CONFIG_DIR
  // (or a worker that started before the test set it) once migrated the real mail.db. Workers share
  // the process, so the pid-scoped folder is the same one on both sides.
  if (process.env.NODE_ENV === 'test') return `${require('node:os').tmpdir()}/jefi-test-${process.pid}`
  const home = process.env.HOME || process.env.USERPROFILE
  return home ? `${home}/.config/jefi` : null
}
