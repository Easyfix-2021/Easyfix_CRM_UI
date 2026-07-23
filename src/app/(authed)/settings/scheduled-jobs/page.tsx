'use client';

/*
 * Settings → Scheduled Jobs (2026-06-06)
 *
 * Expandable list of every node-cron job the BE has registered, with
 * per-job metadata + a "Trigger Now" button that fires the underlying
 * runner out-of-band (no waiting for the next cron tick).
 *
 * Access gate: this page is intentionally NOT in tbl_menu. Visibility
 * is decided server-side by the `scheduled.jobs.visible.emails`
 * easyfix_property — the BE returns 403 from /admin/scheduled-jobs
 * for off-allowlist operators and the FE sidebar hides the entry. To
 * defend against an operator pasting the URL directly, the page
 * fetches /admin/scheduled-jobs once on mount and renders a "Not
 * authorised" card if the request 403s.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown, ChevronRight, Play, RotateCcw, AlertTriangle, Clock, Send,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { StatusChip } from '@/components/ui/StatusChip';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { formatApiError } from '@/lib/api-errors';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type ScheduledJob = {
  id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  registered: boolean;
  skipReason: string | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: unknown;
  lastError: string | null;
  lastTriggerKind: 'cron' | 'manual' | 'test' | null;
  // Test-send surface (2026-06-06). When `testable` is true, a "Test"
  // button renders alongside "Trigger Now" and the modal uses the
  // testSourceLabel / testSourceHelp strings for its optional source-id
  // input. Source id semantics are per-job (efr_id for the profile-
  // reminder cron, job_id for the magic-link cron); the BE validates.
  testable?: boolean;
  testSourceLabel?: string | null;
  testSourceHelp?: string | null;
  lastTestAt?: string | null;
  lastTestDurationMs?: number | null;
  lastTestResult?: unknown;
  lastTestError?: string | null;
};

type JobsResponse = { jobs: ScheduledJob[] };

/*
 * Live progress for the QA database refresh, served by
 * GET /admin/scheduled-jobs/qa-db-refresh/progress. Server-owned state, so it
 * is unaffected by this page unmounting — see the polling effect below.
 */
type QaProgress = {
  running: boolean;
  phase: string;
  label: string;        // human sentence, e.g. "Downloading data from the production replica"
  dryRun?: boolean;
  startedAt?: string;
  elapsedMs?: number;
  bytes?: number | null; // dump size so far, straight off the file on disk
  cancelled?: boolean;
  file?: string;
};

