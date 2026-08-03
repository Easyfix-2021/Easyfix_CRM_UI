/*
 * job-slots — THE single source of truth for the booking window vocabulary.
 *
 * ── TWO SEPARATE CONCEPTS, NEVER ONE ───────────────────────────────────────
 *
 *   tbl_job.time_slot      the BROAD BOOKING BAND. Exactly FOUR values:
 *                            '9AM to 12PM' · '12PM to 3PM' · '3PM to 7PM' ·
 *                            'After Hours'
 *                          These four strings ARE what the column stores today
 *                          (they are the new-CRM picker's own strings and cover
 *                          the overwhelming majority of live rows). Nothing else
 *                          may ever be WRITTEN from this app.
 *
 *   tbl_job.requested_time the START of the 1-HOUR frame Ops/the customer
 *   (+ the time part of    actually picked. Picking "10 AM - 11 AM" stores
 *    requested_date_time)  10:00; the band is then the one CONTAINING 10:00.
 *
 * So: the operator picks a 1-hour frame, its START becomes the requested time,
 * and the band is derived. The BAND is the coarse promise; the TIME is the
 * precision. The string stops being load-bearing — the hour is.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * tbl_job.time_slot holds at least a dozen distinct free-text values accreted
 * from FOUR different vocabularies over the years:
 *
 *   backend deriveTimeSlot()   'Morning 9 to 2' · 'Evening 2 to 7' ·
 *                              'Afternoon 12 to 5' · 'After Hours'
 *   the new-CRM picker         '9AM to 12PM' · '12PM to 3PM' · '3PM to 7PM' ·
 *                              'After Hours'                    ← THE TARGET
 *   a 1-hour-frame experiment  '9 AM–10 AM' … '6 PM–7 PM'  (also written by the
 *                              WhatsApp confirmation flow, backend-side)
 *   legacy junk                'Morning 9 to 12' · 'Afternoon 12 to 2' ·
 *                              'After Hours - 19:00' · '9-12' · 'After 7PM' · …
 *
 * Every duplicated inline slot array in this repo was a chance for a fifth
 * vocabulary, and the customer-facing magic-link form had in fact grown one
 * ('9 AM – 12 PM', en-dash). One module, imported everywhere, is the fix — the
 * repo's touch-it-migrate-it rule applied to a constant.
 *
 * ── BACKWARD COMPATIBILITY (mandatory) ─────────────────────────────────────
 *
 * Historical rows are NOT migrated and never will be. A job holding
 * 'Morning 9 to 2' must still DISPLAY 'Morning 9 to 2' when opened, and an
 * untouched open-and-save must persist it unchanged. `slotChoicesFor()` is how
 * that is guaranteed: it appends whatever the job holds as an extra option when
 * it isn't one of the four. Never blank, never silently rewrite a stored slot.
 */

/** The 'no ordinary window' band. Also the label of the off-grid time row. */
export const AFTER_HOURS_SLOT = 'After Hours';

/**
 * The representative start hour stamped when a caller picks 'After Hours' from
 * a band-only control (the customer magic-link form). Ops surfaces instead let
 * the operator type the exact out-of-hours time.
 */
export const AFTER_HOURS_START = '19:00';

export type BookingBand = {
  /** EXACT string persisted to tbl_job.time_slot. */
  value: string;
  label: string;
  /** Inclusive start hour; -1 for 'After Hours' (no derivable window). */
  fromH: number;
  /** Exclusive end hour; -1 for 'After Hours'. */
  toH: number;
  /** 'HH:mm' stamped when this band is picked band-first. */
  start: string;
};

/*
 * THE FOUR BANDS. `value` === `label` deliberately: the operator reads exactly
 * what the database stores, so a support conversation about "what slot is this
 * job in" needs no translation table.
 */
