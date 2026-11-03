import { expect, test } from 'bun:test'
import { infoPlist, jefiUrlTypes } from './build-helpers'

test('Info.plist claims jefi:// (and not mailto:) as an array of dictionaries', () => {
  const xml = infoPlist({ CFBundleIdentifier: 'app.jefi.mail', LSUIElement: false, CFBundleURLTypes: jefiUrlTypes('app.jefi.mail') })
  expect(xml).toContain('  <key>LSUIElement</key>\n  <false/>')
  expect(xml).toContain(
    '  <key>CFBundleURLTypes</key>\n  <array>\n    <dict>\n      <key>CFBundleURLName</key>\n      <string>app.jefi.mail</string>\n      <key>CFBundleURLSchemes</key>\n      <array>\n        <string>jefi</string>\n      </array>\n    </dict>\n  </array>',
  )
  expect(xml).not.toContain('mailto')
})

test('Info.plist escapes XML', () => expect(infoPlist({ A: 'a & <b>' })).toContain('<string>a &amp; &lt;b&gt;</string>'))
