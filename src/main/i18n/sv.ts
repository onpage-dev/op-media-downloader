/** Texts shown by main in Swedish */
import type { Texts } from './it'
import { plural } from './plural'

export const sv: Texts = {
  app_name: 'On Page Media Downloader',
  open: 'Öppna Media Downloader',
  sync_all: 'Synkronisera alla',
  new_project: 'Nytt projekt',
  quit: 'Avsluta',
  tray_idle: 'Alla projekt är uppdaterade',
  tray_running: count =>
    plural('sv', count, { one: `${count} synkronisering pågår`, other: `${count} synkroniseringar pågår` }),
  tray_attention: count =>
    plural('sv', count, {
      one: `${count} projekt behöver kontrolleras`,
      other: `${count} projekt behöver kontrolleras`,
    }),
  done_title: label => `${label} har uppdaterats`,
  done_body: (files, duration) =>
    plural('sv', files, {
      one: `${files} fil laddades ner på ${duration}`,
      other: `${files} filer laddades ner på ${duration}`,
    }),
  done_nothing: 'Inga nya filer',
  failed_title: label => `${label}: filer laddades inte ner`,
  failed_body: count =>
    plural('sv', count, {
      one: `${count} fil laddades inte ner. Öppna för att försöka igen.`,
      other: `${count} filer laddades inte ner. Öppna för att försöka igen.`,
    }),
  error_title: label => `${label}: synkroniseringen misslyckades`,
  error_body: {
    token_invalid: 'Projektets API-token är ogiltig.',
    folder_unreachable: 'Mappen kan inte nås.',
    folder_not_writable: 'Det går inte att skriva i mappen.',
    folder_locked: 'Mappen används av en annan dator.',
    disk_full: 'Disken är full.',
    listing_failed: 'Det gick inte att läsa fillistan från On Page.',
    other: 'Öppna för att se vad som hände.',
  },
  delete_failed_title: label => `${label}: filerna togs inte bort`,
  delete_failed_body: 'De nedladdade filerna kunde inte tas bort: de finns kvar i mappen.',
  quit_title: 'Nedladdningar pågår',
  quit_message: 'Nedladdningar pågår. Om du avslutar stoppas de: filer som redan har laddats ner finns kvar.',
  deleting_title: 'Filer tas bort',
  deleting_message:
    'Filerna i ett projekt håller på att tas bort. Om du avslutar avbryts borttagningen: vissa filer blir kvar i mappen.',
  quit_confirm: 'Stoppa och avsluta',
  cancel: 'Avbryt',
  ok: 'OK',
  config_damaged_title: 'Inställningarna är skadade',
  config_damaged_message: 'Inställningsfilen var skadad',
  config_damaged_detail: file => `Den har sparats undan som ${file}. Appen startar utan projekt.`,
  start_failed_title: 'On Page Media Downloader kunde inte starta',
  start_failed_log: file => `Detaljer finns i loggen: ${file}`,
  minutes: m => plural('sv', m, { one: `${m} minut`, other: `${m} minuter` }),
  seconds: s => plural('sv', s, { one: `${s} sekund`, other: `${s} sekunder` }),
  menu: {
    settings: 'Inställningar…',
    file: 'Arkiv',
    new_project: 'Nytt projekt…',
    open_folder: 'Öppna mapp',
    sync: 'Synkronisering',
    sync_selected: 'Synkronisera',
    sync_all: 'Synkronisera alla',
    download: 'Ladda ner',
    stop: 'Stoppa',
    find: 'Sök',
    new_project_task: 'Skapa ett projekt att synkronisera',
    sync_all_task: 'Synkronisera alla projekt',
  },
}
