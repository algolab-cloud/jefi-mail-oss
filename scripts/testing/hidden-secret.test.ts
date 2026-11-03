import { expect, test } from 'bun:test'
import { guardHiddenTerminal, type HiddenTerminalRuntime } from './hidden-secret'

function runtime() {
  const listeners = new Map<string, () => void>()
  const events: string[] = []
  const value: HiddenTerminalRuntime = {
    once(signal, listener) { listeners.set(signal, listener) },
    off(signal, listener) { if (listeners.get(signal) === listener) listeners.delete(signal) },
    restore() { events.push('restore') },
    disable() { events.push('disable'); return true },
    suspend() { events.push('suspend') },
    exit(code) { events.push(`exit:${code}`) },
    write(text) { events.push(`write:${JSON.stringify(text)}`) },
  }
  return { value, listeners, events }
}

test('suspending restores echo and resuming hides input again', () => {
  const fixture = runtime()
  const cleanup = guardHiddenTerminal(fixture.value)
  fixture.listeners.get('SIGTSTP')!()
  expect(fixture.events).toEqual(['restore', 'suspend'])
  expect(fixture.listeners.has('SIGTSTP')).toBe(false)
  fixture.listeners.get('SIGCONT')!()
  expect(fixture.events).toEqual(['restore', 'suspend', 'disable'])
  expect(fixture.listeners.has('SIGTSTP')).toBe(true)
  cleanup()
  expect(fixture.listeners.size).toBe(0)
})

test('hangup restores echo before exiting', () => {
  const fixture = runtime()
  guardHiddenTerminal(fixture.value)
  fixture.listeners.get('SIGHUP')!()
  expect(fixture.events).toEqual(['restore', 'write:"\\n"', 'exit:129'])
  expect(fixture.listeners.size).toBe(0)
})
