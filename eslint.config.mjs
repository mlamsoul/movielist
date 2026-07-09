import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: {
      ecmaVersion: 2026,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Qualité
      'no-unused-vars': 'error',
      'no-debugger': 'error',

      'no-param-reassign': ['error', { props: true, ignorePropertyModificationsFor: ['counter'] }],
      camelcase: ['error', { properties: 'never', ignoreDestructuring: true }],

      // Style strict
      eqeqeq: ['error', 'always'], // === mandatory
      'no-var': 'error', // const/let uniquement
      'prefer-const': 'error', // const par défaut
      'prefer-arrow-callback': 'error', // arrow functions
      quotes: ['error', 'single', { avoidEscape: true }],

      // ESM
      'no-duplicate-imports': 'error',
    },
  },
  { files: ['**/*.js'], languageOptions: { sourceType: 'script' } },
]);
