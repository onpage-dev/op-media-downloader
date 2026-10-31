import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import { existsSync } from 'fs'
import { resolve } from 'path'

const shared = { '@shared': resolve('src/shared') }
/** The Pro light icons when scripts/pro-icons.mjs generated them (a build with an On Page token), else Font Awesome Free */
const PRO_ICONS = resolve('src/renderer/src/lib/icons/pro.generated.ts')
const icons = existsSync(PRO_ICONS) ? PRO_ICONS : resolve('src/renderer/src/lib/icons/free.ts')

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
    plugins: [vue()],
  },
})
