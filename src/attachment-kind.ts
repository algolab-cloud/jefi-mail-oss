// What an attachment card needs to know about a file from its name alone: which family it belongs
// to (for the tile's colour and label) and how to shorten it without losing the extension.

export type FileFamily =
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'image'
  | 'audio'
  | 'video'
  | 'calendar'
  | 'text'
  | 'code'
  | 'generic'

export type FileKind = {
  family: FileFamily
  /** Up to four capitals for the tile, e.g. "PDF", "XLSX"; empty when there's no extension. */
  label: string
  /** A short human name for the second line, e.g. "Spreadsheet". */
  typeName: string
}

const FAMILIES: Record<Exclude<FileFamily, 'generic'>, string[]> = {
  pdf: ['pdf'],
  document: ['doc', 'docx', 'odt', 'rtf', 'pages'],
  spreadsheet: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods', 'numbers'],
  presentation: ['ppt', 'pptx', 'odp', 'key'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'tif', 'tiff'],
  audio: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aiff'],
  video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'],
  calendar: ['ics', 'ical', 'vcs'],
  text: ['txt', 'md', 'log', 'eml', 'vcf'],
  code: ['json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'sh', 'yml', 'yaml', 'sql', 'swift', 'java', 'c', 'h', 'cpp'],
}

const TYPE_NAMES: Record<FileFamily, string> = {
  pdf: 'PDF',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  archive: 'Archive',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  calendar: 'Calendar',
  text: 'Text',
  code: 'Code',
  generic: 'File',
}

/** The extension without the dot, lower-cased; empty for "README" or ".env". */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function fileKind(name: string): FileKind {
  const ext = fileExtension(name)
  const family = (Object.keys(FAMILIES) as Array<keyof typeof FAMILIES>).find((f) => FAMILIES[f].includes(ext)) ?? 'generic'
  // Very long "extensions" are usually part of the name, not a type worth printing.
  const label = ext.length > 0 && ext.length <= 4 ? ext.toUpperCase() : ''
  return { family, label, typeName: TYPE_NAMES[family] }
}

/**
 * Shortens `name` to at most `max` characters by cutting from the middle, so the start and the
 * extension both stay readable: "Q3-board-presentation-final-v7-approved.pptx" → "Q3-board-present…oved.pptx".
 */
export function middleEllipsis(name: string, max: number): string {
  const chars = [...name]
  if (chars.length <= max) return name
  if (max <= 1) return '…'
  const ext = fileExtension(name)
  // Keep the extension plus a few characters before it, but never more than half the room.
  const tailWanted = ext && ext.length <= 8 ? ext.length + 1 + 4 : Math.floor((max - 1) / 3)
  const tail = Math.min(tailWanted, Math.floor((max - 1) / 2))
  const head = max - 1 - tail
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}
