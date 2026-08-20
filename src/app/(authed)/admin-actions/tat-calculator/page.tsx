'use client';

/*
 * TAT Calculator — Admin Action (isTatCalculatorView).
 *
 * REACHED ONLY FROM THE ADMIN ACTIONS HUB — there is deliberately no sidebar
 * entry. The tbl_menu leaf exists solely to give `isTatCalculatorView` a
 * menu_action to hang off, and is seeded with menu_status = 0 so it never
 * renders in the nav (see migrations/2026-08-21-tat-calculator-hide-from-
 * sidebar.sql for why menu_status is the right lever and dropping the id from
 * the visibility allowlist is NOT — the latter would redirect this route to
 * /coming-soon).
 *
 * Read-only preview of the centralised TAT engine
 * (EasyFix_Backend/services/tat.service.js), which implements
 * EasyFix_TAT_Final_August2026.xlsx "Developer Specification v1.0".
 * Nothing on this page writes, and nothing else consumes the engine yet.
 *
 * THE HEADLINE IS THE OWNERSHIP SPLIT. EasyFix owns Segments 1, 2 and 4; the
 * client owns Segment 3 (approval). The two scores are shown side by side and
 * NEVER merged, so a client sitting on an approval cannot drag EasyFix's score
 * down. Every layout decision below follows from that.
 *
 * The rules in "How It Works?" come from GET /admin/tat/policy — the same
 * constants the computation uses. A hand-copied table would drift the first
 * time a target changes, and a TAT page that disagrees with the TAT engine is
 * worse than no page.
 *
 * Chart colours: YES / NO / Pending are SEMANTIC, so they use QS_SEMANTIC
 * exclusively. The custom ESLint rule flags QS_COLORS[1..4] beside a
 * QS_SEMANTIC series (identical hex → indistinguishable bars); hand-picked
 * indices here stay ≥ 5 for that reason.
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  Timer, ArrowLeft, ChevronDown, Search, AlertTriangle, Info,
  CheckCircle2, XCircle, HelpCircle, Minus, Gauge, Building2, TrendingDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SearchSelect } from '@/components/ui/search-select';
import { ClientPicker } from '@/components/ui/client-picker';
import { CitySelect } from '@/components/ui/city-select';
import { useLookup } from '@/lib/use-lookup';
import { TechnicianPicker, type EasyfixerLite } from '@/components/ui/technician-picker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import {
  ChartCard, QsBarChart, QsDonut, QsKpiTile, QS_COLORS, QS_SEMANTIC,
} from '@/components/quicksight/charts';
import { DownloadButton } from '@/components/ui/download-button';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

// ─── Types (mirror services/tat.service.js) ──────────────────────────

type Status = 'YES' | 'NO' | 'N/A' | 'Pending';
type Performance = 'Excellent' | 'Good' | 'Partial' | 'Poor' | 'Pending';

type Segment = {
  no: number; key: string; label: string; owner: 'EasyFix' | 'Client';
  startLabel: string; endLabel: string;
  targetHours: number;
  startedAt: string | null; endedAt: string | null;
  hours: number | null; overrunHours: number | null;
  status: Status; note: string | null;
};

type ScoredJob = {
  jobId: number; jobReferenceId: string | null; jobStatus: number;
  clientName: string | null; cityName: string | null; tier: number | null;
  categoryName: string | null; technicianName: string | null;
  projectManager: string | null; verticalName: string | null;
  jobType: 'Local' | 'Travel';
  isEstimateSent: boolean; stopClockAvailable: boolean;
  appointmentAt: string | null; appointmentIsDateOnly: boolean;
  bookingLeadHours: number | null; punctualityHours: number | null;
  segments: Segment[];
  efScore: string; efMet: number; efTotal: number; efPct: number | null;
  clientScore: string; performance: Performance;
};

type SegmentTally = {
  no: number; key: string; label: string; owner: 'EasyFix' | 'Client';
  yes: number; noCount: number; na: number; pending: number;
  metPct: number | null; avgHours: number | null;
  avgOverrunHours: number | null; coveragePct: number | null;
};

type RollupRow = {
  name: string; jobs: number;
  efScorePct: number | null; efMet: number; efTotal: number;
  segmentMetPct: Array<number | null>;
  labels: Record<Performance, number>;
};

type Summary = {
  jobsAnalysed: number;
  efScorePct: number | null; efMet: number; efTotal: number;
  clientScorePct: number | null; clientMet: number; clientEvaluated: number;
  avgBookingLeadHours: number | null; avgPunctualityHours: number | null;
  arrivedOnTimePct: number | null; punctualityMeasurable: number;
  labels: Record<Performance, number>;
  segments: SegmentTally[];
  rollups: Record<string, RollupRow[]>;
};

type Assumption = { key: string; severity: 'warning' | 'info'; title: string; detail: string };
type OpenDecision = {
  id: string; owner: string; status: 'assumed' | 'blocked' | 'gap';
  question: string; today: string; impact: string;
};

type TatResult = {
  mode: string;
  subject?: { id: number; name: string };
  windowLabel?: string;
  truncated?: boolean; rowCap?: number;
  job?: ScoredJob;
  jobs?: ScoredJob[];
  summary: Summary;
  assumptions: Assumption[];
};

type Policy = {
  segments: Array<{ no: number; key: string; label: string; owner: string; startLabel: string; endLabel: string }>;
  targets: { seg1Local: number; seg1Travel: number; seg2: number; seg3: number; seg4: number };
  localityRule: string;
  seg3EscalationHours: number;
  labelThresholds: Array<{ label: string; min: number }>;
  rollupDimensions: Array<{ key: string; label: string }>;
  stopClockAvailable: boolean;
  clientLookbackDays: number;
  inputModes: Array<{ key: string; label: string; kind: string }>;
  assumptions: Assumption[];
  openDecisions: OpenDecision[];
};

// ─── Presentation ────────────────────────────────────────────────────

/*
 * The engine speaks the spec's vocabulary (YES / NO / N/A / Pending) because the
 * workbook does. The UI must not: "NO" reads as "the visit never happened", when
 * it means "it happened, but past the target". Every one of these segments is a
 * CLOCK, so the honest labels are On Time / Delayed.
 *
 * Not Recorded (rather than "Pending") for a missing anchor — "pending" implies
 * we are still waiting for the work, when in fact the work is done and it is the
 * TIMESTAMP that is absent.
 */
