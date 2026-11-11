//! Texts shown by the app itself: notifications, tray menu, dialogs, the
//! macOS menu. The page has its own (vue-i18n). Every language of On Page UI:
//! Italian, English, German, Spanish, French, Russian, Swedish, Chinese.

use crate::models::AppLanguage;

/// The forms of a text with a number, by plural category (CLDR); `{n}` is the number
#[derive(Clone, Copy)]
pub struct Plural {
    pub one: &'static str,
    pub few: Option<&'static str>,
    pub many: Option<&'static str>,
    pub other: &'static str,
}

const fn forms(one: &'static str, other: &'static str) -> Plural {
    Plural { one, few: None, many: None, other }
}

const fn slavic(one: &'static str, few: &'static str, many: &'static str) -> Plural {
    Plural { one, few: Some(few), many: Some(many), other: many }
}

const fn same(text: &'static str) -> Plural {
    forms(text, text)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    One,
    Few,
    Many,
    Other,
}

/// The CLDR category of a whole number in a language: Russian has one, few and
/// many; French says «0 fichier»; Chinese has one form
fn category(language: AppLanguage, n: u64) -> Category {
    match language {
        AppLanguage::Zh => Category::Other,
        AppLanguage::Fr => {
            if n <= 1 {
                Category::One
            } else {
                Category::Other
            }
        }
        AppLanguage::Ru => {
            let (ten, hundred) = (n % 10, n % 100);
            if ten == 1 && hundred != 11 {
                Category::One
            } else if (2..=4).contains(&ten) && !(12..=14).contains(&hundred) {
                Category::Few
            } else {
                Category::Many
            }
        }
        _ => {
            if n == 1 {
                Category::One
            } else {
                Category::Other
            }
        }
    }
}

fn plural(language: AppLanguage, n: u64, forms: &Plural) -> String {
    let text = match category(language, n) {
        Category::One => forms.one,
        Category::Few => forms.few.unwrap_or(forms.other),
        Category::Many => forms.many.unwrap_or(forms.other),
        Category::Other => forms.other,
    };
    text.replace("{n}", &n.to_string())
}

pub struct ErrorBodies {
    pub token_invalid: &'static str,
    pub folder_unreachable: &'static str,
    pub folder_not_writable: &'static str,
    pub folder_locked: &'static str,
    pub folder_other_project: &'static str,
    pub disk_full: &'static str,
    pub listing_failed: &'static str,
    pub other: &'static str,
}

/// The macOS menu's
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MenuTexts {
    pub settings: &'static str,
    pub file: &'static str,
    pub new_project: &'static str,
    pub open_folder: &'static str,
    pub sync: &'static str,
    pub sync_selected: &'static str,
    pub sync_all: &'static str,
    pub download: &'static str,
    pub stop: &'static str,
    pub find: &'static str,
    pub edit: &'static str,
    pub window: &'static str,
}

/// Placeholders: `{label}`, `{duration}`, `{file}`, `{n}` in the plural forms
pub struct Texts {
    language: AppLanguage,
    pub app_name: &'static str,
    pub open: &'static str,
    pub sync_all: &'static str,
    pub quit: &'static str,
    pub tray_idle: &'static str,
    tray_running: Plural,
    tray_attention: Plural,
    done_title: &'static str,
    /// `{n}` files, `{duration}`
    done_body: Plural,
    failed_title: &'static str,
    failed_body: Plural,
    error_title: &'static str,
    pub error_body: ErrorBodies,
    delete_failed_title: &'static str,
    pub delete_failed_body: &'static str,
    pub delete_other_project_body: &'static str,
    pub quit_title: &'static str,
    pub quit_message: &'static str,
    pub deleting_title: &'static str,
    pub deleting_message: &'static str,
    pub quit_confirm: &'static str,
    pub cancel: &'static str,
    pub ok: &'static str,
    pub config_damaged_title: &'static str,
    config_damaged_detail: &'static str,
    pub start_failed_title: &'static str,
    start_failed_log: &'static str,
    minutes: Plural,
    seconds: Plural,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub menu: MenuTexts,
}

