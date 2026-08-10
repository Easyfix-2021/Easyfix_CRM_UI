/*
 * call-legs — the shared vocabulary for CALL LEGS, and the guard that keeps a
 * conference reading as ONE call.
 *
 * ─── Why this file exists ────────────────────────────────────────────────
 *
 * A conference is not a new kind of call. It is one call that gained people.
 * The backend models it that way too: `tbl_job_caller_info` still gets exactly
 * ONE row per call, and each extra person on the call gets their own
 * `tbl_plivo_call_log` row sharing that same `job_caller_info_id` plus a
 * `conference_id` and a `participant_role`.
 *
 * That single decision is what makes every existing call surface keep telling
 * the truth — call COUNTS, connect rates, talk time and the QuickSight
 * aggregates are all keyed on `tbl_job_caller_info` and therefore still count a
 * 3-party conference as one call. What those surfaces lose is COMPOSITION: who
 * else was actually on it. This module is the browser half of putting that back:
 *
 *   · one status vocabulary, spelled exactly as the backend stores it
 *   · one role→label map, so "technician" never renders as three phrasings
 *   · `groupCallRows`, which collapses a per-leg fan-out back into one row
 *
 * ─── PURE ON PURPOSE ─────────────────────────────────────────────────────
 *
 * No React, no lucide, no imports at all. `npm run test:build` compiles this
 * file standalone with plain `tsc` so `tests/call-legs.test.js` can require it,
 * and a single component import would break that build. Icons and JSX live in
 * `components/calls/` — see `CallLegList.tsx` and `conference-types.ts`.
 */

/* ─── status vocabulary ─────────────────────────────────────────────────── */

/*
 * ⚠ THESE STRINGS ARE THE DATABASE'S, NOT OURS.
 *
 * A conference leg is stored in `tbl_plivo_call_log.status` using that table's
 * OWN vocabulary — the same one every ordinary Plivo leg has always used —
 * mirroring `EasyFix_Backend/services/plivo-call-log.service.js` → `LEG_STATUS`.
 * That is deliberate: it is what lets the per-job call-history tooltip, the Call
 * Info modal and GET /api/admin/calls render a conference leg without knowing
 * conferences exist.
 *
 * So do NOT "tidy" these into conference words (`joined`, `left`, `dialling`).
 * The keys below are the conference concept; the VALUES are what is on the
 * wire, and only the values may be compared against a payload.
 *
 * Note `LEFT` and `REMOVED` share one value: the database cannot tell "hung up"
 * from "was dropped by the operator", and inventing a distinction the data does
 * not carry would be a lie with a nice label on it.
 */
export const CALL_LEG_STATUS = {
  DIALLING: 'initiated',
  RINGING: 'ringing',
  JOINED: 'answered',
  LEFT: 'completed',
  REMOVED: 'completed',
  NO_ANSWER: 'no_answer',
  FAILED: 'failed',
} as const;

export type CallLegStatus =
  | 'initiated' | 'ringing' | 'answered' | 'completed' | 'no_answer' | 'failed';

/** Statuses in which a leg is still on the call — mirrors BE ACTIVE_LEG_STATUSES. */
export const ACTIVE_CALL_LEG_STATUSES: readonly CallLegStatus[] = [
  CALL_LEG_STATUS.DIALLING,
  CALL_LEG_STATUS.RINGING,
  CALL_LEG_STATUS.JOINED,
];

export function isActiveCallLegStatus(status: string | null | undefined): boolean {
  return ACTIVE_CALL_LEG_STATUSES.includes(String(status ?? '') as CallLegStatus);
}

/*
 * The tones are a SUBSET of StatusChipTone, spelled as a local union so this
 * module stays import-free (StatusChip is a .tsx and would break test:build).
 * Every value here must remain assignable to StatusChipTone.
 */
export type CallLegTone = 'amber' | 'emerald' | 'slate' | 'rose' | 'sky' | 'violet';

