// ---------------------------------------------------------------------------
// Tracking pixels: the invisible images a sender puts in mail to learn when, where and on what it was
// opened. Remote images are hidden until the reader asks for them (html-view.tsx); trackers stay out
// even then, so "Show images" shows the pictures and still tells the sender nothing.
// ---------------------------------------------------------------------------

/** Every <img> tag, with its attributes. */
const IMG = /<img\b[^>]*>/gi

const attribute = (tag: string, name: string) => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

/** Addresses of the open-tracking services mail goes out through, and the shape their pixels take. */
const TRACKING_URL =
  /(?:\/(?:wf\/open|open\.(?:aspx|php|gif)|track\/open|trk\/open|e\/o|o\/[\w-]{8,}|pixel(?:\.gif|\.png)?|beacon|imp(?:ression)?)\b|[?&](?:open|track|tracking|utm_medium=email_open)=|\b(?:list-manage\.com\/track|mandrillapp\.com\/track|sendgrid\.net\/wf|mailgun\.org\/o|sparkpostmail\.com\/q|hubspotemail\.net|exct\.net\/open|mailtrack\.io|mixmax\.com\/api\/track|getnotify\.com|bananatag|yesware|streak\.com\/.*track|superhuman\.com\/.*\.gif))/i

const REMOTE = /^\s*(?:https?:)?\/\//i

/** Whether an <img> tag is a tracker: remote, and invisible or from a tracking service. */
export function isTracker(tag: string): boolean {
  const src = attribute(tag, 'src') ?? ''
  if (!REMOTE.test(src)) return false
  if (TRACKING_URL.test(src)) return true
  const tiny = (value: string | null) => value !== null && /^\s*[0-3](?:\.\d+)?\s*(?:px)?\s*$/i.test(value)
  if (tiny(attribute(tag, 'width')) || tiny(attribute(tag, 'height'))) return true
  const style = (attribute(tag, 'style') ?? '').toLowerCase()
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0|(?:^|;)\s*(?:width|height)\s*:\s*[0-3](?:px)?\s*(?:;|$)/.test(style)) return true
  return false
}

/** How many tracking pixels a message carries. */
export const countTrackers = (html: string) => [...html.matchAll(IMG)].filter((match) => isTracker(match[0])).length

/** The message without its tracking pixels: what's shown once remote images are allowed. */
export const withoutTrackers = (html: string) => html.replace(IMG, (tag) => (isTracker(tag) ? '' : tag))
