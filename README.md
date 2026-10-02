# Poliframe

A desktop photo composition app built with Electron, Vue 3 and standard shadcn-vue components.

Compose horizontal or vertical photo strips and editable recursive grids, crop and rotate photographs, add captions or transparent logos, and export JPEG, PNG or TIFF. The image pipeline uses Sharp/libvips, embedded ICC profiles and ExifTool for selected metadata. PNG and TIFF support real 16-bit output.

## Development

Requires Node.js 24.14+ and pnpm 10.29+. Current development acceptance target: macOS Apple Silicon.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Developer Tools visibility is remembered across starts. Use View → Toggle Developer Tools to open them. Settings and reusable JSON presets are stored in `~/Library/Application Support/Poliframe Electron` on macOS, separately from the native app. Editing sessions and source photographs are not persisted in presets.

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Tests exercise geometry, transforms, ROI rendering, color profiles, actual bit depth, metadata, atomic output, preset persistence and updater lifecycle. App interaction is additionally checked in dev Electron. Distribution builds and signing are outside the current dev verification scope.

## Editing

- **Compose:** up to four visible strip photos, or recursive grids with empty cells and an overflow image pool. Grid cells support split, merge, swap, clear and delete, with undo/redo for structural edits. Drag dividers to resize; Command disables snapping and Option limits the divider segment.
- **Annotate:** seven caption styles with bundled licensed fonts, selected EXIF fields, shared or per-photo captions, and transparent logo watermarks.
- **Print:** paper size, orientation and Fit/Fill/Grid layout. Fit retains native photographic resolution and derives the effective DPI.
- **Preview:** Fit, backing-pixel 100%, zoom/pan and debounced high-resolution visible-region rendering.
- **Export:** `1920w`, `1080h`, `0.5x` or automatic dimensions, JPEG/PNG/TIFF, sRGB/Display P3/Adobe RGB, optional metadata from a selected source. Adobe RGB currently uses the macOS system profile. Original input files cannot be export destinations.

Input is bounded to 100 megapixels and 512 MB per image; output is bounded to 100 megapixels and 32768 pixels per side. Supported dialog inputs are JPEG, PNG, TIFF, WebP and AVIF. RAW/HEIC and automatic migration from native presets are not advertised. Export runs in a worker and writes through a temporary file before replacing the chosen destination.

The application icon and caption fonts originate from the native Poliframe app. Font licenses are included in `resources/licenses`.
