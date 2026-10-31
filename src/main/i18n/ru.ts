/** Texts shown by main in Russian */
import type { Texts } from './it'
import { plural } from './plural'

export const ru: Texts = {
  app_name: 'On Page Media Downloader',
  open: 'Открыть Media Downloader',
  sync_all: 'Синхронизировать всё',
  new_project: 'Новый проект',
  quit: 'Выйти',
  tray_idle: 'Все проекты актуальны',
  tray_running: count =>
    plural('ru', count, {
      one: `Идёт ${count} синхронизация`,
      few: `Идут ${count} синхронизации`,
      many: `Идёт ${count} синхронизаций`,
      other: `Идёт ${count} синхронизаций`,
    }),
  tray_attention: count =>
    plural('ru', count, {
      one: `${count} проект требует внимания`,
      few: `${count} проекта требуют внимания`,
      many: `${count} проектов требуют внимания`,
      other: `${count} проектов требуют внимания`,
    }),
  done_title: label => `${label}: всё актуально`,
  done_body: (files, duration) =>
    plural('ru', files, {
      one: `Скачан ${files} файл за ${duration}`,
      few: `Скачаны ${files} файла за ${duration}`,
      many: `Скачано ${files} файлов за ${duration}`,
      other: `Скачано ${files} файлов за ${duration}`,
    }),
  done_nothing: 'Нет новых файлов',
  failed_title: label => `${label}: файлы не скачаны`,
  failed_body: count =>
    plural('ru', count, {
      one: `Не удалось скачать ${count} файл. Откройте, чтобы повторить попытку.`,
      few: `Не удалось скачать ${count} файла. Откройте, чтобы повторить попытку.`,
      many: `Не удалось скачать ${count} файлов. Откройте, чтобы повторить попытку.`,
      other: `Не удалось скачать ${count} файлов. Откройте, чтобы повторить попытку.`,
    }),
  error_title: label => `${label}: синхронизация не удалась`,
  error_body: {
    token_invalid: 'Неверный API-токен.',
    folder_unreachable: 'Папка недоступна.',
    folder_not_writable: 'Запись в папку невозможна.',
    folder_locked: 'Папку использует другой компьютер.',
    disk_full: 'Диск заполнен.',
    listing_failed: 'Не удалось получить список файлов с On Page.',
    other: 'Откройте, чтобы узнать, что произошло.',
  },
  delete_failed_title: label => `${label}: файлы не удалены`,
  delete_failed_body: 'Не удалось удалить скачанные файлы: они остались в папке.',
  quit_title: 'Идёт скачивание',
  quit_message: 'Файлы ещё скачиваются. Если выйти, скачивание остановится: уже скачанные файлы сохранятся.',
  deleting_title: 'Идёт удаление',
  deleting_message: 'Файлы проекта удаляются. Если выйти, удаление прервётся: часть файлов останется в папке.',
  quit_confirm: 'Остановить и выйти',
  cancel: 'Отмена',
  ok: 'ОК',
  config_damaged_title: 'Настройки повреждены',
  config_damaged_message: 'Файл настроек был повреждён',
  config_damaged_detail: file => `Он сохранён отдельно: ${file}. Приложение запускается без проектов.`,
  start_failed_title: 'Не удалось запустить On Page Media Downloader',
  start_failed_log: file => `Подробности в журнале: ${file}`,
  /** The duration of done_body, after «за»: the accusative (за 1 минуту, за 2 минуты, за 5 минут) */
  minutes: m =>
    plural('ru', m, {
      one: `${m} минуту`,
      few: `${m} минуты`,
      many: `${m} минут`,
      other: `${m} минут`,
    }),
  seconds: s =>
    plural('ru', s, {
      one: `${s} секунду`,
      few: `${s} секунды`,
      many: `${s} секунд`,
      other: `${s} секунд`,
    }),
  menu: {
    settings: 'Настройки…',
    file: 'Файл',
    new_project: 'Новый проект…',
    open_folder: 'Открыть папку',
    sync: 'Синхронизация',
    sync_selected: 'Синхронизировать',
    sync_all: 'Синхронизировать всё',
    download: 'Скачать',
    stop: 'Остановить',
    find: 'Найти',
    new_project_task: 'Создать проект для синхронизации',
    sync_all_task: 'Синхронизировать все проекты',
  },
}
