import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CreateSaleReturnInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { InventoryEngineService } from '../../../../engines/inventory/inventory-engine.service';
import { EffectivePermissionsService } from '../../../../common/authorization/effective-permissions.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { resolveAllowNegative } from '../../../inventory/domain/resolve-allow-negative';
import { lockSale } from '../../domain/lock-sale';
import { documentNumberFromId } from '../../../../common/domain/document-number';
import { assertIdempotentReplayMatches } from '../../../../common/domain/idempotency';
import { AccountingEngineService } from '../../../../engines/accounting/accounting-engine.service';
import { buildSaleReturnJournalLines } from '../../../accounting/domain/sale-return-journal-lines';
import { lineReturnCredit, saleCumulativeReturnCredit } from '../../domain/return-credit';
import { round4 } from '../../../../common/domain/money';
import { lockCustomer } from '../../../loyalty/domain/lock-customer';
import { findActiveShift } from '../../domain/find-active-shift';
import { recordCashTransaction } from '../../../finance/domain/record-cash-transaction';
import { TaxEngineService } from '../../../../engines/tax/tax-engine.service';
import { getCustomerPointsBalance } from '../../../loyalty/domain/customer-points-balance';
import { computeCumulativeClawback, computeCumulativeRestoration } from '../../../loyalty/domain/loyalty-returns';
import { disposeReturnedSerials } from '../../../inventory/domain/return-serials';

function saleReturnFingerprint(
  saleId: string,
  items: { saleItemId: string; quantity: Prisma.Decimal.Value; condition: string; serials?: string[] }[],
  refund?: { method: string; amount: Prisma.Decimal.Value; reference?: string },
) {
  return {
    saleId,
    // Phase 10 (BD-23): the tender handed back is part of the request, so
    // replaying a key that refunded 50 in CASH with one refunding 50 by
    // CARD - or refunding nothing at all - must be rejected rather than
    // silently returning the first return. Money leaving the drawer and
    // money leaving a card terminal are not the same event.
    refund: refund ? { method: refund.method, amount: new Prisma.Decimal(refund.amount).toString() } : null,
    items: items
      .map((i) => ({
        saleItemId: i.saleItemId,
        quantity: new Prisma.Decimal(i.quantity).toString(),
        condition: i.condition,
        // Phase 8E: which physical units are coming back is part of the
        // request, so replaying a key with different serials must be
        // rejected rather than silently accepted.
        serials: [...(i.serials ?? [])].sort(),
      }))
      .sort((a, b) => a.saleItemId.localeCompare(b.saleItemId)),
  };
}

/**
 * A sale return is a single-step atomic action (not a draft/confirm
 * workflow), mirroring PurchaseReturn - but WITH idempotencyKey from day
 * one, correcting Known Issue #23 rather than reproducing it.
 *
 * Returnable quantity rule: bounded by `SaleItem.quantity -
 * SaleItem.quantityReturned` per line, protected under the SAME
 * Sale-row lock CreateSalePaymentUseCase uses, so two concurrent returns
 * against the same line can never together over-return it.
 *
 * SELLABLE condition: posts a real SALES_RETURN increase, costed at the
 * ORIGINAL sale's own unit_cost_at_movement (looked up from that
 * specific StockMovement, carried over exactly - never fabricated or
 * defaulted to today's average cost, the same non-fabrication principle
 * Stock Transfers use). DAMAGED condition: the same SALES_RETURN
 * increase is posted (the goods DID physically come back), immediately
 * followed by a DAMAGE decrease of the same quantity at the engine's
 * current average cost (standard decrease-costing rule, zero
 * special-casing) - net stock effect zero, but both real events stay
 * visible in the ledger. The customer credit is posted identically
 * regardless of condition - a damaged return is the store's inventory
 * loss to absorb, not the customer's.
 *
 * Bundle-type SaleItems cannot be returned in v1 (see Known Issues) -
 * rejected explicitly rather than silently mishandled.
 */
