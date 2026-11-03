// ---------------------------------------------------------------------------
// Every native library the app loads from Contents/Frameworks. scripts/bundle.ts puts them there,
// scripts/release/sign.ts refuses to sign a bundle missing one, and `Jefi cli selftest` loads each
// under the release signature. A test keeps this list and the bundle scripts in step.
// ---------------------------------------------------------------------------

export type NativeHelper = {
  file: string
  kind: 'dylib' | 'napi'
  /** A symbol (dylib) or export (napi) the app uses: finding it proves the file is the right one. */
  symbol: string
}

export const NATIVE_HELPERS: NativeHelper[] = [
  { file: 'libJefiNotifications.dylib', kind: 'dylib', symbol: 'jefi_notifications_start' },
  { file: 'libJefiEditor.dylib', kind: 'dylib', symbol: 'jefi_editor_selection' },
  { file: 'libJefiMailSnapshot.dylib', kind: 'dylib', symbol: 'jefi_mail_snapshot' },
  { file: 'libJefiLifecycle.dylib', kind: 'dylib', symbol: 'jefi_lifecycle_install' },
  { file: 'gpuix-native.darwin-arm64.node', kind: 'napi', symbol: 'markdownLinkEventsVersion' },
]
