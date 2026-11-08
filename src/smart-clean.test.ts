import { expect, test } from 'bun:test'
import type { SenderProfile, ThreadPeek } from './engine/scrub'
import { BATCH, keepersOf, knownVerdict, parsePicks, parseVerdicts, pickWorthKeeping, sendersForModel, smartScan, sortSenders, threadsForModel } from './smart-clean'

const sender = (email: string, extra: Partial<SenderProfile> = {}): SenderProfile => ({
  key: `sender:${email}`,
  selector: { sender: email },
  label: email.split('@')[0]!,
  detail: email,
  messages: 3,
  unread: 2,
  bytes: 1000,
  latest: 0,
  canUnsubscribe: false,
  wrote: 0,
  flagged: 0,
  answered: 0,
  bulk: false,
  subjects: [],
  ...extra,
})

test('what the mailbox knows decides first: written to, answered, flagged or kept is important', () => {
  const none = new Set<string>()
  expect(knownVerdict(sender('a@x.example', { wrote: 2 }), none)).toEqual({ verdict: 'important', reason: 'You wrote to them 2 times' })
  expect(knownVerdict(sender('a@x.example', { answered: 1 }), none)?.verdict).toBe('important')
  expect(knownVerdict(sender('a@x.example', { flagged: 1 }), none)?.verdict).toBe('important')
  expect(knownVerdict(sender('Shop@X.example'), new Set(['shop@x.example']))?.reason).toBe('You chose to keep them')
  expect(knownVerdict(sender('a@x.example'), none)).toBeNull()
})

test('the block for the model numbers senders and keeps subjects on one line', () => {
  const block = sendersForModel([
    sender('news@shop.example', { label: 'Shop', canUnsubscribe: true, subjects: ['50% off\ntoday', 'Say "hi"'] }),
    sender('bot@x.example', { unread: 0, bulk: true, messages: 1 }),
  ])
  expect(block).toBe(
    [
      `1. Shop <news@shop.example> | 3 messages, 2 unread, has an unsubscribe link | recent subjects: "50% off today"; "Say 'hi'"`,
      '2. bot <bot@x.example> | 1 message, all read, bulk-style address | recent subjects: (none)',
    ].join('\n'),
  )
})

test('verdicts are read defensively: fenced JSON, string ids, unknown verdicts and out-of-range ids', () => {
  const text = 'Sure:\n```json\n[{"id":1,"verdict":"Junk","reason":"Promotions"},{"id":"2","verdict":"important"},{"id":3,"verdict":"delete"},{"id":9,"verdict":"junk"},{"id":1,"verdict":"important"}]\n```'
  const verdicts = parseVerdicts(text, 3)
  expect([...verdicts.entries()]).toEqual([
    [0, { verdict: 'junk', reason: 'Promotions' }],
    [1, { verdict: 'important', reason: '' }],
  ])
  expect(parseVerdicts('no idea', 3).size).toBe(0)
})

test('sorting asks only about unknown senders, in batches, and anything unanswered is unsure', async () => {
  const senders = [sender('friend@x.example', { wrote: 1 }), ...Array.from({ length: BATCH + 2 }, (_, i) => sender(`s${i}@bulk.example`))]
  const asked: number[] = []
  const progress: Array<[number, number]> = []
  const groups = await sortSenders(
    senders,
    new Set(),
    async (block) => {
      const lines = block.split('\n').length
      asked.push(lines)
      // Calls the first sender of each batch junk and says nothing about the rest.
      return JSON.stringify([{ id: 1, verdict: 'junk', reason: 'Ads' }])
    },
    (done, total) => progress.push([done, total]),
  )
  expect(asked.sort((a, b) => b - a)).toEqual([BATCH, 2])
  expect(progress[0]).toEqual([0, BATCH + 2])
  expect(progress.at(-1)).toEqual([BATCH + 2, BATCH + 2])
  expect(groups.map((g) => g.detail)).toEqual(senders.map((s) => s.detail))
  expect(groups[0]).toMatchObject({ verdict: 'important', reason: 'You wrote to them' })
  expect(groups.filter((g) => g.verdict === 'junk').map((g) => g.detail)).toEqual(['s0@bulk.example', `s${BATCH}@bulk.example`])
  expect(groups.filter((g) => g.verdict === 'unsure')).toHaveLength(BATCH)
})

