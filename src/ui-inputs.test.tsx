import { afterAll, expect, test } from 'bun:test'
import { useState } from 'react'
import { createTestRoot } from '@gpuix/react/testing'
import { DEFAULT_SETTINGS, SettingsContext, palette } from './theme'
import { SecretInput, TextInput } from './ui'

// Enter on a GPUIX <input> arrives as submit, not as a key down: fields that only listened for an
// "enter" key down never saw it, so Enter did nothing in Settings, the account wizard and onboarding.

const C = palette(DEFAULT_SETTINGS.theme, DEFAULT_SETTINGS.accent)
const entered: string[] = []
const keys: string[] = []

function Fields() {
  const [text, setText] = useState('')
  const [secret, setSecret] = useState('')
  return (
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, C, update: () => {} }}>
      <div style={{ width: 400, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <TextInput testId="text" value={text} onChange={setText} onEnter={() => entered.push(`text:${text}`)} onKey={(key) => keys.push(key)} />
        <SecretInput testId="secret" value={secret} onChange={setSecret} onEnter={() => entered.push(`secret:${secret}`)} />
      </div>
    </SettingsContext.Provider>
  )
}

// GPUIX's test renderer reads frames back from the GPU, which it can do on macOS and Windows only:
// CI's Linux runners skip this, the Mac release build runs it.
const rendererSupported = process.platform !== 'linux'
const app = rendererSupported ? createTestRoot({ width: 480, height: 200 }) : (null as unknown as ReturnType<typeof createTestRoot>)
afterAll(() => app?.unmount())

const pump = () => {
  app.renderer.flush()
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
}

const type = (testId: string, keystrokes: string) => {
  const input = app.renderer.findByTestId(testId)
  if (!input) throw new Error(`no ${testId}`)
  app.renderer.focusElement(input.id)
  pump()
  app.renderer.simulateKeystrokes(keystrokes)
  pump()
}

test.skipIf(!rendererSupported)('Enter in a TextInput or SecretInput runs onEnter once, with what was typed', () => {
  app.render(<Fields />)
  pump()
  type('text', 'a b c enter')
  expect(entered).toEqual(['text:abc'])
  expect(keys).not.toContain('enter')
  type('text', 'escape')
  expect(keys).toContain('escape')
  // The field remounts on every edit, so each key goes to the input on screen now.
  for (const key of ['s', 'k', 'enter']) type('secret', key)
  expect(entered).toEqual(['text:abc', 'secret:sk'])
})
