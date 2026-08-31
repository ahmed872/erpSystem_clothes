import { Controller, Get, Query } from '@nestjs/common';
import { auditLogListQuerySchema, AuditLogListQuery } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ListAuditLogsUseCase } from '../application/list-audit-logs.use-case';

/**
 * Phase 11 — the audit trail.
 *
 * READ ONLY, and structurally so. There is no POST, PATCH or DELETE here
 * and there never can be a working one: `erp_app` holds SELECT and INSERT
 * on `audit_logs` and nothing else, so an endpoint that tried to edit a
 * row would be refused by the database rather than by a convention.
 *
 * `audit.view` is deliberately NOT on the Cashier or Sales Employee
 * templates. The trail records who did what, including their own mistakes,
 * and reading it is an oversight function.
 */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly listAuditLogs: ListAuditLogsUseCase) {}

  @RequirePermissions('audit.view')
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(auditLogListQuerySchema)) query: AuditLogListQuery,
  ) {
    return this.listAuditLogs.execute(user, query);
  }
}
