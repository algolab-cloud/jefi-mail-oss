import { readFileSync } from 'node:fs'
import { closeMainWindow, lifecycleBackend, mainWindowVisible, showMainWindow } from '../native/app-lifecycle'
import { closePanel, forcePanelAppearance, glassAvailable, panelAppearance, panelScreen, panelScreenFrame, panelShown, panelWindowNumber } from '../native/menubar-popover'
import { showBackdrop, type Backdrop } from './backdrop'
import { parsePanelMessage, type PanelMessage } from './model'

// ---------------------------------------------------------------------------
// A remote control for scripts/shot-menubar.ts, off unless JEFI_MENUBAR_DEBUG names a command file.
// The script writes one command there and sends SIGUSR1; the answer is one `[menubar] …` line on
// stderr. Commands run on the JS thread, which is AppKit's main thread here.
// ---------------------------------------------------------------------------

export function installMenuBarDebug(handlers: { click: () => void; itemFrame: () => { x: number; y: number; width: number; height: number } | null; snapshot: (path: string) => void; act: (message: PanelMessage) => void }) {
  const file = process.env.JEFI_MENUBAR_DEBUG
  if (!file) return () => {}
  const report = (line: string) => process.stderr.write(`[menubar] ${line}\n`)
  const run = () => {
    const command = readFileSync(file, 'utf8').trim()
    if (command === 'click') handlers.click()
    else if (command.startsWith('item-png ')) handlers.snapshot(command.slice(9))
    else if (command === 'close-window') closeMainWindow()
    else if (command === 'close') closePanel()
    else if (command === 'show-window') showMainWindow()
    else if (command.startsWith('backdrop image ')) showBackdrop('image', command.slice(15))
    else if (command.startsWith('backdrop ')) showBackdrop(command.slice(9) as Backdrop)
    else if (command.startsWith('appearance ')) {
      const look = command.slice(11)
      forcePanelAppearance(look === 'light' || look === 'dark' ? look : null)
    } else if (command.startsWith('message ')) {
      const message = parsePanelMessage(command.slice(8))
      if (message) handlers.act(message)
    }
    // Let AppKit settle a frame or two before answering.
    setTimeout(() => report(`${command.split(' ')[0]} visible=${mainWindowVisible() ? 1 : 0} panel=${panelShown() ? 1 : 0} window=${panelWindowNumber()} frame=${(panelScreenFrame() ?? []).map(Math.round).join(',')} screen=${(panelScreen() ?? []).map(Math.round).join(',')} appearance=${panelAppearance()} glass=${glassAvailable() ? 1 : 0} backend=${lifecycleBackend()} item=${Object.values(handlers.itemFrame() ?? {}).map(Math.round).join(',')} pid=${process.pid}`), 400)
  }
  process.on('SIGUSR1', run)
  report(`ready pid=${process.pid}`)
  return () => {
    process.off('SIGUSR1', run)
    showBackdrop('none')
  }
}
