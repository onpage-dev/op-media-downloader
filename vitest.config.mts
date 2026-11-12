import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/** The page's tests; the app's and the service's are Rust tests (`cargo test --workspace`) */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      // The free icons, in git: the tests are the same with or without the Pro ones
      '#icons': resolve('src/renderer/src/lib/icons/free.ts'),
    },
  },
  test: {
    include: ['src/renderer/**/*.test.ts', 'src/shared/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
})
