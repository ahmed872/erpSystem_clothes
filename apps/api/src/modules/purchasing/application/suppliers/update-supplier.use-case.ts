import { Injectable } from '@nestjs/common';
import type { UpdateSupplierInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class UpdateSupplierUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, supplierId: string, input: UpdateSupplierInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id: supplierId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Supplier', supplierId);

      if (input.name && input.name !== before.name) {
        const clash = await tx.supplier.findFirst({ where: { businessId: actor.tenantId, name: input.name, id: { not: supplierId } } });
        if (clash) throw new ConflictDomainError(`A supplier named "${input.name}" already exists`);
      }

      const supplier = await tx.supplier.update({
        where: { id: supplierId },
        data: {
          name: input.name,
          contactPerson: input.contactPerson,
          phone: input.phone,
          email: input.email,
          address: input.address,
          taxNumber: input.taxNumber,
          paymentTermsDays: input.paymentTermsDays,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Supplier',
        entityId: supplier.id,
        before,
        after: supplier,
      });

      return supplier;
    });
  }
}
