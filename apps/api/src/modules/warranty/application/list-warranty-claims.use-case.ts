import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

/**
 * Lists every claim registered against one warranty, newest first. The
 * parent warranty is resolved inside the tenant first so a claim from
 * another business can never be reached by guessing a warranty id.
 */
@Injectable()
export class ListWarrantyClaimsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, warrantyId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warranty = await tx.warranty.findFirst({
        where: { id: warrantyId, businessId: actor.tenantId },
        select: { id: true },
      });
      if (!warranty) throw new NotFoundDomainError('Warranty', warrantyId);

      const claims = await tx.warrantyClaim.findMany({
        where: { warrantyId, businessId: actor.tenantId },
        orderBy: { claimedAt: 'desc' },
      });
      return { data: claims };
    });
  }
}
