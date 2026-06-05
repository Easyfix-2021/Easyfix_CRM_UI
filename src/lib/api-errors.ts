/*
 * api-errors.ts — shared helper for converting backend error responses
 * into operator-facing toast strings.
 *
 * The BE's modern envelope is:
 *   { success: false, error: "Validation failed", details: [
 *       { field: "useAlt", message: "\"useAlt\" must be a boolean" }
 *     ]
 *   }
 *
 * api.ts surfaces this as `ApiError` with `.message = "Validation failed"`
 * and `.details = [...]`. Before this helper, every catch block in the
 * CRM just rendered `.message`, so operators saw the generic
 * "Validation failed" toast with no hint at the offending field —
 * forcing a ticket + dev tools dive to discover which input was wrong.
 *
 * `formatApiError(err)` pulls field-level messages out of `.details`
 * (when present) and joins them onto the toast line, so the operator
 * sees something like:
 *
 *   "Validation failed — useAlt must be a boolean"
 *
 * For non-validation errors (auth fail, 5xx, unrelated 4xx without
 * `.details`), it falls through to the plain `.message`.
 */

import { ApiError } from '@/lib/api';

type ValidationDetail = { field?: unknown; message?: unknown };

function isDetailArray(d: unknown): d is ValidationDetail[] {
  return Array.isArray(d)
    && d.length > 0
    && d.every((x) => x && typeof x === 'object');
}

/*
 * Build the user-facing toast string for an unknown thrown value.
 *
 * - `ApiError` with `.details` validation array → "Generic message — field message; field message"
 * - `ApiError` without `.details`               → `.message`
 * - Plain `Error`                               → `.message`
 * - Anything else                               → `'Unexpected error'`
 *
 * `cap` truncates very long detail strings so the toast doesn't
 * overflow the viewport (8-field-deep payloads occasionally produce
 * 500+ char messages). Default 240 chars; pass `cap: 0` to disable.
 */
export function formatApiError(err: unknown, opts: { fallback?: string; cap?: number } = {}): string {
  const cap = opts.cap ?? 240;
  const fallback = opts.fallback ?? 'Unexpected error';

  if (err instanceof ApiError) {
    if (isDetailArray(err.details)) {
      // Format each detail as "field: message" — strip Joi's default
      // outer quotes around the field name in the message (Joi emits
      // `"useAlt" must be a boolean`) to avoid double-quoting since
      // we already prefix with the field name.
      const parts = (err.details as ValidationDetail[])
        .map((d) => {
          const fieldRaw = typeof d.field === 'string' ? d.field : '';
          const msgRaw = typeof d.message === 'string' ? d.message : '';
          const msgClean = msgRaw.replace(/^"[^"]+"\s*/, '');
          if (!fieldRaw) return msgClean || JSON.stringify(d);
          return msgClean ? `${fieldRaw} ${msgClean}` : fieldRaw;
        })
        .filter(Boolean);
      const joined = parts.join('; ');
      const combined = joined ? `${err.message} — ${joined}` : err.message;
      return cap > 0 && combined.length > cap ? `${combined.slice(0, cap - 1)}…` : combined;
    }
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
