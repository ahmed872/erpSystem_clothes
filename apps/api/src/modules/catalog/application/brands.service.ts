import { Injectable } from '@nestjs/common';
import type { CreateBrandInput, UpdateBrandInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, input: CreateBrandInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const duplicate = await tx.brand.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
      if (duplicate) throw new ConflictDomainError(`A brand named "${input.name}" already exists`);

      const brand = await tx.brand.create({
        data: { businessId: actor.tenantId, name: input.name, description: input.description, createdBy: actor.id },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Brand',
        entityId: brand.id,
        after: brand,
      });

      return brand;
    });
  }

  async list(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.brand.findMany({ where: { businessId: actor.tenantId }, orderBy: { name: 'asc' } }),
    );
  }

  async update(actor: RequestUser, brandId: string, input: UpdateBrandInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.brand.findFirst({ where: { id: brandId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Brand', brandId);

      if (input.name && input.name !== before.name) {
        const duplicate = await tx.brand.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`A brand named "${input.name}" already exists`);
      }

      const after = await tx.brand.update({
        where: { id: brandId },
        data: {
          name: input.name ?? undefined,
          description: input.description === undefined ? undefined : input.description,
          isActive: input.isActive ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Brand',
        entityId: brandId,
        before,
        after,
      });

      return after;
    });
  }
}
