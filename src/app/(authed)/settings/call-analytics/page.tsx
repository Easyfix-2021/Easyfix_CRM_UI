'use client';

/*
 * Settings → Call Analytics.
 *
 * A call-history table (linked to the job where available) with a "View
 * Analysis" action per row that opens an AI coaching report generated from the
 * call (GET /admin/calls/:id/analysis). Transcript comes from Plivo; the
 * communication analysis is LLM-generated + cached server-side.
 * RBAC-gated by isCallAnalyticsView.
 *
 * ANALYSIS MODE (2026-07): the coaching AI can read either the call's TEXT
 * TRANSCRIPT or the RECORDING AUDIO directly — a poor transcript caps the score,
 * so ops needs the audio route. It is chosen in exactly two places:
 *
 *   1. the global default in the filter row (GET/POST /admin/calls/analysis-mode);
 *   2. a per-call override in the confirm dialog, reachable from BOTH row
 *      actions — "Analyse Call" for a call's FIRST analysis and "Re-analyse
 *      Call" for every one after it. One picker component, one mental model,
 *      no extra row icon (see `askAnalysisMode`).
 *
 * Everywhere else the mode is READ-ONLY provenance (the "Audio"/"Transcript"
 * chip) — deliberately, so the icon-only row actions stay uncluttered.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  PhoneCall, Loader2, Sparkles, TrendingUp, AlertTriangle, ThumbsUp, Ban, PlusCircle, Users, RefreshCw, Play,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { Select } from '@/components/ui/select';
import { InfoTooltip } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { CallRecordingAudio } from '@/components/ui/call-recording-audio';
import { IconButton } from '@/components/ui/icon-button';
import { CallLegsRow, ConferenceBadge } from '@/components/calls/CallLegList';
import { groupCallRows, type CallLeg } from '@/lib/call-legs';

type CallRow = {
  id: number;
  job_id: number | null;
  caller: string | null;
  caller_name: string | null;
  receiver: string | null;
  receiver_name: string | null;
  call_type: string | null;
  // start_time = when the call was ANSWERED — NULL on ~13% of rows (and on most
  // recent ones), so it can't be the display source on its own. inserted_time =
  // when the call was logged/initiated, never NULL (it's the list's ORDER BY
  // key). Both are already projected by GET /admin/calls. See the Date/Time cell.
  start_time: string | null;
  inserted_time: string | null;
  duration: number | null;
  provider: string | null;
  transcription_status?: string | null;
  // Extended by the list endpoint (2026-07): the flow that originated the
  // call, the cached coaching overall_score, and the analysis job status.
  call_flow?: string | null;
  score?: string | null;
  call_analysis_status?: string | null;
  /*
   * Conference legs — everyone who was on the call. The analysis itself always
   * belongs to the OPERATOR's leg (the backend files transcription, recording
   * and coaching against that one row), so nothing in the Score / Transcript
   * columns changes; the legs only say who else was in the room, which is
   * context a coach reading a 3-party call needs.
   */
  conference_id?: number | null;
  legs?: CallLeg[] | null;
};
type ListResp = { total: number; page: number; limit: number; items: CallRow[] };

// Per-caller coaching rollup — GET /admin/calls/scorecard ("who is improving").
type ScorecardRow = {
  callerUserId: number;
  callerName: string;
  callsCount: number;
  avgOverall: number | null;
  avgCoverage: number | null;
  dimensions: { [name: string]: number };
  trend: { score: number | null; when: string | null }[];
  lastCallOn: string | null;
};
type ScorecardResp = { items: ScorecardRow[] };

// Known call flows (the backend `flow` filter accepts the raw key). Kept as a
// small hardcoded set — the label is what the operator sees, the value is what
// the list query param takes.
const FLOW_OPTIONS: { value: string; label: string }[] = [
  { value: 'guided_verification', label: 'Guided Verification' },
  { value: 'technician', label: 'Technician' },
  { value: 'job', label: 'Job' },
  { value: 'customer', label: 'Customer' },
  { value: 'spoc', label: 'SPOC' },
];
// SearchSelect option lists for the filter row (defined at module scope so the
// arrays keep a stable identity across renders — SearchSelect memoises on them).
const FLOW_SELECT_OPTIONS: SearchOption[] = [{ value: '', label: 'All Flows' }, ...FLOW_OPTIONS];
const MIN_SCORE_OPTIONS: SearchOption[] = [
  { value: '', label: 'Any' },
  { value: '5', label: '5+' },
  { value: '7', label: '7+' },
  { value: '8', label: '8+' },
];

/*
 * Which SOURCE the coaching AI reads. 'transcript' = the stored text (cheap, but
 * a bad transcript caps the score); 'recording' = the recording audio handed to
 * Gemini directly. `modeAvailable.recording` is false when that key isn't
 * configured — a mode we must never OFFER, because asking for it would just fall
 * back to the transcript and quietly mislabel the result.
 */
type AnalysisMode = 'transcript' | 'recording';
type ModeAvailability = { transcript: boolean; recording: boolean };
type AnalysisModeResp = { mode: AnalysisMode; modeAvailable: ModeAvailability };

const MODE_CFG_KEY = '/admin/calls/analysis-mode';
const MODE_LABEL: Record<AnalysisMode, string> = { transcript: 'Transcript', recording: 'Call Recording' };
// Lower-case noun for mid-sentence use in toasts ("regenerated from the …").
const MODE_NOUN: Record<AnalysisMode, string> = { transcript: 'transcript', recording: 'call recording' };
const MODE_HINT: Record<AnalysisMode, string> = {
  transcript: 'Reads the stored text transcript. A poor transcript caps the score.',
  recording: 'Listens to the recording itself, so tone and unclear speech survive.',
};
const MODE_OFF_HINT: Record<AnalysisMode, string> = {
  recording: 'Unavailable — the Gemini API key is not configured in this environment.',
  transcript: 'Unavailable — no transcript source is configured in this environment.',
};

