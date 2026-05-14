'use client';

/*
 * Call Info — DEPRECATED page.
 *
 * Superseded 2026-05-14 by the navbar-driven `CallInfoModal`
 * (`src/components/call-info/CallInfoModal.tsx`). The header button
 * on the Dashboard / Manage Jobs now opens the modal in place rather
 * than navigating here.
 *
 * Kept as a thin redirect page so any old bookmarks / shared links
 * pointing to `/admin-actions/call-info` route the user back to the
 * Dashboard and instruct them to open the modal from the header.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Phone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function CallInfoPage() {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Phone className="size-6" /> Call Info
        </h1>
        <p className="text-sm text-muted-foreground">
          The Call Info view has moved into the header button on the
          Dashboard and Manage Jobs pages.
        </p>
      </div>
      <Card>
        <CardContent className="p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Open the <strong>Call Info</strong> button in the page header
            (Dashboard or Manage Jobs). Pick a date range, hit
            <em> Fetch Calls</em>, and the call history will load in a
            table without leaving your current screen.
          </p>
          <Button onClick={() => router.push('/dashboard')}>
            Go to Dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
