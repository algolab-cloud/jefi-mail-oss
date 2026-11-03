import { expect, test } from 'bun:test'
import { ruleProblem } from './rules'
import { ruleDraftFrom } from './store'
import type { MailRule } from './engine/rules'

const rule = (patch: Partial<MailRule> = {}): MailRule => ({ id: 'r1', name: 'Newsletters', enabled: true, match: { list: true }, actions: { moveTo: 'archive' }, ...patch })

test('editing a rule keeps its id and on/off state, so saving replaces it', () => {
  const existing = rule({ enabled: false })
  expect(ruleDraftFrom(existing)).toEqual(existing)
  const fresh = ruleDraftFrom({ match: { from: 'deals@example.com' } }, 1000)
  expect(fresh).toEqual({ id: `rule-${(1000).toString(36)}`, name: 'New rule', enabled: true, match: { from: 'deals@example.com' }, actions: { moveTo: 'archive' } })
})

test('a rule needs a name, a condition and an action before it can be saved', () => {
  expect(ruleProblem(rule())).toBeNull()
  expect(ruleProblem(rule({ name: '  ' }))).toBe('Give the rule a name')
  expect(ruleProblem(rule({ match: { from: ' ' } }))).toBe('Add at least one condition')
  expect(ruleProblem(rule({ actions: {} }))).toBe('Choose at least one thing to do')
  expect(ruleProblem(rule({ actions: { star: true } }))).toBeNull()
})
