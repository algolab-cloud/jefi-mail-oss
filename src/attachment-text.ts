import { statSync } from 'node:fs'

// ---------------------------------------------------------------------------
// The text of an attachment, for the assistant to read: plain text as is, PDFs through PDFKit and
// Office/RTF documents through macOS's own textutil. Nothing new is installed, and nothing is opened
// in another app. Images, archives and anything else have no text to give.
// ---------------------------------------------------------------------------

/** Enough for a contract or a long report; more would crowd out the rest of the chat. */
export const ATTACHMENT_TEXT_MAX = 40_000
/** Files bigger than this aren't read: extracting them would stall the chat. */
const MAX_BYTES = 30 * 1024 * 1024

const PLAIN = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'ics', 'vcf', 'log', 'yaml', 'yml', 'eml'])
const MARKUP = new Set(['html', 'htm'])
const TEXTUTIL = new Set(['doc', 'docx', 'rtf', 'rtfd', 'odt', 'wordml', 'webarchive'])

export type AttachmentKind = 'plain' | 'html' | 'pdf' | 'document' | null

export function attachmentKind(name: string): AttachmentKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (PLAIN.has(ext)) return 'plain'
  if (MARKUP.has(ext)) return 'html'
  if (ext === 'pdf') return 'pdf'
  if (TEXTUTIL.has(ext)) return 'document'
  return null
}

/** Visible text of an HTML file, roughly: scripts and styles out, tags out, entities for the common few. */
export function htmlText(html: string) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Last, so "&amp;lt;" reads as "&lt;" rather than "<".
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Squeezes runs of blank lines and cuts to the limit, saying so when it does. */
export function clipText(text: string, max = ATTACHMENT_TEXT_MAX) {
  const tidy = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return tidy.length > max ? `${tidy.slice(0, max)}\n\n[Cut off: the rest of the file (${tidy.length - max} more characters) isn't shown]` : tidy
}

const PDF_SCRIPT = `ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); if (!d || d.isNil()) return ""; const s = d.string; return s && !s.isNil() ? ObjC.unwrap(s) : "" }`

async function output(command: string[], signal?: AbortSignal) {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', signal })
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw new Error("Couldn't read the text in that file")
  return text
}

/** The text in the file at `path`, or an error that says why there's none. */
export async function attachmentText(path: string, name: string, signal?: AbortSignal): Promise<string> {
  const kind = attachmentKind(name)
  if (!kind) throw new Error(`${name} isn't a kind of file the assistant can read (PDFs, Word, RTF, HTML and text files are)`)
  if (statSync(path).size > MAX_BYTES) throw new Error(`${name} is too large to read here`)
  const text =
    kind === 'plain'
      ? await Bun.file(path).text()
      : kind === 'html'
        ? htmlText(await Bun.file(path).text())
        : kind === 'pdf'
          ? await output(['/usr/bin/osascript', '-l', 'JavaScript', '-e', PDF_SCRIPT, path], signal)
          : await output(['/usr/bin/textutil', '-convert', 'txt', '-stdout', path], signal)
  if (!text.trim()) throw new Error(kind === 'pdf' ? `${name} has no text to read (it may be a scan)` : `${name} has no text in it`)
  return clipText(text)
}
