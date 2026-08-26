/*
 * /lms/training-videos → /lms/content (2026-08-26).
 *
 * The video catalogue moved into the first tab of LMS ▸ Content when video
 * stopped being the only kind of course content. This route stays as a
 * REDIRECT rather than being deleted, because bookmarks and copied links to it
 * exist and a 404 would read as "the feature was removed" — which is exactly
 * the wrong conclusion, since nothing about the catalogue changed.
 *
 * A redirect rather than a duplicate page: two live copies of the same table
 * editor is how the two drift, and the sidebar now points only at /lms/content
 * (src/lib/legacy-url-map.ts), so this path is reachable only from history.
 *
 * Deliberately a SERVER component with no 'use client' — `redirect()` resolves
 * during render, so the browser never downloads, mounts, or paints a page just
 * to bounce off it.
 */

import { redirect } from 'next/navigation';

export default function TrainingVideosRedirect(): never {
  redirect('/lms/content');
}
