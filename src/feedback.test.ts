import { afterAll, expect, test } from 'bun:test'
import { feedbackBody, feedbackContext, feedbackErrors, sendFeedback, type FeedbackDraft } from './feedback'
import { APP_VERSION } from './version'

const draft: FeedbackDraft = { kind: 'bug', message: '  The calendar skips a day in March.  ', email: ' mara@example.com ', name: '', includeContext: true }
const context = { version: '0.8.0', os: '15.1', arch: 'arm64' }

test('a report needs a few words and an address to reply to', () => {
  expect(feedbackErrors(draft)).toEqual({})
  expect(feedbackErrors({ ...draft, message: 'hm', email: 'mara' })).toEqual({ message: 'Please write a little more', email: 'An address to reply to' })
  expect(feedbackErrors({ ...draft, message: 'x'.repeat(5001) }).message).toBe('Please keep it under 5,000 characters')
})

test('what goes to jefi.app: the kind as the topic, trimmed text, and the context only when allowed', () => {
  expect(feedbackBody(draft, context)).toEqual({ topic: 'bug', message: 'The calendar skips a day in March.', email: 'mara@example.com', name: undefined, context })
  expect(feedbackBody({ ...draft, includeContext: false }, context)).not.toHaveProperty('context')
})

test('the context names this build and the machine, nothing more', () => {
  const c = feedbackContext()
  expect(Object.keys(c).sort()).toEqual(['arch', 'os', 'version'])
  expect(c.version).toBe(APP_VERSION)
  // The macOS version, from sw_vers; CI's Linux runners have none to report.
  expect(c.os).toMatch(process.platform === 'darwin' ? /^\d+(\.\d+)*$/ : /^$/)
})

const received: unknown[] = []
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as { message: string }
    received.push(body)
    return body.message.includes('slow down') ? Response.json({ ok: false, error: 'Too many requests. Try again in a minute.' }, { status: 429 }) : Response.json({ ok: true })
  },
})
afterAll(() => server.stop())

test('sending posts to the contact endpoint and passes on what it says when it refuses', async () => {
  const previous = process.env.JEFI_API_URL
  process.env.JEFI_API_URL = `http://localhost:${server.port}`
  try {
    expect(await sendFeedback(draft)).toEqual({ ok: true })
    expect(received[0]).toMatchObject({ topic: 'bug', email: 'mara@example.com' })
    expect(await sendFeedback({ ...draft, message: 'slow down please' })).toEqual({ ok: false, error: 'Too many requests. Try again in a minute.' })
    process.env.JEFI_API_URL = 'http://localhost:1'
    expect((await sendFeedback(draft)).ok).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.JEFI_API_URL
    else process.env.JEFI_API_URL = previous
  }
})
