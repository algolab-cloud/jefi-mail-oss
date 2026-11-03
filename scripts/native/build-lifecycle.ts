import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const commandLineTools = '/Library/Developer/CommandLineTools'

/** Compiles scripts/native/lifecycle.m to `out`: used by the bundle and by scripts/shot-menubar.ts. */
export function buildLifecycleHelper(out: string) {
  execFileSync(
    'xcrun',
    [
      'clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-fmodules', '-mmacosx-version-min=13.0', '-dynamiclib',
      '-framework', 'Foundation', '-framework', 'AppKit',
      `${import.meta.dir}/lifecycle.m`,
      '-install_name', '@rpath/libJefiLifecycle.dylib',
      '-o', out,
    ],
    {
      stdio: 'inherit',
      // Same as the other helpers: an unaccepted full Xcode makes xcrun fail, the Command Line Tools don't.
      env: process.env.DEVELOPER_DIR || !existsSync(`${commandLineTools}/usr/bin/clang`) ? process.env : { ...process.env, DEVELOPER_DIR: commandLineTools },
    },
  )
}
