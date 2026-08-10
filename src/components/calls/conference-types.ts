/*
 * conference-types — the WIRE CONTRACT for /api/admin/conferences/*, plus the
 * display maps that turn it into UI. One file so the panel, the participant
 * list and the picker cannot drift on a field name or a status string.
 *
 * ─── What this feature is ────────────────────────────────────────────────
 *
 * Plivo cannot promote a live <Dial> into a conference, so every ops call is
 * placed as a Multi-Party Call carrying a single participant (the operator).
 * Ops sees no difference — click Call, it rings, they talk — but because the
 * leg is already a conference participant, "add someone" is one API call away
 * at any moment. This file describes what the browser is allowed to know
 * about that room.
 *
 * ─── PRIVACY: the browser only ever sees a masked number ─────────────────
 *
 * Both `ConferenceParticipant` and `ConferenceRosterEntry` carry
 * `masked_number` (the `9988••••••` form) and NOTHING else number-shaped.
 * The backend's DTOs never project `dialled_number`, and there is no query
 * parameter that unmasks a live-call payload. Do not add a field here that
 * would hold digits, and never render a roster row's identity as anything
 * but `masked_number`.
 *
 * The corollary, and the reason `request` exists: a roster row carries the
 * exact BODY to POST for that row (`{ jobId: 482491, useAlt: true }`), so the
 * picker sends an IDENTIFIER and the server resolves the digits. The FE never
 * maps target-kind → request key, and therefore cannot get that mapping wrong.
 */

import {
  Headset, User, UserRound, Wrench, Building2, Briefcase, PhoneOutgoing,
  type LucideIcon,
} from 'lucide-react';
import type { StatusChipTone } from '@/components/ui/StatusChip';
import {
  CALL_LEG_ROLE_LABEL,
  CALL_LEG_STATUS_LABEL,
  CALL_LEG_STATUS_TONE,
  callLegStatusLabel,
  callLegStatusTone,
  type CallLeg,
  type CallLegRole,
  type CallLegStatus,
} from '@/lib/call-legs';

/* ─── enums (mirrors the BE's own constants) ────────────────────────────── */

/** `creating | live | ending` are the LIVE set; `ended | failed` are terminal. */
export type ConferenceStatus = 'creating' | 'live' | 'ending' | 'ended' | 'failed';

/*
 * ⚠ A PARTICIPANT'S STATUS IS A CALL-LOG STATUS.
 *
 * Participants stopped being their own table: a conference leg is now a row in
 * `tbl_plivo_call_log` sharing the call's `job_caller_info_id`, so it carries
 * THAT table's status vocabulary (`initiated | ringing | answered | completed |
 * no_answer | failed`), not a conference-private one. That is what lets the
 * per-job call-history tooltip and the Call Info modal render a conference leg
 * without knowing conferences exist.
 *
 * The old names live on as the KEYS of `CALL_LEG_STATUS` — `LEFT` is still
 * `LEFT`, its value is just `'completed'`. Never compare against the old string
 * literals: `p.status === 'joined'` is now permanently false.
 */
export type ParticipantStatus = CallLegStatus;

export type ConferenceTargetKind = CallLegRole;

/* ─── objects ───────────────────────────────────────────────────────────── */

export type Conference = {
  id: number;
  job_id: number | null;
  status: ConferenceStatus;
  provider: string;
  started_by_user_id: number | null;
  job_caller_info_id: number | null;
  /*
   * DERIVED server-side from the legs it returns alongside this object, not a
   * stored counter — so the number here and the length of `participants` are
   * the same count, taken once.
   */
  participant_count: number;
  started_on: string | null;
  ended_on: string | null;
  duration: number | null;
  end_reason: string | null;
  error: string | null;
  created_on: string | null;
  live: boolean;
  /** Stop-polling flag — mirrors GET /admin/calls/:id/status's own `terminal`. */
  terminal: boolean;
};

/*
 * A live participant IS a call leg (`CallLeg` in lib/call-legs.ts, the same type
 * the history surfaces render) plus the three things only a LIVE read can know:
 * the Plivo role, whether the leg is still on the call, and whether this
 * operator may drop it.
 */
export type ConferenceParticipant = CallLeg & {
  id: number;
  conference_id: number;
  target_kind: ConferenceTargetKind;
  target_id: number | null;
  display_name: string | null;
  /** `9988••••••`. The ONLY number-shaped value on the wire. */
  masked_number: string | null;
  role: string;
  status: ParticipantStatus;
  hangup_cause: string | null;
  added_by_user_id: number | null;
  joined_at: string | null;
  left_at: string | null;
  duration: number | null;
  created_on: string | null;
  /** status ∈ initiated | ringing | answered. */
  active: boolean;
  /** False for the operator — dropping that leg would end the room; use End Call. */
  can_remove: boolean;
};

/*
 * One pickable party on the job. `request` IS the POST body for this row —
 * copy it verbatim, do not rebuild it.
 */
