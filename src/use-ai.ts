import { useSyncExternalStore } from 'react'
import { aiConnection, loadAnthropicKey, loadOpenAIKey, saveAnthropicKey, saveOpenAIKey, testCodex, type AiConnection } from './ai'
import { useSettings } from './theme'
import { setCodexPath } from './codex-path'

// ---------------------------------------------------------------------------
// Whether AI features can run: a saved key (read once from the Keychain) and the Settings switch.
// ---------------------------------------------------------------------------

let anthropicKey: string | null = null
let openAIKey: string | null = null
let keysLoaded = false
let codex: { loaded: boolean; available: boolean; error?: string } = { loaded: false, available: false }
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

void Promise.all([loadAnthropicKey(), loadOpenAIKey()])
  .then(([anthropic, openai]) => {
    anthropicKey = anthropic
    openAIKey = openai
  })
  .catch(() => {})
  .finally(() => {
    keysLoaded = true
    notify()
  })

export async function refreshCodex() {
  codex = { loaded: false, available: false }
  notify()
  const result = await testCodex()
  codex = result.ok ? { loaded: true, available: true } : { loaded: true, available: false, error: result.error }
  notify()
  return result
}

void refreshCodex()

export async function setAnthropicKey(value: string) {
  await saveAnthropicKey(value)
  anthropicKey = value.trim() || null
  notify()
}

export async function setOpenAIKey(value: string) {
  await saveOpenAIKey(value)
  openAIKey = value.trim() || null
  notify()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The saved key (null when there isn't one) and whether AI is switched on and usable. */
export function useAi() {
  const { settings } = useSettings()
  // Before anything spawns the CLI: Settings know where it is when the search can't find it.
  setCodexPath(settings.aiCodexPath)
  const anthropic = useSyncExternalStore(subscribe, () => anthropicKey)
  const openai = useSyncExternalStore(subscribe, () => openAIKey)
  const ready = useSyncExternalStore(subscribe, () => keysLoaded)
  const codexState = useSyncExternalStore(subscribe, () => codex)
  const codexSelected = settings.aiProvider === 'openai' && settings.aiOpenAiMode === 'codex'
  const selectedKey = settings.aiProvider === 'anthropic' ? anthropic : openai
  const available = codexSelected ? codexState.available : !!selectedKey
  const connection = aiConnection(settings, { anthropic, openai }, codexState.available)
  return {
    key: selectedKey,
    anthropicKey: anthropic,
    openAIKey: openai,
    loaded: codexSelected ? codexState.loaded : ready,
    enabled: !!connection,
    available,
    /** Null unless AI is switched on and usable: nothing is sent otherwise. */
    connection,
    provider: settings.aiProvider,
    providerName: settings.aiProvider === 'anthropic' ? 'Claude' : codexSelected ? 'ChatGPT' : 'OpenAI',
    codex: codexState,
  }
}
