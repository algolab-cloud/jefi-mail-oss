import { afterAll, expect, test } from 'bun:test'
import { createTestRoot } from '@gpuix/react/testing'
import { BidiText, bidiWords } from './bidi-text'

// Right-to-left subjects: truncated in reading order (the @gpuix/react patch isolates runs against
// the paragraph's direction) and wrapped in reading order (BidiText).

const RLI = '\u2067'
const LRI = '\u2066'
const PDI = '\u2069'

test('a mostly Arabic title reads right to left, with an English phrase kept together', () => {
  expect(bidiWords('Re: اجتماع فريق التسويق')).toEqual({ dir: 'rtl', items: [['Re:'], 'اجتماع', 'فريق', 'التسويق'] })
  expect(bidiWords('Invoice for the whole team from محمد')).toEqual({ dir: 'ltr', items: ['Invoice', 'for', 'the', 'whole', 'team', 'from', ['محمد']] })
  expect(bidiWords('תכנון השבוע Jefi Calendar ו-2026 הבא').items).toEqual(['תכנון', 'השבוע', ['Jefi', 'Calendar'], 'ו-2026', 'הבא'])
})

const rendererSupported = process.platform !== 'linux'
const app = rendererSupported ? createTestRoot({ width: 600, height: 200 }) : (null as unknown as ReturnType<typeof createTestRoot>)
afterAll(() => app?.unmount())

test.skipIf(!rendererSupported)('mixed-direction text reaches the renderer with the other direction isolated; one-direction text as is', () => {
  app.render(
    <div style={{ width: 600, display: 'flex', flexDirection: 'column' }}>
      <text>Re: اجتماع فريق</text>
      <text>مرحبا team notes شكرا</text>
      <text>Plain English subject</text>
      <text>اجتماع فريق التسويق</text>
    </div>,
  )
  app.renderer.flush()
  const painted = app.renderer.getPaintedText()
  expect(painted).toContain(`Re: ${RLI}اجتماع فريق${PDI}`)
  expect(painted).toContain(`مرحبا ${LRI}team notes${PDI} شكرا`)
  expect(painted).toContain('Plain English subject')
  expect(painted).toContain('اجتماع فريق التسويق')
})

test.skipIf(!rendererSupported)('BidiText is a plain text for left-to-right text, and a word per element for right-to-left', () => {
  const style = { fontSize: 14, lineHeight: 18, color: '#FFFFFF', fontFamily: 'Geist' }
  app.render(
    <div style={{ width: 600, display: 'flex', flexDirection: 'column' }}>
      <BidiText text="An English title" style={style} testId="ltr" />
      <BidiText text="اجتماع فريق التسويق" style={style} testId="rtl" />
    </div>,
  )
  app.renderer.flush()
  const painted = app.renderer.getPaintedText()
  expect(painted).toContain('An English title')
  // Reversed for the wrap-reverse row, so the first word ends up at the top right.
  const words = painted.filter((t) => ['اجتماع', 'فريق', 'التسويق'].includes(t))
  expect(words).toEqual(['التسويق', 'فريق', 'اجتماع'])
})
