'use client';

import { useState } from 'react';
import { History, MessageSquare, Send } from 'lucide-react';
import { useFetch, useTabVisible, invalidateFetch } from '@/lib/hooks';
import { formatDate, statusLabel } from '@/lib/utils';
import { api, ApiError, type JobChatMessage } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { pollIntervalMs } from '@/lib/ops-desk';

/*
 * JobActivity — the job's event stream (V3 plan 3.1).
 *
 * WHY A NINTH PANEL RATHER THAN A ROW IN AN EXISTING ONE. This job already has
 * five history surfaces: Rescheduling History and Calling History on Summary,
 * Scheduling History on Schedule, the Audit & History card, and the customer's
 * prior jobs behind a dialog. Every one of them answers ONE question from ONE
 * table. None of them answers "what has happened to this job", because the
 * table that knows — tbl_job_logs, ~1.7M rows since 2015 — had no reader in
 * this stack at all until GET /admin/jobs/:id/activity.
 *
 * So this is not a sixth variation on the same idea. The others are reports
 * over specific tables; this is the job's spine, and the V3 plan has it gating
 * 3.2 (the ops desk's "Pending on" and "Start proof") through 3.7.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not merge the other five in. A merged feed would have to invent a
 * common ordering across five tables with different time columns and different
 * notions of "when", and the first disagreement would be silent. This shows one
 * table honestly and says so.
 *
 * It has no filters, no search and no pagination. A job's history is tens of
 * rows; controls for narrowing tens of rows are furniture. The API caps the
 * feed and reports `truncated`, which is rendered rather than hidden — a
 * partial history presented as a whole one is the one failure that matters
 * here, because this panel's entire value is being complete.
 *
 * ── READING ORDER IS OLDEST-FIRST, ON PURPOSE ───────────────────────────────
 *
 * The API returns ascending, this renders ascending, and Scheduling History
 * beside it does the same (its route ends `ORDER BY sh.id ASC`). A job's
 * history is read as a story — offered, accepted, arrived, worked, closed —
 * and a newest-first feed makes an operator read the ending first. The API's
 * cap still bites at the RECENT end, so a long job shows its latest life and
 * not its first day; that asymmetry is deliberate and lives in the service.
 */

type Actor = {
  kind: 'technician' | 'user' | 'system' | 'legacy';
  userId: number | null;
  efrId: number | null;
  name: string | null;
};

export type ActivityEvent = {
  id: number;
  event: string;
  from: string | null;
  to: string | null;
  etaStatus: string | null;
  at: string;
  source: 'app' | 'crm' | 'system' | 'legacy';
  actor: Actor;
  writtenBy: string | null;
};

/*
 * log_for → what an operator should read.
 *
 * The keys are the production values and must stay byte-exact — services/
 * job-log.service.js pins them against the live table, including the two
 * mixed-case oddities ('Re-Scheduling', 'Re-visit Required') that look like
 * typos and are not. An unmapped value falls through to the raw string rather
 * than to "Unknown": a log_for this UI has not been taught is still perfectly
 * readable as itself, and hiding it behind a placeholder would lose the only
 * information the row carries.
 */
const EVENT_LABEL: Record<string, string> = {
  'new job': 'Job created',
  schedule: 'Scheduled',
  checkout: 'Checked out',
  'Re-Scheduling': 'Rescheduled',
  'Re-visit Required': 'Revisit required',
  'status change': 'Status changed',
  'customer pin resent': 'Customer PIN resent',
  'completed without customer pin': 'Closed without customer PIN',
  'customer pin verified': 'Customer PIN verified',
  'incentive awarded': 'On-time incentive awarded',
  'visit charge awarded': 'Visit charge awarded',
};

/*
 * 'Status: 2' is what the writer stores; 'In Progress' is what an operator
 * reads. Decoded through the SAME statusLabel() the job lists and chips use,
 * so a status cannot read one way here and another way on the row above.
 *
 * Anything that is not exactly 'Status: <digits>' is returned untouched — the
 * other events put real text in these columns (a revisit reason, 'Amount: 50',
 * 'Efr_id: 7'), and a looser parse would mangle them.
 */
function decodeStatus(value: string | null): string | null {
  if (!value) return null;
  const m = /^Status: (\d+)$/.exec(value);
  return m ? statusLabel(Number(m[1])) : value;
}

function actorText(e: ActivityEvent): string {
  const { actor } = e;
  if (actor.kind === 'technician') {
    // The name when we have it; the id when the technician row is gone. Never
    // a bare "Technician" — on a job worked by two people that is ambiguous.
    return actor.name ? `${actor.name} (technician)` : `Technician #${actor.efrId}`;
  }
  if (actor.kind === 'user') return actor.name ?? `User #${actor.userId}`;
  if (actor.kind === 'system') return 'System';
  /*
   * Legacy rows: show the old stack's OWN words ('Changed by CRM', 'Changed by
   * Api'). Translating them into today's vocabulary would assert an attribution
   * this backend cannot make — nobody recorded WHO in the old CRM, only that it
   * was the old CRM.
   */
  return e.writtenBy ?? 'Legacy';
}

