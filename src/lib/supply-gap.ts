/*
 * Supply Gap (legacy "Open City") — shared vocabulary for the QuickSight list
 * page and the request dialog, so a status renamed on one cannot miss the other.
 */

import { TONE_SURFACE_CLASSES, type StatusChipTone } from '@/components/ui/StatusChip';

/* tbl_open_city.status — {0 Open, 1 In Progress, 2 Assigned, 3 Cancelled, 4 Completed}. */
export const SUPPLY_STATUS_LABEL: Record<number, string> = {
  0: 'Open',
  1: 'In Progress',
  2: 'Assigned',
  3: 'Cancelled',
  4: 'Completed',
};

/* Status → shared StatusChip tone. The dialog renders <StatusChip>; the list
   page's plain cell reads the same tone's surface classes, so the two agree. */
export const SUPPLY_STATUS_TONE: Record<number, StatusChipTone> = {
  0: 'info',
  1: 'warning',
  2: 'neutral',
  3: 'urgent',
  4: 'success',
};

export const SUPPLY_STATUS_CLASS: Record<number, string> = Object.fromEntries(
  Object.entries(SUPPLY_STATUS_TONE).map(([status, tone]) => [status, TONE_SURFACE_CLASSES[tone]]),
);

/* supply_request_log.action_type — legacy opencity.component.ts statusMap. */
export const SUPPLY_ACTION_LABEL: Record<number, string> = {
  0: 'Opened',
  1: 'Added',
  2: 'Allocated',
  3: 'Cancelled',
  4: 'Completed',
  9: 'Remarks Added',
};

/* request_for — 1 = raised against an existing job, 2 = a city with no supply. */
export type SupplyRequestFor = 1 | 2;

/* GET /admin/quicksight/supply-gap/:id */
export type SupplyGapDetail = {
  id: number;
  clientId: number | null;
  clientName: string | null;
  stateUser: number | null;
  stateUserName: string | null;
  catgId: number | null;
  catgName: string | null;
  pin: number | null;
  cityName: string | null;
  districtName: string | null;
  stateName: string | null;
  comments: string | null;
  referenceId: string | null;
  status: number | null;
  newSupplyNumber: string | null;
  newSupplyName: string | null;
  oldSupplyId: number | null;
  actionDate: string | null;
  actionRemarks: string | null;
  initiatedOn: string | null;
  requestFor: number | null;
  closedOn: string | null;
  closedComments: string | null;
  actionUserName: string | null;
  initiatedByUser: string | null;
  closedByUser: string | null;
  isJobEscalated: number;
  jobStatus: number | null;
};

/* GET /admin/quicksight/supply-gap/:id/history */
export type SupplyGapHistoryEntry = {
  commentId: number;
  comment: string | null;
  actionType: number;
  userName: string | null;
  insertOn: string | null;
  /* "name_mobile" when the entry concerns a technician. */
  txDetails: string | null;
  efrCurrentStatus: string | null;
};

/*
 * GET /admin/quicksight/supply-gap/job/:jobId — three shapes:
 *   - a prefill (referenceId set)
 *   - an open request already exists for the job (id set, comments = message)
 *   - the job is closed / cancelled (only comments set)
 */
export type SupplyGapJobPrefill = {
  id?: number;
  referenceId?: number;
  clientId?: number | null;
  clientName?: string | null;
  pin?: number | null;
  cityName?: string | null;
  districtName?: string | null;
  stateName?: string | null;
  stateUser?: number | null;
  stateUserName?: string | null;
  catgId?: number | null;
  catgName?: string | null;
  jobStatus?: string | null;
  jobAge?: number | null;
  comments?: string | null;
};

/* GET /admin/quicksight/supply-gap/pin/:pin */
export type SupplyGapPinPrefill = {
  pin: number;
  cityId: number | null;
  cityName: string | null;
  districtName: string | null;
  stateName: string | null;
  stateUser: number | null;
  stateUserName: string | null;
};

/* POST / PUT response — side-effect outcomes are reported, not thrown. */
export type SupplyGapSaveResult = {
  id: number;
  ownerTransfer?: { done: boolean; reason?: string | null } | null;
  whatsapp?: { sent: boolean; reason?: string | null } | null;
};

/* One toast line that says what actually happened, not what was asked for. */
export function describeSupplySave(r: SupplyGapSaveResult, verb: 'submitted' | 'updated'): {
  variant: 'success' | 'warning';
  message: string;
} {
  const parts = [`Supply gap request #${r.id} ${verb}`];
  let warn = false;
  if (r.ownerTransfer) {
    if (r.ownerTransfer.done) parts.push('job moved to Zonal Manager');
    else { parts.push('job owner NOT changed'); warn = true; }
  }
  if (r.whatsapp) {
    if (r.whatsapp.sent) parts.push('Zonal Manager notified on WhatsApp');
    else { parts.push('WhatsApp not sent'); warn = true; }
  }
  return { variant: warn ? 'warning' : 'success', message: parts.join(' · ') };
}
