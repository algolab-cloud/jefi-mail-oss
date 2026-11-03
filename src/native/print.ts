import { alloc, available, cls, loadAppKit, msg, msgBool, msgDouble, msgInt, msgRectReturn, nsString, release } from './objc'

// Fits within both Letter and A4 after the explicit 0.75-inch page margins below.
const PRINT_WIDTH = 480
const PRINT_MARGIN = 54

function runPrint(title: string, text: string): boolean {
  if (!available) return false
  loadAppKit()
  const document = `${title}\n\n${text}`
  // The frame origin also matters for AppKit's final partial page. Without the
  // vertical origin, the last page is anchored to the paper edge and loses its
  // top margin even though full pages honor NSPrintInfo's margin.
  const view = msgRectReturn(alloc('NSTextView'), 'initWithFrame:', 0, PRINT_MARGIN, PRINT_WIDTH, 1)
  if (!view) return false
  let printInfo: ReturnType<typeof msg> = null
  try {
    msgBool(view, 'setEditable:', false)
    msgBool(view, 'setHorizontallyResizable:', false)
    msgBool(view, 'setVerticallyResizable:', true)
    msg(view, 'setString:', nsString(document))
    // Let AppKit's text system measure the actual glyphs and wrapping. Character-count
    // estimates can truncate wide scripts and can create a blank page for short mail.
    msg(view, 'sizeToFit')
    msgBool(view, 'setVerticallyResizable:', false)
    printInfo = msg(msg(cls('NSPrintInfo'), 'sharedPrintInfo'), 'copy')
    if (!printInfo) return false
    for (const edge of ['Top', 'Bottom', 'Left', 'Right']) msgDouble(printInfo, `set${edge}Margin:`, PRINT_MARGIN)
    // AppKit centers the final, partially filled page by default. Anchor every
    // page to the imageable origin so continuation and final pages keep the
    // same top/left margins as page one.
    msgBool(printInfo, 'setVerticallyCentered:', false)
    msgBool(printInfo, 'setHorizontallyCentered:', false)
    const operation = msg(cls('NSPrintOperation'), 'printOperationWithView:printInfo:', view, printInfo)
    if (!operation) return false
    msgBool(operation, 'setShowsPrintPanel:', true)
    msgBool(operation, 'setShowsProgressPanel:', true)
    return msgInt(operation, 'runOperation') !== 0
  } finally {
    release(printInfo)
    release(view)
  }
}

/**
 * Show the macOS print panel for plain reader text. The panel's PDF menu provides Save as PDF.
 * Plain text is deliberate: printing never evaluates message HTML or loads remote resources.
 */
export function printReaderText(title: string, text: string): boolean {
  return runPrint(title, text)
}
