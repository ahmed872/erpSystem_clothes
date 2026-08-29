import { Global, Module } from '@nestjs/common';
import { AccountingEngineService } from './accounting-engine.service';

@Global()
@Module({
  providers: [AccountingEngineService],
  exports: [AccountingEngineService],
})
export class AccountingEngineModule {}
