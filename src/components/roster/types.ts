/*
 * Team Roster — shared TS types mirroring the API contract exactly
 * (scratchpad/roster-api-contract.md). The backend is being built in
 * parallel; keep this file in lockstep with the contract, not with
 * whatever the mock/dev backend happens to return.
 *
 * Day codes: 'PR' = Present, 'WO' = Week Off. Weekday index 0 = Monday
 * … 6 = Sunday. Dates are plain calendar strings 'YYYY-MM-DD' (IST) —
 * see roster-dates.ts for the UTC-safe string helpers that parse them.
 */

/*
 * 'LV' / 'SL' (Employee Hub leave, 2026-09-30) only ever appear on a cell for
 * an APPROVED FULL-day leave — the day is then LOCKED (see `locked` below).
 * A half-day or a PENDING leave of any duration keeps the planned 'PR'/'WO'
 * type and rides in `leave` instead — see leave-contract.md §Roster changes.
 */
export type DayType = 'PR' | 'WO' | 'LV' | 'SL';
export type CellSource = 'ROSTER' | 'WEEKLY' | 'LEAVE';

export type RosterDayCell = {
  type: DayType;
  shift: string | null;
  source: CellSource;
  /** true only for an APPROVED full-day leave — the cell is not editable (grid, fill-pattern, bulk, reset all skip it; a direct PUT 409s). */
  locked?: true;
  /** Riding leave for this day: pending (any duration) or an approved half day. Absent/null otherwise. */
  leave?: { id: number; kind: 'LV' | 'SL'; duration: 'FULL' | 'FIRST_HALF' | 'SECOND_HALF'; status: 'PENDING' | 'APPROVED' } | null;
};

export type RosterHoliday = { date: string; name: string };
export type RosterManager = { userId: number; name: string };

export type RosterMember = {
  userId: number;
  name: string;
  /** Null for most users (69 of 71 on QA) — never render "()" or a dangling " · ". */
  empCode: string | null;
  roleName: string;
  editable: boolean;
  defaultShift: string | null;
  days: Record<string, RosterDayCell>;
};

export type RosterWindow = { today: string; editFrom: string; editTo: string };

export type RosterResponse = {
  window: RosterWindow;
  dates: string[];
  holidays: RosterHoliday[];
  managers: RosterManager[];
  members: RosterMember[];
  headcount: Record<string, { onDuty: number; total: number }>;
};

/** One dirty (uncommitted) grid edit — the shape PUT /admin/roster/cells expects. */
export type RosterCellInput = {
  userId: number;
  date: string;
  dayType: DayType;
  shiftStart?: string | null;
};

export type SaveCellsResponse = { saved: number; changed: number };

export type FillPatternBody = {
  userIds: number[];
  from: string;
  to: string;
  weekOffDays: number[];
  shiftStart?: string | null;
  keepManual: boolean;
};
export type FillPatternResult = {
  users: number; cells: number; wo: number; pr: number; keptManual: number;
  /** Days skipped because they carry an APPROVED full-day leave (locked) — Employee Hub leave, 2026-09-30. */
  keptLeave?: number;
};

export type ResetBody = { userIds: number[]; from: string; to: string };
export type ResetResult = { removed: number };

/*
 * v2 contract (scratchpad/roster-v2-contract.md): `changedBy` / `source` /
 * `createdAt` are gone — the parent action row already says who/when. Fetch
 * ONLY when an action's details are opened (never on Logs-tab open), scoped
 * by `actionId`.
 */
export type RosterUpdateLogItem = {
  id: number;
  userId: number;
  userName: string;
  empCode: string | null;
  rosterDate: string | null;
  /** 'day_type' | 'shift_start' | 'pref.monday'..'pref.sunday' | 'pref.working_days' | 'pref.shift' */
  field: string;
  oldValue: string | null;
  newValue: string | null;
};
export type RosterUpdateLogResponse = { items: RosterUpdateLogItem[]; total: number };

/** GET /admin/roster/logs/actions/:id/changes — one entry per roster date (null = weekly-days edits). */
export type RosterActionChangesResponse = {
  items: {
    rosterDate: string | null;
    employees: {
      userId: number;
      userName: string;
      empCode: string | null;
      changes: Pick<RosterUpdateLogItem, 'field' | 'oldValue' | 'newValue'>[];
    }[];
  }[];
  total: number;
};

export type RosterActionLogAction =
  | 'SAVE_GRID' | 'FILL_PATTERN' | 'COPY_MONTH' | 'RESET' | 'NOTIFY' | 'EXPORT' | 'WORKING_DAYS' | 'BULK_UPLOAD';
/*
 * `affectedCells` / `scopeSummary` are gone — use `summary`. `COPY_MONTH` is
 * kept in the union: the endpoint that produced it is removed, but old rows
 * with that action still come back from the log and the FE verb map has to
 * cover them ("Updated", same as SAVE_GRID/FILL_PATTERN).
 */
export type RosterActionLogItem = {
  id: number;
  createdAt: string;
  actorName: string;
  action: RosterActionLogAction;
  summary: string;
  affectedUsers: number;
  statusCode: number;
};
export type RosterActionLogResponse = { items: RosterActionLogItem[]; total: number };
