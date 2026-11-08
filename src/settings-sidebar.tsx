import React, { useState } from 'react'
import { FONT, TOPBAR_HEIGHT, useSettings } from './theme'
import { NavRow, SectionHeader } from './sidebar'
import { SETTINGS_GROUPS, searchSettings, showSettingsPage, useSettingsPage } from './settings-pages'
import { TextInput } from './ui'

// ---------------------------------------------------------------------------
// Settings' own navigation: its pages in groups. It takes the sidebar's place while Settings is
// open (like Calendar's and Tasks'), or sits inside the pane when the sidebar is hidden.
// ---------------------------------------------------------------------------

/** The grouped list of pages, with a search over what's on them. */
export function SettingsNav() {
  const { C } = useSettings()
  const page = useSettingsPage()
  const [query, setQuery] = useState('')
  const found = new Set(searchSettings(query).map((p) => p.id))
  const groups = SETTINGS_GROUPS.map((group) => ({ ...group, pages: group.pages.filter((p) => found.has(p.id)) })).filter((group) => group.pages.length)
  return (
    <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 4, flexShrink: 0 }}>
        <TextInput testId="settings-search" value={query} placeholder="Search settings" onChange={setQuery} onEnter={() => groups[0] && showSettingsPage(groups[0].pages[0]!.id)} />
      </div>
      <div testId="settings-nav" style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', paddingLeft: 10, paddingRight: 10, paddingBottom: 12 }}>
        {groups.length === 0 ? (
          <text testId="settings-search-empty" style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT, paddingLeft: 8, paddingTop: 14 }}>No settings match</text>
        ) : (
          groups.map((group, index) => (
            <div key={group.label ?? `group-${index}`} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              {group.label ? <SectionHeader label={group.label} /> : <div style={{ height: 14, flexShrink: 0 }} />}
              {group.pages.map((item) => (
                <NavRow key={item.id} icon={item.icon} label={item.label} active={page === item.id} onSelect={() => showSettingsPage(item.id)} testId={`settings-nav-${item.id}`} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** The column beside the app rail while Settings is open. */
export function SettingsSidebar() {
  const { C } = useSettings()
  return (
    <div testId="settings-sidebar" style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, paddingLeft: 16, paddingRight: 12, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <text style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Settings</text>
      </div>
      <SettingsNav />
    </div>
  )
}
