// ---------------------------------------------------------------------------
// Video meeting links: which service a link belongs to, so the editor can say "Zoom" beside a
// pasted link and the calendar can offer "Join". Jefi doesn't create meetings (that takes each
// service's sign-in); the person pastes a link they already have, like their Zoom personal room.
// ---------------------------------------------------------------------------

export type MeetingProviderId = 'zoom' | 'meet' | 'teams' | 'webex' | 'whereby' | 'jitsi' | 'facetime' | 'slack' | 'discord'

export type MeetingProvider = { id: MeetingProviderId; label: string }

const PROVIDERS: Array<MeetingProvider & { host: RegExp }> = [
  { id: 'zoom', label: 'Zoom', host: /(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/ },
  { id: 'meet', label: 'Google Meet', host: /^meet\.google\.com$/ },
  { id: 'teams', label: 'Microsoft Teams', host: /^teams\.(microsoft|live)\.com$/ },
  { id: 'webex', label: 'Webex', host: /(^|\.)webex\.com$/ },
  { id: 'whereby', label: 'Whereby', host: /(^|\.)whereby\.com$/ },
  { id: 'jitsi', label: 'Jitsi Meet', host: /^(meet\.jit\.si|8x8\.vc)$/ },
  { id: 'facetime', label: 'FaceTime', host: /^facetime\.apple\.com$/ },
  { id: 'slack', label: 'Slack huddle', host: /(^|\.)slack\.com$/ },
  { id: 'discord', label: 'Discord', host: /^(discord\.gg|discord\.com)$/ },
]

const hostOf = (link: string) => {
  try {
    return new URL(link).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The service a link is a meeting on, or null for any other link (or text that isn't one). */
export function meetingProvider(link: string | null | undefined): MeetingProvider | null {
  const host = hostOf(link?.trim() ?? '')
  const found = host ? PROVIDERS.find((p) => p.host.test(host)) : undefined
  return found ? { id: found.id, label: found.label } : null
}

/**
 * What the meeting-link field holds, as a link to store: "zoom.us/j/123" gains its https://, and
 * anything that isn't a web link is null.
 */
export function meetingLink(text: string | null | undefined): string | null {
  const raw = text?.trim() ?? ''
  if (!raw || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname.includes('.')) return null
    return url.href
  } catch {
    return null
  }
}

/** Every https link in some text, trailing punctuation dropped. */
export const httpsLinks = (text: string | null | undefined) =>
  [...(text ?? '').matchAll(/https:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''))

/** The first link to a meeting service in these texts, in order. */
export function findMeetingLink(...texts: Array<string | null | undefined>): string | null {
  return texts.flatMap(httpsLinks).find((link) => meetingProvider(link) !== null) ?? null
}

/**
 * The link to join an event: a meeting service's link from its link, place or notes. Any other link
 * set on it counts only for the person's own events; an invite's could lead anywhere.
 */
export function joinLink(event: { url: string | null; location: string | null; description: string | null; invite: unknown }): string | null {
  const own = meetingLink(event.url)
  return findMeetingLink(own, event.location, event.description) ?? (event.invite ? null : own)
}
