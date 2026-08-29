import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InventoryMovementsQuery, InventoryValuationQuery, SlowMovingQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ForbiddenDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveReportContext } from '../../domain/report-context';
import { branchWhere, resolveBranchScope } from '../../domain/branch-scope';
import { dateRangeWhere } from '../../domain/date-range';
import { applyVisibility, applyVisibilityToRows, resolveVisibility } from '../../domain/report-visibility';

/**
 * Inventory reports. Source of truth is the Stock Ledger
 * (`StockMovement`) and its derived cache (`StockBalance`) - never
 * `Product.defaultCost` or any other independent quantity/cost field.
 *
 * Historical movement cost always comes from `unitCostAtMovement`
 * (immutable, recorded at movement time); current valuation comes from
 * `StockBalance.averageCost`. These answer different questions and are
 * never conflated.
 *
 * NOT IMPLEMENTED - Low Stock: the schema has no reorder-point /
 * minimum-stock threshold field anywhere (verified during the Phase 7
 * audit), so there is no source of truth for "low". Reporting one would
 * require inventing a threshold, which is forbidden. Documented as
 * BLOCKED BY DEPENDENCY rather than approximated.
 */
@Injectable()
export class InventoryReportsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  /** Current stock value per variant/warehouse, from the derived balance cache. */
  async valuation(actor: RequestUser, query: InventoryValuationQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');
      const branchScope = await resolveBranchScope(tx, actor.tenantId, actor.id, permissions, query.branchId);
      const visibility = resolveVisibility(permissions);

      // StockBalance has no branchId of its own - branch authorization is
      // applied through the warehouse that owns the balance.
      const warehouseFilter =
        branchScope.allowedBranchIds === null
          ? query.warehouseId
            ? { id: query.warehouseId }
            : undefined
          : { branchId: { in: branchScope.allowedBranchIds }, ...(query.warehouseId ? { id: query.warehouseId } : {}) };

      const where: Prisma.StockBalanceWhereInput = {
        businessId: actor.tenantId,
        ...(warehouseFilter ? { warehouse: warehouseFilter } : {}),
      };

      const [total, balances] = await Promise.all([
        tx.stockBalance.count({ where }),
        tx.stockBalance.findMany({
          where,
          include: {
            variant: { select: { sku: true, product: { select: { name: true } } } },
            warehouse: { select: { id: true, name: true } },
          },
          orderBy: { id: 'asc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      const rows = balances.map((b) => ({
        variantId: b.variantId,
        sku: b.variant.sku,
        productName: b.variant.product.name,
        warehouseId: b.warehouse.id,
        warehouseName: b.warehouse.name,
        quantityOnHand: b.quantityOnHand.toString(),
        averageCost: b.averageCost.toString(),
        inventoryValue: b.quantityOnHand.times(b.averageCost).toString(),
      }));

      // The grand total is computed over the WHOLE filtered set, not just
      // the current page - a page-only total would be misleading.
      const allBalances = await tx.stockBalance.findMany({ where, select: { quantityOnHand: true, averageCost: true } });
      const totalValue = allBalances.reduce((s, b) => s.plus(b.quantityOnHand.times(b.averageCost)), new Prisma.Decimal(0));

      return {
        data: applyVisibilityToRows(rows, visibility),
        summary: applyVisibility({ inventoryValue: totalValue.toString(), variantCount: total }, visibility),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }

  /** Raw stock ledger for a period, optionally filtered by type/variant. */
  async movements(actor: RequestUser, query: InventoryMovementsQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const where: Prisma.StockMovementWhereInput = {
        businessId: ctx.businessId,
        createdAt: dateRangeWhere(ctx.range),
        ...branchWhere(ctx.branchScope),
        ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.movementType ? { movementType: query.movementType } : {}),
      };

      const [total, movements] = await Promise.all([
        tx.stockMovement.count({ where }),
        tx.stockMovement.findMany({
          where,
          include: { variant: { select: { sku: true, product: { select: { name: true } } } }, warehouse: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);

      const rows = movements.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        movementType: m.movementType,
        variantId: m.variantId,
        sku: m.variant.sku,
        productName: m.variant.product.name,
        warehouseName: m.warehouse.name,
        quantityBase: m.quantityBase.toString(),
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        reason: m.reason,
        isNegativeStock: m.isNegativeStock,
        unitCostAtMovement: m.unitCostAtMovement.toString(),
        movementValue: m.quantityBase.abs().times(m.unitCostAtMovement).toString(),
      }));

      return {
        data: applyVisibilityToRows(rows, ctx.visibility),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  /** Damage and loss write-offs for a period, by type. */
  async damageAndLoss(actor: RequestUser, query: InventoryMovementsQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ctx = await resolveReportContext(tx, this.effectivePermissions, actor, query);

      const movements = await tx.stockMovement.findMany({
        where: {
          businessId: ctx.businessId,
          createdAt: dateRangeWhere(ctx.range),
          movementType: { in: ['DAMAGE', 'LOSS', 'EXPIRY'] },
          ...branchWhere(ctx.branchScope),
          ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
        },
        include: { variant: { select: { sku: true, product: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
      });

      const byType = new Map<string, { quantity: Prisma.Decimal; value: Prisma.Decimal; count: number }>();
      for (const m of movements) {
        const current = byType.get(m.movementType) ?? { quantity: new Prisma.Decimal(0), value: new Prisma.Decimal(0), count: 0 };
        current.quantity = current.quantity.plus(m.quantityBase.abs());
        current.value = current.value.plus(m.quantityBase.abs().times(m.unitCostAtMovement));
        current.count += 1;
        byType.set(m.movementType, current);
      }

      const summary = [...byType.entries()].map(([movementType, v]) =>
        applyVisibility({ movementType, quantity: v.quantity.toString(), movementValue: v.value.toString(), movementCount: v.count }, ctx.visibility),
      );

      const start = (query.page - 1) * query.limit;
      const rows = movements.slice(start, start + query.limit).map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        movementType: m.movementType,
        sku: m.variant.sku,
        productName: m.variant.product.name,
        quantity: m.quantityBase.abs().toString(),
        reason: m.reason,
        unitCostAtMovement: m.unitCostAtMovement.toString(),
        movementValue: m.quantityBase.abs().times(m.unitCostAtMovement).toString(),
      }));

      return {
        data: applyVisibilityToRows(rows, ctx.visibility),
        summary,
        pagination: { page: query.page, limit: query.limit, total: movements.length, totalPages: Math.ceil(movements.length / query.limit) },
        range: { from: ctx.range.from.toISOString(), to: ctx.range.toExclusive.toISOString(), timezone: ctx.range.timezone },
      };
    });
  }

  /**
   * Variants holding stock with no SALE movement in the last `days`.
   * "Slow" is defined purely by observed sales activity in the ledger -
   * no invented threshold, unlike Low Stock which has no source at all.
   */
  async slowMoving(actor: RequestUser, query: SlowMovingQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const permissions = await this.effectivePermissions.get(tx, actor.id);
      if (!permissions) throw new ForbiddenDomainError('Insufficient permissions');
      const branchScope = await resolveBranchScope(tx, actor.tenantId, actor.id, permissions, query.branchId);
      const visibility = resolveVisibility(permissions);

      const cutoff = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);

      const warehouseFilter =
        branchScope.allowedBranchIds === null
          ? query.warehouseId
            ? { id: query.warehouseId }
            : undefined
          : { branchId: { in: branchScope.allowedBranchIds }, ...(query.warehouseId ? { id: query.warehouseId } : {}) };

      const balances = await tx.stockBalance.findMany({
        where: {
          businessId: actor.tenantId,
          quantityOnHand: { gt: 0 },
          ...(warehouseFilter ? { warehouse: warehouseFilter } : {}),
        },
        include: { variant: { select: { sku: true, product: { select: { name: true } } } }, warehouse: { select: { id: true, name: true } } },
      });

      const recentlySold = await tx.stockMovement.findMany({
        where: {
          businessId: actor.tenantId,
          movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] },
          createdAt: { gte: cutoff },
          ...branchWhere(branchScope),
        },
        select: { variantId: true },
        distinct: ['variantId'],
      });
      const soldRecently = new Set(recentlySold.map((m) => m.variantId));

      const lastSaleByVariant = new Map<string, Date>();
      const anySale = await tx.stockMovement.findMany({
        where: { businessId: actor.tenantId, movementType: { in: ['SALE', 'BUNDLE_CONSUMPTION'] }, ...branchWhere(branchScope) },
        select: { variantId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      for (const m of anySale) {
        if (!lastSaleByVariant.has(m.variantId)) lastSaleByVariant.set(m.variantId, m.createdAt);
      }

      const slow = balances
        .filter((b) => !soldRecently.has(b.variantId))
        .map((b) => ({
          variantId: b.variantId,
          sku: b.variant.sku,
          productName: b.variant.product.name,
          warehouseId: b.warehouse.id,
          warehouseName: b.warehouse.name,
          quantityOnHand: b.quantityOnHand.toString(),
          lastSaleAt: lastSaleByVariant.get(b.variantId)?.toISOString() ?? null,
          daysWithoutSale: query.days,
          averageCost: b.averageCost.toString(),
          inventoryValue: b.quantityOnHand.times(b.averageCost).toString(),
        }));

      const start = (query.page - 1) * query.limit;
      return {
        data: applyVisibilityToRows(slow.slice(start, start + query.limit), visibility),
        pagination: { page: query.page, limit: query.limit, total: slow.length, totalPages: Math.ceil(slow.length / query.limit) },
        criteria: { days: query.days, definition: 'Variants with stock on hand and no SALE/BUNDLE_CONSUMPTION movement within the window.' },
      };
    });
  }
}