impl Texts {
    pub fn tray_running(&self, count: u64) -> String {
        plural(self.language, count, &self.tray_running)
    }
    pub fn tray_attention(&self, count: u64) -> String {
        plural(self.language, count, &self.tray_attention)
    }
    pub fn done_title(&self, label: &str) -> String {
        self.done_title.replace("{label}", label)
    }
    pub fn done_body(&self, files: u64, duration: &str) -> String {
        plural(self.language, files, &self.done_body).replace("{duration}", duration)
    }
    pub fn failed_title(&self, label: &str) -> String {
        self.failed_title.replace("{label}", label)
    }
    pub fn failed_body(&self, count: u64) -> String {
        plural(self.language, count, &self.failed_body)
    }
    pub fn error_title(&self, label: &str) -> String {
        self.error_title.replace("{label}", label)
    }
    /// The text of an issue's code in a notification
    pub fn error_body(&self, code: Option<&str>) -> &'static str {
        let bodies = &self.error_body;
        match code {
            Some("token_invalid") => bodies.token_invalid,
            Some("folder_unreachable") => bodies.folder_unreachable,
            Some("folder_not_writable") => bodies.folder_not_writable,
            Some("folder_locked") => bodies.folder_locked,
            Some("folder_other_project") => bodies.folder_other_project,
            Some("disk_full") => bodies.disk_full,
            Some("listing_failed") => bodies.listing_failed,
            _ => bodies.other,
        }
    }
    pub fn delete_failed_title(&self, label: &str) -> String {
        self.delete_failed_title.replace("{label}", label)
    }
    pub fn config_damaged_detail(&self, file: &str) -> String {
        self.config_damaged_detail.replace("{file}", file)
    }
    pub fn start_failed_log(&self, file: &str) -> String {
        self.start_failed_log.replace("{file}", file)
    }
    /// A job's duration: seconds under a minute, minutes after
    pub fn duration(&self, ms: i64) -> String {
        let seconds = ((ms as f64) / 1000.0).round().max(1.0) as u64;
        if seconds < 60 {
            plural(self.language, seconds, &self.seconds)
        } else {
            plural(self.language, ((seconds as f64) / 60.0).round() as u64, &self.minutes)
        }
    }
}

pub fn texts(language: AppLanguage) -> &'static Texts {
    match language {
        AppLanguage::It => &IT,
        AppLanguage::En => &EN,
        AppLanguage::De => &DE,
        AppLanguage::Es => &ES,
        AppLanguage::Fr => &FR,
        AppLanguage::Ru => &RU,
        AppLanguage::Sv => &SV,
        AppLanguage::Zh => &ZH,
    }
}

/// The first of the system's preferred languages that the app speaks, else English
pub fn system_language(preferred: &[String]) -> AppLanguage {
    for tag in preferred {
        let base = tag.to_lowercase();
        let base = base.split(['-', '_']).next().unwrap_or("");
        if let Some(language) = AppLanguage::from_code(base) {
            return language;
        }
    }
    AppLanguage::En
}

const APP_NAME: &str = "On Page Media Downloader";

