# [On Page ® Media Downloader](https://app.onpage.it/#/help/advanced-tools/on-page-media-downloader/)

A desktop app that keeps a local or network folder in sync with the media files of an On Page project, read through an [API Token](https://app.onpage.it/#/help/advanced-tools/api) (the token's View is honoured).

## Highlights

- Sync manager window: every project with its state, progress, speed and time left
- Incremental syncs: after the first one, only what changed on On Page is read
- Safe by design: the app only removes the files it created, never anything else in the folder
- Works with network folders: no freezes, folder checks, a lock against two computers syncing the same folder
- Proxy aware downloads with retries, timeouts and a real Stop
- Notification area icon, system notifications, taskbar progress, light and dark theme

## Usage

1. **New project**: name, API token (verified on the spot), folder (checked: network or local, free space, hard links), options.
   - *Keep old local files*: files removed from On Page stay in the folder. Prefer leaving it off.
2. **Sync** compares On Page with the folder and shows what is left to do; **Download** does it. When nothing needs downloading, links and removals are applied right away.
3. The inspector shows the project, the live activity, the failed files (with **Retry**), the names with different files on On Page and the project settings.

Inside the folder, `data/` holds one file per content (named by its On Page token) and `data/manifest.json` lists what the app created; every file name in the folder is a hard link to its content (a copy where hard links are not supported).

When two files on On Page share a name (case does not count), only the first one is downloaded: rename them on On Page to get both.

## Development

Prerequisites: Node.js 24 (`.node-version`) and Yarn 1. No token is needed.

```bash
yarn
yarn dev        # app with hot reload (its data folder is separate from the installed app)
yarn test       # engine, main and renderer tests
yarn typecheck
yarn lint
yarn format     # Prettier; CI runs `yarn format:check`
yarn build:<win | mac | linux>
```

- `OPMD_USER_DATA=<folder>` runs a development build on another data folder.
- `OPMD_API_DOMAIN=http://127.0.0.1:<port>` points a development build at a fake On Page server (see `src/engine/testing`).

**Icons.** Without a token the app uses the closest Font Awesome Free icons. With an On Page Font Awesome Pro token (`FONTAWESOME_NPM_AUTH_TOKEN`, or `//npm.fontawesome.com/:_authToken` in your user `.npmrc`), `yarn` (or `yarn icons`) generates the Pro light icons of the On Page design system in `src/renderer/src/lib/icons/pro.generated.ts`. That file is never committed: Font Awesome Pro icons may be embedded in the app, not published in an open-source repository.

Architecture, safety rules and the sync flows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Changes: [CHANGELOG.md](CHANGELOG.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## Releases

Bump `version` in `package.json`, then push a tag `vX.Y.Z`. The release workflow builds Windows, macOS (x64 and arm64) and Linux, signs and notarizes the macOS DMGs, attaches the installers with their SHA-256 checksums and build provenance to a draft release and publishes it last, so the app's update check never points at a release without installers. The Windows installer is not code-signed yet: Windows shows "unknown publisher".

Repository secrets:

- `FONTAWESOME_NPM_AUTH_TOKEN`: Font Awesome Pro token, for the design system icons (required by releases)
- `MAC_CERTIFICATE`: the .p12 Developer ID certificate, base64
- `APPLE_CERTIFICATE_PASSWORD`: the password of the .p12
- `APPLE_ID`, `APPLE_ID_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`: for notarization

To notarize a DMG built locally: `xcrun notarytool submit <file>.dmg --apple-id <id> --password <app-specific password> --team-id <team> --wait`, then `xcrun stapler staple <file>.dmg`.

## License and trademarks

The code is released under the [MIT License](LICENSE). On Page® and its logo are trademarks of their owner and are not covered by the license. The licenses of the third-party software in the app are listed in `THIRD_PARTY_NOTICES.txt` (generated at build time, also opened from Settings › Updates).
