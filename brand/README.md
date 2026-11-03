# Jefi brand kit

Generated from the source artwork in `assets/icon.svg` (the mark) by `bun run brand`, plus
`assets/logo.svg` (a lockup) if one is added. Edit the sources, then regenerate; don't hand-edit
files here.

## The mark

An envelope with a letter rising out of it and a stamp in its corner, drawn in one even rounded
stroke. It is a single flat shape, so it works as one colour on any background. It is nearly square
(about 1.03 : 1). A solid version is kept in `assets/icon-alt.svg`; it isn't used by the build.

There is no lockup: the mark is the logo. `logo/` holds the mark, and the app's "wordmark" (on the
onboarding and licence screens) shows it too. Add `assets/logo.svg` to bring a lockup back.

The Affinity exports in `assets/` can be replaced as-is: `bun run brand` bakes their transforms into
the paths and crops each one tight to its ink.

## Files

| Folder | Files | Use |
|---|---|---|
| `logo/` | `jefi-logo.svg`, `jefi-logo-white.svg` (+ `.png`, 256 px tall) | The logo: the mark (or a lockup, if `assets/logo.svg` exists). Headers, docs, the website. |
| `mark/` | `jefi-mark.svg`, `jefi-mark-white.svg` (+ `.png` 64 / 256 / 1024 px wide) | The mark alone, where space is tight or the name is already present. |
| `app-icon/` | `jefi-app-icon.svg`, `icon-1024.png`, `icon-<accent>-1024.png`, `AppIcon.icns`, `AppIcon.iconset/` | macOS app and Dock icons. `AppIcon.icns` goes into `Jefi.app`; the running app swaps the Dock icon to match the chosen accent. |
| `web/` | `favicon.svg`, `favicon.ico` (16 / 32 / 48), `apple-touch-icon.png` (180), `logo192.png`, `logo512.png` | Website favicons and web-app manifest icons; also copied to the website repo's `public/` (beside this one as `../website`). |

The app itself uses the single-colour vectors in `src/assets/brand/` (`mark.svg`, `wordmark.svg`,
`avatar.svg`), written by the same script and tinted to the theme at runtime.

## Colour

| Name | Hex | Where |
|---|---|---|
| Jefi violet | `#8B5CF6` | The mark on the app icon (default), and the accent |
| Tile white | `#FFFFFF` → `#ECEDF2` | The app-icon tile, top to bottom |
| Ink | `#000000` | Mark and logo on light backgrounds |
| White | `#FFFFFF` | Mark and logo on dark backgrounds and on the tile |

The app icon is a white tile with the mark in colour, filling most of the tile so it reads at Dock
size. The mark follows the accent the person picks (violet, blue, green, amber, red).

## Usage

- Keep clear space around the mark of at least the width of its stamp.
- Use the mark and logo in one flat colour only: no gradients, outlines or effects (the app icon's
  tile gradient is the one exception).
- Don't redraw or stretch the mark; scale it proportionally.
