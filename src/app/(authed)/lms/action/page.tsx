'use client';

/**
 * LMS → Action Home (spec screen B-01).
 *
 * THE PREMISE, and what it forbids.
 *
 *   "Not a content library with tracking added on. An action tool. The home
 *    screen shows only what needs someone to do something. Anything moving
 *    normally stays invisible. Every row answers three things: who is stuck ·
 *    who owns it · what to do next."
 *
 * So this page is four counters, ONE list, and one sentence — and the list is
 * one list on purpose. A table per detector would read as six reports, and a
 * reader would have to work out which of the six is the urgent one; the server
 * already emits the rows in priority order (deadlines, then review, then not-
 * started, then client certification, then stalled modules) and this file
 * renders that order untouched. Re-sorting here would be a second opinion about
 * urgency, competing with the one the detectors encode.
 *
 * EVERY NUMBER COMES FROM THE SERVER, AND SO DOES THE DENOMINATOR SENTENCE.
 *
 * `summary.runningNormallyText` is printed VERBATIM. It is not assembled here
 * from `runningNormally` and it must never be: the server distinguishes three
 * cases the client cannot safely re-derive — nothing assigned at all, every
 * live module flagged, and N running normally — and the failure mode of
 * getting it wrong is "0 modules are running normally", which reads like a
 * rendering bug on the one line whose entire job is to be believable. The line
 * is what tells the team nothing is hidden; a line nobody believes is worse
 * than no line.
 *
 * WHAT IS NOT COMPUTABLE YET SAYS SO, ONCE.
 *
 * `unavailable` carries the detectors that cannot run (there is no sessions
 * table, so the 48-hour live-session check reports itself absent). It renders
 * as ONE muted line and never as a row: a placeholder row on a screen whose
 * premise is "everything here needs doing" is a lie with a button on it.
 *
 * PERMISSIONS.
 *
 *   isLmsAction — sees the screen. A state manager has this and a city scope;
 *                 the scope is applied server-side, so nothing here filters.
 *   isLmsManage — may PUSH. "Push now" is the one button that CREATES
 *                 assignments, and it is HIDDEN, not disabled, without the
 *                 key. The row is not left dead, though: it falls back to the
 *                 same drilldown link every other row has, because a state
 *                 manager still needs to see who is uncertified even though
 *                 the fix is not his to apply. The server enforces this
 *                 independently (requireLmsManage 403s a hand-crafted POST) —
 *                 hiding the button is the courtesy, not the control.
 *
 * REFRESH.
 *
 * The server caches the whole payload for 60s per city scope, and `fresh`
 * bypasses it. It is a Joi BOOLEAN, which in Joi 17 coerces from 'true'/'false'
 * and NOT from '1'/'0' — `?fresh=1` 400s. Hence `fresh=true` in the key below.
 * The flag lives in the fetch key (the shared-hooks rule: everything that
 * affects the result is in the key), and `refetch()` covers the second click,
 * where the key has not changed but the operator still wants a live read.
 */

import * as React from 'react';
import Link from 'next/link';
import { ListChecks, RefreshCw, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { ActionCounters } from '@/components/lms/ActionCounters';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatApiError } from '@/lib/api-errors';
import type { ActionHome, ActionRow, DetectorKey } from '@/lib/lms-action';

/*
 * The "why" chip on each row. The server's `item` names the THING; this names
 * the CHECK that produced it, which is what makes a mixed list scannable —
 * without it "Fridge Repair Level 2" and "Paused, has not started training"
 * sit side by side with no clue that one is a module and one is a population.
 *
 * `session_48h` is here for completeness of the union only. It is currently
 * unavailable server-side and therefore emits no rows; the entry exists so the
 * day it lands it renders like the rest rather than crashing on a missing key.
 */
const DETECTOR_META: Record<DetectorKey, { label: string; tone: StatusChipTone }> = {
  deadline_passed: { label: 'Deadline Passed', tone: 'urgent' },
  session_48h: { label: 'Live Session', tone: 'info' },
  assessment_failed: { label: 'Needs Review', tone: 'gold' },
  paused_not_started: { label: 'Not Started', tone: 'warning' },
  client_uncertified: { label: 'Certification', tone: 'info' },
  stale_module: { label: 'Stalled', tone: 'warning' },
};

/*
 * The server owns the WORDS on each button ('Chase', 'Review', 'Open list',
 * 'Push now') so a copy change lands without a frontend deploy; the CRM owns
 * the CASING, because every button in this app is Title Case. Mapping the
 * labels locally instead would fork the copy — the point is that the server
 * still decides what the button says.
 */
function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * 'YYYY-MM-DD' → '21 Aug 2026', read character-wise.
 *
 * `today` is the server's IST calendar day. Feeding it to `new Date(...)`
 * parses it as UTC midnight and then prints it in the BROWSER's zone, which
 * moves the date back a day for anyone west of Greenwich — on the one field
 * whose whole meaning is "the day the counters below describe".
 */
