import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Soft-delete only, per the system-wide "no hard delete for anything
 * heavily referenced" precedent (a Supplier is referenced by every
 * Purchase/SupplierTransaction ever created against it) - `erp_app` also
 * has no DELETE grant on `suppliers` at all (defense in depth, see the
 * app-role-grants migration).
 */
@Injectable()
export class DeactivateSupplierUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, supplierId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id: supplierId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Supplier', supplierId);
      if (!before.isActive) throw new ConflictDomainError('Supplier is already inactive');

      const openPurchase = await tx.purchase.findFirst({
        where: { supplierId, businessId: actor.tenantId, status: { in: ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'] } },
        select: { id: true },
      });
      if (openPurchase) {
        throw new ConflictDomainError('Cannot deactivate a supplier with an open (non-cancelled/received) purchase', {
          purchaseId: openPurchase.id,
        });
      }

      const supplier = await tx.supplier.update({ where: { id: supplierId }, data: { isActive: false, updatedBy: actor.id } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Supplier',
        entityId: supplier.id,
        before: { isActive: true },
        after: { isActive: false },
        reason: 'Supplier deactivated',
      });

      return supplier;
    });
  }
}
