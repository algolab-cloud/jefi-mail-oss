import { describe, expect, test } from 'bun:test'
import { completedRecipients, isEmailAddress, parseRecipients, splitAddressList } from './recipients'

describe('recipients', () => {
  test('named addresses paste as their address, not as one tag per word', () => {
    expect(parseRecipients('Nora Hale <nora@harbor.io>, jules@northlight.co')).toEqual(['nora@harbor.io', 'jules@northlight.co'])
    expect(parseRecipients('"Hale, Nora" <nora@harbor.io>; <kenji@northlight.co>')).toEqual(['nora@harbor.io', 'kenji@northlight.co'])
  })

  test('bare lists split on commas, semicolons, lines and spaces', () => {
    expect(parseRecipients('a@x.com b@y.com;c@z.com\nd@w.org')).toEqual(['a@x.com', 'b@y.com', 'c@z.com', 'd@w.org'])
    expect(parseRecipients('mailto:a@x.com, (b@y.com)')).toEqual(['a@x.com', 'b@y.com'])
  })

  test('duplicates collapse regardless of case', () => {
    expect(parseRecipients('a@x.com, A@X.com')).toEqual(['a@x.com'])
  })

  test('names resolve through contacts, and stay as typed otherwise', () => {
    const resolve = (name: string) => (name.toLowerCase() === 'kenji ito' ? 'kenji@northlight.co' : undefined)
    expect(parseRecipients('Kenji Ito, Someone', resolve)).toEqual(['kenji@northlight.co', 'Someone'])
  })

  test('splitting keeps quoted names and angle addresses whole', () => {
    expect(splitAddressList('"A, B" <a@x.com>, c@y.com')).toEqual(['"A, B" <a@x.com>', 'c@y.com'])
  })

  test('address validity', () => {
    expect(isEmailAddress('a@x.com')).toBe(true)
    expect(isEmailAddress('Nora')).toBe(false)
    expect(isEmailAddress('<nora@harbor.io>')).toBe(false)
    expect(isEmailAddress('a@x')).toBe(false)
  })

  test('typing: separators finish tags, a space only finishes a complete address', () => {
    expect(completedRecipients('kenji')).toBeNull()
    expect(completedRecipients('kenji ')).toBeNull()
    expect(completedRecipients('Kenji Ito')).toBeNull()
    expect(completedRecipients('a@x.com ')).toEqual({ done: 'a@x.com', rest: '' })
    expect(completedRecipients('a@x.com, b')).toEqual({ done: 'a@x.com', rest: 'b' })
    expect(completedRecipients('Nora Hale <nora@harbor.io> ')).toEqual({ done: 'Nora Hale <nora@harbor.io>', rest: '' })
    expect(completedRecipients('"Hale, Nora" <nora@')).toBeNull()
    expect(completedRecipients('"Hale, Nora" <nora@harbor.io>, ')).toEqual({ done: '"Hale, Nora" <nora@harbor.io>', rest: '' })
  })
})
