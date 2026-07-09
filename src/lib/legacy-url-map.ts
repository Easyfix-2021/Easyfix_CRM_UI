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
  // Zone management — single surface at /settings/zones: CRUD + city
  // mapping editor + bulk Excel upload/download. The legacy
  // `easyfixerZones` sub-menu was never seeded in production tbl_menu
  // (audit 2026-06-10) — the URL_MAP entry was removed entirely.
  // Sidebar's default fallback routes unknown slugs to /coming-soon
  // so any in-flight legacy bookmarks still land softly.
  'manageZones':           '/settings/zones',
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
  // Call Analytics (Settings): call-history table + Transcribe metrics + LLM
  // coaching. tbl_menu row seeded with url='callAnalytics' by
  // 2026-07-06-add-call-analysis.sql; page lives at /settings/call-analytics.
  // Without this entry the sidebar link fell through to /coming-soon.
  'callAnalytics':         '/settings/call-analytics',
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
  /*
   * QuickSight Reports (native rebuild) — replaces the legacy Angular
   * EF-QuickSight app + its URL-path-JWT session bridge. Lands on the
   * /quicksight card-grid landing page; each report routes to its native
   * /quicksight/<urlBase> page (urlBase values are canonical — see
   * /tmp/qs/_registry.json). Per-report sidebar visibility + the family
   * `ef-QuickSight` gate are driven by the menu/role seed migration; this
   * map only resolves the tbl_menu.url slug → Next.js route.
   *
   * Two slug families are listed:
   *   (1) canonical urlBase slugs — what the seed migration stores in
   *       tbl_menu.url for the DB-driven sidebar children. These cannot
   *       collide with any existing menu slug.
   *   (2) legacy EF-QuickSight slugs (openOrders / performance / …) —
   *       aliases so in-flight bookmarks / direct navigation of the old
   *       Angular URLs still resolve to the native pages.
   *
   * NOTE on the `vertical` legacy slug: it is intentionally NOT remapped
   * here. The legacy EF-QuickSight Vertical-Orders report and the Settings
   * → Verticals master-data page both used `vertical` in their separate
   * apps; in this unified DB-driven sidebar `vertical` already resolves to
   * /settings/verticals (above) and must keep doing so. The native Vertical
   * Orders report is reachable via its canonical `vertical-orders` slug
   * (the seed migration uses that for the QuickSight child menu).
   */
  'quicksight':             '/quicksight',
  // (1) canonical urlBase slugs — DB-driven sidebar children.
  'open-orders':            '/quicksight/open-orders',
  'client-performance':     '/quicksight/client-performance',
  'vertical-orders':        '/quicksight/vertical-orders',
  'priority-jobs':          '/quicksight/priority-jobs',
  'material-report':        '/quicksight/material-report',
  'city-performance':       '/quicksight/city-performance',
  'technician-performance': '/quicksight/technician-performance',
  'supply-gap':             '/quicksight/supply-gap',
  'employee-productivity':  '/quicksight/employee-productivity',
  'admin-dashboard':        '/quicksight/admin-dashboard',
  // (2) legacy EF-QuickSight slug aliases (bookmarks / old Angular URLs).
  // `vertical` deliberately omitted — see NOTE above (kept as Settings → Verticals).
  'openOrders':             '/quicksight/open-orders',
  'performance':            '/quicksight/client-performance',
  'priorityJobs':           '/quicksight/priority-jobs',
  'materiallist':           '/quicksight/material-report',
  'cityperformance':        '/quicksight/city-performance',
  'txperformance':          '/quicksight/technician-performance',
  'opencity':               '/quicksight/supply-gap',
  'productivity':           '/quicksight/employee-productivity',
  'adminDashboard':         '/quicksight/admin-dashboard',
  'adminAction':            '/admin-actions',
  /*
   * `generateClientInvoice` (2026-06-08): the sidebar entry now lands
   * on plain /admin-actions (was: ?focus=generate-invoice). The auto-
   * open logic on the page still respects the focus param for genuine
   * deep links (e.g. emails / docs), but the menu click no longer
   * triggers the popup unsolicited — operator clicks the "Generate
   * Client Invoice" card on the page when they actually want it.
   */
  'generateClientInvoice':  '/admin-actions',
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
  // EFR ledger filtered by transaction_type. Convention (EasyFix_CRM Finance.java
  // + legacy API DAO + mobile app, all agree): transaction_type=1 → Debit
  // (outgoing, e.g. payout/withdrawal), transaction_type=2 → Credit (incoming,
  // e.g. recharge/earnings). (Fixed 2026-07-09: was inverted here.)
  'easyfixerDebit':         '/finance?tab=efr-ledger&type=1',
  'easyfixerCredit':        '/finance?tab=efr-ledger&type=2',
  'easyfixerAdvance':       '/finance/advances',
  // Payout Requests — finance processor for technician wallet withdrawals.
  // Seeded as a child of the Finance menu (url='payoutRequests') in
  // EasyFix_Backend/migrations/2026-07-09-seed-payout-requests-rbac.sql.
  'payoutRequests':         '/finance/payout-requests',
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
