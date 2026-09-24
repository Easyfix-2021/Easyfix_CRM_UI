/*
 * Whether a failed browser (web) call leg gets its ONE silent retry.
 *
 * Only "Not Found": Plivo rejecting the INVITE because this browser's login is
 * stale (token past its 1h `exp`, or a dropped SIP registration). The customer
 * was never dialled — no /web-answer ever arrives — so dialling again is safe,
 * and the fresh login the retry forces is exactly what fixes it (Prod
 * 2026-09-24: 13 such failures across 4 operators, each cured by a re-login).
 *
 * Never for Busy / No Answer / Declined — those reached a real person — and
 * never once the leg connected, nor twice for the same operator click.
 */
export function shouldRetryWebCall(
  reason: string,
  s: { attemptUsed: boolean | null; reachedInProgress: boolean },
): boolean {
  return /not.?found/i.test(reason) && s.attemptUsed === false && !s.reachedInProgress;
}
