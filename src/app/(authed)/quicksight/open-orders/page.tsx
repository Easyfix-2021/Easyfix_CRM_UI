'use client';

/*
 * QuickSight — Open Orders (PM open jobs) report page.
 *
 *   registry slug : openOrders   ·   urlBase: open-orders
 *   action key    : isQuickSightOpenOrdersView
 *   BE endpoints  : POST /api/admin/quicksight/open-orders/summary
 *                   POST /api/admin/quicksight/open-orders/by-owner
 *
 * Native rebuild of the legacy "Job Owner Open Orders Quicksight" page.
 * One summary row per Job Owner with the alert buckets; clicking the Total
 * cell drills into that owner's individual open jobs (modal).
 *
 * Gating: the page is gated on the per-report action key via actionFlags
 * (the family key is enforced server-side by requireQuickSight). A 403 from
 * either endpoint flips the scaffold's accessDenied panel.
 *
 * Fetch hygiene: data comes through the shared `usePostFetch` (from
 * `@/lib/hooks`) — a POST-capable sibling of the GET-only `useFetch` that
 * keeps the same dedup / Strict-Mode / cancellation guards. We never write a
 * raw useEffect+api.get (mandatory CRM_UI fetch-hooks rule); the shared hook
 * keys off url + serialized body and carries the same guarantees for both
 * POST endpoints.
 */

import { useCallback, useMemo, useState } from 'react';
import { ClipboardList, Flame, ExternalLink, Loader2 } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';
import type { SearchOption } from '@/components/ui/search-select';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import {
  QuickSightFilterBar,
  type QuickSightFilterValue,
} from '@/components/quicksight/QuickSightFilterBar';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ACTION_KEY = 'isQuickSightOpenOrdersView';
const API_BASE = '/admin/quicksight/open-orders';

/* ── Row types (mirror the BE service response) ──────────────────────── */
type SummaryRow = {
  pmUserId: number;
  pmName: string;
  unconfirmed: number;
  waitingForAllocation: number;
  runningLate: number;
  openOnApp: number;
  waitingAudit: number;
  totalAlerts: number;
  escalationCount: number;
};

type DrillRow = {
  jobID: number;
  jobAge: number;
  clientName: string;
  clientSpocName: string;
  cityMappedUser: string;
  efrID: number | null;
  efrName: string;
  jobBucketStatus: string;
  isEscalated: number;
};

/* The filter body shape both endpoints accept. */
type FilterBody = {
  clientId: number[];
  verticalId: number[];
  zonalManagerId: number[];
  serviceCategoryId: number[];
};

/* POST-based XLSX download (the shared download-xlsx helper is GET-only;
 * these endpoints validate the filter body, so the export must POST). */
