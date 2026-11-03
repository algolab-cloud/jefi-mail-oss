# Email link protection

Email links open a review popover before leaving Jefi. Plain-text links, simplified
HTML rendered as Markdown, and the Full HTML reader share the same URL assessment.
Unsupported schemes cannot be opened. `mailto:` creates a draft for review.

The popover shows the parsed destination, sender-domain comparison, and warnings
for unencrypted HTTP, embedded credentials, IP addresses, internationalized
hostnames, unusual ports, and recognized URL shorteners. No destination is visited
to expand redirects. A matching From-address domain does not authenticate a sender.

## Trusted domains

Settings accepts exact destination hosts. It normalizes case and internationalized
names, rejects wildcard entries, and does not automatically trust subdomains.
Trust suppresses the sender-domain mismatch warning only. It never suppresses
other URL warnings or threat-list matches, and does not allow remote images.

## Downloaded phishing lists

Jefi downloads the active domain and URL lists published by
[Phishing.Database](https://github.com/Phishing-Database/Phishing.Database). It
first uses the project's documented `phish.co.za/latest` files together with the
SHA-256 values from the project's checksum repository. If that host is unavailable,
Jefi falls back to the same project's official GitHub repository. The fallback pins
one commit, reads the file sizes and blob hashes from that commit's Git tree, and
downloads both files at the immutable commit URL. It verifies the byte count and Git
blob hash before parsing either file. Metadata-provided download URLs are ignored.

The local snapshot is stored under the Jefi configuration directory in
`link-protection/`. Updates validate both lists and their provenance before atomically
replacing the snapshot. A failed primary download only activates the GitHub fallback
after that snapshot passes its own independent checks. If both sources fail, no new
database is activated and the previous snapshot remains available. Settings shows
the source, last successful update, entry count, update errors, and an **Update now**
button.
Automatic updates are limited to once every six hours while the protection UI is
in use. Checks continue offline against the last downloaded snapshot, with stale
data identified in the popover.

Domain entries match the exact host. URL entries match the normalized URL, ignoring
fragments; a listed URL does not blacklist an entire shared hosting provider.
A missing match is not proof of safety. The feed's MIT notice is retained in the
repository's third-party notices and included in the macOS app bundle.

## Optional Google Web Risk

Each person supplies their own Google Cloud API key with the Web Risk API enabled.
Use the official [Web Risk setup guide](https://docs.cloud.google.com/web-risk/docs/detect-malicious-urls)
and restrict the key to the Web Risk API. Google Cloud billing and quotas belong to
that person's project; see [current pricing](https://cloud.google.com/web-risk/pricing).
Jefi uses Web Risk because Google's Safe Browsing API is restricted to
non-commercial use.

Add the key in Settings. Jefi stores it in macOS Keychain, outside settings JSON.
**Save and check** verifies API access using a fixed public example URL, not an
email link. Removing the key clears it from Keychain and clears cached results.

In a web-link popover, **Check with Google** sends that full URL to the Web Risk
Lookup API. This can include private query tokens. The popover discloses this
before the action; reading, hovering, and opening the popover do not perform a
Google lookup. Jefi does not submit email contents or train a model with the link.

The check covers phishing/social engineering, malware, and unwanted software.
The UI separates a threat match, no match, a pending check, an unavailable check,
and an expired result. Positive results are cached in memory only until Google's
expiry (with a local upper bound). No-match results are not cached. Google warnings
include attribution, qualified risk language, and educational links as required
by [Google's user-warning guidance](https://docs.cloud.google.com/web-risk/docs/user-warnings).

This integration uses the **Lookup API**, not Google's local hash-prefix Update
API. Google's lists are not copied into the Phishing.Database snapshot.

### Live API-key smoke check

After enabling billing and `webrisk.googleapis.com` in the Google Cloud project,
run `bun run smoke:web-risk`. The script reads the key from a hidden terminal
prompt, makes one lookup for `https://example.com/` and one for Google's documented
malware test URL, and fails unless the results are respectively no-match and
`MALWARE`. It sends only Lookup API requests to Google; it never visits either URL.

For a non-interactive CI job, provide the key through the protected
`JEFI_WEB_RISK_API_KEY` environment variable. The script does not accept keys in
command-line arguments, print them, save them to settings, or write them to
Keychain. A successful smoke check verifies access and response shape at that
moment; a no-match for another URL is still not proof that the URL is safe.

## Renderer boundary

Email JavaScript stays disabled, remote-image permissions stay separate, and the
Full HTML navigation delegate cancels navigation before requesting review in Jefi.
The browser is opened only by the popover confirmation action. Full HTML exposes the
literal `href` on pointer hover and keyboard focus with app-owned CSS; this does not
run message code or resolve the destination.

Jefi's pinned GPUIX addon exposes the renderer's exact Markdown link ranges for
pointer hover, keyboard focus, and activation. Hover or Tab focus now discloses the
literal destination beside the inline text while preserving native wrapping,
typography, tables, code, emoji offsets, selection, and copying. Enter, Space, and
pointer click route through the same review popover; none opens a destination
directly.

Simplified and Full views retain the compact **Links in this message** index as a
redundant review surface. It covers inline, reference, angle-autolink, and bare
Markdown destinations in source order. Inline disclosure and the index perform no
Google lookup, feed update, DNS resolution, or destination request.
