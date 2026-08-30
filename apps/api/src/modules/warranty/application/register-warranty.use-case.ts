import { Injectable } from '@nestjs/common';
import type { RegisterWarrantyInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { computeWarrantyEndDate, resolveWarrantyDurationDays } from '../domain/resolve-warranty-duration';

/**
 * Registers a warranty against ONE physical serial unit sold on ONE sale
 * line. Record-keeping only (approved Phase 8A scope): this use-case
 * injects neither InventoryEngineService nor AccountingEngineService, so
 * it structurally cannot produce a StockMovement or a JournalEntry.
 *
 * Validation, in order - every reference is checked against the caller's
 * own tenant before anything is written, the same convention every
 * Phase 4/5 use-case follows:
 *   1. The SaleItem exists in this tenant.
 *   2. Its product is SERIAL-TRACKED (approved decision 13). A
 *      non-serialized item cannot be warranted, because a warranty must
 *      identify exactly one physical unit and a non-serialized line has
 *      no way to say which one.
 *   3. The SerialNumber exists in this tenant AND belongs to the same
 *      variant as the sale line - otherwise a warranty could be attached
 *      to a serial of a completely different product.
 *   4. The duration resolves (override, else business default).
 *
 * `startDate` is always the SALE's own createdAt - never the registration
 * time, never client-supplied. The warranty period starts when the
 * customer took the goods.
 *
 * KNOWN ISSUE #47 IS CLOSED (Phase 8E). Sales now capture serial identity
 * at creation - mandatory for a serial-tracked variant - and record it in
 * the append-only `SaleItemSerial` link. This use-case therefore verifies
 * the real fact rather than a proxy: the supplied serial must be one this
 * SALE LINE actually sold.
 *
 * The old fallback (serial exists in the tenant and matches the variant)
 * is no longer sufficient on its own and is no longer relied upon, but it
 * is still applied as a defence-in-depth check before the link lookup.
 *
 * Duplicate protection is the (businessId, saleItemId, serialNumberId)
 * unique index - a DB-level guarantee, not an application pre-check
 * alone. The pre-check below exists only to return a friendlier 409 than
 * a raw unique-violation.
 */
@Injectable()
export class RegisterWarrantyUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, input: RegisterWarrantyInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const saleItem = await tx.saleItem.findFirst({
        where: { id: input.saleItemId, businessId: actor.tenantId },
        include: {
          sale: { select: { id: true, createdAt: true, customerId: true, saleNumber: true } },
          variant: { select: { id: true, sku: true, product: { select: { id: true, name: true, tracksSerialNumbers: true } } } },
        },
      });
      if (!saleItem) throw new NotFoundDomainError('SaleItem', input.saleItemId);

      if (!saleItem.variant.product.tracksSerialNumbers) {
        throw new ValidationFailedError(
          'A warranty can only be registered for a serial-tracked product - this sale line has no serial numbers to identify a specific unit',
          { saleItemId: saleItem.id, productId: saleItem.variant.product.id },
        );
      }

      const serialNumber = await tx.serialNumber.findFirst({
        where: { id: input.serialNumberId, businessId: actor.tenantId },
        select: { id: true, serial: true, variantId: true },
      });
      if (!serialNumber) throw new NotFoundDomainError('SerialNumber', input.serialNumberId);

      if (serialNumber.variantId !== saleItem.variantId) {
        throw new ValidationFailedError('This serial number belongs to a different product variant than the sale line', {
          serialNumberId: serialNumber.id,
          serialVariantId: serialNumber.variantId,
          saleItemVariantId: saleItem.variantId,
        });
      }

      // Known Issue #47 closure: the serial must be one this sale line
      // actually sold. `SaleItemSerial` is append-only and written in the
      // same transaction as the SALE movement that consumed the unit, so
      // its absence means this unit genuinely did not leave on this line.
      const soldOnThisLine = await tx.saleItemSerial.findFirst({
        where: { businessId: actor.tenantId, saleItemId: saleItem.id, serialNumberId: serialNumber.id },
        select: { id: true },
      });
      if (!soldOnThisLine) {
        throw new ValidationFailedError(
          'This serial number was not sold on this sale line - a warranty can only cover a unit the sale actually delivered',
          { saleItemId: saleItem.id, serialNumberId: serialNumber.id },
        );
      }

      const existing = await tx.warranty.findFirst({
        where: { businessId: actor.tenantId, saleItemId: saleItem.id, serialNumberId: serialNumber.id },
      });
      if (existing) {
        throw new ConflictDomainError('A warranty is already registered for this serial unit on this sale line', { warrantyId: existing.id });
      }

      const durationDays = await resolveWarrantyDurationDays(tx, actor.tenantId, input.durationDays);
      const startDate = saleItem.sale.createdAt;
      const endDate = computeWarrantyEndDate(startDate, durationDays);

      const warranty = await tx.warranty.create({
        data: {
          businessId: actor.tenantId,
          saleItemId: saleItem.id,
          serialNumberId: serialNumber.id,
          customerId: saleItem.sale.customerId,
          startDate,
          endDate,
          // Snapshotted: a later change to the business default never
          // reaches this row (approved decision BD-4).
          durationDays,
          notes: input.notes,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Warranty',
        entityId: warranty.id,
        after: warranty,
        reason: `Warranty registered for serial ${serialNumber.serial} on sale ${saleItem.sale.saleNumber}`,
      });

      return warranty;
    });
  }
}
