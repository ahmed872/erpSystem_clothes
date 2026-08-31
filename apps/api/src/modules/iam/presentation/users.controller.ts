import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  createUserSchema,
  updateUserSchema,
  CreateUserInput,
  UpdateUserInput,
  resetUserPasswordSchema,
  ResetUserPasswordInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { ThrottleCredential } from '../../../common/security/throttle-policy';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateUserUseCase } from '../application/users/create-user.use-case';
import { ListUsersUseCase } from '../application/users/list-users.use-case';
import { UpdateUserUseCase } from '../application/users/update-user.use-case';
import { ChangePasswordUseCase } from '../application/users/change-password.use-case';

@Controller('users')
export class UsersController {
  constructor(
    private readonly createUser: CreateUserUseCase,
    private readonly listUsers: ListUsersUseCase,
    private readonly updateUser: UpdateUserUseCase,
    private readonly passwords: ChangePasswordUseCase,
  ) {}

  @RequirePermissions('users.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listUsers.execute(user) };
  }

  @RequirePermissions('users.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput) {
    return { data: await this.createUser.execute(user, body) };
  }

  /**
   * Phase 10 (10G): an administrator sets a new password for someone who
   * has forgotten theirs - the case that actually happens in a shop.
   *
   * `users.edit` is the check: the administrator does not know the current
   * password, which is the entire point of a reset. Every live session of
   * that user is revoked, so a password reset after a suspected compromise
   * actually ends the compromise.
   */
  @RequirePermissions('users.edit')
  @ThrottleCredential()
  @Post(':id/password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resetUserPasswordSchema)) body: ResetUserPasswordInput,
  ) {
    return { data: await this.passwords.resetForUser(user, id, body) };
  }

  @RequirePermissions('users.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
  ) {
    return { data: await this.updateUser.execute(user, id, body) };
  }

  @RequirePermissions('users.delete')
  @Delete(':id')
  async suspend(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.updateUser.execute(user, id, { status: 'SUSPENDED' }) };
  }
}
