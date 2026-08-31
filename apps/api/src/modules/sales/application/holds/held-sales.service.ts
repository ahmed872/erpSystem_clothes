import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type {
  CreateHeldSaleInput,
  UpdateHeldSaleInput,
  ResumeHeldSaleInput,
  VoidHeldSaleInput,
  HeldSaleListQuery,
} from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { findActiveShift } from '../../domain/find-active-shift';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { CreateSaleUseCase } from '../sales/create-sale.use-case';

/**
 * Phase 10 (approved resolution of BLOCKING-2) — HOLD / RESUME, as a SOFT
 * hold.
 *
 * A parked basket is a SEPARATE entity and never a `Sale` row with a HELD
 * status. No reporting query in this codebase filters on `Sale.status`, so
 * a held basket stored as a Sale would be counted as revenue, as tax owed
 * and as sold stock from the moment it was parked - silently, in every
 * report. A basket nobody has bought is not a sale.
 *
 * WHAT A HOLD DOES NOT DO. It moves no stock, writes no journal entry,
 * touches no drawer, and consumes no serial. Nothing about a hold is
 * financial. Its only mark outside its own two tables is the ADVISORY
 * `StockBalance.quantityReserved`, which the Inventory Engine reads for
 * nobody's decision: a parked basket can never stop a real customer at the
 * till from buying the goods in front of them. That is exactly what makes
 * the hold SOFT.
 *
 * RESUMING runs the UNCHANGED `CreateSaleUseCase` over the basket's lines.
 * The hold is a draft of a REQUEST, not a half-built sale, so checkout
 * re-runs the whole pipeline - promotions, loyalty, tax, serials, stock -
 * against the configuration in force AT CHECKOUT, exactly as if the
 * cashier had typed the basket in fresh. Prices are re-resolved and never
 * honoured from the draft, which is why parking a basket cannot lock in a
 * price that has since changed, and why a promotion that ended overnight
 * is not silently still applied in the morning.
 */