static IT: Texts = Texts {
    language: AppLanguage::It,
    app_name: APP_NAME,
    open: "Apri Media Downloader",
    sync_all: "Sincronizza tutto",
    quit: "Esci",
    tray_idle: "Tutti i progetti aggiornati",
    tray_running: forms("1 sincronizzazione in corso", "{n} sincronizzazioni in corso"),
    tray_attention: forms("1 progetto da controllare", "{n} progetti da controllare"),
    done_title: "{label} aggiornato",
    done_body: forms("1 file scaricato in {duration}", "{n} file scaricati in {duration}"),
    failed_title: "{label}: file non scaricati",
    failed_body: forms(
        "1 file non è stato scaricato. Apri per riprovare.",
        "{n} file non sono stati scaricati. Apri per riprovare.",
    ),
    error_title: "{label}: sincronizzazione non riuscita",
    error_body: ErrorBodies {
        token_invalid: "Il token API non è valido.",
        folder_unreachable: "La cartella non è raggiungibile.",
        folder_not_writable: "Non si può scrivere nella cartella.",
        folder_locked: "La cartella è in uso da un altro computer.",
        folder_other_project: "La cartella è sincronizzata con un altro progetto On Page.",
        disk_full: "Il disco è pieno.",
        listing_failed: "Non è stato possibile leggere i file da On Page.",
        other: "Apri per vedere cosa è successo.",
    },
    delete_failed_title: "{label}: file non eliminati",
    delete_failed_body: "Non è stato possibile eliminare i file scaricati: sono rimasti nella cartella.",
    delete_other_project_body: "La cartella ora è di un altro progetto On Page: i file sono rimasti dove sono.",
    quit_title: "Download in corso",
    quit_message: "Ci sono download in corso. Se chiudi, si interrompono: i file già scaricati restano.",
    deleting_title: "Eliminazione in corso",
    deleting_message: "Si stanno eliminando i file di un progetto. Se chiudi, l’eliminazione si interrompe e alcuni file restano nella cartella.",
    quit_confirm: "Interrompi e chiudi",
    cancel: "Annulla",
    ok: "OK",
    config_damaged_title: "Impostazioni danneggiate",
    config_damaged_detail: "Il file delle impostazioni era danneggiato. È stato messo da parte in {file}. L’app si avvia senza progetti.",
    start_failed_title: "On Page Media Downloader non si è potuto avviare",
    start_failed_log: "Dettagli nel log: {file}",
    minutes: forms("1 minuto", "{n} minuti"),
    seconds: forms("1 secondo", "{n} secondi"),
    menu: MenuTexts {
        settings: "Impostazioni…",
        file: "File",
        new_project: "Nuovo progetto…",
        open_folder: "Apri cartella",
        sync: "Sincronizzazione",
        sync_selected: "Sincronizza",
        sync_all: "Sincronizza tutto",
        download: "Scarica",
        stop: "Interrompi",
        find: "Cerca",
        edit: "Modifica",
        window: "Finestra",
    },
};

static EN: Texts = Texts {
    language: AppLanguage::En,
    app_name: APP_NAME,
    open: "Open Media Downloader",
    sync_all: "Sync all",
    quit: "Quit",
    tray_idle: "All projects up to date",
    tray_running: forms("1 sync running", "{n} syncs running"),
    tray_attention: forms("1 project needs attention", "{n} projects need attention"),
    done_title: "{label} is up to date",
    done_body: forms("1 file downloaded in {duration}", "{n} files downloaded in {duration}"),
    failed_title: "{label}: files not downloaded",
    failed_body: forms("1 file was not downloaded. Open to retry.", "{n} files were not downloaded. Open to retry."),
    error_title: "{label}: sync failed",
    error_body: ErrorBodies {
        token_invalid: "The API token is not valid.",
        folder_unreachable: "The folder cannot be reached.",
        folder_not_writable: "The app cannot write in the folder.",
        folder_locked: "Another computer is using the folder.",
        folder_other_project: "The folder is synced with another On Page project.",
        disk_full: "The disk is full.",
        listing_failed: "The file list could not be read from On Page.",
        other: "Open to see what happened.",
    },
    delete_failed_title: "{label}: files not deleted",
    delete_failed_body: "The downloaded files could not be deleted: they are still in the folder.",
    delete_other_project_body: "The folder now belongs to another On Page project: the files were left where they are.",
    quit_title: "Downloads running",
    quit_message: "Some downloads are running. Quitting stops them: the files already downloaded stay.",
    deleting_title: "Deleting files",
    deleting_message: "The files of a project are being deleted. Quitting stops the deletion: some files stay in the folder.",
    quit_confirm: "Stop and quit",
    cancel: "Cancel",
    ok: "OK",
    config_damaged_title: "Settings damaged",
    config_damaged_detail: "The settings file was damaged. It was set aside in {file}. The app starts without projects.",
    start_failed_title: "On Page Media Downloader could not start",
    start_failed_log: "Details in the log: {file}",
    minutes: forms("1 minute", "{n} minutes"),
    seconds: forms("1 second", "{n} seconds"),
    menu: MenuTexts {
        settings: "Settings…",
        file: "File",
        new_project: "New project…",
        open_folder: "Open folder",
        sync: "Sync",
        sync_selected: "Sync",
        sync_all: "Sync all",
        download: "Download",
        stop: "Stop",
        find: "Find",
        edit: "Edit",
        window: "Window",
    },
};

