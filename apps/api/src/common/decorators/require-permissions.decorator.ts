import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '@retail/shared-types';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares the permission code(s) a route requires. Checked server-side
 * by PermissionsGuard against the caller's *current* role grants (looked
 * up fresh per request, not cached in the JWT) - see
 * docs/architecture/PHASE-0-ARCHITECTURE.md §9/§14: the frontend is
 * never the source of authorization truth.
 */
export const RequirePermissions = (...codes: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, codes);
