'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/*
 * Kept as a redirect so any old bookmarks or legacy links to /easyfixers/new
 * still work. The actual create UI lives in the modal on the list page now.
 */
export default function NewEasyfixerRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/easyfixers?new=1'); }, [router]);
  return <div className="text-sm text-muted-foreground">Opening form…</div>;
}
