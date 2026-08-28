import { Injectable } from '@nestjs/common';
import type { CatalogSyncQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../common/authorization/effective-permissions.service';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { PRODUCT_INCLUDE } from '../domain/includes';
import { omitFields } from '../domain/omit-fields';

/**
 * Bulk/delta catalog read designed for POS caching (Phase 5) and, later,
 * offline-first priming (Phase 0 §15): `updatedSince` lets a client pull
 * only what changed since its last sync instead of the whole catalog
 * every time. This is a read-only endpoint - it does not need the Sync
 * Queue/idempotency machinery Phase 5 builds for *writes* coming back
 * from an offline client, but its query shape is exactly what that later
 * work will keep using, so it does not need to be redesigned then.
 */
@Injectable()
export class CatalogSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async sync(actor: RequestUser, query: CatalogSyncQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const since = query.updatedSince ? new Date(query.updatedSince) : undefined;

      const products = await tx.product.findMany({
        where: {
          businessId: actor.tenantId,
          status: query.includeInactive ? undefined : 'ACTIVE',
          ...(since ? { OR: [{ updatedAt: { gte: since } }, { variants: { some: { updatedAt: { gte: since } } } }] } : {}),
        },
        include: PRODUCT_INCLUDE,
        orderBy: { updatedAt: 'asc' },
      });

      const shaped = canViewCost
        ? products
        : products.map((p) => ({
            ...omitFields(p, ['defaultCost']),
            variants: p.variants.map((v) => omitFields(v, ['cost'])),
          }));

      return { data: shaped, syncedAt: new Date().toISOString() };
    });
  }
}
