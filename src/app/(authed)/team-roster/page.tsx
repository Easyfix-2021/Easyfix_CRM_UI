'use client';

/*
 * Team Roster — Manage Roster (grid) + Update Log + Action Log.
 *
 * Gate: the isRosterManage action key ONLY — role-based, no email allowlist
 * (owner decision 2026-09-29: if you can see the menu, you can use the page).
 * Redirect only after `me` has settled (never eject a user mid-flight).
 * Tabs copied from admin-actions/webhooks/page.tsx (shared @/components/ui/tabs).
 * See src/components/roster/roster-api-contract usage in RosterGrid /
 * RosterLogs for the backend shape this page is coded against.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { RosterGrid } from '@/components/roster/RosterGrid';
import { RosterLogs } from '@/components/roster/RosterLogs';

export default function TeamRosterPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const canManage = hasAction(me, 'isRosterManage');

  // Fail closed, but only once `me` has settled.
  useEffect(() => {
    if (!meLoading && !canManage) router.replace('/dashboard');
  }, [meLoading, canManage, router]);

  const [tab, setTab] = useState<'manage' | 'logs'>('manage');

  if (meLoading || !canManage) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <CalendarDays className="size-6" /> Team Roster
        </h1>
        <p className="text-sm text-muted-foreground">
          Plan who is present or on a week off, day by day, for your team.
        </p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'manage' | 'logs')}>
        <TabsList>
          <TabsTrigger value="manage">Manage Roster</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="manage"><RosterGrid /></TabsContent>
        {/* One Logs tab: WHAT was done (one row per action — Save Grid, Fill
            From Pattern, Notify…) above WHICH values changed (one row per day
            or Working Days field). Each section pages independently. */}
        <TabsContent value="logs" className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold">Actions</h2>
            <p className="text-xs text-muted-foreground">One row per action, including denied attempts.</p>
            <RosterLogs kind="actions" />
          </section>
          <section>
            <h2 className="text-sm font-semibold">Updates</h2>
            <p className="text-xs text-muted-foreground">One row per changed day or Working Days field.</p>
            <RosterLogs kind="updates" />
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
