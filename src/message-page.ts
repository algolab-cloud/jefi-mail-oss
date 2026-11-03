import type { Message } from './data'
import { markdownToHtml } from './engine/mime'
import { splitQuoted } from './mail-text'

// ---------------------------------------------------------------------------
// Every message is read in the HTML view (src/html-view.tsx), so each one needs a page: the HTML the
// sender wrote, the composer's text as it was sent, or a plain-text message turned into HTML. The
// quoted history trailing a plain-text reply folds into a <details>, which WebKit opens and closes
// itself (the page runs no script).
// ---------------------------------------------------------------------------

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Web and mail addresses in plain text, as links. Trailing punctuation stays outside the link. */
const PLAIN_LINK = /\b(?:https?:\/\/|mailto:)[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi

/** One line of plain text as HTML: escaped, with its addresses made into links. */
function plainLine(line: string): string {
  let out = ''
  let last = 0
  for (const match of line.matchAll(PLAIN_LINK)) {
    const url = match[0]
    out += escapeHtml(line.slice(last, match.index)) + `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
    last = match.index! + url.length
  }
  return out + escapeHtml(line.slice(last))
}

/** Plain text as paragraphs: blank lines split them, single newlines stay line breaks. */
export function plainTextHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.split('\n').map(plainLine).join('<br>')}</p>`)
    .join('\n')
}

/** Quoted history, folded until the reader opens it. */
const folded = (html: string) => `<details class="jefi-quoted"><summary>•••</summary>${html}</details>`

/** A plain-text body from its paragraphs (list blocks are one item per line). */
const paragraphsText = (blocks: Message['paragraphs']) => blocks.map((block) => (Array.isArray(block) ? block.join('\n') : block)).join('\n\n')

/**
 * The page the HTML view shows for a message, or null while its body isn't on this Mac. Mail that came
 * with HTML shows it; mail written in Jefi (drafts, the Outbox, a reply just sent) shows its text as it
 * goes out; plain-text mail is escaped into paragraphs, its quoted history folded.
 */
export function messagePage(message: Message): string | null {
  if (message.bodyMissing) return null
  if (message.html) return message.html
  if (message.markdown !== undefined) {
    const { body, quoted } = splitQuoted(message.markdown)
    return markdownToHtml(body) + (quoted ? folded(markdownToHtml(quoted.replace(/^\s*>\s?/gm, ''))) : '')
  }
  if (!message.paragraphs.length) return null
  const { body, quoted } = splitQuoted(paragraphsText(message.paragraphs))
  return plainTextHtml(body) + (quoted ? folded(plainTextHtml(quoted.replace(/^\s*>\s?/gm, ''))) : '')
}
