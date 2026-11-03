import { describe, expect, test } from 'bun:test'
import { closePlan, lifecycleHelperPath } from './app-lifecycle'

describe('closePlan', () => {
  test('with the menu bar item, closing hides the window', () => {
    expect(closePlan({ menuBar: true, hideDockWhenClosed: false })).toEqual({ action: 'hide', hideDock: false })
    expect(closePlan({ menuBar: true, hideDockWhenClosed: true })).toEqual({ action: 'hide', hideDock: true })
  })
  test('without it, closing quits and the Dock is never hidden', () => expect(closePlan({ menuBar: false, hideDockWhenClosed: true })).toEqual({ action: 'quit', hideDock: false }))
})

test('the helper sits in the bundle Frameworks, unless a script points elsewhere', () => {
  expect(lifecycleHelperPath('/Applications/Jefi.app/Contents/MacOS/Jefi', {})).toBe('/Applications/Jefi.app/Contents/Frameworks/libJefiLifecycle.dylib')
  expect(lifecycleHelperPath('/x/Jefi', { JEFI_LIFECYCLE_HELPER: '/tmp/l.dylib' })).toBe('/tmp/l.dylib')
})
