# On Page ® Media Downloader

This program allows to download all files from a given project using an [API Token](https://app.onpage.it/#/help/integrations/token-api-k).

## Usage

To start, create a new project setting:

- Name: local project name to identify it
- Api Token: remote project Api Token that will be used to download the files
- Target Folder: sets the location where all the files will be downloaded

Every project enables 3 functions:

- Sync: aligns the local downloaded files with the remote files
- Edit: changes the config properties (name/api token/download folder)
- Delete: deletes the config and all the relative local files and folders

# Develop

```bash
git clone https://github.com/onpage-dev/op-media-downloader.git
cd op-media-downloader
yarn
yarn dev
```

# Build

```bash
git clone https://github.com/onpage-dev/op-media-downloader.git
cd op-media-downloader
yarn
yarn build:mac
```

## Notarization

### Local

The local notarization process uses the info stored inside AC_PASSWORD from your keychain.
You can configure it bu running this command

```bash
xcrun notarytool store-credentials "AC_PASSWORD" \
--apple-id "<YOUR_APPLE_ID>" \
--team-id "<YOUR_TEAM_ID>" \
--password "<APP_SPECIFIC_PASSWORD>"
```

If you want to build and notarize the app you can run this command

```bash
build:mac-with-notarize
```

### GitHub Actions

The actions will trigger whenever a new release or pre-release is created and will attempt to build, sign and notarize the application.

After the build process is over it will automatically attach the files to the release's assets.

To do this it will try to read some secrets in order to complete each step correctly

- MAC_CERTIFICATE: The .p12 certificate obtained from Apple
- APPLE_CERTIFICATE_PASSWORD: The password applied to the certificate.p12
- APPLE_ID: User developer id eg. user@test.com
- APPLE_ID_PASSWORD: App specific password set inside your user account
- APPLE_TEAM_ID: Team ID found inside your company page
