import { Global, Module } from '@nestjs/common';
import { InventoryEngineService } from './inventory-engine.service';

@Global()
@Module({
  providers: [InventoryEngineService],
  exports: [InventoryEngineService],
})
export class InventoryEngineModule {}
