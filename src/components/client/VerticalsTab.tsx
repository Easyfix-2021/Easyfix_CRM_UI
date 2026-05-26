'use client';

/*
 * Verticals tab — list + bulk-edit (vertical × user × role) assignments.
 *
 * Backed by:
 *   GET /admin/clients/:clientId/verticals
 *   PUT /admin/clients/:clientId/verticals  (replace-set)
 *
 * The legacy CRM exposed two roles per vertical: Head (user_type=1)
 * and Project Manager (user_type=2). We keep that vocabulary in the
 * UI but allow free-form roles forward-compat — the BE accepts any
 * positive int and silently drops user_type if the column is absent.
 *
 * Replace-set save semantics: the user manipulates the grid locally,
 * then "Save Changes" sends the full new set. Simple, atomic, matches
 * legacy behaviour.
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, AlertCircle, Save, Users, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';

type Vertical = { vertical_id: number; vertical_name: string };
// tbl_user uses single `user_name` + `official_email` (NOT
// first_name/last_name/user_email). Verified against legacy.
type UserRow = { user_id: number; user_name: string | null; official_email: string | null };
// /admin/users returns `{ items, total }` (verified in user.service.js#listUsers).
// Tolerate both shapes since other lookups return bare arrays.
type UsersResponse = { items: UserRow[]; total?: number } | UserRow[];

type Assignment = {
  vertical_id: number;
  vertical_name?: string;
  user_id: number;
  user_name?: string | null;
  user_email?: string | null;
  user_type: number | null;
  user_type_label?: string;
};

const ROLE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Head' },
  { value: 2, label: 'PM (Project Manager)' },
  { value: 0, label: 'Member' },
];

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function VerticalsTab({ clientId, canEdit }: Props) {
  const assignmentsKey = `/admin/clients/${clientId}/verticals`;
  const { data: serverRows, loading, error, refetch } = useFetch<Assignment[]>(assignmentsKey);
  const { data: verticals } = useFetch<Vertical[]>(`/shared/lookup/verticals`);
  // Users list — fetched once per session; large org might want a
  // typeahead later but for ~50-200 staff users a single fetch is fine.
  const { data: usersResp } = useFetch<UsersResponse>(`/admin/users?limit=500`);
  // Normalise — endpoint returns { items, total } but be defensive about
  // future contract changes.
  const users: UserRow[] = useMemo(() => {
    if (!usersResp) return [];
    if (Array.isArray(usersResp)) return usersResp;
    return Array.isArray(usersResp.items) ? usersResp.items : [];
  }, [usersResp]);

  const [draft, setDraft] = useState<Assignment[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Snapshot server rows into local draft so the user can edit
  // freely; revert by clicking Cancel.
  useEffect(() => {
    if (serverRows && draft === null) setDraft(serverRows);
  }, [serverRows, draft]);

  const dirty = useMemo(() => {
    if (!draft || !serverRows) return false;
    if (draft.length !== serverRows.length) return true;
    const k = (a: Assignment) => `${a.vertical_id}:${a.user_id}:${a.user_type ?? ''}`;
    return draft.map(k).sort().join('|') !== serverRows.map(k).sort().join('|');
  }, [draft, serverRows]);

  const verticalOptions = useMemo(() => (verticals ?? []).map((v) => ({ value: v.vertical_id, label: v.vertical_name })), [verticals]);
  const userOptions = useMemo(() => users.map((u) => {
    const name = u.user_name?.trim() || u.official_email || `User #${u.user_id}`;
    return { value: u.user_id, label: name };
  }), [users]);

  function addRow() {
    setDraft((d) => [...(d ?? []), { vertical_id: 0, user_id: 0, user_type: 1 }]);
  }
  function removeRow(idx: number) {
    setDraft((d) => (d ?? []).filter((_, i) => i !== idx));
  }
  function updateRow(idx: number, patch: Partial<Assignment>) {
    setDraft((d) => (d ?? []).map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function reset() {
    setDraft(serverRows ?? []);
  }

  async function onSave() {
    if (!draft) return;
    // Validate: every row must have a vertical + user. Dedupe is the BE's
    // job, but warn locally if obvious duplicates exist.
    const incomplete = draft.find((r) => !r.vertical_id || !r.user_id);
    if (incomplete) {
      showToast({ variant: 'error', message: 'Every row needs both a vertical and a user.' });
      return;
    }
    const seen = new Set<string>();
    for (const r of draft) {
      const k = `${r.vertical_id}:${r.user_id}`;
      if (seen.has(k)) {
        showToast({ variant: 'error', message: 'Duplicate (vertical, user) row.' });
        return;
      }
      seen.add(k);
    }
    setSaving(true);
    try {
      const assignments = draft.map((r) => ({
        verticalId: r.vertical_id,
        userId: r.user_id,
        userType: r.user_type ?? undefined,
      }));
      await api.put<{ written: number }>(`/admin/clients/${clientId}/verticals`, { assignments } as never);
      invalidateFetch((k) => k === assignmentsKey);
      refetch();
      // Also force the local draft to re-sync once the fetch lands.
      setDraft(null);
      showToast({ variant: 'success', message: 'Verticals saved.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  const rows = draft ?? [];

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${rows.length} assignment${rows.length === 1 ? '' : 's'}`}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {dirty && (
              <>
                <Button size="sm" variant="outline" onClick={reset} disabled={saving}>Revert</Button>
                <Button size="sm" onClick={onSave} disabled={saving}>
                  <Save className="size-3.5 mr-1" /> {saving ? 'Saving…' : 'Save Changes'}
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" onClick={addRow}>
              <Plus className="size-3.5 mr-1" /> Add Assignment
            </Button>
          </div>
        )}
      </div>
      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div className="text-sm text-muted-foreground italic">
          No vertical assignments. {canEdit ? 'Click "Add Assignment" to map a user to a vertical for this client.' : 'Ask an editor to add assignments.'}
        </div>
      )}
      <div className="rounded border bg-card divide-y">
        {rows.map((r, idx) => (
          <div key={idx} className="p-2 grid grid-cols-12 gap-2 items-center">
            <div className="col-span-4">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <Layers className="size-3" /> Vertical
              </Label>
              {canEdit ? (
                <SearchSelect
                  value={r.vertical_id || ''}
                  onChange={(val) => updateRow(idx, {
                    vertical_id: Number(val),
                    vertical_name: verticals?.find((v) => v.vertical_id === Number(val))?.vertical_name,
                  })}
                  options={verticalOptions}
                  placeholder="Select vertical…"
                />
              ) : (
                <div className="text-sm">{r.vertical_name ?? `#${r.vertical_id}`}</div>
              )}
            </div>
            <div className="col-span-5">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <Users className="size-3" /> User
              </Label>
              {canEdit ? (
                <SearchSelect
                  value={r.user_id || ''}
                  onChange={(val) => {
                    const u = users.find((u) => u.user_id === Number(val));
                    const name = u?.user_name?.trim() || null;
                    updateRow(idx, { user_id: Number(val), user_name: name, user_email: u?.official_email ?? null });
                  }}
                  options={userOptions}
                  placeholder="Select user…"
                />
              ) : (
                <div className="text-sm">
                  <div>{r.user_name ?? `#${r.user_id}`}</div>
                  {r.user_email && <div className="text-xs text-muted-foreground">{r.user_email}</div>}
                </div>
              )}
            </div>
            <div className="col-span-2">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Role</Label>
              {canEdit ? (
                <select
                  className="border rounded h-9 px-2 text-sm w-full bg-background"
                  value={r.user_type ?? ''}
                  onChange={(e) => updateRow(idx, { user_type: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  {ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <div className="text-sm">{r.user_type_label ?? '—'}</div>
              )}
            </div>
            <div className="col-span-1 flex justify-end">
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={() => removeRow(idx)} className="text-red-600 hover:text-red-700">
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {canEdit && dirty && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          You have unsaved changes. Click "Save Changes" to commit, or "Revert" to discard.
        </div>
      )}
    </div>
  );
}
