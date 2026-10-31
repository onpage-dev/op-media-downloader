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
  delete_failed_title: label => `${label}: Dateien nicht gelöscht`,
  delete_failed_body: 'Die heruntergeladenen Dateien konnten nicht gelöscht werden und befinden sich noch im Ordner.',
  quit_title: 'Downloads laufen',
  quit_message:
    'Es laufen noch Downloads. Wenn Sie die App beenden, werden sie gestoppt: Bereits heruntergeladene Dateien bleiben erhalten.',
  deleting_title: 'Dateien werden gelöscht',
  deleting_message:
    'Die Dateien eines Projekts werden gerade gelöscht. Wenn Sie die App beenden, wird das Löschen abgebrochen: Einige Dateien bleiben im Ordner.',
  quit_confirm: 'Stoppen und beenden',
  cancel: 'Abbrechen',
  ok: 'OK',
  config_damaged_title: 'Einstellungen beschädigt',
  config_damaged_message: 'Die Einstellungsdatei war beschädigt',
  config_damaged_detail: file => `Die Datei wurde unter ${file} aufbewahrt. Die App startet ohne Projekte.`,
  start_failed_title: 'On Page Media Downloader konnte nicht gestartet werden',
  start_failed_log: file => `Details im Protokoll: ${file}`,
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
