import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve('src/shared') }
/** The Pro light icons when scripts/pro-icons.mjs generated them (a build with an On Page token), else Font Awesome Free */
const PRO_ICONS = resolve('src/renderer/src/lib/icons/pro.generated.ts')
const icons = existsSync(PRO_ICONS) ? PRO_ICONS : resolve('src/renderer/src/lib/icons/free.ts')

/**
 * The Content-Security-Policy of the renderer's page, by mode. The build loads
 * nothing but its own files, data and blob images and the previews of On Page's
 * storage (the duplicates tab); the development server also needs the
 * WebSocket of Vite's client.
 */
const CSP = {
  build: [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://storage.onpage.it",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ],
  serve: [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
  ],
}
function contentSecurityPolicy(): Plugin {
  let policy = CSP.build
  return {
    name: 'content-security-policy',
    configResolved(config) {
      policy = config.command == 'serve' ? CSP.serve : CSP.build
    },
    /** First in <head>: it applies to every script and style after it */
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy.join('; ') }, injectTo: 'head-prepend' },
    ],
  }
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      /** electron-store is ESM only: bundled into main rather than required at run time */
      externalizeDeps: { exclude: ['electron-store'] },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          /** The sync engine, started by main as an Electron utility process */
          engine: resolve('src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    /** The renderer is sandboxed: the preload must not require anything but electron */
    build: { externalizeDeps: false },
  },
  renderer: {
    resolve: {
      alias: {
        ...shared,
        '#icons': icons,
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [vue(), tailwindcss(), contentSecurityPolicy()],
    /** vue-i18n: the Composition API only (useI18n), none of its global components or directive, no devtools in the build */
    define: {
      __VUE_I18N_FULL_INSTALL__: false,
      __VUE_I18N_LEGACY_API__: false,
      __INTLIFY_PROD_DEVTOOLS__: false,
    },
    build: {
      /** Minified, without comments but the licenses' */
      minify: true,
      rolldownOptions: { output: { comments: { legal: true, annotation: false, jsdoc: false } } },
    },
  },
})
