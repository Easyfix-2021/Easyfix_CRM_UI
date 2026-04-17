'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/*
 * Kept as a redirect so any old bookmarks, webhooks, or emails that link to
 * /easyfixers/<id> still resolve. The detail/edit UI lives in the modal on the
 * list page now.
 */
export default function EasyfixerDetailRedirect() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  useEffect(() => {
    if (id && /^\d+$/.test(id)) router.replace(`/easyfixers?view=${id}`);
    else router.replace('/easyfixers');
  }, [id, router]);
  return <div className="text-sm text-muted-foreground">Opening easyfixer…</div>;
}
