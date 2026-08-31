import { Injectable } from '@nestjs/common';
import type { CreateTaxInput, UpdateTaxInput, UpdateTaxSettingsInput } from '@retail/shared-validation';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { NotFoundDomainError, ValidationFailedError } from '../../../../common/errors/domain-error';
import { RequestUser } from '../../../../common/decorators/current-user.decorator';

/**
 * Phase 10 (BD-18) — tax configuration.
 *
 * Rates are configuration, never constants, and no jurisdiction is assumed
 * anywhere: the product ships knowing nothing about VAT, GST or any
 * national regime, and a business defines whatever it is subject to.
 *
 * Editing a rate changes what FUTURE sales are charged and can never reach
 * a historical one - every sale line snapshots the rate that produced its
 * tax (BD-18 rule 4). That is why a rate is editable at all: without the
 * snapshot it would have to be immutable, and a business could never
 * correct a typo or follow a rate change.
 *
 * Taxes are never hard-deleted. `isActive = false` retires one, so a tax
 * that has ever been applied stays resolvable; the grant withholds DELETE
 * to make that structural.
 */
@Injectable()
export class TaxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, input: CreateTaxInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const tax = await tx.tax.create({
        data: {
          businessId: actor.tenantId,
          name: input.name,
          ratePercent: input.ratePercent,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Tax',
        entityId: tax.id,
        after: tax,
      });

      return tax;
    });
  }

  async update(actor: RequestUser, id: string, input: UpdateTaxInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.tax.findFirst({ where: { id, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Tax', id);

      const after = await tx.tax.update({
        where: { id },
        data: {
          name: input.name,
          ratePercent: input.ratePercent,
          isActive: input.isActive,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Tax',
        entityId: id,
        before,
        after,
        reason: 'Tax configuration changed - historical sales are unaffected (each line snapshots its own rate)',
      });

      return after;
    });
  }

  async list(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) =>
      tx.tax.findMany({ where: { businessId: actor.tenantId }, orderBy: { name: 'asc' } }),
    );
  }

  /** The business-level tax settings: pricing mode and default tax. */
  async getSettings(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, async (tx) =>
      tx.business.findUniqueOrThrow({
        where: { id: actor.tenantId },
        select: { taxPricingMode: true, defaultTaxId: true },
      }),
    );
  }

  async updateSettings(actor: RequestUser, input: UpdateTaxSettingsInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.defaultTaxId) {
        const tax = await tx.tax.findFirst({ where: { id: input.defaultTaxId, businessId: actor.tenantId } });
        if (!tax) throw new NotFoundDomainError('Tax', input.defaultTaxId);
        if (!tax.isActive) {
          throw new ValidationFailedError('An inactive tax cannot be the business default', { taxId: tax.id });
        }
      }

      const before = await tx.business.findUniqueOrThrow({
        where: { id: actor.tenantId },
        select: { taxPricingMode: true, defaultTaxId: true },
      });

      const after = await tx.business.update({
        where: { id: actor.tenantId },
        data: {
          taxPricingMode: input.taxPricingMode,
          // `undefined` leaves it alone; an explicit `null` clears it.
          defaultTaxId: input.defaultTaxId === undefined ? undefined : input.defaultTaxId,
        },
        select: { taxPricingMode: true, defaultTaxId: true },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Business',
        entityId: actor.tenantId,
        before,
        after,
        reason: 'Tax settings changed',
      });

      return after;
    });
  }
}
