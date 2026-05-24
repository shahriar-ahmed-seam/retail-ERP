// src/main/printing/index.ts
//
// Barrel for the printing subsystem.
//
// Public surface (Phase 8):
//
//   - `buildReceiptDTO`, `loadShopInfoFromSettings`,
//     `SHOP_INFO_SETTING_KEYS` (task 8.1) — the pure receipt
//     renderer.
//   - `escposAdapter`, `htmlAdapter`, `pdfAdapter` (tasks 8.2 / 8.3
//     / 8.4) — the three concrete adapters.
//   - `selectPrinter`, `printReceipt`, `runChain`, `postCommitPrint`,
//     `runPostCommitPrint` (task 8.5) — the chain entry points.
//   - `PrinterAdapter`, `PrintResult`, `PrinterAdapterName`,
//     `PrinterFailureReason` — the shared types every adapter
//     implements.
//
// Importers (`pos.service`, the printer settings page in Phase 8.6,
// and the unit/integration tests) reach into this barrel rather
// than the per-file modules. Keeps a single seam if a future task
// re-locates an adapter module.

export {
  buildReceiptDTO,
  loadShopInfoFromSettings,
  SHOP_INFO_SETTING_KEYS,
  type PrismaLike as ReceiptRendererPrismaLike,
} from './receipt-renderer.js';

export { escposAdapter } from './escpos-adapter.js';
export { htmlAdapter } from './html-adapter.js';
export { pdfAdapter } from './pdf-adapter.js';

export {
  postCommitPrint,
  printReceipt,
  runChain,
  runPostCommitPrint,
  selectPrinter,
  type ChainAdapter,
  type PostCommitPrintOptions,
} from './printer.js';

export type {
  PrinterAdapter,
  PrinterAdapterName,
  PrinterFailureReason,
  PrintResult,
} from './types.js';
