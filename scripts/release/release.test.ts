import { expect, test } from 'bun:test'
import { nextVersion } from './release'

test('a keyword moves one part and resets the ones after it', () => {
  expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1')
  expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0')
  expect(nextVersion('0.9.4', 'major')).toBe('1.0.0')
  expect(nextVersion('1.9.9', 'patch')).toBe('1.9.10')
})

test('an exact version is taken as given; anything else is refused', () => {
  expect(nextVersion('0.1.0', '0.3.0')).toBe('0.3.0')
  expect(nextVersion('0.1.0', 'v0.3.0')).toBeNull()
  expect(nextVersion('0.1.0', '0.3')).toBeNull()
  expect(nextVersion('0.1.0', 'latest')).toBeNull()
})
