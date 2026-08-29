# PROJECT STATE SUMMARY

## Current Phase
Phase 5 — Sales / POS (**Complete, awaiting explicit approval to start Phase 6**)

## Completed Features

### Phases 1-4 (unchanged, carried forward)
Auth, Users, Roles & Permissions, Business/Branches/Warehouses/Settings, append-only Audit log (Phase 1); Categories, Brands, UOM, Attributes, Products, Variants, Barcodes, Bundles, Price Lists (Phase 2); the Inventory Engine — `StockMovement` as sole source of truth, `StockBalance` as a derived/verifiable cache, row-level-locked WAC costing, Opening Stock, Receive/Consume primitives, Adjustments, Bundle consumption, Stock Transfers, Stock Counts, negative-inventory gating, Lots/Serials, Reconciliation (Phase 3); Purchasing — Suppliers, Purchase documents (DRAFT→APPROVED→PARTIALLY_RECEIVED→RECEIVED/CANCELLED), Receiving, Purchase Returns, Payments, Supplier ledger (Phase 4, formally release-gate reviewed — see prior revision of this file for the full findings). See prior revisions of this file / git history for the full write-ups. Not repeated here except where Phase 5 touches them.

**Carried-forward Known Issues from the Phase 4 review** (explicitly not forgotten, per your instruction):
- #23 `PurchaseReturn` missing `idempotencyKey` — still open, unrelated to Phase 5's own `SaleReturn` (which was built WITH idempotency from day one specifically to not repeat this).
- #24 Multi-line lock-ordering deadlock exposure in Phase 3's bundle consumption — **addressed as part of Phase 5**, see Architecture Decisions and Concurrency Review below (the same `consumeVariant` code path Phase 3's bundle sale used is now sorted).
- #25 No cost-visibility gating on Purchasing reads — still open (assessed as intentional for Purchasing); Phase 5 explicitly implements the equivalent gating for Sales, per the spec's explicit requirement for this domain (see Security Review).
- Original deferred scope items #18-#22 (Purchasing landed cost, single-warehouse-per-PO, no supplier price list, no payment void, no Phase 6 wiring) — unchanged, out of Phase 5 scope.

### Phase 5 (new) — Sales / POS

**Scope decisions** (approved before implementation):
- **Held Invoices / stock reservation: OUT for v1.** A Sale is created already-`COMPLETED` in one atomic call; the POS cart lives client-side until checkout. `StockBalance.quantityReserved` (Phase 3) remains unwritten. `SaleStatus` is a deliberate single-value enum (`COMPLETED`) so a future `DRAFT`/`HELD` state can be added later via a new enum value without reshaping the schema or corrupting the completed-sale model.
- **Shift/Register: IN, minimal.** Open/close, identify the active shift, associate completed Sales with it, enforce the active-shift invariant — no cash-count/reconciliation fields, no Register/Terminal/Device entities, no Phase-6 accounting.
- **Offline batch sync: OUT for v1.** No `/pos-sync/*`, `Device`, or `SyncQueueItem`. `CreateSaleUseCase`'s idempotency design (tenant-scoped `Sale.idempotencyKey`) is exactly what a future sync layer would reuse unchanged — Phase 0 §8's own `hash(device_id + offline_transaction_id)` scheme maps directly onto it.

**Customers** (`application/customers/`): create/update/deactivate/list/get. No uniqueness constraint on name/phone (deliberate — real customers legitimately share names, unlike Suppliers). Balance = `SUM(CustomerTransaction.amount)`, never stored, mirroring `SupplierTransaction` exactly.

**Shifts** (`application/shifts/`): `OpenShiftUseCase`/`CloseShiftUseCase`/`GetActiveShiftUseCase`/`ListShiftsUseCase`. Exactly one `OPEN` shift per `(businessId, openedBy)`, enforced by a partial unique index (`shifts_one_open_per_user`) — the first partial index in the schema, genuinely warranted since `CLOSED` shifts must be excluded from the uniqueness check entirely. `CloseShiftUseCase` uses a single conditional `UPDATE ... WHERE status = 'OPEN'` rather than read-then-write, so two concurrent close attempts can never both report success.

**`CreateSaleUseCase`** (`application/sales/create-sale.use-case.ts`) — the critical atomic path, the Phase 5 analog of Purchasing's `ReceivePurchaseUseCase`. One call to `POST /sales`:
1. Idempotency check on `Sale.idempotencyKey`.
2. Resolves the acting user's own `OPEN` Shift (never client-supplied) and requires it to be for the SAME warehouse being sold from.
3. Validates customer (if given) and every line's variant.
4. Computes `subtotal`/`discountAmount`/`taxAmount`/`totalAmount` precisely (see Architecture Decisions for the exact monetary model) and validates the payment invariant.
5. Creates the `Sale` + `SaleItem` rows, then consumes inventory for each line **in canonical `variantId` order** (never client-supplied order) via the shared `consumeVariant` domain helper (see below) - the only inventory-touching step.
6. Records `SalePayment` row(s) for whatever was tendered now.
7. Posts `CustomerTransaction(SALE, +total)` and `CustomerTransaction(PAYMENT, -amount)` per payment - only if a customer is attached.

