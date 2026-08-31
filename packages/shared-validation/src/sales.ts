import { z } from 'zod';
import { positiveQuantitySchema } from './catalog';
import { nameSchema } from './primitives';

const notesSchema = z.string().trim().max(1000);
const nonNegativeMoneySchema = z.number().finite().nonnegative().max(999_999_999_999);
const positiveMoneySchema = z.number().finite().positive().max(999_999_999_999);

export const createCustomerSchema = z.object({
  name: nameSchema,
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  taxNumber: z.string().trim().max(100).optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

/// Phase 10 (BD-17): openShiftSchema / closeShiftSchema moved to
/// ./finance.ts, where they sit alongside the cash-register and
/// reconciliation contracts they now belong to.

const saleItemInputSchema = z.object({
  variantId: z.string().uuid(),
  quantity: positiveQuantitySchema,
  unitPrice: nonNegativeMoneySchema,
  discountAmount: nonNegativeMoneySchema.default(0),
  /// Phase 10 (BD-18 rule 5): `taxAmount` is NO LONGER ACCEPTED. Tax is
  /// resolved and computed server-side from the tenant's own configuration,
  /// so a client can never state the tax it would like to pay. This is a
  /// deliberate breaking change, reported at the release gate.
  ///
  /// BD-18 rule 8: a line may be marked EXPLICITLY exempt. Exemption is
  /// never inferred - a product with no tax configured is untaxed, which is
  /// a different fact from a product that is exempt.
  taxExempt: z.boolean().default(false),
  /// Phase 8E: the exact physical units being sold. REQUIRED for a
  /// serial-tracked variant (approved decision BD-13) and rejected for a
  /// variant that is not serial-tracked - the server decides which,
  /// because only it knows the product's tracking flag. The count must
  /// equal `quantity`.
  serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
});

const salePaymentInputSchema = z.object({
  amount: positiveMoneySchema,
  method: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(200).optional(),
});

export const createSaleSchema = z.object({
  /// warehouseId only - branchId is always derived server-side from
  /// warehouse.branchId (Phase 3/4 convention).
  warehouseId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  notes: notesSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  items: z.array(saleItemInputSchema).min(1).max(500),
  /// Phase 8C: loyalty points to spend on this sale. Resolved
  /// server-side inside CreateSaleUseCase's own transaction and turned
  /// into line discounts - never a separate payment tender and never a
  /// client-supplied discount. Requires `customerId`: points belong to a
  /// customer, so a walk-in sale has none to spend.
  redeemPoints: nonNegativeMoneySchema.optional(),
  /// Payment(s) tendered at the moment of sale. May be empty ONLY for a
  /// credit sale against an identified customer (see the invariant on
  /// the Sale model) - a walk-in sale (no customerId) must be paid in
  /// full here.
  payments: z.array(salePaymentInputSchema).max(20).default([]),
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

/**
 * Phase 12 (Sale Quote) — what the till asks before it asks for money.
 *
 * DELIBERATELY THE SALE REQUEST MINUS THE THINGS A QUOTE MUST NOT CARRY:
 *
 *   - no `idempotencyKey`. A quote creates nothing, so there is nothing to
 *     deduplicate, and accepting one would invite a client to spend a key
 *     on a request that never became a document.
 *   - no `payments`. The whole point is to learn what to tender; asking
 *     the caller to state it first would be circular. The exact-payment
 *     rule stays on `POST /sales`, where the money actually moves.
 *   - no `notes`. Nothing is being recorded.
 *
 * Everything else is identical to `createSaleSchema`, on purpose: the
 * quote must be computed from the SAME request the sale will be given, or
 * the figure it returns is a figure for a different sale.
 */
export const quoteSaleSchema = z.object({
  warehouseId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  items: z.array(saleItemInputSchema).min(1).max(500),
  redeemPoints: nonNegativeMoneySchema.optional(),
});
export type QuoteSaleInput = z.infer<typeof quoteSaleSchema>;

export const createSalePaymentSchema = z.object({
  amount: positiveMoneySchema,
  method: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
});
export type CreateSalePaymentInput = z.infer<typeof createSalePaymentSchema>;

export const createSaleReturnSchema = z.object({
  reason: notesSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  /// Phase 10 (BD-23): the money actually handed back, recorded as a real
  /// operational fact at the moment it happens.
  ///
  /// Optional for an account customer (omitting it leaves the credit on
  /// their ledger, the pre-Phase-10 behaviour). MANDATORY for a WALK-IN,
  /// because a walk-in has no ledger the credit could sit on - that is
  /// forced by the data model, not an invented policy, and mirrors the
  /// existing rule that a walk-in SALE must be paid in full.
  refund: z
    .object({
      method: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER']),
      amount: positiveMoneySchema,
      reference: z.string().trim().max(200).optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        saleItemId: z.string().uuid(),
        quantity: positiveQuantitySchema,
        condition: z.enum(['SELLABLE', 'DAMAGED']).default('SELLABLE'),
        /// Phase 8E / BD-14: for a serial-tracked line the return must
        /// name the EXACT physical units coming back - a partial return
        /// of a multi-serial line is otherwise ambiguous about which unit
        /// left the customer's hands. Required for serial-tracked lines
        /// and rejected for others; the server decides which, from the
        /// product's own tracking flag.
        serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateSaleReturnInput = z.infer<typeof createSaleReturnSchema>;

/**
 * Phase 12 (Returns) — what the return will be worth, before it happens.
 *
 * DELIBERATELY THE RETURN REQUEST MINUS WHAT A PREVIEW MUST NOT CARRY:
 * no `refund` (the preview exists to tell the caller what the refund may
 * or must be - asking for it first would be circular), no
 * `idempotencyKey` (nothing is created, so there is nothing to
 * deduplicate), no `reason` (nothing is recorded).
 *
 * `items` is byte-identical to the real return's, including `condition`
 * and `serials`, so the preview is computed from the SAME request the
 * return will be given. A preview of a different request is a figure for
 * a different return.
 */
export const previewSaleReturnSchema = z.object({
  items: z
    .array(
      z.object({
        saleItemId: z.string().uuid(),
        quantity: positiveQuantitySchema,
        condition: z.enum(['SELLABLE', 'DAMAGED']).default('SELLABLE'),
        serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type PreviewSaleReturnInput = z.infer<typeof previewSaleReturnSchema>;

/**
 * Phase 10 (Exchanges) — goods back and goods out, as ONE event.
 *
 * The two halves are the SAME return and the SAME sale the existing
 * endpoints create, composed inside one transaction. Nothing about either
 * is reinterpreted: BD-1 still decides the credit, BD-18 still decides the
 * tax, BD-13 still demands serials, and the Inventory and Accounting
 * engines remain the only things that move stock or post entries.
 *
 * What the request DOES NOT carry, deliberately:
 *
 *   - the warehouse and the customer. Both come from the original sale.
 *     An exchange is against that sale, so letting a client name a
 *     different warehouse or a different customer would let it move goods
 *     and credit between places the original document never mentioned.
 *   - the exchange credit itself. It is the return's own computed figure;
 *     a client that could state it could pay for goods with nothing.
 */
export const createExchangeSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  reason: notesSchema.optional(),
  notes: notesSchema.optional(),
  /// The goods coming back - identical in shape to a sale return's items,
  /// minus the refund, which an exchange settles with the replacement.
  returnItems: z
    .array(
      z.object({
        saleItemId: z.string().uuid(),
        quantity: positiveQuantitySchema,
        condition: z.enum(['SELLABLE', 'DAMAGED']).default('SELLABLE'),
        serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
      }),
    )
    .min(1)
    .max(500),
  /// The goods going out - identical in shape to a sale's items.
  newItems: z.array(saleItemInputSchema).min(1).max(500),
  /// Real tender for the difference, when the replacement is worth more
  /// than the goods handed back. EXCHANGE_CREDIT is not among the methods
  /// a client may name: only the server can produce it.
  payments: z.array(salePaymentInputSchema).max(20).default([]),
  /// Phase 10.2 — the money going back when the replacement is worth LESS
  /// than the goods handed back.
  ///
  /// The AMOUNT is not trusted. The server computes what the exchange
  /// permits - exactly `returnCredit - replacementTotal`, or zero when the
  /// replacement is worth at least as much - and rejects anything else,
  /// naming the figure that would have worked. What the client genuinely
  /// contributes is the METHOD: only the till knows whether the difference
  /// went back as cash, to a card, or to a wallet.
  ///
  /// Omit it for an upward or even exchange, where nothing goes back.
  refund: z
    .object({
      method: z.enum(['CASH', 'CARD', 'WALLET', 'OTHER']),
      amount: positiveMoneySchema,
      reference: z.string().trim().max(200).optional(),
    })
    .optional(),
  /// Phase 8C: the replacement may spend loyalty points like any sale.
  redeemPoints: nonNegativeMoneySchema.optional(),
});
export type CreateExchangeInput = z.infer<typeof createExchangeSchema>;

/**
 * Phase 10 (approved resolution of BLOCKING-2) — parking a basket.
 *
 * These are DRAFT sale lines, not sale lines. The shape mirrors a sale's
 * items so a basket round-trips exactly as the cashier typed it, but
 * nothing here is priced, taxed or costed: those figures come into
 * existence at CHECKOUT, and storing a guess would invite someone to
 * trust it.
 *
 * There are deliberately no `payments` and no `redeemPoints`. Money is
 * tendered when goods change hands, not when a basket is put to one side,
 * and points are spent against a sale that exists.
 */
const heldSaleItemInputSchema = z.object({
  variantId: z.string().uuid(),
  quantity: positiveQuantitySchema,
  unitPrice: nonNegativeMoneySchema,
  discountAmount: nonNegativeMoneySchema.default(0),
  taxExempt: z.boolean().default(false),
  /// Units already scanned into the basket. Validated at CHECKOUT by the
  /// unchanged BD-13 rules, never here: a unit scanned into a parked
  /// basket is not sold and must stay sellable to everyone else.
  serials: z.array(z.string().trim().min(1).max(120)).max(10_000).optional(),
});

export const createHeldSaleSchema = z.object({
  warehouseId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  /// What the cashier calls it - "blue coat lady", "table 4". The whole
  /// point of a hold is being able to find it again.
  label: z.string().trim().max(120).optional(),
  notes: notesSchema.optional(),
  items: z.array(heldSaleItemInputSchema).min(1).max(500),
});
export type CreateHeldSaleInput = z.infer<typeof createHeldSaleSchema>;

/** Replaces a parked basket's lines wholesale - editing a draft is the
 *  entire point of parking one. */
export const updateHeldSaleSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  label: z.string().trim().max(120).nullable().optional(),
  notes: notesSchema.nullable().optional(),
  items: z.array(heldSaleItemInputSchema).min(1).max(500).optional(),
});
export type UpdateHeldSaleInput = z.infer<typeof updateHeldSaleSchema>;

/**
 * Resuming turns the basket into a real sale through the UNCHANGED
 * `CreateSaleUseCase`.
 *
 * The request carries only what could not have been known when the basket
 * was parked: how the customer is paying, and whether they are spending
 * points. Everything else - the goods, the warehouse, the customer - comes
 * from the hold, and the PRICES are re-resolved at checkout rather than
 * honoured from the draft, so parking a basket cannot lock in a price that
 * has since changed.
 */
export const resumeHeldSaleSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  payments: z.array(salePaymentInputSchema).max(20).default([]),
  redeemPoints: nonNegativeMoneySchema.optional(),
  notes: notesSchema.optional(),
});
export type ResumeHeldSaleInput = z.infer<typeof resumeHeldSaleSchema>;

export const voidHeldSaleSchema = z.object({
  reason: notesSchema.optional(),
});
export type VoidHeldSaleInput = z.infer<typeof voidHeldSaleSchema>;

export const heldSaleListQuerySchema = z.object({
  /// Defaults to OPEN: a till wants the baskets it can still pick up, not
  /// every basket ever parked.
  status: z.enum(['OPEN', 'RESUMED', 'VOIDED']).default('OPEN'),
  warehouseId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HeldSaleListQuery = z.infer<typeof heldSaleListQuerySchema>;

export const saleListQuerySchema = z.object({
  /**
   * Phase 12 (Returns) — find the sale on the receipt in the customer's
   * hand, whichever shift produced it.
   *
   * EXACT match, not a search. `sale_number` carries a
   * `@@unique([businessId, saleNumber])` index, so equality is
   * index-backed and cannot degrade on a large tenant; a `contains`
   * scan would. The stored form is always upper-case (it is derived by
   * `documentNumberFromId`), so the input is upper-cased here and the
   * comparison stays a plain equality - a cashier typing `inv-ead0819b`
   * finds `INV-EAD0819B` without the query becoming a pattern match.
   *
   * This is deliberately the ONLY lookup added: it answers the one
   * question a returns desk actually asks, and adds no new filter
   * surface to reason about.
   */
  saleNumber: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .transform((v) => v.toUpperCase())
    .optional(),
  customerId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;
