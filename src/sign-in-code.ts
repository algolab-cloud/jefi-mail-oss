// ---------------------------------------------------------------------------
// Sign-in codes: the one-time code or the magic link a service mails when someone signs in, found on
// this Mac when the message is stored, so the list, the reader, the banner and the menu bar can offer
// it in one click. Nothing leaves the Mac. Detection errs towards silence: a missed code costs a
// glance at the message, a wrong one (an order number offered as a code) costs trust.
// ---------------------------------------------------------------------------

export type SignIn = { kind: 'code'; code: string } | { kind: 'link'; url: string }

/** Words that say a message is about signing in or proving who you are. */
const ABOUT_SIGN_IN =
  /\b(?:verification|verify|one[- ]?time|passcode|pass code|otp|2fa|two[- ]?factor|two[- ]?step|security code|login code|sign[- ]?in|log[- ]?in|login|authenticat\w*|confirmation code|access code|magic link)\b/i
/** A code introduced as one: "your code is", "code:", "enter". */
const CODE_LEAD = /\b(?:code|passcode|otp|pin|token)\b[^\n\d]{0,40}$|\b(?:enter|use|is)\s*:?\s*$/i
/** What a code looks like: 4–8 digits (maybe split "123 456" / "123-456"), or 6–8 capitals and digits with a digit. */
const CODE = /(?<![\w$€£#.,/:-])(\d{3}[- ]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w%$€£/:.,-]\d|[\w%])/g

/** Strong subjects for a magic link: a mail that is the link, not one that merely mentions signing in. */
const LINK_SUBJECT =
  /\b(?:magic link|sign[- ]?in link|log[- ]?in link|login link|sign[- ]?in to|log[- ]?in to|verify (?:your )?(?:email|e-mail|account|address)|confirm (?:your )?(?:email|e-mail|account|address|sign[- ]?in))\b/i
const LINK_TEXT = /\b(?:sign[- ]?in|log[- ]?in|login|verify|confirm|continue|magic link|open (?:the )?link)\b/i
const LINK_URL = /(?:login|log-in|signin|sign-in|sign_in|magic|verify|verification|confirm|auth|token|otp)/i

/** Text a person reads: tags gone, entities decoded, blocks as lines. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d|table|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
}

/** A plausible code, or null: no years, no times, nothing that reads as money or a reference. */
function asCode(token: string, before: string): string | null {
  const code = token.replace(/[- ]/g, '')
  if (/^\d{4}$/.test(code) && /^(?:19|20)\d\d$/.test(code) && !CODE_LEAD.test(before)) return null
  if (/(?:order|invoice|ticket|case|ref(?:erence)?|account|booking|tracking|no\.?|number|#)\s*:?\s*$/i.test(before)) return null
  return code
}

/** A subject that just says "code" counts too ("123456 is your Facebook code"), unless it's a shop's. */
const CODE_SUBJECT = /\bcode\b/i
const SHOP_CODE = /\b(?:promo|discount|coupon|voucher|zip|postal|referral|gift|offer|source)\b/i

function findCode(subject: string, body: string): string | null {
  const about =
    ABOUT_SIGN_IN.test(subject) || ABOUT_SIGN_IN.test(body.slice(0, 1500)) || (CODE_SUBJECT.test(subject) && !SHOP_CODE.test(subject))
  if (!about) return null
  // The subject first ("Your Acme code is 482913"), then the body's opening, line by line.
  for (const source of [subject, body.slice(0, 3000)]) {
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      for (const match of trimmed.matchAll(CODE)) {
        const before = trimmed.slice(0, match.index)
        // On a line of its own, or introduced as a code.
        const alone = trimmed === match[0]
        if (!alone && !CODE_LEAD.test(before) && !/\b(?:code|passcode|otp)\b/i.test(trimmed)) continue
        const code = asCode(match[0], before)
        if (code) return code
      }
    }
  }
  return null
}

function findLink(subject: string, text: string, html: string | null): string | null {
  if (!LINK_SUBJECT.test(subject)) return null
  if (html) {
    for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["'](https:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = match[1]!.replace(/&amp;/g, '&')
      if (LINK_TEXT.test(htmlText(match[2]!)) || LINK_URL.test(url)) return url
    }
  }
  for (const match of text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) if (LINK_URL.test(match[0])) return match[0]
  return null
}

/** The sign-in code or magic link in a message, or null. */
export function findSignIn({ subject, text, html }: { subject: string; text: string | null; html: string | null }): SignIn | null {
  const body = text ?? (html ? htmlText(html) : '')
  const code = findCode(subject, body)
  if (code) return { kind: 'code', code }
  const url = findLink(subject, body, html)
  return url ? { kind: 'link', url } : null
}

/** How long a code is worth offering: codes expire in minutes, but a pill on yesterday's mail is noise. */
export const SIGN_IN_FRESH_MS = 24 * 60 * 60 * 1000
/** The menu bar lists codes from the last quarter hour. */
export const SIGN_IN_RECENT_MS = 15 * 60 * 1000

export const signInFresh = (at: number | undefined, now = Date.now(), within = SIGN_IN_FRESH_MS) => at !== undefined && now - at < within

export const parseSignIn = (json: string | null | undefined): SignIn | undefined => {
  if (!json) return undefined
  try {
    const value = JSON.parse(json) as SignIn
    return value.kind === 'code' && value.code ? value : value.kind === 'link' && value.url ? value : undefined
  } catch {
    return undefined
  }
}