static DE: Texts = Texts {
    language: AppLanguage::De,
    app_name: APP_NAME,
    open: "Media Downloader öffnen",
    sync_all: "Alle synchronisieren",
    quit: "Beenden",
    tray_idle: "Alle Projekte sind aktuell",
    tray_running: forms("{n} Synchronisierung läuft", "{n} Synchronisierungen laufen"),
    tray_attention: forms("{n} Projekt erfordert Aufmerksamkeit", "{n} Projekte erfordern Aufmerksamkeit"),
    done_title: "{label} ist aktuell",
    done_body: forms("{n} Datei in {duration} heruntergeladen", "{n} Dateien in {duration} heruntergeladen"),
    failed_title: "{label}: Dateien nicht heruntergeladen",
    failed_body: forms(
        "{n} Datei wurde nicht heruntergeladen. Zum Wiederholen öffnen.",
        "{n} Dateien wurden nicht heruntergeladen. Zum Wiederholen öffnen.",
    ),
    error_title: "{label}: Synchronisierung fehlgeschlagen",
    error_body: ErrorBodies {
        token_invalid: "Das API-Token ist ungültig.",
        folder_unreachable: "Der Ordner ist nicht erreichbar.",
        folder_not_writable: "In den Ordner kann nicht geschrieben werden.",
        folder_locked: "Der Ordner wird von einem anderen Computer verwendet.",
        folder_other_project: "Der Ordner wird mit einem anderen On Page-Projekt synchronisiert.",
        disk_full: "Der Datenträger ist voll.",
        listing_failed: "Die Dateiliste konnte nicht von On Page abgerufen werden.",
        other: "Öffnen, um zu sehen, was passiert ist.",
    },
    delete_failed_title: "{label}: Dateien nicht gelöscht",
    delete_failed_body: "Die heruntergeladenen Dateien konnten nicht gelöscht werden und befinden sich noch im Ordner.",
    delete_other_project_body: "Der Ordner gehört jetzt zu einem anderen On Page-Projekt: Die Dateien bleiben, wo sie sind.",
    quit_title: "Downloads laufen",
    quit_message: "Es laufen noch Downloads. Wenn Sie die App beenden, werden sie gestoppt: Bereits heruntergeladene Dateien bleiben erhalten.",
    deleting_title: "Dateien werden gelöscht",
    deleting_message: "Die Dateien eines Projekts werden gerade gelöscht. Wenn Sie die App beenden, wird das Löschen abgebrochen: Einige Dateien bleiben im Ordner.",
    quit_confirm: "Stoppen und beenden",
    cancel: "Abbrechen",
    ok: "OK",
    config_damaged_title: "Einstellungen beschädigt",
    config_damaged_detail: "Die Einstellungsdatei war beschädigt. Die Datei wurde unter {file} aufbewahrt. Die App startet ohne Projekte.",
    start_failed_title: "On Page Media Downloader konnte nicht gestartet werden",
    start_failed_log: "Details im Protokoll: {file}",
    minutes: forms("{n} Minute", "{n} Minuten"),
    seconds: forms("{n} Sekunde", "{n} Sekunden"),
    menu: MenuTexts {
        settings: "Einstellungen…",
        file: "Ablage",
        new_project: "Neues Projekt…",
        open_folder: "Ordner öffnen",
        sync: "Synchronisierung",
        sync_selected: "Synchronisieren",
        sync_all: "Alle synchronisieren",
        download: "Herunterladen",
        stop: "Stoppen",
        find: "Suchen",
        edit: "Bearbeiten",
        window: "Fenster",
    },
};

