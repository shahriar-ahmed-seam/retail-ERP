// Barrel for the main-process database layer.
//
// Re-exports the configured Prisma client (Phase 1, task 1.3) so callers can
// `import { prisma, connect, disconnect, runWeeklyMaintenance } from '@main/db'`
// without depending on the internal file layout. Future additions (e.g. the
// `paginateCursor` helper from task 2.5.1) will be re-exported here too.

export {
  PRAGMA_STATEMENTS,
  connect,
  disconnect,
  prisma,
  runWeeklyMaintenance,
} from './prisma.js';

export {
  paginateCursor,
  type PaginateCountArgs,
  type PaginateFindManyArgs,
  type PaginateModel,
  type PaginateOptions,
  type PaginateOrderBy,
  type PaginateWhere,
} from './paginate.js';
