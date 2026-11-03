import { describe, expect, test } from 'bun:test'
import { mergeLabels } from './store'

describe('mergeLabels', () => {
  test('a label made in Jefi shows until the server lists it, then once', () => {
    const made = { id: 'gm:a:Urgent', label: 'Urgent', color: 'purple' as const }
    const work = { id: 'gm:a:Work', label: 'Work', color: 'green' as const }
    expect(mergeLabels([made], [work])).toEqual([made, work])
    const synced = { ...made, color: 'teal' as const }
    expect(mergeLabels([made], [synced, work])).toEqual([synced, work])
  })
})

describe('isServerLabel', () => {
  test('Gmail labels are the server’s; Jefi’s own are not', async () => {
    const { isServerLabel } = await import('./sidebar')
    expect(isServerLabel('gm:acct:Work')).toBe(true)
    expect(isServerLabel('urgent-0')).toBe(false)
  })
})
