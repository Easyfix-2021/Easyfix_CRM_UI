'use client';
/*
 * Activity tab — trainings (LMS link), achievements/rewards/attendance/
 * performance (no endpoints yet → placeholders) and activation/status notes
 * (reuses the verification activation comments thread).
 */
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { SectionCard, EndpointPending, LockedBody } from './ui';
import type { VerificationPayload } from './types';

export function ActivityTab({
  efrId,
  v,
  active,
  onReload,
}: {
  efrId: number;
  v: VerificationPayload;
  active: boolean;
  onReload: () => Promise<void> | void;
}) {
  const addNote = async (text: string) => {
    await api.post(`/admin/easyfixers/${efrId}/verification/comments`, { text, section: 'Technician Activation Section' });
    await onReload();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Trainings" icon={<span>🎓</span>} right={<Button asChild size="sm" variant="outline"><Link href="/lms/assign-training">Assign training</Link></Button>}>
          <EndpointPending what="Per-technician training progress needs an LMS assignment lookup (e.g. GET /admin/lms/assignments?efrId=). Use the Assign training link to reach the LMS module meanwhile." />
        </SectionCard>
        <SectionCard title="Achievements" icon={<span>🏆</span>}>
          {active ? <EndpointPending what="Certificates / trophies / rewards counts need GET /admin/easyfixers/:id/achievements." /> : <LockedBody />}
        </SectionCard>
      </div>

      <SectionCard title="Rewards & points" icon={<span>🎁</span>} right={<span>balance &amp; claimed only</span>}>
        {active ? <EndpointPending what="Points balance + claimed rewards need GET /admin/easyfixers/:id/rewards (the shop & earning rules live in the technician app)." /> : <LockedBody />}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Attendance" icon={<span>🗓️</span>} right={<span>days active / month</span>}>
          {active ? <EndpointPending what="Attendance history needs GET /admin/easyfixers/:id/attendance-history (the roster's POST /attendance only returns today's slots)." /> : <LockedBody />}
        </SectionCard>
        <SectionCard title="Performance" icon={<span>📈</span>}>
          {active ? <EndpointPending what="On-time / same-day / escalations / rating metrics need GET /admin/easyfixers/:id/performance." /> : <LockedBody />}
        </SectionCard>
      </div>

      <SectionCard title="Status change notes" icon={<span>🔁</span>} right={<span>activation / inactivation notes</span>}>
        <CommentsPanel entries={v.activation.comments as CommentEntry[]} onAdd={addNote} addLabel="Add a note" />
      </SectionCard>
    </div>
  );
}
