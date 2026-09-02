'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
/*
 * `SelectOption` here is an alias of `SearchOption` (same {value, label}
 * shape). The legacy `Select` component is no longer used anywhere
 * in JSX after the 2026-05-14 SearchSelect migration; this type
 * import now points at the canonical search-select definition so we
 * don't carry a phantom dependency on the unused Select component.
 */
import type { SearchOption as SelectOption } from '@/components/ui/search-select';
import { formatEasyfixerName } from './utils';

/*
 * Cached dropdown data from /api/shared/lookup/*.
 * Session-scoped cache (single module-level Map) — lookups rarely change
 * within a session, and a page-level refetch is always available via refresh().
 *
 * The cache itself lives in ./lookup-cache — it is the user-namespacing
 * described there, and it had no test until it was somewhere `tsc`-in-isolation
 * could compile. This file keeps only the React hook, and re-exports the three
 * cache controls below so every existing `@/lib/use-lookup` import still works.
 */
import { fetchOnce, clearLookupCache, invalidateLookup, setLookupIdentity } from './lookup-cache';
export { clearLookupCache, invalidateLookup, setLookupIdentity };

type City = { city_id: number; city_name: string; state_id: number | null };
type State = { state_id: number; state_name: string };
type ServiceCategory = { service_catg_id: number; service_catg_name: string };
type ServiceType = { service_type_id: number; service_type_name: string; service_catg_id: number; display: number };
type ClientLite = { client_id: number; client_name: string; vertical_id: number | null };
type UserLite = { user_id: number; user_name: string; role_name?: string };
type RoleLite = { role_id: number; role_name: string; role_desc: string | null; role_status: number; group: string };
type EasyfixerLite = { efr_id: number; efr_name: string; efr_no: string; city_name: string | null; is_technician_verified: boolean };
type Reason = { id: number; reason: string };
type Bank = { id: number; bank_name: string };
type DocumentType = { document_type_id: number; document_name: string };
type Vertical = { vertical_id: number; vertical_name: string };
type Zone     = { zone_id: number;     zone_name: string };

