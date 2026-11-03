import { describe, expect, test } from 'bun:test'
import { findSignIn, htmlText, parseSignIn } from './sign-in-code'

const code = (subject: string, text: string | null, html: string | null = null) => {
  const found = findSignIn({ subject, text, html })
  return found?.kind === 'code' ? found.code : null
}

describe('one-time codes', () => {
  test('in the subject', () => {
    expect(code('Your Slack confirmation code: 482913', 'Hi')).toBe('482913')
    expect(code('123456 is your Facebook code', 'Hi')).toBe('123456')
  })

  test('on a line of its own, or introduced as a code', () => {
    expect(code('Sign in to Acme', 'Use this code to sign in:\n\n739201\n\nIt expires in 10 minutes.')).toBe('739201')
    expect(code('Verify your email', 'Your verification code is 55 21 90')).toBeNull()
    expect(code('Verify your email', 'Your verification code is 552-190.')).toBe('552190')
    expect(code('Two-factor authentication', 'Enter: K7Q2XM9 to continue')).toBe('K7Q2XM9')
    expect(code('Login code', 'Your one-time passcode is 0412')).toBe('0412')
  })

  test('from HTML when there is no text part', () => {
    expect(code('Your login code', null, '<p>Your code</p><div style="font-size:32px"><b>904 117</b></div>')).toBe('904117')
  })

  test('not in mail that is not about signing in', () => {
    expect(code('Your order has shipped', 'Order 482913 is on its way.')).toBeNull()
    expect(code('Invoice', 'Invoice number 20240311 total $1234')).toBeNull()
    expect(code('Lunch?', 'Meet at 1230 by the fountain')).toBeNull()
    expect(code('Your promo code: SAVE2025', 'SAVE2025')).toBeNull()
  })

  test('not numbers that read as something else', () => {
    expect(code('Sign in to Acme', 'Order number: 482913. Your code is in the app.')).toBeNull()
    expect(code('Verification', 'Since 2019 we have kept your account safe.')).toBeNull()
    expect(code('Security code', 'It costs $4829 per year. Call 555-0100.')).toBeNull()
  })
})

describe('magic links', () => {
  test('the sign-in button in a sign-in mail', () => {
    const html = '<p>Click below.</p><a href="https://tracking.example.com/open">View in browser</a><a href="https://app.acme.com/auth/magic?token=a1&amp;b=2">Sign in to Acme</a>'
    expect(findSignIn({ subject: 'Sign in to Acme', text: null, html })).toEqual({ kind: 'link', url: 'https://app.acme.com/auth/magic?token=a1&b=2' })
  })

  test('a link in a plain-text sign-in mail', () => {
    expect(findSignIn({ subject: 'Your magic link', text: 'Open https://acme.com/login/verify?t=xyz to continue.', html: null })).toEqual({ kind: 'link', url: 'https://acme.com/login/verify?t=xyz' })
  })

  test('not in a newsletter that just mentions signing in', () => {
    const html = '<a href="https://shop.example.com/sale">Sign in to see deals</a>'
    expect(findSignIn({ subject: 'Weekend sale: 30% off', text: null, html })).toBeNull()
  })
})

test('the text of an HTML mail decodes entities once and drops scripts', () => {
  expect(htmlText('<p>Type &amp;lt;code&amp;gt;&nbsp;&lt;here&gt;</p>')).toBe(' Type &lt;code&gt; <here>\n')
  expect(htmlText('<script>var code = 111111</script >Your code is 222222')).toBe(' Your code is 222222')
})

test('stored values read back, and junk reads as nothing', () => {
  expect(parseSignIn('{"kind":"code","code":"482913"}')).toEqual({ kind: 'code', code: '482913' })
  expect(parseSignIn('{"kind":"code"}')).toBeUndefined()
  expect(parseSignIn('not json')).toBeUndefined()
  expect(parseSignIn(null)).toBeUndefined()
})