static ES: Texts = Texts {
    language: AppLanguage::Es,
    app_name: APP_NAME,
    open: "Abrir Media Downloader",
    sync_all: "Sincronizar todo",
    quit: "Salir",
    tray_idle: "Todos los proyectos actualizados",
    tray_running: forms("{n} sincronización en curso", "{n} sincronizaciones en curso"),
    tray_attention: forms("{n} proyecto por revisar", "{n} proyectos por revisar"),
    done_title: "{label}: actualizado",
    done_body: forms("{n} archivo descargado en {duration}", "{n} archivos descargados en {duration}"),
    failed_title: "{label}: archivos no descargados",
    failed_body: forms(
        "{n} archivo no se ha descargado. Abre la app para reintentar.",
        "{n} archivos no se han descargado. Abre la app para reintentar.",
    ),
    error_title: "{label}: sincronización fallida",
    error_body: ErrorBodies {
        token_invalid: "El token de API no es válido.",
        folder_unreachable: "No se puede acceder a la carpeta.",
        folder_not_writable: "No se puede escribir en la carpeta.",
        folder_locked: "Otro ordenador está usando la carpeta.",
        folder_other_project: "La carpeta se sincroniza con otro proyecto de On Page.",
        disk_full: "El disco está lleno.",
        listing_failed: "No se ha podido leer la lista de archivos de On Page.",
        other: "Abre la app para ver qué ha pasado.",
    },
    delete_failed_title: "{label}: archivos no eliminados",
    delete_failed_body: "No se han podido eliminar los archivos descargados: siguen en la carpeta.",
    delete_other_project_body: "La carpeta ahora es de otro proyecto de On Page: los archivos se han quedado donde estaban.",
    quit_title: "Descargas en curso",
    quit_message: "Hay descargas en curso. Si sales, se detendrán: los archivos ya descargados se conservan.",
    deleting_title: "Eliminando archivos",
    deleting_message: "Se están eliminando los archivos de un proyecto. Si sales, la eliminación se interrumpe y algunos archivos se quedan en la carpeta.",
    quit_confirm: "Detener y salir",
    cancel: "Cancelar",
    ok: "Aceptar",
    config_damaged_title: "Ajustes dañados",
    config_damaged_detail: "El archivo de ajustes estaba dañado. Se ha guardado aparte en {file}. La app se inicia sin proyectos.",
    start_failed_title: "On Page Media Downloader no se ha podido iniciar",
    start_failed_log: "Detalles en el registro: {file}",
    minutes: forms("{n} minuto", "{n} minutos"),
    seconds: forms("{n} segundo", "{n} segundos"),
    menu: MenuTexts {
        settings: "Ajustes…",
        file: "Archivo",
        new_project: "Nuevo proyecto…",
        open_folder: "Abrir carpeta",
        sync: "Sincronización",
        sync_selected: "Sincronizar",
        sync_all: "Sincronizar todo",
        download: "Descargar",
        stop: "Detener",
        find: "Buscar",
        edit: "Edición",
        window: "Ventana",
    },
};

