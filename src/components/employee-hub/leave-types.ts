/*
 * Employee Hub — Leave: shared TS types mirroring the API contract exactly
 * (scratchpad/leave-contract.md, spec docs/superpowers/specs/2026-09-30-employee-hub-leave-design.md).
 * The backend is being built in parallel; keep this file in lockstep with
 * the contract, not with whatever the mock/dev backend happens to return.
 *
 * Dates are plain 'YYYY-MM-DD' calendar strings; datetimes are MySQL
 * 'YYYY-MM-DD HH:mm:ss' (IST, as stored) — render with formatDate()/
 * parseIstDateTime(), never `new Date(str)` directly.
 */

import type { StatusChipTone } from '@/components/ui/StatusChip';
import { formatYmdLabel } from '@/components/roster/roster-dates';

export type LeaveKind = 'LV' | 'SL';
export type LeaveDuration = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'CANCELLED';

/** The leave riding a roster/attendance day — pending (any duration) or an approved half day. */
export type LeaveOnDay = { id: number; kind: LeaveKind; duration: LeaveDuration; status: 'PENDING' | 'APPROVED' };

export type LeaveCalendarDay = {
  date: string;
  /** 'LV'/'SL' only for an APPROVED FULL-day leave — a half-day or pending leave keeps 'PR'. */
  type: 'PR' | 'WO' | 'LV' | 'SL';
  holiday: string | null;
  leave: LeaveOnDay | null;
};

export type LeaveMonthlySummary = {
  totalDays: number;
  elapsed: number;
  plannedPresent: number;
  leaves: number;
  weekOffsAndHolidays: number;
};

export type LeaveRequestRow = {
  id: number;
  kind: LeaveKind;
  fromDate: string;
  toDate: string;
  duration: LeaveDuration;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  endedEarly: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
};

/** GET /admin/leave/requests/past — the caller's own requests that My Requests no longer shows. */
export type LeavePastResponse = { items: LeaveRequestRow[]; total: number };

export type LeaveRules = { lvEarliest: string; slDate: string };

export type LeaveMeResponse = {
  month: string;
  today: string;
  rules: LeaveRules;
  days: LeaveCalendarDay[];
  summary: LeaveMonthlySummary;
  requests: LeaveRequestRow[];
};

export type LeaveApprovalRow = LeaveRequestRow & {
  userId: number;
  userName: string;
  empCode: string | null;
  roleName: string | null;
  canDecide: boolean;
};

export type LeaveApprovalsResponse = { items: LeaveApprovalRow[]; total: number };

export type LeaveAlert = {
  key: string;
  requestId: number;
  kind: 'SL';
  userName: string;
  date: string;
  duration: LeaveDuration;
  reason: string | null;
  createdAt: string;
};
export type LeaveAlertsResponse = { items: LeaveAlert[] };

export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
};

export const LEAVE_DURATION_LABEL: Record<LeaveDuration, string> = {
  FULL: 'Full Day',
  FIRST_HALF: 'First Half',
  SECOND_HALF: 'Second Half',
};

export function leaveKindLabel(kind: LeaveKind): string {
  return kind === 'LV' ? 'Leave' : 'Sick Leave';
}

export const LEAVE_STATUS_TONE: Record<LeaveStatus, StatusChipTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'urgent',
  WITHDRAWN: 'neutral',
  CANCELLED: 'neutral',
};

export function leaveDateRangeLabel(r: { fromDate: string; toDate: string }): string {
  return r.toDate !== r.fromDate ? `${formatYmdLabel(r.fromDate)} – ${formatYmdLabel(r.toDate)}` : formatYmdLabel(r.fromDate);
}
