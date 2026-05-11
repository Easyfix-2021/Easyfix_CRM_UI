'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Search, ChevronLeft, ChevronRight, Eye,
  CalendarClock, PlayCircle, CheckCircle2, CalendarCheck,
  UserPlus, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatDate, formatEasyfixerName, statusColorClass, statusLabel } from '@/lib/utils';
import { TABS } from '@/lib/job-tabs';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { AssignTechnicianModal, type AssignMode } from '@/components/job/AssignTechnicianModal';
import { useSort, SortHeader } from '@/lib/use-sort';
import { useConfirm } from '@/components/ui/confirm-dialog';

/*
 * MY ORDERS — user-scoped view of tbl_job.
 *
 * Data model parity with legacy CRM:
 *   - Legacy `userOwnerJob` + `dashboardChecking?enumDesc=<value>` actions
 *     both call `sp_ef_user_owner_job_list(userId, roleId, …)`. The SP does
 *     role-aware visibility expansion — admin + supervisor-style roles see
 *     their whole team's jobs, regular users see only their own.
 *   - We approximate that behaviour in the app layer:
 *       role.group === 'admin' → no owner filter (see everything — matches
 *                                 how a project manager / ops admin uses it)
 *       otherwise               → filter by ownerId = me.user.user_id
 *     This preserves the "I can see unconfirmed orders my team owns" flow
 *     for admins while keeping regular users focused on their own queue.
 *
 * UI-wise this is intentionally its own page (not /jobs with a scope pill):
 *   - Distinct title "My Orders" so ops know which flow they're in.
 *   - Same 11-tab lifecycle nav as /jobs (imported from lib/job-tabs.ts so
 *     the two pages never drift on bucket definitions).
 *   - Same row-level quick actions as /jobs (View / Schedule / Check-In /
 *     Check-Out) so muscle memory carries across.
 *   - Reuses JobModal for create/view/edit/assign/change-owner.
 *
 * Reusable pieces:
 *   - TABS, countFor, CountsResp from lib/job-tabs
 *   - JobModal + all its internal dialogs (Assign, AutoAssign, ChangeOwner)
 *   - Card / Button / Input / SortHeader / LoadBtn
 *   - statusLabel + statusColorClass
 */

type JobRow = {
  job_id: number; job_reference_id: string | null; client_ref_id: string | null;
  job_status: number; job_type: string; source_type: string | null;
  job_desc: string | null;
  created_date_time: string; requested_date_time: string; scheduled_date_time: string | null;
  checkin_date_time: string | null; checkout_date_time: string | null;
  fk_customer_id: number; customer_name: string | null; customer_mob_no: string | null;
  fk_client_id: number; client_name: string | null;
  fk_easyfixter_id: number | null; easyfixer_name: string | null;
  job_owner: number | null; owner_name: string | null;
  fk_address_id: number; city_name: string | null;
};
type Resp = { items: JobRow[]; total: number; limit: number; offset: number };

const PAGE_SIZE = 50;

