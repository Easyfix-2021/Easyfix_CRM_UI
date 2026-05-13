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
import {
  UserCog, Users, Search, Plus, Pencil, Trash2,
  AlertTriangle, ChevronDown, ChevronRight, Info,
  ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

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
};

type ListResponse = { items: User[]; total: number };

// Must mirror SORTABLE_COLUMNS in services/user.service.js.
type SortKey =
  | 'user_id' | 'user_name' | 'official_email' | 'mobile_no'
  | 'role_name' | 'city_name' | 'user_status' | 'insert_date';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageUsersPage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  const { me } = useMe();
  // Permission gating mirrors legacy CRM Constants.actionPermissions:
  //   - isUserEdit  : controls the Edit + Deactivate buttons on each row.
  //                   Legacy doesn't have a separate "isUserAddNew" — the
  //                   Add User button is open to any admin-role user, and
  //                   we keep that behaviour. If ops wants finer control,
  //                   add a new menu_action row with action_name=isUserAddNew
  //                   and re-gate the Add button here.
  const can = actionFlags(me, ['isUserEdit']);

  // ID → Name map for expanding manage_cities CSV in the list. Built from
  // the lookup cache (already loaded by useLookup). The legacy list shows
  // "Manage City" as a comma-joined list of city names — we mirror that
  // exactly here. (Manage Clients is form-only in legacy; not shown in
  // the list, so no clientNameById map is needed.)
  const cityNameById = useMemo(
    () => new Map(lookup.cities.map((c) => [c.city_id, c.city_name])),
    [lookup.cities]
  );

  const [items, setItems] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<number | ''>('');
  const [cityFilter, setCityFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<User | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const [sortBy,  setSortBy]  = useState<SortKey>('user_name');
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
    return localStorage.getItem('users-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('users-help-collapsed', howOpen ? '0' : '1');
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
  }, [search, roleFilter, cityFilter, includeInactive]);

  useEffect(() => { void fetchList(); /* eslint-disable-next-line */ }, [page, sortBy, sortDir]);

  async function fetchList() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (roleFilter)    params.set('roleId', String(roleFilter));
      if (cityFilter)    params.set('cityId', String(cityFilter));
      if (includeInactive) params.set('includeInactive', 'true');
      params.set('limit',  String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      const data = await api.get<ListResponse>(`/admin/users?${params}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

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
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="size-4 mr-1" /> Add User
          </Button>
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

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
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
            <SearchSelect
              value={cityFilter === '' ? '' : cityFilter}
              onChange={(v) => setCityFilter(v ? Number(v) : '')}
              options={lookup.cities.map((c) => ({ value: c.city_id, label: c.city_name }))}
              placeholder="All cities"
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
              <col style={{ width: '6%'  }} /> {/* User ID */}
              <col style={{ width: '16%' }} /> {/* Name */}
              <col style={{ width: '18%' }} /> {/* Email */}
              <col style={{ width: '10%' }} /> {/* Mobile */}
              <col style={{ width: '13%' }} /> {/* Role */}
              <col style={{ width: '20%' }} /> {/* Manage Cities */}
              <col style={{ width: '8%'  }} /> {/* Status */}
              <col style={{ width: '9%'  }} /> {/* Actions */}
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="user_id"        align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>User ID</SortHeader>
                <SortHeader col="user_name"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Name</SortHeader>
                <SortHeader col="official_email" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Email</SortHeader>
                <SortHeader col="mobile_no"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Mobile</SortHeader>
                <SortHeader col="role_name"      align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Role</SortHeader>
                {/*
                  * "Manage Cities" = expanded names from tbl_user.manage_cities CSV.
                  * Legacy CRM list shows this as a comma-joined string of city
                  * names; we mirror that. Not sortable because the underlying
                  * column is a CSV — sorting it would order rows by the raw
                  * "1,5,12" string, which is meaningless to operators.
                  */}
                <th className="!text-left whitespace-nowrap" title="Cities this user is allowed to manage (tbl_user.manage_cities)">Manage Cities</th>
                <SortHeader col="user_status"    align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No users match the current filters.</td></tr>
              )}
              {!loading && items.map((u) => (
                <tr key={u.user_id}>
                  <td className="!text-center font-mono text-xs truncate">{u.user_id}</td>
                  <td className="!text-left font-medium truncate" title={u.user_name}>{u.user_name}</td>
                  <td className="!text-left truncate" title={u.official_email}>{u.official_email}</td>
                  <td className="!text-left font-mono text-xs truncate" title={u.mobile_no}>{u.mobile_no}</td>
                  <td className="!text-left truncate" title={u.role_name ?? ''}>
                    {u.role_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left truncate">
                    <ManageCitiesCell csv={u.manage_cities} nameById={cityNameById} />
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {u.user_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isUserEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(u); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isUserEdit && u.user_status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(u)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
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
        onSaved={() => { setModalOpen(false); void fetchList(); }}
      />
    </div>
  );
}

// ─── Manage-Cities / Manage-Clients cell ─────────────────────────────
/*
 * Expands a CSV string of IDs to a comma-joined list of names. Truncates
 * gracefully with a "+N more" suffix when the row has many entries; the
 * full list is exposed in the title tooltip so operators can still read
 * everything without scrolling the cell.
 *
 * Used by the list table to show manage_cities and (potentially) manage_clients
 * as legacy-equivalent comma-separated displays. Returns "—" placeholder when
 * the CSV is empty or null.
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

function ManageCitiesCell({ csv, nameById }: { csv: string | null | undefined; nameById: Map<number, string> }) {
  const names = expandCsvToNames(csv, nameById);
  if (names.length === 0) return <span className="text-muted-foreground">—</span>;
  // Show first 2 + "+N more" — keeps the column readable even for users
  // who manage many cities. Hover reveals the full list.
  const visible = names.slice(0, 2);
  const overflow = names.length - visible.length;
  return (
    <span title={names.join(', ')} className="text-xs">
      {visible.join(', ')}
      {overflow > 0 && <span className="text-muted-foreground"> +{overflow} more</span>}
    </span>
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
 * Create form: name + email + mobile + role + manage cities (multi) + manage clients (multi).
 * Edit form:   name + email shown read-only (OTP is keyed off these); everything else editable.
 *
 * Mirrors the legacy CRM addEditUser.vm exactly:
 *   - User Name        (read-only on edit)
 *   - Email            (read-only on edit)
 *   - Mobile Number    *
 *   - User Role        *
 *   - Manages Cities   (multi-select, CSV in tbl_user.manage_cities)
 *   - Manages Clients  (multi-select, CSV in tbl_user.manage_clients)
 *   - Status           (edit only)
 *
 * Legacy doesn't expose a single "home City" picker — only the Manages
 * Cities multi. We keep the home City picker as a new-app addition (used
 * by other parts of the system that key off tbl_user.city_id) but it sits
 * below the Manage Cities multi-select so the legacy-parity fields are
 * primary.
 */
function UserFormModal({
  open, onClose, editing, roles, cities, clients, states, verticals, adminUsers, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: User | null;
  roles: Array<{ role_id: number; role_name: string }>;
  cities: Array<{ city_id: number; city_name: string }>;
  clients: Array<{ client_id: number; client_name: string }>;
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
  const [roleId,  setRoleId]  = useState<number | ''>('');
  const [cityId,  setCityId]  = useState<number | ''>('');
  const [active,  setActive]  = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manages Cities + Manages Clients — Sets for O(1) toggle. Persisted as
  // CSV strings on save to match legacy `tbl_user.manage_cities` /
  // `manage_clients` storage. Hydrated from editing.manage_cities CSV by
  // parsing the comma-separated id list.
  const [manageCities,    setManageCities]    = useState<Set<number>>(new Set());
  const [manageClients,   setManageClients]   = useState<Set<number>>(new Set());
  const [manageStates,    setManageStates]    = useState<Set<number>>(new Set());
  const [manageVerticals, setManageVerticals] = useState<Set<number>>(new Set());
  const [reportingManager, setReportingManager] = useState<number | ''>('');
  const [managerQuery, setManagerQuery] = useState('');

  const [cityQuery, setCityQuery] = useState('');
  const filteredCities = useMemo(() => {
    const q = cityQuery.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => c.city_name.toLowerCase().includes(q));
  }, [cities, cityQuery]);

  const [clientQuery, setClientQuery] = useState('');
  const filteredClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.client_name.toLowerCase().includes(q));
  }, [clients, clientQuery]);

  const [manageCitiesQuery, setManageCitiesQuery] = useState('');
  const filteredManageCities = useMemo(() => {
    const q = manageCitiesQuery.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => c.city_name.toLowerCase().includes(q));
  }, [cities, manageCitiesQuery]);

  const [manageStatesQuery, setManageStatesQuery] = useState('');
  const filteredManageStates = useMemo(() => {
    const q = manageStatesQuery.trim().toLowerCase();
    if (!q) return states;
    return states.filter((s) => s.state_name.toLowerCase().includes(q));
  }, [states, manageStatesQuery]);

  const [verticalQuery, setVerticalQuery] = useState('');
  const filteredVerticals = useMemo(() => {
    const q = verticalQuery.trim().toLowerCase();
    if (!q) return verticals;
    return verticals.filter((v) => v.vertical_name.toLowerCase().includes(q));
  }, [verticals, verticalQuery]);

  // Reporting Manager — single-select searchable. Exclude the user
  // being edited (preventing direct self-loops at the UI layer; backend
  // DFS guards against indirect cycles via `visited` set).
  const filteredManagers = useMemo(() => {
    const q = managerQuery.trim().toLowerCase();
    const list = adminUsers.filter((u) => !editing || u.user_id !== editing.user_id);
    if (!q) return list.slice(0, 50);
    return list.filter((u) =>
      u.user_name.toLowerCase().includes(q) ||
      (u.role_name || '').toLowerCase().includes(q)
    ).slice(0, 50);
  }, [adminUsers, managerQuery, editing]);

  const selectedManagerName = useMemo(
    () => adminUsers.find((u) => u.user_id === reportingManager)?.user_name ?? null,
    [adminUsers, reportingManager]
  );

  const selectedCityName = useMemo(
    () => cities.find((c) => c.city_id === cityId)?.city_name ?? null,
    [cities, cityId],
  );

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
      setManageCities(csvToSet(editing?.manage_cities));
      setManageClients(csvToSet(editing?.manage_clients));
      setManageStates(csvToSet(editing?.manage_states));
      setManageVerticals(csvToSet(editing?.manage_verticals));
      setReportingManager(editing?.reporting_manager ?? '');
      setCityQuery('');
      setClientQuery('');
      setManageCitiesQuery('');
      setManageStatesQuery('');
      setVerticalQuery('');
      setManagerQuery('');
      setError(null);
    }
  }, [open, editing]);

  function toggleManageCity(id: number) {
    setManageCities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleManageClient(id: number) {
    setManageClients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleManageState(id: number) {
    setManageStates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleManageVertical(id: number) {
    setManageVerticals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /*
   * Debounced real-time mobile-uniqueness probe. Fires only when:
   *   - exactly 10 digits typed (shorter is a length warning, not a probe)
   *   - mobile differs from the user being edited (no probe for unchanged)
   * Cache hits resolve instantly; cache misses wait 450ms after the last
   * keystroke. The dropdown stays disabled during 'checking' so a fast
   * Save can't race the probe. AbortController cancels stale requests
   * when the user keeps typing.
   */
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
    }
    if (!/^[0-9]{10}$/.test(mobile)) { setError('Mobile must be 10 digits'); return; }
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

    // Serialise the Sets back to CSV — matches legacy tbl_user storage.
    // Sort by id so the persisted value is deterministic (avoids spurious
    // diffs when the operator's click order changes).
    const manageCitiesCsv    = Array.from(manageCities).sort((a, b) => a - b).join(',') || null;
    const manageClientsCsv   = Array.from(manageClients).sort((a, b) => a - b).join(',') || null;
    const manageStatesCsv    = Array.from(manageStates).sort((a, b) => a - b).join(',') || null;
    const manageVerticalsCsv = Array.from(manageVerticals).sort((a, b) => a - b).join(',') || null;

    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/users/${editing!.user_id}`, {
          mobile_no:        mobile,
          alternate_no:     altMob || null,
          user_role:        Number(roleId),
          city_id:          cityId ? Number(cityId) : null,
          manage_cities:    manageCitiesCsv,
          manage_clients:   manageClientsCsv,
          manage_states:    manageStatesCsv,
          manage_verticals: manageVerticalsCsv,
          reporting_manager: reportingManager ? Number(reportingManager) : null,
          is_active:        active,
        });
      } else {
        await api.post('/admin/users', {
          user_name:        name.trim(),
          official_email:   email.trim(),
          mobile_no:        mobile,
          alternate_no:     altMob || null,
          user_role:        Number(roleId),
          city_id:          cityId ? Number(cityId) : null,
          manage_cities:    manageCitiesCsv,
          manage_clients:   manageClientsCsv,
          manage_states:    manageStatesCsv,
          manage_verticals: manageVerticalsCsv,
          reporting_manager: reportingManager ? Number(reportingManager) : null,
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.user_name}"` : 'Add User'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <label className="text-sm font-medium block mb-1">
              Full Name * {isEdit && <span className="text-xs text-muted-foreground font-normal">(not editable)</span>}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              disabled={isEdit}
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              Official Email * {isEdit && <span className="text-xs text-muted-foreground font-normal">(not editable)</span>}
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="priya@channelplay.in"
              disabled={isEdit}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium block mb-1">Mobile *</label>
              <Input
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10-digit number"
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
              <label className="text-sm font-medium block mb-1">Alternate Mobile</label>
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

          {/* Role — shared SearchSelect (typeahead + keyboard nav).
              Same component the toolbar role filter uses, so the picker
              behaves identically across the page. */}
          <div>
            <label className="text-sm font-medium block mb-1">Role *</label>
            <SearchSelect
              value={roleId === '' ? '' : roleId}
              onChange={(v) => setRoleId(v ? Number(v) : '')}
              options={roles.map((r) => ({ value: r.role_id, label: r.role_name }))}
              placeholder="Search and select a role…"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Every active role is listed. Backend will reject combos that aren't allowed for the user's group.
            </p>
          </div>

          {/*
            * Manages Cities (multi-select) — legacy field. Persisted as a CSV
            * of city_ids in tbl_user.manage_cities. Users with role-based
            * city scoping (e.g. Zonal Field Team) need this to limit their
            * job lists to their assigned regions.
            */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">
                Manages Cities <span className="text-xs text-muted-foreground font-normal">
                  ({manageCities.size} selected)
                </span>
              </label>
              {/* Bulk-select shortcuts. Applies to the CURRENT filter:
                  "Select all" picks every city matching the search box
                  so an operator can search "Mum" and select all Mumbai
                  variants in one click. With an empty search, it picks
                  every city in the master list. */}
              <div className="text-xs flex gap-2">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setManageCities(new Set([
                    ...Array.from(manageCities),
                    ...filteredManageCities.map((c) => c.city_id),
                  ]))}
                >
                  Select {manageCitiesQuery.trim() ? 'filtered' : 'all'}
                </button>
                {manageCities.size > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-red-600 hover:underline"
                    onClick={() => setManageCities(new Set())}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <Input
              value={manageCitiesQuery}
              onChange={(e) => setManageCitiesQuery(e.target.value)}
              placeholder="Search cities to add/remove…"
              className="mb-1"
            />
            {manageCities.size > 0 && (
              <div className="text-xs text-muted-foreground mb-1 flex flex-wrap gap-1">
                {Array.from(manageCities).map((id) => {
                  const c = cities.find((x) => x.city_id === id);
                  if (!c) return null;
                  return (
                    <span key={id} className="bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
                      {c.city_name}
                      <button type="button" className="ml-1 text-blue-700/60 hover:text-blue-900" onClick={() => toggleManageCity(id)}>×</button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="border rounded bg-background max-h-36 overflow-auto" role="listbox">
              {filteredManageCities.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No cities match.</div>
              ) : filteredManageCities.map((c) => {
                const selected = manageCities.has(c.city_id);
                return (
                  <button
                    type="button"
                    key={c.city_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => toggleManageCity(c.city_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 flex items-center gap-2 ${selected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                  >
                    <input type="checkbox" readOnly checked={selected} className="pointer-events-none" />
                    <span>{c.city_name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            * Manages Clients (multi-select) — legacy field. CSV of client_ids
            * in tbl_user.manage_clients. Roles like Business Development +
            * Project Manager use this to scope their views to specific
            * clients.
            */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">
                Manages Clients <span className="text-xs text-muted-foreground font-normal">
                  ({manageClients.size} selected)
                </span>
              </label>
              <div className="text-xs flex gap-2">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setManageClients(new Set([
                    ...Array.from(manageClients),
                    ...filteredClients.map((c) => c.client_id),
                  ]))}
                >
                  Select {clientQuery.trim() ? 'filtered' : 'all'}
                </button>
                {manageClients.size > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-red-600 hover:underline"
                    onClick={() => setManageClients(new Set())}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <Input
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
              placeholder="Search clients to add/remove…"
              className="mb-1"
            />
            {manageClients.size > 0 && (
              <div className="text-xs text-muted-foreground mb-1 flex flex-wrap gap-1">
                {Array.from(manageClients).map((id) => {
                  const c = clients.find((x) => x.client_id === id);
                  if (!c) return null;
                  return (
                    <span key={id} className="bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5">
                      {c.client_name}
                      <button type="button" className="ml-1 text-emerald-700/60 hover:text-emerald-900" onClick={() => toggleManageClient(id)}>×</button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="border rounded bg-background max-h-36 overflow-auto" role="listbox">
              {filteredClients.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No clients match.</div>
              ) : filteredClients.map((c) => {
                const selected = manageClients.has(c.client_id);
                return (
                  <button
                    type="button"
                    key={c.client_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => toggleManageClient(c.client_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 flex items-center gap-2 ${selected ? 'bg-emerald-50 text-emerald-700 font-medium' : ''}`}
                  >
                    <input type="checkbox" readOnly checked={selected} className="pointer-events-none" />
                    <span>{c.client_name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            * Manages States (multi-select) — RBAC scope. CSV of state_ids in
            * tbl_user.manage_states. Filters the user's view of jobs / EFRs
            * by the state of the linked city.
            */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">
                Manages States <span className="text-xs text-muted-foreground font-normal">
                  ({manageStates.size} selected)
                </span>
              </label>
              <div className="text-xs flex gap-2">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setManageStates(new Set([
                    ...Array.from(manageStates),
                    ...filteredManageStates.map((s) => s.state_id),
                  ]))}
                >
                  Select {manageStatesQuery.trim() ? 'filtered' : 'all'}
                </button>
                {manageStates.size > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-red-600 hover:underline"
                    onClick={() => setManageStates(new Set())}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <Input
              value={manageStatesQuery}
              onChange={(e) => setManageStatesQuery(e.target.value)}
              placeholder="Search states to add/remove…"
              className="mb-1"
            />
            {manageStates.size > 0 && (
              <div className="text-xs text-muted-foreground mb-1 flex flex-wrap gap-1">
                {Array.from(manageStates).map((id) => {
                  const s = states.find((x) => x.state_id === id);
                  if (!s) return null;
                  return (
                    <span key={id} className="bg-violet-50 text-violet-700 rounded px-1.5 py-0.5">
                      {s.state_name}
                      <button type="button" className="ml-1 text-violet-700/60 hover:text-violet-900" onClick={() => toggleManageState(id)}>×</button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="border rounded bg-background max-h-36 overflow-auto" role="listbox">
              {filteredManageStates.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No states match.</div>
              ) : filteredManageStates.map((s) => {
                const selected = manageStates.has(s.state_id);
                return (
                  <button
                    type="button"
                    key={s.state_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => toggleManageState(s.state_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 flex items-center gap-2 ${selected ? 'bg-violet-50 text-violet-700 font-medium' : ''}`}
                  >
                    <input type="checkbox" readOnly checked={selected} className="pointer-events-none" />
                    <span>{s.state_name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            * Manages Verticals (multi-select) — RBAC scope. CSV of vertical_ids
            * in tbl_user.manage_verticals. Filters the user's view of jobs /
            * clients by the vertical assigned to the client (tbl_client.vertical_id).
            */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">
                Manages Verticals <span className="text-xs text-muted-foreground font-normal">
                  ({manageVerticals.size} selected)
                </span>
              </label>
              <div className="text-xs flex gap-2">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setManageVerticals(new Set([
                    ...Array.from(manageVerticals),
                    ...filteredVerticals.map((v) => v.vertical_id),
                  ]))}
                >
                  Select {verticalQuery.trim() ? 'filtered' : 'all'}
                </button>
                {manageVerticals.size > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-red-600 hover:underline"
                    onClick={() => setManageVerticals(new Set())}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <Input
              value={verticalQuery}
              onChange={(e) => setVerticalQuery(e.target.value)}
              placeholder="Search verticals to add/remove…"
              className="mb-1"
            />
            {manageVerticals.size > 0 && (
              <div className="text-xs text-muted-foreground mb-1 flex flex-wrap gap-1">
                {Array.from(manageVerticals).map((id) => {
                  const v = verticals.find((x) => x.vertical_id === id);
                  if (!v) return null;
                  return (
                    <span key={id} className="bg-amber-50 text-amber-700 rounded px-1.5 py-0.5">
                      {v.vertical_name}
                      <button type="button" className="ml-1 text-amber-700/60 hover:text-amber-900" onClick={() => toggleManageVertical(id)}>×</button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="border rounded bg-background max-h-36 overflow-auto" role="listbox">
              {filteredVerticals.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No verticals match.</div>
              ) : filteredVerticals.map((v) => {
                const selected = manageVerticals.has(v.vertical_id);
                return (
                  <button
                    type="button"
                    key={v.vertical_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => toggleManageVertical(v.vertical_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 flex items-center gap-2 ${selected ? 'bg-amber-50 text-amber-700 font-medium' : ''}`}
                  >
                    <input type="checkbox" readOnly checked={selected} className="pointer-events-none" />
                    <span>{v.vertical_name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            * Reporting Manager — single-select. Drives the hierarchy DFS
            * for scope-union: on login, the user's own scope is merged
            * with every direct/indirect report's manage_* fields so a
            * manager sees their team's data. Self-assignment is blocked
            * at the UI layer; the backend also catches transitive cycles.
            */}
          <div>
            <label className="text-sm font-medium block mb-1">
              Reporting Manager <span className="text-xs text-muted-foreground font-normal">(optional)</span>
            </label>
            {selectedManagerName && (
              <div className="text-xs text-muted-foreground mb-1">
                Selected: <span className="font-medium text-foreground">{selectedManagerName}</span>
                {' '}<button type="button" className="text-blue-700 underline ml-1" onClick={() => setReportingManager('')}>clear</button>
              </div>
            )}
            <Input
              value={managerQuery}
              onChange={(e) => setManagerQuery(e.target.value)}
              placeholder="Search by name or role…"
              className="mb-1"
            />
            <div className="border rounded bg-background max-h-36 overflow-auto" role="listbox">
              {filteredManagers.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No matching admins.</div>
              ) : filteredManagers.map((u) => {
                const selected = reportingManager === u.user_id;
                return (
                  <button
                    type="button"
                    key={u.user_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => { setReportingManager(u.user_id); setManagerQuery(''); }}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 flex items-center justify-between gap-2 ${selected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                  >
                    <span>{u.user_name}</span>
                    {u.role_name && <span className="text-xs text-muted-foreground">{u.role_name}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            * Home City (single) — new-app addition. Not in legacy form but
            * tbl_user.city_id has been a real column for years; other parts
            * of the system key off it. Optional, sits below the Manages
            * fields so legacy-parity inputs stay primary.
            */}
          <div>
            <label className="text-sm font-medium block mb-1">Home City (optional)</label>
            <Input
              value={cityQuery}
              onChange={(e) => setCityQuery(e.target.value)}
              placeholder="Search cities…"
              className="mb-1"
            />
            {selectedCityName && (
              <div className="text-xs text-muted-foreground mb-1">
                Selected: <span className="font-medium text-foreground">{selectedCityName}</span>
                {' '}<button type="button" className="text-blue-700 underline ml-1" onClick={() => setCityId('')}>clear</button>
              </div>
            )}
            <div className="border rounded bg-background max-h-32 overflow-auto" role="listbox">
              {filteredCities.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No cities match.</div>
              ) : filteredCities.map((c) => {
                const selected = c.city_id === cityId;
                return (
                  <button
                    type="button"
                    key={c.city_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => setCityId(c.city_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 ${selected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                  >
                    {c.city_name}
                  </button>
                );
              })}
            </div>
          </div>

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Active</span>
            </label>
          )}

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add User'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}


