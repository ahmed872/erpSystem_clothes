import { Global, Module } from '@nestjs/common';
import { EffectivePermissionsService } from './effective-permissions.service';

@Global()
@Module({
  providers: [EffectivePermissionsService],
  exports: [EffectivePermissionsService],
})
export class AuthorizationModule {}
