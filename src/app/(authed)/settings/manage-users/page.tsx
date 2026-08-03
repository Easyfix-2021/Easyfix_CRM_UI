'use client';

/*
 * Manage Users — Settings page.
 *
 * Lists internal CRM staff (tbl_user where user_type_id = 5). Operates on
 * /api/admin/users (services/user.service.js). Columns:
 *   User ID | Name | Email | Mobile | Role | City | Status | Actions.
 *
 * Soft-delete only — tbl_user rows are referenced by tbl_job audit columns
 * and historical assignments. Deactivation flips user_status to 0; the row
 * stays. Reactivation toggles it back via the edit modal.
 *
 * Auth model note (carried over from legacy CRM): tbl_user has no password
 * column. Login is OTP-only (email or mobile). This form therefore has no
 * password field — the create form is just identity + role + city.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invalidateFetch, useDebouncedValue } from '@/lib/hooks';
import {
  UserCog, Users, Search, Plus, Pencil, Trash2,
  AlertTriangle, ChevronDown, ChevronRight, Info, Layers,
} from 'lucide-react';
import { BulkUpdateUsersDialog } from '@/components/users/BulkUpdateUsersDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { CitySelect } from '@/components/ui/city-select';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { SortHeader, cycleSort } from '@/lib/use-sort';
import { Switch } from '@/components/ui/switch';
import { useCancelConfirm } from '@/lib/use-cancel-confirm';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { STAGE_OPTIONS, STAGES } from '@/lib/job-stages';

type User = {
  user_id: number;
  user_code: string | null;
  user_name: string;
  official_email: string;
  mobile_no: string;
  alternate_no: string | null;
  user_role: number | null;
  role_name: string | null;
  city_id: number | null;
  city_name: string | null;
  manage_clients: string | null;
  manage_cities: string | null;
  manage_states: string | null;
  manage_verticals: string | null;
  reporting_manager: number | null;
  user_status: number;
  insert_date: string | null;
  update_date: string | null;
  /*
   * Job Stage Access — the user's allowed lifecycle stages (STAGE_KEYS from
   * lib/job-stages.ts). Returned by BOTH the list endpoint (batched, one query
   * per page) and the GET user detail endpoint. NULL / absent = unrestricted
   * (all stages); [] = explicit no access; non-empty = restricted to those keys.
   */
  allowed_stages?: string[] | null;
};

type ListResponse = { items: User[]; total: number };

// Must mirror SORTABLE_COLUMNS in services/user.service.js.
/*
 * POST /admin/users response — the new user PLUS the Microsoft 365 mailbox
 * outcome. The two are independent: `accountStatus:'created'` with
 * `licenceStatus:'no_seats_available'` is an Entra account with NO mailbox, so
 * `mailboxReady` (not accountStatus) is the field that answers "can this person
 * receive email?". All fields optional — an older backend, or the feature
 * switched off, simply omits them.
 */
type CreatedUser = {
  user_id?: number;
  provisioning?: {
    attempted?: boolean;
    /** Finished BOTH steps — the only value that means a usable mailbox. */
    mailboxReady?: boolean;
    /** Outran the inline deadline and is completing in the background. */
    pending?: boolean;
    /** Operator-facing explanation, e.g. the "no free seats (67/67 used)" text. */
    reason?: string;
    accountStatus?: string;
    licenceStatus?: string;
  };
};

type SortKey =
  | 'user_id' | 'user_name' | 'official_email' | 'mobile_no'
  | 'role_name' | 'city_name' | 'user_status' | 'insert_date';
type SortDir = 'asc' | 'desc';

// PAGE_SIZE is now operator-controlled via the TablePagination footer
// dropdown. Default 10 matches the new spec.

