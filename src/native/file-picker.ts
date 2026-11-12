import { describeFile } from '../attachment-files'
import { quarantine } from '../engine/attachment-safety'
import type { Attachment } from '../data'
import { available, cls, fromNSString, msg, msgBool, msgIndex, msgInt, nsString } from './objc'
import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

// ---------------------------------------------------------------------------
// The system's own open panel, for picking files to attach. NSOpenPanel driven over the
// Objective-C bridge: no native code to ship, and people get the sheet they know (favourites,
// iCloud Drive, tags). Cancelling returns no files; off macOS there is no panel, so the caller
// gets an empty list and nothing is attached.
// ---------------------------------------------------------------------------

const NS_MODAL_RESPONSE_OK = 1

/**
 * One file, for pointing Jefi at something on disk (the Codex CLI). Hidden files shown, because
 * command-line tools live in places like ~/.local/bin. Empty when cancelled or off macOS.
 */
export function pickFile(prompt: string, message: string): string {
  if (!available) return ''
  const panel = msg(cls('NSOpenPanel'), 'openPanel')
  msgBool(panel, 'setAllowsMultipleSelection:', false)
  msgBool(panel, 'setCanChooseFiles:', true)
  msgBool(panel, 'setCanChooseDirectories:', false)
  msgBool(panel, 'setResolvesAliases:', true)
  msgBool(panel, 'setShowsHiddenFiles:', true)
  msgBool(panel, 'setTreatsFilePackagesAsDirectories:', true)
  msg(panel, 'setPrompt:', nsString(prompt))
  msg(panel, 'setMessage:', nsString(message))
  if (msgInt(panel, 'runModal') !== NS_MODAL_RESPONSE_OK) return ''
  const urls = msg(panel, 'URLs')
  return msgInt(urls, 'count') > 0 ? fromNSString(msg(msgIndex(urls, 'objectAtIndex:', 0), 'path')) : ''
}

/** Opens the panel and returns what was chosen, ready to attach. Blocks while the panel is up. */
export function pickAttachments(prompt = 'Attach'): Attachment[] {
  if (!available) return []
  const panel = msg(cls('NSOpenPanel'), 'openPanel')
  msgBool(panel, 'setAllowsMultipleSelection:', true)
  msgBool(panel, 'setCanChooseFiles:', true)
  msgBool(panel, 'setCanChooseDirectories:', false)
  msgBool(panel, 'setResolvesAliases:', true)
  msg(panel, 'setPrompt:', nsString(prompt))
  msg(panel, 'setMessage:', nsString('Choose files to attach to this message'))
  if (msgInt(panel, 'runModal') !== NS_MODAL_RESPONSE_OK) return []

  const urls = msg(panel, 'URLs')
  const picked: Attachment[] = []
  for (let index = 0; index < msgInt(urls, 'count'); index++) {
    const path = fromNSString(msg(msgIndex(urls, 'objectAtIndex:', index), 'path'))
    if (path) picked.push(describeFile(path))
  }
  return picked
}

export const safeAttachmentSaveName = (name: string, index = 0) => {
  const leaf = name.split(/[/\\]/).pop()!.replace(/[\u0000-\u001f\u007f:]/g, '_').replace(/^\.+/, '').trim()
  const fallback = `attachment-${index + 1}`
  if (!leaf) return fallback
  let safe = ''
  for (const character of leaf) {
    if (Buffer.byteLength(safe + character) > 180) break
    safe += character
  }
  return safe || fallback
}

/** A system Save panel for one attachment. Empty means the person cancelled. */
export function pickAttachmentDestination(name: string): string {
  if (!available) return ''
  const panel = msg(cls('NSSavePanel'), 'savePanel')
  msgBool(panel, 'setCanCreateDirectories:', true)
  msgBool(panel, 'setExtensionHidden:', false)
  msg(panel, 'setNameFieldStringValue:', nsString(safeAttachmentSaveName(name)))
  msg(panel, 'setPrompt:', nsString('Save'))
  msg(panel, 'setMessage:', nsString('Choose where to save this attachment'))
  if (msgInt(panel, 'runModal') !== NS_MODAL_RESPONSE_OK) return ''
  return fromNSString(msg(msg(panel, 'URL'), 'path'))
}

/** A system Save panel for the exact RFC 822 message source. */
export function pickOriginalDestination(subject: string): string {
  if (!available) return ''
  const panel = msg(cls('NSSavePanel'), 'savePanel')
  msgBool(panel, 'setCanCreateDirectories:', true)
  msgBool(panel, 'setExtensionHidden:', false)
  const base = safeAttachmentSaveName(subject || 'message').replace(/\.eml$/i, '')
  msg(panel, 'setNameFieldStringValue:', nsString(`${base}.eml`))
  msg(panel, 'setPrompt:', nsString('Export'))
  msg(panel, 'setMessage:', nsString('Export the exact original message source'))
  if (msgInt(panel, 'runModal') !== NS_MODAL_RESPONSE_OK) return ''
  return fromNSString(msg(msg(panel, 'URL'), 'path'))
}

export const saveOriginalTo = (source: string, destination: string) => copyFile(source, destination)

/** A system directory chooser for Save All. Empty means the person cancelled. */
export function pickAttachmentDirectory(): string {
  if (!available) return ''
  const panel = msg(cls('NSOpenPanel'), 'openPanel')
  msgBool(panel, 'setAllowsMultipleSelection:', false)
  msgBool(panel, 'setCanChooseFiles:', false)
  msgBool(panel, 'setCanChooseDirectories:', true)
  msgBool(panel, 'setCanCreateDirectories:', true)
  msgBool(panel, 'setResolvesAliases:', true)
  msg(panel, 'setPrompt:', nsString('Save All'))
  msg(panel, 'setMessage:', nsString('Choose a folder for these attachments'))
  if (msgInt(panel, 'runModal') !== NS_MODAL_RESPONSE_OK) return ''
  const urls = msg(panel, 'URLs')
  return msgInt(urls, 'count') > 0 ? fromNSString(msg(msgIndex(urls, 'objectAtIndex:', 0), 'path')) : ''
}

/**
 * The Save panel already confirmed replacement, so this copies exactly to its chosen path. A copy
 * doesn't carry the cached file's quarantine mark, so the saved file gets its own.
 */
export async function saveAttachmentTo(source: string, destination: string) {
  await copyFile(source, destination)
  await quarantine(destination)
}

/** Save All never overwrites an existing file; duplicate names gain a numeric suffix. */
export async function saveAttachmentInDirectory(source: string, directory: string, name: string): Promise<string> {
  const file = safeAttachmentSaveName(name)
  const extension = extname(file)
  const stem = extension ? file.slice(0, -extension.length) : file
  for (let copy = 0; ; copy++) {
    const destination = join(directory, copy ? `${stem} (${copy + 1})${extension}` : file)
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      await quarantine(destination)
      return destination
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
  }
}
