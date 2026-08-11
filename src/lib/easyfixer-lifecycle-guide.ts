/**
 * Ops-facing reference for the technician lifecycle transition flow.
 *
 * This module is documentation, not enforcement: the backend
 * (`services/easyfixer-lifecycle.service.js`) remains the single authority for
 * which transitions are actually allowed. What we add here is the *rationale* —
 * for each status, what an operator can move it to and, crucially, WHY some
 * moves are intentionally not offered. Ops asked for this because the same
 * dropdown that only shows two options from Blacklisted / Inactive looks like a
 * bug until the reasoning is visible.
 *
 * `crmTransitionTargets()` is a deliberate, in-lock-step port of the backend's
 * `allowedCrmTransitions()` for the guide's representative case (a verified,
 * unmapped technician). The verification and manager-mapping nuances that this
 * common case elides are spelled out in LIFECYCLE_GUIDE_RULES.
 */

import type { EasyfixerLifecycleStatus } from './easyfixer-lifecycle';

const ONBOARDING = new Set<EasyfixerLifecycleStatus>([
  'NEW',
  'REGISTRATION_INCOMPLETE',
  'TRAINING_PENDING',
  'ASSESSMENT_FAILED',
  'UNDER_VERIFICATION',
  'VERIFICATION_REJECTED',
  'REAPPLIED',
  'APPLICATION_REJECTED',
]);

/**
 * The CRM transition targets from a status, for a *verified* technician with no
 * manager mapping (so the working state is ACTIVE, not UNDER_MASTER). Mirrors
 * backend `allowedCrmTransitions(status, verified=true, managerId=0)`; the self
 * status is filtered out, exactly as the dialog dropdown does.
 */
export function crmTransitionTargets(
  status: EasyfixerLifecycleStatus,
): EasyfixerLifecycleStatus[] {
  let targets: EasyfixerLifecycleStatus[];
  if (status === 'REAPPLIED') {
    targets = ['REGISTRATION_INCOMPLETE', 'APPLICATION_REJECTED'];
  } else if (status === 'INACTIVE' || status === 'DORMANT') {
    // (Semi-)technician-driven exits: returning to work must go through the
    // app-initiated reapply -> re-verification flow, so the CRM only offers the
    // administrative moves among the blocked states.
    targets = ['INACTIVE', 'DORMANT', 'BLACKLISTED'];
  } else if (ONBOARDING.has(status)) {
    targets = [
      'NEW',
      'REGISTRATION_INCOMPLETE',
      'TRAINING_PENDING',
      'ASSESSMENT_FAILED',
      'UNDER_VERIFICATION',
      'VERIFICATION_REJECTED',
      'APPLICATION_REJECTED',
      'INACTIVE',
      'BLACKLISTED',
    ];
  } else {
    // Operational states (ACTIVE/UNDER_MASTER/PAUSED/OFFLINE/ON_BENCH/SUSPENDED
    // and the fully-reversible BLACKLISTED): verified keeps ACTIVE, an unmapped
    // technician drops UNDER_MASTER (the CRM never lets you pick between them).
    targets = [
      'ACTIVE',
      'PAUSED',
      'INACTIVE',
      'BLACKLISTED',
      'DORMANT',
      'OFFLINE',
      'ON_BENCH',
      'SUSPENDED',
    ];
  }
  return targets.filter((target) => target !== status);
}

export type LifecycleGuideEntry = {
  status: EasyfixerLifecycleStatus;
  /** One-line plain-English meaning of the state. */
  summary: string;
  /** What is (and is not) offered from here, and why. */
  why: string;
};

export type LifecycleGuideGroup = {
  title: string;
  blurb: string;
  entries: LifecycleGuideEntry[];
};

/**
 * The three lifecycle phases, in the order a technician normally travels them.
 * Every one of the 17 lifecycle statuses appears exactly once.
 */
