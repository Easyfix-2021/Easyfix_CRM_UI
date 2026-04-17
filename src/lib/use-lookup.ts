'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { SelectOption } from '@/components/ui/select';
import { formatEasyfixerName } from './utils';

/*
 * Cached dropdown data from /api/shared/lookup/*.
 * Session-scoped cache (single module-level Map) — lookups rarely change
 * within a session, and a page-level refetch is always available via refresh().
 */

type City = { city_id: number; city_name: string };
type State = { state_id: number; state_name: string };
type ServiceCategory = { service_catg_id: number; service_catg_name: string };
type ServiceType = { service_type_id: number; service_type_name: string; service_catg_id: number };
type ClientLite = { client_id: number; client_name: string };
type UserLite = { user_id: number; user_name: string; role_name?: string };
type EasyfixerLite = { efr_id: number; efr_name: string; efr_no: string; city_name: string | null; is_technician_verified: boolean };
type Reason = { id: number; reason: string };
type Bank = { id: number; bank_name: string };
type DocumentType = { document_type_id: number; document_name: string };

/*
 * Three-tier cache:
 *   1. in-memory Map     — zero-cost read for the rest of the session
 *   2. sessionStorage    — survives soft/hard browser reload; cleared on tab close
 *   3. in-flight Promise — de-dupes concurrent first-fetches (the real fix for
 *      the saturation bug: two modals mounting in parallel used to each fire
 *      all 10 lookup requests simultaneously, so 20 requests hit the backend
 *      in the same millisecond)
 *
 * A 30-minute TTL on sessionStorage entries keeps long-lived tabs from
 * permanently caching a stale dropdown.
 */
const MEM_CACHE = new Map<string, unknown>();
const INFLIGHT = new Map<string, Promise<unknown>>();
const SS_PREFIX = 'efx-lookup:';
const SS_TTL_MS = 30 * 60 * 1000;

function readSession<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; d: T };
    if (Date.now() - parsed.t > SS_TTL_MS) return null;
    return parsed.d;
  } catch { return null; }
}
function writeSession<T>(key: string, data: T) {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(SS_PREFIX + key, JSON.stringify({ t: Date.now(), d: data })); }
  catch { /* quota — ignore */ }
}

async function fetchOnce<T>(key: string, loader: () => Promise<T>): Promise<T> {
  if (MEM_CACHE.has(key)) return MEM_CACHE.get(key) as T;
  const fromSession = readSession<T>(key);
  if (fromSession != null) { MEM_CACHE.set(key, fromSession); return fromSession; }
  if (INFLIGHT.has(key)) return INFLIGHT.get(key) as Promise<T>;
  const promise = loader().then((data) => {
    MEM_CACHE.set(key, data);
    writeSession(key, data);
    INFLIGHT.delete(key);
    return data;
  }).catch((err) => { INFLIGHT.delete(key); throw err; });
  INFLIGHT.set(key, promise);
  return promise;
}

export function useLookup() {
  const [cities, setCities] = useState<City[]>([]);
  const [states, setStates] = useState<State[]>([]);
  const [serviceCategories, setServiceCategories] = useState<ServiceCategory[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [adminUsers, setAdminUsers] = useState<UserLite[]>([]);
  const [easyfixers, setEasyfixers] = useState<EasyfixerLite[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [cancelReasons, setCancelReasons] = useState<Reason[]>([]);
  const [rescheduleReasons, setRescheduleReasons] = useState<Reason[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);

  useEffect(() => {
    (async () => {
      try { setCities(await fetchOnce('cities', () => api.get<City[]>('/shared/lookup/cities', { limit: 1000 }))); } catch {}
      try { setStates(await fetchOnce('states', () => api.get<State[]>('/shared/lookup/states'))); } catch {}
      try { setServiceCategories(await fetchOnce('svcCat', () => api.get<ServiceCategory[]>('/shared/lookup/service-categories'))); } catch {}
      try { setServiceTypes(await fetchOnce('svcType', () => api.get<ServiceType[]>('/shared/lookup/service-types'))); } catch {}
      try { setClients(await fetchOnce('clients', () => api.get<ClientLite[]>('/shared/lookup/clients', { limit: 500 }))); } catch {}
      try { setAdminUsers(await fetchOnce('admUsers', () => api.get<UserLite[]>('/shared/lookup/users', { roleGroup: 'admin', limit: 500 }))); } catch {}
      try { setEasyfixers(await fetchOnce('efrs', () => api.get<EasyfixerLite[]>('/shared/lookup/easyfixers'))); } catch {}
      try { setBanks(await fetchOnce('banks', () => api.get<Bank[]>('/shared/lookup/banks'))); } catch {}
      try { setCancelReasons(await fetchOnce('cancelR', () => api.get<Reason[]>('/shared/lookup/cancel-reasons'))); } catch {}
      try { setRescheduleReasons(await fetchOnce('reschR', () => api.get<Reason[]>('/shared/lookup/reschedule-reasons'))); } catch {}
      try { setDocumentTypes(await fetchOnce('docT', () => api.get<DocumentType[]>('/shared/lookup/document-types'))); } catch {}
    })();
  }, []);

  return {
    cities, states, serviceCategories, serviceTypes, clients, adminUsers, easyfixers, banks,
    cancelReasons, rescheduleReasons, documentTypes,
    toOpts: {
      cities: cities.map<SelectOption>((c) => ({ value: c.city_id, label: c.city_name })),
      states: states.map<SelectOption>((s) => ({ value: s.state_id, label: s.state_name })),
      serviceCategories: serviceCategories.map<SelectOption>((c) => ({ value: c.service_catg_id, label: c.service_catg_name })),
      serviceTypes: serviceTypes.map<SelectOption>((t) => ({ value: t.service_type_id, label: t.service_type_name })),
      clients: clients.map<SelectOption>((c) => ({ value: c.client_id, label: c.client_name })),
      adminUsers: adminUsers.map<SelectOption>((u) => ({ value: u.user_id, label: `${u.user_name} · ${u.role_name ?? ''}` })),
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

export function clearLookupCache() {
  MEM_CACHE.clear();
  if (typeof window !== 'undefined') {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(SS_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => window.sessionStorage.removeItem(k));
  }
}