/*
 * One label map for BOTH the live panel and call history, which is why the
 * wording is outcome-shaped rather than tense-shaped. 'Left' reads correctly
 * for a leg that has hung up whether you are watching it happen or reading it
 * back a week later; 'Disconnected' would be ambiguous with 'Failed'.
 */
export const CALL_LEG_STATUS_LABEL: Record<CallLegStatus, string> = {
  initiated: 'Dialling',
  ringing:   'Ringing',
  answered:  'On Call',
  completed: 'Left',
  no_answer: 'No Answer',
  failed:    'Failed',
};

export const CALL_LEG_STATUS_TONE: Record<CallLegStatus, CallLegTone> = {
  initiated: 'amber',
  ringing:   'amber',
  answered:  'emerald',
  completed: 'slate',
  no_answer: 'rose',
  failed:    'rose',
};

/*
 * An unknown status must degrade to something readable rather than paint a
 * blank chip. The backend enum is closed today; this is what keeps a future
 * value (or a pre-migration row) from rendering `undefined`.
 */
export function callLegStatusLabel(status: string | null | undefined): string {
  return CALL_LEG_STATUS_LABEL[String(status ?? '') as CallLegStatus] ?? 'Unknown';
}

export function callLegStatusTone(status: string | null | undefined): CallLegTone {
  return CALL_LEG_STATUS_TONE[String(status ?? '') as CallLegStatus] ?? 'slate';
}

/* ─── role vocabulary ───────────────────────────────────────────────────── */

/** `tbl_plivo_call_log.participant_role` — also the conference target kind. */
export type CallLegRole =
  | 'operator'        // the ops user's own leg — never removable (see can_remove)
  | 'customer'
  | 'customer_alt'
  | 'technician'
  | 'job_spoc'
  | 'client_contact'
  | 'custom';         // an arbitrary number, gated by isConferenceCustomNumber

/*
 * ⚠ 'operator' is 'Ops Agent' here, NOT 'You'.
 *
 * The live panel can say "You" because the call being watched is yours. Call
 * HISTORY is mostly other people's calls, so the same map would caption another
 * agent's leg as "You". The live panel overrides this one key — see
 * `TARGET_KIND_LABEL` in components/calls/conference-types.ts — and every other
 * role is shared, so a rename lands in both places at once.
 */
export const CALL_LEG_ROLE_LABEL: Record<CallLegRole, string> = {
  operator:       'Ops Agent',
  customer:       'Customer',
  customer_alt:   'Customer (Alternate)',
  technician:     'Assigned Technician',
  job_spoc:       'Job SPOC',
  client_contact: 'Client Contact',
  custom:         'Other Number',
};

export function callLegRoleLabel(role: string | null | undefined): string {
  return CALL_LEG_ROLE_LABEL[String(role ?? '') as CallLegRole] ?? 'Participant';
}

/*
 * Party tone, across BOTH role vocabularies.
 *
 * Call history has two sources for "who was this with": the leg's own
 * `participant_role` (`client_contact`), and the older per-row classification
 * the backend derives from the job's known numbers (`Client SPOC`). They mean
 * the same things and must not be coloured differently on the same screen, so
 * this normalises punctuation and casing and maps both.
 */
