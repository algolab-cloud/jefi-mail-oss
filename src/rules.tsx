import { useEffect, useState } from 'react'
import { FONT, TOPBAR_HEIGHT, useSettings } from './theme'
import { Icon } from './icons'
import { useMail } from './store'
import { Switch } from './settings'
import { Button, Field, SegmentedControl, TextInput } from './ui'
import { isEmptyMatch, type MailRule, type RuleActions, type RuleMatchCount } from './engine/rules'

// ---------------------------------------------------------------------------
// Rules: "when mail matches, do this". The engine runs enabled rules on new Inbox mail after each
// sync; "Run now" applies one to what's already in the Inbox.
// ---------------------------------------------------------------------------

type Move = NonNullable<RuleActions['moveTo']> | 'none'
const MOVES: Array<{ value: Move; label: string }> = [
  { value: 'none', label: 'Keep' },
  { value: 'archive', label: 'Archive' },
  { value: 'trash', label: 'Trash' },
  { value: 'spam', label: 'Spam' },
]

export function describeRule(rule: MailRule) {
  const when = [
    rule.match.from && `from “${rule.match.from}”`,
    rule.match.to && `to “${rule.match.to}”`,
    rule.match.subject && `subject has “${rule.match.subject}”`,
    rule.match.list && 'from a mailing list',
    rule.match.hasAttachment && 'with attachments',
  ].filter(Boolean)
  const then = [
    rule.actions.moveTo && { archive: 'archive', trash: 'move to Trash', spam: 'mark as spam', inbox: 'move to Inbox' }[rule.actions.moveTo],
    rule.actions.label && 'label',
    rule.actions.markRead && 'mark read',
    rule.actions.star && 'star',
  ].filter(Boolean)
  return `When ${when.join(', ') || '…'} → ${then.join(', ') || 'nothing'}`
}

/** Why a rule can't be saved yet, or null: it needs a name, something to match and something to do. */
export function ruleProblem(rule: MailRule): string | null {
  const { match, actions } = rule
  if (!rule.name.trim()) return 'Give the rule a name'
  if (!match.from?.trim() && !match.to?.trim() && !match.subject?.trim() && !match.list && !match.hasAttachment) return 'Add at least one condition'
  if (!actions.moveTo && !actions.label && !actions.markRead && !actions.star) return 'Choose at least one thing to do'
  return null
}