export const LIFECYCLE_GUIDE_GROUPS: LifecycleGuideGroup[] = [
  {
    title: 'Onboarding & Verification',
    blurb:
      'New and re-applying technicians move through these states until CRM verifies them. From any of them you can only step around within onboarding, or exit to Inactive or Blacklisted.',
    entries: [
      {
        status: 'NEW',
        summary: 'Record created; registration has not started yet.',
        why: 'Onboarding states move between each other or exit to Inactive / Blacklisted. Activation is not offered here — a technician becomes Active only through the verification approval flow, never as a manual status change.',
      },
      {
        status: 'REGISTRATION_INCOMPLETE',
        summary: 'Registration begun, but personal details, Aadhaar or photo are still missing.',
        why: 'Same onboarding options. It cannot jump to a working or availability state — those are for already-activated technicians.',
      },
      {
        status: 'TRAINING_PENDING',
        summary: 'Registration complete; training not yet finished.',
        why: 'Moves within onboarding, or exits to Inactive / Blacklisted. No direct activation from here.',
      },
      {
        status: 'ASSESSMENT_FAILED',
        summary: 'Failed the skill assessment.',
        why: 'Send back into onboarding to retry, or exit to Inactive / Blacklisted.',
      },
      {
        status: 'UNDER_VERIFICATION',
        summary: 'Details submitted; CRM is reviewing the profile.',
        why: 'Approve through the verification flow to activate — the dropdown deliberately does not offer Active here. You can still send it back (Verification Rejected / Registration Incomplete) or exit.',
      },
      {
        status: 'VERIFICATION_REJECTED',
        summary: 'CRM rejected the submitted details; the technician must correct and resubmit.',
        why: 'Stays within onboarding, or exits to Inactive / Blacklisted.',
      },
      {
        status: 'REAPPLIED',
        summary: 'A former technician has re-applied from the app and is awaiting a management decision.',
        why: 'This state cannot be set from the CRM — only the technician app can request it. From here you either admit them back to Registration (approve, which restarts a fresh verification) or move them to Application Rejected.',
      },
      {
        status: 'APPLICATION_REJECTED',
        summary: 'The application or re-application was rejected.',
        why: 'Re-admit into onboarding, or exit to Inactive / Blacklisted.',
      },
    ],
  },
  {
    title: 'Working & Availability',
    blurb:
      'Verified technicians who are, or can be, taking jobs. You can freely switch between working, availability and restriction states here, but you cannot push them back into onboarding.',
    entries: [
      {
        status: 'ACTIVE',
        summary: 'Verified and working — receiving and completing jobs.',
        why: 'Move to Paused / Offline / On Bench for temporary availability, or Inactive / Dormant / Blacklisted to stop work. Onboarding states are not offered — a working technician cannot be pushed back into registration.',
      },
      {
        status: 'UNDER_MASTER',
        summary: 'Working, but managed under a master / manager mapping.',
        why: 'Same options as Active. Whether a working technician shows as Active or Under Master follows the manager mapping — the CRM applies the correct one, so you do not pick between them here.',
      },
      {
        status: 'PAUSED',
        summary: 'Temporarily off new offers; keeps already-assigned jobs. May carry an auto-resume date.',
        why: 'Reactivate to Active, change availability, or exit. A dated pause lifts automatically on its date via the daily job.',
      },
      {
        status: 'OFFLINE',
        summary: 'Availability only — the technician is not currently taking work.',
        why: 'Switch back to Active, move between availability states, or exit to a restriction.',
      },
      {
        status: 'ON_BENCH',
        summary: 'Availability only — the technician is benched.',
        why: 'Switch back to Active, move between availability states, or exit to a restriction.',
      },
    ],
  },
  {
    title: 'Restrictions & Exit',
    blurb:
      'States that stop a technician from working. Suspended and dated pauses are temporary; Inactive and Dormant require the technician to re-apply from the app to return; Blacklisted is an admin decision that Ops can still reverse.',
    entries: [
      {
        status: 'SUSPENDED',
        summary: 'Admin-scheduled temporary block with a mandatory end date; auto-lifts on that date.',
        why: 'Admin only, and it needs a future end date. Because it is timed, the technician returns automatically, so you rarely move it by hand.',
      },
      {
        status: 'INACTIVE',
        summary: 'Technician has left or been deactivated (for example full-and-final).',
        why: 'From the CRM you can only keep them Inactive, move to Dormant, or Blacklist. Returning to work is deliberately not offered — the technician must re-apply from the app, which triggers management review and a fresh verification.',
      },
      {
        status: 'DORMANT',
        summary: 'Auto-parked (for example the wallet went below zero) or long inactive.',
        why: 'Same as Inactive: the CRM only offers Dormant to Inactive / Blacklisted. Coming back requires re-application from the app, not a CRM switch.',
      },
      {
        status: 'BLACKLISTED',
        summary: 'Blocked by an admin decision (fraud or serious misconduct).',
        why: 'Because it is a pure admin call, Ops can fully reverse it — every operational state is available, including moving straight back to Active. It is not a dead end.',
      },
    ],
  },
];

/**
 * Cross-cutting rules that shape the transition graph but are not tied to a
 * single "from" status. Rendered as the "How Transitions Work" preamble.
 */
export const LIFECYCLE_GUIDE_RULES: string[] = [
  'Verification gates work. Only a verified technician can be set Active or Under Master; for an unverified operational technician those two options are hidden.',
  'Active vs Under Master is automatic — it follows the manager mapping, so the CRM applies the correct one and you never choose between them.',
  'Some moves happen on their own: a daily job can auto-pause, auto-lift a dated Pause or Suspended on its date, and move a below-zero wallet to Dormant. The system never auto-sets Inactive or Blacklisted.',
  'Re-application is started by the technician. Reapplied can only come from the app; from Inactive or Dormant the CRM cannot send someone straight back to work.',
  'A reason is mandatory for every restricting move (Paused, Inactive, Dormant, Suspended, Blacklisted and the rejections) and is written to the audit log — some reasons are shown to the technician.',
  'Nothing is a permanent dead end — even Blacklisted can be reversed by an admin.',
];
