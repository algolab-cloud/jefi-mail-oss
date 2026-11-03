import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SYSTEM, execute, toolsFor, type AssistantEvent, type AssistantTools } from './assistant'
import { CODEX_MISSING, codexBinary, codexPath } from './codex-path'
import { codexFailure, missingBinary } from './ai'

// ---------------------------------------------------------------------------
// The Assistant on the person's own Codex CLI login.
//
// Codex can't call into Jefi directly, so for each turn Jefi serves its tools over MCP (the protocol
// Codex uses for external tools) on 127.0.0.1, behind a one-time token, and runs `codex exec` pointed
// at that server alone. Codex's own reach is switched off for these runs: no shell, browser,
// computer use, apps, plugins or image generation, and the person's Codex config (with any other MCP
// servers in it) isn't loaded. The run is ephemeral; earlier turns of the chat are sent as text.
// ---------------------------------------------------------------------------

export type CodexTurn = { role: 'user' | 'assistant'; text: string }


/** Codex features a mail assistant has no business using. */
const DISABLED_FEATURES = ['shell_tool', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'plugins', 'remote_plugin']

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> }

/** A minimal MCP server (streamable HTTP, JSON responses) exposing the Assistant's tools. */
function serveTools(tools: AssistantTools, onEvent: (event: AssistantEvent) => void) {
  const token = crypto.randomUUID()
  let calls = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
      const message = (await req.json()) as Rpc
      // Notifications (no id) just get acknowledged.
      if (message.id === undefined) return new Response(null, { status: 202 })
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result })
      switch (message.method) {
        case 'initialize':
          return reply({ protocolVersion: (message.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jefi', version: '0.1.0' } })
        case 'ping':
          return reply({})
        case 'tools/list':
          return reply({ tools: toolsFor(tools).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) })
        case 'tools/call': {
          const name = String(message.params?.name ?? '')
          const input = (message.params?.arguments ?? {}) as Record<string, unknown>
          const result = await execute(`codex-${++calls}`, name, input, tools, onEvent)
          return reply({ content: [{ type: 'text', text: result.content }], isError: !result.ok })
        }
        default:
          return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, token, stop: () => server.stop(true) }
}

/** The chat so far plus the new request, as one prompt for an ephemeral Codex run. */
function prompt(history: CodexTurn[], context: string) {
  const earlier = history.slice(0, -1)
  const latest = history[history.length - 1]?.text ?? ''
  return [
    SYSTEM,
    'Use only the jefi tools to look at or act on mail. You have no shell or file access and must not ask for it.',
    context,
    earlier.length ? `<earlier_conversation>\n${earlier.map((t) => `${t.role === 'user' ? 'Person' : 'Assistant'}: ${t.text}`).join('\n\n')}\n</earlier_conversation>` : '',
    `The person now says:\n${latest}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Runs one request through the person's Codex CLI. `history` holds the chat as text; the last entry
 * is the new request, and the reply is appended when the run succeeds.
 */
export async function runAssistantCodex(model: string | undefined, history: CodexTurn[], context: string, tools: AssistantTools, onEvent: (event: AssistantEvent) => void, signal?: AbortSignal) {
  const mcp = serveTools(tools, onEvent)
  const directory = mkdtempSync(`${tmpdir()}/jefi-assistant-`)
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '-c',
    `mcp_servers.jefi.url="${mcp.url}"`,
    '-c',
    'mcp_servers.jefi.bearer_token_env_var="JEFI_MCP_TOKEN"',
    // Jefi's own tools, pre-approved: exec runs have no one to ask.
    '-c',
    'mcp_servers.jefi.default_tools_approval_mode="approve"',
    '-c',
    'model_reasoning_effort="medium"',
    ...(model ? ['-c', `model="${model}"`] : []),
    ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
    prompt(history, context),
  ]
  if (!codexPath()) throw new Error(CODEX_MISSING)
  const replies: string[] = []
  try {
    const child = Bun.spawn([codexBinary(), ...args], {
      cwd: directory,
      env: { ...process.env, JEFI_MCP_TOKEN: mcp.token },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    })
    // Codex reports progress as JSON lines; its messages arrive whole, one per step.
    const decoder = new TextDecoder()
    let buffer = ''
    let failure: string | null = null
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let event: { type?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string }
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.trim()) {
          const text = event.item.text.trim()
          onEvent({ type: 'text', text: replies.length ? `\n\n${text}` : text })
          replies.push(text)
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          failure = event.error?.message ?? event.message ?? 'ChatGPT stopped with an error'
        }
      }
    }
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (signal?.aborted) throw new Error('Stopped')
    if (failure) throw new Error(codexFailure(failure, code))
    if (code !== 0) throw new Error(codexFailure(stderr.trim().split('\n').filter((l) => !/Reading additional input/.test(l)).slice(-3).join(' '), code))
    history.push({ role: 'assistant', text: replies.join('\n\n') || '(no reply)' })
  } catch (error) {
    if (missingBinary(error)) throw new Error(CODEX_MISSING)
    throw error
  } finally {
    mcp.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}
