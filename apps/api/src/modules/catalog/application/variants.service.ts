import { Injectable } from '@nestjs/common';
import type {
  AddVariantInput,
  UpdateVariantInput,
  ChangeVariantCostInput,
  ChangeVariantPriceInput,
  VariantLookupQuery,
} from '@retail/shared-validation';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EffectivePermissionsService } from '../../../common/authorization/effective-permissions.service';
import { NotFoundDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { assertSkuAvailable } from '../domain/sku-guard';
import { resolveAttributeValues, attributeSignature } from '../domain/attribute-values';
import { omitFields } from '../domain/omit-fields';
import { VARIANT_INCLUDE } from '../domain/includes';

@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async addVariant(actor: RequestUser, productId: string, input: AddVariantInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId, businessId: actor.tenantId } });
      if (!product) throw new NotFoundDomainError('Product', productId);

      await assertSkuAvailable(tx, actor.tenantId, input.sku);

      const attributeMap = await resolveAttributeValues(tx, actor.tenantId, input.attributeValueIds);

      if (attributeMap.size > 0) {
        const existingVariants = await tx.variantAttributeValue.findMany({
          where: { variant: { productId } },
          select: { variantId: true, attributeValueId: true },
        });
        const byVariant = new Map<string, string[]>();
        for (const row of existingVariants) {
          byVariant.set(row.variantId, [...(byVariant.get(row.variantId) ?? []), row.attributeValueId]);
        }
        const newSignature = attributeSignature([...attributeMap.keys()]);
        for (const ids of byVariant.values()) {
          if (attributeSignature(ids) === newSignature) {
            throw new ValidationFailedError('A variant with this exact combination of attribute values already exists');
          }
        }
      }

      if (input.barcodes.length > 0) {
        const existingBarcodes = await tx.barcode.findMany({
          where: { businessId: actor.tenantId, code: { in: input.barcodes } },
          select: { code: true },
        });
        if (existingBarcodes.length > 0) throw new ValidationFailedError(`Barcode already in use: ${existingBarcodes[0].code}`);
      }

      const variant = await tx.productVariant.create({
        data: {
          businessId: actor.tenantId,
          productId,
          sku: input.sku,
          cost: input.cost ?? product.defaultCost,
          sellingPrice: input.sellingPrice ?? product.defaultSellingPrice,
          weight: input.weight,
          createdBy: actor.id,
        },
      });

      if (attributeMap.size > 0) {
        await tx.variantAttributeValue.createMany({
          data: [...attributeMap.entries()].map(([attributeValueId, attributeId]) => ({
            variantId: variant.id,
            attributeId,
            attributeValueId,
          })),
        });
      }
      if (input.barcodes.length > 0) {
        await tx.barcode.createMany({
          data: input.barcodes.map((code, idx) => ({
            businessId: actor.tenantId,
            variantId: variant.id,
            code,
            isPrimary: idx === 0,
          })),
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'ProductVariant',
        entityId: variant.id,
        after: variant,
      });

      return tx.productVariant.findUniqueOrThrow({ where: { id: variant.id }, include: VARIANT_INCLUDE });
    });
  }

  async getVariant(actor: RequestUser, variantId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, businessId: actor.tenantId },
        include: VARIANT_INCLUDE,
      });
      if (!variant) throw new NotFoundDomainError('ProductVariant', variantId);

      return canViewCost ? variant : omitFields(variant, ['cost']);
    });
  }

  async updateVariant(actor: RequestUser, variantId: string, input: UpdateVariantInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.productVariant.findFirst({ where: { id: variantId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('ProductVariant', variantId);

      const after = await tx.productVariant.update({
        where: { id: variantId },
        data: {
          status: input.status ?? undefined,
          weight: input.weight === undefined ? undefined : input.weight,
          dimensions:
            input.dimensions === undefined
              ? undefined
              : input.dimensions === null
                ? Prisma.JsonNull
                : (input.dimensions as Prisma.InputJsonValue),
          images: input.images === undefined ? undefined : (input.images as Prisma.InputJsonValue),
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'ProductVariant',
        entityId: variantId,
        before,
        after,
      });

      return after;
    });
  }

  async changeCost(actor: RequestUser, variantId: string, input: ChangeVariantCostInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.productVariant.findFirst({ where: { id: variantId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('ProductVariant', variantId);

      const after = await tx.productVariant.update({
        where: { id: variantId },
        data: { cost: input.cost, updatedBy: actor.id },
      });

      await tx.productPriceHistory.create({
        data: {
          businessId: actor.tenantId,
          variantId,
          changeType: 'COST',
          oldValue: before.cost,
          newValue: input.cost,
          changedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'ProductVariant',
        entityId: variantId,
        before: { cost: before.cost },
        after: { cost: after.cost },
        reason: 'Cost change',
      });

      return after;
    });
  }

  async changePrice(actor: RequestUser, variantId: string, input: ChangeVariantPriceInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.productVariant.findFirst({ where: { id: variantId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('ProductVariant', variantId);

      const after = await tx.productVariant.update({
        where: { id: variantId },
        data: { sellingPrice: input.sellingPrice, updatedBy: actor.id },
      });

      await tx.productPriceHistory.create({
        data: {
          businessId: actor.tenantId,
          variantId,
          changeType: 'SELLING_PRICE',
          oldValue: before.sellingPrice,
          newValue: input.sellingPrice,
          changedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'ProductVariant',
        entityId: variantId,
        before: { sellingPrice: before.sellingPrice },
        after: { sellingPrice: after.sellingPrice },
        reason: 'Selling price change',
      });

      return after;
    });
  }

  /**
   * Fast lookup by barcode or SKU - the exact operation a POS cashier
   * (and later, offline POS cache priming) performs on every scan. Kept
   * as its own indexed, single-purpose query rather than reusing the
   * general product listing/filtering path, since this is the one catalog
   * read that must be fast and dead simple under real POS load.
   */
  async lookupVariant(actor: RequestUser, query: VariantLookupQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const variant = query.barcode
        ? await tx.productVariant.findFirst({
            where: { businessId: actor.tenantId, barcodes: { some: { code: query.barcode } } },
            include: VARIANT_INCLUDE,
          })
        : await tx.productVariant.findFirst({
            where: { businessId: actor.tenantId, sku: query.sku },
            include: VARIANT_INCLUDE,
          });

      if (!variant) throw new NotFoundDomainError('ProductVariant');

      return canViewCost ? variant : omitFields(variant, ['cost']);
    });
  }
}
