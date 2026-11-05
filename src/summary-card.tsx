import { FONT, READ_PAD_LEFT, READ_PAD_RIGHT, useSettings } from './theme'
import { Icon, IconButton } from './icons'
import { Button } from './ui'
import { Spinner } from './toast'
import { MailMarkdown } from './markdown'
import type { Handoff } from './assistant-handoff'

export type CardSummary = { kind: 'summary' | 'translation'; text: string; state: 'streaming' | 'done' | 'error'; error?: string }

/**
 * AI summary or translation above the conversation. Once it's done it can be copied, or handed to
 * the assistant to ask about; it can be closed, or tried again after a failure.
 */
export function SummaryCard({ provider, subject, summary, onClose, onRetry, onCopy, onAsk }: {
  provider: string
  subject: string
  summary: CardSummary
  onClose: () => void
  onRetry: () => void
  onCopy: (text: string) => void
  onAsk: (item: Handoff) => void
}) {
  const { C } = useSettings()
  const translation = summary.kind === 'translation'
  const done = summary.state === 'done' && summary.text.trim() !== ''
  const title = `${translation ? 'Translation' : 'Summary'} of “${subject.trim() || '(no subject)'}”`
  return (
    <div style={{ width: '100%', flexShrink: 0, paddingLeft: READ_PAD_LEFT, paddingRight: READ_PAD_RIGHT, paddingTop: 12 }}>
      <div testId="ai-summary" style={{ borderRadius: 12, backgroundColor: C.raised, paddingLeft: 14, paddingRight: 8, paddingTop: 8, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, height: 26 }}>
          <Icon name={translation ? 'languages' : 'sparkles'} size={14} color={C.accent} />
          {/* One string: separate children would each be laid out on a line of their own. */}
          <text testId="ai-summary-title" style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`${translation ? 'Translation' : 'Summary'} · ${provider}`}</text>
          {summary.state === 'streaming' ? <Spinner size={12} color={C.accent} /> : null}
          {summary.state === 'error' ? <Button label="Try again" variant="ghost" onClick={onRetry} testId="ai-summary-retry" /> : null}
          {done ? (
            <>
              <IconButton icon="copy" size={14} pad={24} tooltip="Copy" onClick={() => onCopy(summary.text)} testId="ai-summary-copy" />
              <IconButton icon="messageSquare" size={14} pad={24} tooltip="Ask about it in the chat" onClick={() => onAsk({ title, text: summary.text })} testId="ai-summary-chat" />
            </>
          ) : null}
          <IconButton icon="x" size={14} pad={24} tooltip={translation ? 'Close translation' : 'Close summary'} onClick={onClose} testId="ai-summary-close" />
        </div>
        {summary.state === 'error' ? (
          <text style={{ fontSize: 13, color: C.accent, fontFamily: FONT }}>{summary.error ?? 'Something went wrong'}</text>
        ) : summary.text ? (
          <MailMarkdown source={summary.text} testId="ai-summary-text" />
        ) : (
          <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>{translation ? 'Translating…' : 'Reading the conversation…'}</text>
        )}
      </div>
    </div>
  )
}
