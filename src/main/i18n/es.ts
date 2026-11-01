/** Texts shown by main in Spanish */
import type { Texts } from './it'
import { plural } from './plural'

export const es: Texts = {
  app_name: 'On Page Media Downloader',
  open: 'Abrir Media Downloader',
  sync_all: 'Sincronizar todo',
  new_project: 'Nuevo proyecto',
  quit: 'Salir',
  tray_idle: 'Todos los proyectos actualizados',
  tray_running: count =>
    plural('es', count, { one: `${count} sincronización en curso`, other: `${count} sincronizaciones en curso` }),
  tray_attention: count =>
    plural('es', count, { one: `${count} proyecto por revisar`, other: `${count} proyectos por revisar` }),
  done_title: label => `${label}: actualizado`,
  done_body: (files, duration) =>
    plural('es', files, {
      one: `${files} archivo descargado en ${duration}`,
      other: `${files} archivos descargados en ${duration}`,
    }),
  done_nothing: 'No hay archivos nuevos',
  failed_title: label => `${label}: archivos no descargados`,
  failed_body: count =>
    plural('es', count, {
      one: `${count} archivo no se ha descargado. Abre la app para reintentar.`,
      other: `${count} archivos no se han descargado. Abre la app para reintentar.`,
    }),
  error_title: label => `${label}: sincronización fallida`,
  error_body: {
    token_invalid: 'El token de API no es válido.',
    folder_unreachable: 'No se puede acceder a la carpeta.',
    folder_not_writable: 'No se puede escribir en la carpeta.',
    folder_locked: 'Otro ordenador está usando la carpeta.',
    folder_other_project: 'La carpeta se sincroniza con otro proyecto de On Page.',
    disk_full: 'El disco está lleno.',
    listing_failed: 'No se ha podido leer la lista de archivos de On Page.',
    other: 'Abre la app para ver qué ha pasado.',
  },
  delete_failed_title: label => `${label}: archivos no eliminados`,
  delete_failed_body: 'No se han podido eliminar los archivos descargados: siguen en la carpeta.',
  delete_other_project_body:
    'La carpeta ahora es de otro proyecto de On Page: los archivos se han quedado donde estaban.',
  quit_title: 'Descargas en curso',
  quit_message: 'Hay descargas en curso. Si sales, se detendrán: los archivos ya descargados se conservan.',
  deleting_title: 'Eliminando archivos',
  deleting_message:
    'Se están eliminando los archivos de un proyecto. Si sales, la eliminación se interrumpe y algunos archivos se quedan en la carpeta.',
  quit_confirm: 'Detener y salir',
  cancel: 'Cancelar',
  ok: 'Aceptar',
  config_damaged_title: 'Ajustes dañados',
  config_damaged_message: 'El archivo de ajustes estaba dañado',
  config_damaged_detail: file => `Se ha guardado aparte en ${file}. La app se inicia sin proyectos.`,
  start_failed_title: 'On Page Media Downloader no se ha podido iniciar',
  start_failed_log: file => `Detalles en el registro: ${file}`,
  minutes: m => plural('es', m, { one: `${m} minuto`, other: `${m} minutos` }),
  seconds: s => plural('es', s, { one: `${s} segundo`, other: `${s} segundos` }),
  menu: {
    settings: 'Ajustes…',
    file: 'Archivo',
    new_project: 'Nuevo proyecto…',
    open_folder: 'Abrir carpeta',
    sync: 'Sincronización',
    sync_selected: 'Sincronizar',
    sync_all: 'Sincronizar todo',
    download: 'Descargar',
    stop: 'Detener',
    find: 'Buscar',
    new_project_task: 'Crear un proyecto para sincronizar',
    sync_all_task: 'Sincronizar todos los proyectos',
  },
}
