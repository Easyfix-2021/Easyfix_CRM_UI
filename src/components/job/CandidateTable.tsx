'use client';

/*
 * CandidateTable — the shared, data-dense technician-picking table used by
 * BOTH the Schedule & Assign flow (ScheduleAssignModal, status-0) and the
 * Assign / Reassign flow (AssignTechnicianModal, status-0 / status-1).
 *
 * Extracted from ScheduleAssignModal (2026-07-28) so the two surfaces present
 * an identical picking experience: the same widened columns (distance / current
 * pincode / serviceable pincodes / zone / deep-skill status / worked-for-client
 * …), the same sticky-left Technician column, and the same select control
 * (checkbox in offer/multi-select mode, radio in direct-assign/single-select
 * mode).
 *
 * Both surfaces feed this table rows from the SAME backend contract — the
 * unified candidate row built by candidate-ranking.service.js `buildCandidateRow`
 * (returned by GET /admin/jobs/:id/candidates AND /candidates/search). The two
 * modals read different SUBSETS of that one row shape, so the table's
 * `ScheduleCandidate` type is the authoritative column contract.
 *
 * `is_current` (optional) is set by the backend ONLY in Reassign mode, on the
 * technician currently assigned to the job (pinned first). When present the row
 * renders an amber highlight + a "Current" chip and is NOT selectable — you
 * cannot reassign a job to the technician already on it. In Schedule & Assign
 * (status-0, unassigned) no row ever carries the flag, so the table renders
 * exactly as before there.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Info, Search, Phone } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/StatusChip';
import { CallableMobile } from '@/components/calls/CallButton';
import { InfoTooltip } from '@/components/ui/tooltip';
import { EasyfixerLifecycleChip } from '@/components/easyfixer/EasyfixerLifecycleChip';
import {
  candidateJobOfferEligibility,
  type EasyfixerLifecycleStatus,
} from '@/lib/easyfixer-lifecycle';

/* ── BE row shape (exact contract). ──────────────────────────────────── */
export type DistanceTier =
  | 'same_pincode' | 'current_pincode' | 'in_zone' | 'out_of_zone' | 'unknown';
/*
 * 'not_applicable' is its own state on purpose: the job names no Service
 * Category/Type, so there is no skill requirement to match against. It used to
 * collapse into 'both_available', making one green label mean both "matches"
 * and "nothing to match".
 */
export type DeepSkillStatus =
  | 'both_available' | 'job_skill_not_available' | 'easyfixer_skills_not_available'
  | 'not_applicable';

export type ScheduleCandidate = {
  efr_id: number;
  efr_name: string;
  /** Already masked by the BE mask-mobile middleware. */
  mobile: string | null;
  current_pincode: string | null;
  zone_name: string | null;
  serviceable_pincodes: string[];
  distance_km: number | null;
  distance_tier: DistanceTier;
  /** Basis that produced distance_tier: 'Serviceable Pincode' | 'Current Pincode'
   *  | 'Zone' | 'GPS Distance' | '—'. Derived 1:1 from distance_tier by the BE. */
  distance_criteria: string;
  /** Matched reference pincode the criteria keyed on (null when unknown). */
  distance_criteria_value: string | null;
  attendance_for_job_date: boolean;
  deep_skill_status: DeepSkillStatus;
  deep_skill_match: boolean;
  worked_in_category: boolean;
  /* Same CLIENT VERTICAL (tbl_vertical_mapping) — NOT the service category.
     Optional so a pre-deploy API response renders "No" instead of breaking. */
  worked_for_same_vertical?: boolean;
  worked_for_client: boolean;
  payment_mode: string | null;
  account_balance: number;
  concurrent_jobs_count: number;
  same_slot_conflict: boolean;
  /** Completed jobs (status 3/5) — mirrors Manage Easyfixers job_count. < 5 => "Fresher". */
  job_count?: number;
  // Existing ranking fields — optional so the search endpoint (which
  // skips ranking) can omit them.
  score?: number;
  grade?: 'A+' | 'A' | 'B' | 'C' | 'D' | 'E';
  avg_rating?: number;
  /** Lifecycle projection is included in the bounded candidate response. */
  lifecycle_status?: EasyfixerLifecycleStatus | null;
  lifecycle_reason_code?: string | null;
  lifecycle_reason?: string | null;
  /** Server-authoritative offer/assignment gate for this candidate row. */
  can_offer?: boolean;
  /**
   * TRUE for the technician currently assigned to this job (Reassign mode only).
   * The backend pins them first; the table highlights the row and disables its
   * select control so ops can't "reassign" to the same technician. Absent in
   * Schedule & Assign (the job is unassigned there).
   */
  is_current?: boolean;
};

