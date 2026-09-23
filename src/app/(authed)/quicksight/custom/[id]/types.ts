/*
 * Custom (Dynamic) Reports — shared wire types.
 *
 * Verbatim mirror of the BE contract (dynamic-reports-api.md). Co-located
 * under [id]/ because every consumer that needs them (this page, its
 * ReportDataTable / ReportChart / UploadDialog siblings, AND the public
 * read-only page at app/public/report/[token]) lives at or under this
 * route — no separate top-level types module.
 */

export type ColType = 'text' | 'number' | 'date';
export type Column = { key: string; name: string; type: ColType };
export type Chart = { type: 'bar' | 'line' | 'pie'; x: string; y: string[]; agg: 'sum' | 'count' | 'avg' };

export type Upload = {
  id: number;
  mode: 'replace' | 'append';
  rowCount: number;
  addedRows: number;
  originalName: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: number;
  uploadedByName: string | null;
  isCurrent: boolean;
};

export type ReportDetail = {
  id: number;
  name: string;
  columns: Column[];
  chart: Chart | null;
  roleIds: number[];
  ownerId: number;
  ownerName: string | null;
  shareToken: string | null;
  canEdit: boolean;
  /* Owner or an operator on the BE email allowlist — never a role. */
  canTransferOwner: boolean;
  isAdmin: boolean;
  columnsChanged: boolean;
  current: Upload | null;
  uploads: Upload[];
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
};

export type RowsResponse = {
  uploadId: number | null;
  columns: Column[];
  rows: Array<Record<string, string | number | null>>;
  total: number;
  page: number;
  pageSize: number;
};

export type ChartResponse = {
  chart: Chart | null;
  series: Array<{ key: string; name: string }>;
  points: Array<{ x: string; [seriesKey: string]: string | number }>;
};

/* Public (no-auth) share-link payload — same shape minus uploadedBy fields on `current`. */
export type PublicReportDetail = {
  name: string;
  columns: Column[];
  chart: Chart | null;
  current: Omit<Upload, 'uploadedBy' | 'uploadedByName'> | null;
  retentionDays: number;
};

export const RETENTION_NOTE =
  'Uploaded data is kept for 30 days. Older uploads are deleted automatically — the current upload is always kept. '
  + 'Download any version you need to keep longer.';

export const PUBLIC_LINK_CAPTION = "Anyone with this link can view and download — role restrictions don't apply.";
