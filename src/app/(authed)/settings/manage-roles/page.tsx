'use client';

/*
 * Manage Roles — Settings page.
 *
 * Lists tbl_role and surfaces user counts per role. Operates on
 * /api/admin/roles (services/role.service.js). Columns:
 *   Role ID | Role Name | Description | Group | Active Users | Status | Actions.
 *
 * Group classification (admin/client/mobile/default) is shown read-only here
 * because it's a code-level mapping (ROLE_ID_TO_GROUP) — flipping a role
 * between groups from a form would be a real-time privilege-escalation
 * surface. Adding a new role through this UI creates the DB row; mapping it
 * to a group requires a code change + deploy. The UI calls out the
 * "unknown" group on new roles so operators know to expect that follow-up.
 *
 * Soft-delete only — and the backend refuses to deactivate a role while any
 * active user is still assigned to it. Operator must reassign first.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Search, Plus, Pencil, Trash2,
  AlertTriangle, ChevronDown, ChevronRight, Info,
  ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type Role = {
  role_id: number;
  role_name: string;
  role_desc: string | null;
  role_status: number;
  user_count: number;
  menu_ids: number[];
  menu_action_count: number;
  group: string; // 'admin' | 'client' | 'mobile' | 'default' | 'unknown'
};

// Shape returned by GET /admin/roles/:id — the full edit projection.
type RoleDetail = Role & {
  menu_action_ids: number[];
};

type MenuRow = {
  menu_id: number;
  menu_name: string;
  parent_menu: number;
  menu_depth: number;
  has_child: number;
  url: string | null;
  sequence: number | null;
};

type MenuActionRow = {
  id: number;
  menu_id: number;
  menu_name: string | null;
  name: string;          // human label, e.g. "Edit User"
  action_name: string;   // permission key, e.g. "isUserEdit"
};

type ListResponse = { items: Role[]; total: number };

// Mirrors SORTABLE_COLUMNS in services/role.service.js.
type SortKey = 'role_id' | 'role_name' | 'role_desc' | 'role_status' | 'user_count';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

const GROUP_PILL: Record<string, string> = {
  admin:   'bg-blue-100 text-blue-700',
  client:  'bg-emerald-100 text-emerald-700',
  mobile:  'bg-amber-100 text-amber-700',
  default: 'bg-slate-100 text-slate-700',
  unknown: 'bg-red-100 text-red-700',
};

export default function ManageRolesPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  // Permission gating mirrors legacy CRM Constants.actionPermissions:
  //   - isRollAddNew : Add Role button visibility.
  //   - isRollEdit   : Edit + Deactivate per-row buttons.
  // Legacy preserved the "Roll" typo in action_name strings; we use it
  // verbatim to match production menu_action rows.
  const can = actionFlags(me, ['isRollAddNew', 'isRollEdit']);

  const [items, setItems] = useState<Role[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Role | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Menu + action catalogue — lifted up from the modal so the list rows
  // can also expand menu_ids → menu_name and render the legacy "Data"
  // expansion (per-menu action permissions). Cached for the session.
  // Both endpoints are admin-only (already enforced by route middleware)
  // and small enough (~80 rows + ~300 rows in prod) to fetch upfront.
  const [allMenus, setAllMenus] = useState<MenuRow[]>([]);
  const [allActions, setAllActions] = useState<MenuActionRow[]>([]);
  useEffect(() => {
    void api.get<MenuRow[]>('/shared/lookup/menus').then(setAllMenus).catch(() => setAllMenus([]));
    void api.get<MenuActionRow[]>('/shared/lookup/menu-actions').then(setAllActions).catch(() => setAllActions([]));
  }, []);

  // id → name maps for fast lookup when rendering expanded rows.
  const menuNameById = useMemo(
    () => new Map(allMenus.map((m) => [m.menu_id, m.menu_name])),
    [allMenus]
  );
  const actionsByMenu = useMemo(() => {
    const map = new Map<number, MenuActionRow[]>();
    for (const a of allActions) {
      if (!map.has(a.menu_id)) map.set(a.menu_id, []);
      map.get(a.menu_id)!.push(a);
    }
    return map;
  }, [allActions]);

  // Per-role expansion state — multiple rows can be open at once. Keyed by
  // role_id. Closed by default; click the chevron to expand.
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(new Set());
  function toggleExpanded(roleId: number) {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
      return next;
    });
  }

  // Per-role action_ids — only fetched on first expand because the list
  // endpoint omits this (action_ids would require an extra join per row).
  // Cached so re-expanding the same row doesn't refetch.
  const [actionsByRole, setActionsByRole] = useState<Map<number, number[]>>(new Map());
  async function ensureActionsLoaded(roleId: number) {
    if (actionsByRole.has(roleId)) return;
    try {
      const full = await api.get<RoleDetail>(`/admin/roles/${roleId}`);
      setActionsByRole((prev) => new Map(prev).set(roleId, full.menu_action_ids ?? []));
    } catch {
      // Leave the entry unset so a future expand will retry. The UI
      // shows "loading…" until the response arrives.
    }
  }

  const [sortBy,  setSortBy]  = useState<SortKey>('role_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
    setPage(0);
  }

  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('roles-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('roles-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setPage(0);
      void fetchList();
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, includeInactive]);

  useEffect(() => { void fetchList(); /* eslint-disable-next-line */ }, [page, sortBy, sortDir]);

  async function fetchList() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (includeInactive) params.set('includeInactive', 'true');
      params.set('limit',  String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      const data = await api.get<ListResponse>(`/admin/roles?${params}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeactivate(r: Role) {
    // Backend refuses deactivation when user_count > 0, but we show a clear
    // pre-flight message so operators don't have to interpret a 409.
    if (r.user_count > 0) {
      await confirm({
        title: 'Cannot deactivate this role',
        description: `${r.user_count} active user${r.user_count === 1 ? ' is' : 's are'} still assigned to "${r.role_name}". Reassign them in Manage Users first, then come back here to deactivate.`,
        confirmLabel: 'OK',
      });
      return;
    }
    const ok = await confirm({
      title: 'Deactivate role?',
      description: `${r.role_name} will be marked inactive and hidden from default lists and the user-creation dropdown. Existing references stay intact. You can reactivate by editing and toggling Active.`,
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/roles/${r.role_id}`);
      void fetchList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Deactivate failed');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="size-6" /> Manage Roles
          </h1>
          <p className="text-sm text-muted-foreground">
            CRM roles and their classification group. Group decides which route mount the role can hit.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isRollAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Role
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <button
            type="button"
            onClick={() => setHowOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            aria-expanded={howOpen}
          >
            {howOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <Info className="size-4 shrink-0 text-blue-600" />
            <span className="font-medium">How Role management works</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-3 border-t">
              <section>
                <h3 className="font-semibold text-foreground mb-1">1. What a role row holds</h3>
                <p>
                  Each role row has a name, a description, and a status flag. The
                  &ldquo;Group&rdquo; column shows which surface this role can access
                  (admin = CRM, client = client dashboard, mobile = technician app).
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">2. Group is read-only</h3>
                <p>
                  Group classification is set in code, not from this form — it gates
                  route mounts at the network layer, so flipping it from a UI would be
                  a privilege-escalation event. Adding a new role here creates the DB
                  row; mapping it to a group requires a code change + deploy.
                  Newly-added roles start in the <em>unknown</em> group and can&apos;t
                  reach any application surface until the mapping ships.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">3. Deactivation requires zero active users</h3>
                <p>
                  A role can only be deactivated when no active CRM user is currently
                  assigned to it. Reassign users in Manage Users first; come back here
                  to deactivate. This avoids ghost-role-on-user-row states.
                </p>
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '4%'  }} /> {/* Expand chevron */}
              <col style={{ width: '6%'  }} /> {/* Role ID */}
              <col style={{ width: '15%' }} /> {/* Name */}
              <col style={{ width: '21%' }} /> {/* Description (was 20% — picked up freed Actions space) */}
              <col style={{ width: '8%'  }} /> {/* Group */}
              <col style={{ width: '22%' }} /> {/* Menu Access (was 20% — picked up freed Actions space) */}
              <col style={{ width: '8%'  }} /> {/* Users */}
              <col style={{ width: '8%'  }} /> {/* Status */}
              {/* Actions reduced from 11% → 8% to match the action-column
                  density on Manage Users and the other settings pages.
                  With only 2 icons (no "view-only" chip), the previous
                  11% left a large empty gap left-of-icons even with
                  justify-end. Freed space went to Description + Menu
                  Access which truncate most often. */}
              <col style={{ width: '8%'  }} /> {/* Actions */}
            </colgroup>
            <thead>
              <tr>
                <th className="!text-center"></th>
                <SortHeader col="role_id"     align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Role ID</SortHeader>
                <SortHeader col="role_name"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Role Name</SortHeader>
                <SortHeader col="role_desc"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Description</SortHeader>
                <th className="!text-center whitespace-nowrap">Group</th>
                {/*
                  * "Menu Access" = expanded menu names from tbl_role.menu_ids.
                  * Mirrors the legacy /usertype list. Click the chevron in
                  * the first column to expand the row and see per-menu action
                  * permissions (legacy "Data" column).
                  */}
                <th className="!text-left whitespace-nowrap" title="Menus this role can reach (tbl_role.menu_ids)">Menu Access</th>
                <SortHeader col="user_count"  align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Users</SortHeader>
                <SortHeader col="role_status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">No roles match the current filters.</td></tr>
              )}
              {!loading && items.map((r) => {
                const expanded = expandedRoles.has(r.role_id);
                return (
                  <React.Fragment key={r.role_id}>
                    <tr>
                      <td className="!text-center">
                        <button
                          type="button"
                          onClick={() => { toggleExpanded(r.role_id); void ensureActionsLoaded(r.role_id); }}
                          className="text-muted-foreground hover:text-foreground"
                          title={expanded ? 'Collapse details' : 'Expand to see per-menu action permissions'}
                          aria-expanded={expanded}
                        >
                          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </td>
                      <td className="!text-center font-mono text-xs truncate">{r.role_id}</td>
                      <td className="!text-left font-medium truncate" title={r.role_name}>{r.role_name}</td>
                      <td className="!text-left truncate text-muted-foreground" title={r.role_desc ?? ''}>
                        {r.role_desc ?? <span>—</span>}
                      </td>
                      <td className="!text-center whitespace-nowrap">
                        <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${GROUP_PILL[r.group] ?? GROUP_PILL.unknown}`}>
                          {r.group}
                        </span>
                      </td>
                      <td className="!text-left truncate">
                        <MenuAccessCell menuIds={r.menu_ids} nameById={menuNameById} />
                      </td>
                      <td className="!text-center font-mono text-xs">{r.user_count}</td>
                      <td className="!text-center whitespace-nowrap">
                        {r.role_status === 1
                          ? <span className="text-emerald-700 text-xs">Active</span>
                          : <span className="text-muted-foreground text-xs">Inactive</span>}
                      </td>
                      <td className="!text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1">
                          {can.isRollEdit && (
                            <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setModalOpen(true); }}>
                              <Pencil className="size-3.5" />
                            </Button>
                          )}
                          {can.isRollEdit && r.role_status === 1 && (
                            <Button size="sm" variant="ghost" onClick={() => handleDeactivate(r)}>
                              <Trash2 className="size-3.5 text-red-600" />
                            </Button>
                          )}
                          {!can.isRollEdit && (
                            <span className="text-[10px] text-muted-foreground">view-only</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {/*
                      * Expandable "Data" row — legacy /usertype list has this as
                      * an expandable detail showing per-menu action permissions.
                      * We render it as a second <tr> spanning all columns so
                      * the column layout stays stable.
                      */}
                    {expanded && (
                      <tr className="bg-slate-50">
                        <td colSpan={9} className="!text-left p-3">
                          <RoleDataDetail
                            role={r}
                            menus={allMenus}
                            actionsByMenu={actionsByMenu}
                            actionIds={actionsByRole.get(r.role_id) ?? null}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      <RoleFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        onSaved={() => { setModalOpen(false); void fetchList(); }}
      />
    </div>
  );
}

// ─── Menu-access cell (legacy "Menu Access" column) ──────────────────
/*
 * Renders the menu names this role can access. Shows the first 3 then
 * "+N more" — keeps the column readable even for power roles like Admin
 * which typically have every menu_id ticked. Hover reveals the full list.
 *
 * Returns "—" when menu_ids is empty (a role with no menu access — would
 * also render a blank sidebar for any user assigned to it).
 */
function MenuAccessCell({ menuIds, nameById }: { menuIds: number[]; nameById: Map<number, string> }) {
  const names = (menuIds ?? [])
    .map((id) => nameById.get(id))
    .filter((n): n is string => !!n);
  if (names.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
  const visible = names.slice(0, 3);
  const overflow = names.length - visible.length;
  return (
    <span title={names.join(', ')} className="text-xs">
      {visible.join(', ')}
      {overflow > 0 && <span className="text-muted-foreground"> +{overflow} more</span>}
    </span>
  );
}

// ─── Role "Data" detail (legacy expandable column) ───────────────────
/*
 * Renders the legacy /usertype expandable "Data" view: for each menu in
 * this role's menu_ids, list the action permissions that are currently
 * ticked. Lifted from the form modal so operators can see at-a-glance
 * what a role grants without clicking Edit.
 *
 *   actionIds = null  → still loading (the list endpoint omits this; we
 *                       fetch it lazily on first expand).
 *   actionIds = []    → role has menus but zero action permissions ticked
 *                       (every Save/Edit button will be hidden for them).
 */
function RoleDataDetail({
  role, menus, actionsByMenu, actionIds,
}: {
  role: Role;
  menus: MenuRow[];
  actionsByMenu: Map<number, MenuActionRow[]>;
  actionIds: number[] | null;
}) {
  // Only show menus this role actually has access to (filter the full
  // tbl_menu catalogue by the role's menu_ids).
  const allowedMenus = useMemo(() => {
    const allowed = new Set(role.menu_ids ?? []);
    return menus.filter((m) => allowed.has(m.menu_id));
  }, [menus, role.menu_ids]);

  if (actionIds === null) {
    return <div className="text-xs text-muted-foreground italic">Loading action permissions…</div>;
  }

  const grantedActions = new Set(actionIds);

  if (allowedMenus.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        This role has no menus granted. Users assigned to it will see an empty sidebar.
      </div>
    );
  }

  return (
    <div className="text-xs space-y-1.5">
      <div className="font-semibold text-foreground">Per-menu action permissions:</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
        {allowedMenus.map((m) => {
          const actions = actionsByMenu.get(m.menu_id) ?? [];
          const grantedHere = actions.filter((a) => grantedActions.has(a.id));
          return (
            <div key={m.menu_id} className="flex gap-2">
              <span className="font-medium min-w-[120px]">{m.menu_name}:</span>
              <span className="flex-1">
                {actions.length === 0 ? (
                  <span className="text-muted-foreground italic">no granular actions</span>
                ) : grantedHere.length === 0 ? (
                  <span className="text-muted-foreground italic">none granted</span>
                ) : (
                  grantedHere.map((a) => (
                    <span key={a.id} className="inline-block bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 mr-1 mb-0.5">
                      {a.name} <span className="font-mono text-[10px] opacity-70">({a.action_name})</span>
                    </span>
                  ))
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sortable column header ─────────────────────────────────────────
function SortHeader({
  col, align, sortBy, sortDir, onSort, children,
}: {
  col: SortKey;
  align: 'left' | 'center' | 'right';
  sortBy: SortKey;
  sortDir: SortDir;
  onSort: (col: SortKey) => void;
  children: React.ReactNode;
}) {
  const isActive = sortBy === col;
  const alignCls = align === 'left' ? '!text-left'
                 : align === 'right' ? '!text-right'
                 : '!text-center';
  const justify  = align === 'left' ? 'justify-start'
                 : align === 'right' ? 'justify-end'
                 : 'justify-center';
  const Icon = !isActive ? ArrowUpDown
             : sortDir === 'asc' ? ArrowUp
             : ArrowDown;
  return (
    <th
      className={`${alignCls} cursor-pointer select-none hover:bg-muted/40 transition-colors whitespace-nowrap overflow-hidden`}
      onClick={() => onSort(col)}
      role="button"
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${justify}`}>
        {children}
        <Icon className={`size-3 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground/40'}`} />
      </span>
    </th>
  );
}

// ─── Add/Edit modal ─────────────────────────────────────────────────
/*
 * Three sections — match the legacy CRM addEditUserType.vm:
 *
 *   1. Identity        : role_name + description + (edit-only) active flag.
 *   2. Menu Access     : checkbox tree from tbl_menu. Checked menus end up
 *                        in the CSV `tbl_role.menu_ids`. Each menu visible
 *                        in the sidebar must be ticked here for users in
 *                        this role to reach it.
 *   3. Action Perms    : per-menu list of menu_action rows. Each row carries
 *                        a human label ("Edit User") + a permission key
 *                        ("isUserEdit"). Checked rows get an active row in
 *                        role_menu_action (legacy soft-delete upsert).
 *
 * On open, the modal fetches the menu catalogue + the menu-action catalogue
 * once. On edit, it additionally fetches GET /admin/roles/:id to pull
 * menu_action_ids (the list endpoint doesn't include them — they need a
 * second query and we don't want to N+1 the list).
 */
function RoleFormModal({
  open, onClose, editing, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: Role | null;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name,   setName]   = useState('');
  const [desc,   setDesc]   = useState('');
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);

  // Catalogue data — fetched once on first open, cached on the component.
  const [menus, setMenus] = useState<MenuRow[]>([]);
  const [allActions, setAllActions] = useState<MenuActionRow[]>([]);

  // Selection state — Sets keep add/remove O(1) and avoid the duplicate-id
  // bugs you'd hit with arrays. Persisted as arrays on save.
  const [selectedMenus, setSelectedMenus] = useState<Set<number>>(new Set());
  const [selectedActions, setSelectedActions] = useState<Set<number>>(new Set());

  // Fetch catalogues on first open. They rarely change within a session;
  // we don't refetch on subsequent opens.
  useEffect(() => {
    if (!open) return;
    if (menus.length === 0) {
      void api.get<MenuRow[]>('/shared/lookup/menus').then(setMenus).catch(() => setMenus([]));
    }
    if (allActions.length === 0) {
      void api.get<MenuActionRow[]>('/shared/lookup/menu-actions').then(setAllActions).catch(() => setAllActions([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Hydrate form state from `editing`. For edit, we also pull the full
  // detail row to get menu_action_ids (not in the list response).
  useEffect(() => {
    if (!open) return;
    setName(editing?.role_name ?? '');
    setDesc(editing?.role_desc ?? '');
    setActive(editing ? editing.role_status === 1 : true);
    setError(null);
    setSelectedMenus(new Set(editing?.menu_ids ?? []));
    setSelectedActions(new Set());
    if (editing) {
      setHydrating(true);
      api.get<RoleDetail>(`/admin/roles/${editing.role_id}`)
        .then((full) => {
          setSelectedMenus(new Set(full.menu_ids ?? []));
          setSelectedActions(new Set(full.menu_action_ids ?? []));
        })
        .catch(() => { /* keep the list-derived menu_ids; just no actions */ })
        .finally(() => setHydrating(false));
    }
  }, [open, editing]);

  // Build a parent → children index. `parent_menu === 0` rows are roots;
  // every other row points at its parent's menu_id. Sorted by sequence so
  // the editor matches sidebar order.
  const tree = useMemo<{ roots: MenuRow[]; childrenByParent: Map<number, MenuRow[]> }>(() => {
    const sorted = [...menus].sort((a, b) =>
      (a.sequence ?? 999) - (b.sequence ?? 999) || a.menu_name.localeCompare(b.menu_name)
    );
    const roots = sorted.filter((m) => !m.parent_menu);
    const childrenByParent = new Map<number, MenuRow[]>();
    for (const m of sorted) {
      if (!m.parent_menu) continue;
      if (!childrenByParent.has(m.parent_menu)) childrenByParent.set(m.parent_menu, []);
      childrenByParent.get(m.parent_menu)!.push(m);
    }
    return { roots, childrenByParent };
  }, [menus]);

  // Index actions by menu_id for fast lookup when rendering each menu row.
  const actionsByMenu = useMemo(() => {
    const map = new Map<number, MenuActionRow[]>();
    for (const a of allActions) {
      if (!map.has(a.menu_id)) map.set(a.menu_id, []);
      map.get(a.menu_id)!.push(a);
    }
    return map;
  }, [allActions]);

  function toggleMenu(menuId: number) {
    setSelectedMenus((prev) => {
      const next = new Set(prev);
      if (next.has(menuId)) next.delete(menuId);
      else next.add(menuId);
      return next;
    });
  }

  function toggleAction(actionId: number) {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });
  }

  // "Select all children of this parent" — convenience for the operator.
  // Affects both the parent itself and every visible child.
  function toggleParent(parent: MenuRow) {
    const children = tree.childrenByParent.get(parent.menu_id) ?? [];
    const all = [parent, ...children];
    const allSelected = all.every((m) => selectedMenus.has(m.menu_id));
    setSelectedMenus((prev) => {
      const next = new Set(prev);
      for (const m of all) {
        if (allSelected) next.delete(m.menu_id); else next.add(m.menu_id);
      }
      return next;
    });
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Role name is required'); return; }
    if (name.trim().length < 2) { setError('Role name is too short'); return; }

    // Auto-include parent menu_ids of any selected child. Without this
    // step, an operator checking "Manage Jobs" (child) without also
    // explicitly checking "Jobs" (parent) saves only the child id —
    // and the sidebar's parent-required visibility rule then drops
    // the whole branch, so the role ends up seeing only Home. The
    // sidebar now also tolerates orphan children (Sidebar.tsx),
    // but writing the canonical {parent, child} pair into menu_ids
    // means the legacy DB shape stays clean and any other consumer
    // of tbl_role.menu_ids (legacy CRM still reads it during the
    // coexistence window) sees a complete tree.
    const menusByIdLocal = new Map(menus.map((m) => [m.menu_id, m]));
    const expandedMenuIds = new Set(selectedMenus);
    for (const id of selectedMenus) {
      let cur = menusByIdLocal.get(id);
      // Walk up the parent chain. tbl_menu only has one level today
      // (parent_menu = 0 for roots, non-zero pointing at the root)
      // but we loop defensively in case the schema grows a 3rd level.
      while (cur && cur.parent_menu && cur.parent_menu !== 0) {
        if (expandedMenuIds.has(cur.parent_menu)) break;
        expandedMenuIds.add(cur.parent_menu);
        cur = menusByIdLocal.get(cur.parent_menu);
      }
    }

    // Drop selected actions whose menu is not also selected — saving them
    // would result in dead permissions (button visible at action level but
    // its menu hidden from sidebar). Match the legacy form which simply
    // hides actions for unselected menus.
    const effectiveActions = Array.from(selectedActions).filter((aid) => {
      const a = allActions.find((row) => row.id === aid);
      return a && expandedMenuIds.has(a.menu_id);
    });

    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/roles/${editing!.role_id}`, {
          role_name:       name.trim(),
          role_desc:       desc.trim() || null,
          is_active:       active,
          // Send the parent-expanded set, not the raw selection — see
          // expandedMenuIds construction above.
          menu_ids:        Array.from(expandedMenuIds),
          menu_action_ids: effectiveActions,
        });
      } else {
        await api.post('/admin/roles', {
          role_name:       name.trim(),
          role_desc:       desc.trim() || null,
          menu_ids:        Array.from(expandedMenuIds),
          menu_action_ids: effectiveActions,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-[900px] w-[95vw]">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.role_name}"` : 'Add Role'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          {/* Identity */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium block mb-1">Role Name *</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. "Quality Auditor"'
              />
            </div>

            <div>
              <label className="text-sm font-medium block mb-1">Description</label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="What this role is allowed to do"
                className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[60px]"
                maxLength={500}
              />
            </div>

            {isEdit && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                <span>Active</span>
              </label>
            )}
          </section>

          {!isEdit && (
            <div className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded p-2 flex items-start gap-2">
              <Info className="size-3.5 shrink-0 mt-0.5" />
              <span>
                Newly-added roles start in the <strong>unknown</strong> group and can&apos;t
                reach any application surface until an engineer maps the role to a group
                (admin / client / mobile) in code. The menu + action selections below
                still get saved — they activate once the group mapping ships.
              </span>
            </div>
          )}

          {/* Menu Access + per-menu Action Permissions, in one combined tree.
              Putting actions inline under each menu (rather than as a
              separate section) is how legacy addEditUserType.vm renders it
              once a menu is picked — keeps the cognitive load low: "pick
              the menus this role can see, and for each one, pick the
              buttons they can use within it." */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Menu &amp; Action Access</h3>
              <span className="text-xs text-muted-foreground">
                {selectedMenus.size} menu{selectedMenus.size === 1 ? '' : 's'} · {selectedActions.size} action{selectedActions.size === 1 ? '' : 's'}
                {hydrating && ' · loading…'}
              </span>
            </div>
            <div className="border rounded divide-y">
              {tree.roots.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {menus.length === 0 ? 'Loading menus…' : 'No top-level menus found.'}
                </div>
              )}
              {tree.roots.map((parent) => {
                const children = tree.childrenByParent.get(parent.menu_id) ?? [];
                const parentChecked = selectedMenus.has(parent.menu_id);
                const allKidsChecked = children.length > 0 && children.every((c) => selectedMenus.has(c.menu_id));
                const someKidsChecked = children.some((c) => selectedMenus.has(c.menu_id));
                const hybridState = parentChecked && allKidsChecked;
                return (
                  <div key={parent.menu_id} className="bg-background">
                    <div className="px-3 py-2 flex items-center gap-2 bg-slate-50">
                      <input
                        type="checkbox"
                        checked={hybridState}
                        // Indeterminate when some but not all children are selected.
                        ref={(el) => { if (el) el.indeterminate = !hybridState && (parentChecked || someKidsChecked); }}
                        onChange={() => toggleParent(parent)}
                      />
                      <span className="font-medium text-sm flex-1">{parent.menu_name}</span>
                      <button
                        type="button"
                        className="text-xs text-blue-600 hover:underline"
                        onClick={() => toggleMenu(parent.menu_id)}
                      >
                        {parentChecked ? 'Hide parent' : 'Show parent only'}
                      </button>
                    </div>
                    {/* Per-parent actions (rare — most actions are on leaves) */}
                    <MenuActionRows
                      actions={actionsByMenu.get(parent.menu_id) ?? []}
                      enabled={parentChecked}
                      selected={selectedActions}
                      onToggle={toggleAction}
                    />
                    {children.map((child) => {
                      const childChecked = selectedMenus.has(child.menu_id);
                      return (
                        <div key={child.menu_id} className="border-t border-slate-100">
                          <div className="px-3 py-1.5 pl-8 flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={childChecked}
                              onChange={() => toggleMenu(child.menu_id)}
                            />
                            <span className="flex-1">{child.menu_name}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">#{child.menu_id}</span>
                          </div>
                          <MenuActionRows
                            actions={actionsByMenu.get(child.menu_id) ?? []}
                            enabled={childChecked}
                            selected={selectedActions}
                            onToggle={toggleAction}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </section>

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-background pb-1">
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Role'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Per-menu action rows ────────────────────────────────────────────
/*
 * Renders the menu_action checkboxes for one menu. Greyed-out + disabled
 * when the parent menu is not selected (selecting an action without its
 * menu makes no sense — the user can't reach the page). The visual
 * affordance is what makes this clear; the save handler also strips
 * orphaned actions defensively.
 */
function MenuActionRows({
  actions, enabled, selected, onToggle,
}: {
  actions: MenuActionRow[];
  enabled: boolean;
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className={`px-3 pl-12 py-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs ${enabled ? '' : 'opacity-50'}`}>
      {actions.map((a) => (
        <label key={a.id} className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            disabled={!enabled}
            checked={selected.has(a.id)}
            onChange={() => onToggle(a.id)}
          />
          <span>{a.name}</span>
          <span className="text-[10px] font-mono text-muted-foreground">({a.action_name})</span>
        </label>
      ))}
    </div>
  );
}
