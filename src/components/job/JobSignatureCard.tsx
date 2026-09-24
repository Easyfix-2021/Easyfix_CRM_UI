'use client';

/*
 * Customer Signature (V3 Phase 4, spec 4.1/D6). Rendered near the job's
 * images (Images tab) when GET /admin/jobs/:id/signature returns one — a
 * job with a verified start/checkout PIN never collects a signature, so
 * "no signature" is the common, unremarkable case and renders nothing.
 *
 * The stored `svg_path` is technician-submitted MEDIUMTEXT. It is rendered
 * as a REAL <svg><path d=…> element built from sanitised values — never
 * dangerouslySetInnerHTML — and both the path data and the viewBox
 * dimensions are passed through lib/job-extras.ts's allow-list gates first,
 * treating the payload strictly as data. No permission gate: reading a
 * job's own signature needs no more than reading its own images/activity.
 */

import { useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import type { JobSignatureResponse } from '@/lib/api';
import { sanitizeSvgPathData, sanitizeSvgViewBox } from '@/lib/job-extras';

export function JobSignatureCard({ jobId }: { jobId: number }) {
  const { data, loading } = useFetch<JobSignatureResponse>(`/admin/jobs/${jobId}/signature`);
  if (loading || !data) return null;

  const path = sanitizeSvgPathData(data.svg);
  const box = sanitizeSvgViewBox(data.width, data.height);
  if (!path || !box) return null;

  return (
    <div className="mb-3 rounded-lg border bg-card p-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-medium">Customer Signature</div>
        <div className="text-xs text-muted-foreground">Signed {formatDate(data.signedOn)}</div>
      </div>
      {/* bg-card (not bg-white): the stroke below uses currentColor / the
          `text-foreground` token so the signature stays legible against
          whichever surface the active theme resolves this card to. */}
      <div className="flex justify-center rounded border bg-card p-2 text-foreground">
        <svg
          viewBox={`0 0 ${box.width} ${box.height}`}
          width={Math.min(box.width, 320)}
          height={Math.min(box.height, 320 * (box.height / box.width || 1))}
          role="img"
          aria-label="Customer signature"
        >
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
