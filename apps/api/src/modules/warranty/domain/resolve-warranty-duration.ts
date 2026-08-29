import { TenantTx } from '../../../common/prisma/prisma.service';
import { ValidationFailedError } from '../../../common/errors/domain-error';

export const WARRANTY_DEFAULT_DURATION_SETTING_KEY = 'warranty.default_duration_days';

/** Technical bound only - mirrors the warranties_duration_days_technical_bound
 * CHECK constraint and the shared zod schema. Phase 0 defines no business
 * maximum and one was explicitly not invented; this exists solely so
 * startDate + durationDays cannot overflow a valid timestamp. */
export const WARRANTY_MAX_DURATION_DAYS = 36500;

/**
 * Resolves the warranty duration for a registration, per approved
 * decision BD-4: an optional per-registration override, otherwise the
 * business-wide default in Setting['warranty.default_duration_days'].
 * Reuses the generic Setting store (Phase 1) exactly as
 * resolveAllowNegative does for inventory - no dedicated warranty
 * configuration table, and no Product/Variant schema change.
 *
 * The returned value is SNAPSHOTTED onto the Warranty row by the caller,
 * so changing the business default afterwards affects only future
 * registrations; an issued warranty is never recomputed from current
 * configuration.
 *
 * A business with no default configured and no override supplied is a
 * genuine configuration gap, not a value to guess at: it is rejected with
 * a clear error rather than defaulting to some invented period.
 */
export async function resolveWarrantyDurationDays(tx: TenantTx, businessId: string, override?: number): Promise<number> {
  if (override !== undefined) return override;

  const setting = await tx.setting.findUnique({
    where: { businessId_key: { businessId, key: WARRANTY_DEFAULT_DURATION_SETTING_KEY } },
  });

  const raw = setting?.value;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > WARRANTY_MAX_DURATION_DAYS) {
    throw new ValidationFailedError(
      `No warranty duration supplied and no valid business default configured. Set the '${WARRANTY_DEFAULT_DURATION_SETTING_KEY}' setting to a positive whole number of days, or pass durationDays explicitly.`,
      { settingKey: WARRANTY_DEFAULT_DURATION_SETTING_KEY, configuredValue: raw ?? null },
    );
  }

  return parsed;
}

/** endDate is always derived from the snapshotted duration, never stored
 * independently of it, so the two can never disagree. */
export function computeWarrantyEndDate(startDate: Date, durationDays: number): Date {
  return new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
}
