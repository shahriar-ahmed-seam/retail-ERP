/**
 * Permission layer barrel.
 *
 * Re-exports the static RBAC matrix and the `Permission` helper consumed
 * by the IPC router middleware (task 2.4). The matrix itself lives in
 * `matrix.ts`.
 */
export { Permission, RBAC } from './matrix.js';
