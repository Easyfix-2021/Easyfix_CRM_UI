'use client';

import { useParams, useRouter } from 'next/navigation';
import { ComposeWizard } from '@/components/notice/ComposeWizard';

/*
 * Thin route wrapper for /notice-board/<id> — opens the Compose
 * modal in Edit mode on mount, navigates back to /notice-board on
 * close. Mirrors /notice-board/new — the actual UX lives entirely
 * inside the dialog.
 */
export default function EditNoticePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  if (!id || Number.isNaN(id)) {
    return <div className="p-8 text-sm text-muted-foreground">Invalid notice id</div>;
  }
  return (
    <ComposeWizard
      mode="edit"
      noticeId={id}
      open
      onClose={() => router.replace('/notice-board')}
    />
  );
}