@Injectable()
export class HeldSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly sales: CreateSaleUseCase,
  ) {}

  // ------------------------------------------------------------------
  async create(actor: RequestUser, input: CreateHeldSaleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warehouse = await tx.warehouse.findFirst({
        where: { id: input.warehouseId, businessId: actor.tenantId },
        select: { id: true, branchId: true },
      });
      if (!warehouse) throw new NotFoundDomainError('Warehouse', input.warehouseId);

      // A hold belongs to the till it was taken at, so a shift can be
      // closed knowing what it left behind.
      const shift = await findActiveShift(tx, actor.tenantId, actor.id);
      if (!shift) throw new ConflictDomainError('An open shift is required to park a basket');

      assertNoDuplicateVariants(input.items);
      await assertVariantsExist(tx, actor.tenantId, input.items);

      const id = randomUUID();
      const held = await tx.heldSale.create({
        data: {
          id,
          businessId: actor.tenantId,
          branchId: warehouse.branchId,
          warehouseId: warehouse.id,
          customerId: input.customerId,
          shiftId: shift.id,
          holdNumber: documentNumberFromId('HOLD', id),
          label: input.label,
          notes: input.notes,
          createdBy: actor.id,
          items: {
            create: input.items.map((i) => ({
              businessId: actor.tenantId,
              variantId: i.variantId,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              discountAmount: i.discountAmount,
              taxExempt: i.taxExempt,
              serials: i.serials ?? [],
            })),
          },
        },
        include: { items: true },
      });

      await this.reserve(tx, actor.tenantId, warehouse.id, held.items, 1);

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'HeldSale',
        entityId: held.id,
        after: held,
      });

      return held;
    });
  }

  // ------------------------------------------------------------------
  async update(actor: RequestUser, id: string, input: UpdateHeldSaleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await this.lockOpen(tx, actor.tenantId, id);

      if (input.items) {
        assertNoDuplicateVariants(input.items);
        await assertVariantsExist(tx, actor.tenantId, input.items);

        // Release the old lines' reservation before claiming the new
        // ones, so a basket edited from 5 units to 3 leaves 3 reserved and
        // not 8.
        await this.reserve(tx, actor.tenantId, before.warehouseId, before.items, -1);
        await tx.heldSaleItem.deleteMany({ where: { businessId: actor.tenantId, heldSaleId: id } });
      }

      const after = await tx.heldSale.update({
        where: { id },
        data: {
          customerId: input.customerId === undefined ? undefined : input.customerId,
          label: input.label === undefined ? undefined : input.label,
          notes: input.notes === undefined ? undefined : input.notes,
          ...(input.items
            ? {
                items: {
                  create: input.items.map((i) => ({
                    businessId: actor.tenantId,
                    variantId: i.variantId,
                    quantity: i.quantity,
                    unitPrice: i.unitPrice,
                    discountAmount: i.discountAmount,
                    taxExempt: i.taxExempt,
                    serials: i.serials ?? [],
                  })),
                },
              }
            : {}),
        },
        include: { items: true },
      });

      if (input.items) {
        await this.reserve(tx, actor.tenantId, after.warehouseId, after.items, 1);
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'HeldSale',
        entityId: id,
        before,
        after,
      });

      return after;
    });
  }

  // ------------------------------------------------------------------
  /**
   * The basket becomes a real sale. ONE transaction: the hold is released
   * and closed in the same breath as the sale that consumed it, so there
   * is no window in which the goods have been sold and the basket is still
   * sitting there for someone else to resume.
   */
  async resume(actor: RequestUser, id: string, input: ResumeHeldSaleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const held = await this.lockOpen(tx, actor.tenantId, id);

      // The reservation is released FIRST. The Inventory Engine ignores it
      // either way, so this changes no outcome - but leaving it standing
      // while the same goods are being sold would make the "available"
      // figure understate the shelf by the very units just sold.
      await this.reserve(tx, actor.tenantId, held.warehouseId, held.items, -1);

      // The UNCHANGED sale pipeline, over the basket's lines. Prices are
      // re-resolved here, not honoured from the draft.
      const sale = await this.sales.executeInTx(tx, actor, {
        warehouseId: held.warehouseId,
        customerId: held.customerId ?? undefined,
        notes: input.notes ?? held.notes ?? undefined,
        idempotencyKey: input.idempotencyKey,
        items: held.items.map((i) => ({
          variantId: i.variantId,
          quantity: Number(i.quantity),
          unitPrice: Number(i.unitPrice),
          discountAmount: Number(i.discountAmount),
          taxExempt: i.taxExempt,
          serials: i.serials.length > 0 ? i.serials : undefined,
        })),
        payments: input.payments,
        redeemPoints: input.redeemPoints,
      });

      const after = await tx.heldSale.update({
        where: { id },
        data: { status: 'RESUMED', resumedSaleId: sale.id, resumedAt: new Date(), resumedBy: actor.id },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'HeldSale',
        entityId: id,
        before: held,
        after,
        reason: `Resumed as sale ${sale.saleNumber}`,
      });

      return { heldSale: after, sale };
    });
  }

  // ------------------------------------------------------------------
  async void(actor: RequestUser, id: string, input: VoidHeldSaleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const held = await this.lockOpen(tx, actor.tenantId, id);
      await this.reserve(tx, actor.tenantId, held.warehouseId, held.items, -1);

      const after = await tx.heldSale.update({
        where: { id },
        data: { status: 'VOIDED', voidedAt: new Date(), voidedBy: actor.id, voidReason: input.reason },
        include: { items: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'HeldSale',
        entityId: id,
        before: held,
        after,
        reason: input.reason ?? 'Held basket abandoned',
      });

      return after;
    });
  }

  // ------------------------------------------------------------------
  async list(actor: RequestUser, query: HeldSaleListQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const where = {
        businessId: actor.tenantId,
        status: query.status,
        ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
        ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      };
      const [total, data] = await Promise.all([
        tx.heldSale.count({ where }),
        tx.heldSale.findMany({
          where,
          include: { items: true },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);
      return { data, meta: { total, page: query.page, limit: query.limit } };
    });
  }

  async get(actor: RequestUser, id: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const held = await tx.heldSale.findFirst({
        where: { id, businessId: actor.tenantId },
        include: { items: true },
      });
      if (!held) throw new NotFoundDomainError('HeldSale', id);
      return held;
    });
  }

  // ------------------------------------------------------------------
  /**
   * Takes the hold row under a lock and refuses anything that is no longer
   * OPEN. This is what stops two cashiers resuming the same basket: the
   * second waits, sees RESUMED, and is refused - rather than both selling
   * the same goods twice.
   */
  private async lockOpen(tx: TenantTx, businessId: string, id: string) {
    const locked = await tx.$queryRawUnsafe<{ id: string; status: string }[]>(
      `SELECT id, status::text AS status FROM held_sales
        WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
      businessId,
      id,
    );
    if (locked.length === 0) throw new NotFoundDomainError('HeldSale', id);
    if (locked[0].status !== 'OPEN') {
      throw new ConflictDomainError('This basket is no longer open', { heldSaleId: id, status: locked[0].status });
    }
    return tx.heldSale.findUniqueOrThrow({ where: { id }, include: { items: true } });
  }

  /**
   * Moves the ADVISORY reservation counter, always through the Inventory
   * Engine - `stock_balances` is the engine's table and nothing else may
   * write it (non-negotiable #5), even for a number no decision depends on.
   *
   * Ordered by variantId, the same canonical ordering every stock lock in
   * this codebase uses, so a hold and a sale touching an overlapping set
   * cannot grab the rows in opposite orders and deadlock.
   */
  private async reserve(
    tx: TenantTx,
    businessId: string,
    warehouseId: string,
    items: { variantId: string; quantity: Prisma.Decimal }[],
    sign: 1 | -1,
  ) {
    for (const item of [...items].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      await this.engine.adjustReservation(tx, {
        businessId,
        warehouseId,
        variantId: item.variantId,
        quantityDelta: sign === 1 ? item.quantity : item.quantity.negated(),
      });
    }
  }
}

function assertNoDuplicateVariants(items: { variantId: string }[]) {
  const ids = items.map((i) => i.variantId);
  if (new Set(ids).size !== ids.length) {
    throw new ValidationFailedError('The same variant appears more than once in this basket');
  }
}

async function assertVariantsExist(tx: TenantTx, businessId: string, items: { variantId: string }[]) {
  const found = await tx.productVariant.findMany({
    where: { businessId, id: { in: items.map((i) => i.variantId) } },
    select: { id: true },
  });
  if (found.length !== items.length) {
    const known = new Set(found.map((v) => v.id));
    const missing = items.find((i) => !known.has(i.variantId))!;
    throw new NotFoundDomainError('ProductVariant', missing.variantId);
  }
}
