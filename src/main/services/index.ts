// Barrel for main-process services.
//
// Individual services are added per phase:
//   - auth.service.ts (Phase 3, task 3.1)
//   - category.service.ts (Phase 4, task 4.1)
//   - product.service.ts (Phase 4, task 4.2)
//   - inventory.service.ts (Phase 5, task 5.1)
//
// Future additions: pos, purchase, supplier, customer,
// permission, report, backup, audit.

export {
  AuthService,
  BCRYPT_COST_FACTOR,
  type CreateInitialAdminResult,
} from './auth.service.js';

export { CategoryService } from './category.service.js';

export {
  applyMovement,
  InventoryService,
  OutOfStockError,
  type ApplyMovementInput,
  type ApplyMovementResult,
  type MovementType,
  type ReferenceType,
} from './inventory.service.js';

export { ProductService } from './product.service.js';
