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
};

// Static enum for the collected_by code → label mapping (mirrors the
// BE COLLECTED_BY_MAP in services/client.service.js).
export const COLLECTED_BY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Any (Operator Picks)' },
  { value: 1, label: 'Easyfixer' },
  { value: 2, label: 'Easyfix' },
  { value: 3, label: 'Client' },
];
