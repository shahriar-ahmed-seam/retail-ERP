// @ts-check

/**
 * Selectors for the append-only static guarantee (task 11.5,
 * Req 10.5 + 13.4).
 *
 * `journal_entries` and `audit_logs` are append-only by contract. No
 * service method anywhere in `src/` may call `update`, `delete`,
 * `updateMany`, or `deleteMany` against the corresponding Prisma
 * delegates (`journalEntry`, `auditLog`). The build fails if any
 * such reference appears.
 *
 * Each selector matches a `MemberExpression` whose immediate object
 * property is the offending Prisma delegate (`journalEntry` or
 * `auditLog`) and whose own property is one of the four mutating
 * methods. The middle hop (the receiver — `prisma`, `tx`, an alias)
 * is left unconstrained so both `prisma.journalEntry.update(...)` and
 * `tx.journalEntry.update(...)` (transaction client) trip the rule.
 *
 * The selectors are exported from this dedicated file so:
 *   1. `eslint.config.mjs` imports them as the source of truth for
 *      the `no-restricted-syntax` rule scoped to `src/**`.
 *   2. The unit test under
 *      `tests/unit/main/eslint/append-only-journal.test.ts` imports
 *      the same selectors and exercises them directly via the ESLint
 *      `Linter` API against synthetic snippets, so the test and the
 *      build use one rule definition.
 *
 * Validates: Requirements 10.5, 13.4.
 */
export const appendOnlyRestrictedSyntax = Object.freeze([
  Object.freeze({
    selector:
      "MemberExpression[object.type='MemberExpression'][object.property.name='journalEntry'][property.name=/^(update|delete|updateMany|deleteMany)$/]",
    message:
      "Append-only invariant: `journal_entries` may not be mutated via Prisma `update`/`delete`/`updateMany`/`deleteMany` from src/ (Req 10.5).",
  }),
  Object.freeze({
    selector:
      "MemberExpression[object.type='MemberExpression'][object.property.name='auditLog'][property.name=/^(update|delete|updateMany|deleteMany)$/]",
    message:
      "Append-only invariant: `audit_logs` may not be mutated via Prisma `update`/`delete`/`updateMany`/`deleteMany` from src/ (Req 13.4).",
  }),
]);
