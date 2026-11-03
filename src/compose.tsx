import { countRender } from './render-counts'
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, TextInput, useToggle } from './ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { FONT, READ_PAD_LEFT, READ_PAD_RIGHT, TOPBAR_HEIGHT, useSettings } from './theme'
import { Icon, IconButton, type IconName } from './icons'
import { AttachmentCard, Divider, Face } from './primitives'
import type { Attachment, Contact, DraftFields } from './data'
import { contacts, searchContacts } from './contacts'
import { MailMarkdown, findContact, mentionedContacts } from './markdown'
import { useMailActions, useMailSelector } from './store'
import { useAi } from './use-ai'
import { aiErrorMessage, rewriteEmail, writeEmail, type Rewrite } from './ai'
import { Spinner } from './toast'
import { MAX_ATTACHMENT_LABEL, fileProblemMessage, overAttachmentLimit, readProblem } from './attachment-files'
import { pickAttachments } from './native/file-picker'
import { readEditorSnapshot, replaceEditorSelection, type EditorSnapshot } from './native/editor-selection'
import { composeFormatEdit, shortcutFormat, type ComposeFormat } from './compose-format'
import { completedRecipients, isEmailAddress, parseRecipients } from './recipients'
import { useFollowEnd } from './notes/follow-end'

export type ComposedMail = DraftFields

// ---------------------------------------------------------------------------
// Recipient tag input with autocomplete
// ---------------------------------------------------------------------------

/** A typed or pasted name becomes its contact's address when there is one. */
const contactAddress = (name: string) => findContact(name)?.email

/** The addresses still sitting as text in a recipient field: they go out and into drafts too. */
const pendingRecipients = (text: string) => (text.trim() ? parseRecipients(text, contactAddress) : [])

/** The part of a body its writer typed: no quoted lines, nothing of a forwarded message below its rule. */
const writtenPart = (body: string) => {
  const forwarded = body.search(/^---[ \t]*\n+\*\*Forwarded message\*\*/m)
  return (forwarded >= 0 ? body.slice(0, forwarded) : body)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
}

/** The @mention being typed at the end of the body (what follows the @), or null. */
export function mentionAtEnd(body: string): string | null {
  // Only the last @ can start it: the name can't contain another. Looking from the end keeps this
  // cheap on a long body, where a regex anchored at the end would try every position.
  const at = body.lastIndexOf('@')
  if (at < 0 || (at > 0 && !/\s/.test(body[at - 1]!))) return null
  const name = body.slice(at + 1)
  return /^[a-zA-Z0-9._-]*$/.test(name) ? name : null
}

const AUTOSAVE_MS = 1500

