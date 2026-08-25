/*
 * Shared TS types for the Manage Clients flow.
 *
 * Backed by:
 *   - GET  /admin/clients (list)
 *   - GET  /admin/clients/:id (detail)
 *   - POST /admin/clients
 *   - PUT  /admin/clients/:id
 *   - GET  /admin/clients/:clientId/contacts
 *   - POST /admin/clients/:clientId/contacts
 *   - PUT  /admin/clients/contacts/:id
 *   - DELETE /admin/clients/contacts/:id
 *   - GET  /admin/clients/:clientId/billing
 *   - POST /admin/clients/:clientId/billing
 *   - PUT  /admin/clients/billing/:id
 *   - DELETE /admin/clients/billing/:id
 *   - GET  /admin/clients/:clientId/custom-properties
 *   - POST /admin/clients/:clientId/custom-properties
 *   - PUT  /admin/clients/custom-properties/:id
 *   - DELETE /admin/clients/custom-properties/:id
 *
 * Column names are snake_case (DB shape) — matches what the BE
 * `modernOk` envelope wraps. Form payloads use camelCase per the Joi
 * validators on the server side.
 */

export type ClientSpoc = {
  user_id: number;
  name: string | null;
  user_email: string | null;
};

export type ClientRow = {
  client_id: number;
  client_name: string;
  client_email: string | null;
  client_status: number | null;
  client_type: string | null;
  reference_code: string | null;
  booking_cut_off: number | string | null;
  vertical_id?: number | null;
  collected_by?: number | null;
  /* Joined from tbl_city — added 2026-05-25 for the list page. */
  city_id?: number | null;
  city_name?: string | null;
  /* Internal CRM users assigned to this client via tbl_vertical_mapping
     (user_type=1=Primary, 2=Secondary). Resolved server-side. */
  primary_spoc?: ClientSpoc | null;
  secondary_spoc?: ClientSpoc | null;
  /* Derived server-side via EXISTS on tbl_client_custom_properties
     (auto_process_unconfirmed_order='true', status=1). 1 = magic-link
     job-completion flow enabled for this client. */
  magic_link_enabled?: number | null;
};

/* List response envelope — server returns { items, total } now that
   the list is paginated. */
export type ClientListResponse = {
  items: ClientRow[];
  total: number;
};

// Full client detail — same shape as ClientRow but with the additional
// columns the detail endpoint exposes (insert_date, client_address, etc.).
// Kept as a wide record because the legacy tbl_client has many seldom-used
// columns and surfacing them as a flat record keeps the Overview tab simple.
export type ClientDetail = ClientRow & Record<string, unknown> & {
  client_address?: string | null;
  insert_date?: string | null;
  update_date?: string | null;
  max_orders?: number | null;
  travel_distance?: number | null;
  monthly_revenue?: number | null;
};

export type ClientContact = {
  id: number;
  client_id: number;
  contact_name: string | null;
  contact_email: string | null;
  contact_no: string | null;
  contact_alt_no?: string | null;
  contact_desgn?: string | null;
  manager_id?: number | null;
  status: number;
  /*
   * Portal access, LEFT JOINed from easyfix_client_spoc_access. All optional:
   * a SPOC with no access row is still a valid contact, and on an environment
   * where the 2026-08-20 migration has not run the API omits them entirely.
   *
   * The override flags are TRI-STATE — null means "inherit the role", which is
   * different from false ("revoked from this person specifically").
   */
  spoc_role?: number | null;
  can_view_performance?: number | null;
  can_view_invoicing?: number | null;
  can_approve_estimates?: number | null;
  can_view_all_stores?: number | null;
};

/** One role from GET /admin/clients/contacts/access-roles. */
export type SpocAccessRole = {
  id: number;
  key: string;
  name: string;
  grants: string[];
  allStores: boolean;
  /*
   * True when a row exists in easyfix_client_role_access — i.e. somebody has
   * saved this role from Client Role Access. False means it is still on the
   * default that ships in services/client-access.service.js. The endpoint
   * always sends it; it is optional here only so the local fallback objects
   * the Contacts dialog builds when the catalogue has not loaded stay valid.
   */
  configured?: boolean;
};

