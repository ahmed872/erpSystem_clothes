import { Module } from '@nestjs/common';
import { CategoriesController } from './presentation/categories.controller';
import { BrandsController } from './presentation/brands.controller';
import { UomsController } from './presentation/uoms.controller';
import { AttributesController } from './presentation/attributes.controller';
import { ProductsController } from './presentation/products.controller';
import { VariantsController } from './presentation/variants.controller';
import { PriceListsController } from './presentation/price-lists.controller';
import { CatalogSyncController } from './presentation/catalog-sync.controller';
import { CatalogAdminController } from './presentation/catalog-admin.controller';
import { CategoriesService } from './application/categories.service';
import { BrandsService } from './application/brands.service';
import { UomsService } from './application/uoms.service';
import { AttributesService } from './application/attributes.service';
import { ProductsService } from './application/products.service';
import { VariantsService } from './application/variants.service';
import { ProductUomsService } from './application/product-uoms.service';
import { BarcodesService } from './application/barcodes.service';
import { PriceListsService } from './application/price-lists.service';
import { CatalogSyncService } from './application/catalog-sync.service';

@Module({
  controllers: [
    CategoriesController,
    BrandsController,
    UomsController,
    AttributesController,
    ProductsController,
    VariantsController,
    PriceListsController,
    CatalogSyncController,
    CatalogAdminController,
  ],
  providers: [
    CategoriesService,
    BrandsService,
    UomsService,
    AttributesService,
    ProductsService,
    VariantsService,
    ProductUomsService,
    BarcodesService,
    PriceListsService,
    CatalogSyncService,
  ],
})
export class CatalogModule {}
