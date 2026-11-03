import { expect, test } from 'bun:test'
import { configDir } from './paths'

// A test must never reach the person's real mail: without JEFI_CONFIG_DIR, `bun test` gets a temp folder.
test('under bun test, the default config folder is a temp folder, never ~/.config/jefi', () => {
  const saved = process.env.JEFI_CONFIG_DIR
  delete process.env.JEFI_CONFIG_DIR
  try {
    const dir = configDir()!
    expect(dir).not.toContain('/.config/jefi')
    expect(dir).toContain(`jefi-test-${process.pid}`)
  } finally {
    if (saved !== undefined) process.env.JEFI_CONFIG_DIR = saved
  }
})
