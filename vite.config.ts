/**
 * The renderer (`src/renderer`), built into `dist/renderer` for the Tauri app
 * (`frontendDist` in src-tauri/tauri.conf.json) and served on port 5173 for
 * `tauri dev` (`devUrl`). `yarn dev:renderer` alone in a browser shows the
 * mockup's projects (`src/renderer/src/dev`). The Content-Security-Policy is
 * the app's (`app.security.csp` in tauri.conf.json): Tauri adds it to the page.
 */
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'

/** The Pro light icons when scripts/pro-icons.mjs generated them (a build with an On Page token), else Font Awesome Free */
const PRO_ICONS = resolve('src/renderer/src/lib/icons/pro.generated.ts')
const icons = existsSync(PRO_ICONS) ? PRO_ICONS : resolve('src/renderer/src/lib/icons/free.ts')
/** `tauri dev` on a device of the network sets it; on this computer the page is on localhost */
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '#icons': icons,
      '@renderer': resolve('src/renderer/src'),
    },
  },
  plugins: [vue(), tailwindcss()],
  /** vue-i18n: the Composition API only (useI18n), none of its global components or directive, no devtools in the build */
  define: {
    __VUE_I18N_FULL_INSTALL__: false,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  /** Tauri's own messages stay on the terminal */
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    /** Rust's build output changes all the time: not the page's business */
    watch: { ignored: ['**/src-tauri/**', '**/target/**', '**/crates/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: resolve('dist/renderer'),
    emptyOutDir: true,
    /** Minified, without comments but the licenses' */
    minify: true,
    rolldownOptions: { output: { comments: { legal: true, annotation: false, jsdoc: false } } },
  },
})
