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

export type DayType = 'PR' | 'WO';
export type CellSource = 'ROSTER' | 'WEEKLY';

export type RosterDayCell = {
  type: DayType;
  shift: string | null;
  source: CellSource;
};

export type RosterHoliday = { date: string; name: string };
export type RosterManager = { userId: number; name: string };

export type RosterMember = {
  userId: number;
  name: string;
  empCode: string;
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
export type FillPatternResult = { users: number; cells: number; wo: number; pr: number; keptManual: number };

export type CopyMonthBody = { userIds: number[]; fromMonth: string; toMonth: string };
export type CopyMonthResult = { users: number; cells: number };

export type ResetBody = { userIds: number[]; from: string; to: string };
export type ResetResult = { removed: number };

export type RosterUpdateLogSource = 'GRID' | 'PATTERN' | 'COPY' | 'RESET' | 'EDIT_USER';
export type RosterUpdateLogItem = {
  id: number;
  createdAt: string;
  userId: number;
  userName: string;
  empCode: string;
  rosterDate: string | null;
  /** 'day_type' | 'shift_start' | 'pref.monday'..'pref.sunday' | 'pref.working_days' | 'pref.shift' */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: number;
  changedByName: string;
  source: RosterUpdateLogSource;
};
export type RosterUpdateLogResponse = { items: RosterUpdateLogItem[]; total: number };

export type RosterActionLogAction = 'SAVE_GRID' | 'FILL_PATTERN' | 'COPY_MONTH' | 'RESET' | 'EXPORT';
export type RosterActionLogItem = {
  id: number;
  createdAt: string;
  action: RosterActionLogAction;
  actorUserId: number;
  actorName: string;
  scopeSummary: string;
  affectedUsers: number;
  affectedCells: number;
  statusCode: number;
};
export type RosterActionLogResponse = { items: RosterActionLogItem[]; total: number };
