import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Account } from '../../src/engine/../accounts'
import { SECRET_SERVICE } from '../../src/engine/secrets'
import { TEST_SECRETS_ENV, fileKeychain } from '../../src/keychain'
import { selfSignedCert, startFakeSmtp } from '../../src/engine/testing/fake-servers'
import { USER, rawMessage, startImapServer, type TestMessage } from '../../src/engine/testing/imap-server'

// ---------------------------------------------------------------------------
// A ready-to-use mailbox for screenshots and UI flows: an in-memory IMAP server with sample mail, a
// fake SMTP server, and an account already configured in an isolated config directory, so the app
// starts signed in and syncing through the real engine. Demo data lives here, never in src/.
// ---------------------------------------------------------------------------

const DAY = 86_400_000
const now = Date.now()
const at = (daysAgo: number, hour: number) => new Date(new Date(now - daysAgo * DAY).setHours(hour, (hour * 7) % 60, 0, 0))

const from = (name: string, email: string) => ({ name, email })
const PEOPLE = {
  deals: { name: 'Northwind Deals', email: 'news@deals.example' },
  lea: from('Lea Ortiz', 'lea@atlas.dev'),
  kenji: from('Kenji Ito', 'kenji@northlight.co'),
  nora: from('Nora Hale', 'nora@harbor.io'),
  jules: from('Jules Park', 'jules@northlight.co'),
  mira: from('Mira Cole', 'mira@atlas.dev'),
}

type Sample = { n: number; who: keyof typeof PEOPLE; subject: string; text: string; when: Date; seen?: boolean; flagged?: boolean; labels?: string[]; attachment?: { filename: string; content: string }; attachments?: Array<{ filename: string; content: string }>; messageId?: string; inReplyTo?: string; html?: string; list?: boolean }

const SAMPLES: Sample[] = [
  { n: 1, who: 'lea', subject: 'Q3 product review', when: at(0, 10), text: "Here's the deck and a few notes before tomorrow.\n\nThe pricing section still needs your numbers.", attachment: { filename: 'Q3-review.pdf', content: 'deck' }, labels: ['Product'] },
  { n: 2, who: 'kenji', subject: 'Design system updates', when: at(0, 9), text: 'Pushed the latest components and tokens to the shared library.\n\nThe icon set is next.', flagged: true, labels: ['Design'] },
  { n: 3, who: 'nora', subject: 'Re: Customer feedback', when: at(0, 8), text: 'This is super helpful, thank you!\n\nI’ll fold it into the onboarding notes.', seen: true, messageId: '<feedback-2@example.com>', inReplyTo: '<feedback-1@example.com>' },
  { n: 4, who: 'nora', subject: 'Customer feedback', when: at(1, 16), text: 'Three themes came out of this week’s calls: setup, search, and speed.', seen: true, messageId: '<feedback-1@example.com>', labels: ['Customers'] },
  { n: 5, who: 'jules', subject: 'Upcoming launch plan', when: at(1, 7), text: 'Let’s sync on milestones and ownership before the freeze.', seen: true },
  { n: 6, who: 'mira', subject: 'Partnership opportunities', when: at(3, 11), text: 'Would love to explore a partnership with your team next quarter.', seen: true, flagged: true },
  { n: 7, who: 'lea', subject: 'Analytics dashboard v2', when: at(9, 14), text: 'Sharing the latest build for your feedback.', seen: true },
  // A promotional sender with List-Unsubscribe, for Clean up.
  { n: 30, who: 'deals', subject: 'Weekend sale: 30% off', when: at(2, 9), text: 'Everything must go.', seen: true, list: true },
  { n: 31, who: 'deals', subject: 'Last chance', when: at(5, 9), text: 'Ends tonight.', seen: true, list: true },
  { n: 32, who: 'deals', subject: 'New arrivals', when: at(12, 9), text: 'Fresh picks for you.', list: true },
  // An HTML newsletter: rebuilt as safe Markdown in the reader, with its script and pixel dropped.
  {
    n: 8, who: 'jules', subject: 'Northlight weekly', when: at(0, 7), seen: true, text: 'Northlight weekly (plain-text part)',
    html: `<html><head><style>h1{color:red}</style><script>alert('x')</script></head><body>
      <div style="display:none">Preheader you should not see</div>
      <table><tr><td><h1>Northlight weekly</h1>
      <p>Hi Mara, here's what <b>shipped</b> this week:</p>
      <ul><li>Offline sync for <i>everyone</i></li><li>Faster search</li><li>A new <a href="https://jefi.app/changelog">changelog</a></li></ul>
      <blockquote>Mail that finds its own way.</blockquote>
      <p><img src="https://images.example/hero.png" alt="Team photo from the offsite"></p>
      <p><a href="javascript:steal()">Claim your prize</a> · <a href="mailto:hello@northlight.co">hello@northlight.co</a></p>
      <img src="https://track.example/open.gif" width="1" height="1"></td></tr></table></body></html>`,
  },
]

