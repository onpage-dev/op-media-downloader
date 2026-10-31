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
    disk_full: 'El disco está lleno.',
    listing_failed: 'No se ha podido leer la lista de archivos de On Page.',
    other: 'Abre la app para ver qué ha pasado.',
  },
  quit_title: 'Descargas en curso',
  quit_message: 'Hay descargas en curso. Si sales, se detendrán: los archivos ya descargados se conservan.',
  quit_confirm: 'Detener y salir',
  cancel: 'Cancelar',
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
