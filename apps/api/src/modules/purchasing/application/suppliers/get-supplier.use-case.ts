import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { getSupplierBalance } from '../../domain/supplier-balance';

@Injectable()
export class GetSupplierUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, supplierId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, businessId: actor.tenantId } });
      if (!supplier) throw new NotFoundDomainError('Supplier', supplierId);

      const [balance, transactions] = await Promise.all([
        getSupplierBalance(tx, actor.tenantId, supplierId),
        tx.supplierTransaction.findMany({
          where: { businessId: actor.tenantId, supplierId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);

      return { ...supplier, balance: balance.toString(), recentTransactions: transactions };
    });
  }
}
