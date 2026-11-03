import { motion } from '@gpuix/react'
import { useState } from 'react'
import { FONT, useSettings } from './theme'
import { IconButton } from './icons'
import { useKeys } from './keys'
import { useOverlay } from './overlays'
import { useMail } from './store'
import { toast } from './toast'
import { Button, Field, SegmentedControl, TextInput } from './ui'
import { Switch } from './calendar/fields'
import { FEEDBACK_KINDS, closeFeedback, feedbackContext, feedbackErrors, sendFeedback, useFeedbackRequest, type FeedbackDraft, type FeedbackKind } from './feedback'

// ---------------------------------------------------------------------------
// "Report a bug" / "Request a feature": a sheet over the app, opened with openFeedback from the
// rail's feedback button, the palette and Settings → About. Mounted once at the shell.
// ---------------------------------------------------------------------------

export function FeedbackHost() {
  const request = useFeedbackRequest()
  return request ? <FeedbackSheet key={request.key} kind={request.kind} /> : null
}

function FeedbackSheet({ kind }: { kind: FeedbackKind }) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { account } = useMail()
  const [draft, setDraft] = useState<FeedbackDraft>({ kind, message: '', email: account?.email ?? '', name: account?.name ?? '', includeContext: true })
  const [tried, setTried] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<FeedbackDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const errors = feedbackErrors(draft)
  const shown = tried ? errors : {}
  const context = feedbackContext()
  useOverlay(true)

  const send = async () => {
    setTried(true)
    if (sending || Object.keys(errors).length) return
    setSending(true)
    setError(null)
    const result = await sendFeedback(draft)
    setSending(false)
    if (!result.ok) return setError(result.error)
    closeFeedback()
    toast.success(draft.kind === 'bug' ? 'Bug report sent' : draft.kind === 'feature' ? 'Feature request sent' : 'Message sent', { description: `Thank you. Replies go to ${draft.email.trim()}` })
  }

  useKeys((press) => {
    const key = press.key?.toLowerCase()
    if (key === 'escape') {
      closeFeedback()
      return true
    }
    if (key === 'enter' && (press.modifiers?.cmd || press.modifiers?.ctrl)) {
      void send()
      return true
    }
    // Everything else belongs to the fields.
    return true
  })

  const placeholder = FEEDBACK_KINDS.find((k) => k.value === draft.kind)!.placeholder
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#00000080' : '#0000004A' }}
        onClick={closeFeedback}
      />
      <motion.div initial={{ opacity: 0, top: 10 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div
          testId="feedback-sheet"
          style={{
            width: 520,
            borderRadius: 16,
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.overlayStrong,
            boxShadow: { offsetX: 0, offsetY: 24, blurRadius: 64, spreadRadius: 0, color: dark ? '#00000099' : '#00000038' },
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 20, paddingLeft: 24, paddingRight: 14, paddingBottom: 6 }}>
            <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <text style={{ fontSize: 19, fontWeight: 600, color: C.text, fontFamily: FONT }}>Send feedback</text>
              <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>It goes straight to the people who make Jefi.</text>
            </div>
            <IconButton icon="x" size={16} pad={30} tooltip="Close" onClick={closeFeedback} testId="feedback-close" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 12, paddingLeft: 24, paddingRight: 24, paddingBottom: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'row' }}>
              <SegmentedControl testId="feedback-kind" value={draft.kind} options={FEEDBACK_KINDS} onChange={(next) => set({ kind: next })} />
            </div>

            <Field label="Message" error={shown.message}>
              <div style={{ minHeight: 120, borderRadius: 9, borderWidth: shown.message ? 1 : 0, borderColor: C.accent, backgroundColor: C.overlay, paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, display: 'flex' }}>
                <textarea
                  testId="feedback-message"
                  autoFocus
                  value={draft.message}
                  placeholder={placeholder}
                  minRows={5}
                  maxRows={12}
                  onChange={(event) => set({ message: event.value ?? '' })}
                  style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, lineHeight: 20, fontFamily: FONT, color: C.text, paddingTop: 4, paddingBottom: 4 }}
                />
              </div>
            </Field>

            <Field label="Reply to" error={shown.email} hint="We only use it to answer you.">
              <TextInput testId="feedback-email" value={draft.email} placeholder="you@example.com" invalid={!!shown.email} onChange={(email) => set({ email })} />
            </Field>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Switch on={draft.includeContext} label="Include app version and macOS version" testId="feedback-context" onChange={(includeContext) => set({ includeContext })} />
              <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, paddingLeft: 38 }}>{`Jefi ${context.version} · macOS ${context.os || '?'} · ${context.arch}. No mail or account data is sent.`}</text>
            </div>

            {error ? (
              <text testId="feedback-error" style={{ fontSize: 12.5, color: C.accent, fontFamily: FONT }}>
                {error}
              </text>
            ) : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, paddingBottom: 14, paddingLeft: 24, paddingRight: 16, borderTopWidth: 1, borderColor: C.overlay }}>
            <text style={{ flexGrow: 1, fontSize: 12, color: C.muted, fontFamily: FONT }}>⌘↩ to send · Esc to close</text>
            <Button label="Cancel" variant="ghost" onClick={closeFeedback} testId="feedback-cancel" />
            <Button label={sending ? 'Sending…' : 'Send'} variant="primary" disabled={sending} onClick={() => void send()} testId="feedback-send" />
          </div>
        </div>
      </motion.div>
    </div>
  )
}
