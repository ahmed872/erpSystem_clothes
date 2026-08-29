/**
 * Field-level visibility for reports, enforced SERVER-SIDE by removing
 * the keys entirely (not nulling them, not leaving them for a frontend to
 * hide) - the same posture Phase 5 established for Sale cost/margin
 * fields, reapplied here.
 *
 * Two independent gates, deliberately not collapsed into one:
 *   - `products.view_cost` (existing, Phase 2/5) gates COST fields.
 *   - `reports.view_profit` (new, Phase 7) gates PROFIT/MARGIN fields.
 * A caller can legitimately hold one without the other, and the Phase 7
 * role matrix relies on that: BRANCH_MANAGER holds neither, ACCOUNTANT
 * holds both.
 *
 * The keys are declared as readonly tuples so a typo becomes a compile
 * error rather than a silently-unstripped field.
 */
export const COST_FIELDS = [
  'totalCost',
  'unitCost',
  'averageCost',
  'inventoryValue',
  'cogs',
  'returnedCost',
  'netPurchaseCost',
  'unitCostAtMovement',
  'movementValue',
] as const;
export const PROFIT_FIELDS = ['grossProfit', 'netProfit', 'marginPercent', 'profit'] as const;

export interface ReportVisibility {
  canViewCost: boolean;
  canViewProfit: boolean;
}

export function resolveVisibility(permissions: Set<string>): ReportVisibility {
  return {
    canViewCost: permissions.has('products.view_cost'),
    canViewProfit: permissions.has('reports.view_profit'),
  };
}

/**
 * Strips whichever of the cost/profit field families the caller is not
 * entitled to from a single row. Applied per-row rather than once at the
 * envelope so nested rows (report lines) are covered too.
 *
 * Deliberately DELETES the keys rather than nulling them: an absent key
 * cannot be misread as "this value is genuinely zero/unknown", and it
 * makes the omission directly assertable in tests
 * (`expect(row).not.toHaveProperty('grossProfit')`).
 */
export function applyVisibility<T extends object>(row: T, visibility: ReportVisibility): Partial<T> {
  const result = { ...row } as Record<string, unknown>;
  if (!visibility.canViewCost) {
    for (const key of COST_FIELDS) delete result[key];
  }
  if (!visibility.canViewProfit) {
    for (const key of PROFIT_FIELDS) delete result[key];
  }
  return result as Partial<T>;
}

export function applyVisibilityToRows<T extends object>(rows: T[], visibility: ReportVisibility): Partial<T>[] {
  return rows.map((row) => applyVisibility(row, visibility));
}
