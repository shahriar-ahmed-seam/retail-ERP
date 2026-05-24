// Renderer feature module barrel.
//
// Per the design's Project Structure, feature folders (login, setup,
// pos, products, inventory, purchases, suppliers, customers, users,
// reports, settings, backup) are added across Phases 3–13. Each
// folder owns its own barrel and is re-exported here so the renderer
// entry (and the upcoming role-aware shell in task 13.1) can import
// pages from `@renderer/features` directly.

export * from './customers';
export * from './reports';
export * from './settings';
