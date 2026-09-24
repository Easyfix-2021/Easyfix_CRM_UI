/*
 * Pure helpers for the "material-brand pair" model behind the client Rate
 * Cards > Materials add flow (2026-09-24 tx_share redesign): a pair is
 * (material_id, brand_id | null for "No Brand"). GET /admin/clients/:id/
 * material-rates/master-rows returns one row per pair with the master price
 * — AddClientMaterialsDialog must hide any pair already present on the
 * client's card (across ALL of that client's existing groups).
 *
 * Kept dependency-free (no import of the real ClientMaterialRateItem /
 * MasterMaterialRateRow types) so it compiles standalone under the
 * `test:build` raw-tsc invocation (see package.json) — the local shapes
 * below are structurally compatible with the real ones.
 */

export function pairKey(materialId: number, brandId: number | null): string {
  return `${materialId}:${brandId ?? 'none'}`;
}

type ExistingGroup = { brands: Array<{ brand_id: number }> };
type ExistingItem = { material_id: number; groups: ExistingGroup[] };

/** Every (material_id, brand_id) pair already present on the client's card. */
export function existingPairKeys(items: readonly ExistingItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    for (const g of item.groups) {
      if (g.brands.length === 0) keys.add(pairKey(item.material_id, null));
      else for (const b of g.brands) keys.add(pairKey(item.material_id, b.brand_id));
    }
  }
  return keys;
}

type MasterRow = { material_id: number; brand_id: number | null };

/** Master-rows search results with any pair already on the card removed. */
export function hideExistingPairs<T extends MasterRow>(rows: readonly T[], existing: ReadonlySet<string>): T[] {
  return rows.filter((r) => !existing.has(pairKey(r.material_id, r.brand_id)));
}
