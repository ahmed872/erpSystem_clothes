import { Injectable } from '@nestjs/common';
import type { ResolveWarrantyClaimInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

/**
 * Transitions a claim OPEN -> RESOLVED | REJECTED (approved decision 15 -
 * exactly three states, no richer workflow invented). Still
 * record-keeping only: no inventory movement, no accounting posting, no
 * refund, no automatic sale return.
 *
 * Historical integrity: `claimedAt` and `description` are never
 * rewritten. The transition records `resolvedAt`/`resolvedBy` alongside
 * the new status, and the
 * `warranty_claims_resolution_audit_consistent` CHECK constraint makes
 * that pairing a database-level guarantee - a resolved claim can never
 * exist without its audit trail, and an OPEN claim can never carry one.
 *
 * The transition is one-way: a claim already RESOLVED or REJECTED cannot
 * be re-transitioned, so a decision is never silently overwritten. A
 * correction would be a new claim, following the same
 * never-edit-history posture as SaleReturn correcting a Sale.
 */
@Injectable()
export class ResolveWarrantyClaimUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, warrantyId: string, claimId: string, input: ResolveWarrantyClaimInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const claim = await tx.warrantyClaim.findFirst({
        where: { id: claimId, warrantyId, businessId: actor.tenantId },
      });
      if (!claim) throw new NotFoundDomainError('WarrantyClaim', claimId);

      if (claim.status !== 'OPEN') {
        throw new ConflictDomainError(`This claim has already been ${claim.status.toLowerCase()} and cannot be changed`, {
          claimId,
          currentStatus: claim.status,
        });
      }

      // A single conditional UPDATE rather than read-then-write, so two
      // concurrent resolutions can never both report success - the same
      // pattern CloseShiftUseCase (Phase 5) established.
      const result = await tx.warrantyClaim.updateMany({
        where: { id: claimId, businessId: actor.tenantId, status: 'OPEN' },
        data: { status: input.status, resolution: input.resolution, resolvedAt: new Date(), resolvedBy: actor.id },
      });
      if (result.count === 0) {
        throw new ConflictDomainError('This claim was resolved concurrently by someone else', { claimId });
      }

      const updated = await tx.warrantyClaim.findUniqueOrThrow({ where: { id: claimId } });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'WarrantyClaim',
        entityId: claimId,
        before: { status: 'OPEN' },
        after: { status: updated.status, resolution: updated.resolution },
        reason: `Warranty claim ${input.status.toLowerCase()}`,
      });

      return updated;
    });
  }
}
