// Barrel for main-process services.
//
// Individual services are added per phase:
//   - auth.service.ts (Phase 3, task 3.1)
//
// Future additions: product, inventory, pos, purchase, supplier, customer,
// permission, report, backup, audit.

export {
  AuthService,
  BCRYPT_COST_FACTOR,
  type CreateInitialAdminResult,
} from './auth.service.js';
