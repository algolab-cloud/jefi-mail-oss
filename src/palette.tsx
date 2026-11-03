import { useMemo, useRef, useState } from 'react'
import { useKeys } from './keys'
import { FONT, useSettings } from './theme'
import { Icon, type IconName } from './icons'
import { TextInput } from './ui'
import { useOverlay } from './overlays'

// ---------------------------------------------------------------------------
// Command palette (Cmd+K): every action, mailbox and conversation, found by typing.
// ---------------------------------------------------------------------------

export type Command = { id: string; label: string; group: string; icon?: IconName; hint?: string; keywords?: string; run: () => void }

const MAX = 12

/** Words in order, each a prefix of some word in the text: "go arc" finds "Go to Archive". */
function score(command: Command, query: string) {
  if (!query) return 1
  const text = `${command.label} ${command.keywords ?? ''} ${command.group}`.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.every((w) => text.includes(w))) return 0
  return command.label.toLowerCase().startsWith(words[0]!) ? 3 : text.split(/\W+/).some((part) => part.startsWith(words[0]!)) ? 2 : 1
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const { C } = useSettings()
  useOverlay(true)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const results = useMemo(
    () =>
      commands
        .map((command) => ({ command, score: score(command, query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX)
        .map((r) => r.command),
    [commands, query],
  )
  const active = Math.min(index, Math.max(results.length - 1, 0))
  // Keys can arrive both through the input and at window level: run each command once.
  const ran = useRef(false)
  const run = (command?: Command) => {
    if (!command || ran.current) return
    ran.current = true
    onClose()
    command.run()
  }
  const onKey = (key: string) => {
    if (key === 'down') setIndex((i) => Math.min(i + 1, results.length - 1))
    else if (key === 'up') setIndex((i) => Math.max(i - 1, 0))
    else if (key === 'escape' || key === 'esc') onClose()
    else if (key === 'enter' || key === 'return') run(results[active])
    else return false
    return true
  }
  useKeys((press) => (press.key ? onKey(press.key) : false))

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 110 }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000066' }} onClick={onClose} />
      <div
        testId="palette"
        style={{
          width: 580,
          borderRadius: 16,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 48, spreadRadius: 0, color: '#00000077' },
          display: 'flex',
          flexDirection: 'column',
          padding: 8,
          gap: 6,
        }}
      >
        <TextInput
          value={query}
          onChange={(value) => {
            setQuery(value)
            setIndex(0)
          }}
          placeholder="Type a command, mailbox or subject…"
          autoFocus
          testId="palette-input"
          onEnter={() => run(results[active])}
          onKey={onKey}
        />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {results.length === 0 ? (
            <div style={{ height: 44, display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
              <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>No matches</text>
            </div>
          ) : (
            results.map((command, i) => (
              <div
                key={command.id}
                testId={`palette-item-${command.id}`}
                onClick={() => run(command)}
                onMouseEnter={() => setIndex(i)}
                style={{
                  height: 36,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  backgroundColor: i === active ? C.overlayStrong : undefined,
                }}
              >
                <Icon name={command.icon ?? 'arrowRightLong'} size={15} color={i === active ? C.text : C.secondary} />
                <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13.5, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{command.label}</text>
                <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{command.hint ?? command.group}</text>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
