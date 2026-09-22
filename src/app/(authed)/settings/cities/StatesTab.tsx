'use client';

/*
 * Manage Cities › States tab — the state master and its zonal manager.
 *
 * THE RULE (2026-09-21): one zonal manager per state, one manager may hold many
 * states. The manager is set HERE and the backend copies it onto every city of
 * the state in the same transaction (services/state.service.js). New cities,
 * cities moved to another state and approved pending cities take their state's
 * manager automatically — nothing to set per city.
 *
 * THE FLOW this tab is built around: pick the CURRENT manager → tick some or
 * all of their states → pick the NEW manager → Save and apply. That is the
 * "a zonal manager left" case in three clicks. Ticks survive changing the
 * manager filter, so Assam (Joydeep) and Uttar Pradesh (Sneha) can go in one
 * move; the chips in the blue bar show every ticked state, including ones the
 * current filter hides.
 *
 * Wire contract (EasyFix_Backend routes/admin/states.js):
 *   GET   /admin/states                          → { items, total, manager_columns }
 *   POST  /admin/states                          { state_name, state_code?, state_user }
 *   PATCH /admin/states/:id                      { state_name?, state_code?, state_user? }
 *   POST  /admin/states/assign-manager           { state_ids[], state_user }
 *   POST  /admin/states/:id/resync               → cities realigned to the state's manager
 * Every write needs isStateEdit.
 *
 * ALL states load at once (~36 rows, PAN India): filtering, counting and a
 * selection that spans filters are all client-side. The list is not paged.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, RefreshCw, Search, UserX, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { IconButton } from '@/components/ui/icon-button';
import { CancelButton } from '@/components/ui/cancel-button';
import { SearchSelect } from '@/components/ui/search-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useLookup } from '@/lib/use-lookup';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';

export type StateRow = {
  state_id: number;
  state_name: string;
  state_code: string | null;
  country_id: number | null;
  /* 'State' | 'UT' — NULL until migrations/2026-09-21-state-zonal-manager.sql runs, or for a non-official name. */
  state_type: 'State' | 'UT' | null;
  state_status: number;
  state_user: number | null;
  manager_name: string | null;
  manager_role: string | null;
  /* tbl_user.user_status of the manager — anything but 1 means they have left. */
  manager_status: number | null;
  updated_by: number | null;
  updated_by_name: string | null;
  updated_on: string | null;
  /* Active + pending cities in the state. */
  city_count: number;
  /* Of those, how many already carry the state's manager. */
  synced_count: number;
};

/* manager_columns=false ⇒ the backend migration has not run on this DB yet. */
export type StatesResponse = { items: StateRow[]; total: number; manager_columns: boolean };

const NO_MANAGER = 'none';

// Official classification — 28 States and 8 Union Territories.
const TYPE_LABEL: Record<'State' | 'UT', string> = { State: 'State', UT: 'Union Territory' };

const managerLeft = (s: StateRow) => s.state_user != null && Number(s.manager_status) !== 1;
const needsAttention = (s: StateRow) => s.state_user == null || managerLeft(s);
const inSync = (s: StateRow) => s.state_user != null && s.synced_count >= s.city_count;