export default function MyOrdersPage() {
  const { me } = useMe();
  // Permission gating for the per-row action icons. View (Eye) stays open
  // for everyone with access to this screen — it's read-only. Every other
  // icon corresponds to a mutation and gets gated. Granular keys mirror
  // legacy CRM convention: assign/reassign/status are three distinct
  // permissions because operations teams often grant some but not others.
  const canJob = actionFlags(me, [
    'isJobConfirm',       // Confirm unconfirmed (status 9 → 0)
    'isJobAssign',        // Assign / Schedule (status 0 → 1)
    'isJobReassign',      // Reassign already-scheduled (status 1)
    'isJobStatusChange',  // Check-In / Check-Out / Completion
  ]);
  // Read the URL's ?tab=<slug> synchronously so the FIRST load fires with the
  // right filter. Previously tab initialised to 'all', and a follow-up
  // useEffect read the URL after mount — so the initial fetch returned every
  // job, then a second fetch overwrote it with the unconfirmed list. On slow
  // networks that caused a flash of "all jobs" on the Unconfirmed page.
  // useSearchParams() is stable at first render in Next.js 15's App Router,
  // so we can safely hydrate state from it inside useState's initializer.
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab');
    return t && TABS.some((x) => x.value === t) ? t : 'all';
  });
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  /*
   * Role-aware owner filter: admin-group users see all jobs here (matches
   * legacy SP behaviour where role_id determines visibility expansion);
   * everyone else gets their own jobs only. Computed fresh each render from
   * auth — no extra state needed.
   */
  const isAdmin = me?.role?.group === 'admin';
  const scopedOwnerId = isAdmin ? undefined : me?.user.user_id;

  // Cache keyed by tab+offset so switching tabs back feels instant. Bust
  // every key on any mutation (modal save, row quick-action) — simpler than
  // per-tab invalidation and the list is small enough that a refetch is cheap.
  const cacheRef = useRef<Map<string, { at: number; data: Resp }>>(new Map());
  const TAB_CACHE_TTL = 30_000;

  async function load(reset = false, force = false) {
    const tabDef = TABS.find((t) => t.value === tab);
    const off = reset ? 0 : offset;
    const key = `${tab}|${off}|${scopedOwnerId ?? 'admin-all'}`;

    if (!force) {
      const hit = cacheRef.current.get(key);
      if (hit && Date.now() - hit.at < TAB_CACHE_TTL) {
        setData(hit.data);
        if (reset) setOffset(0);
        return;
      }
    }

    setLoading(true);
    try {
      const r = await api.get<Resp>('/admin/jobs', {
        status:    tabDef?.statuses ? undefined : tabDef?.status,
        statuses:  tabDef?.statuses ? tabDef.statuses.join(',') : undefined,
        assigned:  tabDef?.assigned === undefined ? undefined : String(tabDef.assigned),
        limit: PAGE_SIZE, offset: off,
        ownerId: scopedOwnerId,
      });
      setData(r);
      cacheRef.current.set(key, { at: Date.now(), data: r });
      if (reset) setOffset(0);
    } finally { setLoading(false); }
  }

  // Refetch on tab change, offset change, and when auth resolves so admin vs.
  // non-admin scoping takes effect as soon as we know who the user is.
  useEffect(() => { setOffset(0); load(true, true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, scopedOwnerId]);
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset]);

  // (refreshCounts removed with the pill bar — each sub-menu is its own page
  // so we don't need cross-tab counts; `data.total` in the subtitle covers
  // the "how many in this bucket" question.)

  // Deep-link tab support: dashboard cards + sidebar My Orders sub-menus link
  // to /my-orders?tab=<slug>. Initial hydration happens in useState above; this
  // effect handles SUBSEQUENT URL changes (sidebar click while already on
  // /my-orders) so switching between My Orders sub-items updates the filter.
  const router = useRouter();
  useEffect(() => {
    const t = searchParams.get('tab');
    const resolved = t && TABS.some((x) => x.value === t) ? t : 'all';
    if (resolved !== tab) {
      setTab(resolved);
      setOffset(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Assign / Reassign Technician modal — driven by row icon clicks. Shared
  // component (components/job/AssignTechnicianModal.tsx); same backend
  // pipeline as on-create auto-assign.
  const [assignModal, setAssignModal] = useState<{ open: boolean; jobId: number | null; mode: AssignMode }>({
    open: false, jobId: null, mode: 'assign',
  });

  // Modal state + URL deep-link for ?view=<id>.
  const [modal, setModal] = useState<{ open: boolean; mode: JobModalMode; id?: number }>({ open: false, mode: 'create' });
  useEffect(() => {
    const v = searchParams.get('view');
    if (v && /^\d+$/.test(v)) setModal({ open: true, mode: 'view', id: Number(v) });
  }, [searchParams]);
  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
    if (searchParams.get('view')) router.replace('/my-orders');
  }
  function openView(id: number) { setModal({ open: true, mode: 'view', id }); }
  // Unconfirmed orders open the dedicated confirm form (edit layout + services
  // basket + "Confirm & Schedule" footer), mirroring the legacy addEditJob flow.
  function openConfirm(id: number) { setModal({ open: true, mode: 'confirm', id }); }

  // Row-level quick action — same pattern as /jobs. Confirms, PATCHes status,
  // busts cache, refetches list + counts so badges stay coherent.
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const confirmAction = useConfirm();
  async function quickStatusChange(jobId: number, toStatus: number, verb: string) {
    const ok = await confirmAction({
      title: `${verb} job #${jobId}?`,
      description: `The job's status will be updated. You can continue working while the update applies.`,
      confirmLabel: verb,
    });
    if (!ok) return;
    setRowBusy(jobId);
    try {
      await api.patch(`/admin/jobs/${jobId}/status`, { status: toStatus });
      cacheRef.current.clear();
      await load(false, true);
    } catch (e) {
      setErrorMsg(`${verb} failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally { setRowBusy(null); }
  }

  // Client-side search over the currently-loaded page.
  const filteredItems = (data?.items ?? []).filter((j) => {
    if (!q) return true;
    const needle = q.toLowerCase();
    const haystacks = [
      j.job_id, j.job_reference_id, j.client_ref_id,
      j.client_name, j.customer_name, j.customer_mob_no,
      j.city_name, j.easyfixer_name, j.owner_name, j.job_type,
    ];
    return haystacks.some((h) => h != null && String(h).toLowerCase().includes(needle));
  });
  const { sorted, sortKey, sortDir, toggle } = useSort<JobRow>(filteredItems);

  // Resolve the current tab's human label for the page header — each sidebar
  // sub-menu is a standalone status page, so the tab name IS the page title.
  const activeTab = TABS.find((t) => t.value === tab);

  return (
    <div className="space-y-5">
      {errorMsg && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="text-xs hover:underline">Dismiss</button>
        </div>
      )}
      <div className="flex items-end justify-between">
        <div>
          {/*
            * Page title = "My Orders · <lifecycle phase>" when a tab is set,
            * plain "My Orders" for the 'all' default. Ops land here directly
            * from a sidebar sub-menu so the tab context is already baked into
            * their click — no need for an in-page tab selector.
            */}
          <h1 className="text-2xl font-semibold">
            My Orders
            {activeTab && activeTab.value !== 'all' && (
              <span className="text-muted-foreground font-normal"> · {activeTab.label}</span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data?.total.toLocaleString() ?? '…'} matching orders
            {!isAdmin && me?.user && <span> owned by <strong>{me.user.user_name}</strong></span>}
            {isAdmin && <span className="text-xs text-muted-foreground"> · viewing all (admin)</span>}
          </p>
        </div>
      </div>

      {/*
        * Pill-bar tab selector removed — each My Orders sidebar sub-menu is
        * already a dedicated status page (Unconfirmed, Pending Scheduling,
        * etc.), so an in-page tab bar would duplicate that navigation.
        * Users switch buckets via the sidebar; the URL's ?tab= param drives
        * the filter under the hood, unchanged.
        */}

      {/* Search bar */}
      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search job ref / client ref / customer name or mobile…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader<JobRow> colKey="job_id"             sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="stick-col-head stick-left">Job #</SortHeader>
                <SortHeader<JobRow> colKey="client_name"        sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Client</SortHeader>
                <SortHeader<JobRow> colKey="customer_name"      sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Customer</SortHeader>
                <SortHeader<JobRow> colKey="customer_mob_no"    sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Mobile</SortHeader>
                <SortHeader<JobRow> colKey="city_name"          sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>City</SortHeader>
                <SortHeader<JobRow> colKey="easyfixer_name"     sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Technician</SortHeader>
                <SortHeader<JobRow> colKey="requested_date_time" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Requested</SortHeader>
                <SortHeader<JobRow> colKey="job_status"         sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Status</SortHeader>
                <th className="stick-col-head stick-right text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 9 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={9} className="text-center text-muted-foreground py-8">
                  No orders in this bucket{!isAdmin ? ' owned by you' : ''}.
                </td></tr>
              )}
              {!loading && sorted.map((j) => (
                <tr key={j.job_id} className="hover:bg-muted/40">
                  <td className="stick-col stick-left font-medium">#{j.job_id}</td>
                  <td>{j.client_name ?? '—'}</td>
                  <td>{j.customer_name ?? '—'}</td>
                  <td className="text-xs text-muted-foreground">{j.customer_mob_no ?? '—'}</td>
                  <td>{j.city_name ?? '—'}</td>
                  <td>{j.easyfixer_name ? formatEasyfixerName(j.easyfixer_name) : <span className="text-muted-foreground">unassigned</span>}</td>
                  <td className="text-xs whitespace-nowrap">{j.requested_date_time ? formatDate(j.requested_date_time) : '—'}</td>
                  <td>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${statusColorClass(j.job_status)}`}>
                      {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                    </span>
                  </td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    {/* Row actions follow legacy Manage Jobs + our /jobs page convention */}
                    <div className="inline-flex items-center gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => openView(j.job_id)}
                        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                        title="View details"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {/* Unconfirmed (status=9): legacy flow was "open addEditJob
                          modal, complete details, click Book Call → status 0".
                          We mirror that: click the icon → JobModal opens; the
                          action bar there shows Edit + Confirm & Schedule so
                          ops can fill any missing fields before promoting. */}
                      {j.job_status === 9 && canJob.isJobConfirm && (
                        <button
                          type="button"
                          onClick={() => openConfirm(j.job_id)}
                          className="inline-flex items-center gap-1 text-purple-700 text-xs hover:underline"
                          title="Confirm — fill details, pick services, and move to Scheduled"
                        >
                          <CalendarCheck className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {j.job_status === 0 && canJob.isJobAssign && (
                        <>
                          <button
                            type="button"
                            onClick={() => openView(j.job_id)}
                            className="inline-flex items-center gap-1 text-sky-700 text-xs hover:underline"
                            title="Schedule — opens modal to assign a technician"
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                          </button>
                          {/*
                            * Assign Technician — opens the layered-ranking
                            * modal directly (skips the JobModal). Same
                            * backend pipeline as on-create auto-assign.
                            */}
                          <button
                            type="button"
                            onClick={() => setAssignModal({ open: true, jobId: j.job_id, mode: 'assign' })}
                            className="inline-flex items-center gap-1 text-indigo-700 text-xs hover:underline"
                            title="Assign Technician — pick from ranked list"
                          >
                            <UserPlus className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                      {j.job_status === 1 && (
                        <>
                          {canJob.isJobStatusChange && (
                            <button
                              type="button"
                              disabled={rowBusy === j.job_id}
                              onClick={() => quickStatusChange(j.job_id, 2, 'Check in')}
                              className="inline-flex items-center gap-1 text-amber-700 text-xs hover:underline disabled:opacity-50"
                              title="Check-In — technician on-site, move to In Progress"
                            >
                              <PlayCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {/*
                            * Reassign Technician — same modal, mode=reassign.
                            * Backend candidates query already excludes anyone
                            * who's previously rejected/rescheduled this job.
                            */}
                          {canJob.isJobReassign && (
                            <button
                              type="button"
                              onClick={() => setAssignModal({ open: true, jobId: j.job_id, mode: 'reassign' })}
                              className="inline-flex items-center gap-1 text-indigo-700 text-xs hover:underline"
                              title="Reassign Technician — pick a different tech from the ranked list"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </>
                      )}
                      {(j.job_status === 2 || j.job_status === 20) && canJob.isJobStatusChange && (
                        <button
                          type="button"
                          disabled={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 3, 'Check out & complete')}
                          className="inline-flex items-center gap-1 text-emerald-700 text-xs hover:underline disabled:opacity-50"
                          title="Check-Out — close the job"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <JobModal
        open={modal.open}
        mode={modal.mode}
        jobId={modal.id}
        onClose={closeModal}
        onSaved={() => { cacheRef.current.clear(); load(false, true); }}
      />

      <AssignTechnicianModal
        open={assignModal.open}
        jobId={assignModal.jobId}
        mode={assignModal.mode}
        onClose={() => setAssignModal((m) => ({ ...m, open: false }))}
        onAssigned={() => { cacheRef.current.clear(); load(false, true); }}
      />

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
          </span>
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
