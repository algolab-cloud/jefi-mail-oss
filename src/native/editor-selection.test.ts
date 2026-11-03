import { expect, test } from 'bun:test'
import { editorHelperPath, replaceEditorSelection } from './editor-selection'

test('the signed bundle resolves its app-owned editor helper', () => {
  expect(editorHelperPath('/Applications/Jefi.app/Contents/MacOS/Jefi')).toBe(
    '/Applications/Jefi.app/Contents/Frameworks/libJefiEditor.dylib',
  )
})

test('replacement rejects embedded NUL before crossing FFI', () => {
  expect(replaceEditorSelection({ responderIdentity: 1n, location: 0, length: 0 }, { range: { location: 0, length: 0 }, text: 'bad\0text' })).toBe(false)
})
