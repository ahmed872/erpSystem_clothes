import { AccountingMappingKey } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { ConflictDomainError } from '../../../common/errors/domain-error';

/**
 * Turns AccountingMappingKey values into real Account ids for the
 * calling business, via AccountingMappingRule (Phase 0 §6.3: "Mapping
 * Table صريح... وليست if/else متناثرة في الكود"). Every business gets a
 * full set of rows for every key at onboarding (RegisterBusinessUseCase)
 * or via the one-time bootstrap seed for pre-existing businesses (see
 * prisma/seed.ts) - a missing key here means the business's accounting
 * setup is incomplete, surfaced as a clear error rather than silently
 * skipping a line (which would corrupt double-entry balance).
 */
export async function resolveMappedAccounts(tx: TenantTx, businessId: string, keys: AccountingMappingKey[]): Promise<Map<AccountingMappingKey, string>> {
  const uniqueKeys = [...new Set(keys)];
  const rules = await tx.accountingMappingRule.findMany({
    where: { businessId, key: { in: uniqueKeys } },
    select: { key: true, accountId: true },
  });
  const byKey = new Map(rules.map((r) => [r.key, r.accountId]));
  const missing = uniqueKeys.filter((k) => !byKey.has(k));
  if (missing.length > 0) {
    throw new ConflictDomainError('This business is missing required accounting mapping rules', { missingKeys: missing });
  }
  return byKey;
}
