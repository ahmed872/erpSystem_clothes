import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { effectiveWarrantyStatus } from '../domain/warranty-eligibility';

/**
 * Reads one warranty with its full claim history. The tenant predicate is
 * carried in the query as well as by RLS - defence in depth, the same
 * convention every other read use-case follows.
 */
@Injectable()
export class GetWarrantyUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, id: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warranty = await tx.warranty.findFirst({
        where: { id, businessId: actor.tenantId },
        include: {
          serialNumber: { select: { id: true, serial: true, variantId: true } },
          customer: { select: { id: true, name: true, phone: true } },
          saleItem: {
            select: {
              id: true,
              variantId: true,
              quantity: true,
              sale: { select: { id: true, saleNumber: true, createdAt: true, branchId: true } },
            },
          },
          claims: { orderBy: { claimedAt: 'desc' } },
        },
      });
      if (!warranty) throw new NotFoundDomainError('Warranty', id);

      return { ...warranty, effectiveStatus: effectiveWarrantyStatus(warranty, new Date()) };
    });
  }
}
