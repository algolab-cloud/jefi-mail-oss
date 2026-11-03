import { useSettings } from './theme'
import { Icon } from './icons'
import type { ProviderId } from './accounts'

// Brand marks: Gmail + Outlook from svgl.app, iCloud from Simple Icons (CC0),
// Fastmail + Yahoo Mail from Wikimedia Commons (public domain). Trademarks of their owners.
import gmail from './assets/providers/gmail.svg' with { type: 'text' }
import outlook from './assets/providers/outlook.svg' with { type: 'text' }
import icloud from './assets/providers/icloud.svg' with { type: 'text' }
import fastmail from './assets/providers/fastmail.svg' with { type: 'text' }
import yahoo from './assets/providers/yahoo.svg' with { type: 'text' }

/**
 * <img> rasterizes an SVG at its own width/height and scales the bitmap, so a mark drawn in a small
 * viewBox (iCloud's is 24 units) came out pixelated. Give every logo an explicit size large
 * enough for the biggest place it's shown, at 2× for Retina.
 */
const RASTER = 256
const toDataUrl = (svg: string) => {
  const box = svg.match(/viewBox="[^"]*?([\d.]+)\s+([\d.]+)"/)
  const [w, h] = box ? [Number(box[1]), Number(box[2])] : [1, 1]
  const scale = RASTER / Math.max(w, h)
  const sized = svg.replace(/<svg\b/, `<svg width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"`)
  return `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`
}

// GPUI's <svg> paints a single tint, so full-colour marks go through <img>.
const LOGOS: Partial<Record<ProviderId, string>> = {
  gmail: toDataUrl(gmail),
  outlook: toDataUrl(outlook),
  icloud: toDataUrl(icloud),
  fastmail: toDataUrl(fastmail),
  yahoo: toDataUrl(yahoo),
}

/** A provider's brand mark fitted into a `size`-tall box (wordmarks may be wider). */
export function ProviderLogo({ id, size = 24 }: { id: ProviderId; size?: number }) {
  const { C } = useSettings()
  const src = LOGOS[id]
  if (!src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.25,
          backgroundColor: C.chip,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          pointerEvents: 'none',
        }}
      >
        <Icon name="server" size={size * 0.58} color={C.secondary} />
      </div>
    )
  }
  const width = id === 'yahoo' ? size * 2.4 : size
  return <img src={src} objectFit="contain" style={{ width, height: size, flexShrink: 0, pointerEvents: 'none' }} />
}
