import { Injectable } from '@nestjs/common';
import type { CreatePriceListInput, UpdatePriceListInput, UpsertPriceListEntryInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class PriceListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, input: CreatePriceListInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const duplicate = await tx.priceList.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
      if (duplicate) throw new ConflictDomainError(`A price list named "${input.name}" already exists`);

      if (input.isDefault) {
        await tx.priceList.updateMany({ where: { businessId: actor.tenantId, isDefault: true }, data: { isDefault: false } });
      }

      const priceList = await tx.priceList.create({
        data: { businessId: actor.tenantId, name: input.name, isDefault: input.isDefault, createdBy: actor.id },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'PriceList',
        entityId: priceList.id,
        after: priceList,
      });

      return priceList;
    });
  }

  async list(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.priceList.findMany({ where: { businessId: actor.tenantId }, orderBy: { name: 'asc' } }),
    );
  }

  async update(actor: RequestUser, priceListId: string, input: UpdatePriceListInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.priceList.findFirst({ where: { id: priceListId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('PriceList', priceListId);

      if (input.name && input.name !== before.name) {
        const duplicate = await tx.priceList.findFirst({ where: { businessId: actor.tenantId, name: input.name } });
        if (duplicate) throw new ConflictDomainError(`A price list named "${input.name}" already exists`);
      }

      if (input.isDefault) {
        await tx.priceList.updateMany({
          where: { businessId: actor.tenantId, isDefault: true, NOT: { id: priceListId } },
          data: { isDefault: false },
        });
      }

      const after = await tx.priceList.update({
        where: { id: priceListId },
        data: {
          name: input.name ?? undefined,
          isDefault: input.isDefault ?? undefined,
          isActive: input.isActive ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'PriceList',
        entityId: priceListId,
        before,
        after,
      });

      return after;
    });
  }

  async listEntries(actor: RequestUser, priceListId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const priceList = await tx.priceList.findFirst({ where: { id: priceListId, businessId: actor.tenantId } });
      if (!priceList) throw new NotFoundDomainError('PriceList', priceListId);

      return tx.productPrice.findMany({
        where: { priceListId },
        include: { variant: { select: { id: true, sku: true, product: { select: { id: true, name: true } } } } },
      });
    });
  }

  async upsertEntry(actor: RequestUser, priceListId: string, input: UpsertPriceListEntryInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const priceList = await tx.priceList.findFirst({ where: { id: priceListId, businessId: actor.tenantId } });
      if (!priceList) throw new NotFoundDomainError('PriceList', priceListId);

      const variant = await tx.productVariant.findFirst({ where: { id: input.variantId, businessId: actor.tenantId } });
      if (!variant) throw new NotFoundDomainError('ProductVariant', input.variantId);

      const before = await tx.productPrice.findUnique({
        where: { priceListId_variantId: { priceListId, variantId: input.variantId } },
      });

      const after = await tx.productPrice.upsert({
        where: { priceListId_variantId: { priceListId, variantId: input.variantId } },
        create: { businessId: actor.tenantId, priceListId, variantId: input.variantId, price: input.price, updatedBy: actor.id },
        update: { price: input.price, updatedBy: actor.id },
      });

      await tx.productPriceHistory.create({
        data: {
          businessId: actor.tenantId,
          variantId: input.variantId,
          priceListId,
          changeType: 'LIST_PRICE',
          oldValue: before?.price,
          newValue: input.price,
          changedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: before ? 'UPDATE' : 'CREATE',
        entityType: 'ProductPrice',
        entityId: after.id,
        before,
        after,
      });

      return after;
    });
  }
}
