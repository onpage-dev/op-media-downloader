# [On Page ® Media Downloader](https://app.onpage.it/#/help/On-page-media-k/on-page-media-downloader/)

This program allows to download all files from a given project using an [API Token](https://app.onpage.it/#/help/integrations/token-api-k).

## Usage

To start, add a new project:

- Name: used to identify the project;
- Api Token: used to fetch data from On Page, if a View is applied to the token then only the visible data will be donwloaded;
- Target Folder: location where all the files will be downloaded
- Keep old local files: This options lets you keep onld files that were removed from On Page but downloaded previously.
  - WARNING It is recommended to keep this option off as it can create conflicts for files with the same name while downloading the data.

Once you create a project you'll be able to perform 4 actions:

- Sync: fetches data from On Page to check if new files needs to be downloaded;
  - Once sync is finished if there are different files with the same name you'll be presented with a modal containing a list with all conflicts. You'll be able to resolve them and reload or just keep downloading
    - WARNING If you choose to continue while having conflicts only the first file for each name will be downloaded
  - After starting the download you'll be able to stop it at any given time by clicking Stop download, the process will be stopped as soon as possible.
- Edit: lets you change every option defined during creation;
- Delete: deletes the project and optionally all the folders and files related to it;
- Open Folder: opens the folder defined during creation;

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
yarn build:<win | mac | linux>
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