/* DATETIME stored as IST wall-clock — sliced, never parsed (same as Created By). */
function istDate(v: string | null): string {
  return v ? String(v).replace('T', ' ').slice(0, 10) : '';
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

export function StatesTab({
  data, loading, error, canEdit, addOpen, onAddOpenChange, onChanged,
}: {
  data: StatesResponse | null;
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  /* The page header's "Add State" button lives outside this tab. */
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  /* Refetches states AND cities — a manager move changes both. */
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const lookup = useLookup();
  const states = useMemo(() => data?.items ?? [], [data]);

  const [managerFilter, setManagerFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [newManager, setNewManager] = useState<string>('');
  const [applying, setApplying] = useState(false);
  const [editing, setEditing] = useState<StateRow | null>(null);
  const [resyncingId, setResyncingId] = useState<number | null>(null);

  // A refetch can drop a state (never in practice, but a stale tick would be
  // sent to the backend and 400 the whole move) — keep only ids that exist.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(states.map((s) => s.state_id));
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [states]);

  /*
   * The CURRENT-manager dropdown lists only people who hold a state today,
   * each with their state count. A manager who has left stays in the list,
   * flagged — that is the list used to move their states away.
   */
  const managerOptions = useMemo(() => {
    const by = new Map<number, { name: string; count: number; left: boolean }>();
    for (const s of states) {
      if (s.state_user == null) continue;
      const cur = by.get(s.state_user) ?? { name: s.manager_name ?? `User #${s.state_user}`, count: 0, left: managerLeft(s) };
      cur.count += 1;
      by.set(s.state_user, cur);
    }
    return Array.from(by.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => Number(b.left) - Number(a.left) || a.name.localeCompare(b.name));
  }, [states]);

  const unassigned = states.filter((s) => s.state_user == null).length;
  const leftStates = states.filter(managerLeft).length;

  // A filter pointing at a manager who no longer holds any state (they were
  // just moved away) would show an empty table — fall back to all.
  useEffect(() => {
    if (!managerFilter || managerFilter === NO_MANAGER) return;
    if (!managerOptions.some((m) => String(m.id) === managerFilter)) setManagerFilter('');
  }, [managerOptions, managerFilter]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return states.filter((s) =>
      (!q || s.state_name.toLowerCase().includes(q) || (s.state_code ?? '').toLowerCase().includes(q)
        || (s.state_type != null && TYPE_LABEL[s.state_type].toLowerCase().includes(q))) &&
      (!managerFilter || (managerFilter === NO_MANAGER ? s.state_user == null : String(s.state_user) === managerFilter)));
  }, [states, search, managerFilter]);

  const filtersActive = managerFilter !== '' || search.trim() !== '';
  const picked = states.filter((s) => selected.has(s.state_id));
  const pickedCities = picked.reduce((a, s) => a + s.city_count, 0);
  const allVisibleTicked = visible.length > 0 && visible.every((s) => selected.has(s.state_id));
  const someVisibleTicked = visible.some((s) => selected.has(s.state_id));

  const focusManager = managerFilter && managerFilter !== NO_MANAGER
    ? managerOptions.find((m) => String(m.id) === managerFilter) : null;
  const focusCities = focusManager
    ? states.filter((s) => s.state_user === focusManager.id).reduce((a, s) => a + s.city_count, 0) : 0;

  function toggle(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
  function toggleVisible(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visible) { if (on) next.add(s.state_id); else next.delete(s.state_id); }
      return next;
    });
  }

  const userOptions = lookup.toOpts.adminUsers;
  const userName = (id: number) => lookup.adminUsers.find((u) => u.user_id === id)?.user_name ?? `User #${id}`;

  async function applyMove() {
    const to = Number(newManager);
    if (!to || picked.length === 0) return;
    const toName = userName(to);
    const moving = picked.filter((s) => s.state_user !== to);
    const ok = await confirm({
      title: `Move ${plural(picked.length, 'state', 'states')} to ${toName}?`,
      description: (
        <div className="space-y-2">
          <p>
            Every city in these states gets <span className="font-medium text-foreground">{toName}</span> as
            its zonal manager — {plural(pickedCities, 'city', 'cities')} in total. Past jobs and reports for
            these cities move with them.
          </p>
          <ul className="text-sm border rounded divide-y max-h-56 overflow-auto">
            {picked.map((s) => (
              <li key={s.state_id} className="flex justify-between gap-3 px-3 py-1.5">
                <span>
                  <span className="font-medium text-foreground">{s.state_name}</span>
                  <span className="text-muted-foreground"> · {s.manager_name ?? 'no manager'} → {toName}</span>
                </span>
                <span className="text-muted-foreground whitespace-nowrap">{plural(s.city_count, 'city', 'cities')}</span>
              </li>
            ))}
          </ul>
          {moving.length < picked.length && (
            <p className="text-xs">{plural(picked.length - moving.length, 'state already has', 'states already have')} {toName} — their cities are re-synced anyway.</p>
          )}
        </div>
      ),
      confirmLabel: 'Save and apply',
    });
    if (!ok) return;
    setApplying(true);
    try {
      const r = await api.post<{ states_updated: number; cities_updated: number }>(
        '/admin/states/assign-manager',
        { state_ids: picked.map((s) => s.state_id), state_user: to },
      );
      showToast({
        variant: 'success',
        message: `${toName} now manages ${plural(r.states_updated, 'more state', 'more states')} · ${plural(r.cities_updated, 'city', 'cities')} updated`,
      });
      setSelected(new Set());
      setNewManager('');
      onChanged();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not move the states' });
    } finally {
      setApplying(false);
    }
  }

  async function resync(s: StateRow) {
    const behind = s.city_count - s.synced_count;
    const ok = await confirm({
      title: `Re-sync ${s.state_name}?`,
      description: `${plural(behind, 'city in this state has', 'cities in this state have')} a different zonal manager. They will all be set to ${s.manager_name}.`,
      confirmLabel: 'Re-sync cities',
    });
    if (!ok) return;
    setResyncingId(s.state_id);
    try {
      const r = await api.post<{ cities_updated: number }>(`/admin/states/${s.state_id}/resync`);
      showToast({ variant: 'success', message: `${s.state_name} · ${plural(r.cities_updated, 'city', 'cities')} re-synced to ${s.manager_name}` });
      onChanged();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Re-sync failed' });
    } finally {
      setResyncingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {data && !data.manager_columns && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-warning-strong">
            <AlertTriangle className="size-4 shrink-0" />
            Zonal managers aren&rsquo;t set up on this database yet — the state migration still has to run.
            States are listed, but managers can&rsquo;t be assigned until then.
          </CardContent>
        </Card>
      )}

      {(unassigned > 0 || leftStates > 0) && (
        <Card className="border-urgent/40">
          <CardContent className="p-3 flex items-center gap-x-4 gap-y-1 flex-wrap text-sm">
            <AlertTriangle className="size-4 text-urgent shrink-0" />
            {unassigned > 0 && (
              <button type="button" className="text-urgent font-medium hover:underline" onClick={() => setManagerFilter(NO_MANAGER)}>
                {plural(unassigned, 'state needs', 'states need')} a zonal manager
              </button>
            )}
            {leftStates > 0 && (
              <span className="text-urgent font-medium">
                {plural(leftStates, 'state is', 'states are')} managed by someone who has left — pick them in the manager filter
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-3 flex items-end gap-2 flex-wrap">
          <div className="min-w-[260px]">
            <Label className="block mb-1 text-xs text-muted-foreground">Current zonal manager</Label>
            <select
              value={managerFilter}
              onChange={(e) => setManagerFilter(e.target.value)}
              className="border rounded h-9 px-2 text-sm bg-background w-full font-medium"
            >
              <option value="">All managers ({plural(states.length, 'state', 'states')})</option>
              {managerOptions.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.left ? '⚠ ' : ''}{m.name} — {plural(m.count, 'state', 'states')}{m.left ? ' · left organisation' : ''}
                </option>
              ))}
              {unassigned > 0 && (
                <option value={NO_MANAGER}>No manager — {plural(unassigned, 'state', 'states')}</option>
              )}
            </select>
          </div>
          <div className="relative flex-1 min-w-[220px]">
            <Label className="block mb-1 text-xs text-muted-foreground">State</Label>
            <Search className="size-4 absolute left-2 bottom-2.5 text-muted-foreground" />
            <Input
              placeholder="Search by state or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {filtersActive && (
            <Button variant="outline" onClick={() => { setManagerFilter(''); setSearch(''); }}>
              <X className="size-4 mr-1" /> Clear filters
            </Button>
          )}
        </CardContent>
        {focusManager && (
          <div className="px-3 pb-3 -mt-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{focusManager.name}</span> manages{' '}
            {plural(focusManager.count, 'state', 'states')} · {plural(focusCities, 'city', 'cities')}
            {focusManager.left && <span className="text-urgent font-medium"> · has left the organisation — move these states</span>}
          </div>
        )}
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {canEdit && picked.length > 0 && (
            <div className="border-b bg-info-tint px-3 py-3 space-y-2">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="font-semibold text-info-strong">{plural(picked.length, 'state', 'states')} selected</span>
                <span className="text-muted-foreground">· {plural(pickedCities, 'city', 'cities')} will be updated</span>
                <button type="button" className="text-info-strong text-xs underline" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {picked.map((s) => (
                  <span key={s.state_id} className="inline-flex items-center gap-1 rounded-full border bg-background pl-2.5 pr-1 py-0.5 text-xs">
                    <span className="font-medium">{s.state_name}</span>
                    <span className="text-muted-foreground">{s.manager_name ?? 'no manager'}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${s.state_name}`}
                      className="rounded-full p-0.5 text-muted-foreground hover:text-urgent"
                      onClick={() => toggle(s.state_id, false)}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">Assign new zonal manager</span>
                <SearchSelect
                  value={newManager}
                  onChange={setNewManager}
                  options={userOptions}
                  placeholder="Search active internal users…"
                  className="min-w-[280px]"
                />
                <Button className="ml-auto" onClick={applyMove} disabled={!newManager || applying}>
                  {applying ? 'Saving…' : 'Save and apply'}
                </Button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  {canEdit && (
                    <th className="!text-center w-10">
                      <Checkbox
                        checked={allVisibleTicked}
                        indeterminate={!allVisibleTicked && someVisibleTicked}
                        onChange={toggleVisible}
                        label="Select all visible states"
                      />
                    </th>
                  )}
                  <th className="!text-center">State ID</th>
                  <th className="!text-left">State</th>
                  <th className="!text-left">Zonal Manager</th>
                  <th className="!text-center">Cities</th>
                  <th className="!text-center">Cities in Sync</th>
                  <th className="!text-left">Last Updated By</th>
                  <th className="!text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data && (
                  <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {data && visible.length === 0 && (
                  <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No states match these filters.</td></tr>
                )}
                {visible.map((s) => {
                  const ticked = selected.has(s.state_id);
                  return (
                    <tr key={s.state_id} className={ticked ? 'bg-info-tint/60' : undefined}>
                      {canEdit && (
                        <td className="!text-center">
                          <Checkbox checked={ticked} onChange={(on) => toggle(s.state_id, on)} label={`Select ${s.state_name}`} />
                        </td>
                      )}
                      <td className="!text-center font-mono text-xs">{s.state_id}</td>
                      <td className="!text-left">
                        <div className="leading-tight">
                          <span className="font-medium">{s.state_name}</span>
                          {s.state_code && <span className="ml-1.5 text-xs text-muted-foreground">{s.state_code}</span>}
                        </div>
                        {s.state_type && <div className="text-xs text-muted-foreground">{TYPE_LABEL[s.state_type]}</div>}
                      </td>
                      <td className="!text-left">
                        {s.state_user == null ? (
                          <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-urgent-tint text-urgent-strong">
                            Needs a manager
                          </span>
                        ) : (
                          <div className="leading-tight">
                            <div className="font-medium flex items-center gap-1.5">
                              {s.manager_name ?? `User #${s.state_user}`}
                              {managerLeft(s) && (
                                <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium bg-urgent-tint text-urgent-strong">
                                  <UserX className="size-3" /> Left organisation
                                </span>
                              )}
                            </div>
                            {s.manager_role && <div className="text-xs text-muted-foreground">{s.manager_role}</div>}
                          </div>
                        )}
                      </td>
                      <td className="!text-center">{s.city_count}</td>
                      <td className="!text-center whitespace-nowrap">
                        <SyncChip s={s} />
                        {canEdit && s.state_user != null && !inSync(s) && (
                          <IconButton
                            icon={RefreshCw}
                            label={`Re-sync ${s.state_name}'s cities to ${s.manager_name}`}
                            intent="primary"
                            className="ml-1 align-middle"
                            busy={resyncingId === s.state_id}
                            onClick={() => resync(s)}
                          />
                        )}
                      </td>
                      <td className="!text-left">
                        {s.updated_on ? (
                          <div className="leading-tight">
                            <div>{s.updated_by_name ?? (s.updated_by ? `User #${s.updated_by}` : 'Backfill')}</div>
                            <div className="text-xs text-muted-foreground">{istDate(s.updated_on)}</div>
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="!text-right whitespace-nowrap">
                        {canEdit
                          ? <IconButton icon={Pencil} label="Edit State" intent="primary" onClick={() => setEditing(s)} />
                          : <span className="text-xs text-muted-foreground">view-only</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t flex justify-between flex-wrap gap-2 text-xs text-muted-foreground">
            <span>
              Showing {visible.length} of {states.length}
              {states.some((s) => s.state_type) && (
                <> · {states.filter((s) => s.state_type === 'State').length} States, {states.filter((s) => s.state_type === 'UT').length} Union Territories</>
              )}
              {states.some(needsAttention) ? '' : ' · every state has an active manager'}
            </span>
            <span>One manager per state · one manager can hold many states</span>
          </div>
        </CardContent>
      </Card>

      <StateFormDialog
        open={addOpen || editing != null}
        editing={editing}
        typesEnabled={states.some((s) => s.state_type != null)}
        userOptions={userOptions}
        userName={userName}
        onClose={() => { setEditing(null); onAddOpenChange(false); }}
        onSaved={() => { setEditing(null); onAddOpenChange(false); onChanged(); }}
      />
    </div>
  );
}

function SyncChip({ s }: { s: StateRow }) {
  const tone = s.state_user == null
    ? 'bg-urgent-tint text-urgent-strong'
    : inSync(s) ? 'bg-success-tint text-success-strong' : 'bg-warning-tint text-warning-strong';
  const shown = s.state_user == null ? 0 : Math.min(s.synced_count, s.city_count);
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
      title={s.state_user == null ? 'No manager to sync to' : inSync(s) ? 'Every city carries the state\'s manager' : 'Some cities carry a different manager'}
    >
      {shown} / {s.city_count}
    </span>
  );
}

// ─── Add / Edit state ────────────────────────────────────────────────
function StateFormDialog({
  open, editing, typesEnabled, userOptions, userName, onClose, onSaved,
}: {
  open: boolean;
  editing: StateRow | null;
  /* False until the migration adds state_type — the field is hidden rather than sent and refused. */
  typesEnabled: boolean;
  userOptions: Array<{ value: string | number; label: string }>;
  userName: (id: number) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [manager, setManager] = useState('');
  // null = not classified yet (a row the migration could not type by its official name).
  const [stateType, setStateType] = useState<'State' | 'UT' | null>('State');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.state_name ?? '');
    setCode(editing?.state_code ?? '');
    setManager(editing?.state_user != null ? String(editing.state_user) : '');
    // A new state defaults to State; an existing row shows what it has — never a guess.
    setStateType(editing ? editing.state_type : 'State');
    setError(null);
  }, [open, editing]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });
  const managerChanged = !!manager && Number(manager) !== (editing?.state_user ?? null);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('State name is required'); return; }
    if (!manager) { setError('Pick a zonal manager — a state can\'t be saved without one'); return; }
    if (typesEnabled && stateType == null) { setError('Choose State or Union Territory'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        // Only what changed. state_user in the body is what pushes the manager
        // to every city — a rename alone must not re-sync them.
        const body: Record<string, unknown> = {};
        if (name.trim() !== editing!.state_name) body.state_name = name.trim();
        if ((code.trim() || null) !== (editing!.state_code || null)) body.state_code = code.trim() || null;
        if (managerChanged) body.state_user = Number(manager);
        if (typesEnabled && stateType != null && stateType !== editing!.state_type) body.state_type = stateType;
        if (Object.keys(body).length === 0) { onClose(); return; }
        const r = await api.patch<{ cities_updated: number }>(`/admin/states/${editing!.state_id}`, body);
        showToast({
          variant: 'success',
          message: managerChanged
            ? `${name.trim()} saved · ${r.cities_updated} cities now on ${userName(Number(manager))}`
            : `${name.trim()} saved`,
        });
      } else {
        await api.post('/admin/states', {
          state_name: name.trim(),
          state_code: code.trim() || null,
          state_user: Number(manager),
          ...(typesEnabled && stateType != null ? { state_type: stateType } : {}),
        });
        showToast({ variant: 'success', message: `${name.trim()} added with ${userName(Number(manager))}` });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.state_name}"` : 'Add State'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <Label className="block mb-1" required>State Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Uttar Pradesh"' />
            </div>
            <div>
              <Label className="block mb-1">Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 10))} placeholder="UP" className="font-mono" />
            </div>
          </div>

          {typesEnabled && (
            <div>
              <Label className="block mb-1" required>Type</Label>
              <div className="flex gap-4 text-sm" role="radiogroup" aria-label="State or Union Territory">
                {(['State', 'UT'] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="state-type" checked={stateType === t} onChange={() => setStateType(t)} />
                    {TYPE_LABEL[t]}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="block mb-1" required>Zonal Manager</Label>
            <SearchSelect
              value={manager}
              onChange={(v) => { setManager(v); setError(null); }}
              options={userOptions}
              placeholder="Search active internal users…"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Every city in this state takes this manager, including cities added later.
            </p>
          </div>

          {isEdit && managerChanged && (
            <div className="rounded border border-warning/40 bg-warning-tint px-3 py-2 text-sm text-warning-strong">
              <span className="font-medium">{editing!.city_count} cities move to {userName(Number(manager))}.</span>{' '}
              {editing!.state_user != null
                ? `Currently with ${editing!.manager_name ?? `User #${editing!.state_user}`}. Past jobs and reports for these cities move too.`
                : 'This state had no manager.'}
            </div>
          )}

          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save and apply' : 'Add State'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
