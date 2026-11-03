// ---------------------------------------------------------------------------
// Shaping a message body for the reader: quoted history split off, long text cut into pieces.
// ---------------------------------------------------------------------------

/** About a screenful of text per piece: small enough that the list only lays out what's near the viewport. */
const CHUNK_CHARS = 2500

/**
 * Splits markdown at blank lines into pieces of about CHUNK_CHARS, never inside a fenced code block.
 * A long newsletter drawn as one element costs a full layout on every scroll frame; pieces in a
 * virtual list cost only the ones on screen.
 */
export function chunkMarkdown(source: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let length = 0
  let fenced = false
  for (const block of source.split(/\n{2,}/)) {
    current.push(block)
    length += block.length
    // An odd number of ``` fences toggles whether we're inside a code block.
    if (((block.match(/^\s*(```|~~~)/gm) ?? []).length % 2) === 1) fenced = !fenced
    if (!fenced && length >= size) {
      chunks.push(current.join('\n\n'))
      current = []
      length = 0
    }
  }
  if (current.length) chunks.push(current.join('\n\n'))
  return chunks
}

const QUOTE_LINE = /^\s*>/
/** "On Mon, 3 Mar 2026, Ada <ada@x.com> wrote:" and friends, in the languages mail clients commonly use. */
const ATTRIBUTION = /(wrote|writes|schrieb|a écrit|escribió|scrisse|schreef|написал\S*)\s*:\s*$/i

/**
 * Splits a reply into what's new and the quoted history trailing it: the run of ">" lines (and blank
 * lines) at the end, plus the "On … wrote:" line in front of it. Quotes in the middle of a message,
 * with new text after them, stay where they are.
 */
export function splitQuoted(markdown: string): { body: string; quoted: string | null } {
  const lines = markdown.split('\n')
  let start = lines.length
  while (start > 0 && (QUOTE_LINE.test(lines[start - 1]!) || !lines[start - 1]!.trim())) start--
  if (!lines.slice(start).some((l) => QUOTE_LINE.test(l))) return { body: markdown, quoted: null }
  let attribution = start
  while (attribution > 0 && !lines[attribution - 1]!.trim()) attribution--
  if (attribution > 0 && ATTRIBUTION.test(lines[attribution - 1]!)) start = attribution - 1
  const body = lines.slice(0, start).join('\n').trim()
  // A message that's nothing but a quote (a bare forward) shows it.
  return body ? { body, quoted: lines.slice(start).join('\n').trim() } : { body: markdown, quoted: null }
}
