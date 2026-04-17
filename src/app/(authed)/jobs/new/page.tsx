'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/*
 * Old direct URL for the create form — kept as a redirect so any bookmarks,
 * shared links, or webhooks pointing at /jobs/new still open the new modal.
 */
export default function NewJobRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/jobs?new=1'); }, [router]);
  return <div className="text-sm text-muted-foreground">Opening job form…</div>;
}