export default function ManageUsersPage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  // `refresh` re-reads /auth/me — used after a SELF-edit so a permission the
  // operator just granted themselves applies immediately (see onSaved below).
  const { me, refresh: refreshMe } = useMe();
  // Permission gating mirrors legacy CRM Constants.actionPermissions:
  //   - isUserEdit  : controls the Edit + Deactivate buttons on each row.
  //                   Legacy doesn't have a separate "isUserAddNew" — the
  //                   Add User button is open to any admin-role user, and
  //                   we keep that behaviour. If ops wants finer control,
  //                   add a new menu_action row with action_name=isUserAddNew
  //                   and re-gate the Add button here.
  const can = actionFlags(me, ['isUserEdit']);

  // ID → Name map for expanding manage_states CSV in the list. Built from
  // the lookup cache (already loaded by useLookup). The list shows
  // "Manage Regions" as a comma-joined list of region (state) names.
  // (Manage Clients is form-only in legacy; not shown in the list, so no
  // clientNameById map is needed.)
  const stateNameById = useMemo(
    () => new Map(lookup.states.map((s) => [s.state_id, s.state_name])),
    [lookup.states]
  );

  const [items, setItems] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [roleFilter, setRoleFilter] = useState<number | ''>('');
  const [cityFilter, setCityFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<User | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  /*
   * sortBy is nullable so the 3rd click on a column can clear sort
   * entirely (canonical cycle from `cycleSort` in `lib/use-sort`).
   * When null, fetchList omits the sortBy/sortDir params so the BE
   * falls back to its default order.
   */
  const [sortBy,  setSortBy]  = useState<SortKey | null>('user_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
  }

  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('users-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('users-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  /*
   * Unified list-fetch effect — replaces the previous pair of effects
   * (one debounced for filter changes + one immediate for pagination)
   * that double-fired the request on mount. Now a single effect builds
   * the query string from all dependencies; `lastQueryRef` skips a
   * duplicate fire within 100ms (the Strict-Mode double-mount window
   * in dev) so two effects with the same effective key emit one HTTP
   * request, not two.
   *
   * Mutations (post-save / post-bulk-apply / post-toggle) call
   * `fetchList()` directly — that's the explicit refresh path. It
   * also invalidates the module-level fetch cache so any in-flight
   * dedupe doesn't return stale data.
   */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef<{ key: string; at: number } | null>(null);
  const inflightAbortRef = useRef<AbortController | null>(null);

  function buildQuery(): string {
    const params = new URLSearchParams();
    if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
    if (roleFilter)    params.set('roleId', String(roleFilter));
    if (cityFilter)    params.set('cityId', String(cityFilter));
    if (includeInactive) params.set('includeInactive', 'true');
    const limit = pageSizeToLimit(pageSize);
    params.set('limit',  String(limit));
    params.set('offset', String(page * limit));
    if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }
    return params.toString();
  }

  async function fetchList() {
    // Cancel any in-flight request before starting a new one — kills
    // races where a slow earlier fetch lands after a faster later one.
    inflightAbortRef.current?.abort();
    const ac = new AbortController();
    inflightAbortRef.current = ac;

    setLoading(true);
    setError(null);
    try {
      const qs = buildQuery();
      const data = await api.get<ListResponse>(`/admin/users?${qs}`);
      if (ac.signal.aborted) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof ApiError ? e.message : 'Failed to load users');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }

  // Single source of truth for list refresh. The search input is
  // debounced 300ms via useDebouncedValue upstream of this effect;
  // pagination/sort/select-filter changes fire immediately. The
  // 100ms dedupe window catches React Strict Mode's double-mount in
  // dev — without it, every page load triggers `users?…` twice.
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const fire = () => {
      const key = buildQuery();
      const now = Date.now();
      const last = lastQueryRef.current;
      if (last && last.key === key && now - last.at < 100) return;
      lastQueryRef.current = { key, at: now };
      void fetchList();
    };
    // setTimeout(0) batches same-tick dep changes into one fire.
    searchTimerRef.current = setTimeout(fire, 0);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, roleFilter, cityFilter, includeInactive, page, pageSize, sortBy, sortDir]);

  async function handleDeactivate(u: User) {
    const ok = await confirm({
      title: 'Deactivate user?',
      description:
        `${u.user_name} will be marked inactive and won't be able to log in. Their historical records (job ownership, assignments, audit trail) stay intact. You can reactivate by editing and toggling Active.`,
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/users/${u.user_id}`);
      // Drop the module fetch cache for /admin/users keys so subsequent
      // useFetch consumers (or this page's next refetch) don't see the
      // stale row. See lib/hooks.ts module-level cache.
      invalidateFetch((k) => k.startsWith('/admin/users'));
      void fetchList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Deactivate failed');
    }
  }

  // totalPages now computed inside <TablePagination>; no local mirror needed.

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserCog className="size-6" /> Manage Users
          </h1>
          <p className="text-sm text-muted-foreground">
            Internal CRM staff. Auth is OTP-only — there are no passwords to manage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/settings/manage-users/hierarchy" className="inline-flex">
            <Button variant="outline">
              <Users className="size-4 mr-1" /> Hierarchy
            </Button>
          </a>
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <Layers className="size-4 mr-1" /> Bulk Update Users
          </Button>
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="size-4 mr-1" /> Add User
          </Button>
        </div>
      </div>

      {/* Bulk Update modal — opens to a full-viewport dialog with two
          tabs (Select & Apply | Upload File). Refreshes the user list
          on close so the just-edited rows show their new scope. */}
      {/* allUsers is no longer passed — the dialog now fetches the full
          active user set from /admin/users/bulk-lookups so it isn't
          constrained by this page's current page-size. onApplied
          refreshes the visible list (which IS paged) after a mutation. */}
      <BulkUpdateUsersDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onApplied={() => {
          // Drop the module fetch cache for any /admin/users key so a
          // subsequent useFetch consumer doesn't see stale rows from
          // before the bulk mutation. Then refire the visible page.
          invalidateFetch((k) => k.startsWith('/admin/users'));
          void fetchList();
        }}
      />

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
            <span className="font-medium">How User management works</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-3 border-t">
              <section>
                <h3 className="font-semibold text-foreground mb-1">1. Who shows up here</h3>
                <p>
                  Internal CRM staff only (clients and technicians have their own portals).
                  Each row is identified by User ID; name + email are set once at create
                  time and not editable afterwards because OTPs are delivered against
                  those identifiers.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">2. Login flow</h3>
                <p>
                  Users log in with their email or mobile + a 4-digit OTP. No passwords
                  are stored or set from this screen.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">3. Role assignment</h3>
                <p>
                  A user holds exactly one role from <code>tbl_role</code>. The role
                  decides which CRM screens they can reach (see Manage Roles for the
                  list). Only admin-group roles are selectable here — client and
                  technician roles live in their own modules.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">4. Deactivating a user</h3>
                <p>
                  Soft-delete only. The row stays in the database; default lists hide
                  it. Use &ldquo;Include inactive&rdquo; to bring it back and reactivate
                  via the edit form. Historical records remain intact.
                </p>
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      {/*
        * Unified table card — filter row, table, and pagination all
        * live inside the same Card with internal borders so they read
        * as one cohesive table instead of three stacked sections.
        *   ┌─────────────────────────────────────────────────┐
        *   │  search · role · city · include inactive        │  ← thead-like
        *   ├─────────────────────────────────────────────────┤
        *   │  <table>                                        │
        *   ├─────────────────────────────────────────────────┤
        *   │  Show: 10 · « ‹ 6 / 8 › »                       │  ← tfoot-like
        *   └─────────────────────────────────────────────────┘
        */}
      <Card>
        <CardContent className="p-0">
          {/* Filter band — acts as the table's visual header row. */}
          <div className="p-3 flex items-center gap-2 flex-wrap border-b">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, mobile, or code…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            {/* Filters use the shared SearchSelect (typeahead + keyboard nav)
                rather than native <select> so large role/city lists are
                filterable by typing. Empty value = "All roles" / "All cities". */}
            <div className="min-w-[180px]">
              <SearchSelect
                value={roleFilter === '' ? '' : roleFilter}
                onChange={(v) => setRoleFilter(v ? Number(v) : '')}
                options={lookup.roles.map((r) => ({ value: r.role_id, label: r.role_name }))}
                placeholder="All roles"
              />
            </div>
            <div className="min-w-[180px]">
              <CitySelect
                value={cityFilter}
                onChange={(id) => setCityFilter(id ? Number(id) : '')}
                placeholder="All cities"
              />
            </div>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              Include inactive
            </label>
          </div>
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            {/*
                Column widths (must match the th/td sequence below):
                  6 percent  User ID
                  15 percent Name
                  16 percent Email
                  9 percent  Mobile
                  12 percent Role
                  13 percent Manage Regions
                  12 percent Job Stages
                  8 percent  Status
                  9 percent  Actions
                Inline JSX expression comments are illegal inside colgroup
                (they introduce single-space text nodes that fail
                hydration). See manage-roles for the full backstory.
            */}
            <colgroup>
              <col style={{ width: '6%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '9%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="user_id"        align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>User ID</SortHeader>
                <SortHeader col="user_name"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Name</SortHeader>
                <SortHeader col="official_email" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Email</SortHeader>
                <SortHeader col="mobile_no"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Mobile</SortHeader>
                <SortHeader col="role_name"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Role</SortHeader>
                {/*
                  * "Manage Regions" = expanded names from tbl_user.manage_states CSV.
                  * The list shows this as a comma-joined string of region (state)
                  * names. Not sortable because the underlying column is a CSV —
                  * sorting it would order rows by the raw "1,5,12" string, which
                  * is meaningless to operators.
                  */}
                <th className="!text-left whitespace-nowrap" title="Regions this user is allowed to manage (tbl_user.manage_states)">Regions</th>
                {/*
                  * Job Stage Access. Surfaced in the list because a restrictive
                  * grant is invisible otherwise yet has real blast radius — a
                  * "No Access" user sees no job pages at all. Not sortable: the
                  * value lives in tbl_user_allowed_stages, not on the row.
                  */}
                <th className="!text-left whitespace-nowrap" title="Job lifecycle stages this user can see and act on (tbl_user_allowed_stages)">Job Stages</th>
                <SortHeader col="user_status"    align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/*
                * Loading row appears ONLY when there's no existing data
                * to keep visible. On refetch (filter / page-size /
                * sort changes), we keep the previously-loaded rows
                * rendered so the table doesn't flash empty during the
                * 200ms server round-trip. Page-size changes especially
                * benefit — operators see the existing 10 rows stay
                * put, then the additional rows append on response.
                */}
              {loading && items.length === 0 && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">No users match the current filters.</td></tr>
              )}
              {items.map((u) => (
                <tr key={u.user_id}>
                  <td className="!text-center font-mono text-xs truncate">{u.user_id}</td>
                  <td className="!text-left font-medium truncate" title={u.user_name}>{u.user_name}</td>
                  <td className="!text-left truncate" title={u.official_email}>{u.official_email}</td>
                  <td className="!text-left font-mono text-xs truncate" title={u.mobile_no}>{u.mobile_no}</td>
                  <td className="!text-left truncate" title={u.role_name ?? ''}>
                    {u.role_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left truncate">
                    <ManageRegionsCell csv={u.manage_states} nameById={stateNameById} />
                  </td>
                  <td className="!text-left truncate">
                    <JobStagesCell stages={u.allowed_stages} />
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {u.user_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    {/*
                      * Icon-only row actions via the shared <IconButton>
                      * (src/components/ui/icon-button.tsx) — the single
                      * canonical per-row action icon for the CRM. It owns
                      * the uniform size/padding/intent-colour + subtle
                      * hover tint; this cell just owns the right-aligned
                      * flex wrapper. Edit → intent="primary" (blue),
                      * Deactivate → intent="danger" (red).
                      */}
                    <div className="inline-flex items-center justify-end">
                      {can.isUserEdit && (
                        <IconButton
                          icon={Pencil}
                          intent="primary"
                          label="Edit user"
                          onClick={async () => {
                            // The list row's `alternate_no` is BE-masked
                            // ("9876••••••"). Pre-filling the edit form
                            // with that would either show bullets in an
                            // input (confusing) or corrupt the record on
                            // save (Joi rejects). Refetch the user with
                            // ?unmasked=true so the edit modal pre-fills
                            // with the actual digits. Same pattern as
                            // JobModal / EasyfixerModal use for their
                            // edit modes.
                            try {
                              const fresh = await api.get<typeof u>(
                                `/admin/users/${u.user_id}`,
                                { unmasked: 'true' },
                              );
                              setEditing(fresh);
                            } catch {
                              // Fallback to the list row if the unmasked
                              // fetch fails — operator can still save by
                              // clearing the mobile field manually.
                              setEditing(u);
                            }
                            setModalOpen(true);
                          }}
                        />
                      )}
                      {can.isUserEdit && u.user_status === 1 && (
                        <IconButton
                          icon={Trash2}
                          intent="danger"
                          label="Deactivate user"
                          onClick={() => handleDeactivate(u)}
                        />
                      )}
                      {!can.isUserEdit && (
                        <span className="text-[10px] text-muted-foreground">view-only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Pagination band — acts as the table's visual footer row,
              sharing the same Card boundary as the filter band + table. */}
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      <UserFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        roles={lookup.roles}
        cities={lookup.cities}
        clients={lookup.clients}
        states={lookup.states}
        verticals={lookup.verticals}
        adminUsers={lookup.adminUsers}
        onSaved={() => {
          const editedSelf = !!editing && me?.user?.user_id === editing.user_id;
          setModalOpen(false);
          // Drop the module fetch cache so any consumer reading
          // /admin/users keys sees the fresh row after a save.
          invalidateFetch((k) => k.startsWith('/admin/users'));
          void fetchList();
          /*
           * Editing YOURSELF changes your own identity payload — Job Stage
           * Access, menu permissions and scope all ride on `me`, which is
           * cached and otherwise only revalidates on window focus (throttled
           * to 30s). Without this, granting yourself a stage leaves the
           * sidebar stale for several seconds before it silently corrects
           * itself, which reads as a bug rather than a permission taking
           * effect. Only fires on a self-edit; editing someone else can't
           * touch our own `me`.
           */
          if (editedSelf) void refreshMe();
        }}
      />
    </div>
  );
}

// ─── Manage-Regions cell ─────────────────────────────────────────────
/*
 * Expands a CSV string of IDs to a comma-joined list of names. Truncates
 * gracefully with a "+N more" suffix when the row has many entries; the
 * full list is exposed in the title tooltip so operators can still read
 * everything without scrolling the cell.
 *
 * Used by the list table to show manage_states (regions) as a
 * comma-separated display. Returns "—" placeholder when the CSV is empty
 * or null.
 */
function expandCsvToNames(csv: string | null | undefined, nameById: Map<number, string>): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((id) => nameById.get(id))
    .filter((name): name is string => !!name);
}

function ManageRegionsCell({ csv, nameById }: { csv: string | null | undefined; nameById: Map<number, string> }) {
  // '0' is the legacy "All" sentinel (lib/scope.js — mode === 'all').
  // Render it as a green pill so ops can see at a glance which users
  // have unrestricted scope.
  if (String(csv ?? '').trim() === '0') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[11px] font-medium">
        All
      </span>
    );
  }
  const names = expandCsvToNames(csv, nameById);
  if (names.length === 0) return <span className="text-muted-foreground">—</span>;
  // Show first 2 + "+N more" — keeps the column readable even for users
  // who manage many regions. Hover reveals the full list.
  const visible = names.slice(0, 2);
  const overflow = names.length - visible.length;
  return (
    <span title={names.join(', ')} className="text-xs">
      {visible.join(', ')}
      {overflow > 0 && <span className="text-muted-foreground"> +{overflow} more</span>}
    </span>
  );
}

// ─── Job-Stage-Access cell ───────────────────────────────────────────
/*
 * Renders the tri-state Job Stage Access grant. The two ends are pills rather
 * than text because they are the states an operator scans for:
 *
 *   null / undefined → "All"        green  — unrestricted (no rows; the default)
 *   []               → "No Access"  red    — explicitly granted nothing; this
 *                                            user sees NO job pages at all
 *   ['unconfirmed',…]→ stage labels        — restricted to those stages
 *
 * "All" is green to match ManageRegionsCell above, so the two scope columns
 * read the same way. "No Access" is the only red pill in the table — it is the
 * one setting that silently empties the CRM for someone.
 */
function JobStagesCell({ stages }: { stages?: string[] | null }) {
  if (stages == null) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[11px] font-medium">
        All
      </span>
    );
  }
  if (stages.length === 0) {
    return (
      <span
        title="This user has been granted no lifecycle stages — they cannot see or act on any job."
        className="inline-flex items-center rounded-full bg-red-100 text-red-800 px-2 py-0.5 text-[11px] font-medium"
      >
        No Access
      </span>
    );
  }
  // Same first-2 + "+N more" treatment as Regions — hover reveals the rest.
  const labels = stages.map((k) => STAGES[k as keyof typeof STAGES]?.label ?? k);
  const visible = labels.slice(0, 2);
  const overflow = labels.length - visible.length;
  return (
    <span title={labels.join(', ')} className="text-xs">
      {visible.join(', ')}
      {overflow > 0 && <span className="text-muted-foreground"> +{overflow} more</span>}
    </span>
  );
}

// Local SortHeader removed 2026-05-15 — migrated to the shared
// component in `lib/use-sort.tsx` (3-state cycle + icon only on
// active column). See `cycleSort` + `<SortHeader>` import above.

// ─── Add/Edit modal ─────────────────────────────────────────────────
/*
 * Create form: name + email + mobile + role + Manage Regions (multi) +
 * Manage Clients (multi) + Manage Verticals.
 * Edit form:   name + email shown read-only (OTP is keyed off these);
 *              everything else editable.
 *
 * Geo scope is REGION (state) level: a user is assigned Regions (the
 * `tbl_user.manage_states` CSV, labelled "Manage Regions") and handles ALL
 * cities in them. This REPLACES the legacy addEditUser.vm "Manages Cities"
 * picker — `manage_cities` is now always saved as "0" (all) and the backend
 * derives the effective city scope from the user's Regions (see
 * EasyFix_Backend/lib/scope.js `expandStatesToCities`).
 *
 * Fields:
 *   - User Name        (read-only on edit)
 *   - Email            (read-only on edit)
 *   - Mobile Number    *
 *   - User Role        *
 *   - Manage Regions   (multi-select, CSV in tbl_user.manage_states)
 *   - Manage Clients   (multi-select, CSV in tbl_user.manage_clients)
 *   - Status           (edit only)
 *
 * The "home City" picker (tbl_user.city_id) is a new-app addition kept for
 * other flows that key off it; it sits below the scope pickers.
 */
function UserFormModal({
  open, onClose, editing, roles, cities, clients, states, verticals, adminUsers, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: User | null;
  roles: Array<{ role_id: number; role_name: string }>;
  /*
   * Cities/clients now carry their parent FK (state_id / vertical_id)
   * so the Manages Cities / Manages Clients pickers can cascade off
   * Manages States / Manages Verticals. Both fields default to null
   * for orphan rows — those are excluded from the cascaded view since
   * they belong to no parent.
   */
  cities: Array<{ city_id: number; city_name: string; state_id: number | null }>;
  clients: Array<{ client_id: number; client_name: string; vertical_id: number | null }>;
  states: Array<{ state_id: number; state_name: string }>;
  verticals: Array<{ vertical_id: number; vertical_name: string }>;
  adminUsers: Array<{ user_id: number; user_name: string; role_name?: string }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name,    setName]    = useState('');
  const [email,   setEmail]   = useState('');
  const [mobile,  setMobile]  = useState('');
  const [altMob,  setAltMob]  = useState('');
  /*
   * Real-time mobile-uniqueness check.
   *   mobileCheck.state — 'idle' (no probe in flight), 'checking' (probe
   *     in flight), 'available' (mobile is free), 'taken' (taken by another
   *     active internal user), 'invalid' (not 10 digits — UI shows the
   *     existing length warning instead, so we render nothing for this).
   *   Cached in a Map so re-typing the same number doesn't refetch and the
   *   debounce delay (450ms) is the only wait on first probe.
   */
  const [mobileCheck, setMobileCheck] = useState<{
    state: 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
    takenByName?: string;
  }>({ state: 'idle' });
  const mobileCacheRef = useRef<Map<string, { available: boolean; takenBy?: { user_id: number; user_name: string } }>>(new Map());
  /*
   * Real-time email-uniqueness check — parallel to mobileCheck.
   * `suggestion` is filled in by the backend when the typed email is
   * taken AND the form has a non-empty Name (so the suggestion can be
   * derived from <first>.<last>). One-click "Use suggestion" calls
   * setEmail() to adopt it.
   */
  const [emailCheck, setEmailCheck] = useState<{
    state: 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
    takenByName?: string;
    suggestion?: string;
  }>({ state: 'idle' });
  const emailCacheRef = useRef<Map<string, {
    available: boolean;
    takenBy?: { user_id: number; user_name: string };
    suggestion?: string;
  }>>(new Map());
  const [roleId,  setRoleId]  = useState<number | ''>('');
  const [cityId,  setCityId]  = useState<number | ''>('');
  const [active,  setActive]  = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Prompt before discarding the form on Cancel — applies to every Add
  // / Edit User open. See `useCancelConfirm` for the standard copy.
  const cancelWithConfirm = useCancelConfirm(onClose);
  const [error, setError] = useState<string | null>(null);

  // Manages Clients / States / Verticals — Sets for O(1) toggle. Persisted
  // as CSV strings on save to match legacy `tbl_user.manage_*` storage.
  // Hydrated from the editing row's CSV by parsing the comma-separated id
  // list. Cities are no longer collected here — the form always saves
  // manage_cities='0' and the backend derives the effective city scope
  // from the user's states (regions).
  const [manageClients,   setManageClients]   = useState<Set<number>>(new Set());
  const [manageStates,    setManageStates]    = useState<Set<number>>(new Set());
  const [manageVerticals, setManageVerticals] = useState<Set<number>>(new Set());
  // "All" toggles — when ON the corresponding multi-select is disabled
  // and we save '0' as the CSV (matches lib/scope.js's mode==='all').
  // Hydrated on edit-mode by detecting CSV === '0' on the editing row.
  const [verticalsAll, setVerticalsAll] = useState(false);
  const [clientsAll,   setClientsAll]   = useState(false);
  const [statesAll,    setStatesAll]    = useState(false);
  const [reportingManager, setReportingManager] = useState<number | ''>('');
  /*
   * Job Stage Access — restrict this user to a subset of job lifecycle STAGES
   * (STAGE_KEYS from lib/job-stages.ts). `allowedStages` holds the picked
   * stage_keys; `stagesAll` is the "All stages" toggle. Default = All ON
   * (unrestricted) so a new user is never accidentally locked out.
   *
   * Save semantics (see handleSubmit): the backend contract is NULL = ALL
   * (unrestricted), EMPTY ARRAY [] = explicit NO ACCESS, non-empty = restricted.
   * So All-ON → null; a specific pick → that array; All-OFF with no picks → []
   * (the operator deliberately granted nothing — the user sees no jobs).
   */
  const [allowedStages, setAllowedStages] = useState<Set<string>>(new Set());
  const [stagesAll,     setStagesAll]     = useState(true);

  // Reporting Manager + Home City + Role + all 4 scope multi-selects now
  // use `SearchSelect`/`SearchMultiSelect`, which own their own internal
  // filter + selected-label state. The previous module-local
  // `managerQuery` / `cityQuery` / `filtered*` / `selected*Name` memos
  // were therefore removed — leaving them would have been dead state.

  // Helper to convert a CSV string to a Set<number>. Tolerant of nulls,
  // whitespace, junk — matches the backend's parseMenuIdsCsv.
  function csvToSet(csv: string | null | undefined): Set<number> {
    if (!csv) return new Set();
    return new Set(
      String(csv)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    );
  }

  useEffect(() => {
    if (open) {
      setName(editing?.user_name ?? '');
      setEmail(editing?.official_email ?? '');
      setMobile(editing?.mobile_no ?? '');
      setAltMob(editing?.alternate_no ?? '');
      setRoleId(editing?.user_role ?? '');
      setCityId(editing?.city_id ?? '');
      setActive(editing ? editing.user_status === 1 : true);
      // '0' is the legacy "All" sentinel — hydrate the All toggle ON
      // and leave the Set empty. The picker is disabled while All is
      // on; save() re-serialises '0' regardless of the Set state.
      const isAll = (csv: string | null | undefined) => String(csv ?? '').trim() === '0';
      setVerticalsAll(isAll(editing?.manage_verticals));
      setClientsAll(isAll(editing?.manage_clients));
      setStatesAll(isAll(editing?.manage_states));
      setManageClients(isAll(editing?.manage_clients) ? new Set() : csvToSet(editing?.manage_clients));
      setManageStates(isAll(editing?.manage_states) ? new Set() : csvToSet(editing?.manage_states));
      setManageVerticals(isAll(editing?.manage_verticals) ? new Set() : csvToSet(editing?.manage_verticals));
      setReportingManager(editing?.reporting_manager ?? '');
      // Job Stage Access — NULL / absent allowed_stages = unrestricted, so
      // hydrate the "All stages" toggle ON with an empty pick set. An ARRAY
      // (even an empty one) means the operator has set an explicit grant:
      // toggle OFF, pick set = the array. [] therefore round-trips as
      // "no access", not as All.
      const stages = editing?.allowed_stages ?? null;
      setStagesAll(stages === null);
      setAllowedStages(new Set(stages ?? []));
      setError(null);
    }
  }, [open, editing]);

  function toggleManageClient(id: number) {
    setManageClients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /*
   * Cascade rules for Verticals → Clients and States → Cities
   * (introduced 2026-05-15):
   *
   * - Picker options for the dependent field (Clients / Cities) only
   *   include rows whose parent FK is in the currently-selected parent
   *   set. If 0 parents are selected, the picker shows nothing — the
   *   operator must pick a parent first.
   * - When a parent is REMOVED, prune the selected dependents whose
   *   parent FK was that removed parent (and isn't in any of the
   *   still-selected parents). "Don't remove for parents not altered"
   *   — adding never prunes.
   * - Orphan dependents (parent FK = null) are dropped whenever the
   *   filter is active (any parent selected). They can never be added
   *   through the strict picker; clearing all parents leaves them
   *   un-addable until a parent is picked again.
   * - Initial DB hydration of the form is NOT a "change" — load is
   *   raw csvToSet, so existing legacy data with mismatched parents
   *   stays visible as chips until the operator interacts with the
   *   parent field. This preserves backwards-compat for old records
   *   saved before this constraint existed.
   *
   * The cascade lives in the change/toggle handlers (not a useEffect
   * on [manageVerticals]) so the initial hydration doesn't trigger
   * an unwanted prune.
   */
  function applyManageVerticals(next: Set<number>) {
    setManageVerticals(next);
    setManageClients((prevClients) => {
      // Adding a vertical: prevClients ⊆ allowed-by-prev ⊆ allowed-by-next
      // → no prune needed (but pruning is also idempotent so the filter
      // below stays safe to run unconditionally).
      if (next.size === 0) return new Set();
      const pruned = new Set<number>();
      for (const cid of prevClients) {
        const c = clients.find((x) => x.client_id === cid);
        if (!c || c.vertical_id == null) continue;
        if (next.has(c.vertical_id)) pruned.add(cid);
      }
      return pruned;
    });
  }
  function toggleManageVertical(id: number) {
    const next = new Set(manageVerticals);
    if (next.has(id)) next.delete(id); else next.add(id);
    applyManageVerticals(next);
  }

  function applyManageStates(next: Set<number>) {
    // Regions (states) no longer cascade into a Cities picker — this is now
    // a plain setter. Kept as a named helper so toggleManageState and the
    // ScopeMultiSelect onChange share one entry point.
    setManageStates(next);
  }
  function toggleManageState(id: number) {
    const next = new Set(manageStates);
    if (next.has(id)) next.delete(id); else next.add(id);
    applyManageStates(next);
  }

  // Job Stage Access — plain add/remove of a stage_key. Used by the chip
  // remove-buttons and (via the picker) the multi-select onChange.
  function toggleStage(key: string) {
    setAllowedStages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  /*
   * Derived option lists for the cascaded pickers. When no parent is
   * selected, the list is empty — a helper note under each picker
   * tells the operator to pick a parent first. Orphan rows (parent
   * FK = null) are excluded from the strict-filtered view.
   */
  // Cascading filters (aligned with the Bulk Update modal):
  //   - parent-All ON → child shows every active record
  //   - parent empty (and parent-All OFF) → child shows ALL active
  //     records as well (operator hasn't constrained scope yet)
  //   - parent has picks → child filtered to records under those picks
  //
  // The All-toggle on the child is GATED separately at the UI layer
  // (see ScopeMultiSelect's disableAll prop) so the operator can't
  // store child=0 with an empty parent.
  const filteredClientOptions = useMemo(() => {
    if (verticalsAll || manageVerticals.size === 0) {
      return clients.map((c) => ({ value: c.client_id, label: c.client_name }));
    }
    return clients
      .filter((c) => c.vertical_id != null && manageVerticals.has(c.vertical_id))
      .map((c) => ({ value: c.client_id, label: c.client_name }));
  }, [clients, manageVerticals, verticalsAll]);

  /*
   * Debounced real-time mobile-uniqueness probe. Fires only when:
   *   - exactly 10 digits typed (shorter is a length warning, not a probe)
   *   - mobile differs from the user being edited (no probe for unchanged)
   * Cache hits resolve instantly; cache misses wait 450ms after the last
   * keystroke. The dropdown stays disabled during 'checking' so a fast
   * Save can't race the probe. AbortController cancels stale requests
   * when the user keeps typing.
   */
  /*
   * Debounced real-time email-uniqueness probe. The email field is
   * read-only on Edit (OTP keys to it), so the probe only runs on the
   * Add flow. The `name` query param lets the backend generate a
   * `<first>.<last>[<n>]@easyfix.in` suggestion when the typed address
   * is taken — we surface it as a one-click chip below the input.
   */
  useEffect(() => {
    if (!open) return;
    if (isEdit) { setEmailCheck({ state: 'idle' }); return; }
    const e = email.trim().toLowerCase();
    if (!e) { setEmailCheck({ state: 'idle' }); return; }
    if (!/^\S+@\S+\.\S+$/.test(e)) {
      setEmailCheck({ state: 'invalid' });
      return;
    }
    // Cache key includes name so suggestion bumps regenerate when the
    // operator renames the user; the email itself is what we probe.
    const cacheKey = `${e}::${name.trim().toLowerCase()}`;
    const cached = emailCacheRef.current.get(cacheKey);
    if (cached) {
      setEmailCheck(cached.available
        ? { state: 'available' }
        : { state: 'taken', takenByName: cached.takenBy?.user_name, suggestion: cached.suggestion });
      return;
    }
    setEmailCheck({ state: 'checking' });
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const params: Record<string, string | number> = { email: e };
        if (name.trim()) params.name = name.trim();
        // Debounced
        // availability probe with its own `emailCacheRef` keyed on
        // email+name; the effect implements bespoke setTimeout-debounce
        // + stale-response cancellation that's tighter than what
        // useFetch/useDebouncedValue would give here (cache key depends
        // on TWO inputs, and we suppress fetch entirely on invalid
        // formats / Edit mode / same-as-editing). Migration would mean
        // reimplementing the cache+gating layer above the hook.
        // eslint-disable-next-line no-restricted-syntax
        const res = await api.get<{
          available: boolean;
          takenBy?: { user_id: number; user_name: string };
          suggestion?: string;
        }>('/admin/users/check-email', params);
        if (cancelled) return;
        emailCacheRef.current.set(cacheKey, res);
        setEmailCheck(res.available
          ? { state: 'available' }
          : { state: 'taken', takenByName: res.takenBy?.user_name, suggestion: res.suggestion });
      } catch {
        if (!cancelled) setEmailCheck({ state: 'idle' });
      }
    }, 450);
    return () => { window.clearTimeout(timer); cancelled = true; };
  }, [email, name, isEdit, open]);

  useEffect(() => {
    if (!open) return;
    // Same-as-editing → not a change, skip the probe entirely.
    if (isEdit && mobile === (editing?.mobile_no ?? '')) {
      setMobileCheck({ state: 'idle' });
      return;
    }
    if (!/^[0-9]{10}$/.test(mobile)) {
      // length warning is rendered by the existing UI; we stay idle.
      setMobileCheck({ state: mobile.length === 0 ? 'idle' : 'invalid' });
      return;
    }
    const cached = mobileCacheRef.current.get(mobile);
    if (cached) {
      setMobileCheck(cached.available
        ? { state: 'available' }
        : { state: 'taken', takenByName: cached.takenBy?.user_name });
      return;
    }
    setMobileCheck({ state: 'checking' });
    // Stale-response guard: each effect run sets `cancelled=true` from its
    // cleanup callback, so an in-flight probe whose result arrives AFTER
    // the user kept typing simply no-ops instead of overwriting the newer
    // state. The api wrapper doesn't surface AbortSignal, and that's fine
    // for a 10-digit probe — at most one stale request hits the network.
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const params: Record<string, string | number> = { mobile };
        if (isEdit && editing?.user_id) params.excludeUserId = editing.user_id;
        // Mirror of the
        // email availability probe above: bespoke setTimeout-debounce
        // + per-mobile cache ref + same-as-editing short-circuit. Same
        // rationale as the email probe — useFetch's single-key contract
        // can't express the "skip when same as editing" branch without
        // a contrived enabled chain.
        // eslint-disable-next-line no-restricted-syntax
        const res = await api.get<{ available: boolean; takenBy?: { user_id: number; user_name: string } }>(
          '/admin/users/check-mobile', params,
        );
        if (cancelled) return;
        mobileCacheRef.current.set(mobile, res);
        setMobileCheck(res.available
          ? { state: 'available' }
          : { state: 'taken', takenByName: res.takenBy?.user_name });
      } catch {
        if (!cancelled) setMobileCheck({ state: 'idle' });
      }
    }, 450);
    return () => { window.clearTimeout(timer); cancelled = true; };
  }, [mobile, isEdit, editing?.user_id, editing?.mobile_no, open]);

  async function handleSubmit() {
    setError(null);
    if (!isEdit) {
      if (!name.trim())  { setError('Name is required'); return; }
      if (!email.trim()) { setError('Email is required'); return; }
      if (!/^\S+@\S+\.\S+$/.test(email)) { setError('Email format looks wrong'); return; }
      // Defensive — the BE also rejects duplicates, but blocking here
      // keeps the operator from clicking Save while the rose hint is
      // still on screen. We tolerate 'checking' (in-flight probe):
      // backend is the source of truth and will reject if needed.
      if (emailCheck.state === 'taken') {
        setError('Email already in use');
        return;
      }
    }
    /*
     * Mobile is OPTIONAL (2026-08-03) — it used to be mandatory. Blank passes;
     * anything typed must still be exactly 10 digits, so a mistyped number is
     * caught rather than half-stored. Mirrors the backend createBody, which now
     * allows '' / null but keeps the same pattern.
     */
    if (mobile.trim() && !/^[0-9]{10}$/.test(mobile)) { setError('Mobile must be 10 digits'); return; }
    if (altMob && !/^[0-9]{10}$/.test(altMob)) { setError('Alternate number must be 10 digits or blank'); return; }
    // Block submit if the real-time probe found a collision. Backend
    // re-checks on create/update too — this is defensive UX only. We
    // tolerate 'checking' (probe in flight): backend is the source of
    // truth and will reject if needed; blocking submit on 'checking'
    // would frustrate fast typists.
    if (mobileCheck.state === 'taken') {
      setError(`Mobile already in use${mobileCheck.takenByName ? ` by ${mobileCheck.takenByName}` : ''}`);
      return;
    }
    if (!roleId) { setError('Role is required'); return; }

    // Vertical-touched → client-mandatory rule (mirrors the BE bulk
    // route). If the operator toggled All or picked any verticals,
    // they must explicitly pick (or All) clients too — prevents the
    // "narrowed vertical but forgot clients" footgun.
    const verticalsTouched = verticalsAll || manageVerticals.size > 0;
    const clientsTouched   = clientsAll   || manageClients.size   > 0;
    if (verticalsTouched && !clientsTouched) {
      setError('You picked verticals — please also pick clients (or toggle All).');
      return;
    }

    // Serialise the Sets back to CSV — matches legacy tbl_user storage.
    // Sort by id so the persisted value is deterministic.
    //
    // "All" sentinel rules (per ops direction 2026-05-25):
    //   1. The explicit "All" toggle emits '0' (existing behaviour).
    //   2. If the operator picks every option ONE-BY-ONE without
    //      toggling "All", we ALSO collapse to '0' so the stored
    //      value matches semantic intent. Saves storage churn on
    //      lookups that grow (e.g. a new city added later would
    //      otherwise leave that user "behind"; with '0' they
    //      inherit the new option automatically).
    const csvOrAll = (all: boolean, set: Set<number>, total: number) => {
      if (all) return '0';
      // Auto-collapse: full set === All
      if (total > 0 && set.size >= total) return '0';
      const csv = Array.from(set).sort((a, b) => a - b).join(',');
      return csv || null;
    };
    // Cities are no longer collected in this form. Scope is now "Manage
    // Regions" (states) only; the backend derives the effective city scope
    // from the user's states. We always persist manage_cities as the '0'
    // ("all") sentinel so nothing narrows the city dimension from here.
    const manageClientsCsv   = csvOrAll(clientsAll,   manageClients,   clients.length);
    const manageStatesCsv    = csvOrAll(statesAll,    manageStates,    states.length);
    const manageVerticalsCsv = csvOrAll(verticalsAll, manageVerticals, verticals.length);

    /*
     * Job Stage Access. Backend contract: NULL = ALL (unrestricted, stored as
     * no rows); EMPTY ARRAY [] = explicit NO ACCESS (stored as a sentinel row);
     * a non-empty array = restricted to those stage_keys. So:
     *   All-ON             → null  (unrestricted)
     *   All-OFF + no picks → []    (no access — the operator granted nothing)
     *   specific picks     → that array
     */
    const allowedStagesPayload: string[] | null = stagesAll
      ? null
      : Array.from(allowedStages);

    setSubmitting(true);
    /*
     * The create response carries the Microsoft 365 mailbox outcome alongside
     * the new user — see `provisioning` on CreatedUser. Captured so the toast
     * can tell the truth: the CRM user is created either way, but the mailbox
     * can fail INDEPENDENTLY (no licence seat, missing Graph consent, SKU not
     * on the tenant), and a flat green "User Created" hides exactly that.
     */
    let created: CreatedUser | null = null;
    try {
      if (isEdit) {
        await api.patch(`/admin/users/${editing!.user_id}`, {
          mobile_no:        mobile,
          alternate_no:     altMob || null,
          user_role:        Number(roleId),
          city_id:          cityId ? Number(cityId) : null,
          manage_cities:    '0',
          manage_clients:   manageClientsCsv,
          manage_states:    manageStatesCsv,
          manage_verticals: manageVerticalsCsv,
          allowed_stages:   allowedStagesPayload,
          reporting_manager: reportingManager ? Number(reportingManager) : null,
          is_active:        active,
        });
      } else {
        created = await api.post<CreatedUser>('/admin/users', {
          user_name:        name.trim(),
          official_email:   email.trim(),
          mobile_no:        mobile,
          alternate_no:     altMob || null,
          user_role:        Number(roleId),
          city_id:          cityId ? Number(cityId) : null,
          manage_cities:    '0',
          manage_clients:   manageClientsCsv,
          manage_states:    manageStatesCsv,
          manage_verticals: manageVerticalsCsv,
          allowed_stages:   allowedStagesPayload,
          reporting_manager: reportingManager ? Number(reportingManager) : null,
        });
      }
      // Success feedback via the shared bottom-centre toast — matches
      // the convention used across the CRM (Notice Board, Manage Roles,
      // Manage Clients). Inline `setError` stays for FAILURES so the
      // operator sees them within the still-open modal.
      // Title Case + no trailing period — matches the project-wide UI
      // label-casing rule (memory `feedback_easyfix_label_casing`).
      /*
       * MAILBOX OUTCOME — reported honestly, not folded into the success toast.
       *
       * Creating the Entra account and assigning the 365 licence are TWO
       * independent steps: `created` + `no_seats_available` means the directory
       * account exists but there is no mailbox, so the address will bounce.
       * Observed live on user 8737 (vijay.nailwal@easyfix.in): the operator saw
       * a green "User Created" while the mailbox had silently failed on
       * "SKU O365_BUSINESS_ESSENTIALS has no free seats (67/67 used)".
       *
       * `warning` (amber, 6s) is the right variant, not `error`: the user WAS
       * created — this is an operation that succeeded but not the way the
       * operator asked. Rose on a successful action trains people to distrust
       * the colour. Amber also holds for 6s rather than success's 4s, because
       * the reason is something they have to read and act on.
       */
      const prov = created?.provisioning;
      if (!isEdit && prov?.pending) {
        showToast({
          variant: 'warning',
          message: 'User Created — Microsoft 365 mailbox provisioning is still running. Check the Provisioning panel shortly.',
        });
      } else if (!isEdit && prov?.attempted && !prov.mailboxReady) {
        showToast({
          variant: 'warning',
          message: `User Created — but the Microsoft 365 mailbox is NOT ready: ${prov.reason || 'see the provisioning outcome'}`,
        });
      } else {
        showToast({
          variant: 'success',
          message: isEdit ? 'User Updated' : 'User Created',
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  // useFormDirtyGuard (2026-06-03) — same pattern as the sibling
  // Add/Edit Role modal: Esc / X / overlay-click now prompt with the
  // shared "Discard changes?" confirm; skip while saving.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/* Wider modal — matches Add/Edit Role so the two settings forms
          feel like siblings, and gives the multi-select pickers enough
          horizontal room for the chip rows below them. */}
      <DialogContent className="!max-w-[1100px] w-[95vw]">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.user_name}"` : 'Add User'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          {/* Row 1: Full Name | Status toggle (edit only).
              On Add, the Status column is unused — Status defaults to
              Active for new users so we omit it entirely instead of
              showing a redundant always-on switch. Grid collapses to one
              column on narrow viewports so the toggle drops below the
              name field gracefully. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
            <div>
              <Label className="block mb-1" required>
                Full Name {isEdit && <span className="text-xs text-muted-foreground font-normal">(not editable)</span>}
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                disabled={isEdit}
              />
            </div>
            {isEdit ? (
              <div className="flex items-center justify-end gap-3 pb-1.5">
                <span className="text-sm font-medium">Status</span>
                <Switch checked={active} onCheckedChange={setActive} ariaLabel="Toggle user active" />
                <span
                  className={`text-xs w-16 inline-block text-left ${
                    active ? 'text-emerald-700' : 'text-muted-foreground'
                  }`}
                >
                  {active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ) : (
              /* Spacer so the grid keeps its two-column layout on md+
                 (otherwise Full Name would stretch full-width which
                 doesn't match the rest of the form's row rhythm). */
              <div className="hidden md:block" aria-hidden="true" />
            )}
          </div>

          {/* Row 2: Official Email | Role.
              Email is non-editable on edit (it keys OTP delivery). Role
              uses the shared SearchSelect so the dropdown matches every
              other typeahead in the form. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1" required>
                Official Email
              </Label>
              {/* Add-mode: hardcode the @easyfix.in suffix as a non-editable
                  affix so operators can't accidentally type a foreign
                  domain. Only the local-part input round-trips into state.
                  Edit-mode: render the full email, disabled — we never
                  change OTP-keyed emails on existing users. */}
              {isEdit ? (
                <Input
                  type="email"
                  value={email}
                  disabled
                />
              ) : (
                <div className="flex items-stretch">
                  <Input
                    type="text"
                    value={email.endsWith('@easyfix.in')
                      ? email.slice(0, -'@easyfix.in'.length)
                      : email.replace(/@.*$/, '')}
                    onChange={(e) => {
                      const local = e.target.value.replace(/@.*/g, '').replace(/\s+/g, '').toLowerCase();
                      setEmail(local ? `${local}@easyfix.in` : '');
                    }}
                    placeholder="priya"
                    className="rounded-r-none"
                  />
                  <span className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-input bg-muted text-sm text-muted-foreground select-none">
                    @easyfix.in
                  </span>
                </div>
              )}
              {/* Real-time DB uniqueness check — only on Add, only after
                  the value parses as an email. Suggestion chip lets the
                  operator adopt the next free <first>.<last>[<n>]@easyfix.in
                  slot with one click. Taker name is intentionally NOT
                  surfaced — exposes too much in a shared CRM. */}
              {!isEdit && emailCheck.state === 'checking' && (
                <p className="text-xs text-muted-foreground mt-1">Checking availability…</p>
              )}
              {!isEdit && emailCheck.state === 'available' && (
                <p className="text-xs text-emerald-700 mt-1">✓ Available</p>
              )}
              {!isEdit && emailCheck.state === 'taken' && (
                <div className="mt-1 space-y-1">
                  <p className="text-xs text-rose-700">
                    ✗ Already in use
                  </p>
                  {emailCheck.suggestion && (
                    <button
                      type="button"
                      className="text-xs text-sky-700 hover:text-sky-900 underline underline-offset-2"
                      onClick={() => setEmail(emailCheck.suggestion!)}
                    >
                      Use suggestion: <span className="font-mono">{emailCheck.suggestion}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <div>
              <Label className="block mb-1" required>Role</Label>
              <SearchSelect
                value={roleId === '' ? '' : roleId}
                onChange={(v) => setRoleId(v ? Number(v) : '')}
                options={roles.map((r) => ({ value: r.role_id, label: r.role_name }))}
                placeholder="Search and select a role…"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              {/* No `required` — mobile became optional 2026-08-03. The
                  10-digit format is still enforced when one IS supplied. */}
              <Label className="block mb-1">Mobile</Label>
              <Input
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10-digit number (optional)"
                className="font-mono"
              />
              {mobile && mobile.length !== 10 && (
                <p className="text-xs text-amber-700 mt-1">Mobile must be exactly 10 digits ({mobile.length}/10).</p>
              )}
              {/* Real-time DB uniqueness check — only renders for a complete
                  10-digit number that actually differs from the user being
                  edited. Sub-second feel via 450ms debounce + in-memory
                  cache; the form submit is blocked while taken (see
                  handleSubmit guard below). */}
              {mobile.length === 10 && mobileCheck.state === 'checking' && (
                <p className="text-xs text-muted-foreground mt-1">Checking availability…</p>
              )}
              {mobile.length === 10 && mobileCheck.state === 'available' && (
                <p className="text-xs text-emerald-700 mt-1">✓ Available</p>
              )}
              {mobile.length === 10 && mobileCheck.state === 'taken' && (
                <p className="text-xs text-rose-700 mt-1">
                  ✗ Already in use{mobileCheck.takenByName ? ` by ${mobileCheck.takenByName}` : ' by another active user'}.
                </p>
              )}
            </div>
            <div>
              <Label className="block mb-1">Alternate Mobile</Label>
              <Input
                value={altMob}
                onChange={(e) => setAltMob(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="optional"
                className="font-mono"
              />
              {altMob && altMob.length !== 10 && (
                <p className="text-xs text-amber-700 mt-1">If supplied, alt mobile must be 10 digits.</p>
              )}
            </div>
          </div>

          {/* Role helper text — kept under the Email | Role row above
              (instead of inside the picker block) so the grid stays
              clean. Backend rejects role+group mismatches; this hint
              tells operators what to expect if a combo fails. */}
          <p className="text-xs text-muted-foreground -mt-1">
            Every active role is listed. Backend will reject combos that aren&apos;t allowed for the user&apos;s group.
          </p>

          {/*
            * Multi-select scope fields — Cities / Clients / States / Verticals.
            *
            * REFACTORED: previously each field rendered its own search box,
            * a chips-row ABOVE the scrollable list, then the list itself.
            * That layout pushed selected chips into the reading flow before
            * the operator finished selecting, made tall sections in the
            * form (4 × 36-line lists = a lot of scrolling), and duplicated
            * the same search/clear logic four times.
            *
            * Now: each field renders a single `SearchMultiSelect` trigger
            * (matches the look of other dropdowns in the form) and chips
            * appear BELOW it once selected. The popover's internal
            * filter + "select all / clear" footer replaces the old
            * inline Input + bulk action row.
            *
            * Layout: two columns on md+ so the four scopes fit on one
            * screen without a long vertical scroll. Falls back to a
            * single column on narrow viewports.
            */}
          {/*
            * Layout:
            *   Row 1: Verticals | Clients
            *   Row 2: Manage Regions (writes manage_states)
            * Clients sit immediately to the right of their parent
            * (Verticals) so the cascade direction is visually obvious —
            * Clients options are filtered to selected Verticals; see
            * `applyManageVerticals` for the prune-on-remove rules.
            * Cities were removed: the form collects Regions only and
            * always persists manage_cities='0' (see handleSubmit).
            */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Verticals — parent of Clients */}
            <ScopeMultiSelect
              label="Manages Verticals"
              chipColor="amber"
              selected={manageVerticals}
              onChange={(next) => applyManageVerticals(new Set(next as number[]))}
              options={verticals.map((v) => ({ value: v.vertical_id, label: v.vertical_name }))}
              chipFor={(id) => verticals.find((x) => x.vertical_id === id)?.vertical_name}
              onRemoveOne={toggleManageVertical}
              placeholder="Select verticals…"
              selectedLabel="verticals"
              allOn={verticalsAll}
              onAllChange={(b) => {
                setVerticalsAll(b);
                // Clear the picked set on EITHER direction. Toggling
                // On: chips would be stale under "All". Toggling Off:
                // operator wants a clean slate to re-pick — they
                // explicitly unchecked "All", so any previously-loaded
                // chips are no longer relevant.
                setManageVerticals(new Set());
                // Reset Clients-All AND clear the client set so the
                // operator re-affirms client scope against the new
                // vertical universe (the "client mandatory after
                // vertical change" rule).
                setClientsAll(false);
                setManageClients(new Set());
              }}
            />

            {/* Clients — filtered by selected Verticals */}
            <ScopeMultiSelect
              label="Manages Clients"
              chipColor="emerald"
              selected={manageClients}
              onChange={(next) => setManageClients(new Set(next as number[]))}
              options={filteredClientOptions}
              chipFor={(id) => clients.find((x) => x.client_id === id)?.client_name}
              onRemoveOne={toggleManageClient}
              placeholder="Select clients…"
              selectedLabel="clients"
              helperText={
                !verticalsAll && manageVerticals.size === 0
                  ? 'Pick at least one vertical above (or toggle All) to choose clients.'
                  : undefined
              }
              allOn={clientsAll}
              onAllChange={(b) => {
                setClientsAll(b);
                // Always clear chips on either direction — matches the
                // Verticals toggle behavior. Operator expects a clean
                // state when unchecking All so they can re-pick from
                // scratch.
                setManageClients(new Set());
              }}
              // Locked until a Vertical (or Verticals-All) is picked.
              disableAll={!verticalsAll && manageVerticals.size === 0}
            />

            {/* Regions — writes tbl_user.manage_states underneath. Only the
                labels change; the field still serialises manage_states. */}
            <ScopeMultiSelect
              label="Manage Regions"
              chipColor="violet"
              selected={manageStates}
              onChange={(next) => applyManageStates(new Set(next as number[]))}
              options={states.map((s) => ({ value: s.state_id, label: s.state_name }))}
              chipFor={(id) => states.find((x) => x.state_id === id)?.state_name}
              onRemoveOne={toggleManageState}
              placeholder="All Regions"
              selectedLabel="regions"
              allOn={statesAll}
              onAllChange={(b) => {
                setStatesAll(b);
                // Toggling either direction clears the region set so the
                // operator gets a clean slate to re-pick.
                setManageStates(new Set());
              }}
            />

            {/*
              * Job Stage Access — restrict the user to a subset of job
              * lifecycle STAGES. "All" ON = unrestricted (saved as null); OFF
              * with nothing picked = no access (saved as []). Sits alongside
              * the geo/vertical scopes because it's the same class of
              * row-visibility control.
              */}
            <ScopeMultiSelect<string>
              label="Job Stage Access"
              chipColor="blue"
              selected={allowedStages}
              onChange={(next) => setAllowedStages(new Set(next as string[]))}
              options={STAGE_OPTIONS}
              chipFor={(key) => STAGES[key as keyof typeof STAGES]?.label}
              onRemoveOne={toggleStage}
              placeholder="Select stages…"
              selectedLabel="stages"
              helperText="Which lifecycle stages this user can see and act on. All on = unrestricted. All off with nothing selected = no access to any job."
              allOn={stagesAll}
              onAllChange={(b) => {
                setStagesAll(b);
                // Clear the pick set on either direction — matches the geo
                // scopes. All-ON hides the picker; All-OFF gives a clean
                // slate, and saving from there (no picks) means NO ACCESS.
                setAllowedStages(new Set());
              }}
            />
          </div>

          {/*
            * Reporting Manager + Home City — both single-select. Side
            * by side so the identity-graph metadata clusters together.
            *
            * Reporting Manager drives the hierarchy DFS for scope-union
            * (on login, the user's own scope is merged with every
            * direct/indirect report's manage_* fields). Self-assignment
            * is blocked at the UI layer (`adminUsers` filtered to
            * exclude the current user); backend also catches transitive
            * cycles.
            *
            * Home City (tbl_user.city_id) is a new-app addition — not
            * in the legacy form but the column has existed for years
            * and other surfaces key off it.
            *
            * Both fields share the SearchSelect component so the
            * "(optional)" label, picker UI, and clear affordance all
            * stay identical. The clear-X inside SearchSelect replaces
            * the prior bespoke "Selected: X | clear" line below each
            * field.
            */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1">
                Reporting Manager <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <SearchSelect
                value={reportingManager === '' ? '' : reportingManager}
                onChange={(v) => setReportingManager(v ? Number(v) : '')}
                options={adminUsers
                  .filter((u) => !editing || u.user_id !== editing.user_id)
                  .map((u) => ({
                    value: u.user_id,
                    label: u.role_name ? `${u.user_name} · ${u.role_name}` : u.user_name,
                  }))}
                placeholder="Search by name or role…"
              />
            </div>
            <div>
              <Label className="block mb-1">
                Home City <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </Label>
              <SearchSelect
                value={cityId === '' ? '' : cityId}
                onChange={(v) => setCityId(v ? Number(v) : '')}
                options={cities.map((c) => ({ value: c.city_id, label: c.city_name }))}
                placeholder="Search cities…"
              />
            </div>
          </div>

          {/* Status toggle previously lived here at the bottom of the
              form; moved to row 1 (alongside Full Name) so the
              identity-level metadata clusters together. */}

        </div>
        {/*
          * The validation error lives in the FOOTER, beside the button that
          * triggers it — NOT at the end of the form body where it used to be.
          *
          * The body scrolls and the footer is sticky, so a message rendered at
          * the bottom of the body was below the fold: clicking "Add User" with
          * an empty Role set the error, the submit correctly aborted, and the
          * operator saw NOTHING happen. That reads as a dead button, which is
          * exactly how it was reported. An error the user cannot see is the
          * same as no validation at all.
          *
          * `flex-1 text-left` claims the space DialogFooter would otherwise
          * leave empty on the left, so the buttons stay where they were.
          */}
        <DialogFooter>
          {error && (
            <div className="flex-1 text-left text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4 shrink-0" /> {error}
            </div>
          )}
          <Button variant="outline" onClick={cancelWithConfirm} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Small helper that pairs a `SearchMultiSelect` picker with a row of
 * removable chips below it. Used for the 4 scope fields (Cities,
 * Clients, States, Verticals) inside the User modal — keeps each field
 * compact (one trigger + a wrap of chips) instead of four duplicated
 * search-list-chips blocks.
 *
 * The chip color is a theme prop so each scope keeps its identity
 * (blue cities, emerald clients, violet states, amber verticals).
 */
type ChipColor = 'blue' | 'emerald' | 'violet' | 'amber';
const CHIP_CLASSES: Record<ChipColor, { bg: string; text: string; closeHover: string }> = {
  blue:    { bg: 'bg-blue-50',    text: 'text-blue-700',    closeHover: 'hover:text-blue-900' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', closeHover: 'hover:text-emerald-900' },
  violet:  { bg: 'bg-violet-50',  text: 'text-violet-700',  closeHover: 'hover:text-violet-900' },
  amber:   { bg: 'bg-amber-50',   text: 'text-amber-700',   closeHover: 'hover:text-amber-900' },
};

function ScopeMultiSelect<V extends string | number>({
  label,
  chipColor,
  selected,
  onChange,
  options,
  chipFor,
  onRemoveOne,
  placeholder,
  selectedLabel,
  helperText,
  allOn,
  onAllChange,
  disableAll,
}: {
  label: string;
  chipColor: ChipColor;
  /*
   * Selected value set. Generic over `V extends string | number` so the same
   * picker drives both the numeric-id scopes (cities / clients / states /
   * verticals) and the string-keyed Job Stage Access field (STAGE_KEYS).
   */
  selected: Set<V>;
  onChange: (next: Array<string | number>) => void;
  options: SearchOption[];
  chipFor: (id: V) => string | undefined;
  onRemoveOne: (id: V) => void;
  placeholder: string;
  selectedLabel: string;
  /*
   * Optional muted hint rendered between the trigger and the chips.
   * Used by cascaded pickers (Clients depends on Verticals, Cities
   * depends on States) to explain why the option list is empty.
   */
  helperText?: string;
  /*
   * Optional "All" toggle. When ON, the multi-select is disabled and
   * the parent persists '0' as the CSV (legacy "manage_*='0'" sentinel,
   * see lib/scope.js). Caller controls the boolean — keeps the picker
   * stateless so a single source of truth (the form state) governs
   * what gets saved.
   *
   * `disableAll` mutes the All checkbox itself — used by dependent
   * pickers (Clients gated by Verticals, Cities gated by States) so
   * operators can't store child=0 under an empty parent scope.
   */
  allOn?: boolean;
  onAllChange?: (b: boolean) => void;
  disableAll?: boolean;
}) {
  const cls = CHIP_CLASSES[chipColor];
  return (
    <div>
      <label className="text-sm font-medium flex items-center justify-between mb-1">
        <span>
          {label}{' '}
          <span className="text-xs text-muted-foreground font-normal">
            ({allOn ? 'All' : `${selected.size} selected`})
          </span>
        </span>
        {onAllChange && (
          <label className={`inline-flex items-center gap-1.5 text-xs font-normal cursor-pointer ${disableAll ? 'opacity-50 cursor-not-allowed' : 'text-muted-foreground'}`}>
            <input
              type="checkbox"
              checked={!!allOn}
              onChange={(e) => onAllChange(e.target.checked)}
              disabled={!!disableAll}
            />
            All
          </label>
        )}
      </label>
      <SearchMultiSelect
        value={allOn ? [] : Array.from(selected)}
        onChange={onChange}
        options={options}
        placeholder={allOn ? 'All — every active record' : placeholder}
        selectedLabel={selectedLabel}
        disabled={!!allOn}
      />
      {helperText && (
        <p className="text-xs text-muted-foreground mt-1">{helperText}</p>
      )}
      {!allOn && selected.size > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Array.from(selected).map((id) => {
            const name = chipFor(id);
            if (!name) return null;
            return (
              <span
                key={id}
                className={`text-xs rounded px-1.5 py-0.5 ${cls.bg} ${cls.text}`}
              >
                {name}
                <button
                  type="button"
                  className={`ml-1 opacity-60 ${cls.closeHover}`}
                  onClick={() => onRemoveOne(id)}
                  aria-label={`Remove ${name}`}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}