export function partyTone(role: string | null | undefined): CallLegTone {
  const k = String(role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (k) {
    case 'operator':                        return 'slate';
    case 'customer':                        return 'sky';
    case 'customer_alt':
    case 'alternate':                       return 'amber';
    case 'technician':                      return 'emerald';
    case 'job_spoc':
    case 'client_spoc':
    case 'client_contact':                  return 'violet';
    default:                                return 'slate';
  }
}

/* ─── the leg on the wire ───────────────────────────────────────────────── */

/*
 * One leg of a call, as the backend's MASKED leg projection returns it
 * (`LEG_PUBLIC_COLUMNS` in plivo-call-log.service.js, which aliases the call-log
 * columns into this participant vocabulary).
 *
 * ⚠ `masked_number` (`9812••••••`) is the ONLY number-shaped field, here and on
 * the wire. The projection selects neither `dialed_number` nor
 * `receiver_number`; only the first four digits ever leave the database. Do not
 * add a field to this type that could hold a whole number, and never render a
 * leg's identity as anything but `masked_number`.
 *
 * Most fields are optional because this same type is consumed from three
 * endpoints that are free to project only what their surface renders — a
 * history row does not need `member_id`. `id`, `target_kind` and `status` are
 * the three a leg cannot be drawn without.
 */
export type CallLeg = {
  /** `tbl_plivo_call_log.id` — NOT the call id. Unique per leg. */
  id: number;
  conference_id?: number | null;
  target_kind: CallLegRole | string;
  display_name?: string | null;
  /** `9812••••••`. The only number-shaped value on this wire. */
  masked_number?: string | null;
  status: CallLegStatus | string;
  duration?: number | null;
  /** answered_on / ended_on / initiated_on, in the participant vocabulary. */
  joined_at?: string | null;
  left_at?: string | null;
  created_on?: string | null;
  hangup_cause?: string | null;
};

/** The shape every call-history row shares, whatever else its surface adds. */
export type CallRowWithLegs = {
  id: number;
  conference_id?: number | null;
  legs?: CallLeg[] | null;
};

/* ─── the fan-out guard ─────────────────────────────────────────────────── */

/*
 * groupCallRows — collapse a per-leg fan-out back into ONE row per call.
 *
 * ⚠ THIS IS THE "3 LEGS MUST NOT READ AS 3 CALLS" GUARD, and it is defensive on
 * purpose.
 *
 * `GET /api/admin/calls` INNER JOINs tbl_job_caller_info to tbl_plivo_call_log
 * on `job_caller_info_id`, which is a plain KEY and NOT UNIQUE. The moment a
 * conference writes a second leg under the same call, that join fans out: three
 * near-identical rows, all carrying the SAME call id, every jci-derived column
 * (time, duration, status, recording) duplicated verbatim. Rendered raw that is
 * three calls on screen, three duplicate React keys, and — where the row count
 * is shown — a call volume inflated by the number of people on the call.
 *
 * The endpoint is expected to collapse this server-side and return the extra
 * legs nested as `legs[]`. This function makes the browser correct under BOTH
 * shapes: given collapsed rows it is an identity pass (one row in, one row out,
 * legs untouched), and given a fan-out it merges the duplicates and gathers
 * their legs. Two repos ship on different days; the surface that shows an
 * operator a call count should not be the thing that notices.
 *
 * What it deliberately does NOT do is fix a `total` that counted the fan-out.
 * Only the server can, since the extra rows may be on another page — so a
 * paginated surface must keep pointing its pager at the server's `total`, and
 * the fix for that count lives in the endpoint.
 *
 * First row of a group wins for scalar fields (they are duplicates by
 * construction), order of first appearance is preserved, and legs are de-duped
 * by leg id so a merge cannot list the same person twice.
 */
export function groupCallRows<T extends CallRowWithLegs>(rows: readonly T[] | null | undefined): T[] {
  if (!rows || rows.length === 0) return [];

  const byId = new Map<number, T>();
  const legsById = new Map<number, Map<number, CallLeg>>();
  // Output slots in first-appearance order. A row with an unusable id is
  // emitted IN PLACE rather than grouped: it cannot be merged or keyed, but
  // dropping it (or shunting it to the end) would quietly rewrite the operator's
  // chronological list.
  const slots: Array<{ id: number } | { row: T }> = [];

  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      slots.push({ row });
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, row);
      legsById.set(id, new Map());
      slots.push({ id });
    }
    const legs = legsById.get(id);
    if (!legs) continue;
    for (const leg of row.legs ?? []) {
      if (leg && typeof leg.id === 'number' && !legs.has(leg.id)) legs.set(leg.id, leg);
    }
  }

  return slots.map((slot) => {
    if (!('id' in slot)) return slot.row;
    const row = byId.get(slot.id) as T;
    const legs = sortCallLegs([...(legsById.get(slot.id)?.values() ?? [])]);
    // Preserve `legs: undefined` when there were none — an empty array would
    // read as "we looked and there was nobody", which is a different claim from
    // "this endpoint does not project legs".
    return legs.length > 0 ? ({ ...row, legs } as T) : row;
  });
}

