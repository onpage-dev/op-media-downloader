import { createI18n } from 'vue-i18n'
import { App } from 'vue'

import it from '../i18n/it.json'
import en from '../i18n/en.json'
import de from '../i18n/de.json'
import fr from '../i18n/fr.json'
import zh from '../i18n/zh.json'
import ru from '../i18n/ru.json'
import es from '../i18n/es.json'

export default {
  install(app: App): void {
    const i18n = createI18n({
      legacy: false,
      globalInjection: true,
      locale: 'it',
      fallbackLocale: 'it',
      datetimeFormats: {
        it: {
          date: {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          },
          dateLong: {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          },
          dateTime: {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
          },
          dateTimeSeconds: {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
          },
          time: {
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
          },
          short: {
            month: 'short',
            day: 'numeric',
          },
        },
      },
      messages: {
        it: it,
        en: en,
        de: de,
        es: es,
        fr: fr,
        zh: zh,
        ru: ru,
      },
    })

    app.use(i18n)
  },
}
