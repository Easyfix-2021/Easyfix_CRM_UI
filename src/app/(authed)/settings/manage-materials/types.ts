/*
 * Shared types for Settings → Manage Materials. Mirrors the contract at
 * /admin/materials + /admin/brands — see the shared contract doc this was
 * built against (manage-materials-contract.md) for the authoritative shape.
 */

export type PricingType = 'FIXED' | 'DYNAMIC';

export type MaterialListItem = {
  material_id: number;
  material_name: string;
  description: string | null;
  service_catg_id: number;
  service_catg_name: string;
  uom_id: number | null;
  uom_name: string | null;
  pricing_type: PricingType;
  status: number; // 1 active / 0 inactive
  price_pending: boolean;
  group_count: number;
  brand_names: string[];
  price_min: number | null;
  price_max: number | null;
};
export type MaterialListResponse = { items: MaterialListItem[]; total: number };

export type MaterialDetailBrand = { brand_id: number; brand_name: string; status: number; is_system: number };
export type MaterialDetailStateGroup = { state_price_id: number; price: number; state_ids: number[] };
export type MaterialDetailGroup = {
  group_id: number;
  price: number | null;
  brands: MaterialDetailBrand[];
  states: MaterialDetailStateGroup[];
};
export type MaterialDetail = {
  material_id: number;
  material_name: string;
  description: string | null;
  service_catg_id: number;
  service_catg_name: string;
  uom_id: number | null;
  uom_name: string | null;
  pricing_type: PricingType;
  status: number;
  price_pending: boolean;
  groups: MaterialDetailGroup[];
};

export type BrandListItem = {
  brand_id: number;
  brand_name: string;
  is_system: number;
  status: number;
  used_by: number;
};
export type BrandListResponse = { items: BrandListItem[]; total: number };

export type BrandOption = { brand_id: number; brand_name: string; is_system: number };
export type UomOption = { uom_id: number; uom_name: string };

export type ReferencesResponse = {
  total: number;
  by_type: Array<{ type: string; label: string; count: number }>;
};

export type ReplaceConflict = { material_id: number; material_name: string };

/* Import contract — shared shape for both Materials and Brands (Brands rows
   are a strict subset: row_number, brand_name, outcome, errors). */
export type ImportRow = {
  row_number: number;
  outcome: string;
  errors?: string[];
  [key: string]: unknown;
};
export type MaterialImportSummary = {
  new: number;
  update: number;
  price_pending: number;
  blocked: number;
  brands_to_create: string[];
  can_create_brands: boolean;
};
export type BrandImportSummary = { new: number; exists: number; blocked: number };
export type ImportPreviewResponse<S> = { rows: ImportRow[]; summary: S };
export type ImportCommitResponse<S> = { summary: S };

/* RBAC action keys — verbatim per the contract. */
export const MATERIAL_ACTIONS = [
  'isMaterialView',
  'isMaterialAddNew',
  'isMaterialEdit',
  'isMaterialDeactivate',
  'isMaterialDelete',
  'isMaterialImport',
] as const;
export const BRAND_ACTIONS = [
  'isBrandView',
  'isBrandAddNew',
  'isBrandEdit',
  'isBrandDeactivate',
  'isBrandDelete',
  'isBrandImport',
] as const;
