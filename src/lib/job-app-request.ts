/*
 * Technician APP REQUESTS — the cancellation and reschedule asks a technician
 * raises from the mobile app, and the vocabulary the CRM renders them with.
 *
 * ─── WHAT A REQUEST IS ────────────────────────────────────────────────────
 *
 * A technician standing at (or on the way to) a job can ask for the order to
 * be cancelled, or for its appointment to be moved. Neither ask MOVES the job
 * on its own: the row stays at job_status = 1 (SCHEDULED, "Pending to Start")
 * carrying a flag, and it keeps sitting in whichever appointment bucket its
 * CURRENT appointment puts it in — which is exactly why the request is
 * invisible. The three date buckets answer "when is this due", and a request
 * is a question about whether it is due at all.
 *
 *   is_cancelled_by_app   = 1  → "please cancel this order"
 *   is_rescheduled_by_app = 1  → "please move this appointment"
 *
 * ─── WHY job_status IS PART OF THE PREDICATE ──────────────────────────────
 *
 * A request is PENDING precisely while the job is still at status 1. The
 * moment ops actions it the job leaves that status — a granted cancellation
 * lands on 6 (CANCELLED) — so the pending set empties itself and there is no
 * "handled" flag to keep in sync with anything. Dropping the status test would
 * therefore not merely widen the set, it would resurrect every request ops has
 * ALREADY actioned, forever. The status test IS the handled test.
 *
 * ─── PRECEDENCE WHEN BOTH FLAGS ARE SET ───────────────────────────────────
 *
 * Both columns are sticky audit flags, so a job rescheduled from the app last
 * week and asked to be cancelled today carries both. Cancellation wins: it is
 * the more consequential ask, it supersedes any appointment the reschedule was
 * arguing about, and showing the row as a reschedule would hide the fact that
 * somebody is asking to kill the order.
 *
 * ─── WHY THIS IS A LIB MODULE AND NOT A COMPONENT HELPER ──────────────────
 *
 * `src/lib/*` is what `npm run test:build` compiles, so the predicate and the
 * kind discrimination get a real behavioural test instead of a source scan —
 * same reasoning as job-share.ts, whose shape this file follows. And, like
 * that module, it has NO imports: `test:build` compiles with
 * `--rootDir src/lib`, so reaching into `@/components/**` would break it. The
 * tone strings are deliberately a subset of `StatusChipTone`
 * (components/ui/StatusChip.tsx) — structurally assignable, so the call site
 * type-checks without the import.
 *
 * ─── THE WIRE FIELDS ──────────────────────────────────────────────────────
 *
 * All snake_case verbatim column aliases, matching every other field on the
 * `/admin/jobs` LIST projection (customer_submitted_at, magic_link_sent_at,
 * easyfixer_mobile, …) — that projection aliases columns as themselves and
 * resolves an action_taken_reason description as `<x>_reason_name`, which is
 * where app_request_reason comes from (see services/job.service.js: one
 * COALESCE resolving job_cancel_reason_id_by_easyfixer, else
 * reschedule_reason_id, against action_taken_reason).
 *
 * Every field is OPTIONAL. The CRM ships independently of the backend, so a
 * deploy that predates the projection change must render the rest of the row
 * rather than throw — an absent flag simply yields no request.
 */

/* job_status 1 — SCHEDULED / "Pending to Start". The only status in which a
 * request from the app is still awaiting an operator. */
export const PENDING_TO_START_STATUS = 1;

/* mysql2 hands TINYINT back as a number, JSON round-trips can make it a
 * string, and the projection may well cast it to a boolean. All three spell
 * the same flag. */
export type AppRequestFlag = boolean | number | string | null | undefined;

export type AppRequestFields = {
  job_status?: number | string | null;
  is_cancelled_by_app?: AppRequestFlag;
  is_rescheduled_by_app?: AppRequestFlag;
  /* Cancellation: when the technician raised it. */
  cancel_date_time?: string | null;
  /* Reschedule: when it was raised (tbl_job.reschedule_at_app — stamped by
   * the app's own POST /mobile/jobs/:id/reschedule), the appointment the
   * technician is ASKING for, and the resolved reason. */
  reschedule_at_app?: string | null;
  reschedule_date_time_app?: string | null;
  /* The ask's reason text, already resolved and disambiguated server-side:
   * ONE column for both kinds, because a job carrying both flags must not let
   * the FE pick a different winner than the SQL did. */
  app_request_reason?: string | null;
};

export type AppRequestKind = 'cancel' | 'reschedule';

export type AppRequest = {
  kind: AppRequestKind;
  /* Title Case, per the estate label rule. */
  label: string;
  tone: 'urgent' | 'warning';
  reason: string | null;
  /* When the technician raised it — the per-kind stamp, never a shared one. */
  raisedAt: string | null;
  /* The appointment being ASKED for. Reschedules only; a cancellation is not
   * proposing a new time, so this stays null and the UI renders no comparison
   * against the live appointment. */
  requestedFor: string | null;
};

/* A flag is ON only for an affirmative value. `'0'` is a non-empty string and
 * so truthy in JS — the exact way a stringified TINYINT turns every row in the
 * queue into a request. */
function flagOn(v: AppRequestFlag): boolean {
  return v === true || v === 1 || v === '1';
}