/* The two jobs the progress card applies to. */
const QA_REFRESH_IDS = ['qa-db-refresh', 'qa-db-refresh-dry-run'];

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export default function ScheduledJobsPage() {
  const { me } = useMe();
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  // Set of job ids currently expanded. Multiple-open allowed since the
  // detail panels are short and side-by-side comparison helps debugging.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-job triggering flag — disables the button + shows a busy state
  // without blocking the whole page (other jobs stay actionable).
  const [triggering, setTriggering] = useState<Set<string>>(new Set());
  // Test-send modal target. When non-null, the modal opens for this job
  // and submits to POST /admin/scheduled-jobs/:id/test. Single modal at
  // a time because the modal owns transient input state (mobile +
  // sourceId); two open simultaneously would race the input refs.
  const [testTarget, setTestTarget] = useState<ScheduledJob | null>(null);

  /*
   * LIVE PROGRESS for the QA database refresh — the only jobs here that run for
   * MINUTES (a multi-GB dump), where "Last Run" telemetry alone leaves the
   * operator watching a spinner with no idea if anything is happening.
   *
   * The state lives on the SERVER (qa-db-refresh.service), so this is a pure
   * read. That is what makes progress survive switching tabs, navigating away,
   * or closing the browser entirely — nothing is held in React, so there is
   * nothing to lose. Re-opening this page picks a run back up mid-flight.
   *
   * Poll cadence: brisk while a run is in flight, lazy when idle so an open page
   * isn't a permanent heartbeat. Driven through the shared `useFetch` hook
   * (module-level dedupe + cleanup) rather than a hand-rolled useEffect loop —
   * the repo forbids raw api.* calls inside effects for exactly the
   * double-fire reasons the lint rule cites.
   */
  /*
   * POLLING BUDGET — this backend is shared by the CRM, the client portal and
   * the mobile app, so an ops page left open must not become a permanent
   * heartbeat against it. The cost is therefore bounded three ways:
   *
   *   1. NO POLLING WHEN IDLE. `refetchInterval` is 0 unless a run is actually
   *      in flight, so an open page costs exactly ONE request on mount and then
   *      nothing at all.
   *   2. PAUSED IN A BACKGROUND TAB. `enabled` follows document visibility —
   *      ops leave tabs open for hours, and a hidden tab has nobody to show
   *      progress to. Because `enabled` is a dependency of the fetch, flipping
   *      back to visible also re-probes once, which is how a run started
   *      elsewhere (or by the cron) gets picked up.
   *   3. 3s ONLY WHILE RUNNING, and the endpoint it hits is in-memory state
   *      plus one stat() — no database, no query.
   *
   * Triggering a QA job calls refetch() directly, so the live strip appears at
   * once rather than waiting for a tick.
   */
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const [qaRunning, setQaRunning] = useState(false);
  const qaProg = useFetch<QaProgress>(
    '/admin/scheduled-jobs/qa-db-refresh/progress',
    { enabled: tabVisible, refetchInterval: qaRunning ? 3_000 : 0 },
  );
  const qaProgress = qaProg.data;
  const [stopping, setStopping] = useState(false);
  useEffect(() => { setQaRunning(!!qaProgress?.running); }, [qaProgress?.running]);

  // Refresh the job list as soon as a run ends, so "Last Run" reflects it
  // without the operator hitting reload.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && qaProgress && !qaProgress.running) load();
    wasRunning.current = !!qaProgress?.running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaProgress?.running]);

  async function stopQaRun() {
    setStopping(true);
    try {
      await api.post('/admin/scheduled-jobs/qa-db-refresh/cancel', {});
      showToast({ variant: 'warning', message: 'Stopping the run — it will report as stopped shortly.' });
      qaProg.refetch();   // reflect the cancelled flag without waiting for the tick
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not stop the run.' }) });
    } finally {
      setStopping(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<JobsResponse>('/admin/scheduled-jobs');
      setJobs(res.jobs);
      setDenied(false);
    } catch (e) {
      // 403 from the BE means the operator's email isn't on the
      // allowlist — render the polite "no access" card instead of
      // an error toast. Any other failure goes through the standard
      // error banner.
      const msg = formatApiError(e, { fallback: 'Failed to load scheduled jobs' });
      if (/not authorised|not authorized|forbidden|403/i.test(msg)) {
        setDenied(true);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function triggerNow(job: ScheduledJob) {
    const ok = await confirm({
      title: `Trigger "${job.name}" now?`,
      description: (
        <>
          <p>
            This will run the job <strong>out-of-band</strong> — the
            normal cron schedule is unaffected, but the job&apos;s
            underlying runner executes immediately.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Cron: <code className="font-mono">{job.cron}</code> ·
            Timezone: <code className="font-mono">{job.timezone}</code>
          </p>
        </>
      ),
      confirmLabel: 'Trigger Now',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    setTriggering((prev) => new Set(prev).add(job.id));
    try {
      await api.post(`/admin/scheduled-jobs/${encodeURIComponent(job.id)}/trigger`, {});
      showToast({ variant: 'success', message: `"${job.name}" triggered successfully.` });
      /*
       * QA-refresh jobs run for minutes, so start the live strip immediately
       * instead of waiting for a poll tick — and because polling is OFF while
       * idle, without this nudge nothing would begin watching at all until the
       * operator switched tabs.
       */
      if (QA_REFRESH_IDS.includes(job.id)) { setQaRunning(true); qaProg.refetch(); }
      // Re-fetch so the lastRunAt / lastResult panel reflects the new run.
      await load();
    } catch (e) {
      showToast({
        variant: 'error',
        message: formatApiError(e, { fallback: 'Trigger failed' }),
      });
    } finally {
      setTriggering((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  }

  // Render shape decided up front so the early-returns stay tidy.
  const content = useMemo(() => {
    if (loading && !jobs) {
      return (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            Loading scheduled jobs…
          </CardContent>
        </Card>
      );
    }
    if (denied) {
      return (
        <Card>
          <CardContent className="py-8 text-center text-sm">
            <AlertTriangle className="h-6 w-6 mx-auto text-amber-600 mb-2" />
            <p className="font-medium">You don&apos;t have access to this page.</p>
            <p className="text-muted-foreground mt-1">
              Scheduled Jobs is restricted to specific operator emails. Ask
              an admin to add <code className="font-mono text-xs">{me?.user?.official_email || 'your email'}</code> to the
              <code className="font-mono text-xs mx-1">scheduled.jobs.visible.emails</code>
              property if you need access.
            </p>
            <Link
              href="/dashboard"
              className="inline-block mt-3 text-sm text-sky-700 hover:underline"
            >
              Back to Dashboard
            </Link>
          </CardContent>
        </Card>
      );
    }
    if (error) {
      return (
        <Card>
          <CardContent className="py-6 text-center text-sm">
            <AlertTriangle className="h-6 w-6 mx-auto text-destructive mb-2" />
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
              <RotateCcw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      );
    }
    if (!jobs || jobs.length === 0) {
      return (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            No scheduled jobs registered on this deploy.
          </CardContent>
        </Card>
      );
    }
    return (
      <ul className="space-y-2">
        {jobs.map((job) => {
          const isOpen = expanded.has(job.id);
          const isTriggering = triggering.has(job.id);
          const Chev = isOpen ? ChevronDown : ChevronRight;
          return (
            <li key={job.id}>
              <Card className="overflow-hidden">
                {/*
                  * Header row — two SIBLING controls in a flex container,
                  * NOT a parent button wrapping a child button (HTML
                  * doesn't allow nested <button>s, and Next.js's hydrator
                  * surfaces it as a console error + dev overlay).
                  *
                  * Layout:
                  *   ┌─────────────────────────────────────────────────────┐
                  *   │ <button> expand toggle (chevron + title + meta) │ <Button>Trigger Now</Button>│
                  *   └─────────────────────────────────────────────────────┘
                  *
                  * The expand <button> takes flex-1 so it absorbs the
                  * row's free space; the Trigger Now button sits to its
                  * right at its natural width. Clicking anywhere on the
                  * left section toggles the detail panel; clicking the
                  * Trigger Now button fires the trigger without
                  * interfering with the expand state.
                  */}
                <div className="px-4 py-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => toggle(job.id)}
                    className="flex-1 min-w-0 text-left flex items-center gap-3 hover:bg-muted/40 -mx-2 -my-1 px-2 py-1 rounded transition-colors"
                    aria-expanded={isOpen}
                  >
                    <Chev className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{job.name}</span>
                        {job.registered
                          ? <StatusChip tone="emerald" size="sm">Scheduled</StatusChip>
                          : <StatusChip tone="slate" size="sm">Not Scheduled</StatusChip>}
                        {job.lastError
                          ? <StatusChip tone="red" size="sm">Last Run Failed</StatusChip>
                          : null}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
                        <span>
                          <code className="font-mono text-[11px]">{job.cron}</code>
                          <span className="ml-1.5">({job.timezone})</span>
                        </span>
                        {job.lastRunAt && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Last run: {formatDateTime(job.lastRunAt)}
                            {job.lastTriggerKind === 'manual' ? ' · manual' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                  {/*
                    * Test button (2026-06-06) — visible only when the
                    * job's tester is registered on the BE (job.testable
                    * is true). Opens a modal where the operator types
                    * a mobile + optional source-row id; the WhatsApp
                    * dispatches only to the typed mobile, never to the
                    * source row's real recipient. See TestJobModal
                    * below.
                    */}
                  {job.testable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setTestTarget(job)}
                      className="shrink-0"
                      title="Send a one-off test message to any number you choose"
                    >
                      <Send className="h-3.5 w-3.5 mr-1" />
                      Test
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isTriggering}
                    onClick={() => void triggerNow(job)}
                    className="shrink-0"
                  >
                    <Play className="h-3.5 w-3.5 mr-1" />
                    {isTriggering ? 'Triggering…' : 'Trigger Now'}
                  </Button>
                </div>
                {/*
                  * LIVE PROGRESS strip — QA refresh jobs only, and only while a
                  * run is actually in flight. Rendered OUTSIDE the `isOpen`
                  * block on purpose: a long-running job must be visible without
                  * the operator remembering which card to expand.
                  *
                  * It reads from the server poll, so it repaints correctly after
                  * a tab switch or a full page reload — the run keeps going
                  * regardless of whether anyone is watching.
                  */}
                {QA_REFRESH_IDS.includes(job.id) && qaProgress?.running && (
                  <div className="border-t bg-sky-50 px-4 py-2.5 flex items-center gap-3 flex-wrap">
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-600" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-sky-900">
                        {qaProgress.label}
                        {qaProgress.dryRun && <span className="ml-1.5 text-xs font-normal text-sky-700">(dry run — QA untouched)</span>}
                      </div>
                      <div className="text-xs text-sky-800/80 tabular-nums">
                        Running {formatDuration(qaProgress.elapsedMs ?? null)}
                        {qaProgress.bytes != null && qaProgress.bytes > 0
                          && ` · ${(qaProgress.bytes / 1024 / 1024).toFixed(1)} MB downloaded`}
                      </div>
                    </div>
                    {/* Stop is destructive-ish but always safe: the run unwinds
                        through its normal failure path, so the maintenance gate
                        is lowered and the partial dump deleted. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={stopping || qaProgress.cancelled}
                      onClick={() => void stopQaRun()}
                      className="shrink-0 border-rose-300 text-rose-700 hover:bg-rose-50"
                    >
                      {qaProgress.cancelled ? 'Stopping…' : stopping ? 'Stopping…' : 'Stop'}
                    </Button>
                  </div>
                )}
                {isOpen && (
                  <div className="border-t bg-muted/20 px-4 py-3 text-sm">
                    <dl className="grid grid-cols-1 md:grid-cols-[10rem_1fr] gap-x-3 gap-y-2">
                      <dt className="font-semibold text-muted-foreground text-xs">ID</dt>
                      <dd className="font-mono text-xs">{job.id}</dd>
                      <dt className="font-semibold text-muted-foreground text-xs">Description</dt>
                      {/*
                        * JobDescription parses the BE's plain-text
                        * description into proper visual blocks:
                        *   - Label prefixes ("What this task does:",
                        *     "Why this matters:", "Note:", etc.) → bold
                        *   - Numbered-step blocks ("  1. …", "  2. …")
                        *     → real <ol> with proper indentation
                        *   - Blank-line-separated chunks → paragraphs
                        * See the JobDescription component definition
                        * below this page's default export.
                        */}
                      <dd className="text-xs leading-relaxed">
                        <JobDescription text={job.description} />
                      </dd>
                      <dt className="font-semibold text-muted-foreground text-xs">Cron Expression</dt>
                      <dd className="font-mono text-xs">{job.cron} ({job.timezone})</dd>
                      <dt className="font-semibold text-muted-foreground text-xs">Status</dt>
                      <dd className="text-xs">
                        {job.registered
                          ? 'Registered and running on schedule.'
                          : `Not registered. Reason: ${job.skipReason || 'unknown'}`}
                      </dd>
                      <dt className="font-semibold text-muted-foreground text-xs">Last Run</dt>
                      <dd className="text-xs">
                        {job.lastRunAt
                          ? `${formatDateTime(job.lastRunAt)} (${job.lastTriggerKind ?? 'cron'})`
                          : 'Never (since the server last started)'}
                      </dd>
                      <dt className="font-semibold text-muted-foreground text-xs">Last Duration</dt>
                      <dd className="text-xs">{formatDuration(job.lastDurationMs)}</dd>
                      {job.lastError && (
                        <>
                          <dt className="font-semibold text-destructive text-xs">Last Error</dt>
                          <dd className="text-xs text-destructive whitespace-pre-wrap break-words">
                            {job.lastError}
                          </dd>
                        </>
                      )}
                      {job.lastResult != null && !job.lastError && (
                        <>
                          <dt className="font-semibold text-muted-foreground text-xs">Last Result</dt>
                          <dd className="text-xs whitespace-pre-wrap break-words">
                            <pre className="bg-background border rounded p-2 text-[11px] overflow-x-auto">
                              {JSON.stringify(job.lastResult, null, 2)}
                            </pre>
                          </dd>
                        </>
                      )}
                      {/*
                        * Last Test telemetry (2026-06-06) — only shows
                        * when the job is testable AND has actually been
                        * tested since the server last restarted. Kept
                        * SEPARATE from "Last Run" so a test send
                        * doesn't confuse "did the cron itself run".
                        */}
                      {job.testable && (job.lastTestAt || job.lastTestError) && (
                        <>
                          <dt className="font-semibold text-muted-foreground text-xs">Last Test</dt>
                          <dd className="text-xs">
                            {job.lastTestAt ? formatDateTime(job.lastTestAt) : '—'}
                            {job.lastTestDurationMs != null && (
                              <span className="text-muted-foreground"> · {formatDuration(job.lastTestDurationMs)}</span>
                            )}
                          </dd>
                          {job.lastTestError && (
                            <>
                              <dt className="font-semibold text-destructive text-xs">Last Test Error</dt>
                              <dd className="text-xs text-destructive whitespace-pre-wrap break-words">
                                {job.lastTestError}
                              </dd>
                            </>
                          )}
                          {!job.lastTestError && job.lastTestResult != null && (
                            <>
                              <dt className="font-semibold text-muted-foreground text-xs">Last Test Result</dt>
                              <dd className="text-xs whitespace-pre-wrap break-words">
                                <pre className="bg-background border rounded p-2 text-[11px] overflow-x-auto">
                                  {JSON.stringify(job.lastTestResult, null, 2)}
                                </pre>
                              </dd>
                            </>
                          )}
                        </>
                      )}
                    </dl>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    );
  }, [loading, denied, error, jobs, expanded, triggering, me]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Scheduled Jobs</h1>
          <p className="text-sm text-muted-foreground">
            All background tasks running on this server. Each task has its
            own schedule (when it runs automatically) and you can also
            press &ldquo;Trigger Now&rdquo; to run any task immediately
            without waiting for its next scheduled time.
          </p>
        </div>
        {/*
          * Refresh button (2026-06-06 — tooltip clarified). Re-fetches
          * the job list + per-job telemetry (last run time, last
          * duration, last result/error). Useful when another
          * operator has just triggered a job on another tab and you
          * want to see the updated status, OR after a long-running
          * job to confirm completion. (The page does NOT auto-poll
          * — refresh is manual to keep the load light on the BE.)
          */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          title="Re-fetch the latest job status + last-run details (useful when other operators have triggered jobs in parallel, or to confirm a long-running job has finished)"
        >
          <RotateCcw className={cn('h-4 w-4 mr-1', loading && 'animate-spin')} />
          Refresh Status
        </Button>
      </div>
      {content}
      {/*
        * Test-send modal — single instance, target set via setTestTarget.
        * Mounted at the page root so it doesn't get unmounted when the
        * memoized `content` reconciles. Modal handles its OWN reload of
        * job state on close-after-success so the Last Test panel
        * refreshes without us having to thread anything through here.
        */}
      <TestJobModal
        target={testTarget}
        onClose={() => setTestTarget(null)}
        onSuccess={() => { void load(); }}
      />
    </div>
  );
}

/*
 * TestJobModal (2026-06-06).
 *
 * Modal opened from the "Test" button next to "Trigger Now" on testable
 * jobs (currently `magic-link-hourly-sweep` and `easyfixer-profile-reminder`).
 *
 * Behaviour contract (matches the BE tester):
 *   - The Mobile field is REQUIRED. The WhatsApp dispatches to this
 *     number ONLY — never to any real customer / easyfixer / SPOC.
 *   - The Source ID field is OPTIONAL. When provided, the BE looks up
 *     that row READ-ONLY and uses its display fields (customer name +
 *     client name for magic-link; easyfixer name for profile-reminder)
 *     as placeholder values in the template. The lookup never mutates
 *     the source row (no send-count increment, no audit columns
 *     touched, no url-shortener row).
 *   - If Source ID is blank, dummy values populate the template ("Test
 *     Customer" / "EasyFix Demo" / "Test Easyfixer").
 *
 * The label / help copy comes from the per-job
 * testSourceLabel / testSourceHelp strings the BE registered, so adding
 * a third testable job later doesn't need any FE change here.
 */
function TestJobModal({
  target, onClose, onSuccess,
}: {
  target: ScheduledJob | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [mobile, setMobile] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  // Reset form whenever the target changes (modal re-opened, possibly for a
  // different job). Without this, a previous mobile/sourceId would leak
  // into the next test target which would be confusing.
  useEffect(() => {
    if (target) {
      setMobile('');
      setSourceId('');
      setInlineError(null);
      setSubmitting(false);
    }
  }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !!target;
  const trimmedMobile = mobile.trim();
  const cleanedDigits = trimmedMobile.replace(/\D/g, '');
  const mobileValid = cleanedDigits.length === 10
    || (cleanedDigits.length === 12 && cleanedDigits.startsWith('91'));
  const sourceIdLooksValid =
    sourceId.trim() === '' || /^\d+$/.test(sourceId.trim());
  const canSubmit = mobileValid && sourceIdLooksValid && !submitting;

  // Discard-changes guard for Esc / X / overlay-click. Project-wide ESLint
  // rule forbids inline `onOpenChange` on Dialog because it bypasses this
  // shared behaviour. `isDirty` includes the source-id field so a typo into
  // that field also prompts before discarding. The `when` gate skips the
  // prompt while a submit is in flight — that close path is already a
  // success that's tearing down the modal.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: trimmedMobile !== '' || sourceId.trim() !== '',
    when: () => !submitting,
  });

  if (!target) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !target) return;
    setSubmitting(true);
    setInlineError(null);
    try {
      await api.post(
        `/admin/scheduled-jobs/${encodeURIComponent(target.id)}/test`,
        {
          mobile: trimmedMobile,
          sourceId: sourceId.trim() === '' ? undefined : sourceId.trim(),
        },
      );
      showToast({
        variant: 'success',
        message: `Test message dispatched to ${trimmedMobile}.`,
      });
      onSuccess();
      onClose();
    } catch (err) {
      setInlineError(formatApiError(err, { fallback: 'Test send failed.' }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Test &ldquo;{target.name}&rdquo;</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/*
            * Hard-rule callout. Repeats the BE guarantee at the top of
            * the modal so the operator can't miss it — the entire point
            * of this dialog is "real recipient is NEVER contacted",
            * surface that visibly.
            */}
          <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2 text-xs leading-relaxed">
            <strong>Safety rule:</strong> the test WhatsApp is sent to the
            mobile number you enter below — and <strong>only</strong> to that
            number. Even if you provide an existing {target.testSourceLabel || 'source ID'}{' '}
            below, that record&apos;s real owner will <strong>not</strong> receive
            the message.
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              Mobile Number <span className="text-red-600">*</span>
            </label>
            <Input
              type="tel"
              inputMode="numeric"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="10-digit Indian mobile (e.g. 9876543210)"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Where the test WhatsApp will land. 10 digits, India (or 12
              digits including the 91 prefix).
            </p>
            {!mobileValid && trimmedMobile.length > 0 && (
              <p className="text-[11px] text-destructive mt-1">
                Enter a valid 10-digit Indian mobile number.
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              {target.testSourceLabel || 'Source ID'}{' '}
              <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </label>
            <Input
              type="text"
              inputMode="numeric"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              placeholder="Leave blank to use dummy details"
            />
            {target.testSourceHelp && (
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                {target.testSourceHelp}
              </p>
            )}
            {!sourceIdLooksValid && (
              <p className="text-[11px] text-destructive mt-1">
                ID must be a positive integer.
              </p>
            )}
          </div>

          {inlineError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 text-destructive text-xs px-3 py-2">
              {inlineError}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
            >
              <Send className="h-3.5 w-3.5 mr-1" />
              {submitting ? 'Sending…' : 'Send Test Message'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/*
 * JobDescription — pretty-prints the multi-paragraph plain-text
 * descriptions authored in `server/scheduler.js` into typographically
 * proper visual blocks.
 *
 * Two-stage parser (2026-06-06 rewrite — the previous version required
 * EVERY line of a paragraph to be numbered, which meant a paragraph
 * like "Here's how it works:\n  1. Step\n  2. Step" fell through to
 * the plain-paragraph branch and lost its list structure):
 *
 *   STAGE 1 — split on blank lines into "paragraphs".
 *   STAGE 2 — within each paragraph, walk lines and group them into
 *             runs of consecutive numbered lines (rendered as <ol>)
 *             vs runs of plain lines (rendered as a paragraph). One
 *             paragraph can therefore produce multiple blocks: a
 *             lead-in sentence followed by a numbered list followed
 *             by a trailing wrap-up sentence.
 *
 * Plus:
 *   - A run's FIRST line may start with a label like "What this task
 *     does:" or "Why this matters:" — bolded via LABEL_RX.
 *   - Numbered lines may also embed inline labels (e.g. step body
 *     starting with "Cooldown — …") but we don't try to bold those;
 *     the numbered context already provides enough structure.
 *
 * Pure-function renderer; no state, no effects.
 */
function JobDescription({ text }: { text: string }) {
  if (!text) return null;
  // Split on one-or-more blank lines so authors who accidentally type
  // 3 newlines get the same single paragraph break.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+$/, ''));
  // ^Phrase: — short Title-Cased phrase ending in a colon, then a space
  // and the rest of the sentence. Capped at 80 chars so a random
  // mid-sentence colon doesn't get bolded.
  const LABEL_RX = /^([A-Z][^:\n]{0,80}):\s+/;
  const NUMBERED_LINE_RX = /^\s*(\d+)\.\s+(.*)$/;

  /*
   * Within a single paragraph, build a list of "blocks":
   *   { type: 'list', items: string[] }  — consecutive numbered lines
   *   { type: 'text', text: string }      — consecutive plain lines
   *                                          joined with a single space
   * The walker flushes whenever it transitions between line types,
   * so a paragraph can yield multiple blocks.
   */
  function parseParagraph(para: string): Array<
    | { kind: 'list'; items: string[] }
    | { kind: 'text'; text: string }
  > {
    const blocks: Array<
      | { kind: 'list'; items: string[] }
      | { kind: 'text'; text: string }
    > = [];
    let currentText: string[] = [];
    let currentList: string[] = [];
    const flushText = () => {
      if (currentText.length === 0) return;
      blocks.push({ kind: 'text', text: currentText.join(' ').trim() });
      currentText = [];
    };
    const flushList = () => {
      if (currentList.length === 0) return;
      blocks.push({ kind: 'list', items: currentList });
      currentList = [];
    };
    for (const rawLine of para.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(NUMBERED_LINE_RX);
      if (m) {
        flushText();
        currentList.push(m[2]);
      } else {
        flushList();
        currentText.push(line);
      }
    }
    flushText();
    flushList();
    return blocks;
  }

  function renderTextWithLabel(text: string, key: string | number) {
    const labelMatch = text.match(LABEL_RX);
    if (labelMatch) {
      const rest = text.slice(labelMatch[0].length);
      return (
        <p key={key}>
          <strong className="font-semibold text-foreground">{labelMatch[1]}:</strong>{' '}
          {rest}
        </p>
      );
    }
    return <p key={key}>{text}</p>;
  }

  return (
    <div className="space-y-3 max-w-[72ch]">
      {paragraphs.flatMap((para, pIdx) => {
        if (!para.trim()) return [];
        const blocks = parseParagraph(para);
        return blocks.map((b, bIdx) => {
          const key = `${pIdx}-${bIdx}`;
          if (b.kind === 'list') {
            return (
              <ol
                key={key}
                className="list-decimal pl-6 space-y-1.5 marker:text-muted-foreground marker:font-semibold"
              >
                {b.items.map((item, i) => (
                  <li key={i} className="pl-1">{item}</li>
                ))}
              </ol>
            );
          }
          return renderTextWithLabel(b.text, key);
        });
      })}
    </div>
  );
}
