/*
 * QuickSight — MTD: the shapes GET /api/admin/quicksight/mtd returns.
 *
 * A transcription of EasyFix_Backend services/quicksight/mtd.service.js, not a
 * re-modelling of it: the field names, the nesting and the nulls are the
 * server's. Two of those choices are worth reading before using the types:
 *
 *   `data` INSIDE the response is the page of people (the nested key matches
 *   employee-productivity's response), while `total` / `pageNumber` /
 *   `pageSize` / `totalPages` describe the whole filtered set.
 *
 *   `unattributed` is NOT one of those rows and never appears in `data`. It is
 *   its own field with `userId: null` — the jobs whose client has no Primary
 *   SPOC, or whose SPOC is not a resolvable user. attributed + unattributed
 *   equals totals for every metric, and `reconciled` is the server's own check
 *   that it does; false means the backend logged an error and the numbers on
 *   screen should not be trusted.
 */

import type { DateWindow } from '@/lib/report-window';
import type { MtdSortKey } from './api';

/**
 * The five counts, every one of them a job count.
 *
 * ⚠ `open` and `inProgress` IGNORE the date window — they are a snapshot of
 * what is open RIGHT NOW (the backend reads them with no date filter at all),
 * and `inProgress` is a subset of `open`. The other three are counted inside
 * the window, on the date that defines them: ticket created, checkout, cancel.
 * Anywhere these are rendered, the two snapshot columns must say so, or a
 * reader who changes the dates will file a bug when they do not move.
 */
export type MtdCounts = {
  ticketCreated: number;
  inProgress: number;
  open: number;
  completed: number;
  cancelled: number;
};

/** One named person: the client's Primary SPOC, with their five counts. */
export type MtdPerson = MtdCounts & {
  userId: number;
  name: string;
};

/** The pinned footer line: everything that could not be attributed to a person. */
export type MtdUnattributed = MtdCounts & {
  userId: null;
  /** The backend's own label ('Unattributed') — rendered as sent, never re-worded here. */
  name: string;
};

/** How many job rows each loader read — the status line's honesty check. */
export type MtdJobsRead = {
  ticketCreated: number;
  open: number;
  completed: number;
  cancelled: number;
};

export type MtdMeta = {
  /** ISO instant the counts were read (the cache entry's build time, up to 60s old). */
  readAt: string;
  jobsRead: MtdJobsRead;
  ms: number;
};

export type MtdTableResponse = {
  window: DateWindow;
  /** null, never 0, when the filter is All. */
  scope: { verticalId: number | null; zonalManagerId: number | null };
  sort: { sortBy: MtdSortKey; sortDir: 'asc' | 'desc' };
  /** The PAGE of named people. */
  data: MtdPerson[];
  /** Named people in the whole filtered set — Unattributed is not one of them. */
  total: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
  /* All three are over the WHOLE filtered set on every page, so the tiles need no second request. */
  totals: MtdCounts;
  attributed: MtdCounts;
  unattributed: MtdUnattributed;
  reconciled: boolean;
  meta: MtdMeta;
};
