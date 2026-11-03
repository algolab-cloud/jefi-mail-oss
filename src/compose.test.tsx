import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import type { DraftFields } from './data'
import { DEFAULT_SETTINGS, SettingsContext, palette } from './theme'
import { shallowEqual } from './store-equality'
import * as storePure from './store-pure'
import { sidebarCounts } from './sidebar-counts'

// The composer reads the mail store and AI settings; neither matters to these flows. The real
// modules aren't imported: use-ai reads the Keychain as it loads. Mocks are process-wide in bun, so
// every export other test files' imports need is stubbed too.
const account = { id: 'a', name: 'Mara Lin', email: 'me@example.com', face: { letter: 'ML' } }
const work = { id: 'w', name: 'Mara Lin', email: 'mara@work.example', face: { letter: 'ML' }, label: 'Work' }
const fakeStore = {
  account,
  accounts: [account] as Array<typeof account>,
  notify: () => {},
  // Synced thread ids start with their account's id.
  accountOf: (threadId: string) => fakeStore.accounts.find((a) => threadId.startsWith(`${a.id}:`)) ?? account,
}
// Bun patches the mocked module's exports in place, re-exports included, so the pure helpers must be
// the real ones: a stand-in shallowEqual here once broke store-equality's own tests on CI.
// Every export the real store has (see the test below): a module loaded after this file that asks
// for one it lacks fails to load at all, which on CI's file order broke unrelated tests.
const storeStandIn = {
  ...storePure,
  shallowEqual,
  useMail: () => fakeStore,
  useMailActions: () => fakeStore,
  useMailSnapshot: () => () => fakeStore,
  useMailSelector: (select: (store: unknown) => unknown) => select(fakeStore),
  useMailCounts: () => ({ inboxUnread: {}, sidebar: sidebarCounts([]) }),
  MailProvider: ({ children }: { children: unknown }) => children,
}
mock.module('./store', () => storeStandIn)

test('the stand-in store has every export the real one has', () => {
  const source = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')
  const declared = [...source.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]!)
  const listed = [...source.matchAll(/^export \{([^}]*)\}/gm)].flatMap((m) => m[1]!.split(',').map((name) => name.trim()).filter(Boolean))
  expect([...declared, ...listed].filter((name) => !(name in storeStandIn))).toEqual([])
})
mock.module('./use-ai', () => ({
  useAi: () => ({ enabled: false, connection: null, providerName: '' }),
  refreshCodex: async () => ({ ok: false }),
  setAnthropicKey: async () => {},
  setOpenAIKey: async () => {},
}))

const { ComposePane } = await import('./compose')
const { setContacts } = await import('./contacts')
const C = palette('dark', 'red')

let root: TestRoot
let sent: Array<{ mail: DraftFields; sendAt?: number }>
let autosaved: DraftFields[]

// GPUIX's test renderer reads frames back from the GPU, which it can do on macOS and Windows only:
// CI's Linux runners skip these, the Mac release build runs them.
const rendererSupported = process.platform !== 'linux'

beforeEach(() => {
  sent = []
  autosaved = []
  if (rendererSupported) root = createTestRoot({ width: 900, height: 700 })
})
afterEach(() => {
  if (rendererSupported) root.unmount()
})

const render = (initial?: Partial<DraftFields>) => {
  root.render(
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, C, update: () => {} }}>
      <div style={{ width: 900, height: 700, display: 'flex' }}>
        <ComposePane
          initial={initial}
          onSend={(mail, sendAt) => sent.push({ mail, sendAt })}
          onSaveDraft={() => {}}
          onAutosave={(mail) => autosaved.push(mail)}
          onDiscard={() => {}}
          onClose={() => {}}
        />
      </div>
    </SettingsContext.Provider>,
  )
  root.renderer.flush()
}

const node = (testId: string) => {
  const found = root.renderer.findByTestId(testId)
  if (!found) throw new Error(`missing ${testId}`)
  return found
}
const type = (testId: string, keys: string) => {
  root.renderer.nativeSimulateKeystrokes(node(testId).id, keys)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
}
const click = (testId: string) => {
  const bounds = root.renderer.getElementBounds(node(testId).id)!
  root.renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
}
const keys = (text: string) => [...text].map((ch) => (ch === ' ' ? 'space' : ch === ',' ? ',' : ch)).join(' ')

