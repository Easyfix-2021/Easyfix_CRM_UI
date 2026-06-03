/*
 * Legacy URL → Next.js route mapping. Single source of truth shared by:
 *
 *   1. `Sidebar.tsx`        — translates tbl_menu.url values to <Link href>.
 *   2. `middleware.ts`      — reverse-maps hidden legacy URLs (from the BE
 *                             menu-visibility endpoint) to Next.js path
 *                             bases so it can redirect direct navigation
 *                             of WIP flows to /coming-soon.
 *
 * Anything not listed routes (in Sidebar.tsx) to /coming-soon?title=…&legacyPath=…
 *
 * My Orders sub-menus — legacy `dashboardChecking?enumDesc=<value>` URLs.
 * The canonical enumDesc values come from `HomeAction.getJobUIStatus()` in
 * the legacy CRM; each maps to a tab slug in /jobs (and the tab carries the
 * correct status/statuses/assigned filter payload):
 *
 *   UnConfirmed               → /jobs?tab=unconfirmed          (status 9)
 *   PendingForScheduling      → /jobs?tab=pending-scheduling   (status 0, unassigned)
 *   PendingForAcknowledgement → /jobs?tab=pending-app-ack      (status 0, assigned)
 *   NotStarted                → /jobs?tab=pending-start        (status 1)
 *   NotCompleted              → /jobs?tab=pending-close        (statuses 2 OR 20)
 *   PendingFeedback           → /jobs?tab=pending-feedback     (status 3)
 *   PendingForApproval        → /jobs?tab=estimate-pending     (statuses 15 OR 21)
 *   PendingForCheckout        → /jobs?tab=audit-complete       (status 10)
 *
 * Two legacy concepts currently fold onto existing buckets in our status
 * model: (a) "Audit & Complete" has no distinct legacy enumDesc — it's a
 * dashboard-only card that maps to closed-jobs (status 3+5); (b) "Orders in
 * Followup" maps to `PendingForCheckout` in legacy, which is our status 10
 * — same row as Pending for Feedback in our schema today. If a distinct
 * followup flag lands later, split these URL_MAP entries.
 */
