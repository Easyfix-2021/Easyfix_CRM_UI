'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { SelectOption } from '@/components/ui/select';

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
type Reason = { id: number; reason: string };
type Bank = { id: number; bank_name: string };
type DocumentType = { document_type_id: number; document_name: string };

const cache = new Map<string, unknown>();

async function fetchOnce<T>(key: string, loader: () => Promise<T>): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  const data = await loader();
  cache.set(key, data);
  return data;
}

export function useLookup() {
  const [cities, setCities] = useState<City[]>([]);
  const [states, setStates] = useState<State[]>([]);
  const [serviceCategories, setServiceCategories] = useState<ServiceCategory[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [adminUsers, setAdminUsers] = useState<UserLite[]>([]);
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
      try { setBanks(await fetchOnce('banks', () => api.get<Bank[]>('/shared/lookup/banks'))); } catch {}
      try { setCancelReasons(await fetchOnce('cancelR', () => api.get<Reason[]>('/shared/lookup/cancel-reasons'))); } catch {}
      try { setRescheduleReasons(await fetchOnce('reschR', () => api.get<Reason[]>('/shared/lookup/reschedule-reasons'))); } catch {}
      try { setDocumentTypes(await fetchOnce('docT', () => api.get<DocumentType[]>('/shared/lookup/document-types'))); } catch {}
    })();
  }, []);

  return {
    cities, states, serviceCategories, serviceTypes, clients, adminUsers, banks,
    cancelReasons, rescheduleReasons, documentTypes,
    toOpts: {
      cities: cities.map<SelectOption>((c) => ({ value: c.city_id, label: c.city_name })),
      states: states.map<SelectOption>((s) => ({ value: s.state_id, label: s.state_name })),
      serviceCategories: serviceCategories.map<SelectOption>((c) => ({ value: c.service_catg_id, label: c.service_catg_name })),
      serviceTypes: serviceTypes.map<SelectOption>((t) => ({ value: t.service_type_id, label: t.service_type_name })),
      clients: clients.map<SelectOption>((c) => ({ value: c.client_id, label: c.client_name })),
      adminUsers: adminUsers.map<SelectOption>((u) => ({ value: u.user_id, label: `${u.user_name} · ${u.role_name ?? ''}` })),
      banks: banks.map<SelectOption>((b) => ({ value: b.id, label: b.bank_name })),
      cancelReasons: cancelReasons.map<SelectOption>((r) => ({ value: r.id, label: r.reason })),
      rescheduleReasons: rescheduleReasons.map<SelectOption>((r) => ({ value: r.id, label: r.reason })),
      documentTypes: documentTypes.map<SelectOption>((d) => ({ value: d.document_type_id, label: d.document_name })),
    },
  };
}

export function clearLookupCache() { cache.clear(); }