export type ConferenceRosterEntry = {
  target_kind: ConferenceTargetKind;
  label: string;
  name: string | null;
  masked_number: string | null;
  /** False when there's no number on file → the Add affordance must be disabled. */
  available: boolean;
  /**
   * True when this party already has an ACTIVE leg in the room — which is the
   * right question for "grey out Add so we don't dial them twice", and the
   * WRONG one for a status chip: the active set includes `initiated`, so this
   * is true for someone whose phone is still ringing. Render `status`, not this.
   */
  on_call: boolean;
  /**
   * The leg's real status when this row has one, else null. Same vocabulary as
   * `ConferenceParticipant.status`.
   */
  status: ParticipantStatus | null;
  participant_id: number | null;
  request: Record<string, number | boolean>;
};

/** GET /admin/conferences/:id — one read drives the whole live surface. */
export type ConferenceStateResp = {
  conference: Conference;
  participants: ConferenceParticipant[];
  roster: ConferenceRosterEntry[];
  /*
   * ⚠ There is no `limits` here, and that is a decision rather than an
   * omission. The max-participants / max-duration / max-concurrent properties
   * were deleted: a ceiling on a conference belongs to the PROVIDER, so Plivo's
   * own defaults apply and the FE has nothing to render or enforce. Do not
   * reintroduce a capacity read — the room's cost guard is the operator's leg
   * carrying `endMpcOnExit` (hanging up ends the room), with a server-side leak
   * detector behind it. Neither is a number an operator should ever see.
   */
  /*
   * Server-side truth for the higher-trust custom-number arm. Read this
   * rather than inferring it: the endpoint that will accept (or 403) the
   * request is the same code that computed this flag.
   */

};

/** POST /admin/conferences/:id/participants — the leg is DIALLING, not joined. */
export type AddParticipantResp = {
  participantId: number;
  participant: ConferenceParticipant | null;
  message?: string;
};

/** POST /admin/conferences/:id/end. */
export type EndConferenceResp = {
  conferenceId: number;
  ended: boolean;
  alreadyEnded: boolean;
  /** False ⇒ Plivo accepted the teardown but still reports the room (reaper retries). */
  verified: boolean;
  duration: number | null;
  message?: string;
};

/** DELETE /admin/conferences/:id/participants/:participantId. */
export type RemoveParticipantResp = {
  participantId: number;
  removed: boolean;
  alreadyGone: boolean;
  message?: string;
};

/* ─── RBAC action keys ──────────────────────────────────────────────────── */

/*
 * Seeded by EasyFix_Backend/migrations/2026-08-04-seed-conference-rbac.sql.
 * `hasAction()` fails closed and there is NO Admin bypass, so an unseeded key
 * is held by nobody — including Admin.
 */
/*
 * The ONE permission. Conferencing is gated by the SAME key as calling —
 * `isClickToCall` — because every ops call IS a conference now, so a separate
 * conference grant could only ever produce a broken half-state: an operator able
 * to place a call but not see its own participants. Per the owner: "either no
 * call access or any type of call access."
 *
 * NB: `isConferenceCall` in src/lib/call-legs.ts is an unrelated helper meaning
 * "is this call row a conference?" — not a permission. Don't merge the two.
 */
export const ACTION_CONFERENCE = 'isClickToCall';

/* ─── display maps ──────────────────────────────────────────────────────── */

/*
 * Re-exported from lib/call-legs.ts rather than restated: the live panel and
 * call history must spell a leg's status identically, and the only way to
 * guarantee that is for there to be one map. `StatusChipTone` is the wider
 * union — the assignment below is what proves the lib's tone subset stays
 * assignable to it, and will fail the build if it ever stops being.
 */
export const PARTICIPANT_STATUS_LABEL: Record<ParticipantStatus, string> = CALL_LEG_STATUS_LABEL;

export const PARTICIPANT_STATUS_TONE: Record<ParticipantStatus, StatusChipTone> = CALL_LEG_STATUS_TONE;

/*
 * Fallback label when a participant has no display_name of its own.
 *
 * One key differs from the shared map, deliberately: on the LIVE panel the
 * operator leg is the person reading the screen, so it says 'You'. Call history
 * is mostly other people's calls and uses the shared 'Ops Agent'. Every other
 * role comes from the shared map so a rename lands in both.
 */
export const TARGET_KIND_LABEL: Record<ConferenceTargetKind, string> = {
  ...CALL_LEG_ROLE_LABEL,
  operator: 'You',
};

/*
 * Role icon per party kind. Referenced as components (`const Icon = MAP[k]`)
 * so this stays a plain .ts module with no JSX.
 */
export const TARGET_KIND_ICON: Record<ConferenceTargetKind, LucideIcon> = {
  operator:       Headset,
  customer:       User,
  customer_alt:   UserRound,
  technician:     Wrench,
  job_spoc:       Building2,
  client_contact: Briefcase,
  custom:         PhoneOutgoing,
};

/*
 * An unknown status string must degrade to something readable rather than
 * render `undefined`. The BE enum is closed today; these keep a future value
 * from painting a blank chip.
 */
export function participantStatusLabel(status: ParticipantStatus | string): string {
  return callLegStatusLabel(status);
}

export function participantStatusTone(status: ParticipantStatus | string): StatusChipTone {
  return callLegStatusTone(status);
}

export function targetKindLabel(kind: ConferenceTargetKind | string): string {
  return TARGET_KIND_LABEL[kind as ConferenceTargetKind] ?? 'Participant';
}

export function targetKindIcon(kind: ConferenceTargetKind | string): LucideIcon {
  return TARGET_KIND_ICON[kind as ConferenceTargetKind] ?? User;
}
