// AF-20: lint mínimo, sem regras de estilo (critério 6). Ver README, seção CI.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['data/', 'coverage/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
    },
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    ignores: ['src/shared/**'],
    languageOptions: { globals: globals.node },
  },
  // Servido ao navegador em /shared/* e importado pelo servidor: só o que existe nos dois.
  { files: ['src/shared/**/*.js'], languageOptions: { globals: globals['shared-node-browser'] } },
  { files: ['web/**/*.js'], languageOptions: { globals: globals.browser } },
];
