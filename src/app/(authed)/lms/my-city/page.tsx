'use client';

/*
 * LMS → My City (spec screen B-13) — the state manager's own screen.
 *
 * WHY ONE SENTENCE AND NOT FOUR TILES
 *
 * The spec is explicit: "A counter at the top: '9 technicians in your city are
 * not earning because of pending training.' That sentence is the whole screen.
 * It connects training to money, which is what a state manager actually cares
 * about." So the hero here is `data.headline`, rendered VERBATIM — the server
 * composes it, singular/plural included, so the number and the words it sits
 * in cannot disagree. <ActionCounters> deliberately is NOT used: a four-tile
 * grid would bury the one line that is the reason this page exists, and three
 * of its four counters are the training team's framing, not a field manager's.
 *
 * The sentence counts TECHNICIANS, not assignments — one person owing three
 * modules is one person not earning. That is also why "Paused" below is drawn
 * one card per technician while "Overdue" is one row per module.
 *
 * PAUSED AND OVERDUE ARE THE SAME ROWS, AND THAT IS SAID OUT LOUD
 *
 * GET /field/my-city returns ONE `overdue` array, presented twice (see the
 * handler in routes/admin/lms-action.js — both are `overdue.rows`). They are
 * two readings of one population: who is stopped, and which modules stopped
 * them. Rendering them as two anonymous lists would show the reader the same
 * nine people twice and imply eighteen problems, so the Overdue section states
 * its relationship to the one above it in its own subtitle.
 *
 * `pending` (status=not_started) is NOT disjoint from `overdue` either — the
 * chips partition nothing: "overdue" is a statement about a DEADLINE and
 * "not started" one about PROGRESS. The server's own `status` field is the
 * only overlap test used here (an unstarted row it calls 'overdue' is in the
 * list above), so no second definition of overdue is invented client-side.
 *
 * NO CREATE, NO PUSH, NOT EVEN DISABLED
 *
 * A state manager holds isLmsAction and nothing else; assignment, module
 * editing and push all 403 at the route. So this page renders no such control
 * in any state — a greyed-out "Assign" would advertise a door that is walled
 * up. The only actions on the page are the per-row chase buttons, which is
 * exactly the spec's row: "technician · what is pending · how long · WhatsApp
 * · Call · Mark chased".
 *
 * WHAT THIS ENDPOINT DOES NOT SEND
 *
 * PendingRow carries `last_chased_at` / `chase_count_7d`, but only the B-02
 * drilldown decorates its rows with chaseSummaryFor(); /field/my-city does
 * not. Those two fields therefore arrive UNDEFINED here and are deliberately
 * not rendered — "Last chased —" on every row is a worse lie than silence.
 * Chase history that IS known for a row appears in the hand-off section, which
 * has its own `first_chased_at` column.
 */

