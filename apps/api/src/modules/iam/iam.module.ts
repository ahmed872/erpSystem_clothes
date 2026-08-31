import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PasswordHasherService } from '../../common/security/password-hasher.service';
import { AuthTokenService } from './domain/auth-token.service';
import { AuthController } from './presentation/auth.controller';
import { UsersController } from './presentation/users.controller';
import { RolesController } from './presentation/roles.controller';
import { PermissionsController } from './presentation/permissions.controller';
import { LoginUseCase } from './application/auth/login.use-case';
import { RefreshTokenUseCase } from './application/auth/refresh-token.use-case';
import { LogoutUseCase } from './application/auth/logout.use-case';
import { CreateUserUseCase } from './application/users/create-user.use-case';
import { ListUsersUseCase } from './application/users/list-users.use-case';
import { UpdateUserUseCase } from './application/users/update-user.use-case';
import { ChangePasswordUseCase } from './application/users/change-password.use-case';
import { CreateRoleUseCase } from './application/roles/create-role.use-case';
import { ListRolesUseCase } from './application/roles/list-roles.use-case';
import { UpdateRoleUseCase } from './application/roles/update-role.use-case';
import { DeleteRoleUseCase } from './application/roles/delete-role.use-case';
import { ListPermissionsUseCase } from './application/permissions/list-permissions.use-case';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, UsersController, RolesController, PermissionsController],
  providers: [
    ChangePasswordUseCase,
    PasswordHasherService,
    AuthTokenService,
    LoginUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    CreateUserUseCase,
    ListUsersUseCase,
    UpdateUserUseCase,
    CreateRoleUseCase,
    ListRolesUseCase,
    UpdateRoleUseCase,
    DeleteRoleUseCase,
    ListPermissionsUseCase,
  ],
  exports: [AuthTokenService],
})
export class IamModule {}
