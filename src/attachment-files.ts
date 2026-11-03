import { closeSync, openSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Attachment } from './data'

// ---------------------------------------------------------------------------
// Attached files as they sit on this Mac: their size for the composer, whether they can still be
// read, and how to say so. Both sides need this — the composer before the send, the engine at send
// time — so it stays free of anything native (see src/native/file-picker.ts for the panel).
// ---------------------------------------------------------------------------

/** Most providers refuse a message larger than this, so the composer stops before the send does. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_LABEL = '25 MB'

/**
 * Why a file can't be attached or sent. Jefi isn't sandboxed, so anything under Desktop, Documents,
 * Downloads or iCloud Drive is behind macOS privacy: the first read raises the system prompt and a
 * refusal comes back as EPERM/EACCES — the file is right where it was, and saying it moved would
 * send people looking in the wrong place.
 */
export type FileProblem = 'missing' | 'denied'

/** Opening the file is the only honest test: privacy can allow `stat` and still refuse the read. */
export function readProblem(path: string): FileProblem | null {
  try {
    closeSync(openSync(path, 'r'))
    return null
  } catch (err) {
    const code = (err as { code?: string }).code
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing'
  }
}

export const fileProblemMessage = (name: string, problem: FileProblem) =>
  problem === 'denied'
    ? `Jefi isn't allowed to read ${name}. Allow it in System Settings → Privacy & Security → Files and Folders, then send again.`
    : `Couldn't read ${name} — it may have been moved or deleted`

/** An attachment for a file on disk: the name and size shown in the composer, plus the path sent from. */
export function describeFile(path: string): Attachment {
  return { name: basename(path), size: formatSize(fileBytes(path)), path }
}

/** Bytes on disk, or 0 for a file that has since moved (the send reports that, not the composer). */
export const fileBytes = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export const totalAttachmentBytes = (attachments: Attachment[]) =>
  attachments.reduce((total, file) => total + (file.path ? fileBytes(file.path) : 0), 0)

export const overAttachmentLimit = (attachments: Attachment[]) => totalAttachmentBytes(attachments) > MAX_ATTACHMENT_BYTES

/** Same wording as the reader's attachment list (src/engine/threads.ts). */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
