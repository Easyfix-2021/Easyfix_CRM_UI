/*
 * collected_by — tbl_job's "who bears the cost" enum, and the words ops read.
 *
 * Moved verbatim out of JobModal.tsx (2026-09-11) so every surface that SHOWS
 * the value reads it through one mapping. The Reassign Technician panel had
 * its own, reading a `payment_mode` field, and printed "Not Set" for a job
 * storing collected_by = 1 (Paid By Customer).
 */

/*
 * collectedByCode — coerce the form's `collected_by` field (a
 * human-readable label like "Easyfix" / "Easyfixer" / "Client", per
 * the legacy default in JobModal's JobForm) into the integer enum tbl_job
 * expects. Returns `undefined` for unknown values so the BE falls
 * back to whatever default it prefers.
 *
 *   1 = Easyfixer (technician collects)
 *   2 = Easyfix   (operator/CRM collects)
 *   3 = Client    (client collects)
 */
export function collectedByCode(label: unknown): number | undefined {
  if (label == null || label === '') return undefined;
  if (typeof label === 'number') return label;
  const s = String(label).trim().toLowerCase();
  if (s === 'easyfixer') return 1;
  if (s === 'easyfix')   return 2;
  if (s === 'client')    return 3;
  // Allow numeric strings too (e.g. "2") for forward-compat.
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/*
 * collectedByLabel — inverse of collectedByCode. tbl_job stores the enum as an
 * INTEGER (1/2/3), but the Collected By <SearchSelect> options are the string
 * labels. On reload we must map the stored integer back to its label, else the
 * dropdown value matches no option and renders blank — the "Collected By not
 * saved" symptom. Tolerant of already-label values (legacy rows). Returns
 * undefined for unknown so the caller can apply its default.
 */
export function collectedByLabel(code: unknown): string | undefined {
  if (code == null || code === '') return undefined;
  const s = String(code).trim().toLowerCase();
  if (s === '1' || s === 'easyfixer') return 'Easyfixer';
  if (s === '2' || s === 'easyfix')   return 'Easyfix';
  if (s === '3' || s === 'client')    return 'Client';
  return undefined;
}

/*
 * Customer-facing wording for Collected By. The stored enum and the wire
 * vocabulary are UNCHANGED — 'Easyfixer'/'Easyfix' remain the option values and
 * the BE's /collected-by-preference still answers with them (routes/admin/
 * clients.js COLLECTED_BY_MAP). Only the words ops read change, from "who
 * physically collects" to "who bears the cost", which is the same fact:
 *   1 Easyfixer → the technician takes payment on site → Paid By Customer
 *   2 Easyfix   → Easyfix invoices the client          → Free For Customer
 * Keeping value≠label is deliberate: relabelling the VALUES would silently
 * reinterpret 82k jobs already storing 1 and break collectedByCode()'s mapping.
 *
 * 3 (Client) is intentionally NOT offered per job — ops set it on the client
 * profile, and production has 13 such jobs. Any unmapped value falls through
 * verbatim so a legacy 'Client' row still renders its own name rather than blank.
 */
export const COLLECTED_BY_CUSTOMER_LABEL: Record<string, string> = {
  Easyfixer: 'Paid By Customer',
  Easyfix:   'Free For Customer',
};
export function collectedByDisplay(v: unknown): string {
  const s = String(v ?? '').trim();
  return COLLECTED_BY_CUSTOMER_LABEL[s] ?? s;
}

/*
 * The two options the booking flow offers when the client profile says "Any"
 * (tbl_client.collected_by = 0). Ops MUST pick one — leaving it unset is what
 * wrote 0 to tbl_job and blocked those jobs from checking out.
 */
export const COLLECTED_BY_JOB_OPTIONS = [
  { value: 'Easyfix',   label: 'Free For Customer' },
  { value: 'Easyfixer', label: 'Paid By Customer' },
];

/*
 * Stored value (1/2/3, or a legacy label) → the customer-facing words.
 * 1 → 'Paid By Customer', 2 → 'Free For Customer', 3 → 'Client';
 * undefined when unset (0 / null / unknown) so the caller picks its placeholder.
 */
export function collectedByText(code: unknown): string | undefined {
  const label = collectedByLabel(code);
  return label ? collectedByDisplay(label) : undefined;
}
