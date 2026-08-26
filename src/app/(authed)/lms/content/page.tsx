'use client';

/*
 * LMS ▸ Content — the catalogue of everything a course can be built from.
 *
 * ONE page, THREE tabs, one per content KIND:
 *
 *   Training Videos — legacy `training_videos`, played by the technician app
 *   Assessments     — `lms_assessment` + questions/options, scored server-side
 *   Documents       — `lms_document`, a PPT/PDF in S3, completed by acknowledgement
 *
 * WHY TABS AND NOT SIDEBAR LEAVES. `Sidebar.tsx::buildTree` re-parents
 * grandchildren onto their grandparent — the menu is a hard two-level tree, so
 * "LMS ▸ Content ▸ Documents" is not expressible; a third level would surface
 * as a fourth sibling of Content and the grouping would be a lie. Tabs are also
 * where these belong: an operator assembling a course moves between the kinds
 * constantly, and the sidebar makes that three page loads.
 *
 * MENU IDENTITY. The tbl_menu leaf keeps url = 'lmsVideos' and is RENAMED to
 * "Content" by the 2026-08-26 migration; only URL_MAP repoints (see
 * src/lib/legacy-url-map.ts). Renaming carries every role grant in
 * tbl_role.menu_ids, the menu_action key and the visible-menu allowlist across
 * untouched — a new leaf would need all three seeded again.
 *
 * PERMISSIONS. Every write on all three tabs gates on the SAME `isLmsManage`
 * flag that already governs courses/videos/assign/report; each tab reads it
 * itself. The lists stay readable without it, because "what is a technician
 * being taught" is a fair question for someone who cannot edit the catalogue.
 */

import * as React from 'react';
import { Library } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { VideosTab } from './VideosTab';
import { AssessmentsTab } from './AssessmentsTab';
import { DocumentsTab } from './DocumentsTab';

type TabKey = 'videos' | 'assessments' | 'documents';

export default function LmsContentPage() {
  const [tab, setTab] = React.useState<TabKey>('videos');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Library className="size-6" /> Content
        </h1>
        <p className="text-sm text-muted-foreground">
          Everything a course can be built from — videos to watch, assessments to pass, and documents
          to read. Courses are assembled from these on LMS ▸ Manage Courses.
        </p>
      </div>

      {/*
        Radix Tabs UNMOUNTS the inactive panel, which is the behaviour we want:
        each tab owns its own search/page state and its own list fetch, so
        switching away drops a stale query rather than keeping three lists live.
        The module-level cache in @/lib/hooks means switching back is instant
        anyway.
      */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="videos">Training Videos</TabsTrigger>
          <TabsTrigger value="assessments">Assessments</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>
        <TabsContent value="videos"><VideosTab /></TabsContent>
        <TabsContent value="assessments"><AssessmentsTab /></TabsContent>
        <TabsContent value="documents"><DocumentsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
