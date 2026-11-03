import { memo, useMemo, useState } from 'react'
import { FONT, useSettings } from './theme'
import type { Contact } from './data'
import { findContact, mentionPattern } from './contacts'
import type { LinkPosition } from './link-popover'
import { assessEmailLink } from './link-safety'
import { markdownLinks, type MessageLink } from './link-accessibility'

export { findContact }

/** Names of the contacts @-mentioned in a body, in order of first appearance. */
export function mentionedContacts(body: string): Contact[] {
  const pattern = mentionPattern()
  if (!pattern) return []
  const seen = new Set<string>()
  const out: Contact[] = []
  for (const match of body.matchAll(pattern)) {
    const contact = findContact(match[1] ?? '')
    if (contact && !seen.has(contact.email)) {
      seen.add(contact.email)
      out.push(contact)
    }
  }
  return out
}

/** Known @mentions become mailto links; task markers become checkbox glyphs;
 *  single newlines stay line breaks. */
function prepareSource(body: string) {
  // The native renderer prints task-list markers literally, so draw them as glyphs.
  return body
    // Mail is written line by line: keep single newlines as hard breaks, not soft wraps.
    .replace(/([^\n])\n(?=[^\n])/g, '$1  \n')
    .replace(/^(\s*[-*+]\s+)\[[xX]\]\s+/gm, '$1☑ ')
    .replace(/^(\s*[-*+]\s+)\[ \]\s+/gm, '$1☐ ')
    .replace(mentionPattern() ?? /$^/g, (whole, name: string) => {
    const contact = findContact(name)
    return contact ? `[@${contact.name}](mailto:${contact.email})` : whole
  })
}

const PLAIN_URL = /\b(?:https?:\/\/|mailto:)[^\s<>]+/gi
const TRAILING_PUNCTUATION = /[.,!?;:'\"]+$/

const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}\[\]()#+\-.!<>|])/g, '\\$1')

/** Plain message text with URL-shaped spans made clickable, without interpreting the text as Markdown. */
export function linkifyPlainText(source: string) {
  let cursor = 0
  let out = ''
  for (const match of source.matchAll(PLAIN_URL)) {
    const start = match.index
    const candidate = match[0]
    const trailing = candidate.match(TRAILING_PUNCTUATION)?.[0] ?? ''
    const url = candidate.slice(0, candidate.length - trailing.length)
    out += escapeMarkdown(source.slice(cursor, start))
    out += url ? `<${url}>${escapeMarkdown(trailing)}` : escapeMarkdown(candidate)
    cursor = start + candidate.length
  }
  return out + escapeMarkdown(source.slice(cursor))
}

/** Plain paragraphs keep their literal punctuation and list shape while gaining safe link spans. */
export function plainTextMarkdown(source: string | string[]) {
  return Array.isArray(source)
    ? source.map((line) => `- ${linkifyPlainText(line)}`).join('\n')
    : source.split('\n').map(linkifyPlainText).join('  \n')
}

