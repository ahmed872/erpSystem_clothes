import { Injectable } from '@nestjs/common';
import { TenantTx } from '../prisma/prisma.service';

/**
 * Resolves a user's *current* effective permission set (User -> UserRole ->
 * Role -> RolePermission -> Permission) from the database, inside an
 * already-open tenant-scoped transaction. Shared by PermissionsGuard
 * (route-level authorization) and any use-case that needs a field-level
 * authorization check within the same request (e.g. hiding cost fields
 * from a response for a caller without products.view_cost) - one place
 * computes "what can this user do right now", never duplicated ad hoc.
 *
 * Returns null (not an empty set) when the user doesn't exist or is not
 * ACTIVE, so callers can distinguish "no permissions" from "not a valid,
 * active user at all".
 */
@Injectable()
export class EffectivePermissionsService {
  async get(tx: TenantTx, userId: string): Promise<Set<string> | null> {
    const dbUser = await tx.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        userRoles: {
          select: {
            role: {
              select: {
                rolePermissions: { select: { permission: { select: { code: true } } } },
              },
            },
          },
        },
      },
    });
    if (!dbUser || dbUser.status !== 'ACTIVE') return null;

    const codes = new Set<string>();
    for (const ur of dbUser.userRoles) {
      for (const rp of ur.role.rolePermissions) {
        codes.add(rp.permission.code);
      }
    }
    return codes;
  }
}
