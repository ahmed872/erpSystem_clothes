import { Controller, Delete, Param } from '@nestjs/common';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser, RequestUser } from '../../../common/decorators/current-user.decorator';
import { BarcodesService } from '../application/barcodes.service';
import { ProductUomsService } from '../application/product-uoms.service';

/** Standalone delete routes for barcode/product-uom sub-resources, whose
 * "add" routes are nested under variants/products respectively. */
@Controller('catalog')
export class CatalogAdminController {
  constructor(
    private readonly barcodes: BarcodesService,
    private readonly productUoms: ProductUomsService,
  ) {}

  @RequirePermissions('products.edit')
  @Delete('barcodes/:id')
  async removeBarcode(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.barcodes.remove(user, id);
    return { data: null };
  }

  @RequirePermissions('products.edit')
  @Delete('product-uoms/:id')
  async removeProductUom(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.productUoms.remove(user, id);
    return { data: null };
  }
}
