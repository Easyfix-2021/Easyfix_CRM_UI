'use client';

/*
 * Custom Properties tab — list + Add/Edit/Delete free-form key/value
 * properties attached to a client.
 *
 * Backed by:
 *   GET    /admin/clients/:clientId/custom-properties
 *   POST   /admin/clients/:clientId/custom-properties
 *   PUT    /admin/clients/custom-properties/:id
 *   DELETE /admin/clients/custom-properties/:id
 *
 * The GET endpoint returns NORMALISED shapes: { id, name, label, value,
 * mandatory, raw }. The `name` field is lower-cased + trimmed — used
 * by Book-New-Call to detect which optional inputs to render (branch_name,
 * product_code, etc.). We persist exactly what the user typed; the
 * normalisation happens only on read.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { titleCaseLabel } from '@/lib/format';
import type { ClientCustomProperty, ClientDetail, CustomPropertyFormPayload } from '@/lib/client-types';

/*
 * Shape of the cross-client distinct-keys endpoint
 * (GET /admin/clients/custom-property-keys). Defined locally because
 * this is the only consumer and the BE is plain JS — no shared types
 * package to source from.
 */
type DistinctPropertyKey = {
  key: string;
  sample_label: string | null;
  use_count: number;
};

/*
 * Canonical Title-Case property names for the two BE-consumed runtime
 * flags. Surfaced as dedicated cards above the generic dropdown — the
 * BE looks them up via case-insensitive underscore-tolerant comparison
 * (see services/job-magic-link.service.js + job.service.js LIST
 * projection), so legacy snake_case rows in the DB still resolve.
 *
 * Hidden from the generic dropdown + items list so each control has
 * exactly one UI surface.
 */
const AUTO_PROCESS_KEY = 'Auto Process Unconfirmed Order';
const MAX_SEND_COUNT_KEY = 'Max Magic-Link Send Count';
// Channel for chasing Unconfirmed Orders: 'form' (magic-link web form, default)
// or 'conversation' (in-chat AI WhatsApp flow). Stored as a custom property.
const ORDER_MODE_KEY = 'Order Confirmation Mode';
// Per-client Branch Details policy — Off (no row) / Optional / Mandatory. Stored
// as the canonical `branch_details` custom-property row; the booking pages
// (JobModal + /public job-completion) already derive branchProp from it, so this
// card is the ONLY surface needed to make Branch Details dynamic per client
// (replaces the legacy hardcoded clientId gate 252/395/10 in EasyFix_CRM).
const BRANCH_DETAILS_KEY = 'Branch Details';

/*
 * Normalise a property name for case-insensitive + underscore-tolerant
 * comparison. Mirrors the BE SQL `LOWER(REPLACE(c_prop_name, '_', ' '))`
 * so a row stored as `auto_process_unconfirmed_order`, `Auto Process
 * Unconfirmed Order`, or `AUTO_PROCESS_UNCONFIRMED_ORDER` all collapse
 * to the same canonical key on the FE too. Used by the cards to find
 * their backing row in the items list regardless of how it was authored.
 */
