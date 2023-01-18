# On Page ® Media Downloader

This program allows to download all files from a given project using an [API Token](https://app.onpage.it/#/help/integrations/token-api).

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