static FR: Texts = Texts {
    language: AppLanguage::Fr,
    app_name: APP_NAME,
    open: "Ouvrir Media Downloader",
    sync_all: "Tout synchroniser",
    quit: "Quitter",
    tray_idle: "Tous les projets sont à jour",
    tray_running: forms("{n} synchronisation en cours", "{n} synchronisations en cours"),
    tray_attention: forms("{n} projet à vérifier", "{n} projets à vérifier"),
    done_title: "{label}\u{a0}: à jour",
    done_body: forms("{n} fichier téléchargé en {duration}", "{n} fichiers téléchargés en {duration}"),
    failed_title: "{label}\u{a0}: fichiers non téléchargés",
    failed_body: forms(
        "{n} fichier n’a pas été téléchargé. Ouvrez l’app pour réessayer.",
        "{n} fichiers n’ont pas été téléchargés. Ouvrez l’app pour réessayer.",
    ),
    error_title: "{label}\u{a0}: échec de la synchronisation",
    error_body: ErrorBodies {
        token_invalid: "Le jeton d’API n’est pas valide.",
        folder_unreachable: "Le dossier est inaccessible.",
        folder_not_writable: "Impossible d’écrire dans le dossier.",
        folder_locked: "Un autre ordinateur utilise le dossier.",
        folder_other_project: "Le dossier est synchronisé avec un autre projet On Page.",
        disk_full: "Le disque est plein.",
        listing_failed: "Impossible de lire la liste des fichiers sur On Page.",
        other: "Ouvrez l’app pour voir ce qui s’est passé.",
    },
    delete_failed_title: "{label}\u{a0}: fichiers non supprimés",
    delete_failed_body: "Impossible de supprimer les fichiers téléchargés\u{a0}: ils sont toujours dans le dossier.",
    delete_other_project_body: "Le dossier appartient désormais à un autre projet On Page\u{a0}: les fichiers sont restés en place.",
    quit_title: "Téléchargements en cours",
    quit_message: "Des téléchargements sont en cours. Si vous quittez, ils seront arrêtés\u{a0}: les fichiers déjà téléchargés sont conservés.",
    deleting_title: "Suppression en cours",
    deleting_message: "Les fichiers d’un projet sont en cours de suppression. Si vous quittez, la suppression s’arrête\u{a0}: certains fichiers restent dans le dossier.",
    quit_confirm: "Arrêter et quitter",
    cancel: "Annuler",
    ok: "OK",
    config_damaged_title: "Paramètres endommagés",
    config_damaged_detail: "Le fichier des paramètres était endommagé. Il a été mis de côté dans {file}. L’app démarre sans projets.",
    start_failed_title: "On Page Media Downloader n’a pas pu démarrer",
    start_failed_log: "Détails dans le journal\u{a0}: {file}",
    minutes: forms("{n} minute", "{n} minutes"),
    seconds: forms("{n} seconde", "{n} secondes"),
    menu: MenuTexts {
        settings: "Paramètres…",
        file: "Fichier",
        new_project: "Nouveau projet…",
        open_folder: "Ouvrir le dossier",
        sync: "Synchronisation",
        sync_selected: "Synchroniser",
        sync_all: "Tout synchroniser",
        download: "Télécharger",
        stop: "Arrêter",
        find: "Rechercher",
        edit: "Édition",
        window: "Fenêtre",
    },
};

static RU: Texts = Texts {
    language: AppLanguage::Ru,
    app_name: APP_NAME,
    open: "Открыть Media Downloader",
    sync_all: "Синхронизировать всё",
    quit: "Выйти",
    tray_idle: "Все проекты актуальны",
    tray_running: slavic("Идёт {n} синхронизация", "Идут {n} синхронизации", "Идёт {n} синхронизаций"),
    tray_attention: slavic(
        "{n} проект требует внимания",
        "{n} проекта требуют внимания",
        "{n} проектов требуют внимания",
    ),
    done_title: "{label}: всё актуально",
    done_body: slavic(
        "Скачан {n} файл за {duration}",
        "Скачаны {n} файла за {duration}",
        "Скачано {n} файлов за {duration}",
    ),
    failed_title: "{label}: файлы не скачаны",
    failed_body: slavic(
        "Не удалось скачать {n} файл. Откройте, чтобы повторить попытку.",
        "Не удалось скачать {n} файла. Откройте, чтобы повторить попытку.",
        "Не удалось скачать {n} файлов. Откройте, чтобы повторить попытку.",
    ),
    error_title: "{label}: синхронизация не удалась",
    error_body: ErrorBodies {
        token_invalid: "Неверный API-токен.",
        folder_unreachable: "Папка недоступна.",
        folder_not_writable: "Запись в папку невозможна.",
        folder_locked: "Папку использует другой компьютер.",
        folder_other_project: "Папка синхронизируется с другим проектом On Page.",
        disk_full: "Диск заполнен.",
        listing_failed: "Не удалось получить список файлов с On Page.",
        other: "Откройте, чтобы узнать, что произошло.",
    },
    delete_failed_title: "{label}: файлы не удалены",
    delete_failed_body: "Не удалось удалить скачанные файлы: они остались в папке.",
    delete_other_project_body: "Папка теперь относится к другому проекту On Page: файлы остались на месте.",
    quit_title: "Идёт скачивание",
    quit_message: "Файлы ещё скачиваются. Если выйти, скачивание остановится: уже скачанные файлы сохранятся.",
    deleting_title: "Идёт удаление",
    deleting_message: "Файлы проекта удаляются. Если выйти, удаление прервётся: часть файлов останется в папке.",
    quit_confirm: "Остановить и выйти",
    cancel: "Отмена",
    ok: "ОК",
    config_damaged_title: "Настройки повреждены",
    config_damaged_detail: "Файл настроек был повреждён. Он сохранён отдельно: {file}. Приложение запускается без проектов.",
    start_failed_title: "Не удалось запустить On Page Media Downloader",
    start_failed_log: "Подробности в журнале: {file}",
    // The duration of done_body, after «за»: the accusative (за 1 минуту, за 2 минуты, за 5 минут)
    minutes: slavic("{n} минуту", "{n} минуты", "{n} минут"),
    seconds: slavic("{n} секунду", "{n} секунды", "{n} секунд"),
    menu: MenuTexts {
        settings: "Настройки…",
        file: "Файл",
        new_project: "Новый проект…",
        open_folder: "Открыть папку",
        sync: "Синхронизация",
        sync_selected: "Синхронизировать",
        sync_all: "Синхронизировать всё",
        download: "Скачать",
        stop: "Остановить",
        find: "Найти",
        edit: "Правка",
        window: "Окно",
    },
};

