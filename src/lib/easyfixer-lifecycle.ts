/**
 * Canonical technician lifecycle contract shared by the EasyFix CRM and the
 * unified backend. This module is deliberately React-free so list pages,
 * dialogs, exports, and Node contract tests all use one normalization path.
 */

export const EASYFIXER_LIFECYCLE_STATUSES = [
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
  'ACTIVE',
  'PAUSED',
  'INACTIVE',
  'REAPPLIED',
  'APPLICATION_REJECTED',
  'BLACKLISTED',
  'DORMANT',
  'UNDER_MASTER',
  'OFFLINE',
  'ON_BENCH',
  'SUSPENDED',
] as const;

export type EasyfixerLifecycleStatus = typeof EASYFIXER_LIFECYCLE_STATUSES[number];
export type LifecycleTone = 'red' | 'amber' | 'sky' | 'emerald' | 'slate' | 'violet' | 'rose' | 'orange';

export type EasyfixerLifecycleCapabilities = {
  receiveNewJobs: boolean;
  continueAssignedJobs: boolean;
  mutateAssignedJobs: boolean;
  markAttendance: boolean;
  editRegistration: boolean;
  claimMoney: boolean;
  reapply: boolean;
  readOnlyApp: boolean;
};

export type EasyfixerLifecycleSnapshot = {
  status: EasyfixerLifecycleStatus;
  reasonCode: string | null;
  reason: string | null;
  changedAt: string | null;
  until: string | null;
  version: number | null;
  pauseCount: number;
  jobsAllowed: boolean | null;
  canReapply: boolean | null;
  canClaimEarnings: boolean | null;
  source: string | null;
  capabilities: EasyfixerLifecycleCapabilities | null;
  allowedTransitions: EasyfixerLifecycleStatus[];
  /** Distinguishes an authoritative empty server graph from an older payload. */
  allowedTransitionsProvided: boolean;
};

export type EasyfixerLifecycleHistoryItem = {
  id: number | string;
  fromStatus: EasyfixerLifecycleStatus | null;
  toStatus: EasyfixerLifecycleStatus;
  reasonCode: string | null;
  reason: string | null;
  source: string | null;
  actorUserId: number | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  until: string | null;
  version: number | null;
};

export type EasyfixerLifecycleHistory = {
  items: EasyfixerLifecycleHistoryItem[];
  total: number;
  limit: number;
  offset: number;
};

export type LifecycleRowFields = {
  lifecycle?: unknown;
  lifecycle_status?: unknown;
  lifecycleStatus?: unknown;
  lifecycle_reason_code?: unknown;
  lifecycle_reason?: unknown;
  lifecycle_changed_at?: unknown;
  lifecycle_until?: unknown;
  lifecycle_version?: unknown;
  lifecycle_pause_count?: unknown;
  lifecycle_source?: unknown;
};

const STATUS_SET = new Set<string>(EASYFIXER_LIFECYCLE_STATUSES);
const ONBOARDING_STATUSES = new Set<EasyfixerLifecycleStatus>([
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
  'REAPPLIED',
  'APPLICATION_REJECTED',
]);
const OPERATIONAL_STATUSES = new Set<EasyfixerLifecycleStatus>([
  'ACTIVE',
  'PAUSED',
  'INACTIVE',
  'BLACKLISTED',
  'DORMANT',
  'UNDER_MASTER',
  'OFFLINE',
  'ON_BENCH',
  'SUSPENDED',
]);

