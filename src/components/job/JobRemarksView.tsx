'use client';

import { useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import type { JobComment } from './jobTypes';

/*
 * Read-only "Remarks / Comments" panel — the job's tbl_job_comment thread
 * (GET /admin/jobs/:id/comments) rendered as a compact 4-column table
 * (Date/Time · Remarks · By · Reason). No add form. Dropped into the bottom of
 * the Confirm & Schedule and Schedule & Assign modals so ops can see the
 * existing remarks history without leaving the modal.
 */
export function JobRemarksView({ jobId }: { jobId: number | null }) {
  const { data, loading } = useFetch<JobComment[]>(
    jobId ? `/admin/jobs/${jobId}/comments` : null,
    { enabled: !!jobId },
  );
  const rows = data ?? [];

  return (
    <div className="rounded-md border bg-muted/30">
      <div className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Remarks / Comments
      </div>
      <div className="max-h-48 overflow-y-auto">
        {loading && <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="px-3 py-3 text-sm text-muted-foreground">No remarks yet.</div>
        )}
        {!loading && rows.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Date / Time</th>
                <th className="px-3 py-1.5 font-medium">Remarks</th>
                <th className="px-3 py-1.5 font-medium">By</th>
                <th className="px-3 py-1.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{formatDate(c.created_on)}</td>
                  <td className="px-3 py-1.5">{c.comments || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{c.user_name || <span className="text-muted-foreground">Customer</span>}</td>
                  <td className="px-3 py-1.5">{c.enum_desc || <span className="text-muted-foreground">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
