import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  createProductSchema,
  updateProductSchema,
  productListQuerySchema,
  addVariantSchema,
  addProductUomSchema,
  replaceBundleItemsSchema,
  CreateProductInput,
  UpdateProductInput,
  ProductListQuery,
  AddVariantInput,
  AddProductUomInput,
  ReplaceBundleItemsInput,
} from '@retail/shared-validation';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { ProductsService } from '../application/products.service';
import { VariantsService } from '../application/variants.service';
import { ProductUomsService } from '../application/product-uoms.service';

@Controller('catalog/products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly variants: VariantsService,
    private readonly productUoms: ProductUomsService,
  ) {}

  @RequirePermissions('products.view')
  @Get()
  async list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(productListQuerySchema)) query: ProductListQuery) {
    return this.products.listProducts(user, query);
  }

  @RequirePermissions('products.create')
  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ) {
    return { data: await this.products.createProduct(user, body) };
  }

  @RequirePermissions('products.view')
  @Get(':id')
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { data: await this.products.getProduct(user, id) };
  }

  @RequirePermissions('products.edit')
  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ) {
    return { data: await this.products.updateProduct(user, id, body) };
  }

  @RequirePermissions('products.edit')
  @Put(':id/bundle-items')
  async replaceBundleItems(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replaceBundleItemsSchema)) body: ReplaceBundleItemsInput,
  ) {
    return { data: await this.products.replaceBundleItems(user, id, body) };
  }

  @RequirePermissions('products.create')
  @Post(':id/variants')
  async addVariant(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addVariantSchema)) body: AddVariantInput,
  ) {
    return { data: await this.variants.addVariant(user, id, body) };
  }

  @RequirePermissions('products.edit')
  @Post(':id/uoms')
  async addUom(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addProductUomSchema)) body: AddProductUomInput,
  ) {
    return { data: await this.productUoms.add(user, id, body) };
  }
}
