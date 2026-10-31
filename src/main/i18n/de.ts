/** Texts shown by main in German */
import type { Texts } from './it'
import { plural } from './plural'

export const de: Texts = {
  app_name: 'On Page Media Downloader',
  open: 'Media Downloader öffnen',
  sync_all: 'Alle synchronisieren',
  new_project: 'Neues Projekt',
  quit: 'Beenden',
  tray_idle: 'Alle Projekte sind aktuell',
  tray_running: count =>
    plural('de', count, { one: `${count} Synchronisierung läuft`, other: `${count} Synchronisierungen laufen` }),
  tray_attention: count =>
    plural('de', count, { one: `${count} Projekt erfordert Aufmerksamkeit`, other: `${count} Projekte erfordern Aufmerksamkeit` }),
  done_title: label => `${label} ist aktuell`,
  done_body: (files, duration) =>
    plural('de', files, {
      one: `${files} Datei in ${duration} heruntergeladen`,
      other: `${files} Dateien in ${duration} heruntergeladen`,
    }),
  done_nothing: 'Keine neuen Dateien',
  failed_title: label => `${label}: Dateien nicht heruntergeladen`,
  failed_body: count =>
    plural('de', count, {
      one: `${count} Datei wurde nicht heruntergeladen. Zum Wiederholen öffnen.`,
      other: `${count} Dateien wurden nicht heruntergeladen. Zum Wiederholen öffnen.`,
    }),
  error_title: label => `${label}: Synchronisierung fehlgeschlagen`,
  error_body: {
    token_invalid: 'Das API-Token ist ungültig.',
    folder_unreachable: 'Der Ordner ist nicht erreichbar.',
    folder_not_writable: 'In den Ordner kann nicht geschrieben werden.',
    folder_locked: 'Der Ordner wird von einem anderen Computer verwendet.',
    disk_full: 'Der Datenträger ist voll.',
    listing_failed: 'Die Dateiliste konnte nicht von On Page abgerufen werden.',
    other: 'Öffnen, um zu sehen, was passiert ist.',
  },
  quit_title: 'Downloads laufen',
  quit_message:
    'Es laufen noch Downloads. Wenn Sie die App beenden, werden sie gestoppt: Bereits heruntergeladene Dateien bleiben erhalten.',
  quit_confirm: 'Stoppen und beenden',
  cancel: 'Abbrechen',
  minutes: m => plural('de', m, { one: `${m} Minute`, other: `${m} Minuten` }),
  seconds: s => plural('de', s, { one: `${s} Sekunde`, other: `${s} Sekunden` }),
  menu: {
    settings: 'Einstellungen…',
    file: 'Ablage',
    new_project: 'Neues Projekt…',
    open_folder: 'Ordner öffnen',
    sync: 'Synchronisierung',
    sync_selected: 'Synchronisieren',
    sync_all: 'Alle synchronisieren',
    download: 'Herunterladen',
    stop: 'Stoppen',
    find: 'Suchen',
    new_project_task: 'Ein Projekt zum Synchronisieren erstellen',
    sync_all_task: 'Alle Projekte synchronisieren',
  },
}
