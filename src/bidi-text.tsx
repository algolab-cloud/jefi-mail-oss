import { memo } from 'react'

// ---------------------------------------------------------------------------
// Wrapped text with Arabic or Hebrew in it. GPUIX breaks a wrapping line by where its glyphs sit
// on screen, not by reading order: a right-to-left title put its last words on the first line and
// its first words on the last, split mid-word. So such text flows here a word per element, and the
// renderer only lays out single words (and whole left-to-right phrases, which wrap correctly).
//
// GPUIX has no row-reverse, so a right-to-left paragraph is its words in reverse order in a row
// that wraps upward (wrap-reverse) and packs to the right: read from the top right, that is the
// text in order, with the short line at the top rather than the bottom. Text without right-to-left
// letters stays a plain <text>, exactly as before. Single-line text needs none of this; it
// truncates in reading order on its own (see the @gpuix/react patch).
// ---------------------------------------------------------------------------

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
const RTL_ALL = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/gu
const LETTER_ALL = /\p{L}/gu

type Dir = 'ltr' | 'rtl'

export const hasRtl = (text: string) => RTL.test(text)

const wordDir = (word: string): Dir | null => (RTL.test(word) ? 'rtl' : /\p{L}/u.test(word) ? 'ltr' : null)

/**
 * The paragraph's direction by which letters there are more of, so "Re: <Arabic>" reads as the
 * Arabic it mostly is, and its words in reading order: those of the paragraph's direction (and
 * neutral ones) on their own, and each stretch in the other direction as one group.
 */
export function bidiWords(text: string): { dir: Dir; items: Array<string | string[]> } {
  const rtl = text.match(RTL_ALL)?.length ?? 0
  const letters = text.match(LETTER_ALL)?.length ?? 0
  const dir: Dir = rtl * 2 >= letters ? 'rtl' : 'ltr'
  const words = text.split(/\s+/).filter(Boolean)
  const dirs = words.map(wordDir)
  const items: Array<string | string[]> = []
  for (let i = 0; i < words.length; ) {
    if (dirs[i] === null || dirs[i] === dir) {
      items.push(words[i++]!)
      continue
    }
    let last = i
    for (let k = i; k < words.length && dirs[k] !== dir; k++) if (dirs[k] !== null) last = k
    items.push(words.slice(i, last + 1))
    i = last + 1
  }
  return { dir, items }
}

type TextStyle = { fontSize: number; lineHeight: number; fontWeight?: number; color: string; fontFamily: string; textDecoration?: 'underline' | 'line-through' | 'none'; pointerEvents?: 'none' }

/**
 * `text`, wrapped in reading order. `maxLines` clamps text without right-to-left letters (with an
 * ellipsis, as before); right-to-left text shows every line, since clipping the flow would cut
 * its beginning. `box` is layout for the outer element (flexGrow, minWidth…).
 */
export const BidiText = memo(function BidiText({ text, style, maxLines, testId, box }: { text: string; style: TextStyle; maxLines?: number; testId?: string; box?: Record<string, unknown> }) {
  if (!hasRtl(text)) return <text testId={testId} style={{ ...box, ...style, ...(maxLines ? { lineClamp: maxLines, textOverflow: 'ellipsis' } : {}) }}>{text}</text>
  const { dir, items } = bidiWords(text)
  const gap = Math.round(style.fontSize * 0.28)
  const word = (w: string, key: number) => (
    <text key={key} style={{ ...style, whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0, textOverflow: 'ellipsis' }}>
      {w}
    </text>
  )
  if (dir === 'ltr') {
    // Left to right with right-to-left names or phrases in it: those read right to left as a group.
    return (
      <div testId={testId} style={{ ...box, display: 'flex', flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap: 0 }}>
        {items.flatMap((item, i) => (typeof item === 'string' ? [word(item, i)] : [...item].reverse().map((w, j) => word(w, i * 1000 + j))))}
      </div>
    )
  }
  // Right to left: words reversed in a row wrapping upward, packed right. A left-to-right phrase
  // inside is one element, which wraps correctly by itself.
  return (
    <div testId={testId} style={{ ...box, display: 'flex', flexDirection: 'row', flexWrap: 'wrap-reverse', justifyContent: 'flex-end', columnGap: gap, rowGap: 0 }}>
      {items
        .map((item, i) =>
          typeof item === 'string' ? (
            word(item, i)
          ) : (
            <text key={i} style={{ ...style, flexShrink: 1, minWidth: 0 }}>
              {item.join(' ')}
            </text>
          ),
        )
        .reverse()}
    </div>
  )
})