export const BOOKING_BANDS: readonly BookingBand[] = [
  { value: '9AM to 12PM', label: '9AM to 12PM', fromH: 9,  toH: 12, start: '09:00' },
  { value: '12PM to 3PM', label: '12PM to 3PM', fromH: 12, toH: 15, start: '12:00' },
  { value: '3PM to 7PM',  label: '3PM to 7PM',  fromH: 15, toH: 19, start: '15:00' },
  { value: AFTER_HOURS_SLOT, label: AFTER_HOURS_SLOT, fromH: -1, toH: -1, start: AFTER_HOURS_START },
];

/*
 * foldSlot — a slot string reduced to its COMPARISON form: lower-cased with all
 * whitespace removed. Never stored, never displayed; it exists only to answer
 * "do these two strings name the same band?".
 *
 * WHY IT HAS TO EXIST. tbl_job.time_slot is free text written by four pickers
 * over a decade, so one band arrives spelled several ways that differ ONLY
 * cosmetically — prod carries '9 am to 12 pm' alongside '9AM to 12PM', and job
 * #482491 carries '3pm to 7pm' alongside the canonical '3PM to 7PM'. Compared
 * byte-for-byte those read as unknown legacy values, so `slotChoicesFor`
 * appended each one as an EXTRA option: Confirm & Schedule rendered a FIVE-chip
 * row with '3PM to 7PM' and '3pm to 7pm' sitting side by side, the lower-cased
 * one highlighted. One band, offered twice, with no way to tell them apart.
 *
 * DELIBERATELY NARROW — case and spacing only. A value differing by anything
 * else ('Morning 9 to 2', '9-12', or the WhatsApp flow's 1-hour frame
 * '3 PM–4 PM') is a genuinely different string and still earns its own chip.
 * Folding those would mean PICKING a band on the operator's behalf, which is a
 * writer-side judgement the backend makes at save time (normaliseSlotLabel in
 * services/time-slot.js), not something a display rule may do silently.
 */
