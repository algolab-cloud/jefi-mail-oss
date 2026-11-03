import { parseDocument, DomUtils } from 'htmlparser2'
import type { AnyNode, Element } from 'domhandler'

export type MessageLink = {
  label: string
  /** The destination the renderer will hand to the existing click-time policy. */
  url: string
  /** A URL-looking label names a different host than the destination. */
  labelHostMismatch?: { labelHost: string; destinationHost: string }
}

const normalizeReference = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
const unescapeMarkdown = (value: string) => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
const plainLabel = (value: string) => unescapeMarkdown(value).replace(/[*_~`]/g, '').trim()

const displayUrl = (raw: string) => {
  const value = unescapeMarkdown(raw.trim())
  try {
    return new URL(value).href
  } catch {
    return value
  }
}

const hostFromLabel = (label: string) => {
  const value = label.trim().replace(/^<|>$/g, '')
  if (/\s/.test(value)) return null
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : /^(?:www\.)?[\p{L}\d-]+(?:\.[\p{L}\d-]+)+(?:[/:?#]|$)/u.test(value) ? `https://${value}` : ''
  if (!candidate) return null
  try {
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

const mismatch = (label: string, url: string): MessageLink['labelHostMismatch'] => {
  const labelHost = hostFromLabel(label)
  if (!labelHost) return undefined
  try {
    const destinationHost = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return destinationHost && destinationHost !== labelHost ? { labelHost, destinationHost } : undefined
  } catch {
    return undefined
  }
}

/** Normalize one rendered label/destination pair and flag misleading URL-shaped labels. */
export const messageLink = (label: string, rawUrl: string): MessageLink | null => {
  const url = displayUrl(rawUrl)
  if (!url) return null
  const cleanLabel = plainLabel(label) || url
  const labelHostMismatch = mismatch(cleanLabel, url)
  return { label: cleanLabel, url, ...(labelHostMismatch ? { labelHostMismatch } : {}) }
}

type Candidate = MessageLink & { start: number; end: number }

const masked = (source: string) => {
  // Regex and String.slice offsets are UTF-16 code units, so the mask must use the same units.
  const chars = source.split('')
  const hide = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (chars[index] !== '\n') chars[index] = ' '
  }
  for (const match of source.matchAll(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2(?:\n|$)|$)/g)) hide(match.index + match[1].length, match.index + match[0].length)
  for (const match of source.matchAll(/(`+)([^\n]*?)\1/g)) hide(match.index, match.index + match[0].length)
  return {
    get text() {
      return chars.join('')
    },
    hide,
  }
}

const closing = (source: string, start: number, open: string, close: string) => {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    if (source[index] === '\\') {
      index++
      continue
    }
    if (source[index] === open) depth++
    else if (source[index] === close && --depth === 0) return index
  }
  return -1
}

const inlineDestination = (source: string, start: number) => {
  let cursor = start
  while (/\s/.test(source[cursor] ?? '')) cursor++
  if (source[cursor] === '<') {
    const end = source.indexOf('>', cursor + 1)
    return end < 0 ? null : { raw: source.slice(cursor + 1, end), end: closing(source, start - 1, '(', ')') }
  }
  let nested = 0
  let end = cursor
  for (; end < source.length; end++) {
    const char = source[end]
    if (char === '\\') {
      end++
      continue
    }
    if (char === '(') nested++
    else if (char === ')') {
      if (nested === 0) break
      nested--
    } else if (/\s/.test(char ?? '') && nested === 0) break
  }
  const close = closing(source, start - 1, '(', ')')
  return close < 0 ? null : { raw: source.slice(cursor, end), end: close }
}

const overlaps = (ranges: Array<{ start: number; end: number }>, start: number, end: number) => ranges.some((range) => start < range.end && end > range.start)

/**
 * Links the native Markdown renderer can expose. Reference links, inline links, angle autolinks,
 * and GFM bare URLs are returned in source order; code and image destinations are ignored.
 */
export function markdownLinks(source: string): MessageLink[] {
  const mask = masked(source)
  const definitions = new Map<string, string>()
  for (const match of mask.text.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+.*)?$/gm)) {
    definitions.set(normalizeReference(match[1]), match[2] ?? match[3] ?? '')
    mask.hide(match.index, match.index + match[0].length)
  }

  const candidates: Candidate[] = []
  const occupied: Array<{ start: number; end: number }> = []
  for (const image of mask.text.matchAll(/!\[[^\]]*\](?:\([^\n)]*\)|\[[^\]]*\])/g)) {
    occupied.push({ start: image.index, end: image.index + image[0].length })
    mask.hide(image.index, image.index + image[0].length)
  }
  // All masking is complete. Joining the character array inside this scan would copy
  // the entire message for every character, making long messages quadratic.
  const text = mask.text
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '[' || text[start - 1] === '!' || text[start - 1] === '\\') continue
    const labelEnd = closing(text, start, '[', ']')
    if (labelEnd < 0) continue
    const label = source.slice(start + 1, labelEnd)
    let end = labelEnd + 1
    let rawUrl: string | undefined
    if (text[end] === '(') {
      const destination = inlineDestination(source, end + 1)
      if (destination?.end != null && destination.end >= 0) {
        rawUrl = destination.raw
        end = destination.end + 1
      }
    } else if (text[end] === '[') {
      const referenceEnd = closing(text, end, '[', ']')
      if (referenceEnd >= 0) {
        const reference = source.slice(end + 1, referenceEnd) || label
        rawUrl = definitions.get(normalizeReference(reference))
        end = referenceEnd + 1
      }
    } else {
      rawUrl = definitions.get(normalizeReference(label))
    }
    const found = rawUrl ? messageLink(label, rawUrl) : null
    if (!found) continue
    candidates.push({ ...found, start, end })
    occupied.push({ start, end })
    start = end - 1
  }

  for (const match of text.matchAll(/<([a-z][a-z\d+.-]*:[^<>\s]+)>/gi)) {
    const start = match.index
    const end = start + match[0].length
    if (overlaps(occupied, start, end)) continue
    const found = messageLink(match[1], match[1])
    if (found) candidates.push({ ...found, start, end })
    occupied.push({ start, end })
  }

  const bare = /\b(?:https?:\/\/|mailto:)[^\s<>\[\]()]+/gi
  for (const match of text.matchAll(bare)) {
    const start = match.index
    let raw = match[0].replace(/[.,!?;:'"]+$/, '')
    const end = start + raw.length
    if (!raw || overlaps(occupied, start, end)) continue
    const found = messageLink(raw, raw)
    if (found) candidates.push({ ...found, start, end })
  }

  candidates.sort((a, b) => a.start - b.start)
  const seen = new Set<string>()
  return candidates.flatMap(({ start: _start, end: _end, ...found }) => {
    const key = found.url
    if (seen.has(key)) return []
    seen.add(key)
    return [found]
  })
}

const isElement = (node: AnyNode): node is Element => node.type === 'tag'

/** Anchor destinations from HTML mail, in document order, without loading or resolving them. */
export function htmlLinks(html: string): MessageLink[] {
  const result: MessageLink[] = []
  const seen = new Set<string>()
  const visit = (node: AnyNode) => {
    if (isElement(node) && node.name.toLowerCase() === 'a' && node.attribs.href) {
      const found = messageLink(DomUtils.textContent(node), node.attribs.href)
      if (found && !seen.has(found.url)) {
        seen.add(found.url)
        result.push(found)
      }
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  for (const node of parseDocument(html, { decodeEntities: true }).children) visit(node)
  return result
}
