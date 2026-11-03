# Security

Jefi Mail holds people's mail, passwords and keys, so security reports are welcome and taken
seriously.

## Reporting a vulnerability

Please report privately, not in a public issue:

- **GitHub:** [Report a vulnerability](https://github.com/algolab-cloud/jefi-mail-oss/security/advisories/new)
  (the Security tab → "Report a vulnerability"). This is the best way: it keeps the report
  private and lets us work on a fix and an advisory together.
- **Email:** hello@jefi.app, with "Security" in the subject, if you can't use GitHub.

Include what you found, how to reproduce it, and what an attacker could do with it. Never send
real mail, passwords or other people's data. A made-up message that triggers the problem is
enough.

We'll confirm we've received it within a few days, keep you posted while we fix it, and credit
you in the advisory unless you'd rather we didn't. Please give us a reasonable time to ship a fix
before you talk about it publicly.

## What's in scope

The app and everything in this repository, especially:

- reading mail: HTML rendering, remote content and tracker blocking, link review, attachments;
- the sync engine: IMAP, SMTP, OAuth and how mail is stored on the Mac;
- secrets: the encrypted vault and its key in the macOS Keychain;
- the updater, which must only ever install builds signed by Jefi;
- `jefi://` links and the Raycast extension;
- the release workflow and anything that could get an unreviewed change into a signed build.

Bugs in your mail provider's servers, or in macOS itself, are out of scope here; please report
them to their owners.

## Supported versions

Fixes go into the latest release; Jefi updates itself, so that's the version to test against.

## Verifying a download

Every official DMG is signed, notarized, and has a build attestation linking it to the commit it
was built from:

```bash
gh attestation verify Jefi-<version>.dmg -R algolab-cloud/jefi-mail-oss
```
