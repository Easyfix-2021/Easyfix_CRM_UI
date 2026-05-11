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
