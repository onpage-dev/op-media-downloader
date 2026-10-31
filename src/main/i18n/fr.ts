/** Texts shown by main in French */
import type { Texts } from './it'
import { plural } from './plural'

export const fr: Texts = {
  app_name: 'On Page Media Downloader',
  open: 'Ouvrir Media Downloader',
  sync_all: 'Tout synchroniser',
  new_project: 'Nouveau projet',
  quit: 'Quitter',
  tray_idle: 'Tous les projets sont à jour',
  tray_running: count =>
    plural('fr', count, { one: `${count} synchronisation en cours`, other: `${count} synchronisations en cours` }),
  tray_attention: count => plural('fr', count, { one: `${count} projet à vérifier`, other: `${count} projets à vérifier` }),
  done_title: label => `${label}\u00a0: à jour`,
  done_body: (files, duration) =>
    plural('fr', files, {
      one: `${files} fichier téléchargé en ${duration}`,
      other: `${files} fichiers téléchargés en ${duration}`,
    }),
  done_nothing: 'Aucun nouveau fichier',
  failed_title: label => `${label}\u00a0: fichiers non téléchargés`,
  failed_body: count =>
    plural('fr', count, {
      one: `${count} fichier n’a pas été téléchargé. Ouvrez l’app pour réessayer.`,
      other: `${count} fichiers n’ont pas été téléchargés. Ouvrez l’app pour réessayer.`,
    }),
  error_title: label => `${label}\u00a0: échec de la synchronisation`,
  error_body: {
    token_invalid: 'Le jeton d’API n’est pas valide.',
    folder_unreachable: 'Le dossier est inaccessible.',
    folder_not_writable: 'Impossible d’écrire dans le dossier.',
    folder_locked: 'Un autre ordinateur utilise le dossier.',
    disk_full: 'Le disque est plein.',
    listing_failed: 'Impossible de lire la liste des fichiers sur On Page.',
    other: 'Ouvrez l’app pour voir ce qui s’est passé.',
  },
  delete_failed_title: label => `${label}\u00a0: fichiers non supprimés`,
  delete_failed_body: 'Impossible de supprimer les fichiers téléchargés\u00a0: ils sont toujours dans le dossier.',
  quit_title: 'Téléchargements en cours',
  quit_message:
    'Des téléchargements sont en cours. Si vous quittez, ils seront arrêtés\u00a0: les fichiers déjà téléchargés sont conservés.',
  deleting_title: 'Suppression en cours',
  deleting_message:
    'Les fichiers d’un projet sont en cours de suppression. Si vous quittez, la suppression s’arrête\u00a0: certains fichiers restent dans le dossier.',
  quit_confirm: 'Arrêter et quitter',
  cancel: 'Annuler',
  ok: 'OK',
  config_damaged_title: 'Paramètres endommagés',
  config_damaged_message: 'Le fichier des paramètres était endommagé',
  config_damaged_detail: file => `Il a été mis de côté dans ${file}. L’app démarre sans projets.`,
  start_failed_title: 'On Page Media Downloader n’a pas pu démarrer',
  start_failed_log: file => `Détails dans le journal\u00a0: ${file}`,
  minutes: m => plural('fr', m, { one: `${m} minute`, other: `${m} minutes` }),
  seconds: s => plural('fr', s, { one: `${s} seconde`, other: `${s} secondes` }),
  menu: {
    settings: 'Paramètres…',
    file: 'Fichier',
    new_project: 'Nouveau projet…',
    open_folder: 'Ouvrir le dossier',
    sync: 'Synchronisation',
    sync_selected: 'Synchroniser',
    sync_all: 'Tout synchroniser',
    download: 'Télécharger',
    stop: 'Arrêter',
    find: 'Rechercher',
    new_project_task: 'Créer un projet à synchroniser',
    sync_all_task: 'Synchroniser tous les projets',
  },
}