describe.skipIf(!rendererSupported)('ComposePane', () => {
  test('an address typed without Enter or a comma is still sent to', () => {
    render({ subject: 'Hi', body: 'Hello' })
    type('compose-to', keys('kenji@northlight.co'))
    click('compose-send')
    expect(sent.map((s) => s.mail.to)).toEqual([['kenji@northlight.co']])
  })

  test('Enter turns the typed address into a recipient', () => {
    render({ subject: 'Hi', body: 'Hello' })
    type('compose-to', `${keys('kenji@northlight.co')} enter`)
    expect(root.renderer.findByTestId('remove-tag-kenji@northlight.co')).toBeTruthy()
  })

  test('Send goes out once however often it is clicked', () => {
    render({ to: ['kenji@northlight.co'], subject: 'Hi', body: 'Hello' })
    click('compose-send')
    click('compose-send')
    expect(sent).toHaveLength(1)
  })

  test('closing by navigating away saves what the debounce had not', () => {
    render()
    type('compose-body', keys('unsaved words'))
    expect(autosaved).toHaveLength(0)
    root.render(<div />)
    root.renderer.flush()
    expect(autosaved.map((d) => d.body)).toEqual(['unsaved words'])
  })

  test('a sent message is not saved again as it closes', () => {
    render({ to: ['kenji@northlight.co'], subject: 'Hi', body: 'Hello' })
    type('compose-body', keys(' again'))
    click('compose-send')
    root.render(<div />)
    root.renderer.flush()
    expect(sent).toHaveLength(1)
    expect(autosaved).toHaveLength(0)
  })

  test('only mentions you wrote address people; ones in quoted or forwarded text do not', () => {
    setContacts([
      { name: 'Nora Hale', email: 'nora@harbor.io', face: { letter: 'N' } },
      { name: 'Jules Park', email: 'jules@northlight.co', face: { letter: 'J' } },
    ] as never)
    try {
      render({
        to: ['kenji@northlight.co'],
        subject: 'Re: Plans',
        body: 'Looping in @Jules Park.\n\n> On Monday, Kenji wrote:\n> ask @Nora Hale about it\n\n---\n\n**Forwarded message**\nthanks @Nora Hale',
      })
      click('compose-send')
      expect(sent[0]!.mail.to).toEqual(['kenji@northlight.co', 'jules@northlight.co'])
    } finally {
      setContacts([])
    }
  })

  test('↓ then Enter picks the second suggestion', () => {
    setContacts([
      { name: 'Nora Hale', email: 'nora@harbor.io', face: { letter: 'N' } },
      { name: 'Nora Vance', email: 'vance@harbor.io', face: { letter: 'N' } },
    ] as never)
    try {
      render({ subject: 'Hi', body: 'Hello' })
      type('compose-to', `${keys('nora')} down enter`)
      expect(root.renderer.findByTestId('remove-tag-vance@harbor.io')).toBeTruthy()
      expect(root.renderer.findByTestId('remove-tag-nora@harbor.io')).toBeFalsy()
    } finally {
      setContacts([])
    }
  })

  describe('From', () => {
    afterEach(() => {
      fakeStore.accounts = [account]
    })

    test('with one account there is nothing to choose, and it sends from that one', () => {
      render({ to: ['kenji@northlight.co'], subject: 'Hi', body: 'Hello' })
      expect(root.renderer.findByTestId('compose-from')).toBeFalsy()
      click('compose-send')
      expect(sent[0]!.mail.from).toBe('a')
    })

    test('with several accounts it starts on the active one and can send from another', () => {
      fakeStore.accounts = [account, work]
      render({ to: ['kenji@northlight.co'], subject: 'Hi', body: 'Hello' })
      expect(root.renderer.findByTestId('compose-from')).toBeTruthy()
      click('compose-from')
      click('compose-from-w')
      click('compose-send')
      expect(sent[0]!.mail.from).toBe('w')
    })

    test('a reply starts on the account its conversation belongs to', () => {
      fakeStore.accounts = [account, work]
      render({ to: ['kenji@northlight.co'], subject: 'Re: Hi', body: 'Hello', replying: { threadId: 'w:t1' } })
      click('compose-send')
      expect(sent[0]!.mail.from).toBe('w')
    })

    test('a draft reopens with its From, and changing it is saved with the draft', () => {
      fakeStore.accounts = [account, work]
      render({ to: ['kenji@northlight.co'], subject: 'Hi', body: 'Hello', from: 'w' })
      click('compose-from')
      click('compose-from-a')
      root.render(<div />)
      root.renderer.flush()
      expect(autosaved.map((d) => d.from)).toEqual(['a'])
    })

    test('a draft whose account is gone falls back to the active one', () => {
      fakeStore.accounts = [account, work]
      render({ to: ['kenji@northlight.co'], subject: 'Hi', body: 'Hello', from: 'removed' })
      click('compose-send')
      expect(sent[0]!.mail.from).toBe('a')
    })
  })
})

test('mentionAtEnd reads the @mention being typed exactly as the old end-anchored pattern did', async () => {
  const { mentionAtEnd } = await import('./compose')
  const old = (body: string) => {
    const match = body.match(/(?:^|\s)@([a-zA-Z0-9._-]*)$/)
    return match ? (match[1] ?? '') : null
  }
  for (const body of ['', '@', 'hi @', 'hi @le', 'hi\n@lea.o', 'mail@lea', 'hi @lea ', 'a @b @c', 'a @b@c', 'x\t@y_z-1', '@@', ' @', 'hi @lé', 'x @a @'])
    expect(mentionAtEnd(body)).toBe(old(body))
})
