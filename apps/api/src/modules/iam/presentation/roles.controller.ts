import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { createRoleSchema, updateRoleSchema, CreateRoleInput, UpdateRoleInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateRoleUseCase } from '../application/roles/create-role.use-case';
import { ListRolesUseCase } from '../application/roles/list-roles.use-case';
import { UpdateRoleUseCase } from '../application/roles/update-role.use-case';
import { DeleteRoleUseCase } from '../application/roles/delete-role.use-case';

@Controller('roles')
export class RolesController {
  constructor(
    private readonly createRole: CreateRoleUseCase,
    private readonly listRoles: ListRolesUseCase,
    private readonly updateRole: UpdateRoleUseCase,
    private readonly deleteRole: DeleteRoleUseCase,
  ) {}

  @RequirePermissions('roles.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listRoles.execute(user) };
  }

  @RequirePermissions('roles.create')
  @Post()
  async create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput) {
    return { data: await this.createRole.execute(user, body) };
  }

  @RequirePermissions('roles.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
  ) {
    return { data: await this.updateRole.execute(user, id, body) };
  }

  @RequirePermissions('roles.delete')
  @Delete(':id')
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.deleteRole.execute(user, id);
    return { data: null };
  }
}