const SOURCE_STYLE: Record<ActivityEvent['source'], string> = {
  app: 'bg-primary/10 text-primary',
  crm: 'bg-muted text-muted-foreground',
  system: 'bg-muted text-muted-foreground',
  legacy: 'bg-muted/60 text-muted-foreground',
};

const SOURCE_LABEL: Record<ActivityEvent['source'], string> = {
  app: 'App', crm: 'CRM', system: 'System', legacy: 'Legacy',
};

export default function JobActivity({ jobId }: { jobId: number | null }) {
  return (
    <>
      <JobChatPanel jobId={jobId} />
      <div className="mt-6 border-t pt-4">
        <ActivityFeed jobId={jobId} />
      </div>
    </>
  );
}

/*
 * JobChatPanel — the job chat thread + reply box (spec 3.4), mounted at the
 * top of the Activity tab. GET/POST /admin/jobs/:id/chat.
 *
 * Polling (perf standard — "poll only while visible; stop on
 * hidden/unmount"): 20s, and ONLY while this panel is actually mounted. It
 * mounts only while the Activity tab is the SELECTED tab — JobModal's Tabs
 * root uses Radix TabsContent, which (per the note on Panel/TabsContent
 * above) mounts only the active value — so switching tabs already unmounts
 * this and stops the poll; `useTabVisible` additionally stops it while the
 * browser tab itself is hidden/backgrounded. Refetches immediately after a
 * successful send rather than waiting for the next tick.
 */
function JobChatPanel({ jobId }: { jobId: number | null }) {
  const tabVisible = useTabVisible();
  const key = jobId ? `/admin/jobs/${jobId}/chat` : null;
  const { data, loading, error, dataKey, refetch } = useFetch<{ items: JobChatMessage[] }>(key, {
    refetchInterval: pollIntervalMs(tabVisible, 20_000),
  });
  const fresh = dataKey === key ? data : null;
  const messages = fresh?.items ?? [];

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    const body = draft.trim();
    if (!body || jobId == null) return;
    setSending(true);
    try {
      await api.postJobChat(jobId, body);
      setDraft('');
      // Refetch NOW rather than waiting for the poll tick — the operator's
      // own message should appear immediately.
      invalidateFetch((k) => k === key);
      refetch();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to send' });
    } finally {
      setSending(false);
    }
  }

  if (jobId == null) return null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Job Chat</h3>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto p-4">
        {loading && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading chat…</p>
        )}
        {error && <p className="text-sm text-destructive">Could not load this job&apos;s chat.</p>}
        {!loading && !error && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.senderKind === 'desk' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm ${m.senderKind === 'desk' ? 'bg-primary/10 text-foreground' : 'bg-muted text-foreground'}`}>
              <div>{m.body}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {m.senderName ?? (m.senderKind === 'desk' ? 'EasyFix' : 'Technician')} · {formatDate(m.sentOn)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-3">
        <input
          type="text"
          value={draft}
          maxLength={500}
          placeholder="Reply on this job…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !sending) send(); }}
          className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus-visible:border-foreground/40"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !draft.trim()}
          className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" /> Send
        </button>
      </div>
    </div>
  );
}

function ActivityFeed({ jobId }: { jobId: number | null }) {
  const key = jobId ? `/admin/jobs/${jobId}/activity` : null;
  const { data, loading, error, dataKey } =
    useFetch<{ items: ActivityEvent[]; truncated: boolean }>(key);
  // Only THIS job's history — never the previous job's while this one loads.
  // Same guard JobInternalNotes uses, for the same reason.
  const fresh = dataKey === key ? data : null;
  const items = fresh?.items ?? [];

  if (loading && items.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">Loading activity…</p>;
  }
  if (error) {
    return <p className="py-6 text-sm text-destructive">Could not load this job&apos;s activity.</p>;
  }
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <History className="h-4 w-4" />
        {/* Truthful about WHY it may be empty: the archive only has rows from
            the writers that were running at the time. */}
        <span>No recorded activity for this job yet.</span>
      </div>
    );
  }

  return (
    <div className="py-2">
      {fresh?.truncated && (
        <p className="mb-3 rounded border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Showing the most recent {items.length} events. Older entries exist but are not listed.
        </p>
      )}
      <ol className="relative border-l border-border pl-4">
        {items.map((e) => {
          const from = decodeStatus(e.from);
          const to = decodeStatus(e.to);
          // 'Status changed' already says the noun; the arrow carries the rest.
          // Other events put their own detail in `from` (a revisit reason, an
          // amount), so it is shown on its own line rather than as an arrow.
          const isTransition = e.event === 'status change' && !!from && !!to;
          return (
            <li key={e.id} className="relative mb-4 last:mb-0">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border" />
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground">
                  {EVENT_LABEL[e.event] ?? e.event}
                </span>
                {isTransition && (
                  <span className="text-sm text-muted-foreground">{from} → {to}</span>
                )}
                <span className={`rounded px-1.5 py-0.5 text-xs ${SOURCE_STYLE[e.source]}`}>
                  {SOURCE_LABEL[e.source]}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatDate(e.at)} · {actorText(e)}
              </div>
              {!isTransition && e.from && (
                <div className="mt-0.5 text-xs text-muted-foreground">{e.from}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
