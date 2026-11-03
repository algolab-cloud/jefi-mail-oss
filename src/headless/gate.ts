// ---------------------------------------------------------------------------
// The first import of src/mail.tsx: `Jefi cli …` and `Jefi mcp` run here and exit before any other
// module of the app evaluates, so no window, Dock icon or menu bar item ever appears.
//
// Everything below is synchronous, and that is what makes this work: ES modules evaluate their
// imports in order, but a module that awaits lets the ones after it run meanwhile (the UI would
// load). The CLI is sync by nature (bun:sqlite) and the MCP server blocks on stdin reads.
//
// argv is [runtime, script, ...args] both under `bun src/mail.tsx` and in the compiled binary
// (whose script is /$bunfs/root/Jefi), so the mode is always argv[2].
// ---------------------------------------------------------------------------

export type HeadlessMode = 'cli' | 'mcp'

export const headlessMode = (argv: string[]): HeadlessMode | null => (argv[2] === 'cli' || argv[2] === 'mcp' ? argv[2] : null)

const mode = headlessMode(process.argv)
if (mode) {
  // require, not import: the UI build never loads the headless modules.
  const { runHeadless } = require('./main') as typeof import('./main')
  process.exit(runHeadless(mode, process.argv.slice(3)))
}