function formatYmd(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[3]} ${MONTH_ABBR[month - 1]} ${m[1]}`;
}

/*
 * Every detector counts DISTINCT TECHNICIANS (D1/D4/D5/D6 group on
 * easyfixer_id; D3 is one row per technician), so one unit word is correct for
 * the whole column. Stating it matters for the same reason the counter tiles
 * state theirs: a bare "12" next to a module name reads as twelve modules.
 */
function stuckLabel(n: number): string {
  return `${n.toLocaleString('en-IN')} technician${n === 1 ? '' : 's'}`;
}

/** POST /admin/lms/action/client-push. `message` is the "nothing to do" arm. */
type PushResult = {
  requested?: number;
  assigned?: number;
  alreadyAssigned?: number;
  alreadyComplete?: number;
  due_date?: string | null;
  message?: string;
};

/*
 * Feedback that reflects what HAPPENED, not what was asked for.
 *
 * assignCourse upserts, so most of a push is usually already-held rows. A flat
 * "Pushed" on a call that created nothing is the kind of lie that makes an
 * operator push twice.
 */
function describePush(r: PushResult): { variant: 'success' | 'warning'; message: string } {
  const assigned = Number(r.assigned || 0);
  if (assigned === 0 && r.message) return { variant: 'warning', message: r.message };
  const bits = [`${assigned} assigned`];
  if (r.alreadyAssigned) bits.push(`${r.alreadyAssigned} already held`);
  if (r.alreadyComplete) bits.push(`${r.alreadyComplete} already complete`);
  const due = formatYmd(r.due_date);
  if (due) bits.push(`due ${due}`);
  return { variant: assigned > 0 ? 'success' : 'warning', message: bits.join(' · ') };
}

/* Rows have no id of their own — the (detector, client, item) triple is what
 * makes one unique, and it is exactly what the server groups by. */
function rowKey(r: ActionRow): string {
  return `${r.detector}:${r.clientId ?? ''}:${r.itemId ?? ''}`;
}

export default function LmsActionHomePage() {
  const confirm = useConfirm();
  const { me, loading: authLoading } = useMe();
  const can = actionFlags(me, ['isLmsAction', 'isLmsManage']);
  const canView = can.isLmsAction;
  const canManage = can.isLmsManage;

  /*
   * Sticky rather than momentary: once an operator has asked for a live read,
   * every later refetch on this page should also be live. Flipping it back to
   * false would silently hand them the 60s cache again on the next click.
   */
  const [forceFresh, setForceFresh] = React.useState(false);
  const [pushing, setPushing] = React.useState<string | null>(null);

  const homeKey = `/admin/lms/action/home?fresh=${forceFresh ? 'true' : 'false'}`;
  const homeFetch = useFetch<ActionHome>(canView ? homeKey : null);
  const data = homeFetch.data;
  const rows = data?.rows ?? [];

  function refresh() {
    /* First click changes the key (cache miss → real request). Later clicks
     * leave the key alone, so refetch() is what actually re-requests. Doing
     * both covers each case without branching on which one this is. */
    setForceFresh(true);
    homeFetch.refetch();
  }

  async function pushNow(row: ActionRow) {
    /* Both ids are required by the endpoint's Joi schema. A client_uncertified
     * row always carries them; guarding beats sending a 400. */
    if (row.clientId == null || row.itemId == null) return;
    const ok = await confirm({
      title: 'Push This Module Now?',
      description:
        `${stuckLabel(row.stuckCount)} mapped to this client are not certified on it. `
        + 'Pushing assigns the module to all of them with the deadline from the '
        + "client's certification requirement. Anyone who already holds it keeps "
        + 'their existing deadline.',
      confirmLabel: 'Push Now',
      iconAccent: 'sky',
    });
    if (!ok) return;

    const key = rowKey(row);
    setPushing(key);
    const toastId = showToast({ variant: 'loading', message: 'Pushing…' });
    try {
      const res = await api.post<PushResult>('/admin/lms/action/client-push', {
        clientId: row.clientId,
        courseId: row.itemId,
      });
      dismissToast(toastId);
      showToast(describePush(res ?? {}));
      /*
       * The two-call idiom. Eviction alone never reaches a MOUNTED useFetch —
       * it clears the module cache but nothing re-requests, so the row would
       * keep showing the pre-push count until a full reload.
       */
      invalidateFetch((k) => k.startsWith('/admin/lms/action'));
      homeFetch.refetch();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Push Failed' }) });
    } finally {
      setPushing(null);
    }
  }

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ListChecks className="size-6" /> Action Home
        </h1>
        <p className="text-sm text-muted-foreground">
          Only what needs someone to do something. Anything moving normally stays off this screen.
        </p>
      </div>
      <div className="flex items-center gap-3">
        {formatYmd(data?.today) && (
          <span className="text-xs text-muted-foreground">As Of {formatYmd(data?.today)}</span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={!canView || homeFetch.loading || homeFetch.refreshing}
          title="Re-read past the 60-second server cache"
        >
          <RefreshCw className={`size-4 ${homeFetch.refreshing ? 'animate-spin' : ''}`} />
          <span className="ml-1.5">Refresh</span>
        </Button>
      </div>
    </div>
  );

  /* Auth resolves before anything is claimed about access: actionFlags fails
   * closed, so rendering the denial while `me` is still in flight would accuse
   * every user of having no permission for one paint. */
  if (!authLoading && !canView) {
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            You do not have access to the training action tool. Ask an administrator for the
            LMS Action permission.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}

      {homeFetch.error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-3 text-sm text-urgent">
            <AlertTriangle className="size-4 shrink-0" /> {homeFetch.error}
          </CardContent>
        </Card>
      )}

      {!data ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : (
        <>
          <ActionCounters counters={data.counters} />

          {/* The one number on the tiles that does not say what it is made of.
              "Someone has to decide" invites the question "decide what?", and
              the three arms are three different decisions. */}
          {data.counters.needsDecision > 0 && (
            <p className="text-xs text-muted-foreground">
              Needs decision breaks down as{' '}
              {data.counters.needsDecisionBreakdown.assessmentFailed.toLocaleString('en-IN')} failed
              an assessment ·{' '}
              {data.counters.needsDecisionBreakdown.chasedWithoutEffect.toLocaleString('en-IN')}{' '}
              chased without effect ·{' '}
              {data.counters.needsDecisionBreakdown.impossibleAssignment.toLocaleString('en-IN')}{' '}
              assigned a module with no content.
            </p>
          )}

          {rows.length === 0 ? (
            /* Positively, and without hiding the denominator line below — an
               empty action list is the goal state, not a failure to load. */
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                <CheckCircle2 className="size-8 text-success" />
                <p className="text-sm font-medium">Nothing Needs Action Today</p>
                <p className="text-xs text-muted-foreground">
                  Every check ran and found nothing stuck.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                {/* ONE list, in the server's priority order — see the file
                    header on why this is never re-sorted here. */}
                <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    {/* Item */}
                    <col style={{ width: '46%' }} />
                    {/* How Many Are Stuck */}
                    <col style={{ width: '16%' }} />
                    {/* Owner */}
                    <col style={{ width: '20%' }} />
                    {/* Action */}
                    <col style={{ width: '18%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="!text-left">What Needs Action</th>
                      <th className="!text-left">How Many Are Stuck</th>
                      <th className="!text-left">Owner</th>
                      <th className="!text-right">Do Next</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const meta = DETECTOR_META[row.detector];
                      const key = rowKey(row);
                      const isPush = row.detector === 'client_uncertified';
                      return (
                        <tr key={key}>
                          <td className="!text-left">
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusChip tone={meta?.tone ?? 'neutral'} size="sm">
                                {meta?.label ?? 'Needs Action'}
                              </StatusChip>
                              <span className="font-medium" title={row.item}>
                                {row.item}
                              </span>
                            </div>
                            {/* Only the stalled-module row carries a cohort
                                percentage, and it IS the reason the row exists. */}
                            {row.completionPct != null && (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {row.completionPct}% of the cohort has finished it
                              </div>
                            )}
                          </td>
                          <td className="!text-left tabular-nums">{stuckLabel(row.stuckCount)}</td>
                          <td className="!text-left truncate" title={row.owner}>
                            {row.owner || <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="!text-right">
                            {/* Exactly one button per row. Push is the only one
                                that writes, so it is the only filled one. */}
                            {isPush && canManage ? (
                              <Button
                                size="sm"
                                onClick={() => pushNow(row)}
                                disabled={pushing !== null}
                              >
                                {titleCase(row.button)}
                              </Button>
                            ) : isPush ? (
                              /* Push HIDDEN without isLmsManage — but the row
                                 still opens its list, so it is not a dead end. */
                              <Button asChild size="sm" variant="outline">
                                <Link href={row.href}>Open List</Link>
                              </Button>
                            ) : (
                              <Button asChild size="sm" variant="outline">
                                <Link href={row.href}>{titleCase(row.button)}</Link>
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <div className="space-y-1">
            {/* VERBATIM. See the file header — do not recompute, do not reword. */}
            <p className="text-xs text-muted-foreground">{data.summary.runningNormallyText}</p>

            {/* One line, never a row. */}
            {data.unavailable.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {data.unavailable.length === 1 ? 'One check is' : `${data.unavailable.length} checks are`}{' '}
                  not running yet, so nothing for {data.unavailable.length === 1 ? 'it' : 'them'} appears
                  above: {data.unavailable.map((u) => u.reason).join('; ')}.
                </span>
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
