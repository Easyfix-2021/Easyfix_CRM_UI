'use client';

/*
 * Call Info — landing page for the legacy CRM "Call Info" header button
 * (`onclick="getAllCalldetails();"`). Legacy opened a modal listing the
 * caller's recent inbound/outbound call log, sourced from a call-detail
 * table populated by Exotel/IVR integrations.
 *
 * Migration status: the EasyFix_Backend Exotel integration is preserved
 * behind the `EXOTEL_ENABLED=false` feature flag (per Phase 13). Until
 * that flag flips and a `/api/admin/call-info` endpoint is wired, this
 * page renders a clear placeholder explaining the state — better than
 * the previous behaviour where the button silently dead-ended.
 *
 * When the endpoint comes online, replace the placeholder card with a
 * table reading from `/api/admin/call-info?limit=…&since=…`.
 */

import { Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export default function CallInfoPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Info className="size-6" /> Call Info
        </h1>
        <p className="text-sm text-muted-foreground">
          Inbound + outbound call log for the booking team. Mirrors the
          legacy CRM&apos;s &ldquo;Call Info&rdquo; header button.
        </p>
      </div>

      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-full bg-muted grid place-items-center">
            <Info className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="font-semibold">Call log integration pending</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            The Exotel call-detail feed is paused behind the
            <code className="mx-1 text-xs bg-muted px-1 py-0.5 rounded">EXOTEL_ENABLED</code>
            feature flag in the backend. Once the integration is re-enabled,
            this page will list the most-recent inbound and outbound
            customer calls with timestamps, durations, and outcome notes,
            matching the legacy CRM modal exactly.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