// Mixed types and name lengths for the attachment cards; the content only sets a plausible size.
const filler = (kb: number) => 'x'.repeat(kb * 1024)
const ATTACHMENT_SET = [
  { filename: 'a.pdf', content: filler(84) },
  { filename: 'Q3-board-presentation-final-v7-approved.pptx', content: filler(1400) },
  { filename: 'offsite-team-photo.jpg', content: filler(620) },
  { filename: 'Revenue by region.xlsx', content: filler(38) },
  { filename: 'brand-assets.zip', content: filler(2300) },
  { filename: 'Board meeting.ics', content: filler(2) },
]

const message = (s: Sample): TestMessage => ({
  raw: rawMessage({
    n: s.n,
    subject: s.subject,
    text: s.text,
    date: s.when,
    messageId: s.messageId,
    inReplyTo: s.inReplyTo,
    references: s.inReplyTo ? [s.inReplyTo] : undefined,
    attachment: s.attachment,
    attachments: s.attachments,
    fromName: PEOPLE[s.who].name,
    fromEmail: PEOPLE[s.who].email,
    html: s.html,
    ...(s.list ? { extraHeaders: ['List-Unsubscribe: <https://deals.example/unsubscribe>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] } : {}),
  }),
  flags: [...(s.seen ? ['\\Seen'] : []), ...(s.flagged ? ['\\Flagged'] : [])],
  'X-GM-MSGID': String(9000 + s.n),
  'X-GM-LABELS': s.labels,
})

// Mail with plans in it, for the reader's add-to-calendar suggestions: a meeting at a time, and a
// multi-day range a few weeks out (so both stay in the future whenever the fixture runs).
const offsite = new Date(now + 20 * DAY)
if (offsite.getDate() > 26) offsite.setDate(offsite.getDate() + 7)
const offsiteMonth = offsite.toLocaleString('en-US', { month: 'long' })
const CALENDAR_SAMPLES: Sample[] = [
  { n: 50, who: 'kenji', subject: 'Design review', when: new Date(now - 30 * 60_000), text: 'Hi Mara,\n\nCan we do the design review on Thursday at 3pm? It should take about an hour, in the big room.\n\nKenji' },
  { n: 51, who: 'mira', subject: 'Team offsite', when: new Date(now - 45 * 60_000), text: `The team offsite is set for ${offsiteMonth} ${offsite.getDate()}-${offsite.getDate() + 2} at the lake house.\n\nMira` },
]

/**
 * Edge cases for the list and the reader: very long subjects and names, no subject, right-to-left
 * and emoji text, a long thread, and a reply with quoted history.
 */
const EDGE_SAMPLES: Sample[] = [
  { n: 60, who: 'mira', subject: 'An extraordinarily long subject line that keeps going well past the width of the list column and the reader title so it has to be truncated somewhere sensible', when: at(0, 6), text: 'Long subject body.' },
  { n: 61, who: 'kenji', subject: '', when: at(0, 5), text: 'This message has no subject at all.' },
  { n: 62, who: 'nora', subject: 'مرحبا بالعالم — שלום עולם 🎉✨ 日本語の件名', when: at(0, 4), text: 'نص عربي في الرسالة.\n\nוגם עברית.' },
  { n: 63, who: 'lea', subject: 'Re: Travel plans', when: at(0, 3), text: 'Sounds good to me.\n\nOn Tue, Lea Ortiz wrote:\n> Are we still on for Friday?\n> Let me know.', seen: true },
  ...Array.from({ length: 12 }, (_, i): Sample => ({
    n: 70 + i,
    who: (['lea', 'kenji', 'nora', 'jules'] as const)[i % 4]!,
    subject: i === 0 ? 'Offsite logistics' : 'Re: Offsite logistics',
    when: new Date(at(2, 8).getTime() + i * 3_600_000),
    text: `Message ${i + 1} in the offsite thread.\n\nSome details about item ${i + 1}.`,
    seen: i < 10,
    messageId: `<offsite-${i}@example.com>`,
    inReplyTo: i ? `<offsite-${i - 1}@example.com>` : undefined,
  })),
]

export type Fixture = Awaited<ReturnType<typeof startFixture>>

/** Boots the servers (`inbox` replaces the sample mail, for curated marketing shots), writes the account and its secret, and returns the env the app needs. */
export async function startFixture(dir: string, options: { name?: string; /** Signs in as this address (me@example.com by default), for a second account beside another fixture's. */ email?: string; gmail?: boolean; bulk?: number; newestHtml?: boolean; /** A three-message conversation whose newest message is a long, plain HTML email. */ htmlThread?: boolean; calendar?: boolean; manyAttachments?: boolean; edge?: boolean; inbox?: TestMessage[]; /** Messages in a Spam (\\Junk) folder; without it there is no Spam folder. */ spam?: TestMessage[]; secondAccount?: boolean } = {}) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(`${dir}/config`, { recursive: true })
  const login = { user: options.email ?? USER.user, pass: USER.pass }
  const cert = selfSignedCert()
  writeFileSync(`${dir}/ca.pem`, cert.cert)

  const sent = SAMPLES.slice(2, 3).map((s) => ({ ...message(s), flags: ['\\Seen'] }))
  // A large mailbox for performance checks: plain messages spread over the past year.
  const bulk: TestMessage[] = Array.from({ length: options.bulk ?? 0 }, (_, i) => ({
    raw: rawMessage({
      n: 1000 + i,
      subject: `Bulk message ${i + 1}`,
      text: `Body of bulk message ${i + 1}.`,
      date: new Date(now - (i + 1) * 3_600_000),
      fromName: Object.values(PEOPLE)[i % 5]!.name,
      fromEmail: Object.values(PEOPLE)[i % 5]!.email,
    }),
    flags: i % 3 === 0 ? [] : ['\\Seen'],
  }))
  // An HTML newsletter as the newest message, so the reader opens it in Full HTML at launch.
  // Newest by construction: the samples sit at fixed times of day, so before 10 AM "a minute ago" is
  // older than today's samples and the reader would open a plain message instead of this one.
  const latest = Math.max(now - 60_000, ...SAMPLES.map((s) => s.when.getTime()))
  const newest = options.newestHtml
    ? [message({ ...SAMPLES.find((s) => s.html)!, n: 40, subject: 'Northlight launch notes', when: new Date(latest + 60_000), seen: false })]
    : []
  // A message with a spread of attachment types and name lengths, newest so the reader opens it.
  const attached = options.manyAttachments
    ? [message({ n: 41, who: 'mira', subject: 'Board pack for Thursday', when: new Date(latest + 120_000), text: 'Everything for the board meeting is attached: the deck, numbers, photos and the invite.\n\nShout if anything is missing.', attachments: ATTACHMENT_SET })]
    : []
  // Plain HTML (text styles, no backgrounds): the reader draws it in the app's theme, sized to fit.
  const billing = '<p style="font-family:Arial;color:#222">Hi Mara,</p><p style="font-family:Arial;color:#222">Thanks for the details. Before we set up billing, a few things to confirm.</p>'
    + ['Option A', 'Option B'].map((name) => `<h3 style="color:#111">${name}</h3><p style="color:#222">Meter readings are captured monthly and bills are shared by email and SMS.</p>`).join('')
    + '<h3 style="color:#111">Required for both options</h3><p style="color:#222">Please confirm the tax classifications for:</p><ul><li>Water supply charges</li><li>Any additional charges on your bills <i>(for example, exempt or 16% VAT)</i></li></ul>'
    + '<h3 style="color:#111">Next steps</h3><p style="color:#222">Once we receive your details and complete the setup, we will generate and share <b>sample bills</b> for your review before going live.</p>'
    + '<p style="color:#222">Best regards,<br>Jules Moreau<br><a href="https://northlight.example">Northlight Utilities</a></p>'
  const thread = options.htmlThread
    ? [
        message({ n: 70, who: 'jules', subject: 'Billing setup', when: new Date(latest + 180_000), text: 'Hi Mara, can you share the meter list?', seen: true, messageId: '<billing-1@example.com>' }),
        message({ n: 71, who: 'lea', subject: 'Re: Billing setup', when: new Date(latest + 240_000), text: 'Attached the list. Option B suits us best.', seen: true, messageId: '<billing-2@example.com>', inReplyTo: '<billing-1@example.com>' }),
        message({ n: 72, who: 'jules', subject: 'Re: Billing setup', when: new Date(latest + 300_000), text: 'Thanks for the details.', html: `<html><body>${billing}</body></html>`, seen: false, messageId: '<billing-3@example.com>', inReplyTo: '<billing-2@example.com>' }),
      ]
    : []
  const imap = await startImapServer(
    {
      INBOX: options.inbox ?? [...SAMPLES.map(message), ...newest, ...attached, ...thread, ...(options.calendar ? CALENDAR_SAMPLES.map(message) : []), ...(options.edge ? EDGE_SAMPLES.map(message) : []), ...bulk],
      ...(options.gmail ?? true
        ? {
            '[Gmail]/All Mail': { 'special-use': '\\All', messages: options.inbox ?? [...SAMPLES.map(message), ...bulk] },
            '[Gmail]/Sent Mail': { 'special-use': '\\Sent', messages: sent },
            '[Gmail]/Trash': { 'special-use': '\\Trash', messages: [] },
            ...(options.spam ? { '[Gmail]/Spam': { 'special-use': '\\Junk', messages: options.spam } } : {}),
            Product: [], Design: [], Customers: [],
          }
        : {
            // A plain IMAP server: special-use folders plus custom ones, which the sidebar lists.
            Sent: { 'special-use': '\\Sent', messages: sent },
            Trash: { 'special-use': '\\Trash', messages: [] },
            Projects: [
              message({ n: 20, who: 'mira', subject: 'Roadmap for the offsite', when: at(0, 6), text: 'Filed straight into Projects by a server rule.', seen: false }),
              // A reply filed in Projects to a conversation that started in the Inbox.
              ...(options.edge ? [message({ n: 21, who: 'jules', subject: 'Re: Upcoming launch plan', when: at(0, 2), text: 'Filed the plan under Projects.', seen: true, messageId: '<launch-2@example.com>', inReplyTo: '<m5@example.com>' })] : []),
            ],
            Receipts: [],
          }),
    } as never,
    { gmail: options.gmail ?? true, user: login },
  )
  const smtp = await startFakeSmtp({ cert, users: [login] })

  const account: Account = {
    // Unique per run, so side-by-side runs never mix up accounts or their secrets.
    id: `acct-fixture-${process.pid}-${Date.now().toString(36)}`,
    name: options.name ?? 'Mara Lin',
    email: login.user,
    provider: 'imap',
    face: { letter: 'ML' },
    servers: { imapHost: '127.0.0.1', imapPort: imap.port, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'ssl' },
  }
  // A second account on the same servers (they know one user), for flows that need several, like From.
  const second: Account | null = options.secondAccount ? { ...account, id: `${account.id}-work`, label: 'Work', face: { letter: 'W' } } : null
  const accounts = second ? [account, second] : [account]
  writeFileSync(`${dir}/config/accounts.json`, `${JSON.stringify({ accounts, activeId: account.id }, null, 2)}\n`)
  // Passwords go to a secrets file in the fixture folder, never the login Keychain: the app (and its
  // engine worker) read it through JEFI_TEST_SECRETS_FILE, see src/keychain.ts.
  const secretsFile = `${dir}/secrets.json`
  for (const item of accounts) await fileKeychain(secretsFile).set({ service: SECRET_SERVICE, name: item.id, value: login.pass })

  return {
    imap,
    smtp,
    account,
    second,
    secretsFile,
    env: { JEFI_CONFIG_DIR: `${dir}/config`, JEFI_TEST_CA_FILE: `${dir}/ca.pem`, [TEST_SECRETS_ENV]: secretsFile } as Record<string, string>,
    /** Deliver another message while the app is running (push). */
    deliver: (subject: string, text: string, from: { name: string; email: string } = PEOPLE.jules) =>
      imap.append('INBOX', { raw: rawMessage({ n: 90 + Math.floor(Math.random() * 1000), subject, text, date: new Date(), fromName: from.name, fromEmail: from.email }) }),
    async close() {
      await imap.close()
      await smtp.close()
    },
  }
}
