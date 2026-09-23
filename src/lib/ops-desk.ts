/*
 * Pure helpers for the Ops Desk (V3 Phase 3, spec 3.2) and the Verification
 * queue (3.6) — band labels, the "Client ₹X · TX ₹Y[ · Margin ₹Z]" money
 * line, and the visible-tab polling gate shared by /ops-desk and the job
 * chat thread (JobActivity).
 *
 * Lifted out of the page components so they're testable without a DOM —
 * same rationale as lib/job-buckets.ts.
 */

/** Band strip order + Title Case labels, verbatim from proto.txt renderDesk(). */
export const OPS_BANDS = ['A', 'B', 'C', 'D'] as const;
export type OpsBand = (typeof OPS_BANDS)[number];

export const OPS_BAND_LABEL: Record<OpsBand, string> = {
  A: 'On Site, Moving',
  B: 'Stuck On Client',
  C: 'Quality Check',
  D: 'Cannot Finish As Booked',
};

/** GET /admin/ops-desk `pendingOn` values → the Pending On pill's Title Case label. */
export type PendingOn = 'technician' | 'easyfix' | 'client';

export const PENDING_ON_LABEL: Record<PendingOn, string> = {
  technician: 'Technician',
  easyfix: 'EasyFix',
  client: 'Client',
};

function formatRupee(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : '—';
}

/** Ops Desk row / list money column: "Client ₹1,600 · TX ₹800". */
export function formatOpsMoney(client: number | null | undefined, tx: number | null | undefined): string {
  return `Client ${formatRupee(client)} · TX ${formatRupee(tx)}`;
}

/** JobModal Summary Money card: "Client ₹1,600 · TX ₹800 · Margin ₹800". */
export function formatJobMoney(
  client: number | null | undefined,
  tx: number | null | undefined,
  margin: number | null | undefined,
): string {
  return `${formatOpsMoney(client, tx)} · Margin ${formatRupee(margin)}`;
}

/** "Needs me in" column — backend sends minutes-at-door, or null (nothing to wait for). */
export function needsMeInLabel(minutes: number | null | undefined): string {
  return typeof minutes === 'number' && Number.isFinite(minutes) ? `${minutes} min` : '—';
}

/*
 * Visible-tab polling gate (perf standard: "poll only while visible; stop on
 * hidden/unmount"). Returns the interval to hand `useFetch({ refetchInterval })`
 * — `undefined` disables polling, which useFetch's own effect already treats
 * as "no interval" (see lib/hooks.ts). Kept as a one-line pure function so the
 * on/off decision has a name and a test, instead of an inline ternary at every
 * poll call site.
 */
export function pollIntervalMs(tabVisible: boolean, baseMs: number): number | undefined {
  return tabVisible ? baseMs : undefined;
}

/*
 * Flatten GET /admin/verification into the one table the page renders.
 *
 * CLAIMS FIRST. A can't-complete or cancel claim has a technician who has
 * already been told "EasyFix is confirming with the customer" and a customer
 * waiting to hear; an unaudited completed job only has money waiting. The
 * backend returns them as two queues because they page differently — the audit
 * queue is paged, the claims set is small and capped — so `total` counts the
 * audit side, which is the only side the pager moves through.
 *
 * A claim with no reportId is a technician's cancel ask raised by an app build
 * that predates claim rows. It cannot go through the claim-resolve endpoint;
 * the page sends the operator to the job, where the existing Technician
 * Request actions resolve it.
 */


/*
 * GET /admin/verification — the shape the backend actually sends
 * (services/ops-desk.service.js verificationQueue): two queues, because they
 * page differently. `audit` is paged (oldest completed job first); `claims` is
 * the small live set, capped rather than paged. The page flattens them with
 * toVerificationRows (lib/ops-desk.ts) — see there for why claims go first.
 */
type VerificationJobHeader = {
  jobId: number;
  reference: string | null;
  title: string | null;
  clientName: string | null;
  technician: { efrId: number; name: string | null } | null;
  jobStatus: number;
};
export type VerificationAuditItem = VerificationJobHeader & { finishedOn: string | null };
export type VerificationClaimItem = VerificationJobHeader & {
  /** null for a raw technician cancel ask with no claim row (an older app build). */
  reportId: number | null;
  kind: 'cant_complete' | 'cancel' | 'cancel_request';
  reasonText: string | null;
  proofImageIds: number[];
  visitChargeAwarded: boolean;
  reportedOn: string | null;
};
export type VerificationResponse = {
  audit: { items: VerificationAuditItem[]; total: number };
  claims: { items: VerificationClaimItem[]; total: number; truncated: boolean };
};

/* The flattened row the Verification table renders. Declared here, not
 * imported from api.ts, because test:build compiles lib/ modules standalone
 * (no path aliases, rootDir src/lib) — api.ts re-exports the wire types FROM
 * this file, so the dependency only ever points into the pure module. */
export type VerificationRow = {
  jobId: number;
  title: string | null;
  clientName: string | null;
  technician: { efrId: number; name: string | null } | null;
  jobStatus: number;
  submittedOn: string | null;
  report: {
    id: number;
    kind: 'cant_complete' | 'cancel';
    status: string;
    reasonText: string | null;
    proofImageIds: number[];
  } | null;
  legacyCancelAsk?: boolean;
};

export function toVerificationRows(
  data: VerificationResponse | null | undefined,
): { rows: VerificationRow[]; total: number } {
  if (!data) return { rows: [], total: 0 };
  const claims: VerificationRow[] = (data.claims?.items ?? []).map((c) => ({
    jobId: c.jobId,
    title: c.title,
    clientName: c.clientName,
    technician: c.technician,
    jobStatus: c.jobStatus,
    submittedOn: c.reportedOn,
    report: c.reportId
      ? {
        id: c.reportId,
        kind: c.kind === 'cancel_request' ? 'cancel' : c.kind,
        status: 'open',
        reasonText: c.reasonText,
        proofImageIds: c.proofImageIds,
      }
      : null,
    legacyCancelAsk: c.reportId == null,
  }));
  const audit: VerificationRow[] = (data.audit?.items ?? []).map((a) => ({
    jobId: a.jobId,
    title: a.title,
    clientName: a.clientName,
    technician: a.technician,
    jobStatus: a.jobStatus,
    submittedOn: a.finishedOn,
    report: null,
  }));
  return { rows: [...claims, ...audit], total: Number(data.audit?.total) || 0 };
}
