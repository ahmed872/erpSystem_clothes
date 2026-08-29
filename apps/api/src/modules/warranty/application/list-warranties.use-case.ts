import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WarrantyListQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { effectiveWarrantyStatus } from '../domain/warranty-eligibility';

@Injectable()
export class ListWarrantiesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: WarrantyListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where: Prisma.WarrantyWhereInput = {
        businessId: actor.tenantId,
        status: query.status,
        customerId: query.customerId,
        serialNumberId: query.serialNumberId,
      };

      const [total, warranties] = await Promise.all([
        tx.warranty.count({ where }),
        tx.warranty.findMany({
          where,
          include: {
            serialNumber: { select: { id: true, serial: true } },
            customer: { select: { id: true, name: true } },
            saleItem: { select: { id: true, variantId: true, sale: { select: { id: true, saleNumber: true } } } },
            _count: { select: { claims: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      const now = new Date();
      return {
        data: warranties.map((w) => ({
          ...w,
          // Derived on read - no scheduled job flips ACTIVE to EXPIRED
          // (Phase 8A adds no job runner), so `status` is the stored
          // human-set value and `effectiveStatus` is the time-aware one.
          effectiveStatus: effectiveWarrantyStatus(w, now),
          claimCount: w._count.claims,
        })),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }
}
