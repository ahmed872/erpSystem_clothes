import { Injectable } from '@nestjs/common';
import type { SerialLookupQuery } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { NotFoundDomainError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Phase 12 (POS loose ends, approved decision D4) — the customer arrives
 * holding the thing, and nothing else.
 *
 * THE GAP THIS CLOSES. Returns, Exchanges and Warranty all begin by
 * finding the SALE, and the only way in was the sale number printed on a
 * receipt. A customer who has lost the receipt but is holding a
 * serial-numbered unit could not be served at all — the serial is stamped
 * on the box in their hands and the shop's own record of selling it was
 * unreachable.
 *
 * EXACT, NEVER BROWSING. `serial` is matched by equality against
 * `@@unique([businessId, serial])`, so this answers "which sale sold THIS
 * unit" and cannot enumerate. There is deliberately no prefix search, no
 * wildcard and no listing: `GET /inventory/serials` already exists for
 * stock work behind `inventory.view`, and widening a till's reach to the
 * shop's whole serial inventory was explicitly not approved.
 *
 * MINIMUM NECESSARY INFORMATION. What comes back is what the two
 * downstream workflows need to start: which unit, which sale, which line,
 * and — for Warranty — the serial's own id. No cost, no margin, no
 * customer contact details, no other unit on the sale. A serial received
 * but never sold resolves to `sale: null` rather than 404, because "we
 * have this unit, it has not been sold" is a true and useful answer at a
 * counter; a serial belonging to nobody in this tenant is a 404.
 *
 * The identity comes from `SaleItemSerial` — the append-only link written
 * in the same transaction as the SALE movement that consumed the unit —
 * so this reports the sale that actually delivered it, not a guess from
 * the variant. A unit sold, returned and sold again reports its LATEST
 * sale, which is the one a customer at the counter is asking about.
 */
@Injectable()
export class LookupSerialUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(actor: RequestUser, query: SerialLookupQuery) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const serial = await tx.serialNumber.findFirst({
        where: { businessId: actor.tenantId, serial: query.serial },
        select: {
          id: true,
          serial: true,
          status: true,
          variantId: true,
          variant: { select: { sku: true, product: { select: { name: true, alternativeName: true } } } },
        },
      });
      if (!serial) throw new NotFoundDomainError('SerialNumber', query.serial);

      const link = await tx.saleItemSerial.findFirst({
        where: { businessId: actor.tenantId, serialNumberId: serial.id },
        orderBy: { createdAt: 'desc' },
        select: {
          saleItemId: true,
          sale: { select: { id: true, saleNumber: true, createdAt: true, customer: { select: { id: true, name: true } } } },
        },
      });

      return {
        serialNumberId: serial.id,
        serial: serial.serial,
        status: serial.status,
        variantId: serial.variantId,
        sku: serial.variant.sku,
        productName: serial.variant.product.name,
        alternativeName: serial.variant.product.alternativeName,
        sale: link
          ? {
              id: link.sale.id,
              saleNumber: link.sale.saleNumber,
              soldAt: link.sale.createdAt,
              saleItemId: link.saleItemId,
              customer: link.sale.customer,
            }
          : null,
      };
    });
  }
}
