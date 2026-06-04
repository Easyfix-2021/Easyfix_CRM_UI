/*
 * job-address.ts — shared address-resolution helpers for the Job
 * create/edit modal flows.
 *
 * Hoisted from JobModal.tsx on 2026-06-04. The original inline resolver
 * lived in the C&S sibling fan-out (~line 4923) and existed solely to
 * avoid the BE creating duplicate tbl_address rows when the operator
 * fans out N sibling jobs from one Unconfirmed parent.
 *
 * Why it deserves to be shared:
 *   - The same short-circuit applies the moment ANY create flow grows
 *     a "saved address picker" UX (Book-New-Call, Manage Customers add-
 *     job, mobile-app technician add-job). All of them should pass
 *     `address: { address_id: <existing-row> }` instead of the full
 *     inline address payload — the BE's `create()` honors `address_id`
 *     for reuse and falls through to `insertAddress(...)` otherwise
 *     (see EasyFix_Backend/services/job.service.js ~line 1279).
 *   - Centralising the resolver also gives us ONE place to add
 *     dev-time telemetry when the resolver falls through to inline
 *     (a silent canary for future regressions if a BE select shrinks
 *     and stops returning fk_address_id on a PATCH).
 */

/**
 * Resolve a tbl_address.address_id from one or more candidate sources,
 * preferring the earlier entries in the list. Returns `null` when none
 * of the candidates carry a usable id.
 *
 * Usage:
 *   const id = resolveParentAddressId(saved, initial, currentJob);
 *   const addressPayload = id
 *     ? { address_id: id }
 *     : buildInlineAddress(formState);
 *
 * Why a varargs `unknown[]` signature:
 *   - The Job interface in lib/types.ts doesn't currently declare
 *     `fk_address_id` even though the API returns it — adding it there
 *     would ripple through too many call sites unrelated to this
 *     migration. The resolver does a runtime structural check instead
 *     (cheap, single property read).
 *   - Future callers (Book-New-Call's saved-address picker, mobile-app
 *     technician add-job, etc.) will pass different prop graphs. A
 *     source-agnostic `unknown[]` keeps the signature stable.
 */
export function resolveParentAddressId(...sources: unknown[]): number | null {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const id = (src as { fk_address_id?: number | null }).fk_address_id;
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

/**
 * The inline-address shape the BE accepts when no address_id is available.
 * Mirrors the createBody Joi schema in EasyFix_Backend/validators/job.validator.js.
 * Use when constructing the fallback branch for `buildJobAddressPayload`.
 */
export interface InlineAddressPayload {
  address: string;
  building?: string;
  landmark?: string;
  city_id: number;
  pin_code: string;
  gps_location?: string;
  address_instruction?: string;
}

/**
 * Build the `address` slice of a POST /admin/jobs payload, preferring
 * the address_id short-circuit and falling back to the supplied inline
 * payload when no parent address is available.
 *
 * The dev-only `console.warn` is intentional: when we DO fall through
 * in a flow that was supposed to have a parent address (e.g. C&S
 * sibling), it almost always indicates a BE select shrinking and
 * dropping fk_address_id from a response. Catching it in dev surfaces
 * the silent-duplicate-row regression before it reaches prod.
 */
export function buildJobAddressPayload(
  parentAddressId: number | null,
  inline: InlineAddressPayload,
  opts: { expectingReuse?: boolean } = {},
): { address_id: number } | InlineAddressPayload {
  if (parentAddressId) return { address_id: parentAddressId };
  if (opts.expectingReuse && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '[job-address] expected to reuse a parent address_id but none was '
      + 'available — falling back to inline (may produce a duplicate '
      + 'tbl_address row). Check that the PATCH response / Job prop '
      + 'still includes fk_address_id.',
    );
  }
  return inline;
}
