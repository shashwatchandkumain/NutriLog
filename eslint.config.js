import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'supabase/functions/', 'food_db.js', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser, ...globals.serviceworker } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
  { files: ['js/theme-init.js', 'sw.js'], languageOptions: { sourceType: 'script' } },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
];
