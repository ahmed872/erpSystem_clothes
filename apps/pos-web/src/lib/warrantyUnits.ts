import type { SaleReceipt, WarrantyListRow, WarrantyStatus } from './apiTypes';

/**
 * Phase 12 (Warranty) — the only warranty logic in the browser, and it is
 * deliberately not eligibility.
 *
 * THERE IS NO COVERAGE CHECK HERE, AND THERE MUST NEVER BE ONE. Whether a
 * warranty is in date is decided by `effectiveWarrantyStatus` on the
 * server, from the warranty's OWN snapshotted `startDate`/`endDate` — never
 * from current configuration, and never from the browser's clock. A till
 * whose date is wrong (or whose user set it deliberately) would otherwise
 * be able to declare an expired warranty active, or refuse a live one.
 *
 * What this module does instead is FLATTEN a receipt into the physical
 * units a warranty could name, and pair each with whatever the server
 * already said about it. Every status string below arrives from the API;
 * none is computed.
 */

/** One physical unit on one sale line — the exact pair
 * `POST /warranties` identifies. */
export interface WarrantyUnit {
  saleItemId: string;
  serialNumberId: string;
  serial: string;
  productName: string;
  alternativeName: string | null;
  sku: string;
}

/**
 * Every serial unit the sale actually delivered, taken from
 * `receipt.items[].serialUnits` — the server's own record of what left on
 * which line. Lines with no serials produce nothing: a warranty must name
 * one physical unit, so a non-serialized line has none to offer, and the
 * server refuses such a registration anyway.
 */
export function unitsFromReceipt(receipt: SaleReceipt): WarrantyUnit[] {
  return receipt.items.flatMap((item) =>
    item.serialUnits.map((unit) => ({
      saleItemId: item.id,
      serialNumberId: unit.id,
      serial: unit.serial,
      productName: item.name,
      alternativeName: item.alternativeName,
      sku: item.sku,
    })),
  );
}

/**
 * The warranty covering one unit ON THIS SALE LINE, if the server returned
 * one.
 *
 * The `saleItemId` match matters and is not belt-and-braces: a serial that
 * was sold, returned, and sold again carries a warranty per sale line, and
 * showing an earlier sale's (now auto-voided) warranty against today's line
 * would tell the cashier the opposite of the truth.
 */
export function warrantyForUnit(unit: WarrantyUnit, warranties: WarrantyListRow[]): WarrantyListRow | null {
  return warranties.find((w) => w.serialNumberId === unit.serialNumberId && w.saleItemId === unit.saleItemId) ?? null;
}

/**
 * What the cashier may do with this unit, derived ONLY from whether a
 * warranty exists and what status the SERVER gave it.
 *
 * `REGISTERED` deliberately covers ACTIVE, EXPIRED and CLAIMED alike: all
 * three mean "a warranty exists here", and the server refuses a second one
 * on the (saleItemId, serialNumberId) unique index regardless. Offering a
 * register button for an expired warranty would invite a cashier to try
 * something that must fail.
 *
 * A VOID warranty is reported as VOIDED rather than as "free to register":
 * the unique index still stands, so the unit cannot be re-registered on
 * this line, and pretending otherwise would produce a 409 the cashier could
 * not explain. Its usual cause is a return, which is exactly what the
 * screen should say.
 */
export type UnitWarrantyState = 'UNREGISTERED' | 'REGISTERED' | 'VOIDED';

export function unitWarrantyState(warranty: WarrantyListRow | null): UnitWarrantyState {
  if (!warranty) return 'UNREGISTERED';
  return warranty.effectiveStatus === 'VOID' ? 'VOIDED' : 'REGISTERED';
}

/** Tone for the status badge. Maps the SERVER's status; adds no meaning. */
export function statusTone(status: WarrantyStatus): 'success' | 'neutral' | 'warning' | 'danger' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'CLAIMED':
      return 'warning';
    case 'VOID':
      return 'danger';
    case 'EXPIRED':
    default:
      return 'neutral';
  }
}

/**
 * Whether a claim may be raised from the till.
 *
 * Mirrors the server's two refusals (`RegisterWarrantyClaimUseCase`): a
 * VOID warranty covers nothing, and a claim must fall inside the coverage
 * period. Both are read off `effectiveStatus`, which the server derived —
 * this does not compare dates. The server re-checks regardless; this only
 * decides whether to offer a button that would otherwise be refused.
 */
export function canRaiseClaim(warranty: { effectiveStatus: WarrantyStatus } | null): boolean {
  if (!warranty) return false;
  return warranty.effectiveStatus === 'ACTIVE' || warranty.effectiveStatus === 'CLAIMED';
}
