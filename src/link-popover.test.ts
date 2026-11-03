import { describe, expect, test } from 'bun:test'
import { draftFromMailto } from './link-popover'

describe('reviewed mailto links', () => {
  test('open a normal reviewable draft with address fields and message text', () => {
    expect(draftFromMailto('mailto:hello@example.com?cc=team%40example.com&bcc=audit%40example.com&subject=Hello%20there&body=Please%20review')).toEqual({
      to: ['hello@example.com'],
      cc: ['team@example.com'],
      bcc: ['audit@example.com'],
      subject: 'Hello there',
      body: 'Please review',
    })
  })

  test('refuses malformed or recipient-free mail links', () => {
    expect(draftFromMailto('mailto:')).toBeNull()
    expect(draftFromMailto('https://example.com')).toBeNull()
  })

  test('uses the same strict recipient policy as the review before creating a draft', () => {
    expect(draftFromMailto('mailto:victim@example.com;attacker@evil.example')).toBeNull()
    expect(draftFromMailto('mailto:victim@example.com?cc=friend@example.com;attacker@evil.example')).toBeNull()
    expect(draftFromMailto('mailto:victim@example.com?bcc=archive@example.com;attacker@evil.example')).toBeNull()
    expect(draftFromMailto('mailto:victim@example.com?cc=first@example.com&CC=second@example.com')).toBeNull()
  })
})
