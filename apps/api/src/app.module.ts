import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthorizationModule } from './common/authorization/authorization.module';
import { AuditModule } from './modules/audit/audit.module';
import { IamModule } from './modules/iam/iam.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { SalesModule } from './modules/sales/sales.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { WarrantyModule } from './modules/warranty/warranty.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { FinanceModule } from './modules/finance/finance.module';
import { PromotionsModule } from './modules/promotions/promotions.module';
import { InventoryEngineModule } from './engines/inventory/inventory-engine.module';
import { AccountingEngineModule } from './engines/accounting/accounting-engine.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthorizationModule,
    AuditModule,
    InventoryEngineModule,
    AccountingEngineModule,
    IamModule,
    TenancyModule,
    CatalogModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
    AccountingModule,
    ReportingModule,
    WarrantyModule,
    LoyaltyModule,
    PromotionsModule,
    FinanceModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
