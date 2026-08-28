import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { createBranchSchema, updateBranchSchema, CreateBranchInput, UpdateBranchInput } from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { CreateBranchUseCase } from '../application/branches/create-branch.use-case';
import { ListBranchesUseCase } from '../application/branches/list-branches.use-case';
import { UpdateBranchUseCase } from '../application/branches/update-branch.use-case';

@Controller('branches')
export class BranchesController {
  constructor(
    private readonly createBranch: CreateBranchUseCase,
    private readonly listBranches: ListBranchesUseCase,
    private readonly updateBranch: UpdateBranchUseCase,
  ) {}

  @RequirePermissions('branches.view')
  @Get()
  async list(@CurrentUser() user: RequestUser) {
    return { data: await this.listBranches.execute(user) };
  }

  @RequirePermissions('branches.create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createBranchSchema)) body: CreateBranchInput,
  ) {
    return { data: await this.createBranch.execute(user, body) };
  }

  @RequirePermissions('branches.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBranchSchema)) body: UpdateBranchInput,
  ) {
    return { data: await this.updateBranch.execute(user, id, body) };
  }
}
