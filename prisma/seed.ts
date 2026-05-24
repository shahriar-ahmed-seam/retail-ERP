// prisma/seed.ts
//
// Database seed for Core Retail ERP V1 (Phase 1, task 1.4).
//
// Idempotent: every row is written via `upsert`, so this script is safe to
// re-run during development, in CI, and as part of the bundled `shop.db`
// template build (Phase 1, task 1.5).
//
// What gets seeded:
//   1. Roles `Admin` and `Cashier` — required by Req 1.6 (initial Admin
//      setup needs the `Admin` role to exist) and Req 8.1 (Permission_System
//      defines at minimum these two roles).
//   2. Settings rows that the rest of the application reads on startup or
//      mid-transaction. Values are stored as strings in the `Setting.value`
//      column and follow the conventions noted in design.md and
//      schema.prisma:
//        - `sale.serialCounter`   -> integer string ("0"), incremented inside
//                                    the POS finalize transaction (Req 4.3).
//        - `backup.retentionDays` -> integer string ("14"), how many daily
//                                    snapshots to keep (Req 10.3).
//        - `printer.escpos`       -> JSON string `{"kind":"usb","target":""}`,
//                                    consumed by the ESC/POS adapter
//                                    (design.md "Receipt Printing Pipeline").
//        - `backup.lastSnapshot`  -> empty string, ISO timestamp of most
//                                    recent successful snapshot once the
//                                    Backup_System runs (Req 10.1).
//
// The seed is deliberately self-contained — it does not import from
// `src/main/db/prisma.ts` because that wrapper applies WAL/FK PRAGMAs that
// only matter at runtime; the Prisma CLI is the consumer here and a plain
// `PrismaClient` is sufficient.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Setting rows seeded on every run. Listed as a const array (rather than
 * inline calls) so the set of seeded keys is reviewable at a glance and
 * stays trivially in sync with the comment block above.
 */
const SETTINGS: readonly { key: string; value: string }[] = [
  { key: 'sale.serialCounter', value: '0' },
  { key: 'backup.retentionDays', value: '14' },
  { key: 'printer.escpos', value: JSON.stringify({ kind: 'usb', target: '' }) },
  { key: 'backup.lastSnapshot', value: '' },
];

/**
 * Role names seeded on every run. Stored as a tuple of literal names so the
 * type system can flag a typo before a migration ever sees it.
 */
const ROLE_NAMES = ['Admin', 'Cashier'] as const;

async function main(): Promise<void> {
  // Roles. `name` is `@unique` in the schema so it works as the upsert key.
  // The `update: {}` arm is intentionally empty: re-running the seed must
  // not perturb existing role rows (e.g. their `id`s, which other tables
  // reference via foreign keys).
  for (const name of ROLE_NAMES) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // Settings. `key` is the primary key on the `Setting` model. We DO update
  // `value` on conflict so a developer running the seed after editing the
  // `SETTINGS` array gets the new defaults — but only for the keys this
  // script owns. Counter-style keys (e.g. `sale.serialCounter`) get reset
  // back to `"0"` by this update, which is the correct behaviour for the
  // bundled-template build step (Phase 1, task 1.5) and for fresh dev
  // databases. Production installations seed exactly once on first launch
  // and are not subject to repeated seeds.
  for (const setting of SETTINGS) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: { value: setting.value },
      create: { key: setting.key, value: setting.value },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    // Surface the failure with a non-zero exit code so `prisma db seed`
    // (and any CI pipeline calling it) treats the seed as failed.
    console.error('[prisma/seed.ts] seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