export const URL_MAP: Record<string, string> = {
  'home':                  '/dashboard',
  // Notice Board — broadcast-messages management surface added 2026-05-22.
  // Tbl_menu row seeded with url='noticeBoard'; the page lives at
  // /notice-board and gates Compose/Publish/Archive on isNoticeManage.
  'noticeBoard':           '/notice-board',
  'job':                   '/jobs',
  'uploadJobByExcel':      '/jobs/upload',
  // Distinct ?focus param so isRouteActive() can tell Manage Jobs and
  // Change Job Owner apart — both target /jobs, and without a discriminator
  // the sidebar lit up both rows when the user was on plain /jobs. Same
  // pattern as Reports/Tracking sub-menus. The /jobs page may or may not
  // consume `focus=change-owner` to scroll/highlight the action.
  'changeJobOwner':        '/jobs?focus=change-owner',
  'callLater':             '/jobs?tab=call-later',
  // Legacy `androidAppJob` (App Job) calls SP sp_ef_app_job_list which
  // returns the same 5-bucket per-user dashboard our `/my-orders` page
  // already shows (PendingForScheduling, NotStarted, NotCompleted,
  // PendingForCheckout, PendingFeedback). Aliasing to /my-orders
  // avoids duplicating the same view at a different URL.
  'androidAppJob':         '/my-orders',
  // Top-level master-data pages that ALREADY exist in the new app
  // — sidebar links were silently falling through to /coming-soon
  // because URL_MAP didn't include these legacy `tbl_menu.url` keys.
  'customer':              '/customers',
  'client':                '/clients',
  'easyfixer':             '/easyfixers',
  // Search-by-mobile / efr_no / name. Used by call-flow staff.
  'checkBalance':          '/search',
  // Onboarding queue — EasyFixers awaiting technician verification.
  'efer-registration':     '/easyfixers/registrations',
  // Zone management lives in TWO places (intentional split):
  //   - /settings/zones        — full management surface: CRUD + city
  //                              mapping editor + bulk Excel upload/download.
  //                              `manageZones` (the new sidebar entry under
  //                              Settings) routes here.
  //   - /easyfixers/zones      — read-only "browse zones from EasyFixers
  //                              context" view. The legacy CRM seeded its
  //                              tbl_menu row with url='easyfixerZones' so we
  //                              keep that key for backwards compatibility.
  'manageZones':           '/settings/zones',
  'easyfixerZones':        '/easyfixers/zones',
  // Pincode master under Settings: CRUD + bulk Excel upload. Status
  // (Local/Travel) is computed from active-tech availability — no
  // status column to maintain.
  'managePincodes':        '/settings/pincodes',
  // City master under Settings: CRUD with state/district + status flag.
  // Counts (zones / pincodes / technicians) are computed at read time
  // from the related tables so the totals always match downstream truth.
  'manageCities':          '/settings/cities',
  // Legacy CRM seeded a coming-soon stub with url='city' — the migration
  // 2026_05_01_add_settings_manage_cities_menu.sql retires that row, but
  // an alias here keeps any in-flight bookmarks resolving cleanly.
  'city':                  '/settings/cities',
  'deepSkillTable':        '/settings/deep-skills',
  'manageAutoAllocations': '/settings/auto-allocation',
  // Manage Users (legacy `user`): internal CRM staff. Lives under Settings in
  // the new UI even though the legacy CRM had it at the top-level — keeps the
  // new sidebar focused on the operational verbs (Jobs, My Orders, …) and
  // shoves the master-data verbs into Settings consistently.
  'user':                  '/settings/manage-users',
  // Manage Roles (legacy `usertype`): tbl_role rows + group classification.
  'usertype':              '/settings/manage-roles',
  // Master-data settings ported from legacy CRM.
  'servicecategory':       '/settings/service-categories',
  'servicetype':           '/settings/service-types',
  'documentType':          '/settings/document-types',
  'skill':                 '/settings/skill-levels',
  'tool':                  '/settings/tools',
  'questionaire':          '/settings/questionnaires',
  'questionnaires':        '/settings/questionnaires',
  'vertical':              '/settings/verticals',
  'clientratecard':        '/settings/rate-cards-b2b',
  'retailratecard':        '/settings/rate-cards-b2c',
  // Reports + Tracking + Admin landing pages.
  // Every Report/Tracking sub-menu lands on the same /reports or /tracking
  // page, but each gets a unique `?focus=` so isRouteActive can identify
  // which sub-menu was clicked (otherwise all siblings light up
  // simultaneously). The destination page may or may not consume `focus`
  // to scroll/highlight a section — sidebar correctness doesn't require it.
  'reports':                '/reports',
  'completedJobs':          '/reports?focus=completed-jobs',
  'completedJobsReport':    '/reports?focus=completed-jobs',
  'easyfixerReport':        '/reports?focus=efr',
  'manageEfrReport':        '/reports?focus=efr',
  'payoutSheet':            '/reports?focus=payout',
  'cityAnalysis':           '/reports?focus=city',
  'userProductivity':       '/reports?focus=user-productivity',
  'userHours':              '/reports?focus=user-hours',
  'userLoggingHours':       '/reports?focus=user-hours',
  'manageFinanceReport':    '/reports?focus=finance',
  'manageEscalationReport': '/reports?focus=escalation',
  'tracking':               '/tracking',
  'jobTracking':            '/tracking?focus=jobs',
  'clientTracking':         '/tracking?focus=clients',
  'adminAction':            '/admin-actions',
  'generateClientInvoice':  '/admin-actions?focus=generate-invoice',
  'webhook':                '/admin-actions/webhooks',
  'webhookManager':         '/admin-actions/webhooks',
  // Finance sub-resources — Finance landing page links to these
  'clientInvoice':          '/finance?tab=invoices',
  'servicemenPayout':       '/finance?tab=payouts',
  'ndmCollection':          '/finance?tab=ndm-collection',
  // Legacy `updateRecharge` ("Collection Approval") is the finance-side
  // approval queue for NDM recharges submitted by node managers.
  // Lands on the same NDM tab but with the pending-approval filter
  // pre-selected (flag=4 mirrors legacy submitToFinanceList(0)).
  'updateRecharge':         '/finance?tab=ndm-collection&flag=4',
  // EFR ledger filtered by transaction_type. Legacy convention:
  //   transaction_type=1 → Credit (incoming, e.g. recharge)
  //   transaction_type=2 → Debit  (outgoing, e.g. job payout)
  'easyfixerDebit':         '/finance?tab=efr-ledger&type=2',
  'easyfixerCredit':        '/finance?tab=efr-ledger&type=1',
  'easyfixerAdvance':       '/finance/advances',
  // My Orders sub-menus (legacy CRM): each tbl_menu row's `url` is the full
  // `dashboardChecking?enumDesc=<value>` string, so these keys match verbatim.
  // Targets point at the distinct /my-orders route — that page scopes the
  // list automatically (role-aware: admin sees all, others see own) without
  // leaking a scope pill into /jobs.
  'dashboardChecking?enumDesc=UnConfirmed':               '/my-orders?tab=unconfirmed',
  'dashboardChecking?enumDesc=PendingForScheduling':      '/my-orders?tab=pending-scheduling',
  'dashboardChecking?enumDesc=PendingForAcknowledgement': '/my-orders?tab=pending-app-ack',
  'dashboardChecking?enumDesc=NotStarted':                '/my-orders?tab=pending-start',
  'dashboardChecking?enumDesc=NotCompleted':              '/my-orders?tab=pending-close',
  'dashboardChecking?enumDesc=PendingFeedback':           '/my-orders?tab=pending-feedback',
  'dashboardChecking?enumDesc=PendingForApproval':        '/my-orders?tab=estimate-pending',
  'dashboardChecking?enumDesc=PendingForCheckout':        '/my-orders?tab=audit-complete',
};

/*
 * Resolve a legacy `tbl_menu.url` slug to its Next.js base path (no query
 * string). Used by the middleware to match `req.nextUrl.pathname` against
 * the set of hidden flows — middleware only sees the path, not the query.
 *
 * Returns null for `null`, `''`, `'javascript:;'` (parent-only placeholder),
 * and any slug that's not in URL_MAP (unknown menus already route to
 * /coming-soon via Sidebar's default fallback, so middleware-side guarding
 * is unnecessary for those).
 */
export function legacyUrlToNextPath(legacy: string | null | undefined): string | null {
  if (!legacy || legacy === 'javascript:;') return null;
  const mapped = URL_MAP[legacy];
  if (!mapped) return null;
  const qIndex = mapped.indexOf('?');
  return qIndex >= 0 ? mapped.slice(0, qIndex) : mapped;
}
