# Verifying AI features live

The tests use a fake Codex binary and a local fake API server, so no real key or login is ever used.
These steps need your own key or Codex login. Each takes a few minutes, and the API ones cost a few cents.

## Before you start

1. Open Settings > AI. Check that **Use AI features** is off and that there is no AI button in the reader or the composer.
2. With AI off, open a conversation and the Assistant. Nothing should offer to run.

## Anthropic (your API key)

1. Create a key at console.anthropic.com > API keys.
2. In Settings > AI, choose **Claude**, paste the key, and press **Save key**. You should see "Key saved to your Keychain", and **Use AI features** turns on.
3. In Keychain Access, look for the service `app.jefi.ai`, account `anthropic`.
4. Model: leave it on **Default · claude-sonnet-5**. Open the menu and check that the list loads from your key.
5. Open a conversation and click the sparkles button in the reader toolbar ("Summarize with Claude"). The summary should appear as it is written. Then try:
   - the sparkles button in the reply box ("Draft a reply with Claude")
   - the sparkles button in a new email's toolbar ("Write with Claude"), and one rewrite option from the same menu
6. Assistant: ask "Catch me up on unread mail", then "star the first one". The star should change, with an Undo toast.
7. Errors:
   - Paste `sk-ant-invalid` as a new key. You should see "Anthropic rejected this API key".
   - Turn off Wi-Fi and summarize. You should see "Couldn't reach Anthropic. Check your connection".
8. Remove the key. **Use AI features** turns off and the Keychain item is gone.

## OpenAI (your API key)

Repeat the Anthropic steps with **OpenAI > API key** and a key from platform.openai.com. The default model is `gpt-5.4-mini`. The error messages say "OpenAI" instead of "Anthropic".

## OpenAI (your Codex CLI login)

1. Run `npm i -g @openai/codex`, then `codex login`.
2. In Settings > AI, choose **OpenAI > ChatGPT plan**. It should say "Signed in", and the **Codex CLI** row shows the path Jefi found.
3. Summarize a conversation and use the Assistant as in the Anthropic steps.
4. Errors:
   - Run `codex logout`, then press **Check again**. You should see "Not signed in to ChatGPT. Run codex login in Terminal, then check again in Settings."
   - Under **Codex CLI**, press **Choose…** and pick a file that isn't codex, such as `/bin/echo`. Or set a path that doesn't exist. You should see an error rather than a hang.
5. Run `codex login` again, press **Clear** on the path, then press **Check again**.

## Report back

Note anything where the wording, timing, or what was sent doesn't match the "AI features" section of the privacy page (`src/routes/privacy.tsx` in the website repo).
