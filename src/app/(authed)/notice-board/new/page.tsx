'use client';

import { useRouter } from 'next/navigation';
import { ComposeWizard } from '@/components/notice/ComposeWizard';

/*
 * Thin route wrapper — opens the Compose modal on mount. Navigating
 * back to /notice-board on close keeps the URL clean and ensures the
 * list refreshes (the modal's onSave path also invalidates the list
 * cache, so this is belt-and-braces).
 *
 * The dialog is the single source of truth for compose UX; this page
 * exists so that direct links to /notice-board/new still work (e.g.
 * external bookmarks, future links from emails).
 */
export default function NewNoticePage() {
  const router = useRouter();
  return (
    <ComposeWizard
      mode="create"
      open
      onClose={() => router.replace('/notice-board')}
    />
  );
}
