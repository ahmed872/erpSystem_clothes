import { Injectable } from '@nestjs/common';
import type {
  CreateAttributeInput,
  UpdateAttributeInput,
  CreateAttributeValueInput,
  UpdateAttributeValueInput,
} from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class AttributesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createAttribute(actor: RequestUser, input: CreateAttributeInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const duplicate = await tx.productAttribute.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
      if (duplicate) throw new ConflictDomainError(`An attribute named "${input.name}" already exists`);

      const attribute = await tx.productAttribute.create({
        data: { businessId: actor.tenantId, name: input.name },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'ProductAttribute',
        entityId: attribute.id,
        after: attribute,
      });

      return attribute;
    });
  }

  async listAttributes(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.productAttribute.findMany({
        where: { businessId: actor.tenantId },
        include: { values: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async updateAttribute(actor: RequestUser, attributeId: string, input: UpdateAttributeInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.productAttribute.findFirst({ where: { id: attributeId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('ProductAttribute', attributeId);

      if (input.name && input.name !== before.name) {
        const duplicate = await tx.productAttribute.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`An attribute named "${input.name}" already exists`);
      }

      const after = await tx.productAttribute.update({
        where: { id: attributeId },
        data: { name: input.name ?? undefined, isActive: input.isActive ?? undefined },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'ProductAttribute',
        entityId: attributeId,
        before,
        after,
      });

      return after;
    });
  }

  async createValue(actor: RequestUser, attributeId: string, input: CreateAttributeValueInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const attribute = await tx.productAttribute.findFirst({ where: { id: attributeId, businessId: actor.tenantId } });
      if (!attribute) throw new NotFoundDomainError('ProductAttribute', attributeId);

      const duplicate = await tx.productAttributeValue.findFirst({ where: { attributeId, value: input.value } });
      if (duplicate) throw new ConflictDomainError(`Value "${input.value}" already exists for this attribute`);

      const value = await tx.productAttributeValue.create({
        data: { businessId: actor.tenantId, attributeId, value: input.value, sortOrder: input.sortOrder },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'ProductAttributeValue',
        entityId: value.id,
        after: value,
      });

      return value;
    });
  }

  async updateValue(actor: RequestUser, valueId: string, input: UpdateAttributeValueInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.productAttributeValue.findFirst({ where: { id: valueId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('ProductAttributeValue', valueId);

      if (input.value && input.value !== before.value) {
        const duplicate = await tx.productAttributeValue.findFirst({
          where: { attributeId: before.attributeId, value: input.value },
        });
        if (duplicate) throw new ConflictDomainError(`Value "${input.value}" already exists for this attribute`);
      }

      const after = await tx.productAttributeValue.update({
        where: { id: valueId },
        data: { value: input.value ?? undefined, sortOrder: input.sortOrder ?? undefined },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'ProductAttributeValue',
        entityId: valueId,
        before,
        after,
      });

      return after;
    });
  }

  async deleteValue(actor: RequestUser, valueId: string): Promise<void> {
    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const value = await tx.productAttributeValue.findFirst({
        where: { id: valueId, businessId: actor.tenantId },
        include: { _count: { select: { variants: true } } },
      });
      if (!value) throw new NotFoundDomainError('ProductAttributeValue', valueId);
      if (value._count.variants > 0) {
        throw new ConflictDomainError('Cannot delete a value that is still used by product variants');
      }

      await tx.productAttributeValue.delete({ where: { id: valueId } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'DELETE',
        entityType: 'ProductAttributeValue',
        entityId: valueId,
        before: value,
      });
    });
  }
}
