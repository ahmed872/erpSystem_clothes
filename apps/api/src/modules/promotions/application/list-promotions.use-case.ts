import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PromotionListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class ListPromotionsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: PromotionListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where: Prisma.PromotionWhereInput = {
        businessId: actor.tenantId,
        type: query.type,
        targetType: query.targetType,
        isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
      };

      const [total, data] = await Promise.all([
        tx.promotion.count({ where }),
        tx.promotion.findMany({
          where,
          orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return {
        data,
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
