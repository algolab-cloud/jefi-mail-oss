import type { MailThread } from './data'
import { Icon } from './icons'
import { copyLink as copyText } from './native/mail-webview'
import { signInFresh } from './sign-in-code'
import { FONT, useSettings } from './theme'
import { toast } from './toast'

// ---------------------------------------------------------------------------
// The sign-in code beside a conversation's subject: one click copies it. A magic link is offered only
// in the reader, where it goes through link review like any other link: sign-in mail is what phishing
// imitates, so a link is never opened from the list.
// ---------------------------------------------------------------------------

/** Copies a code and says so. */
export function copySignInCode(code: string) {
  if (copyText(code)) toast.success(`Copied ${code}`, { id: 'sign-in-code' })
  else toast.error("Couldn't copy the code", { id: 'sign-in-code' })
}

/** The code still worth offering for this conversation, if any. */
export const freshCode = (thread: Pick<MailThread, 'signIn' | 'at'>) =>
  thread.signIn?.kind === 'code' && signInFresh(thread.at) ? thread.signIn.code : null

/** A pill reading the code, copied on click. */
export function SignInCodePill({ code, testId, size = 'small' }: { code: string; testId?: string; size?: 'small' | 'large' }) {
  const { C } = useSettings()
  const large = size === 'large'
  return (
    <div
      testId={testId}
      role="button"
      aria-label={`Copy sign-in code ${code}`}
      onClick={() => copySignInCode(code)}
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: large ? 24 : 18,
        paddingLeft: large ? 9 : 6,
        paddingRight: large ? 9 : 6,
        borderRadius: large ? 12 : 9,
        backgroundColor: C.chip,
        cursor: 'pointer',
        hover: { backgroundColor: C.overlayStrong },
      }}
    >
      <Icon name="copy" size={large ? 13 : 11} color={C.accent} />
      <text style={{ fontSize: large ? 13 : 11.5, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{code}</text>
    </div>
  )
}
