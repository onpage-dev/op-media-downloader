#!/usr/bin/env node

// Silences: ExperimentalWarning: The Fetch API is an experimental feature.
process.removeAllListeners('warning')

const lodash = require('lodash')
const { readFileSync, writeFileSync, existsSync } = require('fs')
const path = require('path')

const TOKEN = process.argv[2]
const source = 'it'
const langs = ['en']
translateAll()

if (TOKEN == 'forget') {
  const path = process.argv[3]
  console.log('Forgetting translations of', `${path}`)
  const path_array = path.split('.')
  langs.forEach(lang => {
    data = readLangFile(lang)
    forget(data, path_array)
    writeLangFile(lang, data)
  })
  process.exit(0)
}
if (TOKEN == 'remove') {
  const path = process.argv[3]
  console.log('Forgetting translations of', `${path}`)
  const path_array = path.split('.')
  ;[source].concat(langs).forEach(lang => {
    data = readLangFile(lang)
    forget(data, path_array)
    writeLangFile(lang, data)
  })
  process.exit(0)
}

function forget(data, path) {
  if (path.length == 1) {
    let keytoforget = path[0]
    const is_wildcard = keytoforget.endsWith('*')
    if (is_wildcard) {
      console.log('is wildcard')
      keytoforget = keytoforget.substring(0, keytoforget.length - 1)
      lodash.each(data, (value, key) => {
        if (key.startsWith(keytoforget)) {
          delete data[key]
        }
      })
    } else {
      delete data[keytoforget]
    }
  } else {
    forget(data[path[0]], path.slice(1))
  }
}

function langFilePath(lang) {
  return path.join(__dirname, '..', 'src', 'renderer', 'i18n', `${lang}.json`)
}
function readLangFile(lang, allow_file_not_found) {
  const sourcePath = langFilePath(lang)
  if (allow_file_not_found) {
    if (!existsSync(sourcePath)) {
      return {}
    }
  }
  const data = readFileSync(sourcePath, 'utf8')
  return JSON.parse(data)
}

async function translateAll() {
  for (const lang of langs) {
    void translateLang(lang)
  }
}

async function translateLang(lang) {
  console.log(`Translating ${lang}...`)

  const res = await fetch(
    `https://app.onpage.it/api/translations/json/${source}/${lang}?encode=curly-within`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: TOKEN,
      },
      body: JSON.stringify({
        data: readLangFile(source),
        glossary: readLangFile(lang),
      }),
    },
  )

  if (res.status != 200) {
    console.log('Invalid response', res.status)
  } else {
    console.log(lang, res.status)
    const json = await res.json()

    // Overwrite some translations
    // lodash.merge(json, readLangFile(`${lang}-overwrites`, true))

    writeLangFile(lang, json)
  }
}

function writeLangFile(lang, data) {
  const destPath = langFilePath(lang)
  writeFileSync(destPath, JSON.stringify(data, null, 2), 'utf8')
}
