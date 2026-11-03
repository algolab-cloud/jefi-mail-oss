import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { assessEmailLink, parseMailtoDraft, type LinkAssessment } from './link-safety'
import type { DraftFields } from './data'
import { Icon } from './icons'
import { FONT, mixHex, useSettings } from './theme'
import { Menu } from './ui'
import { useWebRiskKey } from './web-risk-key'
import { checkWebRiskUrl, WebRiskError, type WebRiskVerdict } from './web-risk'
import { usePhishingDatabase } from './use-phishing-database'

export type LinkPosition = { x: number; y: number }

export type LinkReviewRequest = {
  raw: string
  position: LinkPosition
}

/** Turn a reviewed mailto URL into a normal Jefi draft; the person still reviews and sends it. */
export function draftFromMailto(url: string): DraftFields | null {
  return parseMailtoDraft(url)
}

function Action({ label, testId, autoFocus, primary, disabled, onSelect, onClose }: {
  label: string
  testId: string
  autoFocus?: boolean
  primary?: boolean
  disabled?: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      role="button"
      aria-label={label}
      tabIndex={0}
      autoFocus={autoFocus}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(event) => {
        if (event.key === 'escape') onClose()
        else if (!disabled && (event.key === 'enter' || event.key === 'space' || event.key === ' ')) onSelect()
      }}
      style={{
        height: 28,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 14,
        backgroundColor: primary ? C.text : C.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
        hover: disabled ? undefined : { backgroundColor: primary ? mixHex(C.text, C.reading, 0.12) : C.overlayStrong },
        active: disabled ? undefined : { backgroundColor: primary ? mixHex(C.text, C.reading, 0.22) : C.overlayStrong },
      }}
    >
      <text style={{ fontSize: 12.5, fontWeight: 600, color: primary ? C.reading : C.text, fontFamily: FONT, pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}

type WebRiskState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | WebRiskVerdict
  | { kind: 'error'; message: string }

function useReviewCleanup(abortRef: { current: AbortController | null }, expiryRef: { current: ReturnType<typeof setTimeout> | null }) {
  useEffect(() => () => {
    abortRef.current?.abort()
    if (expiryRef.current) clearTimeout(expiryRef.current)
  }, [])
}

const threatLabel = (type: string) => type === 'MALWARE'
  ? 'malware'
  : type === 'SOCIAL_ENGINEERING'
    ? 'phishing or social engineering'
    : type === 'UNWANTED_SOFTWARE'
      ? 'unwanted software'
      : type.toLowerCase().replaceAll('_', ' ')

const googleThreatTitle = (types: readonly string[]) => types.includes('SOCIAL_ENGINEERING')
  ? 'Suspected phishing · Google Web Risk'
  : types.includes('MALWARE')
    ? 'Potential malware · Google Web Risk'
    : types.includes('UNWANTED_SOFTWARE')
      ? 'Potential unwanted software · Google Web Risk'
      : 'Potential threat · Google Web Risk'

const GOOGLE_ADVISORY = 'https://docs.cloud.google.com/web-risk/docs/advisory'
const PHISHING_LEARN_MORE = 'https://apwg.org/'
const MALWARE_LEARN_MORE = 'https://developers.google.com/search/docs/monitor-debug/security/malware'
const UNWANTED_SOFTWARE_LEARN_MORE = 'https://www.google.com/about/unwanted-software-policy.html'

const googleLearnMore = (types: readonly string[]) => types.includes('SOCIAL_ENGINEERING')
  ? { label: 'About phishing', url: PHISHING_LEARN_MORE }
  : types.includes('MALWARE')
    ? { label: 'About malware', url: MALWARE_LEARN_MORE }
    : types.includes('UNWANTED_SOFTWARE')
      ? { label: 'Software policy', url: UNWANTED_SOFTWARE_LEARN_MORE }
      : null

function WebReview({ assessment, actionLabel, onClose, onOpen }: {
  assessment: LinkAssessment & { kind: 'web'; url: string }
  actionLabel: string
  onClose: () => void
  onOpen: (url: string) => void
}) {
  const { C, settings } = useSettings()
  const webRiskKey = useWebRiskKey()
  const phishing = usePhishingDatabase(settings.phishingListEnabled)
  const local = phishing.check(assessment.url)
  const [webRisk, setWebRisk] = useState<WebRiskState>({ kind: 'idle' })
  const checkAbort = useRef<AbortController | null>(null)
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkId = useRef(0)
  useReviewCleanup(checkAbort, expiryTimer)

  const close = () => {
    checkId.current++
    checkAbort.current?.abort()
    if (expiryTimer.current) clearTimeout(expiryTimer.current)
    checkAbort.current = null
    expiryTimer.current = null
    onClose()
  }
  const checkWithGoogle = () => {
    if (!webRiskKey.key) return
    checkAbort.current?.abort()
    if (expiryTimer.current) clearTimeout(expiryTimer.current)
    expiryTimer.current = null
    const controller = new AbortController()
    checkAbort.current = controller
    const id = ++checkId.current
    setWebRisk({ kind: 'checking' })
    void checkWebRiskUrl(assessment.url, webRiskKey.key, { signal: controller.signal })
      .then((verdict) => {
        if (controller.signal.aborted || checkId.current !== id) return
        if (verdict.kind === 'threat') {
          const remaining = verdict.expiresAt - Date.now()
          if (remaining <= 0) {
            setWebRisk({ kind: 'error', message: 'Google result expired; check again.' })
            return
          }
          expiryTimer.current = setTimeout(() => {
            if (checkId.current === id) setWebRisk({ kind: 'error', message: 'Google result expired; check again.' })
          }, Math.min(remaining, 2_147_483_647))
        }
        setWebRisk(verdict)
      })
      .catch((error) => {
        if (controller.signal.aborted || checkId.current !== id) return
        const message = error instanceof WebRiskError ? error.message : 'Google Web Risk could not complete the check.'
        setWebRisk({ kind: 'error', message })
      })
      .finally(() => {
        if (checkId.current === id) checkAbort.current = null
      })
  }

  const localThreat = local?.hit === true
  const googleThreat = webRisk.kind === 'threat'
  const knownThreat = localThreat || googleThreat
  const checking = webRisk.kind === 'checking'
  const learnMore = webRisk.kind === 'threat' ? googleLearnMore(webRisk.threatTypes) : null

  return (
    <>
      {localThreat || webRisk.kind !== 'idle' || (webRiskKey.loaded && webRiskKey.configured) ? (
      <div style={{ height: 1, backgroundColor: C.divider }} />
      ) : null}
      {localThreat ? (
        <div testId="link-review-database-threat" style={{ padding: 8, borderRadius: 7, borderWidth: 1, borderColor: C.amber, backgroundColor: C.overlayStrong, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Icon name="alertCircle" size={14} color={C.amber} />
            <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, fontWeight: 650, color: C.text, fontFamily: FONT }}>Reported phishing</text>
          </div>
          <text style={{ fontSize: 11.5, lineHeight: 16, color: C.secondary, fontFamily: FONT }}>{`Phishing.Database ${local.type === 'url' ? 'URL' : 'domain'} match${local.stale ? ' · list out of date' : ''}`}</text>
        </div>
      ) : null}
      {webRisk.kind === 'threat' ? (
        <div testId="link-review-google-threat" style={{ maxHeight: 170, overflow: 'scroll', padding: 8, borderRadius: 7, borderWidth: 1, borderColor: C.amber, backgroundColor: C.overlayStrong, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Icon name="alertCircle" size={14} color={C.amber} />
            <text style={{ fontSize: 12.5, fontWeight: 650, color: C.text, fontFamily: FONT }}>{googleThreatTitle(webRisk.threatTypes)}</text>
          </div>
          <text style={{ fontSize: 11.5, lineHeight: 16, color: C.secondary, fontFamily: FONT }}>{`Reported for ${webRisk.threatTypes.map(threatLabel).join(', ')}. Google may miss or misidentify links.`}</text>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5 }}>
            <Action label="Advisory provided by Google" testId="link-review-google-advisory" onSelect={() => { onOpen(GOOGLE_ADVISORY); close() }} onClose={close} />
            {learnMore ? <Action label={learnMore.label} testId="link-review-google-learn-more" onSelect={() => { onOpen(learnMore.url); close() }} onClose={close} /> : null}
          </div>
        </div>
      ) : webRisk.kind === 'no-match' ? (
        <text testId="link-review-google-no-match" style={{ fontSize: 11.5, lineHeight: 16, color: C.secondary, fontFamily: FONT }}>No match in Google’s list; not a safety guarantee.</text>
      ) : webRisk.kind === 'error' ? (
        <text testId="link-review-google-error" style={{ fontSize: 11.5, lineHeight: 16, color: C.amber, fontFamily: FONT }}>{`Google check unavailable. ${webRisk.message}`}</text>
      ) : null}
      {webRiskKey.loaded && webRiskKey.configured ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <text style={{ flexGrow: 1, minWidth: 0, fontSize: 11, lineHeight: 15, color: C.muted, fontFamily: FONT }}>Sends the full URL above, including private tokens, to Google.</text>
          <Action label={checking ? 'Checking…' : 'Check with Google'} testId="link-review-google-check" disabled={checking} onSelect={checkWithGoogle} onClose={close} />
        </div>
      ) : null}
      <div style={{ height: 1, backgroundColor: C.divider }} />
      <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 7 }}>
        <Action key={knownThreat ? 'threat-cancel' : 'cancel'} label="Cancel" testId="link-review-cancel" autoFocus primary={knownThreat} onSelect={close} onClose={close} />
        <Action label={knownThreat ? 'Open anyway' : actionLabel} testId="link-review-open" primary={!knownThreat} disabled={checking} onSelect={() => { onOpen(assessment.url); close() }} onClose={close} />
      </div>
    </>
  )
}

