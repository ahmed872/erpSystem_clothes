import { Injectable } from '@nestjs/common';
import type { RegisterWarrantyClaimInput } from '@retail/shared-validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';
import { isWarrantyCoverageActive } from '../domain/warranty-eligibility';

/**
 * Registers a claim against a warranty. RECORD-KEEPING ONLY (approved
 * Phase 8A scope decisions 12-15): this use-case injects neither
 * InventoryEngineService nor AccountingEngineService, so it structurally
 * cannot create a StockMovement, a JournalEntry, a SaleReturn or a
 * refund. Any replacement workflow is explicitly deferred.
 *
 * Eligibility is validated at registration time, against the warranty's
 * OWN snapshotted dates - never against current configuration:
 *   - the warranty must not be VOID (a voided warranty covers nothing),
 *   - `claimedAt` must fall within [startDate, endDate).
 *
 * A warranty already in CLAIMED status can still take another claim: a
 * customer may legitimately claim twice within one warranty period (e.g.
 * a first claim REJECTED, or a second unrelated fault). Blocking that
 * would be inventing a one-claim-per-warranty rule Phase 0 does not
 * state. The status simply records that at least one claim exists.
 */
@Injectable()
export class RegisterWarrantyClaimUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(actor: RequestUser, warrantyId: string, input: RegisterWarrantyClaimInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const warranty = await tx.warranty.findFirst({ where: { id: warrantyId, businessId: actor.tenantId } });
      if (!warranty) throw new NotFoundDomainError('Warranty', warrantyId);

      if (warranty.status === 'VOID') {
        throw new ConflictDomainError('This warranty has been voided and cannot be claimed against', { warrantyId });
      }

      const claimedAt = new Date();
      if (!isWarrantyCoverageActive(warranty, claimedAt)) {
        throw new ConflictDomainError('This warranty is not in its coverage period', {
          warrantyId,
          startDate: warranty.startDate.toISOString(),
          endDate: warranty.endDate.toISOString(),
          claimedAt: claimedAt.toISOString(),
        });
      }

      const claim = await tx.warrantyClaim.create({
        data: {
          businessId: actor.tenantId,
          warrantyId: warranty.id,
          claimedAt,
          description: input.description,
          status: 'OPEN',
          createdBy: actor.id,
        },
      });

      // The warranty records that it has been claimed against. This is a
      // status marker only - it changes no date, no duration, and nothing
      // about coverage.
      if (warranty.status !== 'CLAIMED') {
        await tx.warranty.update({ where: { id: warranty.id }, data: { status: 'CLAIMED' } });
      }

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'WarrantyClaim',
        entityId: claim.id,
        after: claim,
        reason: `Claim registered against warranty ${warranty.id}`,
      });

      return claim;
    });
  }
}
