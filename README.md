# [On Page ® Media Downloader](https://app.onpage.it/#/help/advanced-tools/on-page-media-downloader/)

A desktop app to download all media files from an On Page project using an [API Token](https://app.onpage.it/#/help/advanced-tools/token-api-k).

## Highlights

- Sync project media via API token
- Download media to a local target folder
- Keep or remove previously downloaded files
- Resolve filename conflicts before downloading
- Pause / stop running downloads

## Usage

1. Add a new project:

   - Name — display name for the project
   - API Token — token used to fetch files (respects token view filters if applied)
   - Target Folder — where files are saved
   - Keep old local files — when enabled, previously downloaded files not present remotely are kept (use with caution as it can create conflicts between new and old files with the same name)

2. Actions available per project:
   - Sync — compares remote files and prepares downloads; shows conflict modal if duplicate names exist
   - Download — starts downloading synced files
   - Stop download — stops the active download process as soon as possible
   - Edit — modify project settings
   - Delete — remove project and optionally local files
   - Open Folder — open target folder in OS file explorer

Notes:

- If you continue with unresolved conflicts only the first file for each conflicting name will be downloaded.
- Prefer disabling "Keep old local files" to avoid conflicts.

## Quick start

Prerequisites:

- Node.js (LTS) and Yarn
- Electron build dependencies (platform specific)

Install and run in development:

```bash
git clone https://github.com/onpage-dev/op-media-downloader.git
cd op-media-downloader
yarn
yarn dev
```

Install and build for release:

```bash
git clone https://github.com/onpage-dev/op-media-downloader.git
cd op-media-downloader
yarn
yarn build:<win | mac | linux>
```

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

- The release workflow builds, signs and notarizes the app and uploads the artifacts.
- Required secrets:
  - MAC_CERTIFICATE: .p12 certificate obtained from Apple
  - APPLE_CERTIFICATE_PASSWORD: password applied to the certificate.p12
  - APPLE_ID: User developer id eg. user@test.com
  - APPLE_ID_PASSWORD: App specific password set inside your user account
  - APPLE_TEAM_ID: Team ID found inside your company page

## Contributing

Fork, branch, implement, and open a pull request. Keep commits small.