function Warning({ children }: { children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 7 }}>
      <Icon name="alertCircle" size={13} color={C.amber} />
      <text style={{ flexGrow: 1, minWidth: 0, fontSize: 11.5, lineHeight: 16, color: C.secondary, fontFamily: FONT }}>{children}</text>
    </div>
  )
}

export function LinkPopover({ raw, sender, trustedDomains, position, onClose, onOpen, onCompose, onCopy }: {
  raw: string
  sender: string
  trustedDomains: readonly string[]
  position: LinkPosition
  onClose: () => void
  /** Called only after the person chooses the confirmation action. */
  onOpen: (url: string) => void
  onCompose: (draft: DraftFields) => void
  onCopy: (url: string) => void
}) {
  const { C } = useSettings()
  const assessment = useMemo(() => assessEmailLink(raw, sender, trustedDomains), [raw, sender, trustedDomains])
  const [showWarnings, setShowWarnings] = useState(false)
  const action = () => {
    if (!assessment.canOpen || !assessment.url) return
    if (assessment.kind === 'mailto') {
      const draft = draftFromMailto(assessment.url)
      if (draft) onCompose(draft)
    } else if (assessment.kind === 'web') onOpen(assessment.url)
    onClose()
  }
  const actionLabel = assessment.kind === 'mailto'
    ? 'Compose email'
    : assessment.warnings.length
      ? 'Open anyway'
      : 'Open link'
  const warning = assessment.warnings.find((item) => item.includes("does not match the sender's domain") || item.includes('sender domain could not'))
    ?? assessment.warnings[0]
  const orderedWarnings = warning
    ? [warning, ...assessment.warnings.filter((item) => item !== warning)]
    : assessment.warnings
  const heading = assessment.kind === 'web' && assessment.host ? assessment.host : assessment.title

  return (
    <Menu open onClose={onClose} position={position} width={312} testId="link-review-popover">
      <div style={{ paddingLeft: 9, paddingRight: 9, paddingTop: 8, paddingBottom: 7, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name={assessment.kind === 'blocked' ? 'alertCircle' : assessment.kind === 'mailto' ? 'pencil' : 'link'} size={16} color={assessment.warnings.length ? C.amber : C.secondary} />
          <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, fontWeight: 650, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{heading}</text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <text testId="link-review-url" style={{ flexGrow: 1, minWidth: 0, fontSize: 11.5, lineHeight: 16, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{assessment.url ?? raw}</text>
          <Action label="Copy" testId="link-review-copy" onSelect={() => { onCopy(assessment.url ?? raw); onClose() }} onClose={onClose} />
        </div>
        {warning ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ maxHeight: showWarnings ? 112 : undefined, overflow: showWarnings ? 'scroll' : undefined, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(showWarnings ? orderedWarnings : [warning]).map((item, index) => (
                <div key={item} testId={`link-review-warning-${index}`}><Warning>{item}</Warning></div>
              ))}
            </div>
            {assessment.warnings.length > 1 ? (
              <div
                testId="link-review-warnings-toggle"
                role="button"
                tabIndex={0}
                onClick={() => setShowWarnings((shown) => !shown)}
                onKeyDown={(event) => {
                  if (event.key === 'enter' || event.key === 'space' || event.key === ' ') setShowWarnings((shown) => !shown)
                  else if (event.key === 'escape') onClose()
                }}
                style={{ alignSelf: 'flex-start', height: 22, paddingLeft: 5, paddingRight: 5, borderRadius: 5, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
              >
                <text style={{ fontSize: 11.5, fontWeight: 600, color: C.secondary, fontFamily: FONT }}>{showWarnings ? 'Hide warnings' : `Show ${assessment.warnings.length - 1} more`}</text>
              </div>
            ) : null}
          </div>
        ) : assessment.kind === 'blocked' ? <Warning>{assessment.detail}</Warning> : null}
        {assessment.kind === 'web' && assessment.url ? (
          <WebReview assessment={assessment as LinkAssessment & { kind: 'web'; url: string }} actionLabel={actionLabel} onClose={onClose} onOpen={onOpen} />
        ) : (
          <>
            <div style={{ height: 1, backgroundColor: C.divider, marginTop: 2 }} />
            <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 7 }}>
              <Action label="Cancel" testId="link-review-cancel" autoFocus onSelect={onClose} onClose={onClose} />
              {assessment.canOpen && assessment.url ? <Action label={actionLabel} testId="link-review-open" primary onSelect={action} onClose={onClose} /> : null}
            </div>
          </>
        )}
      </div>
    </Menu>
  )
}
