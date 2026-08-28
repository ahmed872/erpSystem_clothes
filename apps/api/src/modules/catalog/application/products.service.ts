import { Injectable } from '@nestjs/common';
import type { CreateProductInput, ProductListQuery, UpdateProductInput, ReplaceBundleItemsInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EffectivePermissionsService } from '../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { assertSkuAvailable } from '../domain/sku-guard';
import { resolveAttributeValues, attributeSignature } from '../domain/attribute-values';
import { omitFields } from '../domain/omit-fields';
import { PRODUCT_INCLUDE } from '../domain/includes';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async createProduct(actor: RequestUser, input: CreateProductInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const baseUom = await tx.uom.findFirst({ where: { id: input.baseUomId, businessId: actor.tenantId } });
      if (!baseUom) throw new NotFoundDomainError('Uom', input.baseUomId);

      if (input.categoryId) {
        const category = await tx.category.findFirst({ where: { id: input.categoryId, businessId: actor.tenantId } });
        if (!category) throw new NotFoundDomainError('Category', input.categoryId);
      }
      if (input.brandId) {
        const brand = await tx.brand.findFirst({ where: { id: input.brandId, businessId: actor.tenantId } });
        if (!brand) throw new NotFoundDomainError('Brand', input.brandId);
      }

      await assertSkuAvailable(tx, actor.tenantId, input.sku);

      const variantInputs =
        input.variants && input.variants.length > 0
          ? input.variants
          : [
              {
                sku: input.sku,
                cost: input.defaultCost,
                sellingPrice: input.defaultSellingPrice,
                attributeValueIds: [] as string[],
                barcodes: [] as string[],
              },
            ];

      const skusInPayload = new Set<string>();
      const signaturesInPayload = new Set<string>();
      for (const v of variantInputs) {
        if (skusInPayload.has(v.sku)) throw new ValidationFailedError(`Duplicate variant SKU in request: ${v.sku}`);
        skusInPayload.add(v.sku);
        const sig = attributeSignature(v.attributeValueIds);
        if (signaturesInPayload.has(sig)) {
          throw new ValidationFailedError('Two variants in this request have the same combination of attribute values');
        }
        signaturesInPayload.add(sig);
      }
      for (const v of variantInputs) {
        await assertSkuAvailable(tx, actor.tenantId, v.sku);
      }

      const allBarcodeCodes = variantInputs.flatMap((v) => v.barcodes);
      if (new Set(allBarcodeCodes).size !== allBarcodeCodes.length) {
        throw new ValidationFailedError('Duplicate barcode in request');
      }
      if (allBarcodeCodes.length > 0) {
        const existingBarcodes = await tx.barcode.findMany({
          where: { businessId: actor.tenantId, code: { in: allBarcodeCodes } },
          select: { code: true },
        });
        if (existingBarcodes.length > 0) {
          throw new ConflictDomainError(`Barcode already in use: ${existingBarcodes[0].code}`);
        }
      }

      if (input.type === 'BUNDLE') {
        await this.assertValidBundleItems(tx, actor.tenantId, input.bundleItems ?? []);
      }

      const product = await tx.product.create({
        data: {
          businessId: actor.tenantId,
          sku: input.sku,
          name: input.name,
          alternativeName: input.alternativeName,
          categoryId: input.categoryId,
          brandId: input.brandId,
          description: input.description,
          type: input.type,
          defaultCost: input.defaultCost,
          defaultSellingPrice: input.defaultSellingPrice,
          minimumStock: input.minimumStock,
          maximumStock: input.maximumStock,
          baseUomId: input.baseUomId,
          images: input.images,
          tracksLots: input.tracksLots,
          tracksSerialNumbers: input.tracksSerialNumbers,
          createdBy: actor.id,
        },
      });

      for (const v of variantInputs) {
        const attributeMap = await resolveAttributeValues(tx, actor.tenantId, v.attributeValueIds);
        const variant = await tx.productVariant.create({
          data: {
            businessId: actor.tenantId,
            productId: product.id,
            sku: v.sku,
            cost: v.cost ?? input.defaultCost,
            sellingPrice: v.sellingPrice ?? input.defaultSellingPrice,
            weight: v.weight,
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
        if (v.barcodes.length > 0) {
          await tx.barcode.createMany({
            data: v.barcodes.map((code, idx) => ({
              businessId: actor.tenantId,
              variantId: variant.id,
              code,
              isPrimary: idx === 0,
            })),
          });
        }
      }

      if (input.type === 'BUNDLE' && input.bundleItems) {
        await tx.bundleItem.createMany({
          data: input.bundleItems.map((item) => ({
            bundleProductId: product.id,
            componentVariantId: item.variantId,
            quantity: item.quantity,
          })),
        });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Product',
        entityId: product.id,
        after: { sku: product.sku, name: product.name, type: product.type, variantCount: variantInputs.length },
      });

      const full = await tx.product.findUniqueOrThrow({ where: { id: product.id }, include: PRODUCT_INCLUDE });
      return full;
    });
  }

  async listProducts(actor: RequestUser, query: ProductListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const where = {
        businessId: actor.tenantId,
        categoryId: query.categoryId ?? undefined,
        brandId: query.brandId ?? undefined,
        status: query.status ?? undefined,
        type: query.type ?? undefined,
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' as const } },
                { sku: { contains: query.search, mode: 'insensitive' as const } },
                { alternativeName: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      const [total, products] = await Promise.all([
        tx.product.count({ where }),
        tx.product.findMany({
          where,
          include: { category: true, brand: true, baseUom: true, variants: { select: { id: true, sku: true, status: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      return {
        data: canViewCost ? products : products.map((p) => omitFields(p, ['defaultCost'])),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }

  async getProduct(actor: RequestUser, productId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const canViewCost = permissions?.has('products.view_cost') ?? false;

      const product = await tx.product.findFirst({
        where: { id: productId, businessId: actor.tenantId },
        include: PRODUCT_INCLUDE,
      });
      if (!product) throw new NotFoundDomainError('Product', productId);

      if (canViewCost) return product;
      return {
        ...omitFields(product, ['defaultCost']),
        variants: product.variants.map((v) => omitFields(v, ['cost'])),
      };
    });
  }

  async updateProduct(actor: RequestUser, productId: string, input: UpdateProductInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.product.findFirst({ where: { id: productId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Product', productId);

      if (input.categoryId) {
        const category = await tx.category.findFirst({ where: { id: input.categoryId, businessId: actor.tenantId } });
        if (!category) throw new NotFoundDomainError('Category', input.categoryId);
      }
      if (input.brandId) {
        const brand = await tx.brand.findFirst({ where: { id: input.brandId, businessId: actor.tenantId } });
        if (!brand) throw new NotFoundDomainError('Brand', input.brandId);
      }

      const nextMin = input.minimumStock === undefined ? before.minimumStock : input.minimumStock;
      const nextMax = input.maximumStock === undefined ? before.maximumStock : input.maximumStock;
      if (nextMin != null && nextMax != null && Number(nextMax) < Number(nextMin)) {
        throw new ValidationFailedError('maximumStock must be greater than or equal to minimumStock');
      }

      const after = await tx.product.update({
        where: { id: productId },
        data: {
          name: input.name ?? undefined,
          alternativeName: input.alternativeName === undefined ? undefined : input.alternativeName,
          categoryId: input.categoryId === undefined ? undefined : input.categoryId,
          brandId: input.brandId === undefined ? undefined : input.brandId,
          description: input.description === undefined ? undefined : input.description,
          status: input.status ?? undefined,
          minimumStock: input.minimumStock === undefined ? undefined : input.minimumStock,
          maximumStock: input.maximumStock === undefined ? undefined : input.maximumStock,
          images: input.images === undefined ? undefined : input.images,
          tracksLots: input.tracksLots ?? undefined,
          tracksSerialNumbers: input.tracksSerialNumbers ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Product',
        entityId: productId,
        before,
        after,
      });

      return after;
    });
  }

  async replaceBundleItems(actor: RequestUser, productId: string, input: ReplaceBundleItemsInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId, businessId: actor.tenantId } });
      if (!product) throw new NotFoundDomainError('Product', productId);
      if (product.type !== 'BUNDLE') {
        throw new ValidationFailedError('bundle-items can only be set on a product of type BUNDLE');
      }

      await this.assertValidBundleItems(tx, actor.tenantId, input.items, productId);

      const before = await tx.bundleItem.findMany({ where: { bundleProductId: productId } });
      await tx.bundleItem.deleteMany({ where: { bundleProductId: productId } });
      await tx.bundleItem.createMany({
        data: input.items.map((item) => ({
          bundleProductId: productId,
          componentVariantId: item.variantId,
          quantity: item.quantity,
        })),
      });

      const after = await tx.bundleItem.findMany({ where: { bundleProductId: productId } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'BundleItem',
        entityId: productId,
        before,
        after,
        reason: 'Replaced bundle composition',
      });

      return after;
    });
  }

  private async assertValidBundleItems(
    tx: TenantTx,
    businessId: string,
    items: { variantId: string; quantity: number }[],
    excludeBundleProductId?: string,
  ): Promise<void> {
    if (items.length === 0) return;
    const variantIds = items.map((i) => i.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new ValidationFailedError('Duplicate variantId in bundle items');
    }
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, businessId },
      include: { product: { select: { id: true, type: true } } },
    });
    if (variants.length !== variantIds.length) {
      throw new ValidationFailedError('One or more bundle component variantIds do not exist for this business');
    }
    for (const v of variants) {
      if (v.product.type === 'BUNDLE') {
        throw new ValidationFailedError('A bundle cannot contain another bundle as a component');
      }
      if (excludeBundleProductId && v.product.id === excludeBundleProductId) {
        throw new ValidationFailedError('A bundle cannot contain itself as a component');
      }
    }
  }
}