function normalizePropKey(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

const HOISTED_NORMALIZED = new Set([
  normalizePropKey(AUTO_PROCESS_KEY),
  normalizePropKey(MAX_SEND_COUNT_KEY),
  normalizePropKey(ORDER_MODE_KEY),
  normalizePropKey(BRANCH_DETAILS_KEY), // 'branch details'
  'branch',                             // JobModal canonicalises a legacy 'branch' row → branch_details too
]);

/*
 * Module-level TTL cache for `/admin/clients/custom-property-keys`.
 *
 * Why module-level + TTL rather than `useFetch` / `useFetchOnce`:
 *   - useFetchOnce caches forever within a session — new keys created
 *     by ops in a sibling client never surface until refresh.
 *   - useFetch refetches on every mount — opening Add → Cancel → Add
 *     triggers a network roundtrip each time, flickers the dropdown.
 *
 * 30s TTL hits the sweet spot: cancel→reopen is instant; a freshly-
 * added key shows up within half a minute. The cache is also
 * invalidated explicitly when a property is saved/edited/deleted, so
 * the new key shows up immediately in any other dialog opened after.
 */
const KEYS_CACHE_TTL_MS = 30_000;
let _keysCache: { data: DistinctPropertyKey[]; expiresAt: number } | null = null;

async function loadPropertyKeys(force = false): Promise<DistinctPropertyKey[]> {
  const now = Date.now();
  if (!force && _keysCache && _keysCache.expiresAt > now) {
    return _keysCache.data;
  }
  try {
    const data = await api.get<DistinctPropertyKey[]>('/admin/clients/custom-property-keys');
    const arr = Array.isArray(data) ? data : [];
    _keysCache = { data: arr, expiresAt: now + KEYS_CACHE_TTL_MS };
    return arr;
  } catch {
    // On error, return whatever we have cached even if stale. Worst
    // case (no cache + network failure) → empty list, user picks Other.
    return _keysCache?.data ?? [];
  }
}

function invalidatePropertyKeysCache() { _keysCache = null; }

type Props = {
  clientId: number;
  canEdit: boolean;
  client?: ClientDetail | null;
};

export function CustomPropsTab({ clientId, canEdit, client }: Props) {
  const key = `/admin/clients/${clientId}/custom-properties`;
  const { data, loading, error, refetch } = useFetch<ClientCustomProperty[]>(key);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientCustomProperty | null>(null);
  const confirm = useConfirm();

  const allItems = data ?? [];
  /*
   * Generic-list items: everything EXCEPT the two BE-consumed flags
   * that have dedicated cards. Hiding hoisted keys here avoids double-
   * rendering them (one card + one generic row) and stops operators
   * from accidentally creating conflicting duplicate entries.
   */
  const items = allItems.filter((p) => !HOISTED_NORMALIZED.has(normalizePropKey(p.name)));
  const autoProcessRow = allItems.find((p) => normalizePropKey(p.name) === normalizePropKey(AUTO_PROCESS_KEY)) ?? null;
  const maxSendCountRow = allItems.find((p) => normalizePropKey(p.name) === normalizePropKey(MAX_SEND_COUNT_KEY)) ?? null;
  const orderModeRow = allItems.find((p) => normalizePropKey(p.name) === normalizePropKey(ORDER_MODE_KEY)) ?? null;
  // Branch Details backing row — match 'branch_details'/'Branch Details' AND a
  // legacy 'branch' row (JobModal canonicalises all three → branch_details).
  const branchRow = allItems.find((p) => {
    const k = normalizePropKey(p.name);
    return k === normalizePropKey(BRANCH_DETAILS_KEY) || k === 'branch';
  }) ?? null;

  // Invalidating the cross-client keys cache after a save here also
  // invalidates `useFetch`'s memo so a fresh /custom-properties read
  // happens. Centralised so each save/delete site calls one helper.
  function invalidateAndRefetch() {
    invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/custom-properties`));
    invalidatePropertyKeysCache();
    refetch();
  }

  async function onDelete(p: ClientCustomProperty) {
    const ok = await confirm({
      title: 'Delete Custom Property',
      description: `Delete "${p.label ?? p.name}"?`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok || !p.id) return;
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/custom-properties/${p.id}`);
      invalidateAndRefetch();
      showToast({ variant: 'success', message: 'Property deleted.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed.' });
    }
  }

  return (
    <div className="pt-2 space-y-3">
      {/*
        BE-consumed runtime flags. These live in
        `tbl_client_custom_properties` like any other row, but their
        values drive backend behaviour (cron + magic-link cap), not
        booking-form data. Surface them as dedicated cards so ops doesn't
        have to know they're stored as custom properties — they edit them
        like first-class settings. Cards read/write through the same
        endpoint as the generic list; case-insensitive lookup means
        legacy snake_case rows still resolve.
      */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <MonthlyRevenueCard
          clientId={clientId}
          initialValue={client?.monthly_revenue ?? null}
          canEdit={canEdit}
        />
        <AutoProcessCard
          clientId={clientId}
          existing={autoProcessRow}
          canEdit={canEdit}
          onSaved={invalidateAndRefetch}
        />
        <MaxSendCountCard
          clientId={clientId}
          existing={maxSendCountRow}
          canEdit={canEdit}
          onSaved={invalidateAndRefetch}
        />
        <OrderModeCard
          clientId={clientId}
          existing={orderModeRow}
          canEdit={canEdit}
          onSaved={invalidateAndRefetch}
        />
        <BranchDetailsCard
          clientId={clientId}
          existing={branchRow}
          canEdit={canEdit}
          onSaved={invalidateAndRefetch}
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${items.length} other propert${items.length === 1 ? 'y' : 'ies'}`}
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5 mr-1" /> Add Property
          </Button>
        )}
      </div>
      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground italic">No custom properties configured.</div>
      )}
      <ul className="space-y-1">
        {items.map((p, idx) => (
          <li key={p.id ?? idx} className="rounded border bg-card px-3 py-2 flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {/*
                  Display the property name Title Cased for visual
                  consistency even when the DB stored it as lower-snake
                  or lower-space ("store_name" / "store name" both
                  render as "Store Name"). The raw c_prop_name is still
                  what gets persisted on save — this is display-only.
                */}
                <span className="text-xs font-mono bg-muted/50 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                  <Tag className="size-3" /> {titleCaseLabel(p.name)}
                </span>
                {p.label && <span className="text-sm font-medium">{p.label}</span>}
                {p.mandatory && <span className="text-[10px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded">Required</span>}
                {/*
                  Control/config property — hidden from booking forms + bulk
                  templates (is_config discriminator). Data-entry rows have no chip.
                */}
                {p.is_config && (
                  <Badge className="text-[10px] uppercase tracking-wide text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0">Setting</Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {p.value ? <span>Value: <span className="font-mono">{p.value}</span></span> : <span className="italic">No default value</span>}
              </div>
            </div>
            {canEdit && p.id && (
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(p)} className="text-red-600 hover:text-red-700">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <CustomPropFormDialog
          clientId={clientId}
          initial={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={invalidateAndRefetch}
        />
      )}
    </div>
  );
}

/*
 * Sentinel for the "Other (custom key)…" escape-hatch option in the
 * dropdown. Picking it reveals a free-text input so ops can type a
 * brand-new property name that hasn't been used on any client yet.
 * After save, the new key surfaces in the dropdown for everyone (after
 * the TTL cache refreshes — also explicitly invalidated on save).
 */
const OTHER_PRESET_VALUE = '__other__';

function CustomPropFormDialog({
  clientId, initial, onClose, onSaved,
}: {
  clientId: number;
  initial: ClientCustomProperty | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [form, setForm] = useState<CustomPropertyFormPayload>(() => ({
    name: initial?.name ?? '',
    label: initial?.label ?? '',
    value: initial?.value ?? '',
    mandatory: initial?.mandatory ?? false,
    is_config: initial?.is_config ?? false,
  }));
  /*
   * DB-discovered property keys, loaded via the module-level TTL cache
   * on dialog mount. Fresh load (cache miss) → spinner-friendly; cached
   * hit → instant. Hoisted keys (Auto Process / Max Send Count) are
   * filtered out so they only appear in their dedicated cards above.
   */
  const [discoveredKeys, setDiscoveredKeys] = useState<DistinctPropertyKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setKeysLoading(true);
    loadPropertyKeys().then((rows) => {
      if (cancelled) return;
      setDiscoveredKeys(rows);
      setKeysLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const availableKeys = discoveredKeys
    .filter((k) => !HOISTED_NORMALIZED.has(normalizePropKey(k.key)))
    .sort((a, b) => (b.use_count - a.use_count) || a.key.localeCompare(b.key));

  /*
   * Options fed to SearchSelect. Flat list — no group separator.
   * Each option carries the raw c_prop_name as its value (so saves
   * write the unchanged key the row was originally created with),
   * but renders Title-Cased for visual consistency. The "Other"
   * sentinel at the bottom opens the free-text input.
   */
  const dropdownOptions: SearchOption[] = [
    ...availableKeys.map((k) => ({
      value: k.key,
      label: titleCaseLabel(k.sample_label || k.key),
    })),
    { value: OTHER_PRESET_VALUE, label: 'Other (custom key)…' },
  ];

  // Preset selection drives the Property Key input mode.
  //   - In edit mode: irrelevant (key is immutable, locked input shown).
  //   - In add mode + existing key is in available keys: pre-select it.
  //   - Otherwise default to OTHER_PRESET_VALUE → show free-text input.
  const [selectedPreset, setSelectedPreset] = useState<string>(() => {
    if (!initial?.name) return '';
    return availableKeys.some((k) => k.key === initial.name) ? initial.name : OTHER_PRESET_VALUE;
  });
  const activeDiscovered = availableKeys.find((k) => k.key === selectedPreset) ?? null;
  const [saving, setSaving] = useState(false);

  function update<K extends keyof CustomPropertyFormPayload>(key: K, value: CustomPropertyFormPayload[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /*
   * Preset change handler. Three cases:
   *   1. Picked a DB-discovered key → store the key verbatim (preserve
   *      legacy casing so existing BE consumers keep matching) and
   *      auto-fill the Label with the Title-Cased form (only when blank
   *      so we don't clobber an in-progress edit).
   *   2. Picked "Other" → blank the name (was bound to a preset),
   *      keep label/value as-is so user typing isn't lost.
   *   3. Cleared selection ("") → blank the name.
   *
   * Default Value is NEVER auto-filled. The per-row value is always
   * user-typed.
   */
  function onPresetChange(next: string) {
    setSelectedPreset(next);
    const discovered = availableKeys.find((p) => p.key === next);
    if (discovered) {
      setForm((f) => ({
        ...f,
        name: discovered.key,
        label: f.label?.trim() ? f.label : titleCaseLabel(discovered.sample_label || discovered.key),
      }));
    } else {
      // Both OTHER_PRESET_VALUE and "" land here.
      setForm((f) => ({ ...f, name: '' }));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form.name?.trim()) {
      showToast({ variant: 'error', message: 'Property name is required.' });
      return;
    }
    /*
     * Store the key VERBATIM (just whitespace-trimmed). Previously we
     * forced lower-snake (`branch_name`), but the project's new
     * convention is Title-Case-with-spaces ("Bill Number"). The BE
     * looks rows up case-insensitively after collapsing underscores
     * to spaces, so legacy snake_case rows still resolve. Whatever
     * the operator typed (or whatever was preserved from a previously-
     * used pick) goes through unchanged.
     */
    const persistedName = form.name.trim().replace(/\s+/g, ' ');
    if (!/[a-zA-Z0-9]/.test(persistedName)) {
      showToast({ variant: 'error', message: 'Property name must contain letters or numbers.' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: persistedName,
        label: form.label?.trim() || null,
        value: form.value?.trim() || null,
        mandatory: !!form.mandatory,
        is_config: !!form.is_config,
      };
      if (isEdit && initial?.id) {
        await api.put<{ updated: boolean }>(`/admin/clients/custom-properties/${initial.id}`, payload as never);
      } else {
        await api.post<{ id: number }>(`/admin/clients/${clientId}/custom-properties`, payload as never);
      }
      showToast({ variant: 'success', message: isEdit ? 'Property updated.' : 'Property added.' });
      onSaved();
      onClose();
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Custom Property' : 'Add Custom Property'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3 pt-1">
          {/*
            Property Key picker. Edit mode keeps the legacy disabled
            Input (key is immutable + Book-New-Call binds to it). Add
            mode shows a dropdown of well-known keys + "Other (custom
            key)…" so operators don't need to memorise magic strings
            like `max_magic_link_send_count`. Picking "Other" reveals
            the original free-text input for one-off / Book-New-Call
            client-specific keys.
          */}
          {isEdit ? (
            <Field label="Property Key" required>
              <Input
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                maxLength={100}
                required
                placeholder="branch_name"
                disabled
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                Key is immutable after creation (Book-New-Call binds to it).
              </div>
            </Field>
          ) : (
            <Field label="Property Key" required>
              {/*
                Flat searchable combobox of DB-discovered property keys
                + an "Other (custom key)…" escape hatch at the bottom.
                No groups, no separator — the list is one cohesive set
                of properties already in use across all clients. The
                Add-modal-open mount triggers a TTL-cached fetch so the
                list is fresh (and not stuck on a per-session snapshot).
              */}
              <SearchSelect
                value={selectedPreset}
                onChange={onPresetChange}
                options={dropdownOptions}
                placeholder={keysLoading ? 'Loading properties…' : '— Select a property —'}
                disabled={keysLoading}
                required
              />
              {/*
                Tile under the dropdown shows just the raw c_prop_name
                in monospace so the operator can confirm what string
                gets stored in DB (especially useful when the row was
                originally created with lower-case-with-spaces and the
                Title-Cased dropdown label might not exactly match).
                No "Used by N other clients" — operators don't need
                cross-client telemetry on this page.
              */}
              {activeDiscovered && (
                <div className="mt-2 rounded-md bg-slate-50 border border-slate-200 text-slate-700 px-3 py-2 text-xs">
                  <div className="font-mono text-[11px] text-slate-600">{activeDiscovered.key}</div>
                </div>
              )}
              {selectedPreset === OTHER_PRESET_VALUE && (
                <div className="mt-2">
                  <Input
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    maxLength={100}
                    required
                    placeholder="Bill Number"
                  />
                  <div className="text-[11px] text-muted-foreground mt-1">
                    New property name. Stored verbatim — pick Title Case for consistency (e.g. &ldquo;Bill Number&rdquo;).
                  </div>
                </div>
              )}
            </Field>
          )}
          <Field label="Label">
            <Input
              value={form.label ?? ''}
              onChange={(e) => update('label', e.target.value)}
              maxLength={200}
              placeholder={activeDiscovered ? titleCaseLabel(activeDiscovered.sample_label || activeDiscovered.key) : 'Bill Number'}
            />
          </Field>
          <Field label="Default Value">
            <Input
              value={form.value ?? ''}
              onChange={(e) => update('value', e.target.value)}
              maxLength={500}
              placeholder=""
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.mandatory}
              onChange={(e) => update('mandatory', e.target.checked)}
            />
            Required at Booking Time
          </label>
          {/*
            Client Setting discriminator (is_config). When checked, this is a
            client-level control/config property — the BE hides it from booking
            forms + bulk templates. Unchecked = a per-booking data-entry field.
          */}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!!form.is_config}
              onChange={(e) => update('is_config', e.target.checked)}
            />
            <span>
              Client Setting
              <span className="block text-[11px] text-muted-foreground">Hide From Booking Forms &amp; Bulk Template</span>
            </span>
          </label>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Property')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs">{label}{required && <span className="text-red-600 ml-0.5">*</span>}</Label>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/*
 * AutoProcessCard — dedicated Switch UI for the
 * `Auto Process Unconfirmed Order` flag.
 *
 * Reads its current value from any matching row in the items list
 * (case-insensitive + underscore-tolerant via normalizePropKey). On
 * toggle: PUT if a row exists, POST if not. Writes the canonical Title
 * Case key when CREATING a new row; when updating an existing row
 * we preserve the row's stored name so legacy snake_case rows are not
 * silently renamed (their content updates in place).
 */
function AutoProcessCard({
  clientId, existing, canEdit, onSaved,
}: {
  clientId: number;
  existing: ClientCustomProperty | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const isOn = (existing?.value ?? '').toLowerCase() === 'true';
  const [saving, setSaving] = useState(false);

  async function onToggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        // Use the existing row's name when updating (avoids surprise
        // rename); use the canonical Title-Case form when creating fresh.
        name: existing?.name || AUTO_PROCESS_KEY,
        label: existing?.label || AUTO_PROCESS_KEY,
        value: next ? 'true' : 'false',
        mandatory: !!existing?.mandatory,
      };
      if (existing?.id) {
        await api.put<{ updated: boolean }>(`/admin/clients/custom-properties/${existing.id}`, payload as never);
      } else {
        await api.post<{ id: number }>(`/admin/clients/${clientId}/custom-properties`, payload as never);
      }
      onSaved();
      showToast({ variant: 'success', message: next ? 'Auto-process turned ON.' : 'Auto-process turned OFF.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border bg-card px-3 py-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{AUTO_PROCESS_KEY}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          When ON, EasyFix automatically sends each new Unconfirmed Order&rsquo;s customer a WhatsApp link to complete their details, and enables the manual Trigger / Retrigger action on the Unconfirmed Orders list.
        </div>
      </div>
      <div className="shrink-0 pt-0.5">
        <Switch
          checked={isOn}
          onCheckedChange={onToggle}
          disabled={!canEdit || saving}
          ariaLabel={AUTO_PROCESS_KEY}
        />
      </div>
    </div>
  );
}

/*
 * OrderModeCard — dedicated selector for `Order Confirmation Mode`:
 * how an Unconfirmed Order chases the customer for details.
 *   - 'form'         → magic-link web form (default; existing behaviour)
 *   - 'conversation' → guided AI WhatsApp chat (no form link)
 * Stored value is the lower-case token; absent row defaults to 'form'.
 */
function OrderModeCard({
  clientId, existing, canEdit, onSaved,
}: {
  clientId: number;
  existing: ClientCustomProperty | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const current = (existing?.value ?? 'form').toLowerCase().includes('conversation') ? 'conversation' : 'form';
  const [saving, setSaving] = useState(false);

  async function onChange(next: string) {
    if (saving || next === current) return;
    setSaving(true);
    try {
      const payload = {
        name: existing?.name || ORDER_MODE_KEY,
        label: existing?.label || ORDER_MODE_KEY,
        value: next,
        mandatory: !!existing?.mandatory,
      };
      if (existing?.id) {
        await api.put<{ updated: boolean }>(`/admin/clients/custom-properties/${existing.id}`, payload as never);
      } else {
        await api.post<{ id: number }>(`/admin/clients/${clientId}/custom-properties`, payload as never);
      }
      onSaved();
      showToast({ variant: 'success', message: next === 'conversation' ? 'Switched to WhatsApp conversation.' : 'Switched to magic-link form.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border bg-card px-3 py-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{ORDER_MODE_KEY}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          How the customer is asked to complete an Unconfirmed Order&rsquo;s details — a magic-link web <b>Form</b>, or a guided <b>WhatsApp Conversation</b> (AI-assisted, in chat). Requires Auto-process / Trigger to be enabled.
        </div>
      </div>
      <div className="shrink-0 pt-0.5">
        <select
          value={current}
          disabled={!canEdit || saving}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
          aria-label={ORDER_MODE_KEY}
        >
          <option value="form">Form (link)</option>
          <option value="conversation">WhatsApp Conversation</option>
        </select>
      </div>
    </div>
  );
}

/*
 * BranchDetailsCard — dedicated per-client Branch Details policy selector:
 *   - 'off'       → no row (deleted): field hidden on the booking form
 *   - 'optional'  → row with mandatory=false: field shown, not required
 *   - 'mandatory' → row with mandatory=true: field shown with * + blocks submit
 * Backed by the canonical `branch_details` custom-property row, which JobModal
 * (Book New Call + Confirm & Schedule) and the /public job-completion page
 * ALREADY consume via `branchProp`, so no booking-page change is needed. This
 * replaces the legacy hardcoded clientId gate (EasyFix_CRM existCustomer.vm).
 */
function BranchDetailsCard({
  clientId, existing, canEdit, onSaved,
}: {
  clientId: number;
  existing: ClientCustomProperty | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const current: 'off' | 'optional' | 'mandatory' = !existing
    ? 'off'
    : (existing.mandatory ? 'mandatory' : 'optional');
  const [saving, setSaving] = useState(false);

  async function onChange(next: string) {
    if (saving || next === current) return;
    setSaving(true);
    try {
      if (next === 'off') {
        // Off = remove the row so the field disappears from booking.
        if (existing?.id) {
          await api.delete<{ deleted: boolean }>(`/admin/clients/custom-properties/${existing.id}`);
        }
      } else {
        const mandatory = next === 'mandatory';
        // Keep an existing row's authored name/label; create a fresh row with the
        // canonical snake key so it matches everywhere JobModal looks it up.
        const payload = {
          name: existing?.name || 'branch_details',
          label: existing?.label || BRANCH_DETAILS_KEY,
          value: existing?.value ?? null,
          mandatory,
        };
        if (existing?.id) {
          await api.put<{ updated: boolean }>(`/admin/clients/custom-properties/${existing.id}`, payload as never);
        } else {
          await api.post<{ id: number }>(`/admin/clients/${clientId}/custom-properties`, payload as never);
        }
      }
      onSaved();
      showToast({
        variant: 'success',
        message: next === 'off' ? 'Branch Details turned off.'
          : next === 'mandatory' ? 'Branch Details set to mandatory.'
          : 'Branch Details set to optional.',
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border bg-card px-3 py-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{BRANCH_DETAILS_KEY}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Whether the <b>Branch Details</b> field appears on the booking form for this client, and whether it&rsquo;s required. Saved to the job&rsquo;s <code>branch_details</code>.
        </div>
      </div>
      <div className="shrink-0 pt-0.5">
        <select
          value={current}
          disabled={!canEdit || saving}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
          aria-label={BRANCH_DETAILS_KEY}
        >
          <option value="off">Off</option>
          <option value="optional">Optional</option>
          <option value="mandatory">Mandatory</option>
        </select>
      </div>
    </div>
  );
}

/*
 * MonthlyRevenueCard — dedicated ₹ numeric input + Save button for
 * the client's expected monthly revenue. Calls PUT /admin/clients/:id
 * with { monthlyRevenue } and refreshes local draft on save.
 *
 * Modelled on MaxSendCountCard: local draft state, dirty + isValid
 * guards, disabled when !canEdit or saving. The initial value comes
 * from the ClientDetail fetched by the parent dialog (monthly_revenue
 * column) so no extra fetch is needed here.
 */
function MonthlyRevenueCard({
  clientId, initialValue, canEdit,
}: {
  clientId: number;
  initialValue: number | null;
  canEdit: boolean;
}) {
  const toStr = (v: number | null) => (v == null ? '' : String(v));
  const [draft, setDraft] = useState<string>(toStr(initialValue));
  const [saving, setSaving] = useState(false);
  // Ref to the "committed" value so dirty check works even when the
  // parent re-renders with a new initialValue after an unrelated refetch.
  const committedRef = useRef<string>(toStr(initialValue));
  useEffect(() => {
    const s = toStr(initialValue);
    setDraft(s);
    committedRef.current = s;
  }, [initialValue]);

  const dirty = draft.trim() !== committedRef.current.trim();
  const parsedNum = Number(draft.trim());
  const isValid = !draft.trim() || (Number.isFinite(parsedNum) && parsedNum >= 0);

  async function onSave() {
    if (saving || !dirty || !isValid) return;
    setSaving(true);
    try {
      const monthlyRevenue = draft.trim() ? parsedNum : null;
      await api.put<{ updated: boolean }>(`/admin/clients/${clientId}`, { monthlyRevenue } as never);
      committedRef.current = draft.trim();
      showToast({ variant: 'success', message: 'Monthly revenue updated.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border bg-card px-3 py-2.5 flex flex-col gap-2">
      <div>
        <div className="text-sm font-medium">Monthly Revenue</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Expected monthly revenue from this client (₹). Used for reporting and account prioritisation.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-36">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">₹</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
            placeholder="0"
            className="pl-6 w-full"
            disabled={!canEdit || saving}
          />
        </div>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!canEdit || saving || !dirty || !isValid}
          title={!isValid ? 'Enter a non-negative number' : (dirty ? 'Save' : 'No changes')}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/*
 * MaxSendCountCard — dedicated numeric input + Save button for the
 * `Max Magic-Link Send Count` per-client cap.
 *
 * Local "draft" state lets the operator type freely before committing.
 * On Save, validates 1..50 range, persists, and refreshes. Empty input
 * means "use default" — we write null/empty, the BE COALESCEs to 3.
 */
function MaxSendCountCard({
  clientId, existing, canEdit, onSaved,
}: {
  clientId: number;
  existing: ClientCustomProperty | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const initial = existing?.value ?? '';
  const [draft, setDraft] = useState<string>(initial);
  const [saving, setSaving] = useState(false);
  // Sync the draft when the underlying row swaps (e.g. invalidate +
  // refetch fires after another save in the same session).
  useEffect(() => { setDraft(initial); }, [initial]);

  const dirty = String(draft || '').trim() !== String(initial || '').trim();
  const parsedNum = Number(String(draft || '').trim());
  const isValid = !draft || (Number.isFinite(parsedNum) && parsedNum >= 1 && parsedNum <= 50);

  async function onSave() {
    if (saving || !dirty || !isValid) return;
    setSaving(true);
    try {
      const value = String(draft || '').trim() || null;
      const payload = {
        name: existing?.name || MAX_SEND_COUNT_KEY,
        label: existing?.label || MAX_SEND_COUNT_KEY,
        value,
        mandatory: !!existing?.mandatory,
      };
      if (existing?.id) {
        await api.put<{ updated: boolean }>(`/admin/clients/custom-properties/${existing.id}`, payload as never);
      } else {
        await api.post<{ id: number }>(`/admin/clients/${clientId}/custom-properties`, payload as never);
      }
      onSaved();
      showToast({ variant: 'success', message: 'Send cap updated.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border bg-card px-3 py-2.5 flex flex-col gap-2">
      <div>
        <div className="text-sm font-medium">{MAX_SEND_COUNT_KEY}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Per-client cap on WhatsApp magic-link sends per Unconfirmed order. Leave blank to use the platform default (3). Admins can override on a per-send basis from the Trigger / Retrigger popup.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="3"
          className="w-24"
          disabled={!canEdit || saving}
        />
        <Button
          size="sm"
          onClick={onSave}
          disabled={!canEdit || saving || !dirty || !isValid}
          title={!isValid ? 'Enter a number between 1 and 50' : (dirty ? 'Save' : 'No changes')}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
