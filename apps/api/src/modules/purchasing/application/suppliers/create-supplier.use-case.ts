import { Injectable } from '@nestjs/common';
import type { CreateSupplierInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

@Injectable()
export class CreateSupplierUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: CreateSupplierInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const existing = await tx.supplier.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
      if (existing) throw new ConflictDomainError(`A supplier named "${input.name}" already exists`);

      const supplier = await tx.supplier.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          contactPerson: input.contactPerson,
          phone: input.phone,
          email: input.email,
          address: input.address,
          taxNumber: input.taxNumber,
          paymentTermsDays: input.paymentTermsDays,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Supplier',
        entityId: supplier.id,
        after: supplier,
      });

      return supplier;
    });
  }
}