type Dimension = { name: string; score: number; notes?: string };
type Analysis = {
  overall_score?: number;
  summary?: string;
  dimensions?: Dimension[];
  strengths?: string[];
  areas_of_improvement?: string[];
  what_to_avoid?: string[];
  what_to_add?: string[];
};
type Metrics = {
  sentiment?: { agent?: number | null; customer?: number | null };
  talkTime?: { agentSec?: number; customerSec?: number; agentRatioPct?: number | null };
  interruptions?: number | null;
  nonTalkSec?: number | null;
};
type AnalysisResp = {
  status: string;
  analysis?: Analysis;
  metrics?: Metrics | null;
  metricsStatus?: string | null;
  reason?: string;
  // Which mode ACTUALLY produced this analysis — may differ from the one asked
  // for when the backend fell back. Always read this, never assume the request.
  mode?: AnalysisMode;
  modeAvailable?: ModeAvailability;
};

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(+d)) return String(v);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function fmtDuration(sec: number | null | undefined): string {
  const s = sec == null || !Number.isFinite(sec) ? 0 : Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/*
 * Transcript status pill, or null for "not applicable".
 *
 * Takes the DURATION as well, because a call that never connected can never be
 * transcribed: the transcription backfill selects on `duration > 0`, so those
 * rows are never picked up and `transcription_status` stays NULL forever —
 * "Pending" was a promise that could never resolve. They render as the muted "—"
 * the rest of this table uses for "nothing here" (and that ClickToCallTab
 * already uses for exactly this case).
 *
 * The real statuses are checked FIRST so a 0-duration row that somehow DOES
 * carry a transcript — or an explicit failure — keeps its actual state.
 */
function txBadge(status?: string | null, durationSec?: number | null): { label: string; cls: string } | null {
  const s = (status || '').toLowerCase();
  if (s === 'completed') return { label: 'Ready', cls: 'bg-success-tint text-success-strong' };
  if (s === 'not_available') return { label: 'None', cls: 'bg-ink-100 text-ink-500' };
  if (s === 'failed') return { label: 'Failed', cls: 'bg-urgent-tint text-urgent-strong' };
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return { label: 'Pending', cls: 'bg-warning-tint text-warning-strong' };
}
function scoreColor(n?: number): string {
  const v = Number(n) || 0;
  if (v >= 8) return 'text-success';
  if (v >= 5) return 'text-warning';
  return 'text-urgent';
}
// Prettify a raw flow key for display. Known keys use the curated label;
// anything else falls back to Title-Cased words.
function prettyFlow(flow?: string | null): string {
  if (!flow) return '—';
  const known = FLOW_OPTIONS.find((f) => f.value === flow);
  if (known) return known.label;
  return flow.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
// Narrow an untrusted `mode` off the wire to the union, or null. Anything the
// backend adds later (a third mode, a typo) reads as "unknown" and simply shows
// no provenance rather than mislabelling a score.
function normaliseMode(v: unknown): AnalysisMode | null {
  return v === 'transcript' || v === 'recording' ? v : null;
}
// A score string ("8", "8.5", null) → a finite number or null.
function toScore(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// avgCoverage is a 0–100 percentage; render rounded with a % suffix.
function fmtCoverage(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)}%`;
}
// Does this call already carry a coaching analysis? Re-analyse only makes sense
// for those — for everything else "View Analysis" already generates the first one.
// `score` is extracted from the cached analysis JSON, so it's the primary signal;
// call_analysis_status covers an analysis stored without an overall_score.
function hasAnalysis(r: CallRow): boolean {
  return toScore(r.score) != null || r.call_analysis_status === 'ready';
}

/*
 * Listen to a call recording, lazily. Same shape as the CallHistoryButton
 * player: a ▶ button until the operator clicks, then GET /admin/calls/:id/recording
 * (which pulls from the provider, caches to S3 once, and returns a short-lived
 * URL) → an inline <CallRecordingAudio> that downmixes the 2-channel Plivo
 * recording to mono (otherwise the customer is audible only on the right
 * channel — see components/ui/call-recording-audio.tsx). Only rendered when the
 * call actually connected (duration > 0); an unanswered call has no recording.
 */
function ListenButton({ callId }: { callId: number }) {
  const [loading, setLoading] = React.useState(false);
  const [url, setUrl] = React.useState<string | null>(null);

  if (url) return <CallRecordingAudio src={url} autoPlay className="h-7 w-44" />;

  async function play() {
    setLoading(true);
    try {
      const r = await api.get<{ url: string }>(`/admin/calls/${callId}/recording`);
      if (r?.url) setUrl(r.url);
      else showToast({ variant: 'error', message: 'No recording available for this call.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not load the recording.' });
    } finally {
      setLoading(false);
    }
  }

  return <IconButton icon={Play} label="Listen Recording" busy={loading} onClick={() => void play()} />;
}

export default function CallAnalyticsPage() {
  const { me } = useMe();
  const canView = hasAction(me, 'isCallAnalyticsView');
  // Recording playback hits GET /admin/calls/:id/recording, which is gated on
  // isClickToCall — so only show Listen to operators who can actually fetch it,
  // rather than a button that 403s. (The list itself needs only isCallAnalyticsView.)
  const canListen = hasAction(me, 'isClickToCall');

  // 0-indexed page + the shared TablePagination (matches the rest of the CRM,
  // and gives the page-size selector the raw table was missing). The backend
  // list endpoint is 1-indexed, so send `page + 1`.
  const [tab, setTab] = React.useState<'calls' | 'scorecard'>('calls');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [jobQuery, setJobQuery] = React.useState('');
  const debouncedJob = useDebouncedValue(jobQuery.trim(), 400);
  // List filters wired to the extended list endpoint (flow / minScore / hasAnalysis).
  const [flow, setFlow] = React.useState('');
  const [minScore, setMinScore] = React.useState('');
  const [hasAnalysisOnly, setHasAnalysisOnly] = React.useState(false);
  /*
   * The open analysis modal: the row, plus the mode the operator explicitly
   * picked for it (null = "no override, use the server's resolved default").
   * They travel together in ONE state object rather than two parallel pieces
   * of state so the modal can never open against a stale/foreign override.
   */
  const [analysisFor, setAnalysisFor] =
    React.useState<{ row: CallRow; mode: AnalysisMode | null } | null>(null);

  // Row id currently being re-analysed — doubles as the double-submit guard
  // (the request is slow: a provider transcript fetch plus an LLM round-trip).
  const [reanalysing, setReanalysing] = React.useState<number | null>(null);
  const confirm = useConfirm();

  /*
   * Global default analysis mode. Fetched HERE rather than inside the control
   * because three things need it: the select, the per-call override's starting
   * value, and the fallback check after a re-analysis.
   */
  const { data: modeCfg, loading: modeCfgLoading, refetch: refetchModeCfg } =
    useFetch<AnalysisModeResp>(canView ? MODE_CFG_KEY : null);
  // Optimistic display value for the select, and a separate in-flight flag. Kept
  // apart on purpose: `savingMode` clears in `finally` so the control can never
  // stick disabled, while `pendingMode` survives until the re-read agrees.
  const [pendingMode, setPendingMode] = React.useState<AnalysisMode | null>(null);
  const [savingMode, setSavingMode] = React.useState(false);

  /*
   * Everything below fails CLOSED. The backend ships this endpoint in a separate
   * deploy, so until a response lands there is no mode UI at all (`modeSupported`)
   * and recording is treated as unconfigured — offering a mode that would only
   * fall back is worse than not offering it.
   */
  const modeSupported = modeCfg != null;
  const recordingAvailable = modeCfg?.modeAvailable?.recording === true;
  // Transcript is assumed available unless the server explicitly denies it — and
  // a denial is only honoured when recording can take over, so no combination of
  // server flags can leave the operator with nothing selectable.
  const modeAvailable: ModeAvailability = {
    recording: recordingAvailable,
    transcript: modeCfg?.modeAvailable?.transcript !== false || !recordingAvailable,
  };
  const globalMode: AnalysisMode = normaliseMode(modeCfg?.mode) ?? 'transcript';
  const shownMode = pendingMode ?? globalMode;

  /*
   * Should clicking "Analyse Call" stop to ask which source to read?
   *
   * Only when the click would ACTUALLY generate something AND there is a real
   * choice to make. Both halves matter:
   *
   *  - `!hasAnalysis(r)` — this is the first-analysis gate. A row that already
   *    has an analysis opens the modal to READ it, and that read is a cache hit;
   *    sending an explicit ?mode= there would make the backend bypass a cache
   *    produced the other way and silently REGENERATE (an LLM round-trip) just
   *    to look at an existing report. Those rows already show the Re-analyse
   *    icon, which is the correct — and explicitly destructive — place to change
   *    a mode. The two actions stay complementary: exactly one of them prompts.
   *
   *  - both modes available — with only one runnable mode the "choice" is a
   *    dialog with a single selectable radio, i.e. pure friction. Today
   *    GEMINI_API_KEY is unset, so `modeAvailable.recording` is false and this
   *    is ALWAYS false: no dialog ever appears and the action behaves exactly as
   *    it did before. It lights up on its own once the key is provisioned.
   *
   * (`modeAvailable.recording` can only be true when the mode endpoint answered,
   * so this also implies `modeSupported`.)
   */
  function canPickModeFor(r: CallRow): boolean {
    return !hasAnalysis(r) && modeAvailable.transcript && modeAvailable.recording;
  }

  // Drop the optimistic value once the re-read agrees. Clearing it in the POST's
  // `finally` instead would flash the PREVIOUS mode for as long as the GET takes.
  React.useEffect(() => {
    setPendingMode((m) => (m != null && normaliseMode(modeCfg?.mode) === m ? null : m));
  }, [modeCfg]);

  /*
   * Which mode PRODUCED each row's score, learned from the per-call analysis /
   * reanalyse responses. GET /admin/calls does NOT project it, so this only
   * covers rows the operator has touched this session — the modal always shows
   * provenance, the row chip fills in as calls are analysed.
   */
  const [modeByCall, setModeByCall] = React.useState<Record<number, AnalysisMode>>({});
  function rememberMode(callId: number, mode: AnalysisMode | null) {
    if (!mode) return;
    setModeByCall((prev) => (prev[callId] === mode ? prev : { ...prev, [callId]: mode }));
  }

  // Change the GLOBAL default (every future analysis, every operator).
  async function onChangeGlobalMode(next: AnalysisMode) {
    if (savingMode || next === shownMode) return;
    setPendingMode(next);
    setSavingMode(true);
    try {
      await api.post(MODE_CFG_KEY, { mode: next });
      showToast({ variant: 'success', message: `Analysis mode set to ${MODE_LABEL[next]}.` });
      // invalidateFetch only DROPS the cache — this hook is mounted, so it needs
      // the explicit refetch to re-read the server's own view of the value.
      invalidateFetch((k) => k.startsWith(MODE_CFG_KEY));
      refetchModeCfg();
    } catch (e) {
      setPendingMode(null); // snap back to whatever the server still says
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not change the analysis mode.' });
    } finally {
      setSavingMode(false);
    }
  }

  const limit = pageSizeToLimit(pageSize, 200); // backend callListQuery caps limit at 200
  const qs = new URLSearchParams({ page: String(page + 1), limit: String(limit) });
  if (debouncedJob) qs.set('jobId', debouncedJob);
  if (flow) qs.set('flow', flow);
  if (minScore) qs.set('minScore', minScore);
  if (hasAnalysisOnly) qs.set('hasAnalysis', 'true');
  const { data, loading, error, refetch } = useFetch<ListResp>(
    canView && tab === 'calls' ? `/admin/calls?${qs.toString()}` : null,
  );
  // Per-caller scorecard — only fetched while the Scorecard tab is active.
  const { data: scorecard, loading: scLoading, error: scError } = useFetch<ScorecardResp>(
    canView && tab === 'scorecard' ? '/admin/calls/scorecard?limit=100&offset=0' : null,
  );

  /*
   * The ONE mode-choosing dialog, shared by both row actions. Resolves to the
   * picked mode, or null if the operator backed out.
   *
   * `kind` only swaps the COPY — a first analysis and a re-analysis are the same
   * decision ("which source should the AI read?") wearing different verbs, so
   * they share the dialog and the picker rather than forking them. Anything that
   * changes about the picker changes for both entry points at once.
   */
  async function askAnalysisMode(kind: 'analyse' | 'reanalyse'): Promise<AnalysisMode | null> {
    const first = kind === 'analyse';
    /*
     * The picked mode has to travel back out of `confirm()`, which resolves to a
     * bare boolean — so the picker writes into this box and we read it once the
     * promise settles. A plain object, not a React ref: it lives for exactly one
     * invocation. Seeded from the global default so pressing straight through
     * reproduces exactly what would have happened without the dialog — but never
     * from a mode the environment can't run.
     */
    const picked: { mode: AnalysisMode } = {
      mode: modeAvailable[globalMode] ? globalMode : (globalMode === 'recording' ? 'transcript' : 'recording'),
    };
    const ok = await confirm({
      title: first ? 'Analyse This Call?' : 'Re-analyse This Call?',
      description: (
        <div className="space-y-3">
          <p>
            {first
              ? <>Generates the coaching analysis for this call and adds the score to the caller&apos;s scorecard.</>
              : <>Fetches a fresh transcript from the provider, regenerates the coaching analysis and updates the
                 caller&apos;s scorecard. The existing analysis is kept if a new one can&apos;t be generated.</>}
          </p>
          {/* Hidden entirely on a backend without mode support — the dialog then
              reads exactly as it did before this feature. */}
          {modeSupported && (
            <AnalysisModePicker
              initial={picked.mode}
              available={modeAvailable}
              onChange={(m) => { picked.mode = m; }}
            />
          )}
        </div>
      ),
      confirmLabel: first ? 'Analyse' : 'Re-analyse',
      icon: first ? <Sparkles className="h-5 w-5" /> : <RefreshCw className="h-5 w-5" />,
    });
    return ok ? picked.mode : null;
  }

  /*
   * "Analyse Call" — opens the report, which GENERATES the analysis server-side
   * on first view. Before this, that first generation always ran at the global
   * default and could never be overridden: the per-call picker lived only in the
   * Re-analyse dialog, which only appears once an analysis already exists.
   *
   * So the picker is offered here too, but ONLY when the click is genuinely a
   * choice — see `canPickModeFor`. Otherwise the modal opens immediately with no
   * override, byte-identical to the previous behaviour.
   */
  async function onAnalyse(r: CallRow) {
    if (!canPickModeFor(r)) { setAnalysisFor({ row: r, mode: null }); return; }
    const mode = await askAnalysisMode('analyse');
    if (!mode) return;
    setAnalysisFor({ row: r, mode });
  }

  // Force a fresh transcript + fresh coaching for a call that already has one —
  // the analysis is cached server-side, so a better transcript would otherwise
  // never reach the score.
  async function onReanalyse(r: CallRow) {
    if (reanalysing != null) return;
    const picked = await askAnalysisMode('reanalyse');
    if (!picked) return;
    setReanalysing(r.id);
    try {
      /*
       * `mode` is sent EXPLICITLY rather than omitted-for-the-global-default: the
       * picker showed the operator a concrete value, so the request should say
       * exactly that, and it makes the fallback comparison below unambiguous.
       * Omitted only when the backend doesn't know the parameter at all.
       */
      const requested = picked;
      const resp = await api.post<AnalysisResp>(
        `/admin/calls/${r.id}/reanalyse`,
        modeSupported ? { mode: requested } : undefined,
      );
      const produced = normaliseMode(resp.mode);
      rememberMode(r.id, produced);
      if (resp.status === 'ready') {
        if (produced && produced !== requested) {
          // The backend fell back. Say so — an audio-derived and a
          // transcript-derived score aren't comparable, and silently reporting
          // "regenerated" would let the operator assume the audio ran.
          //
          // `warning`, NOT `error`: the re-analysis SUCCEEDED, it just took the
          // other source. Rose here told the operator their action had failed
          // when a fresh analysis was sitting in the row behind the toast.
          showToast({
            variant: 'warning',
            message: `Analysis regenerated from the ${MODE_NOUN[produced]} — the ${MODE_NOUN[requested]} could not be used for this call.`,
          });
        } else {
          showToast({ variant: 'success', message: 'Analysis regenerated.' });
        }
        // The Scorecard tab reads a cached key it only fetches on tab switch, and
        // the rollup just changed — drop it so switching tabs shows the new score.
        invalidateFetch((k) => k.startsWith('/admin/calls/scorecard'));
        refetch();
      } else {
        // Not ready isn't a crash (transcript still processing, AI off) — surface
        // the backend's reason so the operator knows whether to retry.
        showToast({ variant: 'error', message: resp.reason || 'Re-analysis could not be completed.' });
      }
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Re-analysis failed.' });
    } finally {
      setReanalysing(null);
    }
  }

  if (!canView) {
    return (
      <Card className="max-w-lg">
        <CardContent className="pt-6 pb-6 text-center space-y-2">
          <AlertTriangle className="h-6 w-6 text-warning mx-auto" />
          <h2 className="text-base font-semibold text-ink-900">Not Authorised</h2>
          <p className="text-sm text-muted-foreground">
            You don&apos;t have access to Call Analytics. Ask an admin to grant the
            &quot;View Call Analytics&quot; permission.
          </p>
        </CardContent>
      </Card>
    );
  }

  /*
   * One row per CALL. The jci⋈pcl join behind this endpoint is 1:N now, so a
   * conference can arrive as several rows carrying the same call id — which
   * would list one call three times for analysis and hand React three duplicate
   * keys. See groupCallRows in lib/call-legs.ts.
   */
  const items = React.useMemo(() => groupCallRows(data?.items ?? []), [data?.items]);
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <PhoneCall className="h-5 w-5 text-info" />
        <h1 className="text-lg font-semibold text-ink-900">Call Analytics</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Call history with AI coaching analysis. Click <span className="font-medium">Analyse Call</span> to
        see per-call scores + areas of improvement, or <span className="font-medium">Re-analyse Call</span> to
        regenerate the score — either dialog can force one analysis mode for a single call.
      </p>

      {/* Tab switcher — Calls table vs the per-caller coaching rollup. */}
      <div className="inline-flex gap-1 rounded-md border bg-card p-1">
        <Button size="sm" variant={tab === 'calls' ? 'default' : 'ghost'} onClick={() => setTab('calls')}>
          <PhoneCall className="h-4 w-4 mr-1.5" /> Calls
        </Button>
        <Button size="sm" variant={tab === 'scorecard' ? 'default' : 'ghost'} onClick={() => setTab('scorecard')}>
          <Users className="h-4 w-4 mr-1.5" /> Caller Scorecard
        </Button>
      </div>

      {tab === 'calls' && (
        <>
          {/* Filters — wired to the extended list query params. */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <label className="block text-xs font-medium text-ink-500 mb-1">Job #</label>
              <Input
                value={jobQuery}
                onChange={(e) => { setJobQuery(e.target.value.replace(/\D/g, '')); setPage(0); }}
                placeholder="Filter by Job #"
                inputMode="numeric"
              />
            </div>
            <div className="w-52">
              <label className="block text-xs font-medium text-ink-500 mb-1">Flow</label>
              <SearchSelect
                value={flow}
                onChange={(v) => { setFlow(v); setPage(0); }}
                options={FLOW_SELECT_OPTIONS}
                placeholder="All Flows"
              />
            </div>
            <div className="w-40">
              <label className="block text-xs font-medium text-ink-500 mb-1">Min Score</label>
              <SearchSelect
                value={minScore}
                onChange={(v) => { setMinScore(v); setPage(0); }}
                options={MIN_SCORE_OPTIONS}
                placeholder="Any"
              />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm text-ink-700">
              <Switch
                checked={hasAnalysisOnly}
                onCheckedChange={(v) => { setHasAnalysisOnly(v); setPage(0); }}
                ariaLabel="Has Analysis Only"
              />
              Has Analysis Only
            </label>

            {/*
             * NOT a filter — it changes which source every FUTURE analysis is
             * generated from, for everyone. `ml-auto` pushes it to the far end of
             * the row so it doesn't read as one of the filters beside it.
             * Rendered while the config is still loading (so it doesn't pop in),
             * then dropped entirely if the endpoint never answers.
             */}
            {(modeCfgLoading || modeSupported) && (
              <div className="w-56 sm:ml-auto">
                <div className="flex items-center gap-1 text-xs font-medium text-ink-500 mb-1">
                  <span>Analysis Mode</span>
                  <InfoTooltip label="About Analysis Mode" align="end">
                    <div className="space-y-2">
                      <div className="font-semibold text-ink-900">Analysis Mode</div>
                      <div>
                        The source the AI coach reads when it scores a call. Existing analyses keep the
                        mode they were generated with — this applies to new ones only.
                      </div>
                      <ul className="list-disc ml-4 space-y-0.5">
                        <li><strong>Transcript</strong> — {MODE_HINT.transcript}</li>
                        <li><strong>Call Recording</strong> — {MODE_HINT.recording}</li>
                      </ul>
                      {modeSupported && !recordingAvailable && (
                        <div className="text-urgent-strong">
                          Call Recording is switched off here because the Gemini API key is not
                          configured in this environment.
                        </div>
                      )}
                    </div>
                  </InfoTooltip>
                </div>
                <Select
                  value={shownMode}
                  onChange={(e) => void onChangeGlobalMode(e.target.value as AnalysisMode)}
                  disabled={modeCfgLoading || savingMode}
                  aria-label="Analysis Mode"
                >
                  {/* Unavailable modes are DISABLED, not hidden: ops should see
                      the audio route exists and why it's off. `title` surfaces
                      the reason natively where the browser supports it on an
                      <option>; the (i) tooltip always does. */}
                  {(['transcript', 'recording'] as AnalysisMode[]).map((m) => (
                    <option
                      key={m}
                      value={m}
                      disabled={!modeAvailable[m]}
                      title={modeAvailable[m] ? undefined : MODE_OFF_HINT[m]}
                    >
                      {modeAvailable[m] ? MODE_LABEL[m] : `${MODE_LABEL[m]} (Unavailable)`}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          <div className="rounded-md border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs text-ink-500">
                <tr>
                  <th className="px-3 py-2">Date / Time</th>
                  <th className="px-3 py-2">Direction</th>
                  <th className="px-3 py-2">Flow</th>
                  <th className="px-3 py-2">Caller</th>
                  <th className="px-3 py-2">Receiver</th>
                  <th className="px-3 py-2">Job</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Transcript</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading…
                  </td></tr>
                )}
                {!loading && error && (
                  <tr><td colSpan={10} className="px-3 py-6 text-center text-urgent">{error}</td></tr>
                )}
                {!loading && !error && items.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">No calls found.</td></tr>
                )}
                {!loading && items.map((r) => {
                  const b = txBadge(r.transcription_status, r.duration);
                  const outgoing = String(r.call_type || '').toUpperCase() === 'OUT';
                  const s = toScore(r.score);
                  return (
                    <React.Fragment key={r.id}>
                    <tr className="border-t hover:bg-ink-50">
                      {/* Prefer the answered time; fall back to the initiated
                          (inserted) time, which is always present — otherwise
                          recent calls (start_time NULL) showed a bare "—". */}
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.start_time || r.inserted_time)}</td>
                      <td className="px-3 py-2">{outgoing ? 'Outgoing' : 'Incoming'}</td>
                      <td className="px-3 py-2">
                        {r.call_flow
                          ? <Badge className="bg-ink-100 text-ink-700">{prettyFlow(r.call_flow)}</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.caller_name || '—'}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.caller || ''}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.receiver_name || '—'}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.receiver || ''}</div>
                        {/* A coach reading a score needs to know the call had a
                            third person on it — the transcript will have voices
                            the Receiver column does not name. */}
                        <ConferenceBadge row={r} className="mt-0.5" />
                      </td>
                      <td className="px-3 py-2">
                        {r.job_id
                          ? <Link href={`/jobs?jobId=${r.job_id}`} className="text-primary hover:underline font-mono">#{r.job_id}</Link>
                          : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono">{fmtDuration(r.duration)}</td>
                      <td className="px-3 py-2">
                        {b
                          ? <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${b.cls}`}>{b.label}</span>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {s != null
                          ? <span className={`font-semibold ${scoreColor(s)}`}>{s}/10</span>
                          : <span className="text-muted-foreground">—</span>}
                        {/* Provenance, when we know it — see `modeByCall`. */}
                        {modeByCall[r.id] && (
                          <div className="mt-0.5"><ModeChip mode={modeByCall[r.id]} /></div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* Icon-only row actions; each label is the hover tooltip
                            (title) + accessible name. gap-2 keeps the naked icons
                            from crowding. */}
                        <div className="flex items-center justify-end gap-2">
                          {/* Listen — only when the call connected (duration > 0;
                              an unanswered call has no recording) and the operator
                              can fetch it. */}
                          {canListen && (r.duration ?? 0) > 0 && <ListenButton callId={r.id} />}
                          {/* Opens the report — and, on a call with no analysis
                              yet, first asks which source to read it from (only
                              when both are runnable; see `canPickModeFor`). */}
                          <IconButton
                            icon={Sparkles}
                            label="Analyse Call"
                            intent="primary"
                            onClick={() => void onAnalyse(r)}
                          />
                          {/* Only for calls that already have an analysis — for the rest,
                              Analyse Call generates the first one anyway. */}
                          {hasAnalysis(r) && (
                            <IconButton
                              icon={RefreshCw}
                              label="Reanalyse Call"
                              busy={reanalysing === r.id}
                              disabled={reanalysing != null}
                              onClick={() => void onReanalyse(r)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                    <CallLegsRow row={r} colSpan={10} />
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border bg-card px-3 py-2">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </>
      )}

      {tab === 'scorecard' && (
        <CallerScorecard rows={scorecard?.items ?? []} loading={scLoading} error={scError} />
      )}

      {analysisFor && (
        <AnalysisModal
          call={analysisFor.row}
          mode={analysisFor.mode}
          onClose={() => setAnalysisFor(null)}
          onAnalysed={(produced) => {
            // Provenance for the row's Score chip — true on a cache hit too.
            rememberMode(analysisFor.row.id, produced);
            /*
             * Opening the modal GENERATES the analysis server-side on first view,
             * so this row's score + call_analysis_status just changed and the
             * table would otherwise stay stale until a manual reload.
             *
             * Refetch ONLY when the row had no analysis before we opened it. A
             * cache hit changed nothing, and re-requesting the list on every
             * modal open is pure waste — `hasAnalysis` on the row we captured at
             * open time is exactly that "was it already scored?" question.
             *
             * A silent refetch, not an in-place patch: `useFetch` keeps the
             * current data and raises `refreshing` (never `loading`), so the
             * table updates with no skeleton and no flicker. Patching locally
             * would save one small paginated request but force this component to
             * re-derive `score` and `call_analysis_status` the way the BE does —
             * two fields free to drift from the server.
             */
            if (hasAnalysis(analysisFor.row)) return;
            /*
             * This row had NO analysis, so the GET just generated one — which
             * makes a mode other than the one we ASKED FOR a real fallback worth
             * reporting. The check is gated on that: a CACHE HIT legitimately
             * carries whatever mode it was generated with (possibly months ago,
             * under a different default) and toasting on those would cry wolf
             * every time an old analysis is opened.
             *
             * Compared against the operator's explicit pick when there was one
             * (the confirm dialog), falling back to the global default when the
             * modal opened without asking — i.e. always against what this
             * particular click actually requested.
             */
            const requested = analysisFor.mode ?? globalMode;
            if (modeSupported && produced && produced !== requested) {
              // `warning`, not `error`: the analysis WAS generated and is on
              // screen behind this toast — only the source differs from the one
              // requested. See toast.tsx's variant notes.
              showToast({
                variant: 'warning',
                message: `Analysed from the ${MODE_NOUN[produced]} — the ${MODE_NOUN[requested]} could not be used for this call.`,
              });
            }
            invalidateFetch((k) => k.startsWith('/admin/calls/scorecard'));
            refetch();
          }}
        />
      )}
    </div>
  );
}

/*
 * Read-only provenance: which source a score came from. "Audio" rather than
 * "Call Recording" — it has to fit beside a score in a dense table cell, and the
 * hover title carries the full sentence.
 */
function ModeChip({ mode }: { mode: AnalysisMode }) {
  const audio = mode === 'recording';
  return (
    <span
      className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${
        audio ? 'bg-info-tint text-info-strong' : 'bg-ink-100 text-ink-700'
      }`}
      title={audio
        ? 'Generated from the call recording (audio).'
        : 'Generated from the call transcript — a poor transcript caps the score.'}
    >
      {audio ? 'Audio' : 'Transcript'}
    </span>
  );
}

/*
 * Per-call mode override, embedded in the confirm dialog — the SAME component
 * for a first analysis and a re-analysis (see `askAnalysisMode`). Its own copy
 * is verb-free ("Analyse From", "this call only"), so only the surrounding
 * dialog needs different wording; nothing here forks per entry point.
 *
 * It owns its own state and reports upward through `onChange` because
 * `useConfirm()` resolves to a bare boolean — the caller reads the last reported
 * value once the dialog settles. Radios rather than a select: two options, and
 * the "why is audio off" reason has to be readable without opening anything.
 */
function AnalysisModePicker({ initial, available, onChange }: {
  initial: AnalysisMode;
  available: ModeAvailability;
  onChange: (mode: AnalysisMode) => void;
}) {
  const [mode, setMode] = React.useState<AnalysisMode>(initial);
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Analyse From</div>
      {(['transcript', 'recording'] as AnalysisMode[]).map((m) => {
        const off = !available[m];
        return (
          <label
            key={m}
            className={`flex items-start gap-2 ${off ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <input
              type="radio"
              name="analysis-mode"
              className="mt-1 shrink-0"
              checked={mode === m}
              disabled={off}
              onChange={() => { setMode(m); onChange(m); }}
            />
            <span>
              <span className="block text-sm font-medium">{MODE_LABEL[m]}</span>
              <span className="block text-xs text-muted-foreground">{off ? MODE_OFF_HINT[m] : MODE_HINT[m]}</span>
            </span>
          </label>
        );
      })}
      <div className="text-xs text-muted-foreground">
        Applies to this call only — the default for everything else stays as it is.
      </div>
    </div>
  );
}