static SV: Texts = Texts {
    language: AppLanguage::Sv,
    app_name: APP_NAME,
    open: "Öppna Media Downloader",
    sync_all: "Synkronisera alla",
    quit: "Avsluta",
    tray_idle: "Alla projekt är uppdaterade",
    tray_running: forms("{n} synkronisering pågår", "{n} synkroniseringar pågår"),
    tray_attention: same("{n} projekt behöver kontrolleras"),
    done_title: "{label} har uppdaterats",
    done_body: forms("{n} fil laddades ner på {duration}", "{n} filer laddades ner på {duration}"),
    failed_title: "{label}: filer laddades inte ner",
    failed_body: forms(
        "{n} fil laddades inte ner. Öppna för att försöka igen.",
        "{n} filer laddades inte ner. Öppna för att försöka igen.",
    ),
    error_title: "{label}: synkroniseringen misslyckades",
    error_body: ErrorBodies {
        token_invalid: "Projektets API-token är ogiltig.",
        folder_unreachable: "Mappen kan inte nås.",
        folder_not_writable: "Det går inte att skriva i mappen.",
        folder_locked: "Mappen används av en annan dator.",
        folder_other_project: "Mappen synkroniseras med ett annat On Page-projekt.",
        disk_full: "Disken är full.",
        listing_failed: "Det gick inte att läsa fillistan från On Page.",
        other: "Öppna för att se vad som hände.",
    },
    delete_failed_title: "{label}: filerna togs inte bort",
    delete_failed_body: "De nedladdade filerna kunde inte tas bort: de finns kvar i mappen.",
    delete_other_project_body: "Mappen hör nu till ett annat On Page-projekt: filerna ligger kvar där de var.",
    quit_title: "Nedladdningar pågår",
    quit_message: "Nedladdningar pågår. Om du avslutar stoppas de: filer som redan har laddats ner finns kvar.",
    deleting_title: "Filer tas bort",
    deleting_message: "Filerna i ett projekt håller på att tas bort. Om du avslutar avbryts borttagningen: vissa filer blir kvar i mappen.",
    quit_confirm: "Stoppa och avsluta",
    cancel: "Avbryt",
    ok: "OK",
    config_damaged_title: "Inställningarna är skadade",
    config_damaged_detail: "Inställningsfilen var skadad. Den har sparats undan som {file}. Appen startar utan projekt.",
    start_failed_title: "On Page Media Downloader kunde inte starta",
    start_failed_log: "Detaljer finns i loggen: {file}",
    minutes: forms("{n} minut", "{n} minuter"),
    seconds: forms("{n} sekund", "{n} sekunder"),
    menu: MenuTexts {
        settings: "Inställningar…",
        file: "Arkiv",
        new_project: "Nytt projekt…",
        open_folder: "Öppna mapp",
        sync: "Synkronisering",
        sync_selected: "Synkronisera",
        sync_all: "Synkronisera alla",
        download: "Ladda ner",
        stop: "Stoppa",
        find: "Sök",
        edit: "Redigera",
        window: "Fönster",
    },
};