/*
 * Legs in the order a human reads a call: the ops agent first (they placed it),
 * then everyone else in the order they were dialled. `created_on` is the leg's
 * `initiated_on`, stored as an IST wall-clock string — string comparison is
 * correct for that format and needs no Date parsing.
 */
export function sortCallLegs(legs: readonly CallLeg[]): CallLeg[] {
  return [...legs].sort((a, b) => {
    const ao = a.target_kind === 'operator' ? 0 : 1;
    const bo = b.target_kind === 'operator' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const at = String(a.created_on ?? '');
    const bt = String(b.created_on ?? '');
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id - b.id;
  });
}

/*
 * True when this call had more people on it than the operator + one party —
 * i.e. it is worth telling the reader that this row is a conference.
 *
 * Read off the LEGS, not off `conference_id`. Every ops call is now placed as a
 * Multi-Party Call carrying a single participant (Plivo cannot promote a live
 * <Dial> into a conference), so `conference_id` is set on ordinary 1:1 calls
 * too — badging those "Conference" would put the label on nearly every row and
 * teach operators to ignore it.
 */
export function isConferenceCall(row: CallRowWithLegs | null | undefined): boolean {
  return (row?.legs?.length ?? 0) > 1;
}

/*
 * How many people were on the call, for the "· N People" badge.
 *
 * Derived from the legs actually being rendered rather than from a stored
 * counter, so the badge and the list underneath it cannot disagree — the same
 * reason the backend dropped its `participant_count` column and counts the rows
 * it is already returning.
 */
export function callPartyCount(row: CallRowWithLegs | null | undefined): number {
  return row?.legs?.length ?? 0;
}

/*
 * The non-operator legs, i.e. "who the agent was talking to". Used for the
 * one-line summary a narrow column can afford, where the full list cannot fit.
 */
export function counterpartyLegs(row: CallRowWithLegs | null | undefined): CallLeg[] {
  return (row?.legs ?? []).filter((l) => l.target_kind !== 'operator');
}

/*
 * A leg's display name, falling back to its role label and finally its masked
 * number. Never returns an empty string — a blank cell in a call log reads as a
 * rendering bug rather than as missing data.
 */
export function callLegName(leg: CallLeg): string {
  const name = String(leg.display_name ?? '').trim();
  if (name) return name;
  const label = callLegRoleLabel(leg.target_kind);
  if (label !== 'Participant') return label;
  return String(leg.masked_number ?? '').trim() || 'Participant';
}

/*
 * `3m 04s` / `45s` / `—`. Local to leg rendering rather than reusing any of the
 * three surfaces' own duration formatters, so a leg's duration is spelled the
 * same in the tooltip, the Call Info modal and the QuickSight drill-down.
 */
export function fmtLegDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

/*
 * Everything on a call as one searchable string — leg names, role labels and
 * statuses — so a client-side page filter can match a person who was
 * conferenced in, not just the party the call was originally placed to.
 */
export function callLegSearchText(row: CallRowWithLegs | null | undefined): string {
  return (row?.legs ?? [])
    .map((l) => [callLegName(l), callLegRoleLabel(l.target_kind), callLegStatusLabel(l.status)].join(' '))
    .join(' ')
    .toLowerCase();
}