const PRESENTATION: Record<EasyfixerLifecycleStatus, { label: string; tone: LifecycleTone }> = {
  NEW:                     { label: 'New', tone: 'sky' },
  REGISTRATION_INCOMPLETE: { label: 'Registration Incomplete', tone: 'amber' },
  TRAINING_PENDING:        { label: 'Training Pending', tone: 'amber' },
  ASSESSMENT_FAILED:       { label: 'Assessment Failed', tone: 'red' },
  UNDER_VERIFICATION:      { label: 'Under Verification', tone: 'sky' },
  VERIFICATION_REJECTED:   { label: 'Verification Rejected', tone: 'red' },
  ACTIVE:                  { label: 'Active', tone: 'emerald' },
  PAUSED:                  { label: 'Paused', tone: 'orange' },
  INACTIVE:                { label: 'Inactive', tone: 'slate' },
  REAPPLIED:               { label: 'Reapplied', tone: 'violet' },
  APPLICATION_REJECTED:    { label: 'Application Rejected', tone: 'red' },
  BLACKLISTED:             { label: 'Blacklisted', tone: 'rose' },
  DORMANT:                 { label: 'Dormant', tone: 'slate' },
  UNDER_MASTER:            { label: 'Under Master', tone: 'violet' },
  OFFLINE:                 { label: 'Offline', tone: 'slate' },
  ON_BENCH:                { label: 'On Bench', tone: 'amber' },
  SUSPENDED:               { label: 'Suspended', tone: 'orange' },
};

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function lifecycleCapabilities(value: unknown): EasyfixerLifecycleCapabilities | null {
  const source = record(value);
  if (!source) return null;
  return {
    receiveNewJobs: booleanOrNull(source.receiveNewJobs ?? source.receive_new_jobs) ?? false,
    continueAssignedJobs: booleanOrNull(source.continueAssignedJobs ?? source.continue_assigned_jobs) ?? false,
    mutateAssignedJobs: booleanOrNull(source.mutateAssignedJobs ?? source.mutate_assigned_jobs) ?? false,
    markAttendance: booleanOrNull(source.markAttendance ?? source.mark_attendance) ?? false,
    editRegistration: booleanOrNull(source.editRegistration ?? source.edit_registration) ?? false,
    claimMoney: booleanOrNull(source.claimMoney ?? source.claim_money) ?? false,
    reapply: booleanOrNull(source.reapply) ?? false,
    readOnlyApp: booleanOrNull(source.readOnlyApp ?? source.read_only_app) ?? false,
  };
}

/** Accept canonical strings plus harmless case/space/hyphen variants. */
export function normalizeLifecycleStatus(value: unknown): EasyfixerLifecycleStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS_SET.has(normalized) ? normalized as EasyfixerLifecycleStatus : null;
}

/** Resolve a lifecycle status from a string, canonical object, or list row. */
export function lifecycleStatusFrom(value: unknown): EasyfixerLifecycleStatus | null {
  const direct = normalizeLifecycleStatus(value);
  if (direct) return direct;

  const source = record(value);
  if (!source) return null;

  const nested = source.lifecycle;
  const nestedStatus = nested !== value ? lifecycleStatusFrom(nested) : null;
  if (nestedStatus) return nestedStatus;

  return normalizeLifecycleStatus(
    source.lifecycle_status ?? source.lifecycleStatus ?? source.status,
  );
}

export function lifecycleLabel(status: EasyfixerLifecycleStatus): string {
  return PRESENTATION[status].label;
}

export function lifecycleTone(status: EasyfixerLifecycleStatus): LifecycleTone {
  return PRESENTATION[status].tone;
}

export type CandidateJobOfferEligibility = {
  /** The server-authoritative answer when `can_offer` is present. */
  canOffer: boolean;
  /** False only for an older candidate payload that has no lifecycle contract. */
  authoritative: boolean;
  status: EasyfixerLifecycleStatus | null;
  reason: string | null;
  explanation: string;
};

/**
 * Merge the two bounded candidate payloads without letting hidden SWR data
 * override the row the operator can currently see. `useFetch` intentionally
 * retains its previous payload across key changes; inserting the active
 * surface last keeps display, toggle, pruning, and submit guards on one row.
 */
export function mergeCandidatesByActiveSurface<T extends { efr_id: number }>(
  topRows: readonly T[],
  searchRows: readonly T[],
  showingSearch: boolean,
): Map<number, T> {
  const byId = new Map<number, T>();
  const backgroundRows = showingSearch ? topRows : searchRows;
  const activeRows = showingSearch ? searchRows : topRows;
  for (const candidate of backgroundRows) byId.set(candidate.efr_id, candidate);
  for (const candidate of activeRows) byId.set(candidate.efr_id, candidate);
  return byId;
}

const JOB_RECEIVING_LIFECYCLE_STATUSES = new Set<EasyfixerLifecycleStatus>([
  'ACTIVE',
  'UNDER_MASTER',
]);

/**
 * Resolve offer/assignment eligibility from one candidate-list row.
 *
 * `can_offer` is deliberately checked first: ranking/search endpoints own the
 * final decision and may include gates beyond lifecycle. Rich lifecycle fields
 * are only a compatibility fallback. A truly old row with neither contract is
 * allowed so a staggered backend/CRM deployment does not disable the existing
 * assignment flow; every post-migration payload is expected to be authoritative.
 */
