'use client';

/*
 * Client Bulk Upload page — /clients/bulk-upload
 *
 * Two actions supported:
 *   spoc           → bulk-assign Primary/Secondary SPOCs
 *   monthly_revenue → bulk-set monthly revenue per client
 *
 * Template download: POST /admin/clients/bulk-template { action, clientIds }
 *   → binary .xlsx — fetched authenticated via downloadXlsx (bearer + cookie).
 *
 * Upload flow (two-step):
 *   1. "Upload" → POST /admin/clients/bulk-upload?dryRun=true
 *      Shows results under an amber "Dry Run" banner.
 *   2. "Apply Changes" → re-POST same file with dryRun=false → green "Applied" state.
 *
 * Permission gate: isClientAddNew gates the Upload + Apply buttons.
 * Client multi-select: SearchMultiSelect with options from
 *   GET /shared/lookup/clients?limit=500  (useFetch — no raw useEffect).
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Upload, CheckCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DownloadButton } from '@/components/ui/download-button';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { showToast } from '@/components/ui/toast';
import { useFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { api, ApiError } from '@/lib/api';

type BulkAction = 'spoc' | 'monthly_revenue';

type BulkResult = {
  rowNumber: number;
  clientId?: number;
  clientName?: string;
  status: 'updated' | 'invalid' | 'skipped' | 'failed';
  errors?: string[];
  reason?: string;
};

type BulkUploadResponse = {
  summary: {
    total: number;
    updated: number;
    invalid: number;
    skipped: number;
    failed: number;
  };
  results: BulkResult[];
  dryRun?: boolean;
};

type LookupClient = {
  // /shared/lookup/clients returns raw client rows (client_id / client_name),
  // NOT {value,label} — map them in clientOptions below.
  client_id: number;
  client_name: string;
};

type ClientLookupResponse = {
  items?: LookupClient[];
};

const ACTION_OPTIONS = [
  { value: 'spoc', label: 'Client SPOC' },
  { value: 'monthly_revenue', label: 'Monthly Revenue' },
];

function statusChip(status: BulkResult['status']) {
  const map: Record<BulkResult['status'], string> = {
    updated: 'bg-success-tint text-success-strong border border-success/30',
    invalid: 'bg-urgent-tint text-urgent-strong border border-urgent/30',
    skipped: 'bg-warning-tint text-warning-strong border border-warning/30',
    failed:  'bg-urgent-tint text-urgent-strong border border-urgent/30',
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${map[status]}`}>
      {status}
    </span>
  );
}

/** POST helper — builds FormData with file + action + optional dryRun flag. */
async function postBulkUpload(
  file: File,
  action: string,
  dryRun: boolean,
): Promise<BulkUploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('action', action);
  fd.append('dryRun', String(dryRun));
  return api.post<BulkUploadResponse>('/admin/clients/bulk-upload', fd);
}

