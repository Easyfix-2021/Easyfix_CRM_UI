'use client';

/*
 * Manage Pincodes — Settings page (uses tbl_pincode, EasyFix's generic
 * pincode catalog — distinct from pincode_firefox_city_mapping which is
 * firefox-client-specific data).
 *
 * Surface:
 *   - Filterable table: pincode | location | city | district | state | status
 *   - Status pill: LOCAL / TRAVEL (computed from active+verified easyfixers
 *     in the pincode's city). UNZONED is detected at job-create time and
 *     never appears in this list.
 *   - Add/Edit modal — full field set (pincode, location, city dropdown,
 *     district override).
 *   - Bulk Excel upload with dry-run.
 *
 * Backend: /api/admin/pincodes (routes/admin/pincodes.js +
 *   services/pincode.service.js + services/pincode-upload.service.js).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MapPin, Search, Plus, Pencil, Trash2, Upload, Download,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type Pincode = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_id: number | null;
  city_name: string | null;
  district: string | null;
  state_name: string | null;
  is_active: boolean;
  status: 'LOCAL' | 'TRAVEL';
  active_efr_count: number;
};

type ListResponse = {
  items: Pincode[];
  total: number;
};

type StatusFilter = 'ALL' | 'LOCAL' | 'TRAVEL';
const PAGE_SIZE = 100;

export default function ManagePincodesPage() {
  const confirm = useConfirm();
  const lookup  = useLookup();
  const { me } = useMe();
  // Permission gating — keys follow the legacy `is{Entity}{Verb}` convention.
  // Production rollout requires seeding the corresponding rows in `menu_action`
  // and assigning them to the Admin role via Manage Roles → action checkboxes.
  const can = actionFlags(me, ['isPincodeAddNew', 'isPincodeEdit', 'isPincodeUpload']);

  const [items, setItems] = useState<Pincode[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Pincode | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Help panel — collapsed by default (operator-confirmed: most uses of
  // this page are routine, not first-time onboarding). Persisted state
  // means anyone who deliberately opens it stays opened next visit.
  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pincodes-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('pincodes-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  // Debounced server-side search to keep payloads small even as the catalog grows.
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
  }, [search, statusFilter]);

  useEffect(() => { void fetchList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page]);

  async function fetchList() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const data = await api.get<ListResponse>(`/admin/pincodes?${params}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load pincodes');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(p: Pincode) {
    const ok = await confirm({
      title: 'Deactivate pincode?',
      description: `${p.pincode} (${p.city_name ?? 'unknown city'}) will be marked inactive. Historical jobs that reference it stay intact; new jobs created with this pincode after deactivation are flagged Unzoned. You can reactivate later by editing and toggling "Active".`,
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/pincodes/${p.pincode_id}`);
      void fetchList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Deactivate failed');
    }
  }

  async function downloadTemplate() {
    try {
      const token = localStorage.getItem('crm_auth_token');
      const url = `${process.env.NEXT_PUBLIC_API_URL || '/api'}/admin/pincodes/template/download`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Template download failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'manage-pincodes-template.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="size-6" /> Manage Pincodes
          </h1>
          <p className="text-sm text-muted-foreground">
            EasyFix-owned pincode catalog. Local/Travel status reflects current technician availability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isPincodeUpload && (
            <Button variant="outline" onClick={downloadTemplate}>
              <Download className="size-4 mr-1" /> Template
            </Button>
          )}
          {can.isPincodeUpload && (
            <Button variant="outline" onClick={() => setUploadOpen(true)}>
              <Upload className="size-4 mr-1" /> Upload Excel
            </Button>
          )}
          {can.isPincodeAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Pincode
            </Button>
          )}
        </div>
      </div>

      {/* Expandable docs */}
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
            <span className="font-medium">How Pincode management works</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-3 border-t">
              <section>
                <h3 className="font-semibold text-foreground mb-1">1. The master list</h3>
                <p>
                  Canonical list of pincodes the platform serves. Each row maps a 6-digit pincode to a city,
                  with optional location label and district override. The platform routes jobs to technicians
                  whose service zone covers this pincode&apos;s city.
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">2. How a pincode gets a status</h3>
                <p>The status badge is computed live on every page load — no stored flag to maintain:</p>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
                      <CheckCircle2 className="size-3" /> Local
                    </span>{' — '}
                    at least one active and verified Easyfixer is mapped to a zone covering this pincode&apos;s
                    city. No travel charge applies.
                  </li>
                  <li>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                      Travel
                    </span>{' — '}
                    pincode is listed but no active Easyfixer is currently available in the area.
                    Jobs in this pincode get a <strong>travel charge</strong> (rate-card defined).
                  </li>
                  <li>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                      Unzoned
                    </span>{' — '}
                    a job was created with a pincode <em>not</em> in this list. The system flags the job,
                    sends an alert to the Project Manager, and treats the job as Travel until the pincode is
                    added here. Won&apos;t appear in this table — only on jobs.
                  </li>
                </ul>
                <p className="mt-2">
                  <strong className="text-foreground">Status changes by itself.</strong> When a technician is
                  onboarded, deactivated, or moved to a different zone, the affected pincodes flip between
                  Local and Travel automatically on the next page load.
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">3. How to add pincodes</h3>
                <ul className="list-disc pl-5 space-y-1">
                  <li>
                    <strong className="text-foreground">One at a time:</strong> click <em>+ Add Pincode</em>,
                    fill in the 6-digit code, optional location, city (dropdown), and optional district.
                  </li>
                  <li>
                    <strong className="text-foreground">In bulk:</strong> click <em>Template</em> for an Excel
                    file with the city dropdown pre-filled and locked. Fill the Pincodes sheet, then upload.
                    Run a <em>Dry-run</em> first to validate without inserting — the report shows which rows
                    would succeed, fail, or be skipped (already in the catalog).
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">4. What happens at job creation</h3>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>Customer enters a pincode on a new job.</li>
                  <li>
                    Platform looks up the pincode here. <strong className="text-foreground">Found</strong> →
                    job inherits Local/Travel status. <strong className="text-foreground">Not found</strong>{' '}
                    → job is marked <em>Unzoned</em>, PM alert fires, travel charge applied until you add the
                    pincode here.
                  </li>
                  <li>
                    Auto-allocation picks a technician from the matching zone (Local) or from the nearest
                    serviceable zone with a travel reimbursement (Travel).
                  </li>
                </ol>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">5. Editing and deactivating</h3>
                <p>
                  The pincode itself is the row key — to change it, deactivate and re-add. Other fields
                  (location, city, district) are editable any time. Deactivating is a soft-delete: the row
                  hides from the default list but historical jobs that reference it remain intact. You can
                  reactivate later by toggling &quot;Active&quot; in the edit modal.
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
              placeholder="Search by pincode, location or city…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['ALL', 'LOCAL', 'TRAVEL'] as StatusFilter[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={statusFilter === s ? 'default' : 'outline'}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'ALL' ? 'All' : s === 'LOCAL' ? 'Local' : 'Travel'}
              </Button>
            ))}
          </div>
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
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Pincode</th>
                <th className="!text-left">Location</th>
                <th className="!text-left">City</th>
                <th className="!text-left">District</th>
                <th className="!text-left">State</th>
                <th className="!text-center">Status</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">No pincodes match the current filters.</td></tr>
              )}
              {!loading && items.map((p) => (
                <tr key={p.pincode_id}>
                  <td className="!text-left font-mono">{p.pincode}</td>
                  <td className="!text-left">{p.location ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{p.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{p.district ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{p.state_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-center">
                    <StatusPill status={p.status} count={p.active_efr_count} />
                  </td>
                  <td className="!text-right">
                    {can.isPincodeEdit ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(p); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(p)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">view-only</span>
                    )}
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

      <PincodeFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        cities={lookup.cities.map((c) => ({ city_id: c.city_id, city_name: c.city_name }))}
        onSaved={() => { setModalOpen(false); void fetchList(); }}
      />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onCommitted={() => { setUploadOpen(false); void fetchList(); }}
      />
    </div>
  );
}

// ─── Status pill ────────────────────────────────────────────────────
function StatusPill({ status, count }: { status: 'LOCAL' | 'TRAVEL'; count: number }) {
  if (status === 'LOCAL') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="size-3" /> Local · {count} tech
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
      Travel
    </span>
  );
}

// ─── Add/Edit modal ─────────────────────────────────────────────────
function PincodeFormModal({
  open, onClose, editing, cities, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: Pincode | null;
  cities: Array<{ city_id: number; city_name: string }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [pincode,  setPincode]  = useState('');
  const [location, setLocation] = useState('');
  const [cityId,   setCityId]   = useState<number | ''>('');
  const [district, setDistrict] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPincode (editing?.pincode  ?? '');
      setLocation(editing?.location ?? '');
      setCityId  (editing?.city_id  ?? '');
      setDistrict(editing?.district ?? '');
      setIsActive(editing?.is_active ?? true);
      setError(null);
    }
  }, [open, editing]);

  // City picker: a search input + scrollable click-list. Avoids native
  // <select size> quirks (some browsers fire onChange only on commit, not
  // on highlight, so the visually-selected option didn't actually update
  // state — caused "City is required" errors after picking). The list
  // shows ALL cities; the search filters in-memory.
  const [cityQuery, setCityQuery] = useState('');
  const filteredCities = useMemo(() => {
    const q = cityQuery.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => c.city_name.toLowerCase().includes(q));
  }, [cities, cityQuery]);

  // Show the selected city's name in the picker header so users see what
  // they've chosen even after scrolling away from it in the list.
  const selectedCityName = useMemo(
    () => cities.find((c) => c.city_id === cityId)?.city_name ?? null,
    [cities, cityId],
  );

  async function handleSubmit() {
    setError(null);
    if (!isEdit && !/^\d{6}$/.test(pincode)) { setError('Pincode must be exactly 6 digits'); return; }
    if (!cityId) { setError('City is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/pincodes/${editing!.pincode_id}`, {
          location:  location || null,
          city_id:   Number(cityId),
          district:  district || null,
          is_active: isActive,
        });
      } else {
        await api.post('/admin/pincodes', {
          pincode,
          location: location || null,
          city_id:  Number(cityId),
          district: district || null,
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
          <DialogTitle>{isEdit ? 'Edit Pincode' : 'Add Pincode'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Pincode *</label>
            <Input
              value={pincode}
              onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 digits"
              disabled={isEdit}
              className="font-mono"
            />
            {isEdit && (
              <p className="text-xs text-muted-foreground mt-1">
                Pincode is the row key; to change it, deactivate and re-add.
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">Location</label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder='e.g. "Sector 18", "Andheri East" — optional'
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">City *</label>
            <Input
              value={cityQuery}
              onChange={(e) => setCityQuery(e.target.value)}
              placeholder="Search cities…"
              className="mb-1"
            />
            {selectedCityName && (
              <div className="text-xs text-muted-foreground mb-1">
                Selected: <span className="font-medium text-foreground">{selectedCityName}</span>
              </div>
            )}
            <div className="border rounded bg-background max-h-48 overflow-auto" role="listbox" aria-label="Cities">
              {filteredCities.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No cities match.</div>
              ) : filteredCities.map((c) => {
                const isSelected = c.city_id === cityId;
                return (
                  <button
                    type="button"
                    key={c.city_id}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => setCityId(c.city_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 ${isSelected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                  >
                    {c.city_name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">District (optional)</label>
            <Input
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              placeholder="Inherits the city's district if blank"
            />
          </div>

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
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
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Pincode'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk upload modal ──────────────────────────────────────────────
type UploadResult = {
  summary: { totalRows: number; createdCount: number; failedCount: number; skipCount: number; dryRun: boolean };
  results: Array<{
    rowNumber: number | null;
    status: 'created' | 'skipped' | 'failed';
    pincode?: string;
    reason?: string;
    errors?: string[];
  }>;
};

function UploadModal({
  open, onClose, onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<UploadResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'dry-run' | 'committed' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setFile(null); setReport(null); setPhase('idle'); setError(null); }
  }, [open]);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post<UploadResult>(`/admin/pincodes/upload?dryRun=${dryRun}`, fd);
      setReport(r);
      setPhase(dryRun ? 'dry-run' : 'committed');
      if (!dryRun) onCommitted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Pincodes (Bulk)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Use the &quot;Template&quot; button on the parent page to download a starter file.
            Run a dry-run first — it validates rows without inserting anything.
          </p>
          <Input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setPhase('idle'); }}
          />

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          {report && (
            <div className="border rounded p-3 bg-muted/40 space-y-2 text-sm">
              <div className="font-medium">
                {phase === 'dry-run' ? 'Dry-run results' : 'Upload complete'}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Stat label="Total"   value={report.summary.totalRows} />
                <Stat label="Created" value={report.summary.createdCount} tone="ok" />
                <Stat label="Skipped" value={report.summary.skipCount} tone="warn" />
                <Stat label="Failed"  value={report.summary.failedCount} tone="err" />
              </div>
              {!!report.results.length && (
                <div className="max-h-56 overflow-auto border rounded">
                  <table className="data-table w-full text-xs">
                    <thead>
                      <tr><th>Row</th><th>Status</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {report.results.slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td className="!text-center">{r.rowNumber ?? '—'}</td>
                          <td className="!text-center">{r.status}</td>
                          <td className="!text-left">
                            {r.status === 'failed' ? (r.errors?.join('; ') ?? '') : (r.reason ?? r.pincode ?? '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
            <Button variant="outline" disabled={!file || busy} onClick={() => send(true)}>
              {busy && phase === 'idle' ? 'Validating…' : 'Dry-run'}
            </Button>
            <Button disabled={!file || busy || (phase === 'dry-run' && (report?.summary.failedCount ?? 0) > 0)}
                    onClick={() => send(false)}>
              {busy && phase === 'dry-run' ? 'Uploading…' : 'Commit Upload'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'err' }) {
  const color =
    tone === 'ok' ? 'text-emerald-700'
      : tone === 'warn' ? 'text-amber-700'
      : tone === 'err' ? 'text-red-700'
      : '';
  return (
    <div className="border rounded p-2 bg-background">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