All in one DB transaction - any failure anywhere rolls back everything, verified explicitly by test.

**`consumeVariant` domain helper** (`modules/inventory/domain/consume-variant.ts`) — extracted from Phase 3's `ConsumeStockUseCase` specifically for Phase 5 (approved extraction), so the exact same stock-consumption logic (including Bundle expansion) can be composed inside a CALLER-OWNED transaction. `ConsumeStockUseCase` itself is now a thin wrapper with byte-for-byte unchanged external behavior (verified: all 34 Phase 3 inventory tests pass unmodified against the refactored code).

**`CreateSaleReturnUseCase`** (`application/returns/`) — single-step atomic action with `idempotencyKey` from day one (explicitly not repeating Known Issue #23). Bounded by `SaleItem.quantity - SaleItem.quantityReturned`, protected by the same Sale-row lock (`lockSale`) `CreateSalePaymentUseCase` uses. `SELLABLE` condition posts a real `SALES_RETURN` increase costed at the ORIGINAL sale's own `unit_cost_at_movement` (looked up and carried over, never fabricated - the same non-fabrication principle Stock Transfers use). `DAMAGED` condition posts the same `SALES_RETURN` increase immediately followed by a `DAMAGE` decrease of the same quantity (net zero stock effect, both real events stay visible in the ledger). The customer credit is posted identically regardless of condition. Bundle-type `SaleItem`s cannot be returned in v1 (rejected explicitly, see Known Issues).

**`CreateSalePaymentUseCase`** (`application/payments/`) — records a LATER payment against a credit sale (the initial tender(s) are captured atomically inside `CreateSaleUseCase`). Bounded by `totalAmount - SUM(existing payments)`, checked under the Sale-row lock so two concurrent late payments can never together overpay - unlike Purchasing's `CreatePurchasePaymentUseCase` (Phase 4), which never bounded payments against the purchase total and so needed no lock. `idempotencyKey` from day one.

**`GetSaleUseCase`/`ListSalesUseCase`** — cost/margin gating: `totalCost`/`grossProfit` (computed live from the Sale's own `SALE`/`BUNDLE_CONSUMPTION` `StockMovement` rows, never from current Product/Variant cost fields) are only attached for a caller holding `products.view_cost`, stripped otherwise via the same `omitFields` helper Phase 3 already used - directly applying the Phase 4 review's lesson (#25) to the one domain where the spec explicitly mandates it (Cashier "بدون رؤية التكلفة/الربح").

## Pending Features
Everything from Phase 6 onward (Finance/Accounting, Reports, Advanced/Promotions/Loyalty, Security & Reliability hardening, Production).

Deliberately out of Phase 5 scope (see Known Issues for the reasoning on each):
- No Held Invoices / stock reservation (see Scope Decisions above).
- No offline batch sync transport (`/pos-sync/*`, `Device`, `SyncQueueItem`) - `CreateSaleUseCase` is designed to be called unchanged by a future sync layer.
- No cash-count/reconciliation on Shift close.
- No Bundle-type `SaleReturn`.
- No price-list/promotion auto-application - `unitPrice` is caller-supplied per line, exactly mirroring `PurchaseItem.unitCost`'s pattern (Promotions/Loyalty are explicitly Phase 8 per the original phase plan).
- No landed-cost or multi-warehouse-per-sale concepts (a Sale targets exactly one `warehouseId`, matching its Shift's warehouse).

## Architecture Decisions
Everything from Phase 0-4 stands unchanged. New Phase 5 decisions, each explained:

- **Sales is a consumer of the Inventory Engine, never a parallel system** - exactly the same posture as Purchasing. `CreateSaleUseCase` and `CreateSaleReturnUseCase` are the only two places in Sales that touch inventory, and both go through `consumeVariant`/`InventoryEngineService.applyMovement` - verified by grep, not just intended.
- **`consumeVariant` was extracted from `ConsumeStockUseCase` (Phase 3) as a tx-accepting domain helper**, the one approved, behavior-preserving touch to Phase 3 code this phase required. `ConsumeStockUseCase`'s own external behavior is unchanged (all 34 Phase 3 tests pass against the refactored code without modification) - it now just delegates to the shared helper instead of containing the logic directly.
- **Canonical lock ordering, closing Known Issue #24 for the exact code path Phase 5 exercises on every multi-line sale**: `CreateSaleUseCase` sorts `SaleItem`s by `variantId` before consuming any of them (never client-supplied order), and `consumeVariant`'s Bundle-expansion branch now sorts `BundleItem` components by `componentVariantId` too (a one-line, behavior-preserving hardening of Phase 3's `consumeBundle`, applied because Phase 5 makes this a routine multi-resource-lock scenario, not because Phase 3 itself was rewritten for unrelated reasons). Proven live by a dedicated concurrency test: two concurrent multi-line sales selling the SAME two variants in OPPOSITE input order both succeed with no deadlock and no lost update.
- **Sale monetary model, precisely defined** (per the explicit requirement to not assume): `subtotal = SUM(quantity × unitPrice)`; `discountAmount`/`taxAmount` = per-line sums; `totalAmount = subtotal - discountAmount + taxAmount` (the "Sale total"/"Net total" - what the customer owes). `paidAmount`/`remainingAmount`/`paymentStatus` are NEVER stored - always `SUM(SalePayment.amount)` / `totalAmount - paid` / derived, computed on read. `SalePayment.amount` is the amount ACTUALLY APPLIED, never more than outstanding - change-due is a cash-drawer/UI concern, explicitly out of scope, not a ledger amount.
- **Credit-sale invariant, stated exactly**: if `Sale.customerId IS NULL` (walk-in, no account to extend credit to), `SUM(initial SalePayment.amount)` MUST equal `totalAmount` exactly at creation - no credit without an identified Customer. If `customerId` IS set, the initial payment may be anything from 0 up to `totalAmount`, collectible later via `POST /sales/:id/payments`, itself bounded and lock-protected against concurrent overpayment.
- **`CustomerTransaction(SALE, +total)` is posted for the FULL sale value regardless of any upfront payment, with each `SalePayment` posting its own separate `CustomerTransaction(PAYMENT, -amount)`** - even for a fully-paid walk-in sale, this nets to zero balance change but preserves a complete audit trail of gross sales value AND payments received as two distinct events, exactly mirroring how Purchasing posts `SupplierTransaction(PURCHASE)` independent of payment timing.
- **A Sale row, once inserted, is a truly immutable event record** - stricter than `purchases` (which needs `UPDATE` for its multi-step status lifecycle). No application code path ever calls `sale.update()`. (One caveat discovered and corrected during testing: PostgreSQL requires the `UPDATE` privilege - not just `SELECT` - to execute `SELECT ... FOR UPDATE`, even though no content-changing UPDATE ever happens; see Migrations item 4 and Known Issues.)
- **A Sale requires an active Shift, enforced server-side, for the SAME warehouse** - `shiftId` is never client-supplied, resolved from "the caller's own currently OPEN shift" exactly like `branchId` is derived from `warehouseId` rather than accepted as input. Attempting a sale with no open shift, or with a shift for a different warehouse, is rejected explicitly and is covered by a dedicated test.
- **`SaleReturn`'s SELLABLE/DAMAGED cost treatment**: SELLABLE carries over the ORIGINAL sale's own `unit_cost_at_movement` (looked up by `referenceType='Sale'`/`referenceId`/`variantId`/`movementType='SALE'`) as the increase's cost - never today's drifted average, proven by a test that deliberately changes the average cost between the sale and the return. DAMAGED nets to zero stock effect via two real, visible movements (increase then `DAMAGE` decrease) rather than being silently skipped or netted away before ever touching the ledger. The customer credit is identical either way - a damaged return is the store's inventory loss to absorb, not the customer's, a deliberate business-rule choice stated explicitly here per your requirement.
- **Bundle-type `SaleItem`s are explicitly rejected from `CreateSaleReturnUseCase`**, not silently mishandled - a bundle return's correct semantics (partial component returns, re-decomposition) were judged too complex to build without a corresponding explicit requirement; flagged as Known Issue rather than guessed at.
- **`documentNumberFromId` was relocated from `modules/purchasing/domain/` to `common/domain/`** - a small, behavior-preserving move (same function, same output, only the import path changed for Purchasing's three callers) since it's a generic formatting utility now shared by two modules, not Purchasing-specific business logic.

## Database Changes
8 new Prisma models: `Customer`, `CustomerTransaction`, `Shift`, `Sale`, `SaleItem`, `SalePayment`, `SaleReturn`, `SaleReturnItem`. New enums: `SaleStatus` (single-value, `COMPLETED` - see Architecture Decisions), `CustomerTransactionType` (`SALE`/`SALE_RETURN`/`PAYMENT`/`OPENING_BALANCE`/`ADJUSTMENT`), `SalePaymentMethod` (`CASH`/`CARD`/`WALLET`/`OTHER`), `SaleReturnCondition` (`SELLABLE`/`DAMAGED`), `ShiftStatus` (`OPEN`/`CLOSED`). `StockMovementType.SALE`/`SALES_RETURN`/`DAMAGE`/`BUNDLE_CONSUMPTION` already existed from Phase 3 and are reused as-is - no new movement types needed. Every new table carries its own `businessId` for direct RLS scoping.

11 new global permission codes: `customers.{view,create,edit,delete}`, `sales.{view,create,return,pay}`, `shifts.{view,open,close}` (84 permissions total now).

## Migrations
1. `20260829112729_sales_schema` - the 8 tables/5 enums above, plus hand-written `CHECK` constraints: non-zero `amount` on `customer_transactions`; `closed_at >= opened_at` on `shifts`; non-negative subtotal/discount/tax/total on `sales`; positive quantity, non-negative price/discount/tax/line-total/quantity-returned, and **`quantity_returned <= quantity`** on `sale_items`; positive quantity + non-negative price on `sale_return_items`; positive `amount` on `sale_payments`. Plus a **partial unique index** `shifts_one_open_per_user (business_id, opened_by) WHERE status = 'OPEN'` - the database-level guarantee behind the "one open shift per user" invariant, not just an application pre-check.
2. `20260829112800_sales_rls` - RLS on all 8 tables, same default-deny pattern as every prior phase.
3. `20260829112900_sales_app_role_grants` - extends `erp_app`: `customers`/`shifts`/`sale_items` get SELECT+INSERT+UPDATE (genuine in-place mutation - contact details, OPEN→CLOSED transition, the `quantity_returned` running total); everything else (`customer_transactions`, `sales`, `sale_payments`, `sale_returns`, `sale_return_items`) gets SELECT+INSERT only - true event records. Notably, unlike Purchasing, **nothing in Sales needs a DELETE grant at all**, since there is no DRAFT-edit lifecycle for a Sale (it's created already-complete).
4. `20260829130000_sales_lock_update_grant` - a correction found **during e2e testing, not by re-reading the grants migration**: PostgreSQL requires the `UPDATE` privilege (not just `SELECT`) to execute `SELECT ... FOR UPDATE`, which `lockSale` (used by `CreateSaleReturnUseCase`/`CreateSalePaymentUseCase`) does against `sales`. The original grants migration withheld `UPDATE` reasoning "nothing content-updates a Sale row," which is still true and still the design intent - but too narrow, since Postgres treats row-locking itself as write-intent regardless of whether a write follows. Fixed via a small, explained follow-up migration (the exact same "narrow, explained follow-up" pattern as Phase 4's `purchase_items_delete_grant`), reverified live: the failing e2e test (a real `permission denied for table sales` Postgres error, not a guess) now passes.

Applied and verified against both `erp_dev` and `erp_test` (`prisma migrate status`: both "up to date", **19 migrations total** across all five phases). Verified directly via SQL, not just assumed:
- `pg_class.relrowsecurity`/`relforcerowsecurity` = true on all 8 new tables.
- `information_schema.role_table_grants` for `erp_app` matches the design exactly, including the corrected `sales` grant (`INSERT,SELECT,UPDATE`).
- `pg_constraint` confirms all 16 hand-written CHECK constraints landed, and confirms `confdeltype = 'c'` (CASCADE) on every single `*_business_fk` relation across all 8 new tables - directly applying the Phase 4 review's lesson (the `PurchaseReceiptItem`/`PurchaseReturnItem` FK-defaulted-to-RESTRICT defect) so it was not repeated once in this phase's fresh schema.
- The partial unique index `shifts_one_open_per_user` confirmed present via `pg_indexes` with its exact `WHERE (status = 'OPEN'::"ShiftStatus")` clause.

## API Endpoints
All new endpoints under `/api/v1/sales`, same `{ data }` / `{ error }` envelope (list endpoints also return `pagination`).

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/sales/customers` | `customers.view` / `.create` |
| GET | `/sales/customers/:id` | `customers.view` |
| PATCH | `/sales/customers/:id` | `customers.edit` |
| DELETE | `/sales/customers/:id` | `customers.delete` (deactivate) |
| GET | `/sales/shifts` | `shifts.view` |
| GET | `/sales/shifts/active` | `shifts.view` |
| POST | `/sales/shifts/open` | `shifts.open` |
| POST | `/sales/shifts/close` | `shifts.close` |
| GET/POST | `/sales` | `sales.view` / `.create` |
| GET | `/sales/:id` | `sales.view` |
| POST | `/sales/:id/returns` | `sales.return` |
| POST | `/sales/:id/payments` | `sales.pay` |

All request bodies/queries validated against shared zod schemas in `packages/shared-validation/src/sales.ts`.

Role-template grants: `BUSINESS_OWNER` gets everything (as always). `BRANCH_MANAGER`/`ACCOUNTANT` get oversight (`customers.view`, `sales.view`, `shifts.view`, plus `sales.return`/`.pay` for Branch Manager and `sales.pay` for Accountant). `CASHIER` gets the full POS floor set (`customers.{view,create}`, `sales.{view,create,return,pay}`, `shifts.{view,open,close}`) but deliberately **not** `products.view_cost` - matching Phase 0 §9's explicit "no cost/profit visibility" requirement for this template, enforced server-side (see Security Review) not just by omission of a button. `SALES_EMPLOYEE` gets a similar operational set plus fuller customer management (`customers.edit`) but not `sales.pay`. `INVENTORY_MANAGER` gets no sales permissions at all (unchanged from Phase 4).

## Screens
None (still backend-only - unchanged from Phases 1-4; still flagging this for your review).

## Tests and Results
- **E2E** (real NestJS app + real PostgreSQL `erp_test`, no mocks): **40 new tests, 5 new files**, combined with Phases 1-4's 150: **190/190 pass.**
  - `sales-customers.e2e-spec.ts` (6) - create with balance 0; two customers sharing a name allowed (no uniqueness constraint, by design); invalid input (empty name, bad email); update + deactivate + reject-double-deactivation; 404 on unknown id; list with pagination/search.
  - `sales-shifts.e2e-spec.ts` (5) - no active shift initially, open reports it active, close clears it; reject opening a second shift while one is open; reject closing with none open; reject opening against an unknown warehouse; **the active-shift invariant test** - a sale is rejected with `CONFLICT` when the actor has no open shift.
  - `sales-lifecycle.e2e-spec.ts` (10) - a fully-paid walk-in sale with correct totals, a real `SALE` `StockMovement`, and zero customer-ledger rows; a credit sale posting both `SALE`(+total) and `PAYMENT`(-paid) ledger entries with the correct remaining balance; a fully-credit (zero-payment) sale paid down via later calls, with over-payment rejected (`CONFLICT`) both mid-way and once fully paid; rejection of an underpaid walk-in sale and of payments exceeding the total (both `VALIDATION_FAILED`); rejection of empty items/unknown variant/duplicate variant/zero quantity/unknown warehouse; rejection of selling to an inactive customer; **price-snapshot integrity** - `SaleItem.unitPrice` and the sale's totals are unchanged after the variant's live selling price is changed afterward; selling a Bundle-type variant correctly consumes its components via the shared `consumeVariant` path; **cost visibility** - an Owner sees `totalCost`/`grossProfit` on `GET /sales/:id`, a Cashier's identical request has both fields entirely absent from the response body.
  - `sales-returns.e2e-spec.ts` (6) - a SELLABLE return costed at the ORIGINAL sale's cost (proven by deliberately drifting the average cost between sale and return and confirming the return movement still uses the old cost, with the original SALE movement re-read and confirmed byte-for-byte unchanged) and a customer credit; a DAMAGED return proven to net to zero stock effect via two distinct, visible movements, with the customer still credited; over-return prevention in one call and cumulatively; rejection of returning a Bundle-type sale item; rejection of a duplicate `saleItemId` within one call and of a `saleItemId` foreign to the referenced sale; sequential idempotency (a retry after commit returns the original return, one movement).
  - `sales-concurrency-and-isolation.e2e-spec.ts` (13) - **six real-concurrency tests** (see Concurrency Review); a Cashier proven able to open a shift, sell, and close it, but forbidden from an out-of-template action (creating a user); a role with zero sales permissions (`INVENTORY_MANAGER`) forbidden from every sales route; the two-layer tenant-isolation proof (API: cross-tenant sale/return access returns 404, a cross-tenant list never contains foreign data; DB: raw SQL as the restricted `erp_app` role returns zero rows with no tenant context, correctly scoped rows with tenant context set, `customer_transactions` proven to have no UPDATE/DELETE grant even via a direct connection, and an RLS `WITH CHECK` rejection of a cross-tenant insert attempt).
- **Unit**: no new unit tests were needed - Sales intentionally reuses `InventoryEngineService`'s already-unit-tested WAC/locking math (via the extracted `consumeVariant` helper) rather than reimplementing any of it. Phase 1-4's 28 unit tests remain green.
- Full regression: **190/190 e2e + 28/28 unit**, zero regressions from Phases 1-4 (Phase 3's 34 inventory tests specifically re-verified to pass unmodified against the `consumeVariant` extraction).

## Security Review
Everything from Phases 1-4 stands unchanged. Phase 5 additions:
- Every sales-mutating endpoint requires its own specific permission (11 new codes) rather than one blanket `sales.manage` - verified by test at two privilege levels: a Cashier (the intended POS-floor role) allowed to open a shift, sell, and return, but rejected from an out-of-template action; a role with zero sales permissions rejected from every sales route entirely.
- **Cost/margin visibility is server-side gated on Sales, directly satisfying the Phase 0 spec's explicit requirement for this domain** (unlike Purchasing, where it was left as a judgment call - Known Issue #25): `GetSaleUseCase` only attaches `totalCost`/`grossProfit` for a caller holding `products.view_cost`, verified through the actual API with two different tokens against the same sale, not merely asserted from code reading.
- `customer_transactions`, `sales`, `sale_payments`, `sale_returns`, `sale_return_items` all have no DELETE grant for the runtime role (and no UPDATE either, except `sales`' Postgres-required lock-support grant - see Migrations item 4, which does not enable any code path to actually mutate content) - verified by test that UPDATE/DELETE against `customer_transactions` fails with a real Postgres permission-denied error via a direct connection as the restricted role.
- The same RLS + non-superuser-role pattern is proven again for the new tables via raw SQL: an unfiltered `SELECT * FROM sales`/`SELECT * FROM customers` as `erp_app` with no tenant context returns zero rows, and an attempted cross-tenant `INSERT` is rejected by the `WITH CHECK` clause.

## Business Logic Review
- Every sales use case validates its references (warehouse/customer/variant belong to the caller's tenant, customer is active, shift matches the warehouse) before writing anything, returning 404/422/409 rather than silently creating cross-tenant, invalid, or shift-less data.
- Every quantity/cost/price value is a `Prisma.Decimal` throughout, matching the no-floating-point-near-money discipline from every prior phase - explicitly verified by a dedicated test exercising discount/tax arithmetic across a multi-field computation (subtotal 45, discount 3, tax 2 → total exactly 44, `toString()`-compared, no rounding drift).
- The three places this phase does something meaningfully more sophisticated than "call an existing use case" - the canonical lock-ordering for multi-line/bundled sales, the SELLABLE/DAMAGED return cost treatment, and the credit-sale payment-bound invariant under concurrency - are each covered by a test that specifically targets that sophistication rather than only the happy path.
- The credit-sale invariant (walk-in must be paid in full; a customer may owe any amount from 0 up to the total) is enforced at creation and re-verified at every later payment under a lock, closing the exact class of "two nearly-simultaneous partial payments together overpay" bug the review anticipated.

## Inventory Integration Review
Direct evidence that Sales is a real, atomic consumer of the Inventory Engine and not a parallel system:
1. **No new source of inventory truth was created.** Grep-verified: the only two calls to `consumeVariant`/`InventoryEngineService.applyMovement` in the entire `sales` module are in `CreateSaleUseCase` and `CreateSaleReturnUseCase`; nowhere in Sales is `stock_balances`/`stock_movements` written directly.
2. **`unit_cost_at_movement` is preserved exactly as designed in Phase 3.** A sale's `StockMovement.unitCostAtMovement` is the engine's own computed average cost at that instant (no override passed); a SELLABLE return's reversing movement carries over that EXACT original value, looked up from the ledger itself, never re-derived from a mutable Product/Variant field - proven by a test that drifts the average cost between sale and return and confirms the return still uses the old value.
3. **Every sale/return is one atomic DB transaction** - proven directly by the multi-line lock-ordering test (no deadlock, no partial application) and by construction (a Sale row and its inventory effects are created in the exact same `withTenant` transaction; any failure anywhere rolls back the whole thing, including the Sale/SaleItem rows themselves).
4. **No historical `StockMovement` is ever modified or deleted by a return** - proven by re-reading the original `SALE` movement byte-for-byte after a `SALES_RETURN` was posted and confirming it is completely unchanged.
5. **Bundle consumption, Purchasing, Stock Transfers, Stock Counts, and every other Phase 3/4 capability are untouched beyond the one approved extraction** - Sales added zero new logic to `inventory-engine.service.ts`; the only Phase 3 file touched (`consume-stock.use-case.ts`) has byte-for-byte unchanged external behavior, proven by its full existing test suite passing unmodified.

## Customer Ledger & Payment Integration Review
- `CustomerTransaction` is append-only at the DB-privilege level (SELECT+INSERT only for `erp_app`), exactly mirroring `SupplierTransaction` - verified live via a direct-connection UPDATE/DELETE rejection test.
- Balance is always `SUM(CustomerTransaction.amount)`, computed on read, never a stored/mutable column - verified by a test that checks the exact expected balance after a partial payment (`total 40, paid 15 → balance 25`).
- `Sale`, `SaleReturn`, and `SalePayment` effects cannot be duplicated under retry: `Sale.idempotencyKey`, `SaleReturn.idempotencyKey`, and `SalePayment.idempotencyKey` are all tenant-scoped, DB-unique, and proven under TRUE concurrent duplicate requests (not just sequential retries) for the Sale case specifically - two simultaneous identical `POST /sales` calls with the same key produce exactly one `Sale`, one `StockMovement`, one set of ledger effects.
- No Phase-6 accounting entities were invented. `SalePayment` carries only a descriptive `method` enum, no `FinancialAccount`/`JournalEntry` reference - the exact same deliberate boundary Purchasing's `PurchasePayment` established, extended consistently to Sales.
- **What Phase 5 records**: `Sale`/`SaleItem` (what was sold, at what price, snapshotted forever), `SalePayment` (what was actually collected, by what method, when), `CustomerTransaction` (the derived-balance ledger), `SaleReturn`/`SaleReturnItem` (what came back, in what condition). **What Phase 6 will own**: posting these already-complete, immutable facts into a chart of accounts / journal entries (Sales Revenue, COGS, Accounts Receivable, Cash/Card/Wallet accounts, Tax Payable) - none of which exists yet, per explicit instruction not to build a parallel/fake accounting system early.

## Concurrency Review
**Six** e2e tests fire genuinely concurrent HTTP requests (`Promise.all` against the live, already-running NestJS app, real PostgreSQL round-trips for each) - covering every scenario your rules required:
1. **LAST UNIT**: 5 concurrent sales of a 1-unit balance → exactly 1 succeeds (201), 4 rejected (409 `INSUFFICIENT_STOCK`), final balance exactly `0` (never negative), exactly 1 `SALE` movement.
2. **MULTI-UNIT**: 10 concurrent sales of 3 units each against a 20-unit balance (30 requested, only 20 available) → total consumed never exceeds 20, final balance exactly `20 - (successes × 3)`.
3. **SHARED-VARIANT ORDERING**: two concurrent multi-line sales selling the SAME two variants in OPPOSITE input order (the exact lock-order-inversion shape) both succeed with no deadlock and the exact correct final balance on both variants - direct proof the canonical `variantId` sort (Architecture Decisions) works, not just a theoretical claim.
4. **BUNDLE CONTENTION**: two concurrent bundle sales, each needing 3 of a 5-unit scarce shared component (6 requested total) → exactly 1 succeeds, final component balance exactly `2` (never negative).
5. **SALE + RETURN**: a concurrent new sale (decreasing) and a return of a different, earlier sale (increasing) racing on the SAME `StockBalance` row → final balance exactly reflects both operations regardless of which the row lock serialized first (`16 - 5 + 2 = 13`), 3 real movements plus the one from the earlier setup sale.
6. **DUPLICATE IDEMPOTENCY**: two truly simultaneous `POST /sales` requests with the identical `idempotencyKey` → exactly 1 succeeds, exactly 1 `StockMovement`, exactly 1 `Sale` row for that key.

Mechanism: identical to Phase 3/4 - `InventoryEngineService` takes `SELECT ... FOR UPDATE` on each `StockBalance` row before reading or computing anything; `lockSale` does the same for the Sale-document-level invariants (returns, late payments). What's new this phase is the PROOF that acquiring multiple such locks in a call (a multi-line sale, a bundle sale) is deadlock-safe under real concurrency when acquisition order is canonicalized - test #3 above is the direct, executed proof of the Architecture Decisions' lock-ordering claim, not just an inspection-based argument the way Phase 4's review had to leave it.

## Historical Integrity Review
- Once completed, a `Sale` is never mutated by application code (no `sale.update()` call exists anywhere) - the only path that touches an existing Sale's children is `SaleItem.quantityReturned` (a running total, exactly like `PurchaseItem.quantityReturned`) and `SalePayment` inserts (new rows, never edits).
- `StockMovement` rows produced by a Sale or a SaleReturn are never modified or deleted - proven by re-reading the original `SALE` movement after a return and confirming it is byte-for-byte unchanged.
- COGS is never recalculated from current Product/Variant cost - every movement's `unit_cost_at_movement` is fixed at write time (the engine's own rule, untouched), and a SELLABLE return explicitly carries over the ORIGINAL sale's cost rather than re-deriving it, proven under a deliberately drifted average-cost scenario.
- Corrections always use a proper workflow: an over-quantity or wrong-price sale is corrected via `SaleReturn` (a new document, new movements), never by editing the original `Sale`/`SaleItem`/`StockMovement` rows.
- Soft-deactivating a Customer (`isActive = false`) does not touch or hide their historical Sales - `erp_app` has no DELETE grant on `customers`, and no read path filters sales by the customer's current `isActive` status.

## Known Issues / Technical Debt
Phase 1-4's lists stand unchanged (including the carried-forward #23/#24/#25 - see the note under Completed Features for exactly which of those Phase 5 did and didn't address). New from Phase 5:

26. **No Bundle-type `SaleReturn`** - a bundle sale can be completed, but returning it is rejected explicitly (`VALIDATION_FAILED`) rather than attempting a partial component-level return. The correct semantics (which components come back, in what condition, individually) were judged too complex to build without an explicit spec requirement; flagged rather than guessed at.
27. **No landed-cost/multi-warehouse-per-sale** - a Sale targets exactly one `warehouseId` (matching its Shift's warehouse), no allocation of extra costs. Consistent with the same scope boundary Purchasing drew in Phase 4.
28. **Shift has no cash-count/reconciliation** - by deliberate scope decision (approved: "do NOT turn this into a full cash-management/accounting module"). If ever needed, the natural extension is an `expectedCash`/`countedCash` pair on close, without touching the core open/close/active-shift-required mechanics built now.
29. **No price-list/promotion auto-application** - `unitPrice` is caller-supplied per line (mirrors `PurchaseItem.unitCost`'s established pattern); Phase 2's `ProductPrice`/`PriceList` exist and could pre-fill a default client-side, but the server does not cross-check or auto-populate it. Promotions/Loyalty are explicitly Phase 8 territory.
30. **`sales` needed a Postgres-mechanical `UPDATE` grant purely to support `SELECT ... FOR UPDATE`** (Migrations item 4) - a real, minor design-time miss (not caught until a live e2e test hit a genuine permission-denied error), now fixed and documented as a general lesson: any table a future phase needs to lock via `FOR UPDATE` needs the `UPDATE` grant regardless of whether a real content update ever happens.
31. **No offline sync transport** - deliberately out of v1 scope; `CreateSaleUseCase`'s idempotency design is built to be reusable unchanged by a future sync layer (see Scope Decisions), but the transport itself (`/pos-sync/*`, `Device`, `SyncQueueItem`, conflict-review UI) does not exist yet.

## Files Created
Prisma migrations: `apps/api/prisma/migrations/20260829112729_sales_schema/`, `.../20260829112800_sales_rls/`, `.../20260829112900_sales_app_role_grants/`, `.../20260829130000_sales_lock_update_grant/`.

Shared validation: `packages/shared-validation/src/sales.ts`.

Shared common: `apps/api/src/common/domain/document-number.ts` (relocated from `modules/purchasing/domain/`).

Inventory (Phase 3, extended): `apps/api/src/modules/inventory/domain/consume-variant.ts`.

Sales module (`apps/api/src/modules/sales/`): `sales.module.ts`; `domain/{customer-balance,lock-sale,find-active-shift,sale-cost}.ts`; `application/customers/{create-customer,update-customer,deactivate-customer,list-customers,get-customer}.use-case.ts`; `application/shifts/{open-shift,close-shift,get-active-shift,list-shifts}.use-case.ts`; `application/sales/{create-sale,get-sale,list-sales}.use-case.ts`; `application/returns/create-sale-return.use-case.ts`; `application/payments/create-sale-payment.use-case.ts`; `presentation/{customers,shifts,sales}.controller.ts`.

Tests: `apps/api/test/sales-{customers,shifts,lifecycle,returns,concurrency-and-isolation}.e2e-spec.ts`, `apps/api/test/utils/sales-fixtures.ts`.

## Files Modified
`apps/api/prisma/schema.prisma` (8 new models/5 enums + Business/Branch/Warehouse/ProductVariant relations), `apps/api/prisma/seed.ts` (11 new permission descriptions), `apps/api/src/app.module.ts` (wire `SalesModule`), `apps/api/test/db-reset.ts` (truncate the 8 new tables), `packages/shared-types/src/permissions.ts` (11 new codes + role-template grants for `BRANCH_MANAGER`/`ACCOUNTANT`/`CASHIER`/`SALES_EMPLOYEE`), `packages/shared-validation/src/index.ts` (re-export `sales.ts`), `apps/api/src/modules/inventory/application/stock/consume-stock.use-case.ts` (rewritten as a thin wrapper over `consumeVariant`, unchanged external behavior), `apps/api/src/modules/purchasing/application/{purchases/create-purchase,receiving/receive-purchase,returns/create-purchase-return}.use-case.ts` (import path updated for the relocated `documentNumberFromId`).

## Next Phase
**Phase 6 — Finance/Accounting**: expected to own posting the already-complete, immutable facts Phases 4-5 recorded (`SupplierTransaction`, `CustomerTransaction`, `PurchasePayment`, `SalePayment`, and every `StockMovement`'s `unit_cost_at_movement`) into a real Chart of Accounts / double-entry Journal, per Phase 0 §6 - a real `AccountingEngine.postEntry(...)` interface, `JournalEntry`/`JournalEntryLine`/`Account`/`FiscalPeriod`, and an explicit `AccountingMappingRule` configuration table, not `if/else` scattered through Sales/Purchasing code.
**Will not start until you explicitly approve this Phase 5 report.**
