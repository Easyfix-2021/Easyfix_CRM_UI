/**
 * LMS action tool — the vocabulary shared by the action home (B-01), the
 * pending drilldown (B-02) and the state manager's own city (B-13).
 *
 * WHY A SHARED MODULE RATHER THAN THREE COPIES
 *
 * All three screens describe the same population from different angles, and
 * the spec's whole argument rests on them agreeing: a counter that says 12
 * over a list that shows 9 turns an action tool back into a report nobody
 * trusts. Detector keys, chip keys and the copy attached to each live here
 * once, so a rename cannot land on two screens and miss the third.
 *
 * The server owns every NUMBER. This file owns only names and copy — there is
 * deliberately no client-side counting here, because a second implementation
 * of "what is overdue" is exactly how the two halves drift apart. Compare
 * src/lib/due-date.ts, which mirrors server date arithmetic for PREVIEW only
 * and says so at the top for the same reason.
 */

/** The six B-01 row types. Mirrors DETECTORS in routes/admin/lms-action.js. */
export type DetectorKey =
  | 'deadline_passed'
  | 'session_48h'
  | 'assessment_failed'
  | 'paused_not_started'
  | 'client_uncertified'
  | 'stale_module';

/** The five B-02 filter chips. Mirrors CHIPS in routes/admin/lms-action.js. */
export type ChipKey = 'overdue' | 'not_started' | 'part_done' | 'failed' | 'done';

export const CHIP_ORDER: ChipKey[] = ['overdue', 'not_started', 'part_done', 'failed', 'done'];

export const CHIP_LABEL: Record<ChipKey, string> = {
  overdue: 'Overdue',
  not_started: 'Not Started',
  part_done: 'Part Done',
  failed: 'Failed',
  done: 'Done',
};

/*
 * Tone per chip, in brand token vocabulary.
 *
 * `failed` is neutral rather than urgent on purpose: until assessment attempts
 * exist it is always zero, and a permanently-zero red chip trains people to
 * ignore red.
 */
export const CHIP_TONE: Record<ChipKey, 'urgent' | 'warning' | 'info' | 'success' | 'neutral'> = {
  overdue: 'urgent',
  not_started: 'warning',
  part_done: 'info',
  failed: 'neutral',
  done: 'success',
};

export type ActionRow = {
  detector: DetectorKey;
  item: string;
  itemId: number | null;
  clientId?: number;
  stuckCount: number;
  completionPct?: number;
  owner: string;
  button: string;
  href: string;
};

export type ActionCounters = {
  overdue: number;
  pending: number;
  pausedWaiting: number;
  needsDecision: number;
  needsDecisionBreakdown: {
    total: number;
    assessmentFailed: number;
    chasedWithoutEffect: number;
    impossibleAssignment: number;
  };
};

export type ActionHome = {
  today: string;
  counters: ActionCounters;
  rows: ActionRow[];
  summary: {
    activeModules: number;
    runningNormally: number;
    /* Rendered verbatim. The three-way copy (nothing assigned / everything
     * flagged / N running normally) is decided server-side so the two cannot
     * disagree — and so "0 modules are running normally", which reads like a
     * rendering bug on the one line whose job is to be believable, can never
     * be produced. */
    runningNormallyText: string;
  };
  unavailable: { key: DetectorKey; reason: string }[];
};

export type PendingRow = {
  easyfixer_id: number;
  course_id: number;
  course_name: string;
  technician_name: string | null;
  efr_no: string | null;
  efr_cityId: number | null;
  city_name: string | null;
  grade: string | null;
  due_date: string | null;
  completion_date: string | null;
  assigned_on: string | null;
  videos_done: number;
  videos_total: number;
  status: ChipKey | string;
  last_chased_at: string | null;
  chase_count_7d: number;
};

export type PendingPage = {
  rows: PendingRow[];
  total: number;
  limit: number;
  offset: number;
  today: string;
  chips: Record<ChipKey, number>;
};

/*
 * The four B-01 counters, in the order the spec lists them:
 * "Overdue · Pending · Paused and waiting · Needs decision."
 *
 * `unit` matters. Overdue and Pending count ASSIGNMENTS; "Paused and waiting"
 * counts TECHNICIANS — one person owing three modules is one person not
 * earning, not three. Rendering all four as bare numbers would quietly invite
 * the reader to add them up.
 */
export const COUNTER_META: {
  key: keyof Omit<ActionCounters, 'needsDecisionBreakdown'>;
  label: string;
  unit: 'assignments' | 'technicians' | 'items';
  tone: 'urgent' | 'warning' | 'info' | 'gold';
  hint: string;
  chip?: ChipKey;
}[] = [
  {
    key: 'overdue',
    label: 'Overdue',
    unit: 'assignments',
    tone: 'urgent',
    hint: 'Past the complete-by date and still outstanding.',
    chip: 'overdue',
  },
  {
    key: 'pending',
    label: 'Pending',
    unit: 'assignments',
    tone: 'warning',
    // Stated on the tile because the two counters partition deliberately:
    // nested counts would sum to more than the population.
    hint: 'Assigned and outstanding, not yet past its date.',
  },
  {
    key: 'pausedWaiting',
    label: 'Paused & Waiting',
    unit: 'technicians',
    tone: 'info',
    hint: 'Not earning right now because training is overdue.',
    chip: 'overdue',
  },
  {
    key: 'needsDecision',
    label: 'Needs Decision',
    unit: 'items',
    tone: 'gold',
    hint: 'Chasing will not fix these — someone has to decide.',
  },
];

/** Chase channels the CRM can trigger. `call` is routed through click-to-call. */
export type ChaseChannel = 'nudge' | 'whatsapp' | 'call' | 'mark_chased';

/**
 * Days a date is past, in whole days, or null when there is no date.
 *
 * Display only — the server decides what is overdue, against the IST calendar
 * day, and this must never be used to make that judgement a second time. It
 * exists so a row can say "10 days late" next to a status the server set.
 */
export function daysPast(dateish: string | null | undefined, todayIso: string): number | null {
  if (!dateish) return null;
  const due = String(dateish).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) return null;
  const ms = Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86_400_000);
}

/** "10 days late" / "due today" / "in 3 days" — never a bare date on its own. */
export function dueLabel(dateish: string | null | undefined, todayIso: string): string {
  const n = daysPast(dateish, todayIso);
  if (n === null) return 'No deadline';
  if (n > 0) return `${n} day${n === 1 ? '' : 's'} late`;
  if (n === 0) return 'Due today';
  return `In ${-n} day${n === -1 ? '' : 's'}`;
}
