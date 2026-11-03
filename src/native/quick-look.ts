/** Show one explicitly selected attachment in macOS Quick Look. Arguments never pass through a shell. */
export async function previewFile(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (process.platform !== 'darwin') return { ok: false, error: 'Quick Look is available on macOS only' }
  try {
    const process = Bun.spawn(['/usr/bin/qlmanage', '-p', path], { stdout: 'ignore', stderr: 'pipe' })
    const code = await process.exited
    if (code === 0) return { ok: true }
    const detail = (await new Response(process.stderr).text()).trim().split('\n').at(-1)
    return { ok: false, error: detail || 'Quick Look could not preview this file' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