import { useMemo } from 'react';
import {
  MapPin, Lock, AlertTriangle, PauseCircle, CalendarClock,
  ClipboardList, Handshake, CheckCircle2, RefreshCw,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { RefreshBar } from '@/components/ui/refresh-bar';
import { ChaseButtons } from '@/components/lms/ChaseButtons';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { dueLabel, daysPast, type PendingRow } from '@/lib/lms-action';
import { formatDate } from '@/lib/utils';

const ENDPOINT = '/admin/lms/field/my-city';

/*
 * The handler passes `limit: 200` to every list it builds and forwards no
 * `total`, so a saturated list is the ONLY signal that rows were cut. Each
 * section says so at 200 rather than presenting a truncated list as complete —
 * on this screen an invisible technician is one nobody chases.
 */
const LIST_CAP = 200;

type HandoffRow = {
  id: number;
  efr_id: number;
  course_id: number | null;
  city_id: number | null;
  /* 'open' | 'chased' — the handler filters to exactly those two. */
  status: string;
  note: string | null;
  created_at: string | null;
  first_chased_at: string | null;
  batch_id: string | null;
  technician_name: string | null;
  efr_no: string | null;
  course_name: string | null;
};

type MyCityResponse = {
  /* IST calendar day the server judged every deadline against. Every "N days
   * late" on this page is measured from THIS, not from the browser's clock. */
  today: string;
  notEarningCount: number;
  /* Rendered verbatim — see the note at the top of this file. */
  headline: string;
  overdue: PendingRow[];
  pending: PendingRow[];
  handedOff: HandoffRow[];
};

/*
 * mysql2 hands back COUNT(*) columns as strings once they widen, so
 * `videos_done` / `videos_total` can arrive as "3". Coerce at the edge; the
 * numbers are only ever displayed, never compared.
 */
function toNum(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* 'YYYY-MM-DD' → '21 Aug 2026'. A bare DATE must not go through formatDate():
 * that parses it as UTC midnight and prints an 05:30 IST time nobody meant. */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatYmd(v: string | null | undefined): string | null {
  const ymd = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return `${ymd.slice(8, 10)} ${MONTH_ABBR[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
}

/*
 * Chip colour for a deadline. The SERVER's `status` decides what is overdue —
 * daysPast() only shapes the softer end of the scale, so this can never paint
 * a row red that the backend does not also consider late.
 */
function dueTone(status: string, dueDate: string | null, today: string): StatusChipTone {
  if (status === 'overdue') return 'urgent';
  const n = daysPast(dueDate, today);
  if (n === null) return 'neutral';
  return n >= -3 ? 'warning' : 'info';
}

type PausedTechnician = {
  efrId: number;
  name: string | null;
  efrNo: string | null;
  cityName: string | null;
  rows: PendingRow[];
};

/*
 * One entry per technician, in first-appearance order.
 *
 * This is not a second count: it is the SAME fold the server does to produce
 * notEarningCount (`new Set(overdue.rows.map(r => r.easyfixer_id))`), over the
 * same array, so the number of cards and the number in the sentence agree by
 * construction. A Map keeps insertion order, and the server already sorts by
 * `(due_date IS NULL), due_date ASC` — so the technician stuck longest is
 * first, which is what the spec asks for. Do not re-sort: any local ordering
 * would be a second opinion about "oldest".
 */
function groupByTechnician(rows: PendingRow[]): PausedTechnician[] {
  const byEfr = new Map<number, PausedTechnician>();
  for (const r of rows) {
    const id = Number(r.easyfixer_id);
    const existing = byEfr.get(id);
    if (existing) existing.rows.push(r);
    else {
      byEfr.set(id, {
        efrId: id,
        name: r.technician_name,
        efrNo: r.efr_no,
        cityName: r.city_name,
        rows: [r],
      });
    }
  }
  return Array.from(byEfr.values());
}

export default function MyCityPage() {
  const { me } = useMe();
  /* Action key, never a role name — "state manager" is a SCOPE (manage_states)
   * plus this one permission, not a role_id, and the route agrees. */
  const can = actionFlags(me, ['isLmsAction']);

  /* Deferred until the permission is known, so a user without it never fires a
   * request the route would 403 anyway. */
  const city = useFetch<MyCityResponse>(can.isLmsAction ? ENDPOINT : null);
  const data = city.data;

  const paused = useMemo(() => groupByTechnician(data?.overdue ?? []), [data]);

  const today = data?.today ?? '';
  const overdue = data?.overdue ?? [];
  const pending = data?.pending ?? [];
  const handedOff = data?.handedOff ?? [];
  const nothingOutstanding =
    !!data && paused.length === 0 && overdue.length === 0
    && pending.length === 0 && handedOff.length === 0;

  /*
   * After a chase: evict the cached response AND refetch. Eviction alone only
   * helps the next mount — this page never unmounts while the operator works
   * down the list, so without the refetch a row they just chased would keep
   * its pre-chase state until a reload.
   */
  function afterChase() {
    invalidateFetch((k) => k.startsWith('/admin/lms/field'));
    city.refetch();
  }

  if (!can.isLmsAction) {
    return (
      <div className="space-y-4">
        <PageHeading />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
              <Lock className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don’t have permission to view training follow-up for your city.
                Ask an admin to grant you LMS Action
                (<code className="mx-0.5">isLmsAction</code>) in Settings → Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading />
        <div className="flex items-center gap-2">
          {today && (
            <span className="text-xs text-muted-foreground">
              As Of {formatYmd(today) ?? today}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => city.refetch()}
            disabled={city.loading || city.refreshing}
          >
            <RefreshCw className={`size-4 ${city.refreshing ? 'animate-spin' : ''}`} />
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>
      </div>

      <RefreshBar active={city.refreshing} />

      {city.error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-3 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {city.error}
          </CardContent>
        </Card>
      )}

      {city.loading && (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      )}

      {/*
        THE HERO. One sentence, server-composed, printed as sent.

        Tone follows the number: a red plate over "0 technicians … are not
        earning" would train people to read red as decoration. Zero is the good
        outcome and is dressed as one.
      */}
      {data && (
        <Card className={data.notEarningCount > 0 ? 'border-urgent/40' : 'border-success/40'}>
          <CardContent
            className={`flex items-start gap-4 p-6 ${
              data.notEarningCount > 0 ? 'bg-urgent-tint' : 'bg-success-tint'
            }`}
          >
            <span
              className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full ${
                data.notEarningCount > 0
                  ? 'bg-destructive text-primary-foreground'
                  : 'bg-success text-primary-foreground'
              }`}
              aria-hidden="true"
            >
              {data.notEarningCount > 0 ? <PauseCircle className="size-6" /> : <CheckCircle2 className="size-6" />}
            </span>
            <div className="space-y-1">
              <p
                className={`text-xl leading-snug font-semibold sm:text-2xl ${
                  data.notEarningCount > 0 ? 'text-urgent-strong' : 'text-success-strong'
                }`}
              >
                {data.headline}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.notEarningCount > 0
                  ? 'A technician whose training is overdue cannot take new jobs, continue assigned jobs or mark attendance until the course is finished.'
                  : 'Nobody in your city is blocked from taking jobs by training right now.'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* A genuinely clear city gets one clear card, not four empty lists. */}
      {nothingOutstanding && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success-tint text-success-strong">
              <CheckCircle2 className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Nothing To Chase Today</div>
              <p className="max-w-md text-sm text-muted-foreground">
                No paused technicians, no overdue modules, nothing waiting to be
                started and nothing handed to you. Good day.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !nothingOutstanding && (
        <div className="space-y-4">
          {/* 1 · PAUSED — the spec's first list, and the only one grouped by
              person, because "not earning" is a fact about a technician. */}
          <Section
            icon={<PauseCircle className="size-4" />}
            tone="urgent"
            title="Paused — Not Earning Right Now"
            subtitle="Training is overdue, so their app is restricted. Longest stuck first."
            count={paused.length}
            capped={data.overdue.length >= LIST_CAP}
            cappedNote="Only the first 200 overdue modules were returned, so this list may be shorter than the sentence above."
            emptyText="Nobody in your city is paused."
          >
            {paused.map((tech) => (
              <div key={tech.efrId} className="border-b border-border px-3 py-3 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <TechnicianIdentity name={tech.name} efrNo={tech.efrNo} cityName={tech.cityName} />
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {tech.rows.length === 1
                        ? '1 module overdue'
                        : `${tech.rows.length} modules overdue`}
                    </div>
                  </div>
                  {/*
                    One chase per PERSON. courseId is sent only when there is a
                    single module to name — attaching one of three courses to a
                    chase about all three would file the history against the
                    wrong module.
                  */}
                  <ChaseButtons
                    compact
                    target={{
                      efrIds: [tech.efrId],
                      courseId: tech.rows.length === 1 ? tech.rows[0].course_id : null,
                    }}
                    onDone={afterChase}
                  />
                </div>
                <ul className="mt-2 space-y-1">
                  {tech.rows.map((r) => (
                    <li
                      key={`${r.easyfixer_id}-${r.course_id}`}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded bg-muted px-2 py-1 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate" title={r.course_name ?? ''}>
                        {r.course_name || 'Untitled course'}
                      </span>
                      <VideoProgress row={r} />
                      <StatusChip tone={dueTone(String(r.status), r.due_date, today)} size="sm">
                        {dueLabel(r.due_date, today)}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Section>

          {/* 2 · OVERDUE — same people, one row per module. Said plainly in the
              subtitle so the two sections never read as two populations. */}
          <Section
            icon={<CalendarClock className="size-4" />}
            tone="urgent"
            title="Overdue"
            subtitle="Deadline passed. The same technicians as above, broken out one row per module."
            count={overdue.length}
            capped={overdue.length >= LIST_CAP}
            cappedNote="Showing the first 200 overdue modules."
            emptyText="No module in your city is past its date."
          >
            {overdue.map((r) => (
              <AssignmentRow
                key={`${r.easyfixer_id}-${r.course_id}`}
                row={r}
                today={today}
                onDone={afterChase}
              />
            ))}
          </Section>

          {/* 3 · PENDING — assigned, not started. */}
          <Section
            icon={<ClipboardList className="size-4" />}
            tone="warning"
            title="Pending"
            subtitle="Assigned but not a single video watched yet. Chase these before they become overdue."
            count={pending.length}
            capped={pending.length >= LIST_CAP}
            cappedNote="Showing the first 200 unstarted modules."
            emptyText="Everyone assigned a course has at least started it."
          >
            {pending.map((r) => (
              <AssignmentRow
                key={`${r.easyfixer_id}-${r.course_id}`}
                row={r}
                today={today}
                onDone={afterChase}
                /* The server's own status — an unstarted row it calls overdue
                   is also in the section above, and saying so stops the two
                   lists being added together. */
                alsoOverdue={String(r.status) === 'overdue'}
              />
            ))}
          </Section>

          {/* 4 · HANDED TO YOU — the training team's explicit asks. Without a
              section of its own a hand-off is indistinguishable from the
              ambient list, which makes it ignorable, which defeats the point
              of handing anything off. */}
          <Section
            icon={<Handshake className="size-4" />}
            tone="info"
            title="Handed To You"
            subtitle="The training team pushed these to you by name. Oldest first."
            count={handedOff.length}
            capped={handedOff.length >= LIST_CAP}
            cappedNote="Showing the first 200 hand-offs."
            emptyText="Nothing has been handed to you."
          >
            {handedOff.map((h) => {
              const chasedOn = h.first_chased_at;
              return (
                <div
                  key={h.id}
                  className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <TechnicianIdentity name={h.technician_name} efrNo={h.efr_no} cityName={null} />
                    <div className="text-xs text-muted-foreground">
                      {h.course_name || 'No specific course'} · Handed over {formatDate(h.created_at)}
                    </div>
                    {/* The note is the whole reason this is a hand-off and not
                        another overdue row, so it is quoted, not summarised. */}
                    {h.note && (
                      <p className="rounded bg-muted px-2 py-1 text-xs leading-snug text-muted-foreground">
                        “{h.note}”
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {chasedOn ? (
                      <StatusChip tone="success" size="sm" title={`First chased ${formatDate(chasedOn)}`}>
                        Chased {formatDate(chasedOn)}
                      </StatusChip>
                    ) : (
                      <StatusChip tone="warning" size="sm" title="Nobody has recorded a chase against this hand-off yet.">
                        Not Chased Yet
                      </StatusChip>
                    )}
                    <ChaseButtons
                      compact
                      target={{ efrIds: [h.efr_id], courseId: h.course_id ?? null }}
                      onDone={afterChase}
                    />
                  </div>
                </div>
              );
            })}
          </Section>
        </div>
      )}
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <MapPin className="size-6" /> My City
      </h1>
      <p className="text-sm text-muted-foreground">
        Training follow-up for the cities you cover — who is stopped, what is
        pending, and what the training team has handed to you.
      </p>
    </div>
  );
}

/* Name · EFX id · city, in one consistent shape wherever a technician appears. */
function TechnicianIdentity({ name, efrNo, cityName }: {
  name: string | null;
  efrNo: string | null;
  cityName: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="truncate font-medium" title={name ?? ''}>
        {name || <span className="text-muted-foreground">Unnamed Technician</span>}
      </span>
      {efrNo && <span className="font-mono text-xs text-muted-foreground">{efrNo}</span>}
      {cityName && <span className="text-xs text-muted-foreground">· {cityName}</span>}
    </div>
  );
}

/* "3 / 8 Videos" — and "No Videos" when the course has no content, because
 * "0 / 0" reads as a technician who has watched nothing. */
function VideoProgress({ row }: { row: PendingRow }) {
  const done = toNum(row.videos_done);
  const total = toNum(row.videos_total);
  if (total === 0) {
    return (
      <span className="text-xs text-muted-foreground" title="This course has no videos yet.">
        No Videos
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
      {done.toLocaleString('en-IN')} / {total.toLocaleString('en-IN')} Videos
    </span>
  );
}

/*
 * The spec's row, literally: technician · what is pending · how long · chase.
 * Used by both assignment-level lists so Overdue and Pending scan identically.
 */
function AssignmentRow({ row, today, onDone, alsoOverdue = false }: {
  row: PendingRow;
  today: string;
  onDone: () => void;
  alsoOverdue?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <TechnicianIdentity name={row.technician_name} efrNo={row.efr_no} cityName={row.city_name} />
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground" title={row.course_name ?? ''}>
            {row.course_name || 'Untitled course'}
          </span>
          <span className="text-xs text-muted-foreground" aria-hidden="true">·</span>
          <VideoProgress row={row} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {alsoOverdue && (
          <StatusChip
            tone="urgent"
            size="sm"
            title="This row also appears in the Overdue list above — it is one assignment, not two."
          >
            Also Overdue
          </StatusChip>
        )}
        <StatusChip tone={dueTone(String(row.status), row.due_date, today)} size="sm">
          {dueLabel(row.due_date, today)}
        </StatusChip>
        <ChaseButtons
          compact
          target={{ efrIds: [row.easyfixer_id], courseId: row.course_id }}
          onDone={onDone}
        />
      </div>
    </div>
  );
}

const SECTION_TONE: Record<string, string> = {
  urgent: 'bg-urgent-tint text-urgent-strong',
  warning: 'bg-warning-tint text-warning-strong',
  info: 'bg-info-tint text-info-strong',
};

/*
 * One list, with its heading, its count and — when the server's 200-row cap
 * bit — a note saying so. `count` describes the rows actually rendered; it is
 * not a statistic derived about the population, which stays the server's job.
 */
function Section({ icon, tone, title, subtitle, count, capped, cappedNote, emptyText, children }: {
  icon: React.ReactNode;
  tone: 'urgent' | 'warning' | 'info';
  title: string;
  subtitle: string;
  count: number;
  capped: boolean;
  cappedNote: string;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`flex size-6 items-center justify-center rounded ${SECTION_TONE[tone]}`}>
                {icon}
              </span>
              <h2 className="text-sm font-semibold">{title}</h2>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                {capped ? `${count}+` : count.toLocaleString('en-IN')}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {count === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <div>{children}</div>
        )}
        {capped && (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{cappedNote}</p>
        )}
      </CardContent>
    </Card>
  );
}