function foldSlot(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * The canonical spelling of a stored slot when it names one of the four bands
 * with only cosmetic differences ('3pm to 7pm' → '3PM to 7PM'); the trimmed
 * input otherwise, and '' for empty.
 *
 * Use this — NEVER raw `===` — whenever a stored `time_slot` is compared
 * against `BOOKING_BANDS`, e.g. to decide which chip renders as active or what
 * a <SearchSelect> should show as selected. Raw equality misses the cosmetic
 * variants and silently reports "no band selected".
 *
 * It is a READ-side helper. It does not rewrite what gets saved: an untouched
 * job still submits the string it arrived with, and the backend's
 * `resolveTimeSlot` has the final say on what lands in the column.
 */
export function canonicalSlot(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const folded = foldSlot(raw);
  return BOOKING_BANDS.find((b) => foldSlot(b.value) === folded)?.value ?? raw;
}

/**
 * One option as a band picker consumes it. Widened from `BookingBand` because a
 * runtime-appended legacy value carries no real window (fromH/toH = -1).
 */
export type SlotChoice = { value: string; label: string; fromH: number; toH: number };

/*
 * slotChoicesFor — the option list a band picker should render for a job that
 * currently holds `currentValue`.
 *
 * THE COMPATIBILITY RULE: a value the control is given is ALWAYS rendered as an
 * option (and therefore as the selected one), even when it is not one of the
 * four bands. Legacy jobs hold 'Morning 9 to 2' / '9-12'; the WhatsApp flow
 * writes 1-hour frame labels like '3 PM–4 PM'. Either way the operator must see
 * what the job actually says instead of an unselected row — and an untouched
 * save must send that same string straight back.
 *
 * …EXCEPT for a purely cosmetic restatement of a band. `canonicalSlot` folds
 * case and spacing first, so '3pm to 7pm' resolves to the EXISTING
 * '3PM to 7PM' option instead of being appended beside it. Rendering both would
 * put two chips for one window in front of the operator with nothing to choose
 * between them. Only genuinely different strings still get their own option.
 */
export function slotChoicesFor(currentValue: unknown): SlotChoice[] {
  const base: SlotChoice[] = BOOKING_BANDS.map((b) => ({
    value: b.value, label: b.label, fromH: b.fromH, toH: b.toH,
  }));
  const current = canonicalSlot(currentValue);
  if (current && !base.some((b) => b.value === current)) {
    // fromH -1 ⇒ selecting it never nudges the time picker (same treatment as
    // 'After Hours'), because we can't know the window a legacy label meant.
    base.push({ value: current, label: current, fromH: -1, toH: -1 });
  }
  return base;
}

/**
 * True when `value` is one of the four bands (i.e. not a legacy string).
 * Cosmetic variants count as known — '3pm to 7pm' IS the '3PM to 7PM' band, and
 * flagging it as legacy would tag a perfectly ordinary chip with the "already
 * stored on this job, pick a real band to replace it" warning.
 */
export function isKnownBand(value: unknown): boolean {
  const v = canonicalSlot(value);
  return BOOKING_BANDS.some((b) => b.value === v);
}

export type HourFrame = {
  /** 'HH:mm' — the frame START, which is what lands in requested_time. */
  start: string;
  /** Display only. Nothing persists this string. */
  label: string;
  hour: number;
};

function hour12(h: number): string {
  const suffix = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${suffix}`;
}

/*
 * THE TEN 1-HOUR FRAMES — 9-10 … 6-7. This is the granularity Ops and the
 * customer actually choose at; the band follows from the start hour.
 *
 * Labels are PRESENTATIONAL ONLY. They used to be written into
 * tbl_job.time_slot (which is what produced the eleven-chip picker the four
 * bands replaced), so byte-exactness against any backend string no longer
 * matters — only `start` crosses the wire, as the time.
 */
export const HOUR_FRAMES: readonly HourFrame[] = Array.from({ length: 10 }, (_, i) => {
  const h = 9 + i;
  return { start: `${String(h).padStart(2, '0')}:00`, label: `${hour12(h)} - ${hour12(h + 1)}`, hour: h };
});

/** True when 'HH:mm' is exactly one of the ten frame starts. */
export function isHourFrameStart(timeHHMM: string): boolean {
  return HOUR_FRAMES.some((f) => f.start === timeHHMM);
}

/**
 * The band containing `hour`. Anything outside 9–19 (early mornings, late
 * evenings) is 'After Hours'.
 */
export function bandForHour(hour: number): string {
  if (!Number.isFinite(hour)) return '';
  const hit = BOOKING_BANDS.find((b) => b.fromH >= 0 && hour >= b.fromH && hour < b.toH);
  return hit ? hit.value : AFTER_HOURS_SLOT;
}

/** The band for a 'HH:mm' wall-clock time. '' when unparseable. */
export function bandForTime(timeHHMM: string): string {
  const h = Number(String(timeHHMM ?? '').split(':')[0]);
  return Number.isNaN(h) ? '' : bandForHour(h);
}

/*
 * ── WALL-CLOCK PARSING ─────────────────────────────────────────────────────
 *
 * TWO datetime spellings reach these helpers, and both must work:
 *
 *   'YYYY-MM-DDTHH:mm'      datetime-local, what every picker in this app emits
 *   'YYYY-MM-DD HH:mm:ss'   what the API returns — the pool runs with
 *                           `dateStrings: true` + `timezone: '+05:30'`, so a
 *                           DATETIME arrives as an IST wall-clock STRING
 *
 * Anchoring on 'T' alone silently rejected every value off the API and made the
 * derivation a permanent no-op on read-only surfaces. Same `[ T]` separator the
 * backend's WALL_CLOCK_RE accepts (services/time-slot.js).
 *
 * ⚠ A ZONED value is REFUSED, not parsed. '…T09:30:00.000Z' is an instant, not
 * a wall clock: reading 09 out of it would band an IST 3 PM appointment as
 * '9AM to 12PM' — off by five and a half hours, and completely invisible because
 * the answer still looks like a legitimate band. Returning null instead makes
 * every caller's existing "leave the stored slot alone" guard do the right thing.
 */
const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
const ZONED_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function wallClock(dt: unknown): { h: number; mi: number; s: number } | null {
  const raw = String(dt ?? '').trim();
  if (!raw || ZONED_RE.test(raw)) return null;
  const m = WALL_CLOCK_RE.exec(raw);
  if (!m) return null;
  return { h: Number(m[1]), mi: Number(m[2]), s: m[3] === undefined ? 0 : Number(m[3]) };
}

/**
 * The band for a datetime value (picker-local or API wall-clock). `null` when
 * there is no readable time, so callers can leave a stored slot untouched
 * rather than overwriting it with a guess.
 */
export function inferSlotFromTime(dtLocal: string): string | null {
  const p = wallClock(dtLocal);
  return p ? bandForHour(p.h) : null;
}

/**
 * True when a datetime value carries a REAL time-of-day.
 *
 * THE MIDNIGHT SENTINEL. A large tail of rows stores `requested_date_time` at
 * exactly 00:00:00 — that is not "a booking at midnight", it is "no time of day
 * was ever captured" (date-only bookings, legacy imports). `inferSlotFromTime`
 * reports 'After Hours' for those, because it answers "which band contains this
 * hour" and hour 0 genuinely is After Hours. Callers that are about to OVERWRITE
 * or DISPLAY a derived band must gate on this first, or every date-only job
 * silently loses whatever band it holds to a derivation made from a placeholder.
 *
 * Mirrors `hasTimeOfDay` in the backend's services/time-slot.js, which guards
 * the writer-side `resolveTimeSlot` the same way. Keep the two in step.
 */
export function hasTimeOfDay(dtLocal: string): boolean {
  const p = wallClock(dtLocal);
  if (!p) return false;
  return !(p.h === 0 && p.mi === 0 && p.s === 0);
}

/**
 * The band to DISPLAY beside a job's appointment. '' when there is nothing
 * trustworthy to show, so callers can render their own dash / omit the line.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `tbl_job.time_slot` is DERIVED, not authored: it is the band containing
 * `requested_date_time`, and the backend's `resolveTimeSlot` re-derives it on
 * every write. So a stored value that disagrees with the job's own appointment
 * instant is STALE — a band the system will discard the next time anything
 * saves the job. Job #482491 is the recorded case: `requested_date_time` 05:30
 * ('After Hours') stored alongside `time_slot` '3pm to 7pm'. Rendering the
 * column raw put '3pm to 7pm' directly beside "5:30 AM" on five surfaces —
 * a promise the system had already stopped making.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does NOT replace the band with the exact minute. Customer- and ops-facing
 * surfaces commit to a WINDOW, not to "the technician arrives at 5:30" — the
 * band is the promise. The defect was only ever WHICH band. So this returns a
 * band, always; it just refuses to return one the appointment contradicts.
 *
 * ── THE PRECEDENCE ────────────────────────────────────────────────────────
 *
 *   1. A real time-of-day on `requested_date_time` WINS. time_slot is by
 *      definition the band containing it, so a stored label cannot outrank it.
 *   2. Otherwise (date-only booking / the 00:00 midnight sentinel, where
 *      `hasTimeOfDay` is false) the stored label is the ONLY signal on file —
 *      canonicalised for spelling, never invented and never blanked. Genuinely
 *      legacy vocabularies ('Morning 9 to 2') pass through verbatim.
 *
 * This is READ-side only and mirrors the shape of the writer-side gate
 * (`resolveTimeSlot` in the backend's services/time-slot.js) and of
 * `jobDateLabel` in services/whatsapp-conversation.service.js. It is a
 * three-line COMPOSITION of the helpers above rather than new logic — it exists
 * so the five display sites cannot drift from each other the way the raw
 * `job.time_slot` reads did.
 */
export function displaySlot(requestedDateTime: unknown, storedSlot: unknown): string {
  const dt = String(requestedDateTime ?? '');
  if (hasTimeOfDay(dt)) return inferSlotFromTime(dt) ?? '';
  return canonicalSlot(storedSlot);
}
