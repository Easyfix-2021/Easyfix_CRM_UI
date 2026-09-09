'use client';

/*
 * JobModalHost — mounts the JobModal for in-place <JobRefLink>s on a page.
 *
 * Mount ONCE per page that uses default (in-place) <JobRefLink> (from
 * ./JobRefLink). It renders JobModal driven by the URL (?jobId=&action=), so
 * closing strips those params and returns to this page — and ?jobId=&action=view
 * becomes a shareable deep link into it. `onSaved` fires after a modal save
 * (reports are read-only, so it's usually omitted).
 *
 * Kept in its OWN module (apart from JobRefLink) on purpose: JobModal is heavy
 * (~200 kB), so only pages that actually open the modal in place bundle it.
 * new-tab-only reports import just JobRefLink and stay light.
 */

import { useSearchParams } from 'next/navigation';

import { JobModal } from '@/components/job/JobModal';
import { useJobActionParams, useJobActionNav, isJobModalAction } from '@/lib/job-action-url';

export function JobModalHost({ onSaved }: { onSaved?: () => void }) {
  const { jobId, action } = useJobActionParams();
  const { closeJobAction } = useJobActionNav();
  const viewTab = useSearchParams().get('viewTab') || undefined;

  /*
   * assign / reassign / schedule are SEPARATE modals on /jobs, so the host
   * ignores them (a page that needs those mounts its own) — isJobModalAction is
   * the single allow-list, shared with both list pages.
   */
  const supported = isJobModalAction(action);
  // `create` is the only supported action valid without a jobId.
  const open = supported && (action === 'create' || jobId != null);

  return (
    <JobModal
      open={open}
      mode={supported ? action : 'view'}
      jobId={jobId ?? undefined}
      onClose={closeJobAction}
      onSaved={onSaved}
      initialTab={viewTab}
    />
  );
}