const withoutDuplicates = (addresses: string[]) => {
  const seen = new Set<string>()
  return addresses.filter((address) => {
    const key = address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function RecipientTag({ tag, onRemove }: { tag: string; onRemove: () => void }) {
  const { C } = useSettings()
  const contact = findContact(tag)
  const valid = isEmailAddress(tag)

  return (
    <div
      style={{
        height: 24,
        borderRadius: 12,
        backgroundColor: valid ? C.chip : C.overlay,
        borderWidth: valid ? 0 : 1,
        borderColor: C.accent,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 3,
        paddingRight: 4,
        gap: 5,
        flexShrink: 0,
      }}
    >
      {contact ? (
        <Face {...contact.face} size={18} />
      ) : (
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: C.face,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <text style={{ fontSize: 10, fontWeight: 600, color: C.secondary, fontFamily: FONT }}>
            {tag.slice(0, 1).toUpperCase()}
          </text>
        </div>
      )}
      <text style={{ fontSize: 12.5, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>
        {contact ? contact.name : tag}
      </text>
      <div
        testId={`remove-tag-${tag}`}
        onClick={onRemove}
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          hover: { backgroundColor: C.overlayStrong },
        }}
      >
        <Icon name="x" size={11} color={C.muted} />
      </div>
    </div>
  )
}

/** Room for the header fields' labels (To, Cc, From), so their values line up. */
const FIELD_LABEL_WIDTH = 36

function RecipientField({
  label,
  tags,
  onTagsChange,
  input,
  onInputChange,
  testId,
  trailing,
}: {
  label: string
  tags: string[]
  onTagsChange: (tags: string[]) => void
  /** Text typed but not yet a tag; held by the composer so Send and drafts include it. */
  input: string
  onInputChange: (text: string) => void
  testId: string
  trailing?: ReactNode
}) {
  const { C } = useSettings()
  const setInput = onInputChange
  // GPUIX inputs keep their native text when the controlled value is set to a value
  // React already holds (e.g. '' -> ''), so committing a token remounts the field.
  const [inputKey, setInputKey] = useState(0)
  const [open, setOpen] = useState(false)
  // The suggestion ↑/↓ point at; Enter or Tab takes it.
  const [highlight, setHighlight] = useState(0)

  const commit = (raw: string, rest = '') => {
    onTagsChange(withoutDuplicates([...tags, ...parseRecipients(raw, contactAddress)]))
    setInput(rest)
    setInputKey((k) => k + 1)
  }

  const handleChange = (val: string) => {
    const completed = completedRecipients(val)
    if (completed) commit(completed.done, completed.rest)
    else {
      setInput(val)
      setOpen(true)
    }
    setHighlight(0)
  }

  // Enter (onSubmit on a GPUIX input) or Tab: a complete address as typed, else the top suggestion.
  const commitTyped = () => {
    if (!input.trim()) return
    const picked = suggestions[Math.min(highlight, suggestions.length - 1)]
    commit(isEmailAddress(input.trim()) && highlight === 0 ? input : (picked?.email ?? input))
  }

  const q = input.trim().toLowerCase()
  const suggestions = searchContacts(q, tags)

  return (
    <div style={{ flexShrink: 0 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingLeft: READ_PAD_LEFT,
          paddingRight: READ_PAD_RIGHT - 8,
          paddingTop: 5,
          paddingBottom: 5,
          gap: 8,
        }}
      >
        <text style={{ width: FIELD_LABEL_WIDTH, height: 28, lineHeight: 28, fontSize: 13, color: C.muted, fontFamily: FONT, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {label}
        </text>
        <div
          style={{
            flexGrow: 1,
            flexBasis: 0,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            minHeight: 28,
          }}
        >
          {tags.map((tag, idx) => (
            <RecipientTag key={tag} tag={tag} onRemove={() => onTagsChange(tags.filter((_, i) => i !== idx))} />
          ))}
          <input
            key={inputKey}
            testId={testId}
            autoFocus={inputKey > 0}
            value={input}
            onChange={(event) => handleChange(event.value ?? '')}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onSubmit={commitTyped}
            onKeyDown={(event) => {
              if ((event.key === 'enter' || event.key === 'tab') && input.trim()) {
                commitTyped()
              } else if (event.key === 'down' && suggestions.length) {
                setOpen(true)
                setHighlight((i) => Math.min(i + 1, suggestions.length - 1))
              } else if (event.key === 'up' && suggestions.length) {
                setHighlight((i) => Math.max(i - 1, 0))
              } else if (event.key === 'escape') {
                setOpen(false)
              } else if (event.key === 'backspace' && !input && tags.length > 0) {
                onTagsChange(tags.slice(0, -1))
              }
            }}
            style={{ flexGrow: 1, flexBasis: 0, minWidth: 120, height: 28, fontSize: 13.5, fontFamily: FONT, color: C.text }}
          />
          {open && suggestions.length > 0 ? (
            <anchored side="bottom" align="start" gap={6} fit="snap" deferred priority={1} occlude style={{ backgroundColor: C.raised, borderRadius: 12 }}>
              <div
                style={{
                  width: 320,
                  borderRadius: 12,
                  backgroundColor: C.raised,
                  borderWidth: 1,
                  borderColor: C.overlayStrong,
                  boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 16, spreadRadius: 0, color: '#00000044' },
                  padding: 4,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
              {suggestions.map((contact, index) => (
                <div
                  key={contact.email}
                  testId={`suggest-${contact.email}`}
                  onClick={() => commit(contact.email)}
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    height: 40,
                    paddingLeft: 8,
                    paddingRight: 8,
                    borderRadius: 6,
                    gap: 10,
                    cursor: 'pointer',
                    backgroundColor: index === Math.min(highlight, suggestions.length - 1) ? C.overlay : undefined,
                    hover: { backgroundColor: C.overlayStrong },
                  }}
                >
                  <Face {...contact.face} size={26} />
                  <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
                    <text style={{ fontSize: 13, fontWeight: 500, color: C.text, fontFamily: FONT }}>{contact.name}</text>
                    <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{contact.email}</text>
                  </div>
                  {contact.role ? (
                    <text style={{ fontSize: 11, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{contact.role}</text>
                  ) : null}
                </div>
              ))}
              </div>
            </anchored>
          ) : null}
        </div>
        {trailing}
      </div>

    </div>
  )
}

/** Who a message is sent as, with several accounts: the account it goes out through (and whose Drafts keep it). */
function FromField({ accounts, value, onChange }: { accounts: Array<{ id: string; name: string; email: string; label?: string }>; value: string; onChange: (id: string) => void }) {
  const { C } = useSettings()
  const menu = useToggle()
  const current = accounts.find((a) => a.id === value) ?? accounts[0]!
  return (
    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: READ_PAD_LEFT, paddingRight: READ_PAD_RIGHT - 8, paddingTop: 5, paddingBottom: 5, gap: 8 }}>
      <text style={{ width: FIELD_LABEL_WIDTH, height: 28, lineHeight: 28, fontSize: 13, color: C.muted, fontFamily: FONT, flexShrink: 0, whiteSpace: 'nowrap' }}>From</text>
      <div style={{ flexShrink: 1, minWidth: 0 }}>
        <div
          testId="compose-from"
          onClick={menu.toggle}
          style={{ height: 28, paddingLeft: 8, paddingRight: 6, gap: 6, borderRadius: 6, display: 'flex', flexDirection: 'row', alignItems: 'center', cursor: 'pointer', backgroundColor: menu.open ? C.overlay : undefined, hover: { backgroundColor: C.overlay } }}
        >
          <text style={{ fontSize: 13.5, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
            {current.name ? `${current.name} <${current.email}>` : current.email}
          </text>
          {current.label?.trim() ? <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{`· ${current.label.trim()}`}</text> : null}
          <div style={{ pointerEvents: 'none', display: 'flex' }}>
            <Icon name="chevronDown" size={13} color={C.muted} />
          </div>
        </div>
        <Menu open={menu.open} onClose={menu.close} width={320} testId="compose-from-menu">
          <MenuLabel>Send from</MenuLabel>
          {accounts.map((a) => (
            <MenuItem
              key={a.id}
              label={a.email}
              hint={a.label?.trim() || a.name}
              checked={a.id === current.id}
              testId={`compose-from-${a.id}`}
              onSelect={() => {
                menu.close()
                onChange(a.id)
              }}
            />
          ))}
        </Menu>
      </div>
    </div>
  )
}

function CcBccToggle({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        paddingLeft: 8,
        paddingRight: 8,
        height: 28,
        borderRadius: 5,
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        hover: { backgroundColor: C.overlay },
      }}
    >
      <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{label}</text>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ComposePane
// ---------------------------------------------------------------------------

const BODY_PAD_TOP = 14
const BODY_LINE_HEIGHT = 21
// Rough advance width of 14px Geist; only used to place the mention popup near the caret.
const AVG_CHAR_WIDTH = 7.2

const TEMPLATE_BODY =
  'Hi team,\n\n' +
  'Here is the status summary for this week:\n\n' +
  '- [x] Initial design review completed\n' +
  '- [ ] Implement components\n' +
  '- [ ] QA testing\n\n' +
  '> Next milestone is planned for Friday.\n\n' +
  'Best,\nMara'

function ToolbarSeparator() {
  const { C } = useSettings()
  return <div style={{ width: 1, height: 16, backgroundColor: C.divider, marginLeft: 4, marginRight: 4, flexShrink: 0 }} />
}

function ToolbarTextButton({
  label,
  icon,
  onClick,
  testId,
  active,
  tone,
}: {
  label: string
  icon?: IconName
  onClick: () => void
  testId: string
  active?: boolean
  tone?: string
}) {
  const { C } = useSettings()
  const color = tone ?? C.secondary
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        height: 26,
        paddingLeft: 7,
        paddingRight: 8,
        borderRadius: 5,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
        flexShrink: 0,
        backgroundColor: active ? C.overlayStrong : undefined,
        hover: { backgroundColor: C.overlay },
      }}
    >
      {icon ? <Icon name={icon} size={13} color={color} /> : null}
      <text style={{ fontSize: 12.5, fontWeight: 500, color, fontFamily: FONT }}>{label}</text>
    </div>
  )
}

export function ComposePane({
  initial,
  title = 'New message',
  onSend,
  onSaveDraft,
  onAutosave,
  onDiscard,
  onClose,
}: {
  initial?: Partial<ComposedMail>
  title?: string
  /** `sendAt` (epoch ms) schedules the message instead of sending it now. */
  onSend: (mail: ComposedMail, sendAt?: number) => void
  onSaveDraft: (mail: ComposedMail) => void
  /** Keeps the draft saved while writing and on close, so nothing is lost to × or quitting. */
  onAutosave?: (mail: ComposedMail) => void
  /** Gets what was discarded, so it can be offered back. */
  onDiscard: (mail: ComposedMail) => void
  onClose: () => void
}) {
  const { C } = useSettings()
  countRender('ComposePane')
  // Selected, not the whole store: every publish (sync, a read flag) would otherwise redraw the composer.
  const active = useMailSelector((store) => store.account)
  const accounts = useMailSelector((store) => store.accounts)
  const { accountOf, notify } = useMailActions()
  const renderer = useGpuixRequired()
  // From: the draft's own choice, else a reply's conversation's account, else the active one.
  const [fromId, setFromId] = useState(() => {
    const wanted = initial?.from ?? (initial?.replying ? accountOf(initial.replying.threadId).id : active.id)
    return accounts.some((a) => a.id === wanted) ? wanted : active.id
  })
  const account = accounts.find((a) => a.id === fromId) ?? active

  const [toTags, setToTags] = useState<string[]>(initial?.to ?? [])
  const [ccTags, setCcTags] = useState<string[]>(initial?.cc ?? [])
  const [bccTags, setBccTags] = useState<string[]>(initial?.bcc ?? [])
  const [toText, setToText] = useState('')
  const [ccText, setCcText] = useState('')
  const [bccText, setBccText] = useState('')
  const [showCc, setShowCc] = useState(Boolean(initial?.cc?.length))
  const [showBcc, setShowBcc] = useState(Boolean(initial?.bcc?.length))

  const [subject, setSubject] = useState(initial?.subject ?? '')
  // Typing doesn't re-render the composer: each render that reached the screen cost a whole extra
  // frame per keystroke. The native field keeps the text; `bodyText` holds the latest of it for
  // whatever reads it (saving, sending, preview, AI), and `bodyState` changes only with edits made
  // from outside the field, which remount it.
  const [bodyState, setBodyState] = useState(initial?.body ?? '')
  const bodyText = useRef(bodyState)
  const setBody = (next: string | ((prev: string) => string)) => {
    const value = typeof next === 'function' ? next(bodyText.current) : next
    bodyText.current = value
    setBodyState(value)
  }
  const body = bodyText.current
  const bodyRef = useRef<PublicInstance>(null)
  // External edits (AI, template and fallbacks) replace the body wholesale, so remount the native field.
  const [bodyKey, setBodyKey] = useState(0)
  // The native field keeps its own text and follows `value` only as it mounts (every outside edit
  // remounts it through bodyKey). So it gets the text it mounted with, not the latest: re-sending the
  // whole body on each keystroke serialized and parsed it again every time (~10 ms at 100 KB).
  const mounted = useRef({ key: bodyKey, body })
  if (mounted.current.key !== bodyKey) mounted.current = { key: bodyKey, body }

  // Write or rewrite the body with AI. The result streams into the field; Undo puts the old text back.
  const ai = useAi()
  const aiMenu = useToggle()
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const aiAbort = useRef<AbortController | null>(null)
  const runAi = (job: { write: string } | { rewrite: Rewrite }) => {
    if (!ai.connection || aiBusy) return
    aiMenu.close()
    const before = { body: bodyText.current, subject }
    const abort = (aiAbort.current = new AbortController())
    let text = ''
    let last = 0
    const show = (value: string, force = false) => {
      // The field only follows its value when remounted, so refresh a few times a second while streaming.
      if (!force && Date.now() - last < 120) return
      last = Date.now()
      setBody(value)
      setBodyKey((k) => k + 1)
    }
    const restore = () => {
      setSubject(before.subject)
      show(before.body, true)
    }
    const stream = { signal: abort.signal, onText: (delta: string) => show((text += delta)) }
    setAiBusy(true)
    const me = account
    const request = 'write' in job ? writeEmail(ai.connection, me, { to: toTags, subject, instruction: job.write }, stream) : rewriteEmail(ai.connection, bodyText.current, job.rewrite, stream)
    request
      .then((final) => {
        let result = final.trim()
        const heading = result.match(/^Subject:\s*(.+)\n+/i)
        if (heading) {
          if (!before.subject.trim()) setSubject(heading[1]!.trim())
          result = result.slice(heading[0].length)
        }
        show(result, true)
        setAiPrompt('')
        notify('write' in job ? 'Email written' : 'Draft rewritten', before.body.trim() ? restore : undefined)
      })
      .catch((error) => {
        restore()
        if (!abort.signal.aborted) notify(`Couldn't write it: ${aiErrorMessage(error)}`)
      })
      .finally(() => setAiBusy(false))
  }

  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments ?? [])
  const [mode, setMode] = useState<'write' | 'preview'>('write')

  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ icon: IconName; message: string } | null>(null)

  const flash = (message: string, icon: IconName = 'alertCircle') => {
    setNotice({ icon, message })
    setTimeout(() => setNotice((current) => (current?.message === message ? null : current)), 2500)
  }

  // The system open panel, then the files it returned: each has to be readable right now (which is
  // also when macOS asks about a protected folder), the same file twice adds nothing, and the whole
  // set has to stay under what providers accept.
  const attach = () => {
    const picked = pickAttachments()
    if (picked.length === 0) return
    const next = [...attachments]
    for (const file of picked) {
      const problem = file.path ? readProblem(file.path) : 'missing'
      if (problem) {
        flash(fileProblemMessage(file.name, problem), 'paperclip')
        continue
      }
      if (!next.some((a) => a.path === file.path)) next.push(file)
    }
    if (overAttachmentLimit(next)) {
      flash(`Attachments have to stay under ${MAX_ATTACHMENT_LABEL} in total`, 'paperclip')
      return
    }
    setAttachments(next)
  }

  const replaceBody = (update: (prev: string) => string) => {
    setBody((prev) => update(prev))
    setBodyKey((k) => k + 1)
    setMode('write')
  }

  const formatBody = (format: ComposeFormat) => {
    setMode('write')
    const editor = bodyRef.current
    const snapshot = editor && renderer.getFocusedElementId?.() === editor.id ? readEditorSnapshot() : null
    const applySnapshot = (captured: EditorSnapshot) => {
      const selection = { location: captured.location, length: captured.length }
      const edit = composeFormatEdit(captured.value, selection, format)
      return Boolean(edit && replaceEditorSelection(captured, edit))
    }
    // AppKit applies this through GPUI's NSTextInputClient. That keeps the native caret, undo stack,
    // IME state and controlled onChange event together instead of remounting or guessing offsets.
    if (snapshot) {
      if (applySnapshot(snapshot)) return true
      flash('The selection changed — try formatting again')
      return false
    }

    // The native bridge is macOS-only. Keep formatting usable in development and on other platforms,
    // while never treating a global/static-text selection as the editor's range.
    if (format.kind === 'inline') {
      replaceBody((prev) => {
        const sep = !prev || prev.endsWith('\n') || prev.endsWith(' ') ? '' : ' '
        return `${prev}${sep}${format.before}${format.placeholder}${format.after}`
      })
    } else {
      replaceBody((prev) => {
        const sep = !prev ? '' : prev.endsWith('\n') ? '' : '\n'
        return `${prev}${sep}${format.prefix}${format.placeholder}`
      })
    }
    return true
  }

  const formatKeyboardSelection = (format: ComposeFormat) => {
    const editor = bodyRef.current
    const snapshot = editor && renderer.getFocusedElementId?.() === editor.id ? readEditorSnapshot() : null
    if (!editor || !snapshot) return
    const selection = { location: snapshot.location, length: snapshot.length }
    const edit = composeFormatEdit(snapshot.value, selection, format)
    if (!edit) return
    // Capture the exact range during keyDown, but apply after GPUI finishes the full key event.
    // The focused host id plus native responder/range checks reject any intervening focus or caret move.
    setTimeout(() => {
      if (bodyRef.current?.id !== editor.id || renderer.getFocusedElementId?.() !== editor.id) {
        flash('The editor focus changed — try formatting again')
        return
      }
      if (!replaceEditorSelection(snapshot, edit)) flash('The selection changed — try formatting again')
    }, 0)
  }

  // The page around the body scrolls, not the body field (see notes/follow-end.ts).
  const { page: bodyPage, follow: followBody } = useFollowEnd(bodyRef)
  const handleBodyChange = (val: string) => {
    followBody(bodyText.current, val)
    bodyText.current = val
    // Each of these re-renders only when its value changes (typing an @mention, a hand-typed
    // address making Send available).
    // (Compared here first: a setState with the same value can still re-render once.)
    const mention = mentionAtEnd(val)
    if (mention !== mentionQuery) setMentionQuery(mention)
    if (allRecipients.length === 0) {
      const typed = typedMentions().length > 0
      if (typed !== typedMention) setTypedMention(typed)
    }
    if (bodySave.current) clearTimeout(bodySave.current)
    bodySave.current = setTimeout(() => autosaveRef.current(), AUTOSAVE_MS)
  }

  // Tags plus whatever is still typed in each field: an address typed without Enter or a comma is
  // meant to be sent to, not silently dropped.
  const toAll = withoutDuplicates([...toTags, ...pendingRecipients(toText)])
  const ccAll = withoutDuplicates([...ccTags, ...pendingRecipients(ccText)])
  const bccAll = withoutDuplicates([...bccTags, ...pendingRecipients(bccText)])
  const allRecipients = [...toAll, ...ccAll, ...bccAll]

  const addToTo = (contacts: Contact[]) => {
    const fresh = contacts.filter((c) => !allRecipients.includes(c.email))
    if (fresh.length === 0) return
    setToTags((prev) => [...prev, ...fresh.map((c) => c.email)])
    flash(`Added ${fresh.map((c) => c.name).join(', ')} to To`, 'atSign')
  }

  const insertMention = (contact: Contact) => {
    replaceBody((prev) => prev.replace(/@([a-zA-Z0-9._-]*)$/, `@${contact.name} `))
    setMentionQuery(null)
    addToTo([contact])
  }

  // Only what was written here: a quoted reply or a forwarded message can mention people too, and
  // those must not quietly become recipients. Read when needed, as the body changes without renders.
  const typedMentions = () =>
    mentionedContacts(writtenPart(bodyText.current))
      .map((c) => c.email)
      .filter((email) => email !== account.email && !allRecipients.includes(email))
  // Only for a render when a hand-typed mention comes or goes (it enables Send); hasRecipients below
  // works the answer out fresh.
  const [typedMention, setTypedMention] = useState(() => typedMentions().length > 0)

  const lastLine = mentionQuery !== null ? body.slice(body.lastIndexOf('\n') + 1) : ''
  const mentionCaret = { line: mentionQuery !== null ? body.split('\n').length - 1 : 0, column: Math.max(0, lastLine.lastIndexOf('@')) }

  const mentionSuggestions: Contact[] = mentionQuery !== null ? searchContacts(mentionQuery, [account.email]) : []

  const compile = (): ComposedMail => {
    // Mentions typed by hand (not picked from the popup) still address the person.
    return {
      to: withoutDuplicates([...toAll, ...typedMentions()]),
      cc: ccAll,
      bcc: bccAll,
      subject,
      body: bodyText.current,
      attachments,
      ...(initial?.replying ? { replying: initial.replying } : {}),
      from: account.id,
    }
  }

  // Autosave: a moment after typing stops, and on close. Unchanged content (like a draft just
  // reopened) isn't written again.
  const snapshot = () => JSON.stringify(compile())
  // Lazily: useRef(snapshot()) would serialize the whole message on every keystroke just to ignore it.
  const saved = useRef<string | null>(null)
  if (saved.current === null) saved.current = snapshot()
  const hasContent = () => allRecipients.length > 0 || subject.trim() !== '' || bodyText.current.trim() !== '' || attachments.length > 0
  const autosave = () => {
    if (!onAutosave || !hasContent() || snapshot() === saved.current) return
    saved.current = snapshot()
    onAutosave(compile())
  }
  const autosaveRef = useRef(autosave)
  autosaveRef.current = autosave
  useEffect(() => {
    const handle = setTimeout(() => autosaveRef.current(), AUTOSAVE_MS)
    return () => clearTimeout(handle)
  }, [toTags, ccTags, bccTags, toText, ccText, bccText, subject, bodyState, attachments, fromId])
  // Typing in the body restarts its own timer (see handleBodyChange), without a render.
  const bodySave = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (bodySave.current && clearTimeout(bodySave.current)), [])
  // Set once the message is sent, discarded, saved or closed, so nothing below acts on it twice (a
  // double-click on Send sending two copies) and the unmount save doesn't bring a sent draft back.
  const finished = useRef(false)
  const finish = () => {
    if (finished.current) return false
    finished.current = true
    return true
  }
  // Clicking another conversation, switching account or opening another draft unmounts the composer
  // without going through ×: save what the debounce hasn't yet.
  useEffect(() => () => {
    if (!finished.current) autosaveRef.current()
  }, [])
  const close = () => {
    if (finished.current) return
    autosave()
    finish()
    onClose()
  }

  const hasRecipients = allRecipients.length > 0 || typedMentions().length > 0
  const send = (sendAt?: number) => {
    if (allRecipients.length === 0 && typedMentions().length === 0) {
      flash('Add at least one recipient')
      return
    }
    const invalid = allRecipients.find((address) => !isEmailAddress(address))
    if (invalid) {
      flash(`“${invalid}” isn't an email address`)
      return
    }
    if (!finish()) return
    onSend(compile(), sendAt)
  }
  const later = useToggle()
  const at = (days: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  const monday = ((1 - new Date().getDay() + 7) % 7) || 7

  return (
    <div
      testId="compose-pane"
      style={{
        flexGrow: 1,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: C.reading,
        position: 'relative',
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: TOPBAR_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: READ_PAD_LEFT,
          paddingRight: 16,
          gap: 6,
        }}
      >
        <text style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>
          {subject.trim() || title}
        </text>

        <div
          style={{
            height: 28,
            borderRadius: 14,
            backgroundColor: C.overlay,
            padding: 2,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            marginRight: 6,
          }}
        >
          {(['write', 'preview'] as const).map((id) => {
            const active = mode === id
            return (
              <div
                key={id}
                testId={`compose-mode-${id}`}
                onClick={() => {
                  setMode(id)
                  setMentionQuery(null)
                }}
                style={{
                  paddingLeft: 10,
                  paddingRight: 10,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: active ? C.overlayStrong : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
              >
                <text style={{ fontSize: 12, fontWeight: active ? 500 : 400, color: active ? C.text : C.muted, fontFamily: FONT }}>
                  {id === 'write' ? 'Write' : 'Preview'}
                </text>
              </div>
            )
          })}
        </div>

        <IconButton icon="trash" size={17} onClick={() => finish() && onDiscard(compile())} testId="compose-discard" />
        <IconButton icon="x" size={17} onClick={close} testId="compose-close" />
      </div>
      <Divider />

      {/* Header fields */}
      {accounts.length > 1 ? (
        <>
          <FromField accounts={accounts} value={account.id} onChange={setFromId} />
          <Divider />
        </>
      ) : null}
      <RecipientField
        label="To"
        tags={toTags}
        onTagsChange={setToTags}
        input={toText}
        onInputChange={setToText}
        testId="compose-to"
        trailing={
          <div style={{ display: 'flex', flexDirection: 'row', gap: 2, flexShrink: 0 }}>
            {!showCc ? <CcBccToggle label="Cc" onClick={() => setShowCc(true)} testId="compose-show-cc" /> : null}
            {!showBcc ? <CcBccToggle label="Bcc" onClick={() => setShowBcc(true)} testId="compose-show-bcc" /> : null}
          </div>
        }
      />
      {showCc ? (
        <>
          <Divider />
          <RecipientField label="Cc" tags={ccTags} onTagsChange={setCcTags} input={ccText} onInputChange={setCcText} testId="compose-cc" />
        </>
      ) : null}
      {showBcc ? (
        <>
          <Divider />
          <RecipientField label="Bcc" tags={bccTags} onTagsChange={setBccTags} input={bccText} onInputChange={setBccText} testId="compose-bcc" />
        </>
      ) : null}
      <Divider />

      {/* Subject */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 40,
          paddingLeft: READ_PAD_LEFT,
          paddingRight: READ_PAD_RIGHT,
          gap: 8,
          flexShrink: 0,
        }}
      >
        <input
          testId="compose-subject"
          value={subject}
          placeholder="Subject"
          onChange={(event) => setSubject(event.value ?? '')}
          style={{ flexGrow: 1, minWidth: 0, fontSize: 14, fontWeight: 500, fontFamily: FONT, color: C.text }}
        />
      </div>
      <Divider />

      {/* Formatting bar */}
      <div style={{ flexShrink: 0 }}>
        <div
          style={{
            height: 40,
            paddingLeft: READ_PAD_LEFT - 6,
            paddingRight: READ_PAD_RIGHT - 6,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            borderBottomWidth: 1,
            borderColor: C.divider,
          }}
        >
          <ToolbarTextButton label="H1" testId="format-heading-1" onClick={() => formatBody({ kind: 'line', prefix: '# ', placeholder: 'Heading' })} />
          <ToolbarTextButton label="H2" testId="format-heading-2" onClick={() => formatBody({ kind: 'line', prefix: '## ', placeholder: 'Heading' })} />
          <ToolbarSeparator />
          <IconButton icon="bold" size={14} pad={26} testId="format-bold" onClick={() => formatBody({ kind: 'inline', before: '**', after: '**', placeholder: 'bold text' })} />
          <IconButton icon="italic" size={14} pad={26} testId="format-italic" onClick={() => formatBody({ kind: 'inline', before: '_', after: '_', placeholder: 'italic text' })} />
          <IconButton
            icon="strikethrough"
            size={14}
            pad={26}
            testId="format-strikethrough"
            onClick={() => formatBody({ kind: 'inline', before: '~~', after: '~~', placeholder: 'strikethrough' })}
          />
          <IconButton icon="code" size={14} pad={26} testId="format-code" onClick={() => formatBody({ kind: 'inline', before: '`', after: '`', placeholder: 'code' })} />
          <IconButton
            icon="link"
            size={14}
            pad={26}
            testId="format-link"
            onClick={() => formatBody({ kind: 'inline', before: '[', after: '](https://)', placeholder: 'link text' })}
          />
          <ToolbarSeparator />
          <IconButton icon="list" size={14} pad={26} testId="format-bullet-list" onClick={() => formatBody({ kind: 'line', prefix: '- ', placeholder: 'Item' })} />
          <IconButton icon="listOrdered" size={14} pad={26} testId="format-numbered-list" onClick={() => formatBody({ kind: 'line', prefix: '1. ', placeholder: 'Item' })} />
          <IconButton icon="check" size={14} pad={26} testId="format-checklist" onClick={() => formatBody({ kind: 'line', prefix: '- [ ] ', placeholder: 'Task' })} />
          <IconButton icon="quote" size={14} pad={26} testId="format-quote" onClick={() => formatBody({ kind: 'line', prefix: '> ', placeholder: 'Quote' })} />
          <ToolbarSeparator />
          {ai.enabled ? (
            <div style={{ flexShrink: 0, position: 'relative' }}>
              {aiBusy ? (
                <div testId="compose-ai-stop" onClick={() => aiAbort.current?.abort()} style={{ height: 26, paddingLeft: 8, paddingRight: 8, gap: 6, borderRadius: 6, display: 'flex', flexDirection: 'row', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}>
                  <Spinner size={12} color={C.accent} />
                  <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, pointerEvents: 'none' }}>Stop</text>
                </div>
              ) : (
                <IconButton icon="sparkles" size={14} pad={26} active={aiMenu.open} tooltip={`Write with ${ai.providerName}`} testId="compose-ai" onClick={aiMenu.toggle} />
              )}
              <Menu open={aiMenu.open} onClose={aiMenu.close} width={300} testId="compose-ai-menu">
                <MenuLabel>{`Write with ${ai.providerName}`}</MenuLabel>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 6, paddingBottom: 4 }}>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <TextInput testId="compose-ai-prompt" autoFocus value={aiPrompt} placeholder="What should this email say?" onChange={setAiPrompt} onEnter={() => aiPrompt.trim() && runAi({ write: aiPrompt })} />
                  </div>
                  <Button label="Write" variant="primary" disabled={!aiPrompt.trim()} onClick={() => runAi({ write: aiPrompt })} testId="compose-ai-write" />
                </div>
                {body.trim() ? (
                  <>
                    <MenuSeparator />
                    <MenuLabel>Rewrite what you wrote</MenuLabel>
                    <MenuItem icon="sparkles" label="Improve writing" testId="compose-ai-improve" onSelect={() => runAi({ rewrite: 'improve' })} />
                    <MenuItem icon="list" label="Make it shorter" testId="compose-ai-shorter" onSelect={() => runAi({ rewrite: 'shorter' })} />
                    <MenuItem icon="lock" label="More formal" onSelect={() => runAi({ rewrite: 'formal' })} />
                    <MenuItem icon="smile" label="Friendlier" onSelect={() => runAi({ rewrite: 'friendly' })} />
                    <MenuItem icon="check" label="Fix spelling and grammar" onSelect={() => runAi({ rewrite: 'proofread' })} />
                  </>
                ) : null}
              </Menu>
            </div>
          ) : null}
          <ToolbarTextButton
            label="Mention"
            icon="atSign"
            testId="format-mention"
            tone={C.accent}
            active={mentionQuery !== null}
            onClick={() => {
              replaceBody((prev) => (!prev || prev.endsWith(' ') || prev.endsWith('\n') ? `${prev}@` : `${prev} @`))
              setMentionQuery('')
            }}
          />
          <div style={{ flexGrow: 1 }} />
          <ToolbarTextButton
            label="Template"
            testId="format-template"
            onClick={() => {
              if (!subject.trim()) setSubject('Project kickoff & next steps')
              replaceBody(() => TEMPLATE_BODY)
            }}
          />
          <ToolbarTextButton label="Attach" icon="paperclip" testId="format-attach" onClick={attach} />
        </div>

      </div>

      {/* Editor body or preview */}
      <div style={{ flexGrow: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {mode === 'write' ? (
          <div
            ref={bodyPage}
            style={{
              flexGrow: 1,
              minHeight: 0,
              overflowY: 'scroll',
              paddingLeft: READ_PAD_LEFT,
              paddingRight: READ_PAD_RIGHT,
              paddingTop: BODY_PAD_TOP,
              paddingBottom: 12,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <textarea
              key={bodyKey}
              ref={bodyRef}
              testId="compose-body"
              autoFocus={bodyKey > 0}
              value={mounted.current.body}
              placeholder="Write your message — type @ to mention someone"
              minRows={12}
              // Grows with the text, so a long message opens at its top; the page around it scrolls.
              maxRows={100000}
              onChange={(event) => handleBodyChange(event.value ?? '')}
              onKeyDown={(event) => {
                const format = shortcutFormat(event)
                if (format) formatKeyboardSelection(format)
              }}
              style={{ flexGrow: 1, fontSize: 14, lineHeight: BODY_LINE_HEIGHT, fontFamily: FONT, color: C.text }}
            />
          </div>
        ) : (
          <div
            testId="compose-preview"
            style={{
              flexGrow: 1,
              minHeight: 0,
              overflowY: 'scroll',
              paddingLeft: READ_PAD_LEFT,
              paddingRight: READ_PAD_RIGHT,
              paddingTop: 14,
              paddingBottom: 20,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {body.trim() ? (
              <MailMarkdown source={body} />
            ) : (
              <text style={{ fontSize: 14, color: C.muted, fontFamily: FONT }}>Nothing to preview yet</text>
            )}
          </div>
        )}

        {mode === 'write' && mentionSuggestions.length > 0 ? (
          // No caret API: estimate the caret from the hard line count and the last line's length.
          <div
            style={{
              position: 'absolute',
              top: BODY_PAD_TOP + mentionCaret.line * BODY_LINE_HEIGHT,
              left: READ_PAD_LEFT + Math.min(mentionCaret.column * AVG_CHAR_WIDTH, 360),
              width: 1,
              height: BODY_LINE_HEIGHT,
            }}
          >
            <anchored side="bottom" align="start" gap={4} fit="switch" deferred priority={1} occlude style={{ backgroundColor: C.raised, borderRadius: 12 }}>
              <div
                style={{
                  width: 280,
                  borderRadius: 12,
                  backgroundColor: C.raised,
                  borderWidth: 1,
                  borderColor: C.overlayStrong,
                  boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 16, spreadRadius: 0, color: '#00000044' },
                  padding: 4,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ paddingLeft: 8, paddingTop: 4, paddingBottom: 4 }}>
                  <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted, fontFamily: FONT }}>Mention — adds to To</text>
                </div>
                {mentionSuggestions.map((contact) => (
                  <div
                    key={contact.email}
                    testId={`mention-${contact.email}`}
                    onClick={() => insertMention(contact)}
                    style={{
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      height: 44,
                      flexShrink: 0,
                      paddingLeft: 8,
                      paddingRight: 8,
                      borderRadius: 6,
                      gap: 10,
                      cursor: 'pointer',
                      hover: { backgroundColor: C.overlay },
                    }}
                  >
                    <Face {...contact.face} size={26} />
                    <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
                      <text style={{ fontSize: 13, lineHeight: 18, fontWeight: 500, color: C.text, fontFamily: FONT }}>{contact.name}</text>
                      <text style={{ fontSize: 11.5, lineHeight: 16, color: C.muted, fontFamily: FONT }}>{contact.email}</text>
                    </div>
                  </div>
                ))}
              </div>
            </anchored>
          </div>
        ) : null}
      </div>

      {/* Attachments tray */}
      {attachments.length > 0 ? (
        <div
          style={{
            paddingLeft: READ_PAD_LEFT,
            paddingRight: READ_PAD_RIGHT,
            paddingTop: 10,
            paddingBottom: 10,
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            flexShrink: 0,
            borderTopWidth: 1,
            borderColor: C.divider,
          }}
        >
          {attachments.map((att, index) => (
            <AttachmentCard
              key={att.path ?? att.name}
              attachment={att}
              onRemove={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      ) : null}

      <Divider />

      {/* Footer */}
      <div
        style={{
          height: 52,
          paddingLeft: READ_PAD_LEFT - 4,
          paddingRight: READ_PAD_RIGHT - 4,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        {notice ? (
          <div testId="compose-notice" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 4 }}>
            <Icon name={notice.icon} size={13} color={C.accent} />
            <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>{notice.message}</text>
          </div>
        ) : null}

        <div style={{ flexGrow: 1 }} />

        <div
          testId="compose-save-draft"
          onClick={() => finish() && onSaveDraft(compile())}
          style={{
            height: 30,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            hover: { backgroundColor: C.overlay },
          }}
        >
          <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>Save draft</text>
        </div>

        <div style={{ flexShrink: 0 }}>
          <IconButton icon="clock" size={16} pad={30} active={later.open} onClick={later.toggle} testId="compose-send-later" />
          <Menu open={later.open} onClose={later.close} side="top" align="end" width={220} testId="send-later-menu">
            <MenuLabel>Send later</MenuLabel>
            <MenuItem icon="clock" label="In 1 hour" testId="send-later-hour" onSelect={() => { later.close(); send(Date.now() + 3_600_000) }} />
            <MenuItem icon="clock" label="Tomorrow morning" hint="8:00" testId="send-later-tomorrow" onSelect={() => { later.close(); send(at(1, 8)) }} />
            <MenuItem icon="clock" label="Monday morning" hint="8:00" testId="send-later-monday" onSelect={() => { later.close(); send(at(monday, 8)) }} />
          </Menu>
        </div>
        <div
          testId="compose-send"
          onClick={() => send()}
          style={{
            height: 30,
            paddingLeft: 18,
            paddingRight: 18,
            borderRadius: 15,
            backgroundColor: C.accent,
            opacity: hasRecipients ? 1 : 0.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            hover: hasRecipients ? { backgroundColor: C.accentHover } : undefined,
            active: hasRecipients ? { backgroundColor: C.accentActive } : undefined,
          }}
        >
          <text style={{ fontSize: 13, fontWeight: 600, color: C.onAccent, fontFamily: FONT }}>Send</text>
        </div>
      </div>
    </div>
  )
}
