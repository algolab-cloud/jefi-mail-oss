import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS, loadSettings, palette, THEMES } from './theme'

test('trusted link domains default to an empty list', () => {
  expect(DEFAULT_SETTINGS.trustedLinkDomains).toEqual([])
  expect(DEFAULT_SETTINGS.phishingListEnabled).toBe(false)
})

test('the optional phishing list stays disabled for legacy and malformed settings', () => {
  const previous = process.env.JEFI_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'jefi-settings-'))
  process.env.JEFI_CONFIG_DIR = directory

  try {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ theme: 'light' }))
    expect(loadSettings().phishingListEnabled).toBe(false)
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ phishingListEnabled: 'yes' }))
    expect(loadSettings().phishingListEnabled).toBe(false)
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ phishingListEnabled: true }))
    expect(loadSettings().phishingListEnabled).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
    else process.env.JEFI_CONFIG_DIR = previous
  }
})

test('loading settings keeps only unique normalized trusted hostnames', () => {
  const previous = process.env.JEFI_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'jefi-settings-'))
  process.env.JEFI_CONFIG_DIR = directory

  try {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({
      trustedLinkDomains: [
        ' Example.COM ',
        'example.com',
        'login.example.com',
        'https://Example.NET/',
        'BÜCHER.example.',
        '*.example.com',
        'https://example.net/path',
        'not a hostname',
        '',
        42,
        null,
      ],
    }))

    expect(loadSettings().trustedLinkDomains).toEqual([
      'example.com',
      'login.example.com',
      'example.net',
      'xn--bcher-kva.example',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
    else process.env.JEFI_CONFIG_DIR = previous
  }
})

test('a settings file from a newer version or a hand edit never loads values the app cannot draw', () => {
  const previous = process.env.JEFI_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'jefi-settings-'))
  process.env.JEFI_CONFIG_DIR = directory
  try {
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify({
        theme: 'sepia',
        accent: 'pink',
        undoSendSeconds: 7,
        remoteImages: 'never',
        snippets: 'yes',
        paneWidths: { sidebar: 'wide', list: -3, assistant: 400 },
        aiModels: { anthropic: 42, openai: 'gpt-x' },
        signInUserAgent: { family: 'opera', platform: 'linux', suffix: 7 },
        futureSetting: true,
      }),
    )
    const settings = loadSettings()
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(settings.accent).toBe(DEFAULT_SETTINGS.accent)
    expect(settings.undoSendSeconds).toBe(DEFAULT_SETTINGS.undoSendSeconds)
    expect(settings.remoteImages).toBe('ask')
    expect(settings.snippets).toBe(true)
    expect(settings.paneWidths).toEqual({ sidebar: DEFAULT_SETTINGS.paneWidths.sidebar, list: DEFAULT_SETTINGS.paneWidths.list, assistant: 400 })
    expect(settings.aiModels).toEqual({ anthropic: '', openai: 'gpt-x', codex: '' })
    expect(settings.signInUserAgent).toEqual({ ...DEFAULT_SETTINGS.signInUserAgent, platform: 'linux' })
    // Valid values still load as saved.
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ theme: 'light', accent: 'green', undoSendSeconds: 20, remoteImages: 'always' }))
    expect(loadSettings()).toMatchObject({ theme: 'light', accent: 'green', undoSendSeconds: 20, remoteImages: 'always' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
    else process.env.JEFI_CONFIG_DIR = previous
  }
})

test('the style is Liquid Glass unless Default was chosen, and unknown values fall back', () => {
  const previous = process.env.JEFI_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'jefi-settings-'))
  process.env.JEFI_CONFIG_DIR = directory

  try {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(loadSettings().style).toBe('glass')
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ style: 'frosted' }))
    expect(loadSettings().style).toBe('glass')
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ style: 'default' }))
    expect(loadSettings().style).toBe('default')
  } finally {
    rmSync(directory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
    else process.env.JEFI_CONFIG_DIR = previous
  }
})

test('Liquid Glass makes the panes translucent but keeps text and pill ink opaque', () => {
  for (const theme of ['dark', 'light'] as const) {
    const glass = palette(theme, 'red', 'glass')
    expect(glass.sidebar).toHaveLength(9)
    expect(glass.reading).toHaveLength(9)
    expect(glass.text).toBe(THEMES[theme].text)
    expect(glass.onText).toHaveLength(7)
    expect(palette(theme, 'red')).toEqual(palette(theme, 'red', 'default'))
    expect(palette(theme, 'red').sidebar).toBe(THEMES[theme].sidebar)
  }
})
