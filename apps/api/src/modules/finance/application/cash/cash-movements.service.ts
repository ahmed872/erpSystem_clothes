import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateCashMovementInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../../common/errors/domain-error';
import { assertIdempotentReplayMatches } from '../../../../common/domain/idempotency';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';
import { recordCashTransaction } from '../../domain/record-cash-transaction';

/**
 * Phase 10 (BD-17 rule 3) — manual pay-ins and pay-outs.
 *
 * Only MANUAL movements go through this endpoint. Sale tenders and refunds
 * are written by the sale and return use-cases themselves, inside the same
 * transaction as the document that caused them, so the drawer can never
 * disagree with the paperwork that moved it. Exposing an endpoint that
 * could hand-write a SALE_TENDER row would break exactly that guarantee,
 * so the request schema admits only PAY_IN and PAY_OUT.
 *
 * A movement belongs to the acting user's OWN open shift. Cash custody sits
 * with whoever is holding the drawer, so recording a pay-out against
 * somebody else's till is not something this endpoint allows.
 */
@Injectable()
export class CashMovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, shiftId: string, input: CreateCashMovementInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      // Lock the shift first: the same row every close and reconcile takes,
      // so a movement cannot slip in between a close reading the ledger and
      // writing the counted amount.
      const locked = await tx.$queryRawUnsafe<{ id: string; status: string; opened_by: string }[]>(
        `SELECT id, status::text AS status, opened_by
           FROM shifts
          WHERE business_id = $1 AND id = $2
            FOR UPDATE`,
        actor.tenantId,
        shiftId,
      );
      const shift = locked[0];
      if (!shift) throw new NotFoundDomainError('Shift', shiftId);
      if (shift.status !== 'OPEN') {
        throw new ConflictDomainError('Cash can only move through an open shift', { shiftId, status: shift.status });
      }
      if (shift.opened_by !== actor.id) {
        throw new ConflictDomainError('You can only record cash movements against your own open shift', { shiftId });
      }

      if (input.idempotencyKey) {
        const existing = await tx.cashTransaction.findFirst({
          where: {
            businessId: actor.tenantId,
            shiftId,
            referenceType: 'CashMovement',
            referenceId: input.idempotencyKey,
          },
        });
        if (existing) {
          // Both sides are normalised to the SIGNED stored value so a
          // replay of the identical request compares equal, while a replay
          // that flips PAY_IN to PAY_OUT (same magnitude, opposite meaning)
          // is correctly rejected rather than quietly returning the first.
          const magnitude = new Prisma.Decimal(input.amount).abs();
          const signed = input.type === 'PAY_OUT' ? magnitude.negated() : magnitude;
          assertIdempotentReplayMatches(
            { type: existing.type, amount: existing.amount.toString(), reason: existing.reason },
            { type: input.type, amount: signed.toString(), reason: input.reason },
          );
          return existing;
        }
      }

      const created = await recordCashTransaction(tx, {
        businessId: actor.tenantId,
        shiftId,
        type: input.type,
        amount: input.amount,
        referenceType: input.idempotencyKey ? 'CashMovement' : undefined,
        referenceId: input.idempotencyKey,
        reason: input.reason,
        createdBy: actor.id,
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'CashTransaction',
        entityId: created!.id,
        after: created,
        reason: input.reason,
      });

      return created!;
    });
  }

  async list(actor: RequestUser, shiftId: string) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const shift = await tx.shift.findFirst({ where: { id: shiftId, businessId: actor.tenantId }, select: { id: true } });
      if (!shift) throw new NotFoundDomainError('Shift', shiftId);

      return tx.cashTransaction.findMany({
        where: { businessId: actor.tenantId, shiftId },
        orderBy: { createdAt: 'asc' },
      });
    });
  }
}