// Per-caller coaching rollup — the "who is improving" view.
function CallerScorecard({ rows, loading, error }: { rows: ScorecardRow[]; loading: boolean; error: string | null }) {
  return (
    <div className="rounded-md border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-left text-xs text-ink-500">
          <tr>
            <th className="px-3 py-2">Caller</th>
            <th className="px-3 py-2">Calls</th>
            <th className="px-3 py-2">Avg Score</th>
            {/* Coverage is NOT from the AI call analysis — it's the AI Teleprompter's
                script coverage (% of REQUIRED questions the caller actually asked on a
                guided call). Blank for anyone who hasn't used the teleprompter. */}
            <th className="px-3 py-2">
              <span
                className="inline-flex items-center gap-1 border-b border-dotted border-muted-foreground/50"
                title="AI Teleprompter script coverage — the average % of REQUIRED questions the caller actually asked on guided calls. Blank if they haven't used the Teleprompter."
              >
                Avg Coverage
              </span>
            </th>
            <th className="px-3 py-2">Dimensions</th>
            <th className="px-3 py-2">
              <span
                className="inline-flex items-center gap-1 border-b border-dotted border-muted-foreground/50"
                title="Score direction across this caller's recent scored calls (oldest → newest). Needs at least two."
              >
                Trend
              </span>
            </th>
            <th className="px-3 py-2">Last Call</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading…
            </td></tr>
          )}
          {!loading && error && (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-urgent">{error}</td></tr>
          )}
          {!loading && !error && rows.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No Caller Scores Yet</td></tr>
          )}
          {!loading && rows.map((r) => {
            const avg = r.avgOverall;
            const dims = Object.entries(r.dimensions || {});
            return (
              <tr key={r.callerUserId} className="border-t hover:bg-ink-50 align-top">
                <td className="px-3 py-2 font-medium text-ink-900">{r.callerName || '—'}</td>
                <td className="px-3 py-2 font-mono">{r.callsCount}</td>
                <td className="px-3 py-2">
                  {avg != null && Number.isFinite(avg)
                    ? <span className={`font-semibold ${scoreColor(avg)}`}>{avg.toFixed(1)}/10</span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2">{fmtCoverage(r.avgCoverage)}</td>
                <td className="px-3 py-2">
                  {dims.length === 0
                    ? <span className="text-muted-foreground">—</span>
                    : (
                      <div className="flex flex-wrap gap-1">
                        {dims.map(([name, val]) => (
                          <span key={name} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
                            <span className="text-muted-foreground">{name}</span>
                            <span className={`font-semibold ${scoreColor(val)}`}>{Number(val).toFixed(1)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                </td>
                <td className="px-3 py-2"><Sparkline trend={r.trend} /></td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.lastCallOn)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/*
 * Tiny inline-SVG sparkline for a caller's score trend (oldest → newest).
 *
 * Renders the LINE ONLY — no trailing number. A bare digit next to the Calls and
 * Avg Score columns read as another count and confused ops; the trend's job is
 * direction, and both numbers it could show are already their own columns.
 * A single data point is not a trend, so it shows "—" rather than a lone number.
 */
function Sparkline({ trend }: { trend: { score: number | null; when: string | null }[] }) {
  const pts = (trend || []).map((t) => toScore(t.score)).filter((s): s is number => s != null);
  if (pts.length < 2) return <span className="text-muted-foreground" title="Needs at least two scored calls to show a trend">—</span>;
  const w = 72, h = 22, pad = 3;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const step = (w - pad * 2) / (pts.length - 1);
  const coords = pts.map((s, i) => {
    const x = pad + i * step;
    const y = h - pad - ((s - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div className="flex items-center gap-2">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-info shrink-0" aria-hidden="true">
        <polyline
          points={coords.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/*
 * `onAnalysed` fires when the GET came back 'ready'. That endpoint GENERATES and
 * stores the analysis on first view, so opening this modal can change the row's
 * score server-side — without this callback the table showed a stale score until
 * the operator reloaded the page.
 *
 * It fires on cache hits too (the endpoint reports 'ready' either way, and the
 * modal can't tell them apart). Deciding whether anything actually CHANGED is the
 * caller's job — it knows what the row looked like before it opened.
 *
 * It carries the mode that PRODUCED the analysis so the caller can record
 * provenance and spot a fallback.
 *
 * `mode` is the operator's explicit per-call override, forwarded as `?mode=` —
 * the ONLY way a call's FIRST analysis can run at anything but the global
 * default. The caller passes null unless it actually asked (see
 * `canPickModeFor`), and that matters: an explicit ?mode= makes the backend
 * bypass a cache produced the other way and regenerate, so sending one on a
 * plain "view the existing report" click would burn an LLM round-trip per open.
 * This modal renders no picker of its own — mode is chosen before it opens, so a
 * read-only report stays a read-only report.
 */
function AnalysisModal({ call, mode, onClose, onAnalysed }: {
  call: CallRow;
  mode?: AnalysisMode | null;
  onClose: () => void;
  onAnalysed?: (producedMode: AnalysisMode | null) => void;
}) {
  const [resp, setResp] = React.useState<AnalysisResp | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  // Kept in a ref so a caller passing an inline arrow can't re-trigger the fetch
  // effect on every render.
  const onAnalysedRef = React.useRef(onAnalysed);
  onAnalysedRef.current = onAnalysed;

  React.useEffect(() => {
    let cancelled = false;
    setResp(null); setErr(null);
    // Only append ?mode= when an override was actually chosen — omitting it lets
    // the backend resolve the global default AND serve the cache as-is.
    const q = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    api.get<AnalysisResp>(`/admin/calls/${call.id}/analysis${q}`)
      .then((r) => {
        if (cancelled) return;
        setResp(r);
        if (r.status === 'ready') onAnalysedRef.current?.(normaliseMode(r.mode));
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load analysis.'); });
    return () => { cancelled = true; };
  }, [call.id, mode]);

  // Read-only modal — never dirty; the guard just satisfies the shared
  // Dialog-close lint rule.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  const coachingReason = resp && resp.status !== 'ready'
    ? (resp.status === 'no_transcript' ? 'No transcript is available for this call yet.'
      : resp.status === 'llm_disabled' ? 'Coaching AI is not configured in this environment.'
      : resp.status === 'unavailable' ? 'Call analytics is not enabled in this environment.'
      : (resp.reason || 'Coaching could not be generated.'))
    : null;

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-2xl max-h-[calc(100vh-64px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-info" /> Call Analysis{call.job_id ? ` · Job #${call.job_id}` : ''}
          </DialogTitle>
        </DialogHeader>

        {!resp && !err && (
          <div className="py-10 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Analysing the call…
          </div>
        )}
        {err && (
          <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-warning" />{err}
          </div>
        )}
        {resp && (
          <div className="space-y-5">
            {/* Objective metrics — Amazon Transcribe Call Analytics (cron-precomputed). */}
            <MetricsBody metrics={resp.metrics} status={resp.metricsStatus} />
            {/* Coaching narrative — LLM over the transcript OR the recording;
                the chip says which, since the two aren't comparable. */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Coaching</span>
                {normaliseMode(resp.mode) && <ModeChip mode={normaliseMode(resp.mode)!} />}
              </div>
              {resp.status === 'ready' && resp.analysis
                ? <AnalysisBody a={resp.analysis} />
                : <div className="text-sm text-muted-foreground flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning shrink-0" />{coachingReason}</div>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function sentimentLabel(n?: number | null): { label: string; cls: string } {
  if (n == null) return { label: '—', cls: 'text-muted-foreground' };
  // Transcribe OverallSentiment is a signed score (roughly -5..5); sign-based
  // bucketing is robust to the exact scale.
  if (n > 0.5) return { label: 'Positive', cls: 'text-success' };
  if (n < -0.5) return { label: 'Negative', cls: 'text-urgent' };
  return { label: 'Neutral', cls: 'text-ink-700' };
}

function MetricsBody({ metrics, status }: { metrics?: Metrics | null; status?: string | null }) {
  if (!metrics) {
    const s = (status || '').toLowerCase();
    const msg = s === 'processing' ? 'Call metrics are being generated (Amazon Transcribe) — check back shortly.'
      : s === 'failed' ? 'Call metrics could not be generated for this call.'
      : 'Call metrics are not available yet.';
    return (
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">Call Metrics</div>
        <div className="text-sm text-muted-foreground">{msg}</div>
      </div>
    );
  }
  const t = metrics.talkTime || {};
  const sa = sentimentLabel(metrics.sentiment?.agent);
  const sc = sentimentLabel(metrics.sentiment?.customer);
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">Call Metrics</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Agent Sentiment" value={sa.label} cls={sa.cls} />
        <Metric label="Customer Sentiment" value={sc.label} cls={sc.cls} />
        <Metric label="Agent Talk" value={t.agentRatioPct != null ? `${t.agentRatioPct}%` : '—'} />
        <Metric label="Interruptions" value={metrics.interruptions != null ? String(metrics.interruptions) : '—'} />
      </div>
    </div>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className={`text-sm font-semibold ${cls || 'text-ink-900'}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function AnalysisBody({ a }: { a: Analysis }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-3 rounded-md border bg-ink-50 px-3 py-2">
        <div className="text-center shrink-0">
          <div className={`text-2xl font-semibold ${scoreColor(a.overall_score)}`}>
            {a.overall_score ?? '—'}<span className="text-sm text-muted-foreground">/10</span>
          </div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Overall</div>
        </div>
        {a.summary && <p className="flex-1 text-ink-700">{a.summary}</p>}
      </div>

      {Array.isArray(a.dimensions) && a.dimensions.length > 0 && (
        <div className="space-y-2">
          {a.dimensions.map((d, i) => (
            <div key={i} className="rounded-md border px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.name}</span>
                <span className={`font-semibold ${scoreColor(d.score)}`}>{d.score}/10</span>
              </div>
              {d.notes && <p className="text-xs text-muted-foreground mt-0.5">{d.notes}</p>}
            </div>
          ))}
        </div>
      )}

      <ListBlock icon={<ThumbsUp className="h-4 w-4 text-success" />} title="Strengths" items={a.strengths} />
      <ListBlock icon={<TrendingUp className="h-4 w-4 text-info" />} title="Areas of Improvement" items={a.areas_of_improvement} />
      <ListBlock icon={<Ban className="h-4 w-4 text-urgent" />} title="What to Avoid Saying" items={a.what_to_avoid} />
      <ListBlock icon={<PlusCircle className="h-4 w-4 text-info-deep" />} title="What to Add" items={a.what_to_add} />
    </div>
  );
}

function ListBlock({ icon, title, items }: { icon: React.ReactNode; title: string; items?: string[] }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 font-medium mb-1">{icon} {title}</div>
      <ul className="list-disc pl-6 space-y-0.5 text-ink-700">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}