/* Blank-to-null so the caller has one falsy case to render, not three. */
function text(v: string | null | undefined): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

/*
 * THE VOCABULARY, in one table.
 *
 * Two surfaces build an AppRequest from two different payloads — the LIST
 * columns (appRequestOf) and the DETAIL object (appRequestFromDetail) — and
 * they must name the same ask identically. A chip reading "Cancellation
 * Requested" in the queue and something else in the workspace the operator
 * opened FROM that queue is the drift this map exists to make impossible.
 */
const KIND: Readonly<Record<AppRequestKind, { label: string; tone: AppRequest['tone'] }>> = {
  cancel: { label: 'Cancellation Requested', tone: 'urgent' },
  reschedule: { label: 'Reschedule Requested', tone: 'warning' },
};

/*
 * The ONE predicate for a LIST row. Returns the request to render, or null when
 * the row is an ordinary pending order — so a caller both FILTERS and RENDERS
 * through this, and the set on screen can never disagree with the set that was
 * counted.
 */
export function appRequestOf(row: AppRequestFields | null | undefined): AppRequest | null {
  if (!row) return null;
  if (Number(row.job_status) !== PENDING_TO_START_STATUS) return null;

  if (flagOn(row.is_cancelled_by_app)) {
    return {
      kind: 'cancel',
      ...KIND.cancel,
      reason: text(row.app_request_reason),
      raisedAt: text(row.cancel_date_time),
      requestedFor: null,
    };
  }

  if (flagOn(row.is_rescheduled_by_app)) {
    return {
      kind: 'reschedule',
      ...KIND.reschedule,
      reason: text(row.app_request_reason),
      raisedAt: text(row.reschedule_at_app),
      requestedFor: text(row.reschedule_date_time_app),
    };
  }

  return null;
}

/*
 * ─── THE DETAIL PAYLOAD ───────────────────────────────────────────────────
 *
 * GET /admin/jobs/:id already resolves the ask server-side and attaches it as
 * `appRequest` (EasyFix_Backend services/job.service.js getByIdCore →
 * buildAppRequest). Different field names from the LIST columns, and already
 * disambiguated — the SQL picked the winner, so there is nothing to decide here
 * and no flags to re-read.
 *
 * ⚠ IT IS NOT STATUS-GATED, AND THAT IS DELIBERATE — on the server's side too.
 * The list predicate above pins job_status = 1 because THAT is the ops queue,
 * and the status test is what empties it. The detail object keeps describing an
 * open ask after ops has moved the job, because the technician's app renders
 * its "waiting for ops" banner from the same object and hides its own
 * Cancel / Reschedule buttons while it is non-null. So a modal built on this
 * shows the ask on a job the queue has already released, which is correct: it
 * is telling the operator what the TECHNICIAN can currently see.
 */
export type AppRequestDetail = {
  type?: string | null;
  /* The appointment being ASKED for. Reschedules only; an IST wall-clock
   * 'YYYY-MM-DD HH:mm' string, never a parsed instant. */
  requestedDateTime?: string | null;
  reason?: string | null;
  requestedAt?: string | null;
};

/*
 * Detail payload → the SAME AppRequest the list rows carry, so one renderer
 * serves both. Returns null for absent/unknown kinds: a CRM deploy that meets
 * an older backend (no `appRequest` key) or a future ask type it has never
 * heard of must render nothing rather than a half-labelled banner.
 */
export function appRequestFromDetail(detail: AppRequestDetail | null | undefined): AppRequest | null {
  const kind = text(detail?.type) as AppRequestKind | null;
  if (!kind || !(kind in KIND)) return null;
  return {
    kind,
    ...KIND[kind],
    reason: text(detail?.reason),
    raisedAt: text(detail?.requestedAt),
    /* A cancellation proposes no new time; the server sends null, and a stray
     * value on one must not render a "Requested:" line the ask never made. */
    requestedFor: kind === 'reschedule' ? text(detail?.requestedDateTime) : null,
  };
}

/*
 * The technician's open RESCHEDULE ask on a Pending to Start job, or null.
 * Feeds the highlighted "Reschedule Requested" row under the schedule in the
 * Reassign Technician modal and in JobModal's Timeline, off the GET
 * /admin/jobs/:id detail both already read.
 *
 * Unlike appRequestFromDetail this IS status-gated (owner, 2026-09-16: "If
 * Pending to Start job is Reschedule Requested"): the row sits beside the live
 * appointment as a proposal to compare against, and outside status 1 there is
 * no schedule left for ops to move. A job carrying a cancel ask as well yields
 * null — cancel wins server-side, so there is no reschedule to show — and so
 * does an ask with no requested time, which would render an empty row.
 *
 * `requestedFor` stays VERBATIM ('YYYY-MM-DD HH:mm', IST wall-clock). The
 * caller renders it through formatDate / displaySlot, which read a zone-less
 * value as IST.
 */
export function pendingRescheduleRequest(
  detail: { job_status?: number | string | null; appRequest?: AppRequestDetail | null } | null | undefined,
): AppRequest | null {
  if (!detail || Number(detail.job_status) !== PENDING_TO_START_STATUS) return null;
  const req = appRequestFromDetail(detail.appRequest);
  return req?.kind === 'reschedule' && req.requestedFor ? req : null;
}
