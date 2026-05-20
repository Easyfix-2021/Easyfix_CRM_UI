'use client';

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Upload, Download, Layers } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { api, ApiError } from '@/lib/api';

/*
 * BulkUpdateUsersDialog — Manage Users top-right "Bulk Update Users"
 * button opens this. Two tabs:
 *
 *   1. Select & Apply — multi-pick users from a checkbox table, pick
 *      the same scope fields (Verticals / Clients / States / Cities /
 *      Reporting Head / Home City) and apply to all selected users.
 *
 *   2. Upload File — download a template (optionally pre-filled with
 *      the currently-selected users), upload the filled .xlsx/.csv,
 *      see per-row report.
 *
 * Key rules:
 *   - "All" sentinel stored as '0' in the manage_* CSV columns.
 *   - Cascading filter: any change to Manage Verticals refreshes the
 *     Manage Clients dropdown to only clients in the picked verticals.
 *     Operator MUST pick (or "All") clients before submit can fire.
 *
 * The BE endpoints are at:
 *   GET  /api/admin/users/bulk-lookups
 *   GET  /api/admin/users/bulk-upload-template?userIds=…
 *   POST /api/admin/users/bulk-upload
 *   POST /api/admin/users/bulk-update
 */

type Lookups = {
  verticals: Array<{ id: number; name: string }>;
  clients:   Array<{ id: number; name: string; verticalIds: number[] }>;
  states:    Array<{ id: number; name: string }>;
  cities:    Array<{ id: number; name: string; stateId?: number | null }>;
  users:     Array<{ id: number; name: string; official_email?: string | null; role_name?: string | null }>;
  // Admin-group roles only — the BE filters via ROLE_ID_TO_GROUP so we
  // never surface Default User / Technician / Client roles in this picker.
  roles:     Array<{ id: number; name: string }>;
};

type UserRow = {
  user_id: number;
  user_name: string;
  official_email?: string | null;
  role_name?: string | null;
};

type UploadReport = {
  summary: {
    updated: number;
    // `unchanged` is the count of rows whose supplied values already
    // matched the persisted user — the BE diffs per column and skips
    // the UPDATE entirely. Lets the operator see "I re-uploaded an
    // unchanged sheet and nothing was touched" at a glance.
    unchanged?: number;
    failed: number;
    skipCount: number;
    dryRun: boolean;
  };
  results: Array<{ rowNumber: number; userId?: number; status: string; errors?: string[]; reason?: string }>;
};

const ALL_TOKEN = '0';

export function BulkUpdateUsersDialog({
  open, onClose, onApplied,
}: {
  open: boolean;
  onClose: () => void;
  // Note: `allUsers` is intentionally NOT a prop anymore. Both tabs
  // source their user list from `lookups.users` (full active set, up
  // to 1000) so the bulk modal isn't constrained by whatever page-size
  // the parent list happens to be using.
  onApplied: () => void;
}) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [tab, setTab] = useState<'apply' | 'upload'>('apply');

  // Load the master lists once when the dialog opens. Re-uses the new
  // /admin/users/bulk-lookups endpoint that consolidates verticals,
  // clients (with vertical FK), states, cities, and active users.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLookupsLoading(true);
    api.get<Lookups>('/admin/users/bulk-lookups')
      .then((d) => { if (!cancelled) setLookups(d); })
      .catch(() => { if (!cancelled) setLookups(null); })
      .finally(() => { if (!cancelled) setLookupsLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-3.5 !mb-0">
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-sky-300" /> Bulk Update Users
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'apply' | 'upload')}>
            <TabsList>
              <TabsTrigger value="apply">Select Users &amp; Apply</TabsTrigger>
              <TabsTrigger value="upload">Upload File</TabsTrigger>
            </TabsList>

            <TabsContent value="apply" className="pt-3">
              <ApplyTab
                lookups={lookups}
                lookupsLoading={lookupsLoading}
                onDone={() => { onApplied(); onClose(); }}
              />
            </TabsContent>

            <TabsContent value="upload" className="pt-3">
              <UploadTab
                lookups={lookups}
                lookupsLoading={lookupsLoading}
                onDone={onApplied}
              />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Select Users & Apply tab