/** A one-line plain-text preview of a markdown body, for list snippets. */
export function plainSnippet(body: string, max = 90) {
  const line =
    body
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, '')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/(\*\*|__|~~|`|\*|_)/g, '')
          .trim(),
      )
      .find((l) => l.length > 0 && l !== '---') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Human-readable recipient list: contact names where known, raw addresses otherwise. */
export function recipientNames(list: string[]) {
  return list.map((value) => findContact(value)?.name ?? value).join(', ')
}

export type LinkDisclosureContext = { sender: string; trustedDomains: readonly string[] }

type InlineLinkState = { source: string; url: string; linkIndex?: number; position: LinkPosition }

function InlineLinkStatus({ link, disclosure, links }: { link: InlineLinkState; disclosure: LinkDisclosureContext; links: readonly MessageLink[] }) {
  const { C } = useSettings()
  const assessment = useMemo(() => assessEmailLink(link.url, disclosure.sender, disclosure.trustedDomains), [disclosure.sender, disclosure.trustedDomains, link.url])
  const mismatch = links.find((item) => item.url === link.url)?.labelHostMismatch
  const caution = Boolean(mismatch) || assessment.warnings.length > 0
  const detail = mismatch
    ? `Displayed text names ${mismatch.labelHost}; the destination is ${mismatch.destinationHost}.`
    : assessment.warnings[0] ?? assessment.detail
  return (
    <anchored position={link.position} anchor="topLeft" fit="snap" deferred priority={3} occlude style={{ backgroundColor: C.raised, borderRadius: 8 }}>
      <div
        testId="message-inline-link-disclosure"
        style={{ width: 390, maxHeight: 108, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, borderRadius: 12, borderWidth: 1, borderColor: caution ? C.amber : C.overlayStrong, backgroundColor: C.raised, boxShadow: { offsetX: 0, offsetY: 5, blurRadius: 18, spreadRadius: 0, color: '#00000055' }, display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'none' }}
      >
        <text style={{ fontFamily: FONT, fontSize: 11.5, fontWeight: 650, color: caution ? C.amber : C.secondary }}>Destination</text>
        <text style={{ fontFamily: FONT, fontSize: 12, lineHeight: 17, color: C.text, maxWidth: '100%', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{assessment.url ?? link.url}</text>
        <text style={{ fontFamily: FONT, fontSize: 11.5, lineHeight: 16, color: caution ? C.amber : C.secondary, maxWidth: '100%' }}>{detail}</text>
      </div>
    </anchored>
  )
}

/** A redundant destination index for keyboard review and links beyond the visible message body. */
export function LinkDestinationList({ links, disclosure, onLink, testId = 'message-links' }: {
  links: readonly MessageLink[]
  disclosure: LinkDisclosureContext
  onLink: (url: string, position?: LinkPosition) => void
  testId?: string
}) {
  const { C } = useSettings()
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  if (!links.length) return null
  const activeIndex = hovered ?? focused
  const active = activeIndex === null ? null : links[activeIndex] ?? null
  const assessment = active ? assessEmailLink(active.url, disclosure.sender, disclosure.trustedDomains) : null
  const status = active?.labelHostMismatch
    ? `Displayed text names ${active.labelHostMismatch.labelHost}; the destination is ${active.labelHostMismatch.destinationHost}.`
    : assessment?.warnings[0] ?? assessment?.detail ?? 'Hover or focus a link to inspect its destination. Press Enter to review it.'

  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderColor: C.divider }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ fontFamily: FONT, fontSize: 12.5, fontWeight: 600, color: C.secondary }}>Links in this message</text>
        <text style={{ flexGrow: 1, fontFamily: FONT, fontSize: 11.5, color: active ? (active.labelHostMismatch || assessment?.warnings.length ? C.amber : C.secondary) : C.muted, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {status}
        </text>
      </div>
      {links.map((item, index) => {
        const selected = activeIndex === index
        const hover = () => setHovered(index)
        const leave = () => setHovered(null)
        return (
          <div
            key={`${index}-${item.url}`}
            testId={`${testId}-${index}`}
            tabIndex={0}
            role="link"
            aria-label={`${item.label}: ${item.url}`}
            aria-description="Press Enter to review this destination before opening it."
            onMouseEnter={hover}
            onMouseLeave={leave}
            onFocus={() => setFocused(index)}
            onBlur={() => setFocused(null)}
            onKeyDown={(event) => {
              if (event.key === 'enter' || event.key === 'space') onLink(item.url)
            }}
            onClick={(event) => onLink(item.url, typeof event.x === 'number' && typeof event.y === 'number' ? { x: event.x, y: event.y } : undefined)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingLeft: 10,
              paddingRight: 10,
              paddingTop: 7,
              paddingBottom: 7,
              borderRadius: 9,
              borderWidth: 1,
              borderColor: selected ? C.accent : '#00000000',
              backgroundColor: selected ? C.chip : C.overlay,
              cursor: 'pointer',
              hover: { backgroundColor: C.overlay },
            }}
          >
            <text onMouseEnter={hover} onMouseLeave={leave} style={{ fontFamily: FONT, fontSize: 12.5, fontWeight: 500, color: C.text, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</text>
            <text onMouseEnter={hover} onMouseLeave={leave} style={{ fontFamily: FONT, fontSize: 11.5, color: item.labelHostMismatch ? C.amber : C.secondary, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.url}</text>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Memoized: the reader re-renders on every scroll step (the virtual list's window moves), and a new
 * source or theme object makes the native element parse and lay out its markdown again.
 */
export const MailMarkdown = memo(function MailMarkdown({ source, testId, onLink, linkDisclosure, prepared = false }: { source: string; testId?: string; /** Source already escaped and linkified by plainTextMarkdown. */ prepared?: boolean; /** Handles clicks on links (e.g. jefi:// links in the assistant). */ onLink?: (url: string, position?: LinkPosition) => void; /** Adds inline hover/focus disclosure plus a redundant keyboard destination index. */ linkDisclosure?: LinkDisclosureContext }) {
  const { C, settings } = useSettings()
  const renderedSource = useMemo(() => prepared ? source : prepareSource(source), [prepared, source])
  const links = useMemo(() => linkDisclosure ? markdownLinks(renderedSource) : [], [linkDisclosure, renderedSource])
  const theme = useMemo(
    () => ({
      appearance: settings.theme,
      bg: 'transparent',
      text: C.text,
      textMuted: C.secondary,
      textFaint: C.muted,
      textDim: C.ghost,
      accent: C.accent,
      border: C.border,
      codeText: C.text,
      codeWash: C.chip,
      fontSans: FONT,
      metrics: { mdTextSize: 14, mdLineHeight: 21, mdBlockGap: 10, mdHeadingSizes: [20, 17, 15, 14] },
    }),
    [C, settings.theme],
  )
  const style = useMemo(() => ({ fontFamily: FONT, color: C.text }), [C])
  const [hoveredLink, setHoveredLink] = useState<InlineLinkState | null>(null)
  const [focusedLink, setFocusedLink] = useState<InlineLinkState | null>(null)
  const inlineLink = hoveredLink?.source === renderedSource
    ? hoveredLink
    : focusedLink?.source === renderedSource ? focusedLink : null
  const linkEvent = (event: { value?: string; startIndex?: number; x?: number; y?: number }) => event.value && typeof event.x === 'number' && typeof event.y === 'number'
    ? { source: renderedSource, url: event.value, linkIndex: event.startIndex, position: { x: event.x + 8, y: event.y + 14 } }
    : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <markdown testId={testId} source={renderedSource} style={style} theme={theme}
        onMouseLeave={linkDisclosure ? () => setHoveredLink(null) : undefined}
        onLinkHover={linkDisclosure ? (event) => {
          const next = linkEvent(event)
          setHoveredLink((current) => current?.source === next?.source && current?.url === next?.url ? current : next)
        } : undefined}
        onLinkFocus={linkDisclosure ? (event) => setFocusedLink(linkEvent(event)) : undefined}
        onLinkBlur={linkDisclosure ? (event) => setFocusedLink((current) =>
          current?.source === renderedSource && current.linkIndex === event.startIndex ? null : current
        ) : undefined}
        onLinkClick={onLink ? (event: { value?: string; x?: number; y?: number }) => {
          if (!event.value) return
          const position = typeof event.x === 'number' && typeof event.y === 'number' ? { x: event.x, y: event.y } : undefined
          onLink(event.value, position)
        } : undefined} />
      {inlineLink && linkDisclosure ? <InlineLinkStatus link={inlineLink} disclosure={linkDisclosure} links={links} /> : null}
      {onLink && linkDisclosure ? <LinkDestinationList links={links} disclosure={linkDisclosure} onLink={onLink} testId={testId ? `${testId}-links` : undefined} /> : null}
    </div>
  )
})