static ZH: Texts = Texts {
    language: AppLanguage::Zh,
    app_name: APP_NAME,
    open: "打开 Media Downloader",
    sync_all: "全部同步",
    quit: "退出",
    tray_idle: "所有项目均为最新",
    tray_running: same("{n} 个同步进行中"),
    tray_attention: same("{n} 个项目需要注意"),
    done_title: "{label}：已是最新",
    done_body: same("已下载 {n} 个文件，用时 {duration}"),
    failed_title: "{label}：文件未下载",
    failed_body: same("{n} 个文件未能下载。打开即可重试。"),
    error_title: "{label}：同步失败",
    error_body: ErrorBodies {
        token_invalid: "API 令牌无效。",
        folder_unreachable: "文件夹无法访问。",
        folder_not_writable: "无法写入文件夹。",
        folder_locked: "另一台计算机正在使用该文件夹。",
        folder_other_project: "该文件夹正在与另一个 On Page 项目同步。",
        disk_full: "磁盘已满。",
        listing_failed: "无法从 On Page 读取文件列表。",
        other: "打开即可查看详情。",
    },
    delete_failed_title: "{label}：文件未删除",
    delete_failed_body: "无法删除已下载的文件：它们仍在文件夹中。",
    delete_other_project_body: "该文件夹现在属于另一个 On Page 项目：文件保留在原处。",
    quit_title: "正在下载",
    quit_message: "有文件正在下载。如果退出，下载将停止：已下载的文件会保留。",
    deleting_title: "正在删除文件",
    deleting_message: "正在删除某个项目的文件。如果退出，删除将中断：部分文件会留在文件夹中。",
    quit_confirm: "停止并退出",
    cancel: "取消",
    ok: "确定",
    config_damaged_title: "设置已损坏",
    config_damaged_detail: "设置文件已损坏。原文件已另存为 {file}。应用将以空项目列表启动。",
    start_failed_title: "On Page Media Downloader 无法启动",
    start_failed_log: "详细信息见日志：{file}",
    minutes: same("{n} 分钟"),
    seconds: same("{n} 秒"),
    menu: MenuTexts {
        settings: "设置…",
        file: "文件",
        new_project: "新建项目…",
        open_folder: "打开文件夹",
        sync: "同步",
        sync_selected: "同步",
        sync_all: "全部同步",
        download: "下载",
        stop: "停止",
        find: "查找",
        edit: "编辑",
        window: "窗口",
    },
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plural_categories() {
        let ru = texts(AppLanguage::Ru);
        assert_eq!(ru.tray_attention(1), "1 проект требует внимания");
        assert_eq!(ru.tray_attention(3), "3 проекта требуют внимания");
        assert_eq!(ru.tray_attention(11), "11 проектов требуют внимания");
        assert_eq!(ru.tray_attention(22), "22 проекта требуют внимания");
        assert_eq!(
            texts(AppLanguage::Fr).failed_body(0),
            "0 fichier n’a pas été téléchargé. Ouvrez l’app pour réessayer."
        );
        assert_eq!(texts(AppLanguage::En).tray_running(2), "2 syncs running");
        assert_eq!(texts(AppLanguage::Zh).tray_running(1), "1 个同步进行中");
    }

    #[test]
    fn durations() {
        let it = texts(AppLanguage::It);
        assert_eq!(it.duration(400), "1 secondo");
        assert_eq!(it.duration(42_000), "42 secondi");
        assert_eq!(it.duration(150_000), "3 minuti");
        assert_eq!(it.done_body(5, &it.duration(61_000)), "5 file scaricati in 1 minuto");
    }

    #[test]
    fn system_languages() {
        assert_eq!(system_language(&["de-CH".into(), "en".into()]), AppLanguage::De);
        assert_eq!(system_language(&["pt_BR".into(), "zh-Hans-CN".into()]), AppLanguage::Zh);
        assert_eq!(system_language(&["ja".into()]), AppLanguage::En);
    }

    #[test]
    fn every_language_names_its_texts() {
        for language in AppLanguage::ALL {
            let t = texts(language);
            assert_eq!(t.language, language);
            assert!(t.done_title("X").contains('X'));
            assert!(t.config_damaged_detail("F").contains('F'));
            assert!(t.failed_body(7).contains('7'));
        }
    }
}
