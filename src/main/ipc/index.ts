// Barrel for the main-process IPC layer.
//
// Re-exports the router primitives (Phase 2, task 2.4). Handler-group
// modules under `./handlers/` will be added as each domain comes online
// (auth in Phase 3, products in Phase 4, POS in Phase 7, etc.) and will
// register themselves via `registerHandler` on import.

export {
  bindIpcHandlers,
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  prismaAuditWriter,
  registerHandler,
  resetAuditWriter,
  setAuditWriter,
  type AuditDescriptor,
  type AuditWriteInput,
  type AuditWriter,
  type HandlerContext,
  type HandlerFn,
  type HandlerOptions,
} from './router.js';
