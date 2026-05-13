/*
 * Permission helpers — thin wrappers over `me.permissions`.
 *
 * The data model mirrors the legacy CRM session map (LoginAction.java
 * lines 92–98): a flat list of `actionPermissions` keys (e.g. `isUserEdit`,
 * `isAddNew`) checked at button-render time, plus a `menuIds` allowlist
 * that gates the sidebar.
 *
 * Both are RESOLVED SERVER-SIDE by /api/auth/me from
 * `tbl_role.menu_ids` + `role_menu_action` JOIN `menu_action`. The frontend
 * never derives them from role_name or role_id — that would re-introduce
 * the hardcoded role-name allowlist this refactor was meant to remove.
 *
 * Fail-closed: if `me` or `me.permissions` is missing (auth still loading,
 * or backend doesn't yet send the field), every check returns FALSE. This
 * matches the legacy default-deny posture — buttons stay hidden until we
 * KNOW the user has the action.
 */

import type { Me } from './auth-context';

/*
 * Why no Admin bypass here:
 *   An earlier iteration short-circuited every check to TRUE for
 *   role_name === 'Admin'. That violated the workflow rule
 *   ("page name must appear in Manage Role so access can be granted"):
 *   it masked the real bug, which was that several new action keys
 *   (isJobConfirm / isJobAssign / isJobReassign / isJobStatusChange /
 *   isJobCancel / isClientQuestionaire) had never been seeded into
 *   `menu_action`. Without rows in that table, NO role — including
 *   Admin — could have them in `role_menu_action`, so the Admin's
 *   `permissions.actionPermissions` array couldn't contain them.
 *
 *   The correct fix is the data fix: migration
 *   `2026-05-13-seed-new-action-permissions.sql` inserts the missing
 *   `menu_action` rows and grants them to Admin via the legacy upsert
 *   pattern. Once that runs, Admin holds these permissions through the
 *   same code path every other role uses — no special casing needed.
 *
 *   If a future action key fires this same "Admin can't see X" issue,
 *   add it to that migration (or write a new one) rather than adding a
 *   bypass here.
 */

export function hasAction(me: Me | null | undefined, action: string): boolean {
  if (!me?.permissions?.actionPermissions) return false;
  return me.permissions.actionPermissions.includes(action);
}

export function canSeeMenu(me: Me | null | undefined, menuId: number): boolean {
  if (!me?.permissions?.menuIds) return false;
  return me.permissions.menuIds.includes(menuId);
}

/*
 * Bulk-check helper for components that need to gate multiple actions in
 * one render pass. Returns a `Record<actionKey, boolean>` so JSX can read
 * `flags.isUserEdit` without N indexOf scans.
 */
export function actionFlags(me: Me | null | undefined, actions: readonly string[]): Record<string, boolean> {
  const set = new Set(me?.permissions?.actionPermissions ?? []);
  return Object.fromEntries(actions.map((a) => [a, set.has(a)]));
}
