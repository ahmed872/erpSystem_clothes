import { Shift } from '@prisma/client';
import { TenantTx } from '../../../common/prisma/prisma.service';

/** The actor's own currently OPEN shift, if any - never client-supplied
 * (a Sale's shiftId is always resolved this way, the same convention as
 * branchId being derived from warehouseId rather than accepted as input). */
export async function findActiveShift(tx: TenantTx, businessId: string, userId: string): Promise<Shift | null> {
  return tx.shift.findFirst({ where: { businessId, openedBy: userId, status: 'OPEN' } });
}
