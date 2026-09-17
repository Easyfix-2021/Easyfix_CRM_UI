'use client';
/*
 * Team tab — shown only when the technician leads a team (ef_account = Master).
 * There is no team-roster endpoint yet, so the member list is a placeholder.
 */
import { SectionCard, EndpointPending } from './ui';

export function TeamTab() {
  return (
    <SectionCard title="My team" icon={<span>👥</span>}>
      <EndpointPending what="Team members (name, jobs, rating, rework, contributed earnings) for a master technician need GET /admin/easyfixers/:id/team. Not available today." />
    </SectionCard>
  );
}
