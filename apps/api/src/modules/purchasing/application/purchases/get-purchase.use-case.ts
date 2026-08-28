import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class GetPurchaseUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, purchaseId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const purchase = await tx.purchase.findFirst({
        where: { id: purchaseId, businessId: actor.tenantId },
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          items: { include: { variant: { select: { id: true, sku: true } } } },
          receipts: { include: { items: true }, orderBy: { receivedAt: 'desc' } },
          returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
          payments: { orderBy: { paidAt: 'desc' } },
        },
      });
      if (!purchase) throw new NotFoundDomainError('Purchase', purchaseId);
      return purchase;
    });
  }
}
