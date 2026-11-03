import pkg from '../package.json'

/** The version this build was made from: package.json, baked in by the bundler. */
export const APP_VERSION: string = pkg.version

/** The name macOS shows for the app: the menu bar, window, Dock and Notifications. Matches Info.plist (scripts/bundle.ts). */
export const APP_NAME = 'Jefi Mail'