export function useLookup() {
  const [cities, setCities] = useState<City[]>([]);
  const [states, setStates] = useState<State[]>([]);
  const [serviceCategories, setServiceCategories] = useState<ServiceCategory[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [adminUsers, setAdminUsers] = useState<UserLite[]>([]);
  const [roles, setRoles] = useState<RoleLite[]>([]);
  const [easyfixers, setEasyfixers] = useState<EasyfixerLite[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [cancelReasons, setCancelReasons] = useState<Reason[]>([]);
  const [rescheduleReasons, setRescheduleReasons] = useState<Reason[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [zones,     setZones]     = useState<Zone[]>([]);

  useEffect(() => {
    // Fire all lookups in parallel — they're independent, and fetchOnce
    // already de-dupes per key. Each dropdown renders as soon as its own
    // data lands; one failed lookup never blocks the others.
    // tbl_city has ~11k active rows; a 1000 cap truncated the dropdown mid-alphabet
    // (~"Balwada"). Load the full set — SearchSelect caps how many it RENDERS, so the
    // large option list stays snappy, and AddressPickerWithMap needs every city for
    // its reverse-geocode name→id match. Bump in lockstep with citiesQuery.max().
    fetchOnce('cities', () => api.get<City[]>('/shared/lookup/cities', { limit: 20000 })).then(setCities).catch(() => {});
    fetchOnce('verticals', () => api.get<Vertical[]>('/shared/lookup/verticals')).then(setVerticals).catch(() => {});
    fetchOnce('states', () => api.get<State[]>('/shared/lookup/states')).then(setStates).catch(() => {});
    fetchOnce('zones', () => api.get<Zone[]>('/shared/lookup/zones')).then(setZones).catch(() => {});
    // Many legacy tbl_service_catg rows carry a stray trailing
    // apostrophe ("Electrician Services'"). Strip on load so every
    // consumer (dropdowns, Job-tab labels, reports) sees a clean
    // name — single source of truth.
    fetchOnce('svcCat', () => api.get<ServiceCategory[]>('/shared/lookup/service-categories'))
      .then((raw) => setServiceCategories(raw.map((c) => ({ ...c, service_catg_name: (c.service_catg_name || '').replace(/'+$/u, '').trim() }))))
      .catch(() => {});
    fetchOnce('svcType', () => api.get<ServiceType[]>('/shared/lookup/service-types'))
      .then((raw) => setServiceTypes(raw.map((t) => ({ ...t, service_type_name: (t.service_type_name || '').replace(/'+$/u, '').trim() }))))
      .catch(() => {});
    fetchOnce('clients', () => api.get<ClientLite[]>('/shared/lookup/clients', { limit: 500 })).then(setClients).catch(() => {});
    fetchOnce('admUsers', () => api.get<UserLite[]>('/shared/lookup/users', { roleGroup: 'admin', limit: 500 })).then(setAdminUsers).catch(() => {});
    // Fetch EVERY role (not just admin-group). Some legacy roles aren't
    // classified in role.service.js::ROLE_ID_TO_GROUP, which made them
    // invisible in the Manage Users role dropdown. The picker should
    // show all options and let the backend reject invalid combos at save.
    fetchOnce('roles', () => api.get<RoleLite[]>('/shared/lookup/roles')).then(setRoles).catch(() => {});
    fetchOnce('efrs', () => api.get<EasyfixerLite[]>('/shared/lookup/easyfixers')).then(setEasyfixers).catch(() => {});
    fetchOnce('banks', () => api.get<Bank[]>('/shared/lookup/banks')).then(setBanks).catch(() => {});
    fetchOnce('cancelR', () => api.get<Reason[]>('/shared/lookup/cancel-reasons')).then(setCancelReasons).catch(() => {});
    fetchOnce('reschR', () => api.get<Reason[]>('/shared/lookup/reschedule-reasons')).then(setRescheduleReasons).catch(() => {});
    fetchOnce('docT', () => api.get<DocumentType[]>('/shared/lookup/document-types')).then(setDocumentTypes).catch(() => {});
  }, []);

  return {
    cities, states, serviceCategories, serviceTypes, clients, adminUsers, roles, easyfixers, banks,
    cancelReasons, rescheduleReasons, documentTypes, verticals, zones,
    toOpts: {
      cities: cities.map<SelectOption>((c) => ({ value: c.city_id, label: c.city_name })),
      states: states.map<SelectOption>((s) => ({ value: s.state_id, label: s.state_name })),
      serviceCategories: serviceCategories.map<SelectOption>((c) => ({ value: c.service_catg_id, label: c.service_catg_name })),
      serviceTypes: serviceTypes.map<SelectOption>((t) => ({ value: t.service_type_id, label: t.service_type_name })),
      clients: clients.map<SelectOption>((c) => ({ value: c.client_id, label: c.client_name })),
      verticals: verticals.map<SelectOption>((v) => ({ value: v.vertical_id, label: v.vertical_name })),
      adminUsers: adminUsers.map<SelectOption>((u) => ({ value: u.user_id, label: `${u.user_name} · ${u.role_name ?? ''}` })),
      roles: roles.map<SelectOption>((r) => ({ value: r.role_id, label: r.role_name })),
      // Easyfixer label embeds mobile + city so the SearchSelect typeahead
      // matches on any of them: "Pune", "9810…", or the technician's name.
      // formatEasyfixerName expands the legacy "(T)" prefix → "Trainee · …"
      // so operators can see training status at a glance.
      easyfixers: easyfixers.map<SelectOption>((e) => ({
        value: e.efr_id,
        label: `${formatEasyfixerName(e.efr_name)} · ${e.efr_no}${e.city_name ? ` · ${e.city_name}` : ''}`,
      })),
      banks: banks.map<SelectOption>((b) => ({ value: b.id, label: b.bank_name })),
      cancelReasons: cancelReasons.map<SelectOption>((r) => ({ value: r.id, label: r.reason })),
      rescheduleReasons: rescheduleReasons.map<SelectOption>((r) => ({ value: r.id, label: r.reason })),
      documentTypes: documentTypes.map<SelectOption>((d) => ({ value: d.document_type_id, label: d.document_name })),
    },
  };
}