async function downloadXlsxPost(path: string, body: unknown, filename: string) {
  const base = process.env.NEXT_PUBLIC_API_URL || '/api';
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* non-JSON body — keep the HTTP code */
    }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export default function OpenOrdersPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  /* ── Filter state (applied vs draft) ───────────────────────────────
   * The dropdowns edit `draft`; Filter copies draft→applied (which re-keys
   * the fetch). Mirrors the legacy submit/reset model. */
  const [draft, setDraft] = useState<FilterBody>({
    clientId: [],
    verticalId: [],
    zonalManagerId: [],
    serviceCategoryId: [],
  });
  const [applied, setApplied] = useState<FilterBody>(draft);

  /* Zonal-manager options — derived from the shared cities lookup's
   * state_user is not exposed there, so we source admin users as the
   * superset of possible city zonal owners (matches the legacy zonal list
   * being tbl_user rows). Falls back to an empty list while loading. */
  const lookup = useLookup();
  const zonalManagerOptions: SearchOption[] = useMemo(
    () => lookup.toOpts.adminUsers,
    [lookup.toOpts.adminUsers],
  );

  /* Re-fetch summary only when applied filters change (the shared hook keys
   * off url + serialized body internally). */
  const summary = usePostFetch<SummaryRow[]>(
    canView ? `${API_BASE}/summary` : null,
    applied,
    { enabled: canView },
  );

  const rows = summary.data ?? [];
  const accessDenied = canView === false || summary.status === 403;
  const isEmpty = !summary.loading && !summary.error && rows.length === 0;

  /* ── Footer totals (client-side, mirrors legacy calculateTotals) ───── */
  const totals = useMemo(() => {
    const acc = {
      waitingForAllocation: 0,
      runningLate: 0,
      escalationCount: 0,
      unconfirmed: 0,
      openOnApp: 0,
      waitingAudit: 0,
      totalAlerts: 0,
    };
    for (const r of rows) {
      acc.waitingForAllocation += r.waitingForAllocation || 0;
      acc.runningLate += r.runningLate || 0;
      acc.escalationCount += r.escalationCount || 0;
      acc.unconfirmed += r.unconfirmed || 0;
      acc.openOnApp += r.openOnApp || 0;
      acc.waitingAudit += r.waitingAudit || 0;
      acc.totalAlerts += r.totalAlerts || 0;
    }
    return acc;
  }, [rows]);

  /* ── Drill-down modal state ────────────────────────────────────────── */
  const [drill, setDrill] = useState<{ pmUserId: number; pmName: string } | null>(null);
  const drillBody = useMemo(
    () => (drill ? { ...applied, pmUserId: drill.pmUserId } : {}),
    [drill, applied],
  );
  const drillData = usePostFetch<DrillRow[]>(
    drill ? `${API_BASE}/by-owner` : null,
    drillBody,
    { enabled: !!drill },
  );

  /* ── Downloads ─────────────────────────────────────────────────────── */
  const [downloading, setDownloading] = useState(false);
  const onDownloadSummary = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadXlsxPost(
        `${API_BASE}/summary`,
        { ...applied, format: 'xlsx' },
        'open-orders-summary.xlsx',
      );
    } catch {
      /* keep silent on the page chrome; busy state simply clears */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  const [drillDownloading, setDrillDownloading] = useState(false);
  const onDownloadDrill = useCallback(async () => {
    if (!drill) return;
    setDrillDownloading(true);
    try {
      await downloadXlsxPost(
        `${API_BASE}/by-owner`,
        { ...applied, pmUserId: drill.pmUserId, format: 'xlsx' },
        `open-orders-${drill.pmName || drill.pmUserId}.xlsx`,
      );
    } catch {
      /* ignore */
    } finally {
      setDrillDownloading(false);
    }
  }, [drill, applied]);

  return (
    <ReportPageScaffold
      title="Open Orders"
      subtitle="Job Owner Open Orders — alert buckets with per-owner drill-down."
      icon={ClipboardList}
      loading={summary.loading}
      error={summary.status === 403 ? null : summary.error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownloadSummary}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <QuickSightFilterBar
            show={{
              clients: true,
              zonalManagers: true,
              verticals: true,
              serviceCategories: true,
            }}
            clients={draft.clientId}
            onClientsChange={(v) => setDraft((d) => ({ ...d, clientId: toNums(v) }))}
            zonalManagers={draft.zonalManagerId}
            onZonalManagersChange={(v) =>
              setDraft((d) => ({ ...d, zonalManagerId: toNums(v) }))
            }
            zonalManagerOptions={zonalManagerOptions}
            verticals={draft.verticalId}
            onVerticalsChange={(v) => setDraft((d) => ({ ...d, verticalId: toNums(v) }))}
            serviceCategories={draft.serviceCategoryId}
            onServiceCategoriesChange={(v) =>
              setDraft((d) => ({ ...d, serviceCategoryId: toNums(v) }))
            }
            disabled={summary.loading}
          />
          <div className="flex gap-2">
            <Button onClick={() => setApplied(draft)} disabled={summary.loading}>
              Filter
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const empty: FilterBody = {
                  clientId: [],
                  verticalId: [],
                  zonalManagerId: [],
                  serviceCategoryId: [],
                };
                setDraft(empty);
                setApplied(empty);
              }}
              disabled={summary.loading}
            >
              Reset
            </Button>
          </div>
        </div>
      }
    >
      {/* ── Summary table ── */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left">Job Owner</th>
              <th className="!text-center">Waiting For Allocation</th>
              <th className="!text-center">Running Late</th>
              <th className="!text-center">Escalation</th>
              <th className="!text-center">Unconfirmed</th>
              <th className="!text-center">Waiting To Close &gt;12 Hrs</th>
              <th className="!text-center">Waiting Audit &gt;18 Hrs</th>
              <th className="!text-center">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pmUserId}>
                <td className="!text-left font-medium">{r.pmName}</td>
                <td className="!text-center">{r.waitingForAllocation}</td>
                <td className="!text-center">{r.runningLate}</td>
                <td className="!text-center">{r.escalationCount}</td>
                <td className="!text-center">{r.unconfirmed}</td>
                <td className="!text-center">{r.openOnApp}</td>
                <td className="!text-center">{r.waitingAudit}</td>
                <td className="!text-center">
                  {r.totalAlerts > 0 ? (
                    <button
                      type="button"
                      className="font-semibold text-primary underline-offset-2 hover:underline"
                      onClick={() => setDrill({ pmUserId: r.pmUserId, pmName: r.pmName })}
                    >
                      {r.totalAlerts}
                    </button>
                  ) : (
                    r.totalAlerts
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/60 font-semibold">
              <td className="!text-left">Total</td>
              <td className="!text-center">{totals.waitingForAllocation}</td>
              <td className="!text-center">{totals.runningLate}</td>
              <td className="!text-center">{totals.escalationCount}</td>
              <td className="!text-center">{totals.unconfirmed}</td>
              <td className="!text-center">{totals.openOnApp}</td>
              <td className="!text-center">{totals.waitingAudit}</td>
              <td className="!text-center">{totals.totalAlerts}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Drill-down modal ── */}
      <Dialog
        open={!!drill}
        // eslint-disable-next-line no-restricted-syntax -- read-only drill-down modal — no form state to guard
        onOpenChange={(o) => !o && setDrill(null)}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader className="bg-sidebar text-sidebar-foreground">
            <DialogTitle className="flex items-center justify-between gap-3">
              <span>
                {drill?.pmName} — {drillData.data?.length ?? 0} Orders
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="mb-3 flex justify-end">
            <DownloadButton
              onClick={onDownloadDrill}
              disabled={drillDownloading || (drillData.data?.length ?? 0) === 0}
              downloading={drillDownloading}
              label="Download XLSX"
            />
          </div>

          {drillData.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> Loading…
            </div>
          ) : drillData.error ? (
            <div className="p-8 text-center text-sm text-red-600">{drillData.error}</div>
          ) : (drillData.data?.length ?? 0) === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No Jobs Found</div>
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="!text-left">Job ID</th>
                    <th className="!text-left">Client Name</th>
                    <th className="!text-left">Client SPOC Name</th>
                    <th className="!text-left">EasyFixer Id</th>
                    <th className="!text-left">Bucket Status</th>
                    <th className="!text-center">Age</th>
                    <th className="!text-left">City Mapped User</th>
                  </tr>
                </thead>
                <tbody>
                  {drillData.data!.map((j) => (
                    <tr key={j.jobID}>
                      <td className="!text-left">
                        <a
                          href={`/jobs?jobId=${j.jobID}&action=view`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          {j.isEscalated === 1 && (
                            <Flame className="size-4 text-orange-500" aria-label="Escalated" />
                          )}
                          {j.jobID}
                          <ExternalLink className="size-3 opacity-60" />
                        </a>
                      </td>
                      <td className="!text-left">{j.clientName}</td>
                      <td className="!text-left">{j.clientSpocName}</td>
                      <td className="!text-left">
                        {j.efrID ? `${j.efrID} - ${j.efrName}` : '-'}
                      </td>
                      <td className="!text-left">{j.jobBucketStatus}</td>
                      <td className="!text-center">{j.jobAge}</td>
                      <td className="!text-left">{j.cityMappedUser}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ReportPageScaffold>
  );
}

/* Coerce the filter widget's (string|number)[] into a clean number[]. */
function toNums(v: QuickSightFilterValue): number[] {
  return v
    .map((x) => (typeof x === 'number' ? x : Number(x)))
    .filter((n) => Number.isFinite(n));
}