export function candidateJobOfferEligibility(value: unknown): CandidateJobOfferEligibility {
  const row = record(value) ?? {};
  const explicitRaw = row.can_offer ?? row.canOffer;
  const explicit = booleanOrNull(explicitRaw);
  const snapshot = normalizeLifecycleSnapshot(row);
  const status = snapshot?.status ?? null;
  const reason = snapshot?.reason
    ?? stringOrNull(row.lifecycle_reason ?? row.lifecycleReason)
    ?? null;

  let canOffer: boolean;
  let authoritative = explicitRaw != null;
  if (explicitRaw != null) {
    // A present-but-malformed authoritative field must fail closed. Only a
    // genuinely absent field gets the rolling-deploy compatibility fallback.
    canOffer = explicit === true;
  } else if (snapshot?.capabilities) {
    canOffer = snapshot.capabilities.receiveNewJobs;
    authoritative = true;
  } else if (snapshot?.jobsAllowed != null) {
    canOffer = snapshot.jobsAllowed;
    authoritative = true;
  } else if (status) {
    canOffer = JOB_RECEIVING_LIFECYCLE_STATUSES.has(status);
    authoritative = true;
  } else {
    // Backward compatibility for a rolling deploy only. The backend mutation
    // remains the final race-safe guard even while an old list payload is open.
    canOffer = true;
    authoritative = false;
  }

  const explanation = canOffer
    ? 'Eligible to receive new job offers.'
    : reason
      ? reason
      : status
        ? `${lifecycleLabel(status)} technicians cannot receive new job offers.`
        : 'This technician is not currently eligible to receive new job offers.';

  return { canOffer, authoritative, status, reason, explanation };
}

/**
 * Ranked rows are actionable recommendations and must be offerable. Reassign
 * responses may additionally prepend the current technician as non-selectable
 * context even when restricted; CandidateTable marks that row as "Current".
 */
export function candidateVisibleOnRankedSurface(value: unknown): boolean {
  const row = record(value);
  return row?.is_current === true || candidateJobOfferEligibility(value).canOffer;
}

export function normalizeLifecycleSnapshot(value: unknown): EasyfixerLifecycleSnapshot | null {
  const root = record(value);
  if (!root) return null;
  const nested = record(root.lifecycle) ?? root;
  const status = lifecycleStatusFrom(nested);
  if (!status) return null;

  const allowedRaw = nested.allowedTransitions ?? nested.allowed_transitions
    ?? root.allowedTransitions ?? root.allowed_transitions;
  const allowedTransitionsProvided = Array.isArray(allowedRaw);
  const allowedTransitions = Array.isArray(allowedRaw)
    ? allowedRaw.map(normalizeLifecycleStatus).filter((s): s is EasyfixerLifecycleStatus => s != null)
    : [];

  return {
    status,
    reasonCode: stringOrNull(nested.reasonCode ?? nested.reason_code ?? root.lifecycle_reason_code),
    reason: stringOrNull(nested.reason ?? root.lifecycle_reason),
    changedAt: stringOrNull(nested.changedAt ?? nested.changed_at ?? root.lifecycle_changed_at),
    until: stringOrNull(nested.until ?? root.lifecycle_until),
    version: numberOrNull(nested.version ?? root.lifecycle_version),
    pauseCount: numberOrNull(nested.pauseCount ?? nested.pause_count ?? root.lifecycle_pause_count) ?? 0,
    jobsAllowed: booleanOrNull(nested.jobsAllowed ?? nested.jobs_allowed),
    canReapply: booleanOrNull(nested.canReapply ?? nested.can_reapply),
    canClaimEarnings: booleanOrNull(nested.canClaimEarnings ?? nested.can_claim_earnings),
    source: stringOrNull(nested.source ?? root.lifecycle_source),
    capabilities: lifecycleCapabilities(nested.capabilities ?? root.capabilities),
    allowedTransitions,
    allowedTransitionsProvided,
  };
}

function historyItem(value: unknown, fallbackId: number): EasyfixerLifecycleHistoryItem | null {
  const item = record(value);
  if (!item) return null;
  const toStatus = lifecycleStatusFrom(item.toStatus ?? item.to_status ?? item.status);
  if (!toStatus) return null;
  const rawMetadata = record(item.metadata);

  return {
    id: numberOrNull(item.id) ?? stringOrNull(item.id) ?? `history-${fallbackId}`,
    fromStatus: lifecycleStatusFrom(item.fromStatus ?? item.from_status),
    toStatus,
    reasonCode: stringOrNull(item.reasonCode ?? item.reason_code),
    reason: stringOrNull(item.reason),
    source: stringOrNull(item.source),
    actorUserId: numberOrNull(item.actorUserId ?? item.actor_user_id),
    actorName: stringOrNull(
      item.actorName ?? item.actor_name ?? item.changedByName ?? item.changed_by_name
        ?? rawMetadata?.actorName ?? rawMetadata?.actor_name,
    ),
    metadata: rawMetadata,
    createdAt: stringOrNull(item.createdAt ?? item.created_at ?? item.changedAt ?? item.changed_at),
    until: stringOrNull(item.until),
    version: numberOrNull(item.version),
  };
}