/*
 * The whole catalogue response. `surfaces` is the AUTHORITATIVE screen
 * vocabulary (SURFACES in the service) — render it, never a local copy —
 * and `overrides` maps each per-SPOC override column to the surface it
 * controls, so a screen can say which surfaces a single SPOC can be given
 * or denied on top of their role.
 */
export type SpocAccessCatalogue = {
  roles: SpocAccessRole[];
  surfaces: string[];
  overrides: { flag: string; surface: string }[];
};

export type ClientBilling = {
  c_bill_id: number;
  client_id: number;
  c_bill_name: string | null;
  c_bill_address: string | null;
  c_bill_comm_addr: string | null;
  c_bill_city_id: number | null;
  c_bill_pin: string | null;
  c_bill_email: string | null;
  c_bill_freq_type: string | null;
  c_bill_payment_cycle: number | null;
};

// Normalised shape from the BE's GET /custom-properties endpoint —
// matches the shape the Book-New-Call flow consumes.
export type ClientCustomProperty = {
  id?: number; // surfaced by the new BE; older rows may omit
  name: string;
  label: string | null;
  value: string | null;
  mandatory: boolean;
  // Discriminator: true = client-level CONFIG/CONTROL setting (hidden from
  // booking forms + bulk templates); false/absent = per-booking data-entry
  // field. BE returns 0/1 per row on LIST/GET.
  is_config?: boolean;
  raw?: Record<string, unknown>;
};

// Client form payload — camelCase, matches the BE Joi schema for both
// create + edit. Edit is partial; create has clientName as the single
// required field.
export type ClientFormPayload = {
  clientName?: string;
  clientEmail?: string | null;
  clientAddress?: string | null;
  clientStatus?: number;
  clientType?: string | null;
  referenceCode?: string | null;
  bookingCutOff?: number | null;
  maxOrders?: number | null;
  travelDistance?: number | null;
  verticalId?: number | null;
  collectedBy?: number | null;
};

export type ContactFormPayload = {
  contactName: string;
  contactEmail: string;
  contactNo: string;
  contactAltNo?: string | null;
  contactDesgn?: string | null;
  managerId?: number | null;
};

export type BillingFormPayload = {
  name: string;
  address: string;
  commAddr?: string | null;
  cityId: number;
  pin: string;
  email?: string | null;
  frequencyType?: string | null;
  paymentCycle?: number | null;
};

export type CustomPropertyFormPayload = {
  name: string;
  label?: string | null;
  value?: string | null;
  mandatory?: boolean;
  // true → stored 1 (client-level control setting); default false → 0.
  is_config?: boolean;
};

// Static enum for the collected_by code → label mapping (mirrors the
// BE COLLECTED_BY_MAP in services/client.service.js).
export const COLLECTED_BY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Any (Operator Picks)' },
  { value: 1, label: 'Easyfixer' },
  { value: 2, label: 'Easyfix' },
  { value: 3, label: 'Client' },
];

/* ════════════════════════════════════════════════════════════════════════
 * Client Profile page (/clients/[id])
 * ════════════════════════════════════════════════════════════════════════ */

/*
 * The left-rail sections. This union is the SINGLE definition — it used to be
 * copy-pasted into both clients/page.tsx and RowActionsMenu.tsx, which meant a
 * new section had to be added twice or the deep-link menu silently stopped
 * type-checking against the page it opens.
 *
 * The key is also the `?tab=` URL value, so renaming one breaks existing
 * bookmarks. Add rather than rename.
 *
 * Two sections are COMPOSITES of what used to be separate modal tabs, because
 * the profile design has thirteen rail items and the CRM had nine:
 *   roles     = SPOC access roles + the vertical/staff assignment grid
 *               (the old 'verticals' tab)
 *   services  = the client's service catalogue + technician mapping
 *               (the old 'tech-mapping' tab)
 * Nothing was dropped; 'verticals' and 'tech-mapping' remain valid aliases so
 * older deep links still land somewhere sensible.
 */
export type ClientTab =
  | 'overview'
  | 'roles'
  | 'contacts'
  | 'branches'
  | 'channels'
  | 'billing'
  | 'account'
  | 'services'
  | 'rate-cards'
  | 'sla'
  | 'notifications'
  | 'reports'
  | 'props';