@Injectable()
export class CreateSaleReturnUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngineService,
    private readonly effectivePermissions: EffectivePermissionsService,
    private readonly accounting: AccountingEngineService,
    private readonly tax: TaxEngineService,
  ) {}

  async execute(actor: RequestUser, saleId: string, input: CreateSaleReturnInput) {
    return this.prisma.withTenant(actor.tenantId, (tx) => this.executeInTx(tx, actor, saleId, input));
  }

  /**
   * The whole of a return, inside a transaction the CALLER owns - see
   * `CreateSaleUseCase.executeInTx` for why the split exists.
   */
  async executeInTx(
    tx: TenantTx,
    actor: RequestUser,
    saleId: string,
    input: CreateSaleReturnInput,
    /**
     * Phase 10 (Exchanges): SERVER-SET, never reachable from a request.
     * When true this return is one half of an exchange, so its entire
     * credit is parked in the exchange clearing account instead of being
     * handed back as money or left on a ledger, and the replacement sale
     * created immediately afterwards debits the same account by the same
     * figure. A client that could set this could settle a return with
     * nothing at all, which is why it is a parameter and not a field.
     */
    settledByExchange = false,
  ) {
    if (input.idempotencyKey) {
      const existing = await tx.saleReturn.findFirst({
        where: { businessId: actor.tenantId, idempotencyKey: input.idempotencyKey },
        include: { items: { include: { serials: { include: { serialNumber: { select: { serial: true } } } } } } },
      });
      if (existing) {
        assertIdempotentReplayMatches(
          saleReturnFingerprint(
            existing.saleId,
            // The serials actually returned are rebuilt from the
            // append-only link rows, so a replay carrying DIFFERENT
            // physical units is rejected rather than silently handed
            // the original return.
            existing.items.map((i) => ({ ...i, serials: i.serials.map((x) => x.serialNumber.serial) })),
            // Rebuilt from what was STORED, so the comparison is against
            // the refund that actually happened, never a re-read of the
            // incoming request.
            existing.refundMethod && existing.refundAmount
              ? { method: existing.refundMethod, amount: existing.refundAmount }
              : undefined,
          ),
          saleReturnFingerprint(saleId, input.items, input.refund),
        );

        // The credit figure is rebuilt from what was STORED - the refund
        // tender on the row and the customer-ledger credit it wrote -
        // never recomputed from today's configuration (non-negotiable #8).
        //
        // On an EXCHANGE half both are zero by design: the credit went to
        // the clearing account, and `CreateExchangeUseCase` reads the real
        // figure back from the replacement sale's own EXCHANGE_CREDIT
        // payment row, which is where that fact is actually stored.
        const ledgerRow = await tx.customerTransaction.findFirst({
          where: { businessId: actor.tenantId, referenceType: 'SaleReturn', referenceId: existing.id, type: 'SALE_RETURN' },
          select: { amount: true },
        });
        const storedRefund = existing.refundAmount ?? new Prisma.Decimal(0);
        const storedLedger = ledgerRow ? ledgerRow.amount.negated() : new Prisma.Decimal(0);
        return Object.assign(existing, { totalRefundable: round4(storedRefund.plus(storedLedger)) });
      }
    }

    // Canonical lock order across the whole system is
    // Customer -> Sale -> StockBalance. The customer must be locked
    // BEFORE the sale (and therefore before any StockBalance lock taken
    // by applyMovement below), because CreateSaleUseCase locks the
    // customer before its own stock locks - the opposite order here
    // would let a concurrent sale and return deadlock on
    // customer-vs-stock. Resolved with a cheap unlocked read first,
    // since the sale row is what tells us who the customer is.
    const saleOwner = await tx.sale.findFirst({
      where: { id: saleId, businessId: actor.tenantId },
      select: { customerId: true },
    });
    if (!saleOwner) throw new NotFoundDomainError('Sale', saleId);
    if (saleOwner.customerId) {
      await lockCustomer(tx, actor.tenantId, saleOwner.customerId);
    }

    await lockSale(tx, actor.tenantId, saleId);
    const sale = await tx.sale.findFirst({
      where: { id: saleId, businessId: actor.tenantId },
      include: { items: { include: { variant: { include: { product: true } } } } },
    });
    if (!sale) throw new NotFoundDomainError('Sale', saleId);

    const itemIds = input.items.map((i) => i.saleItemId);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new ValidationFailedError('Duplicate saleItemId in return request');
    }
    const itemsById = new Map(sale.items.map((i) => [i.id, i]));
    for (const line of input.items) {
      const saleItem = itemsById.get(line.saleItemId);
      if (!saleItem) throw new NotFoundDomainError('SaleItem', line.saleItemId);
      if (saleItem.variant.product.type === 'BUNDLE') {
        throw new ValidationFailedError('Bundle sale items cannot be returned - return the individual components instead', {
          saleItemId: saleItem.id,
        });
      }

      // Phase 8E / BD-14: a serial-tracked line must name the exact
      // units coming back. A partial return of a multi-serial line is
      // otherwise ambiguous about which physical item the customer
      // handed over, and the warranty auto-void below needs to know.
      const tracksSerials = saleItem.variant.product.tracksSerialNumbers;
      const suppliedSerials = line.serials ?? [];
      if (tracksSerials && suppliedSerials.length === 0) {
        throw new ValidationFailedError(
          'This product is serial-tracked - the serial number(s) being returned must be supplied for this line',
          { saleItemId: saleItem.id },
        );
      }
      if (!tracksSerials && suppliedSerials.length > 0) {
        throw new ValidationFailedError('This product is not serial-tracked - serial numbers cannot be supplied for this line', {
          saleItemId: saleItem.id,
        });
      }
      if (tracksSerials && !new Prisma.Decimal(line.quantity).equals(suppliedSerials.length)) {
        throw new ValidationFailedError('The number of serials supplied must equal the quantity being returned for this line', {
          saleItemId: saleItem.id,
          quantity: new Prisma.Decimal(line.quantity).toString(),
          serialsSupplied: suppliedSerials.length,
        });
      }

      const available = saleItem.quantity.minus(saleItem.quantityReturned);
      if (new Prisma.Decimal(line.quantity).greaterThan(available)) {
        throw new ConflictDomainError(
          `Cannot return ${line.quantity} of variant ${saleItem.variantId} - only ${available.toString()} is available to return`,
          { saleItemId: saleItem.id, available: available.toString(), requested: line.quantity },
        );
      }
    }

    const permissions = await this.effectivePermissions.get(tx, actor.id);
    const allowNegative = await resolveAllowNegative(tx, actor.tenantId, permissions ?? new Set());

    const returnId = randomUUID();
    const saleReturn = await tx.saleReturn.create({
      data: {
        id: returnId,
        businessId: actor.tenantId,
        saleId,
        warehouseId: sale.warehouseId,
        returnNumber: documentNumberFromId('SRET', returnId),
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        // Phase 10 (BD-23): the refund tender is written HERE, in the
        // insert, not patched on afterwards - `sale_returns` is
        // append-only at the grant level (SELECT + INSERT, no UPDATE) and
        // that guarantee is preserved rather than relaxed to make this
        // feature fit. The amount is validated against the return credit
        // further down; a failure there rolls back this insert with it,
        // so an invalid refund can never persist.
        refundMethod: input.refund?.method,
        refundAmount: input.refund?.amount,
        refundReference: input.refund?.reference,
        createdBy: actor.id,
      },
    });

    let totalCredit = new Prisma.Decimal(0);
    /// Phase 10 (BD-18): the tax portion coming back, accumulated by the
    /// same cumulative-delta method as the merchandise credit.
    let totalTaxReversal = new Prisma.Decimal(0);
    let returnInCost = new Prisma.Decimal(0);
    let damageWriteOff = new Prisma.Decimal(0);
    for (const line of input.items) {
      const saleItem = itemsById.get(line.saleItemId)!;

      const originalMovement = await tx.stockMovement.findFirst({
        where: { businessId: actor.tenantId, referenceType: 'Sale', referenceId: saleId, variantId: saleItem.variantId, movementType: 'SALE' },
      });
      if (!originalMovement) {
        throw new ValidationFailedError('No original sale movement found for this line - sale data is inconsistent', {
          saleItemId: saleItem.id,
        });
      }

      await this.engine.applyMovement(tx, {
        businessId: actor.tenantId,
        branchId: sale.branchId,
        warehouseId: sale.warehouseId,
        variantId: saleItem.variantId,
        quantityDelta: line.quantity,
        movementType: 'SALES_RETURN',
        unitCostOverride: originalMovement.unitCostAtMovement,
        referenceType: 'SaleReturn',
        referenceId: saleReturn.id,
        reason: input.reason ?? `Sale return against ${sale.saleNumber}`,
        createdBy: actor.id,
        allowNegative,
      });
      returnInCost = returnInCost.plus(new Prisma.Decimal(line.quantity).times(originalMovement.unitCostAtMovement));

      if (line.condition === 'DAMAGED') {
        const damageResult = await this.engine.applyMovement(tx, {
          businessId: actor.tenantId,
          branchId: sale.branchId,
          warehouseId: sale.warehouseId,
          variantId: saleItem.variantId,
          quantityDelta: new Prisma.Decimal(line.quantity).negated(),
          movementType: 'DAMAGE',
          referenceType: 'SaleReturn',
          referenceId: saleReturn.id,
          reason: 'Returned item damaged - written off, not returned to sellable stock',
          createdBy: actor.id,
          allowNegative,
        });
        damageWriteOff = damageWriteOff.plus(new Prisma.Decimal(line.quantity).times(damageResult.movement.unitCostAtMovement));
      }

      const createdReturnItem = await tx.saleReturnItem.create({
        data: {
          businessId: actor.tenantId,
          saleReturnId: saleReturn.id,
          saleItemId: saleItem.id,
          variantId: saleItem.variantId,
          quantity: line.quantity,
          unitPrice: saleItem.unitPrice,
          condition: line.condition,
        },
      });

      // BD-22 (superseding BD-14): the returned unit takes the SAME
      // disposition the line already declared for the goods - SELLABLE
      // puts it back on the shelf, DAMAGED writes it off - rather than
      // sitting in a quarantine state waiting for an inspection workflow
      // that was deferred. Run AFTER the stock movements above so the
      // lock sequence stays Customer -> Sale -> StockBalance ->
      // SerialNumber.
      if (saleItem.variant.product.tracksSerialNumbers) {
        const returnedSerialIds = await disposeReturnedSerials(
          tx,
          actor.tenantId,
          saleItem.id,
          line.serials ?? [],
          line.condition,
          sale.warehouseId,
        );

        // BD-15: any warranty still covering a returned unit is voided
        // automatically, atomically with this return. The warranty row
        // is never deleted and its snapshotted dates are never
        // rewritten - only the approved status transition occurs, so a
        // voided warranty remains a full historical record of what was
        // once promised.
        for (const serialNumberId of returnedSerialIds) {
          await tx.saleReturnItemSerial.create({
            data: {
              businessId: actor.tenantId,
              saleReturnId: saleReturn.id,
              saleReturnItemId: createdReturnItem.id,
              serialNumberId,
              // BD-22: the permanent record of what was decided for this
              // unit. The serial's own status will change the next time
              // it is sold; this will not.
              condition: line.condition,
            },
          });
        }

        if (returnedSerialIds.length > 0) {
          const voided = await tx.warranty.updateMany({
            where: {
              businessId: actor.tenantId,
              saleItemId: saleItem.id,
              serialNumberId: { in: returnedSerialIds },
              status: { not: 'VOID' },
            },
            data: { status: 'VOID', notes: `Voided automatically: unit returned on ${saleReturn.returnNumber}` },
          });
          if (voided.count > 0) {
            await this.audit.record(tx, {
              businessId: actor.tenantId,
              userId: actor.id,
              action: 'UPDATE',
              entityType: 'Warranty',
              entityId: saleItem.id,
              after: { status: 'VOID', voidedCount: voided.count },
              reason: `Warranty voided automatically by return ${saleReturn.returnNumber}`,
            });
          }
        }
      }

      await tx.saleItem.update({
        where: { id: saleItem.id },
        data: { quantityReturned: saleItem.quantityReturned.plus(line.quantity) },
      });

      // BD-1: the credit is the line's HISTORICAL merchandise value
      // apportioned by cumulative returned quantity - NOT
      // `quantity x unitPrice`, which ignored `discountAmount` and
      // over-refunded every discounted line (a Buy-2-Get-1 line paid
      // 200 refunded 300). The single shared definition in
      // return-credit.ts is used by the refund, the loyalty clawback
      // and the redemption restoration alike, so no two of them can
      // ever disagree about how much of the sale came back.
      totalCredit = totalCredit.plus(lineReturnCredit(saleItem, line.quantity));

      // Phase 10 (BD-18): the TAX on the returned units reverses too - the
      // customer paid it, so it comes back with the merchandise.
      //
      // Apportioned by BD-1's CUMULATIVE method rather than a per-return
      // proportion. This is not decoration: naive per-return proportions
      // drift by fractions that accumulate, which is precisely the defect
      // BD-1 exists to eliminate. Three partial returns of a line reverse
      // EXACTLY the tax that was charged - never a fraction more or less.
      const taxBefore = this.tax.cumulativeLineTax(saleItem.taxAmount, saleItem.quantity, saleItem.quantityReturned);
      const taxAfter = this.tax.cumulativeLineTax(
        saleItem.taxAmount,
        saleItem.quantity,
        saleItem.quantityReturned.plus(line.quantity),
      );
      totalTaxReversal = totalTaxReversal.plus(taxAfter.minus(taxBefore));
    }

    // ---------------------------------------------------------------
    // Phase 8C: LOYALTY CONSEQUENCES OF THE RETURN, in this same
    // transaction. Both are CUMULATIVE-DELTA calculations driven by the
    // SAME return credit the refund above uses, so a sequence of
    // partial returns telescopes to exactly the original amounts
    // instead of accumulating rounding drift.
    //
    // Every input is a historical snapshot - the original EARN/REDEEM
    // rows' own points/basisAmount/rateSnapshot plus the Sale's own
    // immutable subtotal/discountAmount. Current loyalty settings are
    // never read, so a rate changed after the sale cannot alter what is
    // clawed back or restored.
    //
    // Nothing here mutates or deletes a historical ledger row: both are
    // new compensating INSERTs, and `erp_app` holds no UPDATE or DELETE
    // privilege on customer_points to do otherwise.
    // ---------------------------------------------------------------
    if (sale.customerId) {
      // Re-read the lines AFTER this return's quantityReturned updates
      // above, so `C` is the sale's cumulative position including this
      // return.
      const linesAfter = await tx.saleItem.findMany({ where: { saleId: sale.id, businessId: actor.tenantId } });
      const cumulativeCredit = saleCumulativeReturnCredit(linesAfter);
      const saleMerchandiseAmount = sale.subtotal.minus(sale.discountAmount);

      const loyaltyEvents = await tx.customerPoints.findMany({
        where: { businessId: actor.tenantId, customerId: sale.customerId, referenceType: 'Sale', referenceId: sale.id },
      });
      const priorReturns = await tx.customerPoints.findMany({
        where: {
          businessId: actor.tenantId,
          customerId: sale.customerId,
          referenceType: 'SaleReturn',
          referenceId: { in: (await tx.saleReturn.findMany({ where: { saleId: sale.id, businessId: actor.tenantId }, select: { id: true } })).map((r) => r.id) },
        },
      });

      // BD-8: restore the customer's own spent points, proportionally
      // and cumulatively. Written BEFORE the clawback so the balance
      // assertion at the end sees the return's true net effect.
      const redeemRow = loyaltyEvents.find((e) => e.type === 'REDEEM');
      if (redeemRow && redeemRow.basisAmount) {
        const alreadyRestoredPoints = priorReturns
          .filter((e) => e.type === 'REDEMPTION_RESTORATION')
          .reduce((sum, e) => sum.plus(e.points), new Prisma.Decimal(0));
        const alreadyRestoredValue = priorReturns
          .filter((e) => e.type === 'REDEMPTION_RESTORATION')
          .reduce((sum, e) => sum.plus(e.basisAmount ?? 0), new Prisma.Decimal(0));

        const restoration = computeCumulativeRestoration(
          redeemRow.points.negated(),
          redeemRow.basisAmount,
          saleMerchandiseAmount,
          cumulativeCredit,
          alreadyRestoredPoints,
          alreadyRestoredValue,
        );
        if (restoration.points.greaterThan(0)) {
          await tx.customerPoints.create({
            data: {
              businessId: actor.tenantId,
              customerId: sale.customerId,
              type: 'REDEMPTION_RESTORATION',
              points: restoration.points,
              basisAmount: restoration.value,
              // The ORIGINAL rate, never today's - this row records what
              // those points were worth when they were spent.
              rateSnapshot: redeemRow.rateSnapshot,
              referenceType: 'SaleReturn',
              referenceId: saleReturn.id,
              description: `Redeemed points restored on return ${saleReturn.returnNumber}`,
              createdBy: actor.id,
            },
          });
        }
      }

      // Approved rule 6.2: claw back the points earned on the portion
      // of the sale that came back, using the ORIGINAL earning basis
      // and rate snapshot.
      const earnRow = loyaltyEvents.find((e) => e.type === 'EARN');
      if (earnRow && earnRow.basisAmount && earnRow.rateSnapshot) {
        const alreadyClawedBack = priorReturns
          .filter((e) => e.type === 'RETURN_CLAWBACK')
          .reduce((sum, e) => sum.plus(e.points.negated()), new Prisma.Decimal(0));

        const clawback = computeCumulativeClawback(
          earnRow.points,
          earnRow.basisAmount,
          earnRow.rateSnapshot,
          cumulativeCredit,
          alreadyClawedBack,
        );
        if (clawback.greaterThan(0)) {
          await tx.customerPoints.create({
            data: {
              businessId: actor.tenantId,
              customerId: sale.customerId,
              type: 'RETURN_CLAWBACK',
              points: clawback.negated(),
              basisAmount: totalCredit,
              rateSnapshot: earnRow.rateSnapshot,
              referenceType: 'SaleReturn',
              referenceId: saleReturn.id,
              description: `Points clawed back on return ${saleReturn.returnNumber}`,
              createdBy: actor.id,
            },
          });
        }
      }

      // The approved rule forbids a negative loyalty balance. The check
      // is made on the balance the return actually LEAVES BEHIND -
      // after both the restoration and the clawback - because the two
      // are effects of one atomic return. Checking the clawback alone
      // would reject returns that are in fact fully funded by their own
      // restoration. If it fails, the ENTIRE return is rejected: no
      // refund, no stock movement, no journal entry, no ledger row.
      const finalBalance = await getCustomerPointsBalance(tx, actor.tenantId, sale.customerId);
      if (finalBalance.lessThan(0)) {
        throw new ConflictDomainError(
          'This return cannot be processed: the loyalty points earned on this sale have already been spent, and clawing them back would leave a negative balance',
          { customerId: sale.customerId, resultingBalance: finalBalance.toString() },
        );
      }
    }

    // ---------------------------------------------------------------
    // Phase 10 (BD-23): the refund tender.
    // ---------------------------------------------------------------
    const refundAmount = input.refund ? round4(new Prisma.Decimal(input.refund.amount)) : new Prisma.Decimal(0);

    // Phase 10 (BD-18): what the customer actually gets back is the
    // merchandise credit PLUS the tax they paid on it. The merchandise
    // figure alone stays the basis for every loyalty calculation (BD-3 is
    // explicitly net of discounts and BEFORE tax), so the two are kept
    // separate rather than merged.
    const totalRefundable = round4(totalCredit.plus(totalTaxReversal));

    if (refundAmount.greaterThan(totalRefundable)) {
      throw new ValidationFailedError('The refund cannot exceed the credit due for this return', {
        refundAmount: refundAmount.toString(),
        returnCredit: totalRefundable.toString(),
      });
    }

    // Phase 10 (Exchanges): the exchange half carries no refund of its
    // own - the credit is settled by the replacement sale - so a caller
    // supplying one would be describing money that does not move.
    if (settledByExchange && refundAmount.greaterThan(0)) {
      throw new ValidationFailedError('The returned half of an exchange is settled by the replacement sale, not by a refund');
    }

    // A walk-in has no ledger for a remainder to sit on, so the refund
    // must settle the whole credit. This is FORCED BY THE DATA MODEL,
    // not an invented policy - it is the same shape as the existing rule
    // that a walk-in SALE must be paid in full. Without it, the
    // difference would simply vanish.
    //
    // An exchange settles the credit through the replacement sale rather
    // than a tender, so the rule is satisfied by construction and the
    // check does not apply.
    if (!settledByExchange && !sale.customerId && totalRefundable.greaterThan(0) && !refundAmount.equals(totalRefundable)) {
      throw new ValidationFailedError(
        'A walk-in return must be refunded in full - there is no customer account for the balance to sit on',
        { returnCredit: totalRefundable.toString(), refundAmount: refundAmount.toString() },
      );
    }

    if (input.refund && refundAmount.greaterThan(0)) {
      // A CASH refund is physical money leaving the drawer, so it enters
      // the shift's ledger in this same transaction - the counterpart of
      // the SALE_TENDER row a cash sale writes. Without this, every
      // refunding shift would show a phantom shortage its cashier could
      // not explain.
      if (input.refund.method === 'CASH') {
        const shift = await findActiveShift(tx, actor.tenantId, actor.id);
        if (!shift) {
          throw new ConflictDomainError('An open shift is required to refund cash');
        }
        await recordCashTransaction(tx, {
          businessId: actor.tenantId,
          shiftId: shift.id,
          type: 'SALE_REFUND',
          amount: refundAmount,
          referenceType: 'SaleReturn',
          referenceId: saleReturn.id,
          reason: `Refund on return ${saleReturn.returnNumber}`,
          createdBy: actor.id,
        });
      }
    }

    // The customer's ledger takes only what was NOT handed back in cash -
    // and, on an exchange, nothing at all: the whole credit is spent on
    // the replacement, so posting it to the ledger as well would credit
    // the customer twice for one set of goods.
    const ledgerCredit = settledByExchange ? new Prisma.Decimal(0) : round4(totalRefundable.minus(refundAmount));
    if (sale.customerId && ledgerCredit.greaterThan(0)) {
      await tx.customerTransaction.create({
        data: {
          businessId: actor.tenantId,
          customerId: sale.customerId,
          type: 'SALE_RETURN',
          amount: ledgerCredit.negated(),
          referenceType: 'SaleReturn',
          referenceId: saleReturn.id,
          description: `Sale return credit against ${sale.saleNumber}`,
          createdBy: actor.id,
        },
      });
    }

    // Phase 6: post the accounting fact for this return in the SAME
    // transaction - see buildSaleReturnJournalLines's doc comment for
    // the walk-in-return revenue-reversal limitation.
    const returnJournalLines = await buildSaleReturnJournalLines(tx, actor.tenantId, {
      customerId: sale.customerId,
      totalCredit,
      taxReversal: totalTaxReversal,
      returnInCost,
      damageWriteOff,
      refund: settledByExchange
        ? // The exchange half's entire credit goes to the clearing
          // account, expressed as an EXCHANGE_CREDIT "tender". The
          // replacement sale debits the same account by the same figure,
          // so the pair nets to exactly zero.
          { method: 'EXCHANGE_CREDIT' as const, amount: totalRefundable }
        : input.refund && refundAmount.greaterThan(0)
          ? { method: input.refund.method, amount: refundAmount }
          : null,
    });
    if (returnJournalLines.length > 0) {
      await this.accounting.postEntry(tx, {
        businessId: actor.tenantId,
        entryDate: new Date(),
        sourceType: 'SaleReturn',
        sourceId: saleReturn.id,
        description: `Sale return ${saleReturn.returnNumber}`,
        createdBy: actor.id,
        lines: returnJournalLines,
      });
    }

    const finalReturn = await tx.saleReturn.findUniqueOrThrow({ where: { id: saleReturn.id }, include: { items: true } });

    await this.audit.record(tx, {
      businessId: actor.tenantId,
      userId: actor.id,
      action: 'CREATE',
      entityType: 'SaleReturn',
      entityId: saleReturn.id,
      after: finalReturn,
      reason: input.reason ?? 'Sale return',
    });

    // Phase 10 (Exchanges): the caller needs the credit figure to settle
    // the replacement sale with. Attached to the row rather than returned
    // as a separate shape, so `execute`'s HTTP contract stays exactly what
    // every other caller already expects.
    //
    // ONLY `totalRefundable` is surfaced. The merchandise/tax split is a
    // detail of how the credit was reached and nothing outside this
    // use-case needs it - and on an idempotent replay it could only be
    // produced by recomputing history, which non-negotiable #8 forbids.
    return Object.assign(finalReturn, { totalRefundable });
  }
}
