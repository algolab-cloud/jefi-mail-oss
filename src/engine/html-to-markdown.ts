import { parseDocument } from 'htmlparser2'
import type { ChildNode, Element } from 'domhandler'

// ---------------------------------------------------------------------------
// HTML mail → Markdown for Jefi's native renderer.
//
// Jefi never displays mail HTML: it rebuilds the message from a small set of safe blocks
// (headings, paragraphs, lists, quotes, code, links, emphasis). Anything that could run or phone
// home is dropped on the way — scripts, styles, frames, forms, event handlers, and every image,
// so tracking pixels never load. An image with alt text leaves the text behind.
// ---------------------------------------------------------------------------

/** Elements whose whole subtree is dropped. */
const DROP = new Set([
  'head', 'title', 'meta', 'link', 'style', 'script', 'noscript', 'template',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option',
  'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'map',
])

/** Elements that start a new paragraph. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center',
  'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'dl', 'dt', 'dd',
  'figure', 'figcaption', 'address', 'details', 'summary', 'fieldset',
])

/** Stands in for <br> until the final tidy (a private-use character never found in mail text). */
const BREAK = '\uE000'

/** Link targets a person can safely follow; anything else (javascript:, data:, file:) stays text. */
const SAFE_LINK = /^(https?:|mailto:)/i

export function htmlToMarkdown(html: string): string {
  const doc = parseDocument(html, { decodeEntities: true })
  const out = blocks(doc.children, { list: null, pre: false })
  return tidy(out)
}

type Context = { list: { ordered: boolean; index: number } | null; pre: boolean }

function blocks(nodes: ChildNode[], ctx: Context): string {
  return nodes.map((node) => render(node, ctx)).join('')
}

function render(node: ChildNode, ctx: Context): string {
  if (node.type === 'text') return ctx.pre ? node.data : escape(node.data.replace(/\s+/g, ' '))
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return ''
  const el = node as Element
  const tag = el.name.toLowerCase()
  if (DROP.has(tag) || hidden(el)) return ''

  const inner = (next: Context = ctx) => blocks(el.children, next)
  switch (tag) {
    case 'br':
      return ctx.pre ? '\n' : BREAK
    case 'hr':
      return '\n\n---\n\n'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const text = oneLine(inner())
      return text ? `\n\n${'#'.repeat(Math.min(Number(tag[1]), 3))} ${text}\n\n` : ''
    }
    case 'strong':
    case 'b':
      return wrap(inner(), '**')
    case 'em':
    case 'i':
      return wrap(inner(), '*')
    case 's':
    case 'strike':
    case 'del':
      return wrap(inner(), '~~')
    case 'code':
      return ctx.pre ? inner() : wrap(textOf(el).replace(/`/g, "'"), '`')
    case 'pre':
      return `\n\n\`\`\`\n${textOf(el).replace(/```/g, "'''").replace(/\n+$/, '')}\n\`\`\`\n\n`
    case 'a': {
      const text = inner().trim()
      const href = (el.attribs.href ?? '').trim()
      if (!text) return ''
      if (!SAFE_LINK.test(href)) return text
      // A link whose text is its own address reads better bare.
      const plain = text.replace(/\\/g, '')
      if (plain === href) return `<${href}>`
      if (`mailto:${plain}` === href) return `<${plain}>`
      return `[${text.replace(/[[\]]/g, '')}](${href.replace(/[()\s]/g, encodeURIComponent)})`
    }
    case 'img': {
      const alt = (el.attribs.alt ?? '').replace(/\s+/g, ' ').trim()
      return alt ? `*${escape(alt)}*` : ''
    }
    case 'ul':
    case 'ol':
      return `\n\n${inner({ ...ctx, list: { ordered: tag === 'ol', index: 0 } })}\n\n`
    case 'li': {
      const list = ctx.list ?? { ordered: false, index: 0 }
      list.index++
      const marker = list.ordered ? `${list.index}. ` : '- '
      const body = tidy(inner({ ...ctx, list: null }))
        .split('\n')
        .map((line, i) => (i === 0 ? line : line ? `   ${line}` : ''))
        .join('\n')
      return body ? `${marker}${body}\n` : ''
    }
    case 'blockquote': {
      const body = tidy(inner()).replace(/\n+$/, '')
      return body ? `\n\n${body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n` : ''
    }
    default:
      return BLOCK.has(tag) ? `\n\n${inner()}\n\n` : inner()
  }
}

/** Newsletters hide preheader text with inline styles; so do we. */
function hidden(el: Element) {
  if ('hidden' in el.attribs) return true
  const style = (el.attribs.style ?? '').replace(/\s+/g, '').toLowerCase()
  return /display:none|visibility:hidden|max-height:0(px)?(;|$)|font-size:0(px)?(;|$)/.test(style)
}

function textOf(node: ChildNode): string {
  if (node.type === 'text') return node.data
  if ('children' in node) {
    if (node.type === 'tag' && ((node as Element).name === 'br')) return '\n'
    return node.children.map(textOf).join('')
  }
  return ''
}

const escape = (text: string) => text.replace(/([\\`*_[\]<>#|~])/g, '\\$1')

const oneLine = (text: string) => text.replaceAll(BREAK, ' ').replace(/\s+/g, ' ').trim()

function wrap(text: string, mark: string) {
  const trimmed = text.trim()
  if (!trimmed) return text
  // Keep surrounding spaces outside the markers, or the emphasis doesn't parse.
  const lead = text.match(/^\s*/)![0]
  const trail = text.match(/\s*$/)![0]
  return `${lead}${mark}${trimmed}${mark}${trail}`
}

/** Collapses the blank lines and stray spaces left by nested layout tables. */
function tidy(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\uE000[ \t]*/g, '\n')
    .replace(/^(?!\s*[-\d>])(.*?) +$/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