export function normalizeLifecycleHistory(value: unknown, defaultLimit = 10): EasyfixerLifecycleHistory {
  const root = record(value) ?? {};
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items = rawItems
    .map((item, index) => historyItem(item, index))
    .filter((item): item is EasyfixerLifecycleHistoryItem => item != null);
  return {
    items,
    total: Math.max(0, numberOrNull(root.total) ?? items.length),
    limit: Math.max(1, numberOrNull(root.limit) ?? defaultLimit),
    offset: Math.max(0, numberOrNull(root.offset) ?? 0),
  };
}

export function lifecycleTargets(snapshot: EasyfixerLifecycleSnapshot): EasyfixerLifecycleStatus[] {
  if (snapshot.status === 'BLACKLISTED') return [];
  const source = snapshot.allowedTransitionsProvided
    ? snapshot.allowedTransitions
    : snapshot.status === 'REAPPLIED'
      ? ['REGISTRATION_INCOMPLETE', 'APPLICATION_REJECTED'] satisfies EasyfixerLifecycleStatus[]
      : snapshot.status === 'INACTIVE' || snapshot.status === 'DORMANT'
        // These states can reapply only from the technician App. CRM must not
        // bypass management approval and the mandatory second verification.
        ? ['BLACKLISTED'] satisfies EasyfixerLifecycleStatus[]
    : ONBOARDING_STATUSES.has(snapshot.status)
      ? EASYFIXER_LIFECYCLE_STATUSES.filter((status) => ONBOARDING_STATUSES.has(status))
      : EASYFIXER_LIFECYCLE_STATUSES.filter((status) => OPERATIONAL_STATUSES.has(status));
  return source.filter((status) => status !== snapshot.status);
}

export function statusUsesUntil(status: EasyfixerLifecycleStatus | null): boolean {
  return status === 'PAUSED' || status === 'SUSPENDED';
}

export function statusRequiresUntil(status: EasyfixerLifecycleStatus | null): boolean {
  return status === 'SUSPENDED';
}

export type LifecycleTransitionDraft = {
  currentStatus: EasyfixerLifecycleStatus;
  targetStatus: EasyfixerLifecycleStatus | null;
  reason: string;
  until: string;
  today?: string;
};

/** Client-side validation complements, but never replaces, backend rules. */
export function validateLifecycleTransition(draft: LifecycleTransitionDraft): string | null {
  if (!draft.targetStatus) return 'Choose a new lifecycle status.';
  if (draft.targetStatus === draft.currentStatus) return 'Choose a status different from the current status.';
  if (!draft.reason.trim()) return 'A reason is required for the lifecycle audit log.';

  if (statusRequiresUntil(draft.targetStatus) && !draft.until) {
    return 'Suspended status requires an end date.';
  }
  if (draft.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.until)) return 'Enter a valid end date.';
    const today = draft.today ?? new Date().toISOString().slice(0, 10);
    if (draft.until <= today) return 'End date must be in the future.';
  }
  return null;
}

export type ReapplicationSummary = {
  isReapplication: boolean;
  previousTxId: string | number | null;
  previousPerformanceGrade: string | null;
  lifetimeJobs: number | null;
  lifetimeEarnings: number | null;
};

/** Read additive reapplication fields without coupling the table to one casing. */
export function reapplicationSummary(value: unknown): ReapplicationSummary {
  const row = record(value) ?? {};
  const status = lifecycleStatusFrom(row);
  const rawPreviousTxId = row.previousTxId ?? row.previous_tx_id
    ?? row.previousEfrId ?? row.previous_efr_id ?? row.oldTxId ?? row.old_tx_id;
  const previousTxId = stringOrNull(rawPreviousTxId) ?? numberOrNull(rawPreviousTxId);
  const previousPerformanceGrade = stringOrNull(
    row.previousPerformanceGrade ?? row.previous_performance_grade,
  );
  const lifetimeJobs = numberOrNull(
    row.lifetimeJobsCompleted ?? row.lifetime_jobs_completed ?? row.lifetimeJobCount
      ?? row.lifetime_job_count ?? row.previousCompletedJobs ?? row.previous_completed_jobs
      ?? row.previousJobCount ?? row.previous_job_count,
  );
  const lifetimeEarnings = numberOrNull(
    row.lifetimeEarnings ?? row.lifetime_earnings ?? row.previousEarnings ?? row.previous_earnings,
  );
  const explicit = booleanOrNull(row.isReapplication ?? row.is_reapplication ?? row.reapplication);
  return {
    isReapplication: status === 'REAPPLIED' || explicit === true || previousTxId != null,
    previousTxId,
    previousPerformanceGrade,
    lifetimeJobs,
    lifetimeEarnings,
  };
}
