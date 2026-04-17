'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

/*
 * Single source of truth for "page stub while we migrate" — used on every
 * menu item that exists in legacy tbl_menu but doesn't yet have a migrated
 * UI in this app. Standardised look + messaging means operators recognise
 * it instantly and don't waste time thinking "is this a 404 or a WIP?".
 */
export function ComingSoon({
  title, blurb, legacyPath,
}: {
  title: string;
  blurb?: string;
  /** Legacy CRM URL this screen corresponds to — shown as a hint only. */
  legacyPath?: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {blurb && <p className="text-sm text-muted-foreground">{blurb}</p>}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Coming soon
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            This page hasn&apos;t been migrated from legacy EasyFix CRM yet. It&apos;s on
            the roadmap — the menu link is live so the navigation structure
            matches legacy, and the page will light up when the feature lands.
          </p>
          {legacyPath && (
            <p className="text-xs">
              Legacy path: <code className="rounded bg-muted px-1">{legacyPath}</code>
            </p>
          )}
          <div className="pt-2">
            <Link href="/dashboard" className="inline-flex items-center gap-1 text-primary hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Home
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
