import js from '@eslint/js'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/** Vue and TypeScript rules; formatting is Prettier's (`yarn format`), not the linter's */
export default defineConfigWithVueTs(
  {
    ignores: [
      'out/**',
      'dist/**',
      'build/**',
      'bin/**',
      'target/**',
      'src-tauri/**',
      'crates/**',
      'src/renderer/src/lib/icons/pro.generated.ts',
    ],
  },
  js.configs.recommended,
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommendedTypeChecked,
  skipFormatting,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // Async functions that return a value at once keep the async signature of their interface
      '@typescript-eslint/require-await': 'off',
      // Vue and vue-i18n hand out functions meant to be passed around (t, emit…)
      '@typescript-eslint/unbound-method': 'off',
      // Caught errors are rethrown as they came (JobError, DiskError, Node's errors): these two misjudge them
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'vue/no-v-text-v-html-on-component': 'off',
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/prop-name-casing': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-base-to-string': 'off' },
  },
  {
    // reactive({ list: {} as Record<…> }): the assertions decide the state's type
    files: ['src/renderer/src/store.ts', 'src/renderer/src/components/InspectorPanel.vue'],
    rules: { '@typescript-eslint/no-unnecessary-type-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
)
