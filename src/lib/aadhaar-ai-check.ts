/*
 * The technician app's AI Aadhaar check, as the CRM shows it (owner, 2026-09-29).
 *
 * The backend records every check the app runs and stamps the one an identity
 * save used (EasyFix_Backend services/aadhaar-ai-check.service.js). The
 * verification page's Identity section and the Registered queue both render it
 * through this one mapping, so the two can never disagree about what
 * "AI: Mismatch" means.
 *
 * Pure and React-free so tests/aadhaar-ai-check.test.js can pin every verdict.
 */

export type AadhaarAiVerdict = 'verified' | 'mismatch' | 'not_run';

export interface AadhaarAiDiscrepancy {
  field: 'name' | 'aadhaarNumber' | 'dob' | string;
  expected: string | null;
  found: string | null;
}

/** `registrationVerification.identity.ai_check` on the verification payload. */
export interface AadhaarAiCheck {
  verdict: AadhaarAiVerdict | string;
  status: string;
  reason: string | null;
  masked_number: string | null;
  name_score: number | null;
  discrepancies: AadhaarAiDiscrepancy[];
  checked_at: string | null;
  submitted_at: string | null;
}

export type AadhaarAiTone = 'success' | 'warning' | 'neutral';

export interface AadhaarAiBadge {
  label: string;
  tone: AadhaarAiTone;
}

/** Chip for a verdict. `null`/unknown = no check on record (a legacy save). */
export function aadhaarAiBadge(verdict: string | null | undefined): AadhaarAiBadge | null {
  switch (verdict) {
    case 'verified':
      return { label: 'AI Verified ✓', tone: 'success' };
    case 'mismatch':
      return { label: 'AI: Mismatch ⚠', tone: 'warning' };
    case 'not_run':
      return { label: 'AI: Not Run', tone: 'neutral' };
    default:
      return null;
  }
}

const REASONS: Record<string, string> = {
  not_configured: 'The AI reader is switched off — verify the Aadhaar photos manually.',
  unreadable: 'The AI could not read the card — verify the Aadhaar photos manually.',
  name_not_compared: 'The card was read but no name was compared — check the name manually.',
};

/** Why a check did not run, as one sentence. */
export function aadhaarAiReason(reason: string | null | undefined): string {
  return (reason && REASONS[reason]) || 'No AI result — verify the Aadhaar photos manually.';
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  aadhaarNumber: 'Aadhaar Number',
  dob: 'Date Of Birth',
};

export interface AadhaarAiDifference {
  label: string;
  entered: string;
  onCard: string;
}

/** What differed, one row per field, in the order the backend recorded it. */
export function aadhaarAiDifferences(check: Pick<AadhaarAiCheck, 'discrepancies'> | null | undefined): AadhaarAiDifference[] {
  return (check?.discrepancies ?? []).map((d) => ({
    label: FIELD_LABELS[d.field] ?? d.field,
    entered: d.expected || '—',
    onCard: d.found || '—',
  }));
}