const STATUS_META: Record<Status, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  YES: { label: 'On Time', cls: 'bg-success-tint text-success-strong border-success/30', Icon: CheckCircle2 },
  NO: { label: 'Delayed', cls: 'bg-urgent-tint text-urgent-strong border-urgent/30', Icon: XCircle },
  Pending: { label: 'Not Recorded', cls: 'bg-muted text-muted-foreground border-border', Icon: HelpCircle },
  'N/A': { label: 'N/A', cls: 'bg-muted/50 text-muted-foreground/60 border-border', Icon: Minus },
};

function StatusChip({ status }: { status: Status }) {
  const m = STATUS_META[status];
  return (
    <Badge className={`border ${m.cls} gap-1 font-medium`}>
      <m.Icon className="h-3 w-3" />
      {m.label}
    </Badge>
  );
}

const PERF_CLS: Record<Performance, string> = {
  Excellent: 'bg-success-tint text-success-strong border-success/30',
  Good: 'bg-info-tint text-info-strong border-info/30',
  Partial: 'bg-warning-tint text-warning-strong border-warning/30',
  Poor: 'bg-urgent-tint text-urgent-strong border-urgent/30',
  Pending: 'bg-muted text-muted-foreground border-border',
};
const PERF_ORDER: Performance[] = ['Excellent', 'Good', 'Partial', 'Poor', 'Pending'];

function PerfChip({ label }: { label: Performance }) {
  return <Badge className={`border ${PERF_CLS[label]} font-medium`}>{label}</Badge>;
}

/* Open-decision status. `assumed` = we picked a default to keep moving;
 * `blocked` = nothing can be built until someone decides; `gap` = the decision
 * is made, the plumbing does not exist yet. */
const DECISION_META: Record<OpenDecision['status'], { label: string; cls: string }> = {
  assumed: { label: 'Assumed', cls: 'bg-warning-tint text-warning-strong border-warning/30' },
  blocked: { label: 'Needs A Decision', cls: 'bg-urgent-tint text-urgent-strong border-urgent/30' },
  gap: { label: 'Engineering Gap', cls: 'bg-info-tint text-info-strong border-info/30' },
};

const hrs = (n: number | null | undefined) => (n == null ? '—' : `${n}h`);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);

// ─── "How It Works?" ─────────────────────────────────────────────────

