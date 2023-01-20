import { createI18n } from 'vue-i18n'
import { App } from 'vue'

import it from '../i18n/it.json'
import en from '../i18n/en.json'

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
      },
    })

    app.use(i18n)
  },
}
