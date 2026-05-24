// Barrel for main-process services.
//
// Individual services are added per phase:
//   - auth.service.ts (Phase 3, task 3.1)
//   - category.service.ts (Phase 4, task 4.1)
//   - product.service.ts (Phase 4, task 4.2)
//   - inventory.service.ts (Phase 5, task 5.1)
//   - pos.service.ts (Phase 7, tasks 7.2 + 7.3)
//
// Future additions: customer, permission, report, backup, audit.

export {
  AuthService,
  BCRYPT_COST_FACTOR,
  type CreateInitialAdminResult,
} from './auth.service.js';

export { CategoryService } from './category.service.js';

export { CustomerService } from './customer.service.js';

export {
  applyMovement,
  InventoryService,
  OutOfStockError,
  type ApplyMovementInput,
  type ApplyMovementResult,
  type MovementType,
  type ReferenceType,
} from './inventory.service.js';

export { POSService } from './pos.service.js';

export { ProductService } from './product.service.js';

export { PurchaseService } from './purchase.service.js';

export { ReportService } from './report.service.js';

export {
  describeReport,
  exportCsv,
  exportPdf,
  exportReport,
  pumpRows,
  type BatchConsumer,
  type CsvExportOptions,
  type CsvExportResult,
  type ExportColumn,
  type ExportRow,
  type PdfExportOptions,
  type PdfExportResult,
  type PumpOptions,
  type SalesExportRow,
} from './report/index.js';

export { SupplierService } from './supplier.service.js';
