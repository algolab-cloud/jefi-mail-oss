import { useSettings, FONT } from './theme'
import { Button, Modal } from './ui'
import { IconButton } from './icons'

export function ReaderFindBar({ query, current, total, truncated, onQuery, onPrevious, onNext, onClose }: {
  query: string
  current: number
  total: number
  truncated?: boolean
  onQuery: (value: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}) {
  const { C } = useSettings()
  return (
    <div testId="reader-find" style={{ height: 42, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: C.divider, backgroundColor: C.raised, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
      <input
        testId="reader-find-input"
        autoFocus
        value={query}
        placeholder="Find in conversation"
        onChange={(event) => onQuery(event.value ?? '')}
        // Enter in an <input> arrives as a submit, not a key down.
        onSubmit={onNext}
        onKeyDown={(event) => {
          if (event.key === 'escape') onClose()
        }}
        style={{ width: 250, height: 30, paddingLeft: 9, paddingRight: 9, borderRadius: 9, backgroundColor: C.overlay, color: C.text, fontSize: 13, fontFamily: FONT }}
      />
      <text testId="reader-find-count" style={{ width: 72, textAlign: 'center', fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>
        {query.trim() ? (total ? `${current + 1} of ${total}${truncated ? '+' : ''}` : '0 of 0') : ''}
      </text>
      <IconButton icon="chevronLeft" size={14} pad={28} dimmed={!total} onClick={total ? onPrevious : undefined} tooltip="Previous match" testId="reader-find-previous" />
      <IconButton icon="chevronRight" size={14} pad={28} dimmed={!total} onClick={total ? onNext : undefined} tooltip="Next match" testId="reader-find-next" />
      <IconButton icon="x" size={14} pad={28} onClick={onClose} tooltip="Close find" testId="reader-find-close" />
    </div>
  )
}

export function OriginalMessageModal({ headers, onClose, onCopy, onExport }: {
  headers: string
  onClose: () => void
  onCopy: () => void
  onExport: () => void
}) {
  const { C } = useSettings()
  return (
    <Modal onClose={onClose} width={680} testId="original-message-modal">
      <div style={{ height: 52, paddingLeft: 18, paddingRight: 12, borderBottomWidth: 1, borderColor: C.divider, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <text style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Original message</text>
          <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>Raw headers exactly as received</text>
        </div>
        <IconButton icon="x" size={15} onClick={onClose} tooltip="Close" testId="original-close" />
      </div>
      <div style={{ height: 430, padding: 14, overflow: 'scroll', backgroundColor: C.list }}>
        <code code={headers} language="text" showLineNumbers={false} style={{ color: C.text, fontSize: 12, lineHeight: 18, fontFamily: 'monospace' }} />
      </div>
      <div style={{ height: 54, paddingLeft: 14, paddingRight: 14, borderTopWidth: 1, borderColor: C.divider, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <Button label="Copy headers" variant="secondary" onClick={onCopy} testId="original-copy" />
        <Button label="Export .eml" variant="primary" icon="download" onClick={onExport} testId="original-export" />
      </div>
    </Modal>
  )
}
