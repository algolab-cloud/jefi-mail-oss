import { FONT, useSettings } from './theme'
import { Button } from './ui'
import { disablePhishingDatabase, usePhishingDatabase } from './use-phishing-database'
import { SettingsRow, Switch } from './settings'

export function LinkProtectionSettings() {
  const { settings, update: updateSettings, C } = useSettings()
  const enabled = settings.phishingListEnabled
  const { status, update } = usePhishingDatabase(enabled)
  const busy = status?.loading || status?.updating
  const count = (status?.domainCount ?? 0) + (status?.urlCount ?? 0)
  const source = status?.source === 'github-snapshot'
    ? 'Official GitHub snapshot'
    : status?.source === 'published-checksum' ? 'Published feed' : null
  const summary = status?.updatedAt
    ? `${count.toLocaleString()} entries${source ? ` · ${source}` : ''} · Updated ${new Date(status.updatedAt).toLocaleString()}${status.stale ? ' · Update due' : ''}`
    : busy ? 'Downloading the phishing database…' : 'No phishing database downloaded yet'
  return (
    <>
      <SettingsRow title="Phishing.Database" sub="Optional · Check links against a downloaded public phishing list on this Mac">
        <Switch testId="toggle-phishing-list" value={enabled} onChange={(phishingListEnabled) => {
          if (!phishingListEnabled) disablePhishingDatabase()
          updateSettings({ phishingListEnabled })
        }} />
      </SettingsRow>
      {enabled ? (
        <div style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <text testId="phishing-database-status" style={{ flexGrow: 1, minWidth: 0, fontFamily: FONT, fontSize: 12, lineHeight: 17, color: C.secondary }}>{summary}</text>
            <Button label={busy ? 'Updating…' : 'Update now'} onClick={() => { void update() }} disabled={!!busy || !status} testId="phishing-database-update" />
          </div>
          <text style={{ fontFamily: FONT, fontSize: 12, lineHeight: 17, color: C.muted }}>
            Lists update every six hours while in use. Downloads contain no email links. Trusted domains still receive reported-phishing warnings.
          </text>
          {status?.lastError ? <text testId="phishing-database-error" style={{ fontFamily: FONT, fontSize: 12, lineHeight: 17, color: C.amber }}>
            {`Update unavailable: ${status.lastError}${status.updatedAt ? ' The last downloaded database is still in use.' : ' Links have not been checked against a downloaded database.'}`}
          </text> : null}
        </div>
      ) : null}
    </>
  )
}
