import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { createUserSchema, updateUserSchema, CreateUserInput, UpdateUserInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateUserUseCase } from '../application/users/create-user.use-case';
import { ListUsersUseCase } from '../application/users/list-users.use-case';
import { UpdateUserUseCase } from '../application/users/update-user.use-case';

@Controller('users')
export class UsersController {
  constructor(
    private readonly createUser: CreateUserUseCase,
    private readonly listUsers: ListUsersUseCase,
    private readonly updateUser: UpdateUserUseCase,
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
