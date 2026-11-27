// AF-20: lint mínimo, sem regras de estilo (critério 6). Ver README, seção CI.
import js from '@eslint/js';
import globals from 'globals';

// AF-23 (critério 5, decisão do Gerente após o QA): camada de AST da varredura de fuso. Em web/** e
// src/shared/** (exceto zoned-time.js, o único ponto de conversão) não há relógio nem fuso local:
// nenhuma referência a Date (também via globalThis/window/self ou membro computado), a
// Intl.DateTimeFormat/DateTimeFormat por qualquer acesso, a toLocale*String nem aos getters e
// setters locais. A varredura por texto (test/unit/timezone-scan.test.js) continua valendo.
const TZ_MESSAGE = 'AF-23: sem relógio nem fuso local aqui; use src/shared/zoned-time.js (instantToLocal, localToInstant, instantToIso).';
const TZ_NAMES = '(?:Date|Temporal|DateTimeFormat|toLocaleString|toLocaleDateString|toLocaleTimeString|getTimezoneOffset|valueAsDate|(?:get|set)(?:FullYear|Year|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds))';
const TZ_RE = `/^${TZ_NAMES}$/`;
const TZ_PROPERTIES = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'getTimezoneOffset', 'valueAsDate',
  ...['FullYear', 'Year', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds'].flatMap((p) => [`get${p}`, `set${p}`])];
const TZ_RULES = {
  'no-restricted-globals': ['error', { name: 'Date', message: TZ_MESSAGE }, { name: 'Temporal', message: TZ_MESSAGE }],
  'no-restricted-properties': ['error',
    ...['globalThis', 'window', 'self'].flatMap((object) => ['Date', 'Temporal'].map((property) => ({ object, property, message: TZ_MESSAGE }))),
    { object: 'Intl', property: 'DateTimeFormat', message: TZ_MESSAGE },
    ...TZ_PROPERTIES.map((property) => ({ property, message: TZ_MESSAGE })),
  ],
  'no-restricted-syntax': ['error',
    // Identificador com o nome (referência, propriedade, chave de desestruturação, `.call`).
    { selector: `Identifier[name=${TZ_RE}]`, message: TZ_MESSAGE },
    // Membro computado ou `Reflect.get(Intl, 'DateTimeFormat')`: string com o nome exato.
    { selector: `Literal[value=${TZ_RE}]`, message: TZ_MESSAGE },
    { selector: `TemplateLiteral[expressions.length=0] > TemplateElement[value.raw=${TZ_RE}]`, message: TZ_MESSAGE },
  ],
};

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
  { files: ['web/**/*.js', 'src/shared/**/*.js'], ignores: ['src/shared/zoned-time.js'], rules: TZ_RULES },
];
