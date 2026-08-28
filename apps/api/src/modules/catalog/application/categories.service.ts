import { Injectable } from '@nestjs/common';
import type { CreateCategoryInput, UpdateCategoryInput } from '@retail/shared-validation';
import { PrismaService, TenantTx } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../../../common/errors/domain-error';
import { RequestUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: RequestUser, input: CreateCategoryInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      if (input.parentId) {
        const parent = await tx.category.findFirst({ where: { id: input.parentId, businessId: actor.tenantId } });
        if (!parent) throw new NotFoundDomainError('Category', input.parentId);
      }

      const duplicate = await tx.category.findFirst({
        where: { businessId: actor.tenantId, parentId: input.parentId ?? null, name: input.name },
      });
      if (duplicate) throw new ConflictDomainError(`A category named "${input.name}" already exists at this level`);

      const category = await tx.category.create({
        data: {
          businessId: actor.tenantId,
          parentId: input.parentId ?? null,
          name: input.name,
          description: input.description,
          createdBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'CREATE',
        entityType: 'Category',
        entityId: category.id,
        after: category,
      });

      return category;
    });
  }

  async list(actor: RequestUser) {
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.category.findMany({ where: { businessId: actor.tenantId }, orderBy: [{ parentId: 'asc' }, { name: 'asc' }] }),
    );
  }

  async update(actor: RequestUser, categoryId: string, input: UpdateCategoryInput) {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const before = await tx.category.findFirst({ where: { id: categoryId, businessId: actor.tenantId } });
      if (!before) throw new NotFoundDomainError('Category', categoryId);

      const nextParentId = input.parentId === undefined ? before.parentId : input.parentId;
      if (input.parentId !== undefined && input.parentId !== null) {
        if (input.parentId === categoryId) {
          throw new ValidationFailedError('A category cannot be its own parent');
        }
        const parent = await tx.category.findFirst({ where: { id: input.parentId, businessId: actor.tenantId } });
        if (!parent) throw new NotFoundDomainError('Category', input.parentId);
        await this.assertNoCycle(tx, categoryId, input.parentId);
      }

      const nextName = input.name ?? before.name;
      if (nextName !== before.name || nextParentId !== before.parentId) {
        const duplicate = await tx.category.findFirst({
          where: { businessId: actor.tenantId, parentId: nextParentId, name: nextName, NOT: { id: categoryId } },
        });
        if (duplicate) throw new ConflictDomainError(`A category named "${nextName}" already exists at this level`);
      }

      const after = await tx.category.update({
        where: { id: categoryId },
        data: {
          name: input.name ?? undefined,
          parentId: input.parentId === undefined ? undefined : input.parentId,
          description: input.description === undefined ? undefined : input.description,
          isActive: input.isActive ?? undefined,
          updatedBy: actor.id,
        },
      });

      await this.audit.record(tx, {
        businessId: actor.tenantId,
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'Category',
        entityId: categoryId,
        before,
        after,
      });

      return after;
    });
  }

  /** Walks up from `newParentId` to the root; rejects if `categoryId` appears in that chain. */
  private async assertNoCycle(tx: TenantTx, categoryId: string, newParentId: string): Promise<void> {
    let cursor: string | null = newParentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === categoryId) {
        throw new ValidationFailedError('This change would make a category a descendant of itself');
      }
      if (seen.has(cursor)) break; // defensive: pre-existing cycle shouldn't infinite-loop us
      seen.add(cursor);
      const row: { parentId: string | null } | null = await tx.category.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = row?.parentId ?? null;
    }
  }
}