/*
 * Rail order + labels. Title Case per the CRM label convention (the design
 * comp uses sentence case for field labels, but every other tab strip, button
 * and page title in this app is Title Case and consistency wins over one comp).
 */
export const CLIENT_TAB_LIST: ReadonlyArray<{ key: ClientTab; label: string }> = [
  { key: 'overview',      label: 'Overview' },
  { key: 'roles',         label: 'Roles & Actions' },
  { key: 'contacts',      label: 'Contacts' },
  { key: 'branches',      label: 'Branches' },
  { key: 'channels',      label: 'Booking Channels' },
  { key: 'billing',       label: 'Billing & Estimates' },
  { key: 'account',       label: 'Account & Payment' },
  { key: 'services',      label: 'Services' },
  { key: 'rate-cards',    label: 'Rate Cards' },
  { key: 'sla',           label: 'SLA & Priorities' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'reports',       label: 'Reports' },
  { key: 'props',         label: 'Custom Properties' },
];

/** Deep-link aliases kept alive from the pre-profile modal tab names. */
export const CLIENT_TAB_ALIASES: Record<string, ClientTab> = {
  verticals: 'roles',
  'tech-mapping': 'services',
  documents: 'overview',      // the document checklist lives in Overview now
  'custom-properties': 'props',
};

export function resolveClientTab(raw: string | null | undefined): ClientTab {
  if (!raw) return 'overview';
  if (CLIENT_TAB_ALIASES[raw]) return CLIENT_TAB_ALIASES[raw];
  return (CLIENT_TAB_LIST.some((t) => t.key === raw) ? raw : 'overview') as ClientTab;
}

/** GET /admin/clients/:id/summary — the headline strip. */
export type ClientSummary = {
  clientId: number;
  /* null when tbl_client_invoice is not provisioned — "unknown", not zero. */
  invoices: { billed: number; collected: number; outstanding: number; invoices: number } | null;
  outstanding: number | null;
  openOrders: number;
  completedOrders: number;
  totalOrders: number;
  pendingClientQc: number;
};

/** GET /admin/clients/:id/stores — the branch directory. */
export type ClientStore = {
  id: number;
  store_code: string | null;
  store_name: string | null;
  contact_name: string | null;
  contact_no: string | null;
  address: string | null;
  city_id: number | null;
  city_name: string | null;
  pin_code: string | null;
  status: number | null;
};

/** GET /admin/clients/:id/targets — contracted performance targets. */
export type ClientTargets = {
  sla_pct: number;
  ftfr_pct: number;
  revisit_pct: number;
  avg_age_days: number;
  approval_response_hours: number;
  /* 'contracted' = a row exists for this client. 'platform-default' = nobody
     has configured one and the platform figures are standing in. The UI MUST
     distinguish them; a default rendered as a commitment is a lie. */
  source: 'contracted' | 'platform-default';
  directions: Record<string, 'higher' | 'lower'>;
  /*
   * Audit, present ONLY on the admin endpoints. getTargets() takes
   * `{ withAudit }` and defaults to OFF because the client portal shares that
   * function and spreads its result into the tenant-facing /performance
   * response — updated_by is an EasyFix staff id and must not travel there.
   * Optional here for exactly that reason: the portal's shape has no such keys.
   *
   * updatedAt is an IST wall-clock string ("YYYY-MM-DD HH:mm:ss"), passed
   * through verbatim by the service.
   */
  updatedAt?: string | null;
  updatedBy?: { id: number; name: string | null } | null;
};

/*
 * Payment terms live on tbl_client as the legacy "Invoice Details" block.
 * billing_raised is the 0/1 master switch — when it is 0 the legacy DAO NULLs
 * the other three, and the Account & Payment section mirrors that.
 */
export const BILLING_CYCLE_HINT =
  'Comma-separated day numbers, e.g. "1,15". Use 40 for the last day of the month.';

/*
 * paid_by / collected_by share the legacy code space (1=Easyfixer, 2=Easyfix,
 * 3=Client), so "Paid By" reuses COLLECTED_BY_OPTIONS.
 */
export const PAID_BY_OPTIONS = COLLECTED_BY_OPTIONS;
