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
  // Counted in CODE lines: this repo comments heavily and explains its
  // reasoning inline, and a raw line count would penalise exactly the files
  // that document themselves best. 400 is the repo's own grain rather than a
  // round number — after the module split, every source and test file sits
  // under it, and the only exception is the generated table excluded below.
  'max-lines': [
    'error',
    { max: 400, skipBlankLines: true, skipComments: true },
  ],
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
      // A higher cap than source, because the two sizes mean different
      // things: a long source file is a responsibility problem, a long test
      // file is usually just a lot of independent cases. It still has a
      // ceiling — past this a file stops being navigable whatever it holds —
      // and nothing is grandfathered in under it.
      'max-lines': [
        'error',
        { max: 800, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ['src/icon-battery.ts'],
    rules: {
      // A flat emoji table generated from unicode.org's emoji-test.txt, not
      // hand-written code. Splitting it would buy nothing a reviewer values,
      // and regenerating it must stay a single mechanical step.
      'max-lines': 'off',
    },
  },
);
