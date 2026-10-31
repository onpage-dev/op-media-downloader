/** Texts shown by main in Italian: notifications, tray menu, jump list, dialogs */
export const it = {
  app_name: 'On Page Media Downloader',
  open: 'Apri Media Downloader',
  sync_all: 'Sincronizza tutto',
  new_project: 'Nuovo progetto',
  quit: 'Esci',
  tray_idle: 'Tutti i progetti aggiornati',
  tray_running: (count: number): string =>
    count == 1 ? '1 sincronizzazione in corso' : `${count} sincronizzazioni in corso`,
  tray_attention: (count: number): string =>
    count == 1 ? '1 progetto da controllare' : `${count} progetti da controllare`,
  done_title: (label: string): string => `${label} aggiornato`,
  done_body: (files: number, duration: string): string =>
    files == 1 ? `1 file scaricato in ${duration}` : `${files} file scaricati in ${duration}`,
  done_nothing: 'Nessun file nuovo',
  failed_title: (label: string): string => `${label}: file non scaricati`,
  failed_body: (count: number): string =>
    count == 1
      ? '1 file non è stato scaricato. Apri per riprovare.'
      : `${count} file non sono stati scaricati. Apri per riprovare.`,
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
  delete_failed_title: (label: string): string => `${label}: file non eliminati`,
  delete_failed_body: 'Non è stato possibile eliminare i file scaricati: sono rimasti nella cartella.',
  quit_title: 'Download in corso',
  quit_message: 'Ci sono download in corso. Se chiudi, si interrompono: i file già scaricati restano.',
  deleting_title: 'Eliminazione in corso',
  deleting_message:
    'Si stanno eliminando i file di un progetto. Se chiudi, l’eliminazione si interrompe e alcuni file restano nella cartella.',
  quit_confirm: 'Interrompi e chiudi',
  cancel: 'Annulla',
  ok: 'OK',
  config_damaged_title: 'Impostazioni danneggiate',
  config_damaged_message: 'Il file delle impostazioni era danneggiato',
  config_damaged_detail: (file: string): string => `È stato messo da parte in ${file}. L’app si avvia senza progetti.`,
  start_failed_title: 'On Page Media Downloader non si è potuto avviare',
  start_failed_log: (file: string): string => `Dettagli nel log: ${file}`,
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

export type Texts = typeof it
