import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CreateSaleInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../../inventory/domain/resolve-allow-negative';
import { consumeVariant } from '../../../inventory/domain/consume-variant';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { findActiveShift } from '../../domain/find-active-shift';

/**
 * The Phase-5 equivalent of Purchasing's ReceivePurchaseUseCase: the ONE
 * place a completed Sale is created, and the ONLY place in Sales that
 * touches inventory - exclusively via the tx-accepting `consumeVariant`
 * helper (which itself calls InventoryEngineService.applyMovement),
 * inside the SAME transaction as:
 *   - the Sale/SaleItem insert (the document)
 *   - each line's inventory consumption (movementType SALE, or Bundle
 *     expansion via consumeVariant's existing logic)
 *   - the SalePayment insert(s) for whatever was tendered now
 *   - the CustomerTransaction ledger writes (only if customerId is set)
 * If any step fails, the whole transaction rolls back - there is no
 * window where inventory decreased but the Sale document, payment, or
 * customer ledger didn't, or vice versa (Phase 5 rule #5).
 *
 * Requires the acting user to hold an OPEN Shift for the SAME warehouse
 * being sold from (Phase 5 rule #2's "define and test the invariant"),
 * resolved server-side - never client-supplied, same convention as
 * branchId being derived from warehouseId rather than accepted as input.
 *
 * Lock-ordering (Phase 5 rule #3/#10): SaleItems are processed in
 * variantId order, not client-supplied order, before any StockBalance
 * lock is acquired - see consumeVariant's own doc comment for why this
 * also covers Bundle component ordering.
 */
@Injectable()
export class CreateSaleUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
  ) {}

  async execute(actor: RequestUser, input: CreateSaleInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.sale.findFirst({
          where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
          include: { items: true, payments: true },
        });
        if (existing) return existing;
      }

      const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, businessId: actor.tenantId } });
      if (!warehouse) throw new NotFoundDomainError('Warehouse', input.warehouseId);

      const shift = await findActiveShift(tx, actor.tenantId, actor.id);
      if (!shift) throw new ConflictDomainError('An open shift is required to complete a sale');
      if (shift.warehouseId !== input.warehouseId) {
        throw new ValidationFailedError('Your open shift is for a different warehouse - close it and open a new one to sell from this warehouse');
      }

      let customer = null;
      if (input.customerId) {
        customer = await tx.customer.findFirst({ where: { id: input.customerId, businessId: actor.tenantId } });
        if (!customer) throw new NotFoundDomainError('Customer', input.customerId);
        if (!customer.isActive) throw new ValidationFailedError('Cannot sell to an inactive customer');
      }

      const variantIds = input.items.map((i) => i.variantId);
      if (new Set(variantIds).size !== variantIds.length) {
        throw new ValidationFailedError('Duplicate variantId in sale items');
      }
      const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds }, businessId: actor.tenantId } });
      if (variants.length !== variantIds.length) {
        const found = new Set(variants.map((v) => v.id));
        throw new NotFoundDomainError('ProductVariant', variantIds.filter((id) => !found.has(id)).join(', '));
      }

      let subtotal = new Prisma.Decimal(0);
      let discountAmount = new Prisma.Decimal(0);
      let taxAmount = new Prisma.Decimal(0);
      for (const item of input.items) {
        subtotal = subtotal.plus(new Prisma.Decimal(item.unitPrice).times(item.quantity));
        discountAmount = discountAmount.plus(item.discountAmount);
        taxAmount = taxAmount.plus(item.taxAmount);
      }
      const totalAmount = subtotal.minus(discountAmount).plus(taxAmount);

      let paidNow = new Prisma.Decimal(0);
      for (const p of input.payments) paidNow = paidNow.plus(p.amount);
      if (paidNow.greaterThan(totalAmount)) {
        throw new ValidationFailedError('Payments exceed the sale total - overpayment/change-due is not tracked, tender the exact amount owed');
      }
      if (!input.customerId && !paidNow.equals(totalAmount)) {
        throw new ValidationFailedError('A walk-in sale (no customer) must be paid in full at the time of sale');
      }

      const id = randomUUID();
      const sale = await tx.sale.create({
        data: {
          id,
          businessId: actor.tenantId,
          branchId: warehouse.branchId,
          warehouseId: input.warehouseId,
          customerId: input.customerId,
          shiftId: shift.id,
          saleNumber: documentNumberFromId('INV', id),
          idempotencyKey: input.idempotencyKey,
          subtotal,
          discountAmount,
          taxAmount,
          totalAmount,
          notes: input.notes,
          createdBy: actor.id,
        },
      });

      const permissions = await this.effectivePermissions.get(tx, actor.id);
      const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

      // Canonical lock-acquisition order: sorted by variantId, never
      // client-supplied order (Phase 5 rule #3/#10).
      const sortedItems = [...input.items].sort((a, b) => a.variantId.localeCompare(b.variantId));
      for (const item of sortedItems) {
        const lineTotal = new Prisma.Decimal(item.unitPrice).times(item.quantity).minus(item.discountAmount).plus(item.taxAmount);

        await tx.saleItem.create({
          data: {
            businessId: actor.tenantId,
            saleId: sale.id,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountAmount: item.discountAmount,
            taxAmount: item.taxAmount,
            lineTotal,
          },
        });

        await consumeVariant(tx, this.engine, this.audit, {
          businessId: actor.tenantId,
          warehouseId: input.warehouseId,
          variantId: item.variantId,
          quantity: item.quantity,
          movementType: 'SALE',
          referenceType: 'Sale',
          referenceId: sale.id,
          reason: `Sale ${sale.saleNumber}`,
          createdBy: actor.id,
          allowNegative,
        });
      }

      for (const p of input.payments) {
        await tx.salePayment.create({
          data: {
            businessId: actor.tenantId,
            saleId: sale.id,
            amount: p.amount,
            method: p.method,
            reference: p.reference,
            receivedBy: actor.id,
          },
        });
      }

      if (input.customerId) {
        await tx.customerTransaction.create({
          data: {
            businessId: actor.tenantId,
            customerId: input.customerId,
            type: 'SALE',
            amount: totalAmount,
            referenceType: 'Sale',
            referenceId: sale.id,
            description: `Sale ${sale.saleNumber}`,
            createdBy: actor.id,
          },
        });
        for (const p of input.payments) {
          await tx.customerTransaction.create({
            data: {
              businessId: actor.tenantId,
              customerId: input.customerId,
              type: 'PAYMENT',
              amount: new Prisma.Decimal(p.amount).negated(),
              referenceType: 'Sale',
              referenceId: sale.id,
              description: `Payment at sale ${sale.saleNumber}`,
              createdBy: actor.id,
            },
          });
        }
      }

      const finalSale = await tx.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { items: true, payments: true } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Sale',
        entityId: sale.id,
        after: finalSale,
      });

      return finalSale;
    });
  }
}
