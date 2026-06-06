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

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown, ChevronRight, Play, RotateCcw, AlertTriangle, Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/StatusChip';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';

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
  lastTriggerKind: 'cron' | 'manual' | null;
};

type JobsResponse = { jobs: ScheduledJob[] };

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
    </div>
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
