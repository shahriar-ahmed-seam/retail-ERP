// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { appendOnlyRestrictedSyntax } from './eslint-rules/append-only.mjs';

/**
 * ESLint flat config (ESLint 9, typescript-eslint 8).
 *
 * Layout:
 *   - Global ignore list (build output, deps, generated artifacts).
 *   - Base JS recommended rules.
 *   - typescript-eslint recommended-type-checked + stylistic-type-checked.
 *   - eslint-plugin-import with import/order grouped by alias path.
 *   - React + React Hooks rules scoped to the renderer.
 *   - Node/Electron globals scoped to main + preload.
 *   - eslint-config-prettier disables stylistic rules that conflict with Prettier.
 *
 * Type-aware linting uses typescript-eslint's `projectService` so the three
 * per-process tsconfigs (main, preload, renderer) are picked up automatically
 * without us hard-coding a project list.
 */

/** Path alias groups for import/order. Mirrors tsconfig.json `paths`. */
const internalAliasPattern = '@(main|preload|renderer|shared)/**';

export default tseslint.config(
  // 1. Global ignores. Anything matched here is excluded from every config object below.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'prisma/migrations/**',
      '**/*.db',
      // ESLint's own config files do not need to be linted with type-aware rules.
      'eslint.config.mjs',
      // Plain ES modules consumed by `eslint.config.mjs` itself —
      // not part of any tsconfig project (Req 10.5 / 13.4 selector
      // definitions).
      'eslint-rules/**',
    ],
  },

  // 2. Base JS recommended rules.
  js.configs.recommended,

  // 3. typescript-eslint recommended type-checked + stylistic.
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // 4. TypeScript files: language options + import plugin + project-wide tweaks.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Explicit project list. Each per-process tsconfig owns a different
        // slice of `src/`; tsconfig.eslint.json covers root-level config files
        // and the tests/ tree which aren't in the build configs.
        project: [
          './tsconfig.main.json',
          './tsconfig.preload.json',
          './tsconfig.renderer.json',
          './tsconfig.eslint.json',
        ],
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.main.json', './tsconfig.preload.json', './tsconfig.renderer.json'],
        },
        node: true,
      },
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'],
      },
    },
    rules: {
      // Import ordering: built-ins → externals → internal aliases → relative.
      'import/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'object',
            'type',
          ],
          pathGroups: [
            {
              pattern: internalAliasPattern,
              group: 'internal',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
      'import/no-self-import': 'error',
      // TypeScript's resolver is the source of truth here; eslint-plugin-import's
      // own resolver double-checks add latency without catching anything new.
      'import/no-unresolved': 'off',

      // Unused-vars: allow the `_`-prefix convention so destructured / placeholder
      // values don't fight strict linting.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // Allow `void expr` to mark deliberately discarded promises, which we use
      // in src/main/index.ts for win.loadURL / win.loadFile.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreVoidOperator: true }],

      // Boolean expressions: noUncheckedIndexedAccess + exactOptionalPropertyTypes
      // make explicit comparisons more idiomatic, but the strict variant fights
      // common patterns like `if (process.env.X)` at the edges. Keep the default.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
    },
  },

  // 5. Renderer (React) files.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      // React 19 + new JSX transform: no need for React in scope, no prop-types.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  // 6. Node/Electron-main + preload files.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // 6a. Append-only guard for `journal_entries` and `audit_logs`
  //     (task 11.5, Req 10.5 + 13.4). The journal and audit logs are
  //     append-only by contract — no service method may call
  //     `update`, `delete`, `updateMany`, or `deleteMany` on the
  //     `journalEntry` or `auditLog` Prisma delegates anywhere under
  //     `src/`. The rule is enforced statically via `no-restricted-syntax`
  //     so the build fails before the call ever reaches runtime.
  //
  //     The selectors live in `eslint-rules/append-only.mjs` so the
  //     build and the unit test under
  //     `tests/unit/main/eslint/append-only-journal.test.ts` use one
  //     source of truth. Tests under `tests/` may legitimately read
  //     from the append-only tables (counting rows after a recovery
  //     replay, for example), so the guard is intentionally scoped to
  //     `src/**` only.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...appendOnlyRestrictedSyntax],
    },
  },

  // 7. Test files: relax a few rules that fight property-based tests / fixtures.
  {
    files: ['tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // 8. Prettier compatibility shim — disables ESLint stylistic rules that
  //    overlap with Prettier formatting. Must come last.
  prettier,
);
