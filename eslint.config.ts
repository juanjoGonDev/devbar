import vitest from '@vitest/eslint-plugin';
import tseslint from 'typescript-eslint';

const typedFiles = [
  'src/**/*.ts',
  'renderer/**/*.ts',
  'scripts/**/*.ts',
  'tests/**/*.ts',
];

const engineeringRules = {
  complexity: ['error', { max: 50 }],
  'max-depth': ['error', 6],
  'max-params': ['error', 7],
} as const;

const testFiles = ['tests/**/*.test.ts'];

const vitestLayoutRules = {
  'vitest/consistent-test-it': ['error', { fn: 'it' }],
  'vitest/expect-expect': [
    'error',
    {
      assertFunctionNames: [
        'expect',
        'expectValid',
        'expectInvalid',
        'expectFailed',
        'expectSucceeded',
        'expectPresent',
        'expectOccurrence',
      ],
    },
  ],
  'vitest/no-focused-tests': 'error',
  'vitest/no-identical-title': 'error',
  'vitest/no-standalone-expect': 'error',
  'vitest/require-top-level-describe': 'error',
  'vitest/valid-describe-callback': 'error',
  'vitest/valid-expect': ['error', { maxArgs: 2 }],
  'vitest/valid-expect-in-promise': 'error',
  'vitest/valid-title': ['error', { ignoreTypeOfDescribeName: true }],
} as const;

export default tseslint.config(
  {
    ignores: [
      'build/**',
      // `pnpm test:coverage` writes an HTML report here whose vendored
      // scripts are not ours to lint.
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'eslint.config.ts',
      'vitest.config.ts',
    ],
  },
  {
    files: typedFiles,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.node.json',
          './tsconfig.renderer.json',
          './tsconfig.tests.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      ...engineeringRules,
    },
  },
  {
    files: testFiles,
    plugins: { vitest },
    rules: {
      ...vitestLayoutRules,
    },
  },
  {
    files: ['renderer/config.ts'],
    rules: {
      // Existing editor orchestration has many validation branches. A UX-flow
      // refactor is outside this migration; keep the guard visible and scoped.
      complexity: 'off',
    },
  },
);
