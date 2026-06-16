'use strict';

// Flat ESLint config adapted (JS, no TypeScript) from the Iteronix setup.
// Focus: catch unused symbols and guard against over-engineering. Globals
// are scoped per area because DevBar mixes CommonJS (main process), classic
// browser scripts that share globals via <script> tags (tray popover), and
// ES modules (the silenced window).

const globals = require('globals');

// Over-engineering guards — generous thresholds (match Iteronix); they flag
// only genuinely runaway code, not normal complexity.
const overEngineering = {
  complexity: ['error', { max: 50 }],
  'max-depth': ['error', 6],
  'max-params': ['error', 7],
};

// "Sin usar" detection + basic correctness. argsIgnorePattern allows the
// `_e`/`_event` convention for deliberately-unused callback params.
const baseRules = {
  'no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
  ],
  'no-undef': 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  ...overEngineering,
};

// Renderer classic scripts load via <script src> and share top-level
// functions through the global object. Declare those cross-file symbols so
// no-undef doesn't flag legitimate shared globals.
const rendererSharedGlobals = {
  formatUptime: 'readonly',
  createCombobox: 'readonly',
  attachDragHandlers: 'readonly',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'assets/**',
      '**/*.log',
      'pnpm-lock.yaml',
    ],
  },

  // ── Main process + shared modules (CommonJS, Node) ──────────────────
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...baseRules },
  },

  // ── Build/util scripts + root config files (Node) ───────────────────
  {
    files: ['scripts/**/*.js', '*.cjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...baseRules,
      complexity: 'off',
      'max-depth': 'off',
      'max-params': 'off',
    },
  },

  // ── Renderer classic scripts (browser, shared <script> globals) ─────
  {
    files: ['renderer/**/*.js'],
    ignores: ['renderer/silenced.js', 'renderer/silence-ui.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...rendererSharedGlobals },
    },
    rules: { ...baseRules },
  },

  // ── Renderer ES modules (silenced window) ───────────────────────────
  {
    files: ['renderer/silenced.js', 'renderer/silence-ui.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...baseRules },
  },

  // ── Tests (Vitest, ES modules, Node) ────────────────────────────────
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...baseRules,
      complexity: 'off',
      'max-depth': 'off',
      'max-params': 'off',
    },
  },
];
