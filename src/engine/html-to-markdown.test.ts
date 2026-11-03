import { expect, test } from 'bun:test'
import { htmlToMarkdown } from './html-to-markdown'

test('drops everything that could run or load', () => {
  const md = htmlToMarkdown(`
    <html><head><title>T</title><style>p{color:red}</style><script>alert(1)</script></head>
    <body onload="steal()"><p onclick="x()">Hello</p>
      <iframe src="https://evil.example"></iframe><form action="/x"><input name="pw"></form>
      <img src="https://track.example/pixel.gif" width="1" height="1">
      <svg><script>alert(2)</script></svg><object data="x.swf"></object></body></html>`)
  expect(md).toBe('Hello')
})

test('unsafe link targets become plain text; safe ones stay links', () => {
  expect(htmlToMarkdown('<a href="javascript:alert(1)">Click</a>')).toBe('Click')
  expect(htmlToMarkdown('<a href="data:text/html,x">Data</a>')).toBe('Data')
  expect(htmlToMarkdown('<a href="https://jefi.app/docs">Docs</a>')).toBe('[Docs](https://jefi.app/docs)')
  expect(htmlToMarkdown('<a href="mailto:hi@jefi.app">hi@jefi.app</a>')).toBe('<hi@jefi.app>')
})

test('images never load: alt text stays, pixels vanish', () => {
  expect(htmlToMarkdown('<p>Logo: <img src="https://x/logo.png" alt="Acme"> <img src="https://x/p.gif"></p>')).toBe('Logo: *Acme*')
})

test('hidden preheader text is skipped', () => {
  expect(htmlToMarkdown('<div style="display: none; max-height: 0">Preview text</div><p>Body</p>')).toBe('Body')
})

test('markdown in the mail is escaped, not interpreted', () => {
  expect(htmlToMarkdown('<p># not a heading *not bold* [x](javascript:y)</p>')).toBe('\\# not a heading \\*not bold\\* \\[x\\](javascript:y)')
})

test('keeps structure: headings, emphasis, lists, quotes, breaks, code', () => {
  const md = htmlToMarkdown(`
    <h1>Weekly update</h1>
    <p>Hi <b>team</b>,<br>two things:</p>
    <ul><li>Ship <i>Jefi</i></li><li>Rest</li></ul>
    <ol><li>One</li><li>Two</li></ol>
    <blockquote><p>Quoted line</p></blockquote>
    <pre>let x = 1
let y = 2</pre>`)
  expect(md).toBe(
    ['# Weekly update', 'Hi **team**,\ntwo things:', '- Ship *Jefi*\n- Rest', '1. One\n2. Two', '> Quoted line', '```\nlet x = 1\nlet y = 2\n```'].join('\n\n'),
  )
})

test('layout tables flatten into paragraphs without piles of blank lines', () => {
  const md = htmlToMarkdown(`<table><tr><td><table><tr><td>First</td></tr></table></td></tr>
    <tr><td>&nbsp;</td></tr><tr><td>Second &amp; last</td></tr></table>`)
  expect(md).toBe('First\n\nSecond & last')
})
test('a literal BR in text stays text', () => { expect(htmlToMarkdown('<p>Jefi BR test<br>next</p>')).toBe('Jefi BR test\nnext') })
