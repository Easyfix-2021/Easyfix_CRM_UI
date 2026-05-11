'use client';

/*
 * Assign / Reassign Technician — wide modal driven by the layered ranking
 * pipeline in EasyFix_Backend/services/candidate-ranking.service.js.
 *
 * Used on:
 *   - /my-orders (Pending Scheduling tab)  → mode='assign'
 *   - /my-orders (Pending Start tab)       → mode='reassign'
 *   - any future surface where ops need to pick a tech for a job
 *
 * The hard work (eligibility, scoring, deep-skill fallback, balance gate)
 * is on the backend. This component is a thin viewer + commit button.
 *
 * Backend response shape — see service docstring. Key fields the modal
 * reads:
 *   - candidates[]   the ranked + filtered list
 *   - note           'no_deep_skill_match' | 'no_eligible_techs' | null
 *   - rejected[]     L2 drops (saturated / time-conflict) for the small
 *                    operator-visible list at the bottom
 *   - alreadyAssigned indicates a reassign rather than a fresh assign
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, MapPin, Wallet, Briefcase, Star,
  Clock, Zap, UserCheck, Calendar, Search, X,
  ArrowUp, ArrowDown,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';

type Candidate = {
  efr_id: number;
  efr_name: string;
  efr_no: string | null;
  efr_email: string | null;
  city_name: string | null;
  current_balance: number;
  active_jobs: number;
  avg_rating: number;
  avg_tat_hours: number | null;
  // tat_history / sda_history flag whether the candidate has any completed
  // jobs in the lookback window. When false, the displayed value is "No
  // Completed Jobs" (versus a real 0% / 0h reading), and the score uses the
  // configured default_tat_score / default_sda_score from settings.
  tat_history: boolean;
  sda_rate: number | null;
  sda_history: boolean;
  worked_for_client: boolean;
  worked_for_vertical: boolean;
  attendance_marked: boolean;
  // True when the technician has at least one ACTIVE deep-skill mapping
  // matching the job's category (and service-type, if set). Even when the
  // L1 fallback fires and EVERY candidate has has_deep_skill=false, the
  // flag still drives a per-row red X so operators see the constraint
  // they're overriding when picking from the fallback list.
  has_deep_skill: boolean;
  score: number;
  performance: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'E';
  breakdown: {
    rating: number; tat: number; sda: number;
    worked_for_client: number; worked_for_vertical: number;
    attendance: number;
  };
  // True for the row representing the technician currently assigned to
  // this job — backend pins them at the top of the list in Reassign mode.
  is_current?: boolean;
};

type RankResponse = {
  job: {
    job_id: number;
    city_name: string | null;
    pin_code: string | null;
    service_category: string | null;
    requested_date_time: string | null;
    time_slot: string | null;
    paid_by: string | number | null;
    /** Human label resolved from the paid_by integer ('Customer' | 'NE' | 'Easyfix' | 'NA'). */
    paid_by_label: string;
    /** "Carpentry › Wood Repair" — the deep-skill required for this job. */
    deep_skill_label: string | null;
  };
  alreadyAssigned: boolean;
  note: 'no_deep_skill_match' | 'no_eligible_techs' | null;
  l1Count: number;
  l2Count: number;
  candidates: Candidate[];
  rejected: Array<{ efr_id: number; efr_name: string; reason: string }>;
  config: { account_balance_floor: number; max_concurrent: number };
};

export type AssignMode = 'assign' | 'reassign';

