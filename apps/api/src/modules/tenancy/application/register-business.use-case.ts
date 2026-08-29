import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { RegisterBusinessInput } from '@retail/shared-validation';
import { ROLE_TEMPLATE_PERMISSIONS, ROLE_TEMPLATES } from '@retail/shared-types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PasswordHasherService } from '../../../common/security/password-hasher.service';
import { ConflictDomainError } from '../../../common/errors/domain-error';
import { seedAccountingDefaults } from '../../accounting/domain/seed-accounting-defaults';

export interface RegisterBusinessResult {
  businessId: string;
  branchId: string;
  warehouseId: string;
  ownerUserId: string;
}

/**
 * Business onboarding is a single atomic operation: business + default
 * branch + default warehouse + all built-in role templates (with their
 * default permission grants) + the owner user (assigned the
 * BUSINESS_OWNER role and the default branch) either all commit or all
 * roll back together (docs/architecture/PHASE-0-ARCHITECTURE.md §47).
 *
 * The business id is generated here, application-side, and used to open
 * the RLS tenant context BEFORE the business row itself is inserted -
 * this is what lets the "insert own business only" policy apply
 * uniformly to registration with no special-cased bypass (see migration
 * 20260828121500_enable_row_level_security).
 */
@Injectable()
export class RegisterBusinessUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasherService,
  ) {}

  async execute(input: RegisterBusinessInput): Promise<RegisterBusinessResult> {
    const existing = await this.prisma.withoutTenant((tx) =>
      tx.business.findUnique({ where: { slug: input.businessSlug }, select: { id: true } }),
    );
    if (existing) {
      throw new ConflictDomainError(`Business slug "${input.businessSlug}" is already taken`);
    }

    const businessId = randomUUID();
    const branchId = randomUUID();
    const warehouseId = randomUUID();
    const ownerUserId = randomUUID();
    const passwordHash = await this.hasher.hash(input.ownerPassword);

    return this.prisma.withTenant(businessId, async (tx) => {
      await tx.business.create({
        data: {
          id: businessId,
          name: input.businessName,
          slug: input.businessSlug,
          currency: input.currency,
          timezone: input.timezone,
        },
      });

      await tx.branch.create({
        data: { id: branchId, businessId, name: input.defaultBranchName, createdBy: ownerUserId },
      });

      await tx.warehouse.create({
        data: {
          id: warehouseId,
          businessId,
          branchId,
          name: input.defaultWarehouseName,
          isDefault: true,
          createdBy: ownerUserId,
        },
      });

      // Seed every built-in role template so an owner can start assigning
      // Branch Manager / Accountant / Cashier / ... immediately, without a
      // separate "set up roles" step.
      const allPermissions = await tx.permission.findMany({ select: { id: true, code: true } });
      const permissionIdByCode = new Map(allPermissions.map((p) => [p.code, p.id]));

      let ownerRoleId: string | null = null;
      for (const template of ROLE_TEMPLATES) {
        const role = await tx.role.create({
          data: { businessId, name: template, isSystem: true },
        });
        const codes = ROLE_TEMPLATE_PERMISSIONS[template];
        await tx.rolePermission.createMany({
          data: codes
            .map((code) => permissionIdByCode.get(code))
            .filter((id): id is string => Boolean(id))
            .map((permissionId) => ({ roleId: role.id, permissionId })),
        });
        if (template === 'BUSINESS_OWNER') ownerRoleId = role.id;
      }
      if (!ownerRoleId) throw new Error('BUSINESS_OWNER role template failed to seed');

      await tx.user.create({
        data: {
          id: ownerUserId,
          businessId,
          name: input.ownerName,
          email: input.ownerEmail,
          passwordHash,
          status: 'ACTIVE',
        },
      });
      await tx.userRole.create({ data: { userId: ownerUserId, roleId: ownerRoleId } });
      await tx.userBranch.create({ data: { userId: ownerUserId, branchId } });

      // Phase 6: every business gets its default Chart of Accounts +
      // AccountingMappingRule set + one open-ended FiscalPeriod at
      // onboarding, so its very first Sale/Purchase can post immediately -
      // see seedAccountingDefaults's own doc comment.
      await seedAccountingDefaults(tx, businessId, ownerUserId);

      await this.audit.record(tx, {
        businessId,
        userId: ownerUserId,
        action: 'CREATE',
        entityType: 'Business',
        entityId: businessId,
        after: { name: input.businessName, slug: input.businessSlug },
        reason: 'Business onboarding',
      });

      return { businessId, branchId, warehouseId, ownerUserId };
    });
  }
}
