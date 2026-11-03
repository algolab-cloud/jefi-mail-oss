# Contributing to Jefi Mail

Thanks for helping. Bug reports, fixes and features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Never include real mail, addresses, passwords or API keys in issues, tests or screenshots. Tests
  use made-up `example.com` addresses and the fake servers and seeded mailboxes in `src/engine/testing/`.

## Working on the code

```bash
bun install
bun run dev                 # the app, with hot reload
bun run typecheck
bun test ./src ./scripts
```

Match the code around you: small modules, a short comment that says why, and a test beside each
module (`thing.ts` with `thing.test.ts`). UI copy is plain and short, in sentence case.

## Pull requests

- Keep each one to a single change, with tests for new behaviour.
- CI runs the typecheck and the test suite on Linux, and the native smoke tests on macOS.
- By sending a pull request you agree that your contribution is licensed under the project's
  licence, GPL-3.0-or-later.