function HowItWorks({ policy }: { policy: Policy | null }) {
  const [open, setOpen] = useState(false);
  const t = policy?.targets;
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 p-4 text-left hover:bg-muted/40 transition-colors rounded-lg"
      >
        <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center shrink-0">
          <Info className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-medium">How It Works?</h2>
          <p className="text-xs text-muted-foreground">
            The four clocks, who owns each one, and what the numbers can and cannot tell you.
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <CardContent className="pt-0 space-y-5 border-t">
          <section className="space-y-2 pt-4">
            <h3 className="text-sm font-semibold">Four Independent Clocks — And Two Separate Scores</h3>
            <p className="text-sm text-muted-foreground">
              Every job gets a YES / NO / N/A / Pending flag per segment. The clocks are independent: a job
              that lost three days waiting on the client does not thereby fail its Visit or Completion
              segment. <strong>EasyFix owns Segments 1, 2 and 4. The client owns Segment 3.</strong> The two
              scores are reported separately so EasyFix is never penalised for a client delay.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 pt-1">
              {(policy?.segments ?? []).map((s) => (
                <div key={s.key} className="rounded-md border p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="h-5 w-5 rounded bg-primary/10 text-primary text-xs font-semibold grid place-items-center">
                      {s.no}
                    </span>
                    <span className="text-sm font-medium flex-1">{s.label}</span>
                    <Badge className={`border text-xs ${s.owner === 'Client'
                      ? 'bg-warning-tint text-warning-strong border-warning/30'
                      : 'bg-muted text-muted-foreground border-border'}`}
                    >
                      {s.owner}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.startLabel} <span aria-hidden="true">→</span> {s.endLabel}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">The Decision Tree</h3>
            <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal pl-5">
              <li>
                <strong>Local or Travel?</strong> A job is <strong>Local</strong> when at least one active
                technician&rsquo;s current or serviceable pincode matches the job&rsquo;s pincode —
                otherwise somebody has to travel, so it is <strong>Travel</strong>. This sets the Visit
                target ({t?.seg1Local ?? 24}h local, {t?.seg1Travel ?? 48}h travel) and{' '}
                <em>nothing else</em>. It is the same coverage test the allocation engine uses, so
                &ldquo;local&rdquo; means one thing across the platform — the same rule now drives
                Settings &rarr; Manage Pincodes. A job with no usable pincode is treated as Travel — the
                more forgiving target — rather than inventing a breach out of missing address data.
                From 20 Aug 2026 the answer is <strong>frozen when the job is created</strong>, so a later
                supply change cannot move a past job&rsquo;s target. Jobs created before that have no
                snapshot and are still classified live.
              </li>
              <li>
                <strong>Was an estimate sent?</strong> If not, Segments 2 and 3 are N/A and the job is
                scored on Visit and Completion alone. &ldquo;Sent&rdquo; is the moment it went to the
                client for approval — one event, one timestamp.
              </li>
              <li>
                <strong>If it was sent</strong> — how long did EasyFix take from the visit to send it?
                Target {t?.seg2 ?? 24}h.
              </li>
              <li>
                <strong>Then how long did the client take to decide?</strong> Target {t?.seg3 ?? 24}h.
                A rejection counts as NO. Past {policy?.seg3EscalationHours ?? 48}h the spec calls for an
                automatic reminder.
              </li>
              <li>
                <strong>Completion</strong> runs from the approval when there was one, otherwise from the
                visit. Target {t?.seg4 ?? 48}h. Any <strong>stop-clock</strong> time is deducted first —
                see below.
              </li>
            </ol>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">The Stop Clock</h3>
            <p className="text-sm text-muted-foreground">
              Completion pauses while the job is genuinely blocked — waiting on material, waiting on an
              OEM part, or waiting on entry permission. Only the portion of a pause that <em>overlaps</em>
              the Completion window is deducted, so a pause that began before the clock started cannot
              subtract time the clock was never running for. A pause still open at checkout is clamped
              there. Net time can never go below zero.
            </p>
            <p className="text-sm text-muted-foreground">
              Each pause records who owned it — <strong>EasyFix</strong>, <strong>Client</strong> or{' '}
              <strong>OEM / Vendor</strong> — so a delay caused by a supplier can be separated from one
              caused by us.
            </p>
            <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-sm">
              <div className="flex gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-strong shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Nothing writes a stop yet</div>
                  <p className="text-muted-foreground">
                    The ledger exists and Completion deducts from it, but no screen creates a pause today,
                    so in practice every job still reports <strong>gross</strong> time. Writing will be wired
                    once the numbers on this page have been verified by hand. Until then, a Completion
                    breach may be a supplier or access delay rather than an EasyFix one.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">How The Scores Are Built</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border p-3 space-y-1">
                <div className="text-sm font-medium">EasyFix Score</div>
                <p className="text-xs text-muted-foreground">
                  Segments 1, 2 and 4 only, as <code>met/total</code>. N/A and Pending are excluded from
                  the denominator, so a job we could only partly evaluate is scored on what we could see.
                </p>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <div className="text-sm font-medium">Client Score</div>
                <p className="text-xs text-muted-foreground">
                  Segment 3 alone — <code>1/1</code> or <code>0/1</code>. Never folded into the EasyFix
                  score, and never shown to a client as an EasyFix miss.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {(policy?.labelThresholds ?? []).map((l) => (
                <Badge key={l.label} className={`border ${PERF_CLS[l.label as Performance]} font-medium`}>
                  {l.label} · {l.min === 0 ? 'below 34' : l.min === 100 ? '100' : `${l.min}+`}%
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              A job has at most three EasyFix segments, so the reachable ratios are 0, 1/3, 1/2, 2/3 and 1.
              <strong> &ldquo;Good&rdquo; never appears on a single job</strong> — 2/3 is 66.7%, just under
              its 67% floor. It shows up only on group scores, which is why the sample workbook contains
              zero Good rows.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">What These Numbers Cannot Tell You</h3>
            <div className="space-y-2">
              {(policy?.assumptions ?? []).map((a) => (
                <div key={a.key} className="flex gap-2 text-sm">
                  {a.severity === 'warning'
                    ? <AlertTriangle className="h-4 w-4 text-warning-strong shrink-0 mt-0.5" />
                    : <Info className="h-4 w-4 text-info-strong shrink-0 mt-0.5" />}
                  <div>
                    <div className="font-medium">{a.title}</div>
                    <p className="text-muted-foreground">{a.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Open decisions ──────────────────────────────────────────
              Served by GET /admin/tat/policy, not hardcoded here: the list
              belongs to the engine, so anything that consumes TAT later
              inherits the same open questions instead of re-discovering them.
              An item disappears only when it is deleted from the service —
              which forces the decision to be real. */}
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-semibold">Open Decisions</h3>
            <p className="text-sm text-muted-foreground">
              What this flow has <strong>not</strong> settled yet. Each item names what happens today so the
              current numbers can be read correctly, and what changes once it is decided. This list lives
              with the computation, not in a doc.
            </p>
            {(['blocked', 'assumed', 'gap'] as const).map((group) => {
              const items = (policy?.openDecisions ?? []).filter((d) => d.status === group);
              if (!items.length) return null;
              return (
                <div key={group} className="space-y-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Badge className={`border ${DECISION_META[group].cls} font-medium`}>
                      {DECISION_META[group].label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {group === 'blocked' && 'Nothing can be built until someone decides.'}
                      {group === 'assumed' && 'A default was picked to keep moving — overrule it any time.'}
                      {group === 'gap' && 'Decided, but the plumbing does not exist yet.'}
                    </span>
                  </div>
                  <ol className="space-y-2">
                    {items.map((d, i) => (
                      <li key={d.id} className="rounded-md border p-3 space-y-1.5">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="h-5 w-5 rounded bg-muted text-xs font-semibold grid place-items-center shrink-0">
                            {i + 1}
                          </span>
                          <span className="text-sm font-medium flex-1 min-w-0">{d.question}</span>
                          <span className="text-xs text-muted-foreground shrink-0">{d.owner}</span>
                        </div>
                        <dl className="text-xs space-y-1 pl-7">
                          <div className="flex gap-2">
                            <dt className="text-muted-foreground shrink-0 w-24">Today</dt>
                            <dd className="text-muted-foreground flex-1">{d.today}</dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="text-muted-foreground shrink-0 w-24">Once Decided</dt>
                            <dd className="text-muted-foreground flex-1">{d.impact}</dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </section>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Result blocks ───────────────────────────────────────────────────

function AssumptionBanners({ items }: { items: Assumption[] }) {
  const warnings = items.filter((a) => a.severity === 'warning');
  if (!warnings.length) return null;
  return (
    <Card className="border-warning/30 bg-warning-tint">
      <CardContent className="p-3 space-y-1.5">
        {warnings.map((a) => (
          <div key={a.key} className="flex gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-warning-strong shrink-0 mt-0.5" />
            <div>
              <span className="font-medium">{a.title}.</span>{' '}
              <span className="text-muted-foreground">{a.detail}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* Per-segment elapsed-vs-target bar for the single-job view. Scaled to the
 * largest of (target, elapsed) across the job so a 60h overrun on a 48h target
 * reads as visibly over rather than clipped at the edge. */
function SegmentStrip({ job }: { job: ScoredJob }) {
  const scale = Math.max(1, ...job.segments.map((s) => Math.max(s.targetHours, s.hours ?? 0)));
  return (
    <div className="space-y-3">
      {job.segments.map((s) => {
        const na = s.status === 'N/A';
        const pending = s.status === 'Pending';
        return (
          <div key={s.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 min-w-0">
                <span className="h-5 w-5 rounded bg-muted text-xs font-semibold grid place-items-center shrink-0">
                  {s.no}
                </span>
                <span className="font-medium truncate">{s.label}</span>
                <Badge className={`border text-xs shrink-0 ${s.owner === 'Client'
                  ? 'bg-warning-tint text-warning-strong border-warning/30'
                  : 'bg-muted text-muted-foreground border-border'}`}
                >
                  {s.owner}
                </Badge>
                <span className="text-xs text-muted-foreground truncate hidden lg:inline">
                  {s.startLabel} <span aria-hidden="true">→</span> {s.endLabel}
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {na ? 'Not Applicable' : `${hrs(s.hours)} / ${s.targetHours}h target`}
                </span>
                <StatusChip status={s.status} />
              </span>
            </div>
            {!na && (
              <div className="relative h-2.5 rounded-full bg-muted overflow-hidden">
                {!pending && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${Math.min(100, ((s.hours ?? 0) / scale) * 100)}%`,
                      background: s.status === 'NO' ? QS_SEMANTIC.bad : QS_SEMANTIC.good,
                    }}
                  />
                )}
                {/* Target marker — the line the bar must not cross. */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-foreground/40"
                  style={{ left: `${Math.min(100, (s.targetHours / scale) * 100)}%` }}
                  aria-hidden="true"
                />
              </div>
            )}
            {s.note && <p className="text-xs text-muted-foreground pl-7">{s.note}</p>}
            {s.no === 1 && job.bookingLeadHours != null && (
              <p className="text-xs text-muted-foreground pl-7">
                Of that, <strong>{hrs(job.bookingLeadHours)}</strong> was the wait the customer chose; we
                arrived <strong>{(job.punctualityHours ?? 0) > 0
                  ? `${job.punctualityHours}h late`
                  : `${Math.abs(job.punctualityHours ?? 0)}h early`}</strong> against the appointment.
              </p>
            )}
            {s.no === 1 && job.appointmentIsDateOnly && (
              <p className="text-xs text-muted-foreground pl-7">
                Booked for a date with no time, so punctuality cannot be measured.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SummaryCharts({ summary }: { summary: Summary }) {
  const segData = summary.segments.map((s) => ({
    label: `${s.no} · ${s.label}${s.owner === 'Client' ? ' (Client)' : ''}`,
    YES: s.yes,
    NO: s.no,
    Pending: s.pending,
  }));
  const labelData = PERF_ORDER
    .map((l) => ({ name: l, count: summary.labels[l] ?? 0 }))
    .filter((d) => d.count > 0);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <ChartCard
        className="lg:col-span-2"
        title="Segment Outcomes"
        subtitle="Each clock scored independently. Delayed means it happened past the target — not that it never happened. Not Recorded means the timestamp is missing; it is never counted as on time."
      >
        <QsBarChart
          data={segData}
          xKey="label"
          layout="vertical"
          stacked
          height={240}
          series={[
            { key: 'On Time', color: QS_SEMANTIC.good },
            { key: 'Delayed', color: QS_SEMANTIC.bad },
            { key: 'Not Recorded', color: QS_SEMANTIC.neutral },
          ]}
        />
      </ChartCard>

      <ChartCard title="Performance Mix" subtitle="EasyFix-owned segments only.">
        {labelData.length ? (
          <QsDonut
            data={labelData}
            nameKey="name"
            valueKey="count"
            height={240}
            colors={[QS_SEMANTIC.good, QS_SEMANTIC.info, QS_SEMANTIC.warn, QS_SEMANTIC.bad, QS_SEMANTIC.neutral]}
          />
        ) : (
          <div className="h-[240px] grid place-items-center text-sm text-muted-foreground">
            No jobs to score.
          </div>
        )}
      </ChartCard>
    </div>
  );
}

/*
 * The Visit breakdown. A "Delayed" Visit is unactionable on its own: the clock
 * runs from ticket creation to check-in, and most of that gap is usually the
 * date the CUSTOMER asked for. These two figures separate their wait from our
 * punctuality, so the Visit rate can be read honestly.
 */
function VisitBreakdown({ summary }: { summary: Summary }) {
  if (summary.punctualityMeasurable === 0) return null;
  const p = summary.avgPunctualityHours;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <h3 className="text-sm font-semibold">What The Visit Clock Is Made Of</h3>
        <p className="text-sm text-muted-foreground">
          Visit runs from ticket created to check-in &mdash; so it contains the wait the customer asked for
          as well as our own responsiveness. Splitting it is the only way to tell those apart.
        </p>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 pt-1">
          <div className="rounded-md border p-3">
            <div className="text-2xl font-semibold tabular-nums">{hrs(summary.avgBookingLeadHours)}</div>
            <div className="text-xs font-medium">Booking Lead Time</div>
            <p className="text-xs text-muted-foreground">
              Ticket created &rarr; the appointment the customer chose. Entirely theirs &mdash; not scored.
            </p>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {p == null ? '\u2014' : `${p > 0 ? '+' : ''}${p}h`}
            </div>
            <div className="text-xs font-medium">Punctuality</div>
            <p className="text-xs text-muted-foreground">
              Appointment &rarr; check-in. Ours. A negative number means we arrived early.
            </p>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-2xl font-semibold tabular-nums">{pct(summary.arrivedOnTimePct)}</div>
            <div className="text-xs font-medium">Arrived On Time</div>
            <p className="text-xs text-muted-foreground">
              Of {summary.punctualityMeasurable} job(s) with a usable appointment time.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SegmentTable({ segments }: { segments: SegmentTally[] }) {
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm data-table">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Segment</th>
              <th className="text-left p-3 font-medium">Owner</th>
              <th className="text-right p-3 font-medium">On Time</th>
              <th className="text-right p-3 font-medium">Delayed</th>
              <th className="text-right p-3 font-medium">Not Recorded</th>
              <th className="text-right p-3 font-medium">N/A</th>
              <th className="text-right p-3 font-medium">On Time %</th>
              <th className="text-right p-3 font-medium">Coverage</th>
              <th className="text-right p-3 font-medium">Avg Hrs</th>
              <th className="text-right p-3 font-medium">Avg Overrun</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.key} className="border-t">
                <td className="p-3 font-medium">{s.no} · {s.label}</td>
                <td className="p-3">
                  <Badge className={`border ${s.owner === 'Client'
                    ? 'bg-warning-tint text-warning-strong border-warning/30'
                    : 'bg-muted text-muted-foreground border-border'}`}
                  >
                    {s.owner}
                  </Badge>
                </td>
                <td className="p-3 text-right tabular-nums text-success-strong">{s.yes}</td>
                <td className="p-3 text-right tabular-nums text-urgent-strong">{s.noCount}</td>
                <td className="p-3 text-right tabular-nums text-muted-foreground">{s.pending}</td>
                <td className="p-3 text-right tabular-nums text-muted-foreground/60">{s.na}</td>
                <td className="p-3 text-right tabular-nums font-medium">{pct(s.metPct)}</td>
                <td className="p-3 text-right tabular-nums text-muted-foreground">{pct(s.coveragePct)}</td>
                <td className="p-3 text-right tabular-nums">{hrs(s.avgHours)}</td>
                <td className="p-3 text-right tabular-nums">{hrs(s.avgOverrunHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/* Spec §4 rollups. One dimension at a time — seven tables stacked would bury
 * the signal, and the operator is asking one question at a time anyway. */
function Rollups({ summary, dimensions }: { summary: Summary; dimensions: Array<{ key: string; label: string }> }) {
  const [dim, setDim] = useState(dimensions[0]?.key ?? 'client');
  const rows = summary.rollups?.[dim] ?? [];
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold flex-1">Breakdown</h3>
          <div className="w-full sm:w-56">
            <SearchSelect
              value={dim}
              onChange={setDim}
              options={dimensions.map((d) => ({ value: d.key, label: d.label }))}
              placeholder="Pick A Dimension"
              required
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Sorted worst EasyFix score first. A group with nothing evaluable sorts last, so it cannot
          masquerade as the worst offender.
        </p>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm data-table">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">{dimensions.find((d) => d.key === dim)?.label}</th>
                <th className="text-right p-3 font-medium">Jobs</th>
                <th className="text-right p-3 font-medium">EF Score</th>
                <th className="text-right p-3 font-medium">Seg 1</th>
                <th className="text-right p-3 font-medium">Seg 2</th>
                <th className="text-right p-3 font-medium">Seg 3 (Client)</th>
                <th className="text-right p-3 font-medium">Seg 4</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t">
                  <td className="p-3 font-medium">{r.name}</td>
                  <td className="p-3 text-right tabular-nums">{r.jobs}</td>
                  <td className="p-3 text-right tabular-nums font-medium">
                    {pct(r.efScorePct)}
                    <span className="text-xs text-muted-foreground"> ({r.efMet}/{r.efTotal})</span>
                  </td>
                  {r.segmentMetPct.map((p, i) => (
                    <td key={i} className="p-3 text-right tabular-nums text-muted-foreground">{pct(p)}</td>
                  ))}
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Nothing to break down.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function JobsTable({ jobs }: { jobs: ScoredJob[] }) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState<TablePageSize>(20);
  const limit = pageSizeToLimit(size, jobs.length);
  const slice = jobs.slice(page * limit, page * limit + limit);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm data-table">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Job</th>
                <th className="text-left p-3 font-medium">Type</th>
                <th className="text-center p-3 font-medium">1 · Visit</th>
                <th className="text-center p-3 font-medium">2 · Estimate</th>
                <th className="text-center p-3 font-medium">3 · Approval</th>
                <th className="text-center p-3 font-medium">4 · Completion</th>
                <th className="text-right p-3 font-medium">EF</th>
                <th className="text-right p-3 font-medium">Client</th>
                <th className="text-left p-3 font-medium">Performance</th>
              </tr>
            </thead>
            <tbody>
              {slice.map((j) => (
                <tr key={j.jobId} className="border-t hover:bg-muted/30">
                  <td className="p-3">
                    <div className="font-medium">{j.jobReferenceId || j.jobId}</div>
                    <div className="text-xs text-muted-foreground">#{j.jobId}</div>
                  </td>
                  <td className="p-3 text-muted-foreground">{j.jobType}</td>
                  {j.segments.map((s) => (
                    <td key={s.key} className="p-3 text-center"><StatusChip status={s.status} /></td>
                  ))}
                  <td className="p-3 text-right tabular-nums font-medium">{j.efScore}</td>
                  <td className="p-3 text-right tabular-nums text-muted-foreground">{j.clientScore}</td>
                  <td className="p-3"><PerfChip label={j.performance} /></td>
                </tr>
              ))}
              {!slice.length && (
                <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">No completed jobs in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={page}
          pageSize={size}
          total={jobs.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setSize(s); setPage(0); }}
        />
      </CardContent>
    </Card>
  );
}

function Results({ result, dimensions }: { result: TatResult; dimensions: Array<{ key: string; label: string }> }) {
  const s = result.summary;
  const job = result.job;
  return (
    <div className="space-y-3">
      <AssumptionBanners items={result.assumptions} />

      {result.truncated && (
        <Card className="border-warning/30 bg-warning-tint">
          <CardContent className="p-3 flex gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-warning-strong shrink-0 mt-0.5" />
            <span>
              Showing the most recent <strong>{result.rowCap}</strong> completed jobs. There are more —
              this is a partial view, not the full history.
            </span>
          </CardContent>
        </Card>
      )}

      {/* ── The two scores, side by side and never merged ── */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <QsKpiTile
          label={job ? 'EasyFix Score (Seg 1·2·4)' : 'EasyFix Score'}
          value={job ? job.efScore : pct(s.efScorePct)}
          accent={QS_SEMANTIC.good}
          icon={<Gauge className="h-4 w-4" />}
        />
        <QsKpiTile
          label="Client Score (Seg 3)"
          value={job ? job.clientScore : pct(s.clientScorePct)}
          accent={QS_SEMANTIC.warn}
          icon={<Building2 className="h-4 w-4" />}
        />
        <QsKpiTile
          label={job ? 'Performance' : 'Jobs Analysed'}
          value={job ? job.performance : s.jobsAnalysed}
          accent={QS_COLORS[0]}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <QsKpiTile
          label={job ? 'Job Type' : 'Poor + Partial'}
          value={job ? job.jobType : (s.labels.Poor ?? 0) + (s.labels.Partial ?? 0)}
          accent={QS_SEMANTIC.bad}
          icon={<TrendingDown className="h-4 w-4" />}
        />
      </div>

      {job && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">{job.jobReferenceId || `Job #${job.jobId}`}</h2>
              <PerfChip label={job.performance} />
              <Badge className="border bg-muted text-foreground border-border">
                {job.jobType}{job.tier != null ? ` · Tier ${job.tier}` : ''}
              </Badge>
              <Badge className="border bg-muted text-foreground border-border">
                {job.isEstimateSent ? 'Estimate Sent' : 'No Estimate'}
              </Badge>
              {job.clientName && <span className="text-sm text-muted-foreground">{job.clientName}</span>}
              {job.cityName && <span className="text-sm text-muted-foreground">· {job.cityName}</span>}
              {job.technicianName && <span className="text-sm text-muted-foreground">· {job.technicianName}</span>}
            </div>
            <SegmentStrip job={job} />
          </CardContent>
        </Card>
      )}

      {!job && (
        <>
          <SummaryCharts summary={s} />
          <SegmentTable segments={s.segments} />
          <VisitBreakdown summary={s} />
          <Rollups summary={s} dimensions={dimensions} />
          <JobsTable jobs={result.jobs ?? []} />
        </>
      )}

      {job && <SegmentTable segments={s.segments} />}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────

export default function TatCalculatorPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isTatCalculatorView']);

  const [mode, setMode] = useState<string>('job');
  // The four dimension modes share one id box — they differ only in which
  // lookup feeds them, and adding a bespoke picker per dimension would be four
  // near-identical components for a diagnostic page.
  const [dimId, setDimId] = useState('');
  const lk = useLookup();
  /* Project managers are the one dimension useLookup does NOT preload, and the
   * endpoint is admin-gated — so it is fetched here and only when that tab is
   * actually open (null key = no request, and no guaranteed 403 for a
   * non-admin who never visits the tab). */
  const pmFetch = useFetch<Array<{ user_id: number; user_name: string }>>(
    mode === 'project-manager' ? '/shared/lookup/project-managers' : null,
  );
  const [downloading, setDownloading] = useState(false);
  const [jobId, setJobId] = useState('');
  const [clientId, setClientId] = useState<number | ''>('');
  const [tech, setTech] = useState<EasyfixerLite | null>(null);
  const [days, setDays] = useState('90');
  // The key is only set on Compute, so typing an id doesn't fire a request per
  // keystroke against a lifetime-scan endpoint.
  const [queryKey, setQueryKey] = useState<string | null>(null);

  // null key = no request. The early-return below happens AFTER hooks run, so
  // a permissionless visitor must not fire either fetch.
  const policy = useFetch<Policy>(can.isTatCalculatorView ? '/admin/tat/policy' : null);
  const result = useFetch<TatResult>(can.isTatCalculatorView ? queryKey : null);

  if (!can.isTatCalculatorView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Timer className="size-6" /> TAT Calculator
        </h1>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
              <AlertTriangle className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don&rsquo;t have permission to view the TAT Calculator. Ask an admin to grant you{' '}
                <code className="mx-0.5">isTatCalculatorView</code> in Settings &rarr; Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const DIMENSION_MODES = ['city', 'category', 'project-manager', 'vertical'];
  const isDimension = DIMENSION_MODES.includes(mode);

  const currentKey = () => {
    if (mode === 'job' && jobId.trim()) return `/admin/tat/job/${jobId.trim()}`;
    if (mode === 'client' && clientId) return `/admin/tat/client/${clientId}?days=${days || 90}`;
    if (mode === 'technician' && tech) return `/admin/tat/technician/${tech.efr_id}`;
    if (isDimension && dimId.trim()) return `/admin/tat/${mode}/${dimId.trim()}?days=${days || 90}`;
    return null;
  };

  const compute = () => setQueryKey(currentKey());

  const canCompute = !!currentKey();

  /* The export re-runs the SAME key with format=xlsx, so the file can never
   * disagree with what is on screen. */
  async function handleDownload() {
    const key = currentKey();
    if (!key || mode === 'job') return;
    setDownloading(true);
    try {
      // Pass the BARE path — downloadXlsx prepends NEXT_PUBLIC_API_URL itself.
      // Hardcoding '/api' here double-prefixes whenever that env var is set.
      const sep = key.includes('?') ? '&' : '?';
      await downloadXlsx({
        url: `${key}${sep}format=xlsx`,
        filename: `tat-${mode}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch {
      // Non-fatal — the on-screen result is unaffected by a failed export.
    } finally {
      setDownloading(false);
    }
  }

  const dimensions = policy.data?.rollupDimensions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/admin-actions" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Timer className="size-6" /> TAT Calculator
        </h1>
      </div>
      <p className="text-sm text-muted-foreground max-w-3xl">
        Segment-wise turnaround for a single job, a client&rsquo;s recent work, or a technician&rsquo;s whole
        history. EasyFix-owned and client-owned segments are scored separately. Read-only: nothing here is
        consumed by any report, chip or escalation yet.
      </p>

      <HowItWorks policy={policy.data ?? null} />

      <Card>
        <CardContent className="p-4">
          <Tabs value={mode} onValueChange={(v) => { setMode(v as typeof mode); setQueryKey(null); }}>
            <TabsList>
              <TabsTrigger value="job">By Job</TabsTrigger>
              <TabsTrigger value="client">By Client</TabsTrigger>
              <TabsTrigger value="technician">By Technician</TabsTrigger>
              <TabsTrigger value="city">By City</TabsTrigger>
              <TabsTrigger value="category">By Category</TabsTrigger>
              <TabsTrigger value="project-manager">By PM</TabsTrigger>
              <TabsTrigger value="vertical">By Vertical</TabsTrigger>
            </TabsList>

            <TabsContent value="job" className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-64">
                  <Label>Job ID</Label>
                  <Input
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 522124"
                    inputMode="numeric"
                  />
                </div>
                <p className="text-xs text-muted-foreground pb-2">
                  Any job. Segments still running will read Pending.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="client" className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-96">
                  <Label>Client</Label>
                  <ClientPicker
                    value={clientId}
                    onPick={(c) => { setClientId(c ? c.client_id : ''); setQueryKey(null); }}
                    placeholder="— Search By Client Name —"
                  />
                </div>
                <div className="w-full sm:w-40">
                  <Label>Lookback (Days)</Label>
                  <Input
                    value={days}
                    onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
                    placeholder="90"
                    inputMode="numeric"
                  />
                </div>
                <p className="text-xs text-muted-foreground pb-2">
                  Jobs completed in the window. Defaults to the last {policy.data?.clientLookbackDays ?? 90} days.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="technician" className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-96">
                  <Label>Technician</Label>
                  <TechnicianPicker
                    value={tech?.efr_id ?? ''}
                    onPick={(t) => { setTech(t); setQueryKey(null); }}
                    placeholder="— Search By Name, Mobile Or City —"
                  />
                </div>
                <p className="text-xs text-muted-foreground pb-2">
                  Every completed job across the technician&rsquo;s lifetime.
                </p>
              </div>
            </TabsContent>

            {DIMENSION_MODES.map((m) => (
              <TabsContent key={m} value={m} className="pt-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-full sm:w-80">
                    <Label>{policy.data?.inputModes?.find((x) => x.key === m)?.label ?? m}</Label>
                    {/* City is ~11k rows, so it gets the async server typeahead
                        (CitySelect) rather than a preloaded list. Categories and
                        verticals are small enough for useLookup's preload.
                        Project managers come from their own admin-gated fetch. */}
                    {m === 'city' && (
                      <CitySelect
                        value={dimId}
                        onChange={(id) => { setDimId(id); setQueryKey(null); }}
                        placeholder="— Select A City —"
                      />
                    )}
                    {m === 'category' && (
                      <SearchSelect
                        value={dimId}
                        onChange={(v) => { setDimId(v); setQueryKey(null); }}
                        options={lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }))}
                        placeholder="— Select A Category —"
                      />
                    )}
                    {m === 'vertical' && (
                      <SearchSelect
                        value={dimId}
                        onChange={(v) => { setDimId(v); setQueryKey(null); }}
                        options={lk.toOpts.verticals.map((o) => ({ value: o.value, label: String(o.label) }))}
                        placeholder="— Select A Vertical —"
                      />
                    )}
                    {m === 'project-manager' && (
                      <SearchSelect
                        value={dimId}
                        onChange={(v) => { setDimId(v); setQueryKey(null); }}
                        options={(pmFetch.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name }))}
                        placeholder={pmFetch.loading ? 'Loading Project Managers…' : '— Select A Project Manager —'}
                        emptyText={pmFetch.error ? 'Project Manager Lookup Failed' : 'No Project Managers Found'}
                      />
                    )}
                  </div>
                  <div className="w-full sm:w-40">
                    <Label>Lookback (Days)</Label>
                    <Input
                      value={days}
                      onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
                      placeholder="90"
                      inputMode="numeric"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground pb-2">
                    Every completed job in this{' '}
                    {(policy.data?.inputModes?.find((x) => x.key === m)?.label ?? m).toLowerCase()} within the window.
                  </p>
                </div>
              </TabsContent>
            ))}
          </Tabs>

          <div className="pt-4 flex flex-wrap items-center gap-2">
            <Button onClick={compute} disabled={!canCompute || result.loading}>
              <Search className="h-4 w-4 mr-1.5" />
              {result.loading ? 'Computing…' : 'Compute TAT'}
            </Button>
            {mode !== 'job' && (
              <DownloadButton
                onClick={handleDownload}
                downloading={downloading}
                disabled={!result.data || !(result.data.jobs || []).length}
                label="Download XLSX"
                title="One row per job with both scores — the same result that is on screen"
              />
            )}
          </div>
        </CardContent>
      </Card>

      {result.error && (
        <Card className="border-urgent/30 bg-urgent-tint">
          <CardContent className="p-4 flex gap-2 text-sm">
            <XCircle className="h-4 w-4 text-urgent-strong shrink-0 mt-0.5" />
            <span>{result.error}</span>
          </CardContent>
        </Card>
      )}

      {result.loading && (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Computing segment TAT…
          </CardContent>
        </Card>
      )}

      {!result.loading && !result.error && result.data && (
        <>
          {result.data.subject && (
            <div className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{result.data.subject.name}</span>
              {result.data.windowLabel ? ` · ${result.data.windowLabel}` : ''}
            </div>
          )}
          <Results result={result.data} dimensions={dimensions} />
        </>
      )}

      {!queryKey && !result.loading && (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Pick a job, client or technician above, then choose <strong>Compute TAT</strong>.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
