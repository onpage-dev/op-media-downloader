import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
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
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
})
