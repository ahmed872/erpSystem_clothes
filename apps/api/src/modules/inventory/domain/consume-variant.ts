import { Prisma, StockMovementType } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';
import { InventoryEngineService } from '../../../engines/inventory/inventory-engine.service';
import { AuditService } from '../../audit/audit.service';
import { ValidationFailedError } from '../../../common/errors/domain-error';
import { loadVariantContext } from './load-variant-context';
import { toBaseQuantity } from './uom-conversion';
import { consumeSerialsForSale } from './lot-and-serial';

export interface ConsumeVariantParams {
  businessId: string;
  warehouseId: string;
  variantId: string;
  quantity: number;
  uomId?: string;
  movementType: StockMovementType;
  referenceType?: string;
  referenceId?: string;
  lotId?: string;
  reason?: string;
  serials?: string[];
  createdBy?: string;
  allowNegative: boolean;
}

export interface ConsumeVariantResult {
  movementId: string;
  quantityOnHand: string;
  averageCost: string;
  cogsPerUnit: string;
  bundleProductId?: string;
  componentsConsumed?: { variantId: string; movementId: string; quantityConsumed: string; unitCost: string }[];
}

/**
 * Shared stock-out primitive for a single line: consumes `quantity` of
 * `variantId` at `warehouseId`, expanding a Bundle-type variant into its
 * BundleItem components (never the bundle "itself" - Phase 2 design).
 *
 * Extracted from ConsumeStockUseCase (Phase 3) during the Phase 5
 * pre-implementation review, specifically so it can be composed inside a
 * CALLER-OWNED transaction: ConsumeStockUseCase still wraps this in its
 * own `withTenant` transaction (unchanged external behavior, still the
 * standalone endpoint it always was), while Phase 5's Sale completion
 * calls this once per line inside the Sale's own transaction - the only
 * way to get both "exactly one authoritative stock-consumption path" AND
 * "a completed Sale is one atomic DB transaction" at the same time. The
 * actual StockMovement/StockBalance mutation still happens exclusively
 * inside InventoryEngineService.applyMovement - this function only
 * resolves what to call it with (bundle expansion, UOM conversion,
 * serial consumption) and never touches stock tables itself.
 *
 * Lock-ordering hardening (Phase 5 review, rule #3/#10): bundle
 * components are now locked in a deterministic order (sorted by
 * componentVariantId) rather than BundleItem insertion order, so two
 * concurrent multi-component consumptions sharing components can never
 * lock them in opposite orders - closing the class of theoretical
 * deadlock exposure flagged as Known Issue #24 for the exact code path
 * Phase 5 exercises on every multi-line sale. Bundle expansion itself
 * still happens after any Sale-level line ordering the caller applies
 * (Sale lines are sorted by variantId by CreateSaleUseCase before this
 * is ever called), so the full lock sequence for a multi-line, partially
 * bundled Sale is deterministic end to end.
 */
export async function consumeVariant(
  tx: TenantTx,
  engine: InventoryEngineService,
  audit: AuditService,
  params: ConsumeVariantParams,
): Promise<ConsumeVariantResult> {
  const { warehouse, product } = await loadVariantContext(tx, params.businessId, params.warehouseId, params.variantId);

  if (product.type === 'BUNDLE') {
    return consumeBundle(tx, engine, audit, warehouse.branchId, product.id, params);
  }

  const baseQty = toBaseQuantity(product.baseUomId, product.productUoms, params.uomId, params.quantity);

  if (product.tracksSerialNumbers && params.movementType === 'SALE') {
    await consumeSerialsForSale(tx, params.businessId, params.variantId, params.warehouseId, params.serials, params.quantity);
  }

  const result = await engine.applyMovement(tx, {
    businessId: params.businessId,
    branchId: warehouse.branchId,
    warehouseId: params.warehouseId,
    variantId: params.variantId,
    quantityDelta: baseQty.negated(),
    movementType: params.movementType,
    uomId: params.uomId,
    quantityInUom: params.uomId ? params.quantity : undefined,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    lotId: params.lotId,
    reason: params.reason,
    createdBy: params.createdBy,
    allowNegative: params.allowNegative,
  });

  await audit.record(tx, {
    businessId: params.businessId,
    userId: params.createdBy,
    action: 'CREATE',
    entityType: 'StockMovement',
    entityId: result.movement.id,
    after: {
      movementType: params.movementType,
      quantityBase: baseQty.negated().toString(),
      cogsPerUnit: result.movement.unitCostAtMovement.toString(),
    },
  });

  return {
    movementId: result.movement.id,
    quantityOnHand: result.quantityOnHand.toString(),
    averageCost: result.averageCost.toString(),
    cogsPerUnit: result.movement.unitCostAtMovement.toString(),
  };
}

async function consumeBundle(
  tx: TenantTx,
  engine: InventoryEngineService,
  audit: AuditService,
  branchId: string,
  bundleProductId: string,
  params: ConsumeVariantParams,
): Promise<ConsumeVariantResult> {
  // Deterministic lock-acquisition order (see function doc comment above).
  const bundleItems = await tx.bundleItem.findMany({ where: { bundleProductId }, orderBy: { componentVariantId: 'asc' } });
  if (bundleItems.length === 0) {
    throw new ValidationFailedError('This bundle has no components configured');
  }

  const bundleQty = new Prisma.Decimal(params.quantity);
  const components: { variantId: string; movementId: string; quantityConsumed: string; unitCost: string }[] = [];

  for (const item of bundleItems) {
    // BundleItem.quantity is expressed directly in the component
    // variant's own base UOM (Phase 2 bundle items carry no UOM of their
    // own) - no conversion needed here.
    const componentQtyBase = item.quantity.times(bundleQty);

    const result = await engine.applyMovement(tx, {
      businessId: params.businessId,
      branchId,
      warehouseId: params.warehouseId,
      variantId: item.componentVariantId,
      quantityDelta: componentQtyBase.negated(),
      movementType: 'BUNDLE_CONSUMPTION',
      referenceType: params.referenceType ?? 'BundleSale',
      referenceId: params.referenceId ?? bundleProductId,
      reason: params.reason ?? `Bundle consumption for product ${bundleProductId}`,
      createdBy: params.createdBy,
      allowNegative: params.allowNegative,
    });

    components.push({
      variantId: item.componentVariantId,
      movementId: result.movement.id,
      quantityConsumed: componentQtyBase.toString(),
      unitCost: result.movement.unitCostAtMovement.toString(),
    });
  }

  await audit.record(tx, {
    businessId: params.businessId,
    userId: params.createdBy,
    action: 'CREATE',
    entityType: 'BundleConsumption',
    entityId: bundleProductId,
    after: { bundleQuantity: bundleQty.toString(), components },
  });

  return { movementId: '', quantityOnHand: '0', averageCost: '0', cogsPerUnit: '0', bundleProductId, componentsConsumed: components };
}
