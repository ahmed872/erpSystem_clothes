import { TenantTx } from '../../../common/prisma/prisma.service';
import { ValidationFailedError } from '../../../common/errors/domain-error';

/**
 * Resolves and validates a variant's chosen attributeValueIds: every id
 * must exist and belong to this tenant, and a variant can never carry two
 * different values for the same attribute (mirrors the DB-level guarantee
 * from VariantAttributeValue's composite PK, but fails with a readable
 * message here instead of a raw constraint violation).
 *
 * Returns the id -> attributeId map (needed to insert VariantAttributeValue
 * rows, which denormalize attributeId for their own composite FK).
 */
export async function resolveAttributeValues(
  tx: TenantTx,
  businessId: string,
  attributeValueIds: string[],
): Promise<Map<string, string>> {
  if (attributeValueIds.length === 0) return new Map();

  const rows = await tx.productAttributeValue.findMany({
    where: { id: { in: attributeValueIds }, businessId },
    select: { id: true, attributeId: true },
  });
  if (rows.length !== new Set(attributeValueIds).size) {
    throw new ValidationFailedError('One or more attributeValueIds do not exist for this business');
  }

  const byAttribute = new Set<string>();
  for (const row of rows) {
    if (byAttribute.has(row.attributeId)) {
      throw new ValidationFailedError('A variant cannot have two values for the same attribute');
    }
    byAttribute.add(row.attributeId);
  }

  return new Map(rows.map((r) => [r.id, r.attributeId]));
}

/** Canonical signature of a variant's attribute-value set, for duplicate-variant detection. */
export function attributeSignature(attributeValueIds: string[]): string {
  return [...attributeValueIds].sort().join('|');
}
