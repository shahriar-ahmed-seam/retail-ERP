/**
 * Login feature barrel (task 3.3).
 *
 * Re-exports the login screen so the renderer entry can import it from
 * `@renderer/features/login` without referencing the file directly. Future
 * additions (e.g. a "forgot password" path, role-aware redirect helpers)
 * attach here.
 */

export { LoginPage } from './LoginPage.js';
