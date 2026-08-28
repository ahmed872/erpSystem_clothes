import { Injectable } from '@nestjs/common';
import type { CreateUomInput, UpdateUomInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class UomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, input: CreateUomInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const duplicate = await tx.uom.findFirst({
        where: { businessId: actor.tenantId, OR: [{ name: input.name }, { code: input.code }] },
      });
      if (duplicate) {
        throw new ConflictDomainError(`A unit with this name or code already exists`);
      }

      const uom = await tx.uom.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          code: input.code,
          precision: input.precision,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Uom',
        entityId: uom.id,
        after: uom,
      });

      return uom;
    });
  }

  async list(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.uom.findMany({ where: { businessId: actor.tenantId }, orderBy: { name: 'asc' } }),
    );
  }

  async update(actor: RequestUser, uomId: string, input: UpdateUomInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.uom.findFirst({ where: { id: uomId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Uom', uomId);

      if (input.name && input.name !== before.name) {
        const duplicate = await tx.uom.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`A unit named "${input.name}" already exists`);
      }

      const after = await tx.uom.update({
        where: { id: uomId },
        data: {
          name: input.name ?? undefined,
          precision: input.precision ?? undefined,
          isActive: input.isActive ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Uom',
        entityId: uomId,
        before,
        after,
      });

      return after;
    });
  }
}
