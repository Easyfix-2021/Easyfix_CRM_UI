/*
 * Shared types for the Notice Board feature.
 *
 * Mirrors the BE response shapes from EasyFix_Backend/services/notice.service.js
 * + notice-category.service.js + holiday.service.js. Kept in one place so
 * the strip, list, compose wizard and read-receipt logic all type-check
 * against the same source of truth.
 */

export type NoticeSurface = 'crm' | 'client' | 'technician';

export type NoticeStatus = 'draft' | 'scheduled' | 'published' | 'archived';

/* Derived from BE — includes 'expired' (computed) which the raw status
 * column never holds. Used for the All-Notices Status column label. */
export type NoticeEffectiveStatus = NoticeStatus | 'expired';

export type NoticeCategory = {
  category_id: number;
  name: string;
  color: string;                          // hex, e.g. '#16a34a'
  applies_to_surfaces: string;            // CSV: 'crm,client,technician' subset
  sort_order: number;
  is_active: 0 | 1 | boolean;
  created_at?: string;
  updated_at?: string;
};

export type Notice = {
  notice_id: number;
  title: string;
  body: string;
  category_id: number;
  target_surfaces: string;                // CSV
  audience_scope: 'all' | 'city' | 'specific';
  audience_ref_id: number | null;
  action_url: string | null;
  /*
   * Image attachments — two parallel arrays.
   *
   * `image_keys`  — raw stored values (S3 keys like "Notices/1716_abcd"
   *                 when S3 is enabled, or relative URLs like
   *                 "/easydoc/abcd.png" when on the local-disk fallback).
   *                 These are what the FE echoes back to the BE on edit
   *                 to keep the stored row stable across re-saves.
   * `images`      — RESOLVED URLs the FE renders directly. For S3-stored
   *                 keys these are presigned GET URLs valid for ~5 min;
   *                 for local-disk values they're the same string as
   *                 `image_keys`. Use these in <img src=…>.
   *
   * Both arrays are the same length and aligned by index.
   */
  image_keys: string[];
  images: string[];
  is_pinned: 0 | 1 | boolean;
  status: NoticeStatus;
  effective_status: NoticeEffectiveStatus;
  publish_at: string | null;
  expire_at: string | null;
  /*
   * The calendar date this notice is ABOUT (a celebration, a maintenance
   * window) — distinct from publish_at (when it goes live) and expire_at (when
   * it stops showing). NULL/absent = an ordinary notice; a value promotes it
   * into the dashboard's Upcoming Events rail. DATE-only, 'YYYY-MM-DD'.
   * Optional so a pre-migration API response still type-checks.
   */
  event_date?: string | null;
  /* Whether publishing fans a push out to each app. Both only NARROW — the
   * matching surface must still be in target_surfaces. See the Notice Board
   * migration for why push_client cannot deliver yet. */
  push_technician?: boolean | 0 | 1;
  push_client?: boolean | 0 | 1;
  created_by: number;
  reviewed_by: number | null;
  published_by: number | null;
  created_at: string;
  updated_at: string;
  // Decorated by BE listNotices / getNoticeById:
  category_name: string;
  category_color: string;
  created_by_name: string | null;
  read_count?: number;
  reach_estimate?: number;
  read_pct?: number;
  // Decorated by listActiveForSurface:
  is_read?: boolean;
};

export type Holiday = {
  date: string;                            // 'YYYY-MM-DD'
  name: string;
  holiday_type: 'national' | 'regional' | 'restricted';
  description: string | null;
};

export type SurfaceOption = { key: NoticeSurface; label: string };

export const SURFACE_OPTIONS: SurfaceOption[] = [
  { key: 'crm',        label: 'CRM (Internal Staff)' },
  { key: 'client',     label: 'Client Dashboard' },
  { key: 'technician', label: 'Technician App' },
];

/* Helper — split target_surfaces CSV into a typed array. Empty CSV → []. */
export function parseSurfaces(csv: string | null | undefined): NoticeSurface[] {
  if (!csv) return [];
  return csv.split(',')
    .map((s) => s.trim())
    .filter((s): s is NoticeSurface => s === 'crm' || s === 'client' || s === 'technician');
}
