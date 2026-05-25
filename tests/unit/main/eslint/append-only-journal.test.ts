import tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { appendOnlyRestrictedSyntax } from '../../../../eslint-rules/append-only.mjs';

/**
 * Unit tests for the append-only static guarantee (task 11.5,
 * Req 10.5 + 13.4).
 *
 * The journal (`journal_entries`) and audit (`audit_logs`) tables are
 * append-only by contract — Property 5 in design.md. Task 11.5 backs
 * that contract with a static check: any
 * `prisma.journalEntry.update`, `prisma.journalEntry.delete`,
 * `prisma.auditLog.update`, or `prisma.auditLog.delete` call (and the
 * corresponding `*Many` variants) anywhere under `src/` fails the
 * build. The check is wired as an ESLint `no-restricted-syntax` rule
 * scoped to `src/**` in `eslint.config.mjs` so it runs on every
 * `npm run lint`.
 *
 * The selectors live in `eslint-rules/append-only.mjs` so the build
 * config and these tests share one source of truth.
 *
 * The tests drive the ESLint `Linter` API directly (no
 * `parserOptions.project`, no fixture files) against synthetic
 * snippets. The full project-aware lint run is exercised separately
 * by `npm run lint`; this suite isolates the rule itself so a future
 * tweak to the `tsconfig.*` shape can't mask a regression in the
 * selector definitions.
 *
 * Cases:
 *
 *   1. A snippet that calls `prisma.journalEntry.update(...)`
 *      produces exactly one `no-restricted-syntax` error.
 *   2. The same is true for `prisma.journalEntry.delete`,
 *      `prisma.journalEntry.deleteMany`,
 *      `prisma.journalEntry.updateMany`, `prisma.auditLog.update`,
 *      `prisma.auditLog.delete`, `prisma.auditLog.updateMany`, and
 *      `prisma.auditLog.deleteMany`.
 *   3. The rule fires on `tx.journalEntry.update` (transaction
 *      client) as well — the selector matches any
 *      `<obj>.journalEntry.<mutating>` pattern, not only `prisma.*`.
 *   4. The rule does NOT fire on `prisma.journalEntry.create`,
 *      `prisma.journalEntry.findMany`, `prisma.auditLog.create`,
 *      `prisma.auditLog.findMany`, or unrelated mutations like
 *      `prisma.product.update`.
 *
 * Validates: Requirements 10.5, 13.4.
 */

const linter = new Linter();

/** Lint a snippet against the append-only selectors. */
function lintSnippet(code: string): readonly string[] {
  const messages = linter.verify(code, {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-restricted-syntax': ['error', ...appendOnlyRestrictedSyntax],
    },
  });
  return messages
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
}

describe('eslint append-only guard (task 11.5)', () => {
  it('flags prisma.journalEntry.update', () => {
    const errors = lintSnippet(
      `import { prisma } from '@main/db/prisma.js';\n` +
        `export async function bad() {\n` +
        `  await prisma.journalEntry.update({ where: { id: 'x' }, data: {} });\n` +
        `}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/append-only.*journal_entries/i);
  });

  it.each([
    ['delete', `await prisma.journalEntry.delete({ where: { id: 'x' } });`],
    ['updateMany', `await prisma.journalEntry.updateMany({ data: {} });`],
    ['deleteMany', `await prisma.journalEntry.deleteMany({});`],
  ])('flags prisma.journalEntry.%s', (_label, callExpr) => {
    const errors = lintSnippet(
      `import { prisma } from '@main/db/prisma.js';\n` +
        `export async function bad() {\n` +
        `  ${callExpr}\n` +
        `}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/append-only.*journal_entries/i);
  });

  it.each([
    ['update', `await prisma.auditLog.update({ where: { id: 'x' }, data: {} });`],
    ['delete', `await prisma.auditLog.delete({ where: { id: 'x' } });`],
    ['updateMany', `await prisma.auditLog.updateMany({ data: {} });`],
    ['deleteMany', `await prisma.auditLog.deleteMany({});`],
  ])('flags prisma.auditLog.%s', (_label, callExpr) => {
    const errors = lintSnippet(
      `import { prisma } from '@main/db/prisma.js';\n` +
        `export async function bad() {\n` +
        `  ${callExpr}\n` +
        `}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/append-only.*audit_logs/i);
  });

  it('flags tx.journalEntry.update from a $transaction body', () => {
    const errors = lintSnippet(
      `import { prisma } from '@main/db/prisma.js';\n` +
        `export async function bad() {\n` +
        `  await prisma.$transaction(async (tx) => {\n` +
        `    await tx.journalEntry.update({ where: { id: 'x' }, data: {} });\n` +
        `  });\n` +
        `}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/append-only.*journal_entries/i);
  });

  it('does NOT flag prisma.journalEntry.create or read paths', () => {
    const errors = lintSnippet(
      `import { prisma } from '@main/db/prisma.js';\n` +
        `export async function ok() {\n` +
        `  await prisma.journalEntry.create({ data: { opType: 'sale', payload: '{}' } });\n` +
        `  await prisma.journalEntry.findMany({});\n` +
        `  await prisma.auditLog.create({\n` +
        `    data: { actionType: 'x', entityType: 'p', entityId: 'p', userId: null },\n` +
        `  });\n` +
        `  await prisma.auditLog.findMany({});\n` +
        `  await prisma.product.update({ where: { id: 'p' }, data: {} });\n` +
        `}\n`,
    );
    expect(errors).toEqual([]);
  });
});
