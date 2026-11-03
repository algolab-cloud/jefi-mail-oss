import { describe, expect, test } from 'bun:test'
import { htmlLinks, markdownLinks } from './link-accessibility'

describe('accessible message links', () => {
  test('extracts inline, reference, angle, and bare Markdown links in source order', () => {
    const source = [
      '[Account](https://accounts.example.com/path)',
      '[Help][docs] and <mailto:support@example.com>',
      'Then https://status.example.com/now.',
      '',
      '[docs]: https://docs.example.com/start "Documentation"',
    ].join('\n')
    expect(markdownLinks(source).map(({ label, url }) => ({ label, url }))).toEqual([
      { label: 'Account', url: 'https://accounts.example.com/path' },
      { label: 'Help', url: 'https://docs.example.com/start' },
      { label: 'mailto:support@example.com', url: 'mailto:support@example.com' },
      { label: 'https://status.example.com/now', url: 'https://status.example.com/now' },
    ])
  })

  test('ignores code and image destinations and deduplicates repeated links', () => {
    const source = '😀 `https://code.example`\n```md\n[hidden](https://hidden.example)\n```\n![pixel](https://image.example/pixel)\n<https://real.example> and https://real.example'
    expect(markdownLinks(source)).toEqual([{ label: 'https://real.example', url: 'https://real.example/' }])
  })

  test('definition destinations do not leak as bare links and case-sensitive paths stay distinct', () => {
    const source = '[Guide][docs]\n\n[docs]: https://example.com/A\n\nhttps://example.com/A https://example.com/a'
    expect(markdownLinks(source).map((item) => item.url)).toEqual([
      'https://example.com/A',
      'https://example.com/a',
    ])
  })

  test('reports a URL-looking label that points to a different host', () => {
    expect(markdownLinks('[https://billing.example.com](https://billing.example.net/login)')).toEqual([
      {
        label: 'https://billing.example.com',
        url: 'https://billing.example.net/login',
        labelHostMismatch: { labelHost: 'billing.example.com', destinationHost: 'billing.example.net' },
      },
    ])
  })

  test('finds the final link in a long Unicode message without exposing masked destinations', () => {
    const paragraph = 'A long message with ordinary text and emoji 😃. '.repeat(2500)
    const source = `${paragraph}\n![image](https://image.example/pixel)\n\`https://code.example\`\n[Guide][docs]\n[docs]: https://docs.example/start\n[Last](https://last.example/end)`
    expect(markdownLinks(source)).toEqual([
      { label: 'Guide', url: 'https://docs.example/start' },
      { label: 'Last', url: 'https://last.example/end' },
    ])
  })

  test('extracts decoded HTML anchors in document order without including scripts or images', () => {
    const html = '<p><a href="https://one.example/?a=1&amp;b=2">One</a><img src="https://tracker.example/p"></p><a href="mailto:team@example.com">Team</a>'
    expect(htmlLinks(html)).toEqual([
      { label: 'One', url: 'https://one.example/?a=1&b=2' },
      { label: 'Team', url: 'mailto:team@example.com' },
    ])
  })
})
