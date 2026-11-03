import { createContext, useContext, useState, type ReactNode } from 'react'
import type { IconName } from './icons'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './ui'

// ---------------------------------------------------------------------------
// Right-click menus. One host at the app root; anything can open it at the pointer with a list
// of items. GPUIX sends right-clicks as `onAuxClick` with `isRightClick`.
// ---------------------------------------------------------------------------

export type ContextItem =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; checked?: boolean; testId?: string }
  | { heading: string }
  | 'separator'

/** The right-click a row's `onAuxClick` gets. */
export type ContextEvent = { isRightClick?: boolean; button?: number; x?: number; y?: number }

type Open = (items: ContextItem[], at: { x?: number; y?: number }) => void
type MenuState = { items: ContextItem[]; x: number; y: number } | null

const ContextMenuContext = createContext<{ open: Open; menu: MenuState; close: () => void }>({ open: () => {}, menu: null, close: () => {} })

/** Holds the open menu; <ContextMenuHost/> draws it inside the app shell (like the Toaster). */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState>(null)
  const value = { menu, open: ((items, at) => setMenu({ items, x: at.x ?? 0, y: at.y ?? 0 })) as Open, close: () => setMenu(null) }
  return <ContextMenuContext.Provider value={value}>{children}</ContextMenuContext.Provider>
}

export function ContextMenuHost() {
  const { menu, close } = useContext(ContextMenuContext)
  if (!menu) return null
  return (
    <Menu open onClose={close} position={{ x: menu.x, y: menu.y }} width={230} testId="context-menu">
      {menu.items.map((item, index) =>
        item === 'separator' ? (
          <MenuSeparator key={index} />
        ) : 'heading' in item ? (
          <MenuLabel key={index}>{item.heading}</MenuLabel>
        ) : (
          <MenuItem
            key={index}
            icon={item.icon}
            label={item.label}
            danger={item.danger}
            checked={item.checked}
            testId={item.testId}
            onSelect={() => {
              close()
              item.onSelect()
            }}
          />
        ),
      )}
    </Menu>
  )
}

/** Returns an `onAuxClick` handler that opens `items()` at the pointer on right-click. */
export function useContextMenu() {
  const { open } = useContext(ContextMenuContext)
  return (items: () => ContextItem[]) => (event: ContextEvent) => {
    if (!event.isRightClick && event.button !== 2) return
    open(items(), event)
  }
}