test('a stopped sort stops asking', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(sortSenders([sender('a@x.example')], new Set(), async () => '[]', undefined, controller.signal)).rejects.toThrow('Stopped')
})

const peek = (threadId: string, sender: string, subject: string, extra: Partial<ThreadPeek> = {}): ThreadPeek => ({
  threadId,
  sender,
  fromName: sender.split('@')[0]!,
  subject,
  snippet: `About ${subject}`,
  latest: 0,
  flagged: false,
  ...extra,
})

test('conversations go to the model as one numbered line each, preview included', () => {
  expect(threadsForModel([peek('a:1', 'shop@x.example', 'Your order\nshipped', { snippet: 'Track "it" here' })])).toBe(
    `1. From: shop <shop@x.example> | Subject: "Your order shipped" | Preview: "Track 'it' here"`,
  )
})

test('picks are read defensively, and a pick without a reason still counts', () => {
  const picks = parsePicks('```\n[{"id":2,"reason":"Order shipped"},{"id":"1"},{"id":7},{"id":2,"reason":"again"},"x"]\n```', 3)
  expect([...picks.entries()]).toEqual([
    [1, 'Order shipped'],
    [0, 'Looks important'],
  ])
  expect(parsePicks('none of these', 3).size).toBe(0)
})

test('starred conversations are kept without asking', async () => {
  const asked: string[] = []
  const picked = await pickWorthKeeping([peek('a:1', 's@x.example', 'Starred', { flagged: true }), peek('a:2', 's@x.example', 'Sale')], async (block) => {
    asked.push(block)
    return '[]'
  })
  expect([...picked.entries()]).toEqual([['a:1', 'You starred it']])
  expect(asked).toHaveLength(1)
  expect(asked[0]).not.toContain('Starred')
})

test('a scan keeps the important conversations of junk senders and finds real mail in Spam', async () => {
  const shop = sender('shop@x.example')
  const pal = sender('pal@x.example', { wrote: 1 })
  const asked: { senders: string[]; keepers: string[]; spam: string[] } = { senders: [], keepers: [], spam: [] }
  const scan = await smartScan({
    profiles: async () => [shop, pal],
    senderThreads: async (senders) => {
      expect(senders).toEqual(['shop@x.example'])
      return [peek('a:1', 'shop@x.example', 'Big sale'), peek('a:2', 'shop@x.example', 'Your receipt')]
    },
    spamThreads: async () => [peek('a:9', 'win@prize.example', 'You won'), peek('a:8', 'lea@studio.example', 'Dinner Friday?')],
    keep: new Set(),
    askSenders: async (block) => (asked.senders.push(block), JSON.stringify([{ id: 1, verdict: 'junk', reason: 'Promotions' }])),
    askKeepers: async (block) => (asked.keepers.push(block), JSON.stringify([{ id: 2, reason: 'Receipt' }])),
    askSpam: async (block) => (asked.spam.push(block), JSON.stringify([{ id: 2, reason: 'A person writing' }])),
  })
  // The person they write to was never sent to the model.
  expect(asked.senders.join('\n')).not.toContain('pal@')
  expect(scan.groups.map((g) => [g.detail, g.verdict, g.keepers])).toEqual([
    ['shop@x.example', 'junk', [{ threadId: 'a:2', subject: 'Your receipt', reason: 'Receipt' }]],
    ['pal@x.example', 'important', []],
  ])
  expect(keepersOf(scan.groups)).toEqual(['a:2'])
  expect(scan.spam.map((t) => [t.threadId, t.reason])).toEqual([['a:8', 'A person writing']])
})

test('with no junk, no conversations are fetched or sent for a closer look', async () => {
  let fetched = false
  let keepersAsked = false
  const scan = await smartScan({
    profiles: async () => [sender('pal@x.example', { wrote: 1 })],
    senderThreads: async () => ((fetched = true), []),
    spamThreads: async () => [],
    keep: new Set(),
    askSenders: async () => '[]',
    askKeepers: async () => ((keepersAsked = true), '[]'),
    askSpam: async () => '[]',
  })
  expect(fetched).toBe(false)
  expect(keepersAsked).toBe(false)
  expect(scan.spam).toEqual([])
})
