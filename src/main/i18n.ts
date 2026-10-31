/** Texts shown by main: notifications, tray menu, jump list, dialogs */
import { AppLanguage } from '../shared/models'

const it = {
  app_name: 'On Page Media Downloader',
  open: 'Apri Media Downloader',
  sync_all: 'Sincronizza tutto',
  new_project: 'Nuovo progetto',
  quit: 'Esci',
  tray_idle: 'Tutti i progetti aggiornati',
  tray_running: (count: number): string => (count == 1 ? '1 sincronizzazione in corso' : `${count} sincronizzazioni in corso`),
  tray_attention: (count: number): string => (count == 1 ? '1 progetto da controllare' : `${count} progetti da controllare`),
  done_title: (label: string): string => `${label} aggiornato`,
  done_body: (files: number, duration: string): string =>
    files == 1 ? `1 file scaricato in ${duration}` : `${files} file scaricati in ${duration}`,
  done_nothing: 'Nessun file nuovo',
  failed_title: (label: string): string => `${label}: file non scaricati`,
  failed_body: (count: number): string =>
    count == 1 ? '1 file non è stato scaricato. Apri per riprovare.' : `${count} file non sono stati scaricati. Apri per riprovare.`,
  error_title: (label: string): string => `${label}: sincronizzazione non riuscita`,
  error_body: {
    token_invalid: 'Il token API non è valido.',
    folder_unreachable: 'La cartella non è raggiungibile.',
    folder_not_writable: 'Non si può scrivere nella cartella.',
    folder_locked: 'La cartella è in uso da un altro computer.',
    disk_full: 'Il disco è pieno.',
    listing_failed: 'Non è stato possibile leggere i file da On Page.',
    other: 'Apri per vedere cosa è successo.',
  },
  quit_title: 'Download in corso',
  quit_message: 'Ci sono download in corso. Se chiudi, si interrompono: i file già scaricati restano.',
  quit_confirm: 'Interrompi e chiudi',
  cancel: 'Annulla',
  minutes: (m: number): string => (m == 1 ? '1 minuto' : `${m} minuti`),
  seconds: (s: number): string => (s == 1 ? '1 secondo' : `${s} secondi`),
  menu: {
    settings: 'Impostazioni…',
    file: 'File',
    new_project: 'Nuovo progetto…',
    open_folder: 'Apri cartella',
    sync: 'Sincronizzazione',
    sync_selected: 'Sincronizza',
    sync_all: 'Sincronizza tutto',
    download: 'Scarica',
    stop: 'Interrompi',
    find: 'Cerca',
    new_project_task: 'Crea un progetto da sincronizzare',
    sync_all_task: 'Sincronizza tutti i progetti',
  },
}

type Texts = typeof it

const en: Texts = {
  app_name: 'On Page Media Downloader',
  open: 'Open Media Downloader',
  sync_all: 'Sync all',
  new_project: 'New project',
  quit: 'Quit',
  tray_idle: 'All projects up to date',
  tray_running: count => (count == 1 ? '1 sync running' : `${count} syncs running`),
  tray_attention: count => (count == 1 ? '1 project needs attention' : `${count} projects need attention`),
  done_title: label => `${label} is up to date`,
  done_body: (files, duration) => (files == 1 ? `1 file downloaded in ${duration}` : `${files} files downloaded in ${duration}`),
  done_nothing: 'No new files',
  failed_title: label => `${label}: files not downloaded`,
  failed_body: count =>
    count == 1 ? '1 file was not downloaded. Open to retry.' : `${count} files were not downloaded. Open to retry.`,
  error_title: label => `${label}: sync failed`,
  error_body: {
    token_invalid: 'The API token is not valid.',
    folder_unreachable: 'The folder cannot be reached.',
    folder_not_writable: 'The app cannot write in the folder.',
    folder_locked: 'Another computer is using the folder.',
    disk_full: 'The disk is full.',
    listing_failed: 'The file list could not be read from On Page.',
    other: 'Open to see what happened.',
  },
  quit_title: 'Downloads running',
  quit_message: 'Some downloads are running. Quitting stops them: the files already downloaded stay.',
  quit_confirm: 'Stop and quit',
  cancel: 'Cancel',
  minutes: m => (m == 1 ? '1 minute' : `${m} minutes`),
  seconds: s => (s == 1 ? '1 second' : `${s} seconds`),
  menu: {
    settings: 'Settings…',
    file: 'File',
    new_project: 'New project…',
    open_folder: 'Open folder',
    sync: 'Sync',
    sync_selected: 'Sync',
    sync_all: 'Sync all',
    download: 'Download',
    stop: 'Stop',
    find: 'Find',
    new_project_task: 'Create a project to sync',
    sync_all_task: 'Sync every project',
  },
}

export function texts(language: AppLanguage): Texts {
  return language == 'en' ? en : it
}

export function duration(language: AppLanguage, ms: number): string {
  const t = texts(language)
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? t.seconds(seconds) : t.minutes(Math.round(seconds / 60))
}
