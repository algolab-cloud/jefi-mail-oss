// ---------------------------------------------------------------------------
// What Settings → Integrations shows for hooking AI apps and scripts up to Jefi: the command that
// starts the headless modes, and the config snippets for the apps that take one.
// ---------------------------------------------------------------------------

/**
 * The command line that runs Jefi's executable: the app's own binary once bundled
 * (/Applications/Jefi.app/Contents/MacOS/Jefi), `bun src/mail.tsx` from a checkout.
 */
export function jefiCommand(): string[] {
  const standalone = typeof Bun !== 'undefined' && Bun.isStandaloneExecutable
  return standalone ? [process.execPath] : [process.execPath, `${import.meta.dir}/../mail.tsx`]
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

export type SetupSnippet = { id: string; title: string; where: string; text: string }

export function setupSnippets(command = jefiCommand()): SetupSnippet[] {
  const [bin, ...pre] = command as [string, ...string[]]
  const args = [...pre, 'mcp']
  const server = { command: bin, args }
  return [
    {
      id: 'claude',
      title: 'Claude Desktop',
      where: 'Settings → Developer → Edit Config (claude_desktop_config.json)',
      text: JSON.stringify({ mcpServers: { jefi: server } }, null, 2),
    },
    {
      id: 'codex',
      title: 'Codex',
      where: '~/.codex/config.toml',
      text: `[mcp_servers.jefi]\ncommand = ${JSON.stringify(bin)}\nargs = ${JSON.stringify(args)}`,
    },
    {
      id: 'other',
      title: 'Tinycast and other MCP apps',
      where: 'A stdio server with this command',
      text: [bin, ...args].map(quote).join(' '),
    },
    {
      id: 'cli',
      title: 'Command line',
      where: 'Read-only: accounts, unread, search, inbox, thread, today, agenda, events, invites, notes, note',
      text: `${[...command, 'cli'].map(quote).join(' ')} today`,
    },
  ]
}

/**
 * A snippet as Settings paints it, one entry per line, so a long path wraps inside its block instead
 * of running off the edge: a zero-width space after each / - _ . , = gives the line somewhere to
 * break, and leading indentation becomes no-break spaces so it isn't collapsed. For display only:
 * Copy copies the snippet's own text.
 */
export const snippetDisplayLines = (text: string): string[] =>
  text.split('\n').map((line) => {
    const indent = /^ */.exec(line)![0].length
    return ' '.repeat(indent) + line.slice(indent).replace(/([/\-_.,=])(?=\S)/g, '$1​')
  })
