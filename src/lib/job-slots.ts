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
 */
export function slotChoicesFor(currentValue: unknown): SlotChoice[] {
  const base: SlotChoice[] = BOOKING_BANDS.map((b) => ({
    value: b.value, label: b.label, fromH: b.fromH, toH: b.toH,
  }));
  const current = String(currentValue ?? '').trim();
  if (current && !base.some((b) => b.value === current)) {
    // fromH -1 ⇒ selecting it never nudges the time picker (same treatment as
    // 'After Hours'), because we can't know the window a legacy label meant.
    base.push({ value: current, label: current, fromH: -1, toH: -1 });
  }
  return base;
}

/** True when `value` is one of the four bands (i.e. not a legacy string). */
export function isKnownBand(value: unknown): boolean {
  const v = String(value ?? '').trim();
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

/**
 * The band for a datetime-local 'YYYY-MM-DDTHH:mm' value (what every picker in
 * this app emits). `null` when there is no time to band, so callers can leave a
 * stored slot untouched rather than overwriting it with a guess.
 */
export function inferSlotFromTime(dtLocal: string): string | null {
  if (!dtLocal) return null;
  const m = dtLocal.match(/T(\d{2}):/);
  if (!m) return null;
  return bandForHour(Number(m[1]));
}