export default function BulkUploadPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isClientAddNew']);
  const router = useRouter();

  // Client multi-select — options from shared lookup endpoint
  const [selectedClientIds, setSelectedClientIds] = useState<Array<string | number>>([]);
  const { data: lookupRaw, loading: lookupLoading } = useFetch<ClientLookupResponse | LookupClient[]>(
    '/shared/lookup/clients?limit=500',
  );

  // Normalise the lookup response — the endpoint may return { items } or a bare array
  const clientOptions: Array<{ value: string | number; label: string }> = (() => {
    if (!lookupRaw) return [];
    const arr = Array.isArray(lookupRaw) ? lookupRaw : (lookupRaw.items ?? []);
    return (arr as LookupClient[]).map((c) => ({ value: c.client_id, label: c.client_name }));
  })();

  // Action select
  const [action, setAction] = useState<string>('');

  // Template download
  const [downloading, setDownloading] = useState(false);

  async function onDownloadTemplate() {
    if (!action) {
      showToast({ variant: 'error', message: 'Select an action first.' });
      return;
    }
    setDownloading(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const url = `${base}/admin/clients/bulk-template`;
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: action as BulkAction,
          clientIds: selectedClientIds.map(Number),
        }),
        cache: 'no-store',
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j?.error) msg = String(j.error); } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `bulk-${action}-template.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' });
    } finally {
      setDownloading(false);
    }
  }

  // File upload — two-step: dry-run preview → Apply Changes
  const fileRef = useRef<HTMLInputElement>(null);

  /** Phase: idle → previewing (dry-run shown) → applied (committed) */
  type UploadPhase = 'idle' | 'previewing' | 'applied';
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<BulkUploadResponse | null>(null);

  async function onUpload() {
    if (!action) {
      showToast({ variant: 'error', message: 'Select an action first.' });
      return;
    }
    const file = fileRef.current?.files?.[0];
    if (!file) {
      showToast({ variant: 'error', message: 'Choose an .xlsx file first.' });
      return;
    }
    setUploading(true);
    setResult(null);
    setPhase('idle');
    try {
      const res = await postBulkUpload(file, action, true /* dryRun */);
      setResult(res);
      setPhase('previewing');
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Upload failed.' });
    } finally {
      setUploading(false);
    }
  }

  async function onApply() {
    const file = fileRef.current?.files?.[0];
    if (!file || !action) return;
    setApplying(true);
    try {
      const res = await postBulkUpload(file, action, false /* commit */);
      setResult(res);
      setPhase('applied');
      showToast({
        variant: 'success',
        message: `Applied — ${res?.summary.updated ?? 0} row(s) updated.`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Apply failed.' });
    } finally {
      setApplying(false);
    }
  }

  const canDownloadTemplate = !!action && selectedClientIds.length > 0;
  const canUpload = !!action && !!can.isClientAddNew;

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Page header — Back sits ABOVE the title */}
      <div className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/clients')}
          className="gap-1 -ml-2 h-auto px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Bulk Upload</h1>
          <p className="text-xs text-muted-foreground">Upload Client SPOCs or Monthly Revenue in bulk via .xlsx template.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Bulk Upload Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Section A — Client Multi-Select */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Select Clients</label>
            <SearchMultiSelect
              value={selectedClientIds}
              onChange={setSelectedClientIds}
              options={clientOptions}
              placeholder={lookupLoading ? 'Loading clients…' : 'Select clients…'}
              disabled={lookupLoading}
              selectedLabel="clients"
            />
            {selectedClientIds.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {selectedClientIds.map((id) => {
                  const opt = clientOptions.find((o) => String(o.value) === String(id));
                  return (
                    <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                      {opt?.label ?? String(id)}
                      <button
                        type="button"
                        onClick={() => setSelectedClientIds((prev) => prev.filter((v) => String(v) !== String(id)))}
                        className="text-muted-foreground hover:text-foreground leading-none"
                        aria-label={`Remove ${opt?.label ?? id}`}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section B — Action Select */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Action</label>
            <SearchSelect
              value={action}
              onChange={setAction}
              options={ACTION_OPTIONS}
              placeholder="— Select An Action —"
            />
          </div>

          {/* Section C — Download Template + Upload */}
          <div className="space-y-3">
            <div className="text-sm font-medium">Template &amp; Upload</div>
            <div className="flex flex-wrap items-center gap-2">
              <DownloadButton
                onClick={onDownloadTemplate}
                downloading={downloading}
                disabled={!canDownloadTemplate}
                label="Download Template"
                loadingLabel="Preparing…"
                title={
                  !action
                    ? 'Select an action first'
                    : selectedClientIds.length === 0
                      ? 'Select at least one client'
                      : 'Download pre-filled .xlsx template'
                }
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end pt-1">
              <div className="sm:col-span-8">
                <label className="text-xs font-medium block mb-1">Upload File (.xlsx)</label>
                <Input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={uploading || applying}
                  onChange={() => {
                    // Reset state when a new file is chosen
                    setResult(null);
                    setPhase('idle');
                  }}
                />
              </div>
              <div className="sm:col-span-4 flex items-end">
                <Button
                  onClick={onUpload}
                  disabled={!canUpload || uploading || applying}
                  className="w-full"
                  title={!can.isClientAddNew ? 'You do not have permission to upload' : (!action ? 'Select an action first' : '')}
                >
                  <Upload className="size-4 mr-1" />
                  {uploading ? 'Checking…' : 'Upload'}
                </Button>
              </div>
            </div>
          </div>

          {/* Dry-Run Banner + Apply Changes button */}
          {phase === 'previewing' && result && (
            <div className="rounded-md border border-warning/30 bg-warning-tint px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-sm text-warning-strong font-medium leading-snug">
                Dry Run — No Changes Applied Yet. Review Below, Then Apply.
              </div>
              <Button
                onClick={onApply}
                disabled={applying}
                className="shrink-0"
              >
                <CheckCircle className="size-4 mr-1" />
                {applying ? 'Applying…' : 'Apply Changes'}
              </Button>
            </div>
          )}

          {/* Applied banner */}
          {phase === 'applied' && (
            <div className="rounded-md border border-success/30 bg-success-tint px-4 py-3 text-sm text-success-strong font-medium">
              Applied — Changes have been saved successfully.
            </div>
          )}

          {/* Results table */}
          {result && (
            <div className="space-y-2 pt-1">
              <div className="text-sm font-medium">
                {phase === 'previewing' ? 'Dry Run Preview' : 'Upload Results'} — Total {result.summary.total} ·{' '}
                <span className="text-success-strong">Updated {result.summary.updated}</span> ·{' '}
                {result.summary.skipped !== undefined && (
                  <><span className="text-warning-strong">Skipped {result.summary.skipped}</span> · </>
                )}
                <span className="text-urgent-strong">
                  Invalid {result.summary.invalid}
                  {result.summary.failed !== undefined ? ` · Failed ${result.summary.failed}` : ''}
                </span>
              </div>
              <div className="max-h-72 overflow-auto border rounded text-xs">
                <table className="w-full">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium">Row #</th>
                      <th className="text-left px-2 py-1.5 font-medium">Client</th>
                      <th className="text-left px-2 py-1.5 font-medium">Status</th>
                      <th className="text-left px-2 py-1.5 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {result.results.map((r, i) => (
                      <tr
                        key={i}
                        className={
                          r.status === 'updated'
                            ? 'bg-success-tint/30'
                            : r.status === 'skipped'
                              ? 'bg-warning-tint/30'
                              : 'bg-urgent-tint/30'
                        }
                      >
                        <td className="px-2 py-1.5 font-mono">{r.rowNumber}</td>
                        <td className="px-2 py-1.5">
                          {r.clientName ?? (r.clientId ? `#${r.clientId}` : '—')}
                        </td>
                        <td className="px-2 py-1.5">{statusChip(r.status)}</td>
                        <td className="px-2 py-1.5">
                          {r.reason ?? r.errors?.join('; ') ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
