import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditLogsController } from './presentation/audit-logs.controller';
import { ListAuditLogsUseCase } from './application/list-audit-logs.use-case';

/**
 * Global because every module writes to the trail. Phase 11 added the read
 * side: a controller and its use-case, both scoped to `audit.view`.
 */
@Global()
@Module({
  controllers: [AuditLogsController],
  providers: [AuditService, ListAuditLogsUseCase],
  exports: [AuditService],
})
export class AuditModule {}
