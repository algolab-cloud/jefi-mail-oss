import { expect, test } from 'bun:test'
import type { Message } from './data'
import { messagePage, plainTextHtml } from './message-page'

const message = (fields: Partial<Message>): Message =>
  ({ id: 'm', from: 'Nora', email: 'nora@harbor.io', to: 'Me', face: {}, time: '9:00', paragraphs: [], ...fields }) as Message

test('mail that came with HTML shows that HTML', () => {
  expect(messagePage(message({ html: '<p>Hi <b>there</b></p>', markdown: 'Hi **there**', paragraphs: ['Hi there'] }))).toBe('<p>Hi <b>there</b></p>')
})

test('plain text is escaped, keeps its line breaks and links its addresses', () => {
  expect(plainTextHtml('a <b> & c\nnext line\n\nsee https://example.com/x.')).toBe(
    '<p>a &lt;b&gt; &amp; c<br>next line</p>\n<p>see <a href="https://example.com/x">https://example.com/x</a>.</p>',
  )
})

test("a plain-text reply's quoted history folds", () => {
  const page = messagePage(message({ paragraphs: ['Sounds good.', 'On Mon, Nora wrote:\n> Lunch?\n> At noon'] }))!
  // The attribution line folds with the quote it introduces.
  expect(page).toStartWith('<p>Sounds good.</p>')
  expect(page).toContain('<details class="jefi-quoted"><summary>•••</summary><p>On Mon, Nora wrote:<br>Lunch?<br>At noon</p></details>')
})

test('mail written in Jefi shows its text as it is sent', () => {
  expect(messagePage(message({ markdown: 'Hi **Nora**\n\n- one\n- two' }))).toBe('<p>Hi <strong>Nora</strong></p>\n<ul><li>one</li><li>two</li></ul>')
})

test('a body that is not on this Mac yet has no page', () => {
  expect(messagePage(message({ bodyMissing: true, paragraphs: ['snippet'] }))).toBeNull()
  expect(messagePage(message({ paragraphs: [] }))).toBeNull()
})
