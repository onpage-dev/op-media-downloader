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

Prerequisites: Node.js 22 and Yarn 1, plus a Font Awesome Pro token for the design system icons, once in your user `.npmrc` (never in the repository):

```bash
npm config set //npm.fontawesome.com/:_authToken <token>
yarn
yarn dev        # app with hot reload (its data folder is separate from the installed app)
yarn test       # sync engine tests
yarn typecheck
yarn build:<win | mac | linux>
```

- `OPMD_USER_DATA=<folder>` runs a development build on another data folder.
- `OPMD_API_DOMAIN=http://127.0.0.1:<port>` points a development build at a fake On Page server (see `src/engine/testing`).

Architecture, safety rules and the sync flows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Notarization (macOS)

Local notarization (store credentials):

```bash
xcrun notarytool store-credentials "AC_PASSWORD" \
  --apple-id "<YOUR_APPLE_ID>" \
  --team-id "<YOUR_TEAM_ID>" \
  --password "<APP_SPECIFIC_PASSWORD>"
```

Build + notarize:

```bash
yarn build:mac-with-notarize
```

GitHub Actions:

- The release workflow builds, signs and notarizes the app and uploads the artifacts to the release that started it.
- Required secrets:
  - FONTAWESOME_NPM_AUTH_TOKEN: Font Awesome Pro npm token
  - MAC_CERTIFICATE: .p12 certificate obtained from Apple
  - APPLE_CERTIFICATE_PASSWORD: password applied to the certificate.p12
  - APPLE_ID: User developer id eg. user@test.com
  - APPLE_ID_PASSWORD: App specific password set inside your user account
  - APPLE_TEAM_ID: Team ID found inside your company page

## Contributing

Fork, branch, implement, and open a pull request. Keep commits small.
