import { Global, Module } from '@nestjs/common';
import { TaxEngineService } from './tax-engine.service';

/**
 * Phase 10 (BD-18). Global, like the Inventory and Accounting engines, so
 * any application use-case that needs tax can inject it without a module
 * having to re-export it. The engine itself is stateless and holds no HTTP
 * knowledge.
 */
@Global()
@Module({
  providers: [TaxEngineService],
  exports: [TaxEngineService],
})
export class TaxEngineModule {}