// ──────────────────────────────────────────────────────────────────────
function ApplyTab({
  lookups, lookupsLoading, onDone,
}: {
  lookups: Lookups | null;
  lookupsLoading: boolean;
  onDone: () => void;
}) {
  // User list is sourced from lookups.users (full active set) — NOT
  // from the parent's paged items, which would expose only the visible
  // page (10 rows by default) and force ops to paginate just to find
  // a user.
  const allUsers: UserRow[] = useMemo(
    () => (lookups?.users || []).map((u) => ({
      user_id: u.id, user_name: u.name,
      official_email: u.official_email ?? null,
      role_name: u.role_name ?? null,
    })),
    [lookups],
  );
  const [pickedUserIds, setPickedUserIds] = useState<number[]>([]);
  const [userFilter, setUserFilter] = useState('');

  // Field values to apply. CSV strings for the multi-select columns
  // mirror the DB storage shape; '0' = All sentinel. The "All" toggles
  // are independent booleans that, when ON, blank the CSV input and
  // store '0' on submit.
  const [verticals, setVerticals] = useState<string>('');
  const [clients,   setClients]   = useState<string>('');
  const [states,    setStates]    = useState<string>('');
  const [cities,    setCities]    = useState<string>('');
  const [verticalsAll, setVerticalsAll] = useState(false);
  const [clientsAll,   setClientsAll]   = useState(false);
  const [statesAll,    setStatesAll]    = useState(false);
  const [citiesAll,    setCitiesAll]    = useState(false);
  // Whether the operator touched verticals at all — gates the cascading
  // "client mandatory" rule. We compute "touched" rather than always
  // requiring clients so the operator can edit ONLY Reporting Head /
  // Home City without being forced to pick clients too.
  const verticalsTouched = verticals !== '' || verticalsAll;
  const clientsTouched   = clients   !== '' || clientsAll;

  const [role,          setRole]          = useState<string>('');
  const [reportingHead, setReportingHead] = useState<string>('');
  const [homeCity,      setHomeCity]      = useState<string>('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtered user list for the picker (free-text by name / email).
  const filteredUsers = useMemo(() => {
    const q = userFilter.trim().toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter((u) =>
      String(u.user_name || '').toLowerCase().includes(q)
      || String(u.official_email || '').toLowerCase().includes(q),
    );
  }, [allUsers, userFilter]);

  // Cascading filter: clients narrowed to those in the picked verticals.
  // When verticalsAll OR no verticals picked, show the full client list
  // (matches the rule "show all clients until 'All' or no vertical is
  // selected; once Vertical is selected, show clients for only selected
  // verticals").
  const clientOptions = useMemo(() => {
    if (!lookups) return [];
    if (verticalsAll || !verticals) {
      return lookups.clients.map((c) => ({ value: String(c.id), label: c.name }));
    }
    const picked = new Set(verticals.split(',').map((s) => Number(s.trim())).filter(Boolean));
    return lookups.clients
      .filter((c) => c.verticalIds.some((v) => picked.has(v)))
      .map((c) => ({ value: String(c.id), label: c.name }));
  }, [lookups, verticals, verticalsAll]);

  // Same cascading rule for cities, parented by states. `tbl_city`
  // carries a single state_id FK (returned as `stateId` on the
  // lookups payload).
  const cityOptions = useMemo(() => {
    if (!lookups) return [];
    if (statesAll || !states) {
      return lookups.cities.map((c) => ({ value: String(c.id), label: c.name }));
    }
    const picked = new Set(states.split(',').map((s) => Number(s.trim())).filter(Boolean));
    return lookups.cities
      .filter((c) => c.stateId != null && picked.has(c.stateId))
      .map((c) => ({ value: String(c.id), label: c.name }));
  }, [lookups, states, statesAll]);

  // When verticals change, prune any picked clients no longer in scope.
  // Also reset clientsAll if we'd otherwise be applying it under the
  // wrong vertical set (the operator must re-affirm "All" against the
  // new vertical scope per the legacy "mandatory client repick" rule).
  useEffect(() => {
    setClients((prev) => {
      if (!prev) return prev;
      const allowed = new Set(clientOptions.map((o) => o.value));
      const kept = prev.split(',').filter((id) => allowed.has(id.trim()));
      return kept.join(',');
    });
    setClientsAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verticals, verticalsAll]);

  function toggleUser(id: number, checked: boolean) {
    setPickedUserIds((cur) => checked ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id));
  }
  function toggleAllFiltered(checked: boolean) {
    if (!checked) { setPickedUserIds([]); return; }
    setPickedUserIds(Array.from(new Set(filteredUsers.map((u) => u.user_id))));
  }

  async function applyToSelected() {
    setError(null);
    if (pickedUserIds.length === 0) {
      setError('Pick at least one user.');
      return;
    }
    // Vertical-touched → client-mandatory rule. Matches the BE 400.
    if (verticalsTouched && !clientsTouched) {
      setError('You changed Manage Verticals — please also pick clients (or toggle All).');
      return;
    }

    const fields: Record<string, unknown> = {};
    if (verticalsAll) fields.manage_verticals = ALL_TOKEN;
    else if (verticals) fields.manage_verticals = verticals;
    if (clientsAll) fields.manage_clients = ALL_TOKEN;
    else if (clients) fields.manage_clients = clients;
    if (statesAll) fields.manage_states = ALL_TOKEN;
    else if (states) fields.manage_states = states;
    if (citiesAll) fields.manage_cities = ALL_TOKEN;
    else if (cities) fields.manage_cities = cities;
    if (role)          fields.user_role        = Number(role);
    if (reportingHead) fields.reporting_manager = Number(reportingHead);
    if (homeCity)      fields.city_id          = Number(homeCity);

    if (Object.keys(fields).length === 0) {
      setError('Pick at least one field to apply.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/admin/users/bulk-update', {
        userIds: pickedUserIds,
        fields,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bulk update failed');
    } finally { setSubmitting(false); }
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* LEFT — user picker.
          `min-w-0` lets the flex/grid child shrink below the table's
          intrinsic content width so the email column can truncate
          cleanly instead of forcing horizontal scroll. The checkbox
          column is sticky-left as a defensive fallback for narrow
          viewports. */}
      <div className="border rounded-md flex flex-col h-[60vh] min-w-0">
        <div className="p-3 border-b">
          <Input
            placeholder="Filter users by name or email…"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
          />
          <div className="text-xs text-muted-foreground mt-2 flex items-center gap-2">
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={filteredUsers.length > 0 && filteredUsers.every((u) => pickedUserIds.includes(u.user_id))}
                onChange={(e) => toggleAllFiltered(e.target.checked)}
              />
              Select All
            </label>
            <span>·</span>
            <span><strong>{pickedUserIds.length}</strong> selected</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto min-w-0">
          {/* table-fixed + colgroup pins column widths so the email
              cell truncates rather than stretching the table past the
              container's width. */}
          <table className="data-table table-fixed w-full">
            <colgroup>
              <col style={{ width: '32px' }} />
              <col style={{ width: '34%' }} />
              <col style={{ width: '42%' }} />
              <col style={{ width: '24%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="stick-col-head stick-left"></th>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.user_id}>
                  <td className="stick-col stick-left">
                    <input
                      type="checkbox"
                      checked={pickedUserIds.includes(u.user_id)}
                      onChange={(e) => toggleUser(u.user_id, e.target.checked)}
                    />
                  </td>
                  <td className="truncate" title={u.user_name}>{u.user_name}</td>
                  <td className="text-xs text-muted-foreground truncate" title={u.official_email ?? ''}>{u.official_email || '—'}</td>
                  <td className="text-xs truncate" title={u.role_name || ''}>{u.role_name || '—'}</td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr><td colSpan={4} className="text-center py-8 text-xs text-muted-foreground">No matching users.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* RIGHT — field pickers. Tighter vertical rhythm (space-y-2 +
          compact Label margin in MultiWithAllToggle) so all six rows
          (4 multi-selects + Reporting Head + Home City) fit alongside
          the 60vh user list without internal scrolling. */}
      <div className="space-y-2 min-w-0">
        {lookupsLoading && <div className="text-sm text-muted-foreground">Loading lookups…</div>}
        {!lookupsLoading && !lookups && <div className="text-sm text-destructive">Lookups failed to load.</div>}
        {lookups && (
          <>
            <MultiWithAllToggle
              label="Manage Verticals"
              value={verticals}
              onChange={setVerticals}
              allOn={verticalsAll}
              onAllChange={setVerticalsAll}
              options={lookups.verticals.map((v) => ({ value: String(v.id), label: v.name }))}
            />
            <MultiWithAllToggle
              label="Manage Clients"
              value={clients}
              onChange={setClients}
              allOn={clientsAll}
              onAllChange={setClientsAll}
              options={clientOptions}
              // Clients-All is gated by Verticals: disabled until the
              // operator has either picked a vertical OR toggled
              // Verticals-All. Prevents the operator from setting
              // "Manage Clients = All" with an empty vertical scope.
              disableAll={!verticalsAll && !verticals}
              hint={
                verticalsTouched && !clientsTouched
                  ? <span className="text-amber-700">Required — you changed Verticals.</span>
                  : verticalsAll || !verticals
                    ? 'Showing all active clients.'
                    : `Filtered to ${clientOptions.length} client(s) in the picked verticals.`
              }
            />
            <MultiWithAllToggle
              label="Manage States"
              value={states}
              onChange={setStates}
              allOn={statesAll}
              onAllChange={setStatesAll}
              options={lookups.states.map((s) => ({ value: String(s.id), label: s.name }))}
            />
            <MultiWithAllToggle
              label="Manage Cities"
              value={cities}
              onChange={setCities}
              allOn={citiesAll}
              onAllChange={setCitiesAll}
              options={cityOptions}
              // Cities-All is gated by States: disabled until the
              // operator has either picked a state OR toggled States-
              // All. Mirrors the Clients ← Verticals rule.
              disableAll={!statesAll && !states}
              hint={
                statesAll || !states
                  ? 'Showing all active cities.'
                  : `Filtered to ${cityOptions.length} city(s) in the picked states.`
              }
            />
            {/* Role — single-pick from admin-group roles only. The BE
                rejects non-admin roles with a 400 from updateUser, so
                we only ever offer values the backend will accept. */}
            <div>
              <Label className="!mb-0.5 text-xs">Role</Label>
              <SearchSelect
                value={role}
                onChange={setRole}
                placeholder="— No change —"
                options={lookups.roles.map((r) => ({ value: String(r.id), label: r.name }))}
              />
            </div>
            <div>
              <Label className="!mb-0.5 text-xs">Reporting Head</Label>
              <SearchSelect
                value={reportingHead}
                onChange={setReportingHead}
                placeholder="— No change —"
                options={lookups.users.map((u) => ({ value: String(u.id), label: u.name }))}
              />
            </div>
            <div>
              <Label className="!mb-0.5 text-xs">Home City</Label>
              <SearchSelect
                value={homeCity}
                onChange={setHomeCity}
                placeholder="— No change —"
                options={lookups.cities.map((c) => ({ value: String(c.id), label: c.name }))}
              />
            </div>
          </>
        )}

        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={applyToSelected} disabled={submitting}>
            {submitting ? 'Applying…' : `Apply to ${pickedUserIds.length} user(s)`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// MultiWithAllToggle — a SearchMultiSelect + an "All" checkbox.
// "All" disables the multi-select and stores '0' for that column.
// ──────────────────────────────────────────────────────────────────────
function MultiWithAllToggle({
  label, value, onChange, allOn, onAllChange, options, hint, disableAll,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allOn: boolean;
  onAllChange: (b: boolean) => void;
  options: Array<{ value: string; label: string }>;
  hint?: React.ReactNode;
  // When true, the All checkbox is disabled (and visually muted). Used
  // by dependent pickers: Clients-All is locked until a Vertical (or
  // Verticals-All) is picked; same for Cities ← States. Prevents
  // setting child=All under an empty parent scope.
  disableAll?: boolean;
}) {
  return (
    <div>
      <Label className="flex items-center justify-between !mb-0.5 text-xs">
        <span>{label}</span>
        <label className={`inline-flex items-center gap-1.5 text-xs font-normal cursor-pointer ${disableAll ? 'opacity-50 cursor-not-allowed' : 'text-muted-foreground'}`}>
          <input
            type="checkbox"
            checked={allOn}
            onChange={(e) => onAllChange(e.target.checked)}
            disabled={!!disableAll}
          />
          All
        </label>
      </Label>
      {/* SearchMultiSelect takes an array; we serialise the picked
          values to a CSV string on the way OUT so the BE column shape
          (manage_clients='5,10,12') is preserved. When "All" is on,
          we pass an empty array AND disable the control. */}
      <SearchMultiSelect
        value={allOn ? [] : (value ? value.split(',').filter(Boolean) : [])}
        onChange={(next) => onChange(next.map((v) => String(v)).join(','))}
        disabled={allOn}
        placeholder={allOn ? 'All — every active record' : '— No change —'}
        options={options}
      />
      {hint && <div className="text-[11px] mt-1">{hint}</div>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Upload File tab
// ──────────────────────────────────────────────────────────────────────
function UploadTab({
  lookups, lookupsLoading, onDone,
}: {
  lookups: Lookups | null;
  lookupsLoading: boolean;
  onDone: () => void;
}) {
  // Same full-user-list rule as ApplyTab — pulls from lookups.users.
  const allUsers: UserRow[] = useMemo(
    () => (lookups?.users || []).map((u) => ({
      user_id: u.id, user_name: u.name,
      official_email: u.official_email ?? null,
      role_name: u.role_name ?? null,
    })),
    [lookups],
  );
  void lookupsLoading;
  const [pickedIds, setPickedIds] = useState<number[]>([]);
  const [filter, setFilter] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter((u) => String(u.user_name || '').toLowerCase().includes(q));
  }, [allUsers, filter]);

  async function downloadTemplate() {
    const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
    const base = (process.env.NEXT_PUBLIC_API_URL || '/api') + '/admin/users/bulk-upload-template';
    const url = pickedIds.length ? `${base}?userIds=${pickedIds.join(',')}` : base;
    const res = await fetch(url, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { setError(`Template download failed: HTTP ${res.status}`); return; }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = 'easyfix-users-bulk-update-template.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(objUrl);
  }

  async function submit() {
    setError(null); setReport(null);
    const file = inputRef.current?.files?.[0];
    if (!file) { setError('Pick an .xlsx or .csv file.'); return; }
    const fd = new FormData(); fd.set('file', file);
    setLoading(true);
    try {
      const r = await api.post<UploadReport>(`/admin/users/bulk-upload?dryRun=${dryRun}`, fd);
      setReport(r);
      if (!dryRun && r.summary.updated > 0) onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally { setLoading(false); }
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* LEFT — pick which users to pre-populate the template with.
          Same table shape as the Apply tab (Name, Email, Role with
          fixed widths + sticky checkbox) so the two surfaces feel
          interchangeable. */}
      <div className="border rounded-md flex flex-col h-[60vh] min-w-0">
        <div className="p-3 border-b">
          <div className="text-sm font-medium mb-2">1. (Optional) Pick users to pre-populate the template</div>
          <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="text-xs text-muted-foreground mt-2 flex items-center gap-2">
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={filtered.length > 0 && filtered.every((u) => pickedIds.includes(u.user_id))}
                onChange={(e) => {
                  const visible = filtered.map((u) => u.user_id);
                  setPickedIds((cur) => e.target.checked
                    ? Array.from(new Set([...cur, ...visible]))
                    : cur.filter((x) => !visible.includes(x)));
                }}
              />
              Select All
            </label>
            <span>·</span>
            <span>{pickedIds.length} of {filtered.length} selected · Empty = blank template.</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto min-w-0">
          <table className="data-table table-fixed w-full">
            <colgroup>
              <col style={{ width: '32px' }} />
              <col style={{ width: '34%' }} />
              <col style={{ width: '42%' }} />
              <col style={{ width: '24%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="stick-col-head stick-left"></th>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.user_id}>
                  <td className="stick-col stick-left">
                    <input
                      type="checkbox"
                      checked={pickedIds.includes(u.user_id)}
                      onChange={(e) => setPickedIds((cur) => e.target.checked ? [...cur, u.user_id] : cur.filter((x) => x !== u.user_id))}
                    />
                  </td>
                  <td className="truncate" title={u.user_name}>{u.user_name}</td>
                  <td className="text-xs text-muted-foreground truncate" title={u.official_email ?? ''}>{u.official_email || '—'}</td>
                  <td className="text-xs truncate" title={u.role_name || ''}>{u.role_name || '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="text-center py-8 text-xs text-muted-foreground">No matching users.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="p-3 border-t">
          <Button variant="outline" onClick={downloadTemplate} className="w-full">
            <Download className="size-4 mr-1" />
            Download Template ({pickedIds.length ? `${pickedIds.length} ${pickedIds.length === 1 ? 'User' : 'Users'}` : 'Blank'})
          </Button>
        </div>
      </div>

      {/* RIGHT — upload + report */}
      <div className="space-y-3">
        <div className="text-sm font-medium">2. Upload the filled file</div>
        <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="block text-sm" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>Dry Run (validation only)</span>
        </label>
        <Button onClick={submit} disabled={loading}>
          <Upload className="size-4 mr-1" /> {loading ? 'Processing…' : (dryRun ? 'Validate' : 'Upload & Apply')}
        </Button>
        {error && <div className="text-sm text-destructive">{error}</div>}
        {report && (
          <div className="border rounded-md p-3 text-sm">
            <div className="font-medium mb-2">
              {report.summary.dryRun ? 'Dry Run Report' : 'Upload Complete'}
              {' · '}
              <span className="text-emerald-700">{report.summary.updated} Updated</span>
              {' · '}
              <span className="text-sky-700">{report.summary.unchanged ?? 0} Unchanged</span>
              {' · '}
              <span className="text-red-700">{report.summary.failed} Failed</span>
              {' · '}
              <span className="text-muted-foreground">{report.summary.skipCount} Skipped</span>
            </div>
            <div className="max-h-[40vh] overflow-y-auto">
              <table className="data-table">
                <thead><tr><th>Row</th><th>User ID</th><th>Status</th><th>Details</th></tr></thead>
                <tbody>
                  {report.results.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.userId ?? '—'}</td>
                      {/* Backend emits stable lowercase tokens (valid /
                          updated / failed / skipped) for API consumers;
                          we Title Case at render time so the API
                          contract stays stable while the UI follows the
                          EasyFix label-casing rule. */}
                      <td>{r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '—'}</td>
                      <td className="text-xs">{r.errors?.join('; ') || r.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