export function AssignTechnicianModal({
  open, onClose, onAssigned,
  jobId, mode,
}: {
  open: boolean;
  onClose: () => void;
  onAssigned?: (efrId: number, efrName: string) => void;
  jobId: number | null;
  mode: AssignMode;
}) {
  const confirmAction = useConfirm();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<RankResponse | null>(null);
  const [search, setSearch] = useState('');
  const [assigning, setAssigning] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !jobId) {
      setData(null); setErr(null); setSearch(''); setAssigning(null);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId]);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.get<RankResponse>(`/admin/jobs/${jobId}/candidates?limit=100`);
      setData(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }

  async function assign(c: Candidate) {
    if (!jobId) return;
    const verb = mode === 'reassign' ? 'Reassign' : 'Assign';
    /*
     * Manual assignment from this modal hits PATCH /admin/jobs/:id/assign,
     * which is the SAME backend path auto-assign uses post-pick. That path
     * fires (asynchronously, fire-and-forget):
     *   - TechAssigned webhook (or RescheduleTech on reassign) — dispatched
     *     to subscribed clients per webhook-event mappings.
     *   - FCM push to the chosen technician's device.
     *   - Failure-notification email if anything errors before commit.
     * All gated by per-client running_frequency + global NOTIFICATIONS_DISABLE,
     * exactly the way auto-assign honours them.
     *
     * No additional notification flags need to be passed from this modal —
     * we deliberately mirror auto-assign behaviour so manual and automated
     * paths produce the same downstream effects.
     */
    const ok = await confirmAction({
      title: `${verb} this job to ${c.efr_name}?`,
      description:
        `Job #${jobId} will be ${mode === 'reassign' ? 'reassigned' : 'assigned'} to ${c.efr_name} ` +
        `(${c.efr_no ?? '—'}, ${c.city_name ?? 'no city'}). Score ${c.score.toFixed(2)} · Grade ${c.grade}.\n\n` +
        `The technician will receive a push notification, the configured client webhook ` +
        `(${mode === 'reassign' ? 'RescheduleTech' : 'TechAssigned'}) will fire, and any failure ` +
        `notifications will route per the auto-allocation settings.` +
        (!c.has_deep_skill
          ? '\n\n⚠ This technician does NOT hold the deep-skill required for this job.'
          : ''),
      confirmLabel: `Yes, ${verb.toLowerCase()}`,
    });
    if (!ok) return;
    setAssigning(c.efr_id); setErr(null);
    try {
      await api.patch(`/admin/jobs/${jobId}/assign`, { easyfixer_id: c.efr_id });
      onAssigned?.(c.efr_id, c.efr_name);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Assign failed');
    } finally {
      setAssigning(null);
    }
  }

  // Sort state — defaults to backend order (score desc with the current
  // tech pinned first in Reassign). Click cycle on the same column:
  //   1st click → ascending
  //   2nd click → descending
  //   3rd click → off (returns to backend's default order)
  // Clicking a different column starts the cycle fresh on that column.
  // Inactive columns don't render an arrow at all — only the active sort
  // column shows up/down. Keeps the header strip visually quiet.
  type SortKey =
    | 'efr_name' | 'city_name' | 'active_jobs' | 'current_balance'
    | 'avg_rating' | 'avg_tat_hours' | 'sda_rate'
    | 'worked_for_client' | 'worked_for_vertical' | 'attendance_marked'
    | 'has_deep_skill'
    | 'score' | 'grade';
  const [sortBy,  setSortBy]  = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  function onSort(col: SortKey) {
    if (sortBy !== col) {
      // First click on this column: ascending.
      setSortBy(col); setSortDir('asc');
      return;
    }
    // Same column — advance through the 3-state cycle.
    if (sortDir === 'asc')  { setSortDir('desc'); return; }
    if (sortDir === 'desc') { setSortBy(null); setSortDir('asc'); return; }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!data) return [];
    let rows = data.candidates;
    if (q) {
      rows = rows.filter((c) =>
        c.efr_name.toLowerCase().includes(q) ||
        (c.efr_no ?? '').toLowerCase().includes(q) ||
        (c.city_name ?? '').toLowerCase().includes(q)
      );
    }
    // Sort: keep `is_current` row pinned at top, then apply user sort to
    // the rest. Without the pin, sorting would scatter the assigned tech
    // mid-list and defeat the visual "current vs replacements" comparison.
    if (sortBy) {
      const dir = sortDir === 'asc' ? 1 : -1;
      const others = rows.filter((r) => !r.is_current).slice().sort((a, b) => {
        const va: unknown = (a as unknown as Record<string, unknown>)[sortBy];
        const vb: unknown = (b as unknown as Record<string, unknown>)[sortBy];
        // null sorts last regardless of direction (so "No history" rows
        // don't bubble to the top when sorting by TAT/SDA ascending).
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        if (typeof va === 'boolean' && typeof vb === 'boolean') return ((va === vb) ? 0 : (va ? 1 : -1)) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
      const current = rows.filter((r) => r.is_current);
      rows = [...current, ...others];
    }
    return rows;
  }, [data, search, sortBy, sortDir]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        // wider than the default sm:max-w-md — this modal is data-dense.
        className="!max-w-[1200px] w-[95vw]"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'reassign' ? 'Reassign Technician' : 'Assign Technician'}
            {jobId && <span className="text-sm font-normal text-muted-foreground">· Job #{jobId}</span>}
          </DialogTitle>
        </DialogHeader>

        {/* Job context */}
        {data && (
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 -mt-1 mb-1">
            {data.job.city_name && <span><MapPin className="inline h-3 w-3 mr-0.5" />{data.job.city_name}{data.job.pin_code ? ` · ${data.job.pin_code}` : ''}</span>}
            {/*
              * Deep skill = service category › service type. The backend
              * resolves this from the job's FK columns; older jobs may
              * only have the denormalised `service_category` text, in
              * which case we use that. Either way, ALWAYS label the slot
              * "Deep Skill" so operators see the constraint clearly.
              */}
            {(data.job.deep_skill_label || data.job.service_category) && (
              <span>· Deep Skill: <strong className="text-foreground">
                {data.job.deep_skill_label ?? data.job.service_category}
              </strong></span>
            )}
            {data.job.time_slot && <span>· {data.job.time_slot}</span>}
            {data.job.paid_by_label && data.job.paid_by_label !== 'NA' && (
              <span>· Paid by: <strong className="text-foreground">{data.job.paid_by_label}</strong></span>
            )}
          </div>
        )}

        {/* Banners */}
        {data?.note === 'no_deep_skill_match' && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <strong>No technician holds the deep-skill required for this job.</strong>{' '}
              Showing all candidates that pass the other eligibility checks (active, verified,
              not a prior reject, in the customer&apos;s city). Pick someone with caution.
            </div>
          </div>
        )}
        {data?.note === 'no_eligible_techs' && (
          <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-900 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <strong>No technicians match the eligibility filters for this job.</strong>
          </div>
        )}
        {data?.alreadyAssigned && mode === 'assign' && (
          <div className="rounded-md border border-blue-300 bg-blue-50 p-2 text-xs text-blue-900">
            This job is already assigned. Use Reassign to change the technician.
          </div>
        )}

        {/* Search + summary */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Filter by name / mobile / city…" className="pl-9"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {data && (
            <div className="text-xs text-muted-foreground">
              <strong>{data.l1Count}</strong> eligible · <strong>{data.l2Count}</strong> available · <strong>{filtered.length}</strong> shown
            </div>
          )}
        </div>

        {/* Body */}
        {err && (
          <div className="text-sm text-red-700 flex items-center gap-1">
            <AlertTriangle className="h-4 w-4" /> {err}
          </div>
        )}

        {/*
          * Both-side scrollable: vertical (max-h) + horizontal (overflow-auto).
          * Technician Name is the sticky LEFT column — `position: sticky; left: 0`
          * keeps the row identifier visible while horizontal-scrolling through the
          * stat columns. Header is also sticky-top so column labels stay visible
          * while scrolling long lists vertically.
          */}
        <div className="border rounded max-h-[60vh] overflow-auto thin-scroll">
          <table className="data-table text-xs whitespace-nowrap border-separate" style={{ borderSpacing: 0 }}>
            <thead className="sticky top-0 bg-background z-20 shadow-sm">
              <tr>
                {/*
                  * Sticky header for the sticky-left body column: needs z higher
                  * than every body td (which now uses z-20 to win over scroll
                  * content), AND a solid bg so it occludes the scrolling
                  * stat-column headers. z-40 + explicit bg-white meets both.
                  */}
                <SortHeaderTH col="efr_name" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
                  className="!text-left sticky left-0 bg-white z-40 shadow-[2px_0_0_0_var(--border)] min-w-[180px]"
                >Technician Name</SortHeaderTH>
                <SortHeaderTH col="city_name"        sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-left">Location</SortHeaderTH>
                <SortHeaderTH col="has_deep_skill"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Holds an active deep-skill matching the job's service category / type">Deep Skill</SortHeaderTH>
                <SortHeaderTH col="active_jobs"      sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Active jobs (BOOKED + SCHEDULED + IN_PROGRESS)">Current Jobs</SortHeaderTH>
                <SortHeaderTH col="current_balance"  sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-right">Account Balance</SortHeaderTH>
                <SortHeaderTH col="avg_rating"       sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="90-day customer rating average">Rating</SortHeaderTH>
                <SortHeaderTH col="avg_tat_hours"    sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Average turnaround time vs. tier target">TAT (avg hours)</SortHeaderTH>
                <SortHeaderTH col="sda_rate"         sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Same-day attempt rate over the lookback window">SDA Rate</SortHeaderTH>
                <SortHeaderTH col="worked_for_client"  sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Worked for this client before?">Worked for Client</SortHeaderTH>
                <SortHeaderTH col="worked_for_vertical" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Worked in this service category before?">Worked in Vertical</SortHeaderTH>
                <SortHeaderTH col="attendance_marked" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center" title="Attendance marked today?">Attendance Today</SortHeaderTH>
                <SortHeaderTH col="score"            sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-right">Score</SortHeaderTH>
                <SortHeaderTH col="grade"            sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="!text-center">Grade</SortHeaderTH>
                <th className="!text-right whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={14} className="!text-center text-muted-foreground py-6">Loading candidates…</td></tr>
              )}
              {!loading && data && filtered.length === 0 && (
                <tr><td colSpan={14} className="!text-center text-muted-foreground py-6">
                  {data.candidates.length === 0 ? 'No technicians available.' : 'No candidates match the search.'}
                </td></tr>
              )}
              {!loading && filtered.map((c) => {
                /*
                 * Sticky-column bleed-through fix.
                 *
                 * The original `hover:bg-muted/40` on the row painted a
                 * 40%-opacity overlay — and our sticky cell's matching
                 * `group-hover:bg-muted/40` was equally translucent, so
                 * during hover BOTH layers were see-through and content
                 * from columns on the right showed under the sticky-left
                 * Technician Name cell.
                 *
                 * Fix: use FULLY OPAQUE colours on the sticky cell for
                 * both rest and hover states. The non-sticky stat cells
                 * keep their translucent hover so the row still has the
                 * subtle "you're hovering this" tint, but the sticky
                 * column always blocks the cells behind it.
                 */
                const rowBg = c.is_current ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-muted/40';
                const stickyBgStatic = c.is_current
                  ? 'bg-amber-50 group-hover:bg-amber-100'
                  : 'bg-white group-hover:bg-slate-100';
                return (
                  <tr key={c.efr_id} className={`group ${rowBg}`}>
                    <td className={`!text-left sticky left-0 z-20 ${stickyBgStatic} shadow-[2px_0_0_0_var(--border)] min-w-[180px]`}>
                      <div className="font-medium flex items-center gap-1" title={c.efr_name}>
                        {c.efr_name}
                        {c.is_current && <CurrentTechBadge />}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{c.efr_no ?? '—'}</div>
                    </td>
                    <td className="!text-left" title={c.city_name ?? ''}>
                      {c.city_name ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-center">
                      {c.has_deep_skill
                        ? <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" />
                        : <X            className="inline h-3.5 w-3.5 text-red-500" aria-label="No matching deep-skill" />}
                    </td>
                    <td className="!text-center">{c.active_jobs}</td>
                    <td className="!text-right font-mono">
                      <Wallet className="inline h-3 w-3 mr-0.5 text-muted-foreground" />
                      ₹{c.current_balance.toLocaleString()}
                    </td>
                    <td className="!text-center">{c.avg_rating.toFixed(1)}</td>
                    <td className="!text-center">
                      {!c.tat_history ? <NoHistoryPill /> : `${c.avg_tat_hours}h`}
                    </td>
                    <td className="!text-center">
                      {!c.sda_history ? <NoHistoryPill /> : `${Math.round((c.sda_rate ?? 0) * 100)}%`}
                    </td>
                    <td className="!text-center">{c.worked_for_client    ? <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" /> : <X className="inline h-3.5 w-3.5 text-muted-foreground" />}</td>
                    <td className="!text-center">{c.worked_for_vertical  ? <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" /> : <X className="inline h-3.5 w-3.5 text-muted-foreground" />}</td>
                    <td className="!text-center">{c.attendance_marked    ? <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" /> : <X className="inline h-3.5 w-3.5 text-muted-foreground" />}</td>
                    <td className="!text-right font-medium">{c.score.toFixed(2)}</td>
                    <td className="!text-center"><GradePill grade={c.grade} /></td>
                    <td className="!text-right">
                      {c.is_current ? (
                        <span className="text-xs text-muted-foreground italic">Currently assigned</span>
                      ) : (
                        <Button size="sm" disabled={assigning != null} onClick={() => assign(c)}>
                          {assigning === c.efr_id ? 'Assigning…' : (mode === 'reassign' ? 'Reassign' : 'Assign')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
          <span><Star      className="inline h-3 w-3" /> Rating (30%)</span>
          <span><Clock     className="inline h-3 w-3" /> TAT (20%)</span>
          <span><Zap       className="inline h-3 w-3" /> SDA (20%)</span>
          <span><Briefcase className="inline h-3 w-3" /> Client (10%)</span>
          <span><Calendar  className="inline h-3 w-3" /> Vertical (10%)</span>
          <span><UserCheck className="inline h-3 w-3" /> Attendance (10%)</span>
        </div>

        {/* Rejected (L2 drops) — operator visibility */}
        {data && data.rejected.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {data.rejected.length} technician{data.rejected.length === 1 ? '' : 's'} dropped on Layer 2
            </summary>
            <ul className="mt-1 ml-4 list-disc text-muted-foreground">
              {data.rejected.slice(0, 10).map((r) => (
                <li key={r.efr_id}>{r.efr_name} — {r.reason}</li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Click-to-sort header. Same column → flip direction. Different column →
 * switch to that column descending (so a click on "Score" defaults to
 * highest-first, which is what operators expect).
 */
function SortHeaderTH<K extends string>({
  col, sortBy, sortDir, onSort, className = '', title, children,
}: {
  col: K;
  sortBy: K | null;
  sortDir: 'asc' | 'desc';
  onSort: (col: K) => void;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const isActive = sortBy === col;
  // Only show an arrow on the ACTIVE sort column. Inactive columns are
  // still clickable (cursor-pointer + hover bg signal it) but render no
  // icon — keeps the header strip visually quiet.
  const Icon = isActive ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : null;
  // Match the alignment of the inner span to the th's alignment so the
  // arrow doesn't end up on the wrong side of right-aligned numeric cols.
  const justify =
    className.includes('!text-right')  ? 'justify-end'   :
    className.includes('!text-center') ? 'justify-center':
                                          'justify-start';
  return (
    <th
      className={`${className} cursor-pointer select-none hover:bg-muted/50 transition-colors`}
      onClick={() => onSort(col)}
      title={title}
      role="button"
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${justify}`}>
        {children}
        {Icon && <Icon className="size-3 shrink-0 text-foreground" />}
      </span>
    </th>
  );
}

function CurrentTechBadge() {
  return (
    <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-semibold bg-amber-200 text-amber-900 uppercase tracking-wide">
      Current
    </span>
  );
}

function NoHistoryPill() {
  // Distinguishes "no completed jobs in lookback window" (we substitute the
  // configured default score) from a real 0% reading. Without this, a new
  // joiner showing "0%" looks indistinguishable from a tech who's
  // genuinely failing every same-day attempt.
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 italic"
          title="No completed jobs in the scoring window — using configured default for ranking">
      No Completed Jobs
    </span>
  );
}

function GradePill({ grade }: { grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'E' }) {
  const cls =
    grade === 'A+' ? 'bg-emerald-100 text-emerald-800'
    : grade === 'A' ? 'bg-emerald-50 text-emerald-700'
    : grade === 'B' ? 'bg-sky-50 text-sky-700'
    : grade === 'C' ? 'bg-amber-50 text-amber-700'
    : grade === 'D' ? 'bg-orange-50 text-orange-700'
    :                 'bg-red-50 text-red-700';
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${cls}`}>{grade}</span>;
}