export function RulesPane() {
  const { C } = useSettings()
  const { listRules, saveRule, deleteRule, runRule, ruleDraft, startRule, labels, account } = useMail()
  const [rules, setRules] = useState<MailRule[] | null>(null)

  useEffect(() => {
    void listRules().then(setRules)
  }, [account.id])

  const save = async (rule: MailRule) => {
    const next = await saveRule(rule)
    if (next) {
      setRules(next)
      startRule(null)
    }
  }
  // Turning a rule on or off from the list leaves whatever is open in the editor alone.
  const toggle = async (rule: MailRule, enabled: boolean) => {
    const next = await saveRule({ ...rule, enabled })
    if (next) setRules(next)
  }

  return (
    <div testId="rules" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: C.list }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 16, gap: 10 }}>
        <Icon name="sliders" size={17} color={C.secondary} />
        <text style={{ flexGrow: 1, fontSize: 19, fontWeight: 600, color: C.text, fontFamily: FONT }}>Rules</text>
        {!ruleDraft ? <Button label="New rule" icon="plus" variant="primary" onClick={() => startRule({})} testId="rule-new" /> : null}
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '100%', maxWidth: 680, paddingLeft: 24, paddingRight: 24, paddingBottom: 32, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>Rules sort new mail as it arrives. They never touch mail you already have unless you run them.</text>

          {ruleDraft ? <RuleEditor draft={ruleDraft} labels={labels} onCancel={() => startRule(null)} onSave={save} /> : null}

          <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, backgroundColor: C.raised }}>
            {rules === null ? null : rules.length === 0 ? (
              <div style={{ height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>No rules yet. Right-click a conversation to make one from its sender.</text>
              </div>
            ) : (
              rules.map((rule, index) => (
                <div
                  key={rule.id}
                  testId={`rule-${rule.id}`}
                  style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 10, paddingTop: 10, paddingBottom: 10, borderTopWidth: index ? 1 : 0, borderColor: C.divider }}
                >
                  <Switch value={rule.enabled} onChange={(enabled) => void toggle(rule, enabled)} testId={`rule-toggle-${rule.id}`} />
                  <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <text style={{ fontSize: 13.5, fontWeight: 600, color: rule.enabled ? C.text : C.muted, fontFamily: FONT }}>{rule.name}</text>
                    <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{describeRule(rule)}</text>
                  </div>
                  <Button label="Run now" variant="ghost" onClick={() => void runRule(rule)} testId={`rule-run-${rule.id}`} />
                  <Button label="Edit" variant="ghost" onClick={() => startRule(rule)} testId={`rule-edit-${rule.id}`} />
                  <Button label="Delete" variant="ghost" onClick={() => void deleteRule(rule.id).then(setRules)} testId={`rule-delete-${rule.id}`} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function RuleEditor({
  draft,
  labels,
  onSave,
  onCancel,
}: {
  draft: MailRule
  labels: Array<{ id: string; label: string }>
  onSave: (rule: MailRule) => void
  onCancel: () => void
}) {
  const { C } = useSettings()
  const { countRuleMatches } = useMail()
  const [rule, setRule] = useState(draft)
  useEffect(() => setRule(draft), [draft.id])
  // What the conditions cover right now, so a rule that matches nothing (or far less than meant) shows it.
  const [preview, setPreview] = useState<RuleMatchCount | null>(null)
  const conditions = JSON.stringify(rule.match)
  useEffect(() => {
    if (isEmptyMatch(rule.match)) return setPreview(null)
    let live = true
    const timer = setTimeout(() => {
      countRuleMatches(rule.match)
        .then((count) => live && setPreview(count))
        .catch(() => live && setPreview(null))
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [conditions])
  const match = (patch: Partial<MailRule['match']>) => setRule((r) => ({ ...r, match: { ...r.match, ...patch } }))
  const act = (patch: Partial<RuleActions>) => setRule((r) => ({ ...r, actions: { ...r.actions, ...patch } }))
  const problem = ruleProblem(rule)

  return (
    <div testId="rule-editor" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRadius: 14, backgroundColor: C.raised }}>
      <Field label="Name">
        <TextInput value={rule.name} onChange={(name) => setRule((r) => ({ ...r, name }))} testId="rule-name" />
      </Field>
      <text style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>When a message</text>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
        <div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }}>
          <Field label="From contains">
            <TextInput value={rule.match.from ?? ''} onChange={(from) => match({ from })} placeholder="name or address" testId="rule-from" />
          </Field>
        </div>
        <div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }}>
          <Field label="To contains">
            <TextInput value={rule.match.to ?? ''} onChange={(to) => match({ to })} placeholder="address" testId="rule-to" />
          </Field>
        </div>
      </div>
      <Field label="Subject contains">
        <TextInput value={rule.match.subject ?? ''} onChange={(subject) => match({ subject })} testId="rule-subject" />
      </Field>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 18 }}>
        <Toggle label="Is from a mailing list" value={!!rule.match.list} onChange={(list) => match({ list })} testId="rule-list" />
        <Toggle label="Has attachments" value={!!rule.match.hasAttachment} onChange={(hasAttachment) => match({ hasAttachment })} testId="rule-attachment" />
      </div>
      {preview ? <MatchPreview count={preview} onDropList={() => match({ list: false })} /> : null}
      <text style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontFamily: FONT, paddingTop: 4 }}>Then</text>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <SegmentedControl value={(rule.actions.moveTo ?? 'none') as Move} options={MOVES} onChange={(value) => act({ moveTo: value === 'none' ? undefined : value })} testId="rule-move" />
        <Toggle label="Mark read" value={!!rule.actions.markRead} onChange={(markRead) => act({ markRead })} testId="rule-read" />
        <Toggle label="Star" value={!!rule.actions.star} onChange={(star) => act({ star })} testId="rule-star" />
      </div>
      {labels.length ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT, marginRight: 4 }}>Label</text>
          {[{ id: '', label: 'None' }, ...labels].map((l) => (
            <div
              key={l.id || 'none'}
              onClick={() => act({ label: l.id || undefined })}
              style={{ height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 13, display: 'flex', alignItems: 'center', cursor: 'pointer', backgroundColor: (rule.actions.label ?? '') === l.id ? C.chip : undefined, hover: { backgroundColor: C.overlay } }}
            >
              <text style={{ fontSize: 12, color: (rule.actions.label ?? '') === l.id ? C.text : C.secondary, fontFamily: FONT }}>{l.label}</text>
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
        {problem ? <text testId="rule-problem" style={{ flexGrow: 1, fontSize: 12, color: C.muted, fontFamily: FONT }}>{problem}</text> : null}
        <Button label="Cancel" variant="ghost" onClick={onCancel} testId="rule-cancel" />
        <Button label="Save rule" variant="primary" disabled={!!problem} onClick={() => onSave(rule)} testId="rule-save" />
      </div>
    </div>
  )
}

function Toggle({ label, value, onChange, testId }: { label: string; value: boolean; onChange: (value: boolean) => void; testId?: string }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Switch value={value} onChange={onChange} testId={testId} />
      <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>{label}</text>
    </div>
  )
}

const conversations = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'conversation' : 'conversations'}`

/** "Matches 2 conversations in your Inbox now", and when "mailing list" is what narrows it, by how much. */
export function matchPreviewText(count: RuleMatchCount): { text: string; hint: string | null } {
  const text = count.matches
    ? `Matches ${conversations(count.matches)} in your Inbox now. Save, then Run now to sort them; new mail is sorted as it arrives.`
    : 'Nothing in your Inbox matches this right now. New mail that does will be sorted as it arrives.'
  const more = count.withoutList === null ? 0 : count.withoutList - count.matches
  const hint = more > 0 ? `${conversations(more)} more ${more === 1 ? 'matches' : 'match'} if it doesn't have to be from a mailing list. Receipts and notifications usually aren't.` : null
  return { text, hint }
}

function MatchPreview({ count, onDropList }: { count: RuleMatchCount; onDropList: () => void }) {
  const { C } = useSettings()
  const { text, hint } = matchPreviewText(count)
  return (
    <div testId="rule-preview" style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 9, paddingBottom: 9, borderRadius: 10, backgroundColor: C.overlay }}>
      <text testId="rule-preview-text" style={{ fontSize: 12.5, lineHeight: 17, color: C.secondary, fontFamily: FONT }}>{text}</text>
      {hint ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <text testId="rule-preview-hint" style={{ flexGrow: 1, fontSize: 12.5, lineHeight: 17, color: C.accent, fontFamily: FONT }}>{hint}</text>
          <Button label="Include them" variant="secondary" onClick={onDropList} testId="rule-preview-include" />
        </div>
      ) : null}
    </div>
  )
}
