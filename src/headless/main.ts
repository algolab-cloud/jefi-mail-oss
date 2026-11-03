import { writeSync } from 'node:fs'
import { loadSettings } from '../theme'
import { runCli } from './cli'
import { openJefiData, type JefiData } from './data'
import { serveStdio, type McpContext } from './mcp'
import type { HeadlessMode } from './gate'

/** Runs a headless mode to the end and returns its exit code. Synchronous: see gate.ts. */
export function runHeadless(mode: HeadlessMode, args: string[]): number {
  if (mode === 'cli') {
    const { code, stdout } = runCli(args)
    writeSync(1, stdout)
    return code
  }
  if (!loadSettings().mcpEnabled) {
    writeSync(2, 'Jefi: the MCP server is off. Turn on Settings → Integrations → Allow AI apps to read Jefi (MCP), then restart your AI app.\n')
    return 1
  }
  serveStdio(mcpContext())
  return 0
}

export function mcpContext(): McpContext {
  // Opened on first use and kept; a failed open (no mail.db yet) is tried again on the next call.
  let data: JefiData | null = null
  return {
    data: () => (data ??= openJefiData()),
    open: (url) => {
      const result = Bun.spawnSync(['open', url], { stdout: 'ignore', stderr: 'pipe' })
      if (result.exitCode !== 0) throw new Error(`Couldn't open Jefi: ${result.stderr.toString().trim() || `open exited ${result.exitCode}`}`)
    },
  }
}
