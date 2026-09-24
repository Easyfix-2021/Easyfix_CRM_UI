/*
 * Tx Share — the "technician cut on top of material price" field added to
 * client material rate groups / state overrides and to quotation lines
 * (2026-09-24 contract, owner-approved design). The ONE rule this whole
 * feature turns on: Tx Share always defaults to 20% of a price, rounded to
 * 2dp, and that default is recomputed every time the PRICE it is attached to
 * changes — but a manual Tx Share edit survives until the next price change.
 *
 * Kept dependency-free (no imports) so it compiles standalone under the
 * `test:build` raw-tsc invocation (see package.json) and so every caller —
 * ClientMaterialPriceEditor, PriceTree (via a passed-in callback),
 * MaterialReviewModal, AddQuotationLineDialog — goes through the SAME
 * arithmetic rather than each re-deriving "20%" itself.
 */

/*
 * 20% of `price`, rounded to 2dp. Null/undefined/NaN price → 0. Mirrors
 * EasyFix_Backend's own `defaultTxShare` (services/material-price-resolver.js
 * — `round2(price * 0.2)`, `round2` = `Math.round((n + Number.EPSILON) * 100)
 * / 100`) bit-for-bit, so a value the CRM prefills never disagrees with what
 * the server would compute for the same price.
 */
export function defaultTxShare(price: number | null | undefined): number {
  const p = Number(price) || 0;
  return Math.round((p * 0.2 + Number.EPSILON) * 100) / 100;
}

/*
 * Apply a PRICE change to a row that carries a `txShare` field: the price
 * moves to the new value and txShare is unconditionally reset to 20% of it.
 * Use this from every "price changed" handler; use a plain field patch (not
 * this function) for a manual Tx Share edit, so that edit is kept until the
 * NEXT call to this function.
 */
export function applyPriceChange<T extends Record<string, unknown>>(
  row: T,
  price: number | null,
): T & { price: number | null; txShare: number } {
  return { ...row, price, txShare: defaultTxShare(price) };
}

/** (Quoted unit price + Tx Share per unit) × Qty, rounded to 2dp. */
export function computeApprovedTotal(quotedUnitPrice: number, txSharePerUnit: number, qty: number): number {
  const total = (Number(quotedUnitPrice) || 0) + (Number(txSharePerUnit) || 0);
  return Math.round(total * (Number(qty) || 0) * 100) / 100;
}

/*
 * Apply a QUOTED-unit-price change to a row that carries `quotedUnitPrice` +
 * `approvedAmount`: the quoted price moves to the new value and the approved
 * LINE total is unconditionally recomputed from it. Same "reset on the
 * driving field's change, kept otherwise" shape as applyPriceChange — a
 * manual Approved-amount edit survives until the next Quoted change.
 */
export function applyQuotedChange<T extends Record<string, unknown>>(
  row: T,
  quotedUnitPrice: number,
  txSharePerUnit: number,
  qty: number,
): T & { quotedUnitPrice: number; approvedAmount: number } {
  return { ...row, quotedUnitPrice, approvedAmount: computeApprovedTotal(quotedUnitPrice, txSharePerUnit, qty) };
}