/* ───────────────────────── Technician table ─────────────────────────── */
export function CandidateTable({
  rows, loading, error, showingSearch, canCommit, multiSelect, selected, onToggleSelected, onOpenPincodes, jobId,
}: {
  rows: ScheduleCandidate[];
  loading: boolean;
  error: string | null;
  showingSearch: boolean;
  canCommit: boolean;
  /** TRUE → offer pool (checkboxes, many); FALSE → direct assign (radio, one). */
  multiSelect: boolean;
  selected: Map<number, 'top10' | 'search'>;
  onToggleSelected: (efrId: number, source: 'top10' | 'search') => void;
  onOpenPincodes: (c: ScheduleCandidate) => void;
  /** Job the candidates are for — tags click-to-call rows so a call to a
   *  candidate technician shows in this job's call history. */
  jobId: number | null;
}) {
  // +1 column when the operator can commit: the select control (checkbox in
  // offer mode, radio in direct-assign mode).
  const COLS = canCommit ? 17 : 16;
  // Multiple job dialogs can remain mounted at once. React's instance-scoped
  // id prevents aria-describedby collisions for the same technician id.
  const tableInstanceId = useId();
  const eligibilityById = useMemo(() => new Map(
    rows.map((candidate) => [
      candidate.efr_id,
      candidateJobOfferEligibility(candidate),
    ]),
  ), [rows]);
  return (
    // Horizontal scroll ONLY (the 13-14 columns can't fit any laptop). There is
    // deliberately no max-height: a capped inner scroller showed ~5 rows and
    // forced ops to scroll a nested area inside an already-scrolling modal. The
    // list is bounded instead — Top-10 by the BE's top-N, Search Results by the
    // page size — so it's the modal body that scrolls, once.
    <div className="border rounded overflow-x-auto thin-scroll">
      <table
        className="data-table text-xs whitespace-nowrap border-separate"
        style={{ borderSpacing: 0 }}
      >
        <thead className="sticky top-0 bg-background z-40 shadow-sm">
          <tr>
            {/* These two are FROZEN, so they need an opaque background or
                horizontally-scrolled cells bleed through. It must be `bg-muted`
                — the shade `.data-table th` already paints every other header
                cell (globals.css). They previously hard-coded `bg-white`, which
                made them read as two pale boxes cut out of the grey header row;
                the empty w-10 select cell in particular looked like a stray
                artifact next to "Technician", most visibly while loading, when
                the colSpan'd "Loading technicians…" row leaves nothing under it. */}
            {canCommit && (
              <th className="!text-center sticky top-0 left-0 bg-muted z-50 w-10" aria-label="Select" />
            )}
            <th
              className={
                '!text-left sticky top-0 bg-muted z-50 shadow-[2px_0_0_0_var(--border)] min-w-[190px] ' +
                (canCommit ? 'left-10' : 'left-0')
              }
            >
              Technician
            </th>
            <th className="!text-left min-w-[190px]">Technician Status</th>
            <th className="!text-center">Attendance for Job Date</th>
            <th className="!text-center">Current Pincode</th>
            <th className="!text-left min-w-[150px]">Distance Criteria</th>
            <th className="!text-left min-w-[160px]">Serviceable Pincodes</th>
            <th className="!text-center">
              <span className="inline-flex items-center gap-1">
                Distance
                <DistanceTierInfo />
              </span>
            </th>
            <th className="!text-left">Zone Name</th>
            <th className="!text-left min-w-[180px]">Deep Skill Status</th>
            <th className="!text-center">Deep Skill Match</th>
            <th className="!text-center">Worked in Category?</th>
            <th className="!text-center">Worked for Vertical?</th>
            <th className="!text-center">Worked for Client?</th>
            <th className="!text-center">
              <span className="inline-flex items-center gap-1">
                Concurrent Jobs Count
                <InfoTooltip
                  label="How Concurrent Jobs Count is measured"
                  align="end"
                  // `.data-table th` sets white-space:nowrap; the panel is a
                  // descendant of the header cell and INHERITS it, so without
                  // an explicit override the tooltip text runs off as one line
                  // and gets clipped. Force normal wrapping + break long words.
                  panelClassName="normal-case whitespace-normal break-words"
                >
                  <strong className="block mb-1 normal-case">Concurrent Jobs Count</strong>
                  Counts this technician&apos;s <strong>assigned</strong> jobs on the{' '}
                  <strong>same appointment date</strong> (any time slot) that are still
                  open — status Booked, Scheduled, or In-Progress. Jobs only{' '}
                  <em>offered</em> to the technician but not yet accepted are not counted
                  (an offered job stays unassigned until it is accepted), and completed or
                  cancelled jobs are excluded.
                </InfoTooltip>
              </span>
            </th>
            <th className="!text-right">Easyfixer Account Balance</th>
            <th className="!text-left">Masked Mobile</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={COLS} className="!text-center text-muted-foreground py-6">Loading technicians…</td></tr>
          )}
          {!loading && error && (
            <tr><td colSpan={COLS} className="!text-center text-urgent-strong py-6">{error}</td></tr>
          )}
          {!loading && !error && rows.length === 0 && (
            <tr>
              <td colSpan={COLS} className="!text-center text-muted-foreground py-6">
                {showingSearch
                  ? 'No technicians match your search.'
                  : 'No eligible technicians for this schedule.'}
              </td>
            </tr>
          )}
          {!loading && !error && rows.map((c) => {
            const isSelected = selected.has(c.efr_id);
            const offerEligibility = eligibilityById.get(c.efr_id)
              ?? candidateJobOfferEligibility(c);
            const offerBlocked = !offerEligibility.canOffer;
            const lifecycleCellId = `${tableInstanceId}-candidate-lifecycle-${c.efr_id}`;
            // Reassign only: the technician already on the job. Pinned first by
            // the BE, highlighted, and NOT selectable (can't reassign to self).
            const isCurrent = c.is_current === true;
            // Row + sticky-cell backgrounds. When isCurrent=false these collapse
            // to the exact original classes, so Schedule & Assign is unchanged.
            const rowCls = isCurrent
              ? 'group bg-warning-tint hover:bg-warning/15'
              : offerBlocked
                /*
                 * `hover:bg-destructive/15` — ONE alpha suffix. This read
                 * `/15/70` for its whole life, which Tailwind never generates,
                 * so the row body had no hover at all while the two sticky
                 * cells below (selectBg, nameTd) hovered correctly. A blocked
                 * row half-lit: the frozen Select and Name columns washed and
                 * the rest of the row did not.
                 *
                 * Matches the isCurrent row directly above, which is the same
                 * shape — a tint at rest, the meaning colour at /15 on hover.
                 */
                ? 'group bg-urgent-tint/70 hover:bg-destructive/15'
              : 'group hover:bg-muted/40 ' + (isSelected ? 'bg-primary/5' : '');
            const selectBg = isCurrent
              ? 'bg-warning-tint group-hover:bg-warning/15'
              : offerBlocked
                ? 'bg-urgent-tint group-hover:bg-destructive/15'
              : (isSelected ? 'bg-primary/5' : 'bg-card group-hover:bg-ink-100');
            const nameTd = isCurrent
              ? '!text-left sticky z-20 bg-warning-tint group-hover:bg-warning/15 shadow-[2px_0_0_0_var(--border)] min-w-[190px] ' + (canCommit ? 'left-10' : 'left-0')
              : offerBlocked
                ? '!text-left sticky z-20 bg-urgent-tint group-hover:bg-destructive/15 shadow-[2px_0_0_0_var(--border)] min-w-[190px] ' + (canCommit ? 'left-10' : 'left-0')
              : '!text-left sticky z-20 group-hover:bg-ink-100 shadow-[2px_0_0_0_var(--border)] min-w-[190px] ' + (canCommit ? 'left-10' : 'left-0') + ' ' + (isSelected ? 'bg-primary/5' : 'bg-card');
            return (
            <tr key={c.efr_id} className={rowCls}>
              {/* Select control — sticky left so it stays reachable no matter how
                  far the wide table is scrolled horizontally. Checkbox (offer
                  pool) or radio (direct assign). The current technician's row
                  shows a "Now" marker instead — it can't be selected. */}
              {canCommit && (
                <td className={'!text-center sticky left-0 z-20 w-10 ' + selectBg}>
                  {isCurrent ? (
                    <span className="text-xs font-semibold uppercase tracking-wide text-warning-strong" title="Currently assigned to this job">
                      Now
                    </span>
                  ) : (
                    <span
                      className="inline-flex"
                      title={offerBlocked ? offerEligibility.explanation : undefined}
                      tabIndex={offerBlocked ? 0 : undefined}
                      role={offerBlocked ? 'note' : undefined}
                      aria-label={offerBlocked
                        ? `${c.efr_name} cannot be selected. ${offerEligibility.explanation}`
                        : undefined}
                    >
                      <input
                        type={multiSelect ? 'checkbox' : 'radio'}
                        name={multiSelect ? undefined : 'assign-select'}
                        checked={isSelected}
                        disabled={offerBlocked}
                        onChange={() => onToggleSelected(c.efr_id, showingSearch ? 'search' : 'top10')}
                        aria-label={offerBlocked
                          ? `${c.efr_name} cannot be selected. ${offerEligibility.explanation}`
                          : `Select ${c.efr_name}`}
                        aria-describedby={offerBlocked ? lifecycleCellId : undefined}
                        className="h-4 w-4 cursor-pointer accent-primary align-middle disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </span>
                  )}
                </td>
              )}
              {/* Technician (name + efr_id) — sticky left identifier, offset
                  past the select column when present. */}
              <td className={nameTd}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate" title={c.efr_name}>{c.efr_name}</span>
                    {isCurrent && (
                      <StatusChip tone="amber" size="sm" className="shrink-0" title="Currently assigned to this job">Current</StatusChip>
                    )}
                    {c.job_count != null && c.job_count < 5 && (
                      <StatusChip tone="sky" size="sm" className="shrink-0" title="Completed Less Than 5 Jobs Till Now">Fresher</StatusChip>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">Efr #{c.efr_id}</div>
                </div>
              </td>

              {/* Lifecycle state and the server-provided block reason travel in
                  the candidate row itself — never a per-technician fetch. Search
                  deliberately includes blocked technicians for discovery, but
                  the adjacent selection control remains disabled. */}
              <td
                id={lifecycleCellId}
                className="!text-left min-w-[190px] max-w-[250px] whitespace-normal"
              >
                <div className="space-y-1 leading-tight">
                  <EasyfixerLifecycleChip
                    value={c}
                    fallbackLabel={offerEligibility.canOffer ? 'Eligible' : 'Not Eligible'}
                    fallbackTone={offerEligibility.canOffer ? 'emerald' : 'rose'}
                  />
                  {showingSearch && (offerEligibility.reason || offerBlocked) && (
                    <p className={offerBlocked ? 'text-xs text-urgent-strong' : 'text-xs text-muted-foreground'}>
                      {offerEligibility.reason ?? offerEligibility.explanation}
                    </p>
                  )}
                </div>
              </td>

              {/* Attendance for Job Date — green tick / red cross. */}
              <td className="!text-center">
                {c.attendance_for_job_date
                  ? <CheckCircle2 className="inline h-4 w-4 text-success-strong" aria-label="Present on job date" />
                  : <XCircle className="inline h-4 w-4 text-urgent" aria-label="No attendance for job date" />}
              </td>

              {/* Current Pincode. */}
              <td className="!text-center">
                {c.current_pincode || <span className="text-muted-foreground">—</span>}
              </td>

              {/* Distance Criteria — which basis produced this tech's distance/tier. */}
              <td className="!text-left">
                <DistanceCriteriaCell criteria={c.distance_criteria} value={c.distance_criteria_value} />
              </td>

              {/* Serviceable Pincodes — truncated, hover list, click-to-open. */}
              <td className="!text-left">
                <ServiceablePincodesCell candidate={c} onOpen={() => onOpenPincodes(c)} />
              </td>

              {/* Distance — km on top, tier label muted underneath. */}
              <td className="!text-center">
                <DistanceCell km={c.distance_km} tier={c.distance_tier} />
              </td>

              {/* Zone Name. */}
              <td className="!text-left">
                {c.zone_name || <span className="text-muted-foreground">—</span>}
              </td>

              {/* Deep Skill Status — 3-state enum → label. */}
              <td className="!text-left">{deepSkillStatusLabel(c.deep_skill_status)}</td>

              {/* Deep Skill Match. */}
              <td className="!text-center"><YesNo value={c.deep_skill_match} /></td>

              {/* Worked in Category? */}
              <td className="!text-center"><YesNo value={c.worked_in_category} /></td>

              {/* Worked for Vertical? — same CLIENT VERTICAL (tbl_vertical_mapping),
                  distinct from the service-category column above. */}
              <td className="!text-center"><YesNo value={c.worked_for_same_vertical === true} /></td>

              {/* Worked for Client? */}
              <td className="!text-center"><YesNo value={c.worked_for_client} /></td>

              {/* Concurrent Jobs Count. */}
              <td className="!text-center tabular-nums">{c.concurrent_jobs_count ?? 0}</td>

              {/* Easyfixer Account Balance. */}
              <td className="!text-right font-mono">₹{(c.account_balance ?? 0).toLocaleString('en-IN')}</td>

              {/* Masked Mobile — click-to-call via the shared CallableMobile
                  (resolves unmasked digits server-side from efr_id). */}
              <td className="!text-left">
                {c.mobile
                  ? (
                    <span className="inline-flex items-center gap-1">
                      <CallableMobile efrId={c.efr_id} jobContextId={jobId ?? undefined} mobile={c.mobile} />
                    </span>
                  )
                  : <span className="text-muted-foreground inline-flex items-center gap-1"><Phone className="h-3 w-3" />—</span>}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Distance km + tier label cell. ─────────────────────────────────── */
const TIER_LABEL: Record<DistanceTier, string | null> = {
  same_pincode: 'Same as Job Pincode',
  current_pincode: 'Current Pincode',
  in_zone: 'In Job Zone',
  out_of_zone: 'Out of Zone',
  unknown: null,
};
function DistanceCell({ km, tier }: { km: number | null; tier: DistanceTier }) {
  const label = TIER_LABEL[tier];
  return (
    <div className="leading-tight">
      <div className="font-medium tabular-nums">
        {km == null ? <span className="text-muted-foreground">—</span> : `${km.toFixed(1)} km`}
      </div>
      {label && <div className="text-xs text-muted-foreground">({label})</div>}
    </div>
  );
}

/* ── Distance-criteria cell: the basis that produced the tech's distance/tier
   (Serviceable Pincode / Current Pincode / Zone / GPS Distance), with the matched
   reference pincode underneath when the BE has one. ───────────────────────── */
function DistanceCriteriaCell({ criteria, value }: { criteria: string; value: string | null }) {
  if (!criteria || criteria === '—') {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="leading-tight">
      <div className="font-medium">{criteria}</div>
      {value && <div className="text-xs text-muted-foreground tabular-nums">{value}</div>}
    </div>
  );
}

/* ── (i) info tooltip explaining the 3-tier distance criteria. CSS
   group-hover popover — no shared Tooltip primitive exists in this repo
   (the convention is native title= / details / hover popovers). ───────── */
function DistanceTierInfo() {
  return (
    <span className="group/info relative inline-flex">
      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 hidden w-64 -translate-x-1/2 rounded-md border bg-popover p-2 text-left text-xs font-normal normal-case leading-snug text-foreground shadow-lg group-hover/info:block"
      >
        <strong className="block mb-1">How distance is matched</strong>
        <span className="block"><strong>Same as Job Pincode</strong> — a serviceable pincode equals the job pincode.</span>
        <span className="block mt-0.5"><strong>Current Pincode</strong> — the technician&apos;s current pincode compared to the job pincode.</span>
        <span className="block mt-0.5"><strong>In Job Zone</strong> — a serviceable pincode in the same zone as the job pincode.</span>
        <span className="block mt-1 text-muted-foreground">Distance is the real road-distance estimate between geocoded pincode centroids.</span>
      </span>
    </span>
  );
}

/* ── Serviceable-pincodes cell: truncated CSV + hover ordered list +
   click-to-open searchable modal. "Not Available" when empty. ─────────── */
function ServiceablePincodesCell({
  candidate, onOpen,
}: {
  candidate: ScheduleCandidate;
  onOpen: () => void;
}) {
  const list = candidate.serviceable_pincodes ?? [];
  if (list.length === 0) {
    return <span className="text-muted-foreground">Not Available</span>;
  }
  const TRUNCATE = 3;
  const shown = list.slice(0, TRUNCATE).join(', ');
  const extra = list.length - TRUNCATE;
  return (
    <span className="group/pin relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        className="text-left text-primary hover:underline"
        title="Click to view and filter all serviceable pincodes"
      >
        {shown}
        {extra > 0 && <span className="text-muted-foreground"> +{extra} more</span>}
      </button>
      {extra > 0 && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden max-h-48 w-44 overflow-auto rounded-md border bg-popover p-2 text-left shadow-lg group-hover/pin:block"
        >
          <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
            All Serviceable Pincodes
          </span>
          <ol className="list-decimal list-inside space-y-0.5 text-xs text-foreground">
            {list.map((p) => <li key={p}>{p}</li>)}
          </ol>
        </span>
      )}
    </span>
  );
}

/* ── Click-to-open searchable pincode modal (filter box + full list). ─── */
export function PincodeListModal({
  candidate, onClose,
}: {
  candidate: ScheduleCandidate | null;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  useEffect(() => { if (!candidate) setFilter(''); }, [candidate]);

  const list = candidate?.serviceable_pincodes ?? [];
  const filtered = filter.trim()
    ? list.filter((p) => p.includes(filter.trim()))
    : list;

  // Read-only list modal — purely a filter-and-read view of pincodes,
  // it captures NO user input that could be lost, so the discard-changes
  // guard is intentionally skipped here (documented disable per the
  // house rule for read-only modals).
  return (
    // eslint-disable-next-line no-restricted-syntax -- read-only pincode viewer: no dirty state to guard
    <Dialog open={!!candidate} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Serviceable Pincodes
            {candidate && (
              <span className="text-sm font-normal text-ink-300">· {candidate.efr_name}</span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter pincodes…"
            className="pl-9"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="mt-3 max-h-72 overflow-auto rounded border thin-scroll">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {list.length === 0 ? 'Not Available' : 'No pincodes match the filter.'}
            </div>
          ) : (
            <ol className="list-decimal list-inside divide-y text-sm">
              {filtered.map((p) => (
                <li key={p} className="px-3 py-1.5">{p}</li>
              ))}
            </ol>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {filtered.length} of {list.length} pincode{list.length === 1 ? '' : 's'}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Deep Skill Status enum → display label. ─────────────────────────── */
function deepSkillStatusLabel(status: DeepSkillStatus): React.ReactNode {
  switch (status) {
    case 'both_available':
      return <span className="text-success-strong">Has Required Job Skill</span>;
    case 'job_skill_not_available':
      return <span className="text-warning-strong">Technician Missing Job Skill</span>;
    case 'easyfixer_skills_not_available':
      return <span className="text-urgent-strong">Technician Has No Skills</span>;
    /*
     * Neutral, never green. The job carries no Service Category/Type, so no
     * technician can be said to match or miss it — showing this as a positive
     * would claim a fit that was never assessed.
     */
    case 'not_applicable':
      return (
        <span className="text-muted-foreground" title="This job has no Service Category or Type, so there is no skill requirement to match against.">
          Not Applicable
        </span>
      );
    default:
      return <span className="text-muted-foreground">—</span>;
  }
}

/* ── Yes/No cell. ────────────────────────────────────────────────────── */
function YesNo({ value }: { value: boolean }) {
  return value
    ? <span className="text-success-strong font-medium">Yes</span>
    : <span className="text-muted-foreground">No</span>;
}
