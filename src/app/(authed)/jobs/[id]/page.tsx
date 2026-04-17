'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/*
 * Old direct URL for the detail page — kept as a redirect so any bookmarks,
 * webhook payloads, or staff-to-staff links pointing at /jobs/<id> open the
 * new view-modal on the list page.
 */
export default function JobDetailRedirect() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  useEffect(() => {
    if (id && /^\d+$/.test(id)) router.replace(`/jobs?view=${id}`);
    else router.replace('/jobs');
  }, [id, router]);
  return <div className="text-sm text-muted-foreground">Opening job…</div>;
}
