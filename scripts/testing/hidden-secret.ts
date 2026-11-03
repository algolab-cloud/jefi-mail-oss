type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGTSTP' | 'SIGCONT'

export type HiddenTerminalRuntime = {
  once(signal: TerminalSignal, listener: () => void): void
  off(signal: TerminalSignal, listener: () => void): void
  restore(): void
  disable(): boolean
  suspend(): void
  exit(code: number): void
  write(text: string): void
}

/** Keep a shell usable if a hidden prompt is interrupted, hung up, or suspended. */
export function guardHiddenTerminal(runtime: HiddenTerminalRuntime): () => void {
  const finish = (code: number) => {
    runtime.restore()
    cleanup()
    runtime.write('\n')
    runtime.exit(code)
  }
  const interrupt = () => finish(130)
  const terminate = () => finish(143)
  const hangup = () => finish(129)
  const resume = () => {
    if (!runtime.disable()) return finish(1)
    runtime.once('SIGTSTP', suspend)
  }
  const suspend = () => {
    runtime.restore()
    runtime.off('SIGTSTP', suspend)
    runtime.once('SIGCONT', resume)
    runtime.suspend()
  }
  const cleanup = () => {
    runtime.off('SIGINT', interrupt)
    runtime.off('SIGTERM', terminate)
    runtime.off('SIGHUP', hangup)
    runtime.off('SIGTSTP', suspend)
    runtime.off('SIGCONT', resume)
  }
  runtime.once('SIGINT', interrupt)
  runtime.once('SIGTERM', terminate)
  runtime.once('SIGHUP', hangup)
  runtime.once('SIGTSTP', suspend)
  return cleanup
}

export async function readHiddenSecret(environmentVariable: string, prompt: string): Promise<string> {
  const fromEnvironment = process.env[environmentVariable]
  if (fromEnvironment !== undefined) return fromEnvironment
  if (!process.stdin.isTTY) throw new Error(`No interactive terminal is available. Set ${environmentVariable} in the process environment.`)

  const terminal = Bun.spawnSync(['stty', '-g'], { stdio: ['inherit', 'pipe', 'pipe'] })
  if (terminal.exitCode !== 0) throw new Error(`Cannot inspect terminal echo settings; use ${environmentVariable} instead.`)
  const savedMode = terminal.stdout.toString().trim()
  const disabled = Bun.spawnSync(['stty', '-echo'], { stdio: ['inherit', 'pipe', 'pipe'] })
  if (!savedMode || disabled.exitCode !== 0) throw new Error(`Cannot hide terminal input; use ${environmentVariable} instead.`)

  const restore = () => { Bun.spawnSync(['stty', savedMode], { stdio: ['inherit', 'pipe', 'pipe'] }) }
  const disable = () => Bun.spawnSync(['stty', '-echo'], { stdio: ['inherit', 'pipe', 'pipe'] }).exitCode === 0
  const cleanup = guardHiddenTerminal({
    once: (signal, listener) => process.once(signal, listener),
    off: (signal, listener) => process.off(signal, listener),
    restore,
    disable,
    suspend: () => process.kill(process.pid, 'SIGTSTP'),
    exit: (code) => process.exit(code),
    write: (text) => process.stdout.write(text),
  })
  process.stdout.write(prompt)
  try {
    for await (const line of console) return line
  } finally {
    restore()
    cleanup()
    process.stdout.write('\n')
  }
  return ''
}
