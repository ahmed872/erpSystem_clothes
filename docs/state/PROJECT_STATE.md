# PROJECT STATE SUMMARY

## Current Phase
Phase 3 — Inventory Engine (**Complete, awaiting explicit approval to start Phase 4**)

## Completed Features

### Phases 1-2 (unchanged, carried forward)
Auth, Users, Roles & Permissions, Business/Branches/Warehouses/Settings, append-only Audit log (Phase 1); Categories, Brands, UOM, Attributes, Products, Variants, Barcodes, Bundles (composition), Price Lists (Phase 2). See prior revisions of this file / git history for the full write-ups. Not repeated here except where Phase 3 touches them.

### Phase 3 (new) — Inventory Engine
- **`InventoryEngineService`** (`apps/api/src/engines/inventory/`): the single shared core every stock-affecting use case calls. Two entry points:
  - `applyMovement` — signed delta (increase or decrease).
  - `applyAbsoluteQuantity` — locks the balance FIRST, then computes the delta from the target quantity against the freshly-locked value (used by stock-count approval; see Architecture Decisions for why a naive "peek then apply" would have been a real race-condition bug).
  - Both funnel into one private method that does the WAC math, the negative-stock check, the `StockMovement` insert, and the `StockBalance` update — all inside the caller's existing tenant transaction.
- **Row-level locking**: every call takes `SELECT ... FOR UPDATE` on the `(business, warehouse, variant)` `StockBalance` row (creating it with `INSERT ... ON CONFLICT DO NOTHING` first if it doesn't exist yet) before reading/computing anything. Verified under **real concurrent HTTP load** (see Concurrency Review) — not a theoretical claim.
- **Weighted Average Cost**: implemented exactly as designed in Phase 0 §10. Every `StockMovement` stores `unitCostAtMovement`; on an increase this is the input cost, on a decrease it's the average cost at that instant (COGS), and a decrease never changes the average. Verified both by isolated unit tests (11 cases covering the math directly) and e2e tests reading back historical rows after a later cost change.
- **Opening Stock**: one-time per `(warehouse, variant)` — a second attempt is rejected (`CONFLICT`); further correction must go through an Adjustment.
- **Receive / Consume** (generic stock-in/stock-out primitives): `PURCHASE`/`SALES_RETURN` and `SALE`/`PURCHASE_RETURN` respectively. Built as real, usable, permission-gated endpoints now — not stubs — specifically so Phase 4 (Purchasing) and Phase 5 (Sales/POS) can call the same use cases once they exist, per your instruction not to build throwaway integration points.
- **Adjustments**: signed quantity, always requires a reason, covers `ADJUSTMENT`/`DAMAGE`/`LOSS`/`INTERNAL_CONSUMPTION`/`EXPIRY` through one endpoint (all funnel through the same engine call, distinguished only by `movementType`).
- **Bundle consumption**: selling a `BUNDLE`-type variant consumes its `BundleItem` components (each getting its own `BUNDLE_CONSUMPTION` movement, `quantity × bundle ratio`), never the bundle variant itself — matching Phase 2's "a bundle carries no inventory of its own" design. All components consume inside the SAME transaction: if any one is short, the entire bundle sale rolls back with zero partial consumption (verified explicitly by test).
- **Stock Transfers**: `DRAFT → IN_TRANSIT → COMPLETED`. Sending decrements the source only (creates `TRANSFER_OUT`); receiving increments the destination only (creates `TRANSFER_IN`), **carrying over the exact cost recorded on the corresponding `TRANSFER_OUT` movement** rather than fabricating a new purchase cost (a transfer between two warehouses of the same business is not a purchase). `quantityReceived` may differ from `quantity` sent (shrinkage/damage in transit) and is reported, not silently reconciled. All items must be received together in one call.
- **Stock Counts**: `DRAFT → SUBMITTED → APPROVED`. Creating a count snapshots `expectedQuantity` per variant for the counter's reference; approving computes each item's adjustment against the **live, locked** balance at approval time via `applyAbsoluteQuantity`, not the stale snapshot — verified by a test that sells stock *during* an open count and confirms the concurrent sale is correctly reflected, not silently overwritten.
- **Negative Inventory**: disabled by default, exactly as required. Going negative requires **both** the tenant `Setting` (`inventory.allow_negative_stock`, reusing Phase 1's generic Setting store rather than a new column) **and** the specific actor holding the `inventory.allow_negative` permission — the setting alone is insufficient, verified by test with a permission-less user against an enabled setting.
- **Lots & Serial Numbers**: `InventoryLot` is a metadata registry only (lot number, expiry, manufacturing date) — never a quantity counter; "how much of lot X remains" is always `SUM(quantity_base) WHERE lot_id = X` against the ledger, extending the "ledger is the only source of truth" principle down to lot level. `SerialNumber` rows are created on receipt (count must match quantity exactly) and consumed (marked `SOLD`) on a `SALE`-type consumption. Two new boolean flags (`Product.tracksLots`, `Product.tracksSerialNumbers`) were added and wired all the way through Phase 2's product create/update endpoints (a necessary small Phase 2 touch-up — see Files Modified).
- **Reconciliation**: `GET /inventory/reconciliation` independently recomputes every `(warehouse, variant)` quantity via `SUM(quantity_base)` straight from `stock_movements` and diffs it against the cached `StockBalance`. Verified by a test that deliberately corrupts a balance via direct SQL (bypassing the engine) and confirms the endpoint catches it.
- **Multi-UOM integration**: receiving/adjusting in a non-base UOM (e.g. "5 Cartons") converts to the variant's base UOM using Phase 2's `ProductUom.conversionFactor` before ever reaching the engine; cost is converted from per-entered-UOM to per-base-unit the same way.

## Pending Features
Everything from Phase 4 onward (Purchasing, POS/Sales, Finance/Accounting, Reports, Advanced, Security & Reliability hardening, Production).

Deliberately out of Phase 3 scope (per your instruction to prioritize correctness over breadth this phase — see Known Issues for the reasoning on each):
- No Purchase Invoice or Sales Invoice workflow — `POST /inventory/receipts` and `/consumptions` are the generic primitives those modules will call; Phase 3 exposes them directly so they're real and testable now, not fake.
- No reservation semantics at Stock Transfer Draft stage, or anywhere else yet (`StockBalance.quantityReserved` exists as a schema-ready column, always 0 in Phase 3 — Phase 5's POS "hold invoice" is the first real writer).
- No partial/staged Stock Transfer receiving (all items must be received together).
- No FIFO-by-expiry consumption logic or expiry alerting — `InventoryLot.expiryDate` is stored and indexed, ready for Phase 7 reporting to use.
- No Serial Number handling on `PURCHASE_RETURN` consumption (only on `SALE`).

## Architecture Decisions
Everything from Phase 0-2 stands unchanged. New Phase 3 decisions, each explained:

- **`StockMovement` is the exclusive source of inventory truth; `StockBalance` is a derived cache, period.** No `Product.quantity` or similar counter exists anywhere in the schema. Enforced structurally (there is no such column) and operationally (`InventoryEngineService` is the only code path that ever writes `stock_balances`, always inside the same transaction as the `stock_movements` row it summarizes) and verifiably (the reconciliation endpoint independently recomputes the cache from the ledger on demand).
- **Concurrency via `SELECT ... FOR UPDATE` on the `StockBalance` row**, not application-level mutexes or optimistic-locking retries. Chosen because it's the simplest mechanism that gives an exact guarantee (Postgres blocks the second transaction until the first commits/rolls back) rather than a probabilistic one, and it composes correctly with the existing `PrismaService.withTenant` transaction pattern from Phase 1 with no new infrastructure. The lock-or-create helper handles the first-ever-movement race (two concurrent transactions both finding no balance row) via `INSERT ... ON CONFLICT DO NOTHING` followed by a re-`SELECT ... FOR UPDATE`, so the second transaction still ends up correctly blocked on the row the first one just created.
- **`applyAbsoluteQuantity` exists as a distinct method from `applyMovement`, specifically for stock-count approval.** The first implementation of `ApproveStockCountUseCase` "peeked" the current balance, computed a delta, then called `applyMovement` — a real race window: if a sale happened between the peek and the lock being acquired, the precomputed delta would be wrong. Caught during design (not by a test after the fact) and fixed by having the engine lock first and compute the delta internally. This is documented in the engine's own doc comments and covered by 3 dedicated unit tests plus an e2e test that sells stock mid-count and confirms the correct outcome.
- **COGS/decrease cost is always the ledger's current average cost — an increase's cost is a required input, never inferred.** No code path lets a caller assert what a sale's COGS should be; `unitCostOverride` in `ApplyMovementParams` is explicitly documented as ignored for decreases.
- **Negative inventory requires Setting AND Permission, not either alone**, matching Phase 0 §48's "must have a Permission" requirement literally. Implemented as a small pure function (`resolveAllowNegative`) reusing Phase 1's generic `Setting` store rather than adding a dedicated `Business` column, since it's exactly the per-tenant config that module exists for.
- **A transfer's received cost is carried over from its own sent movement, never re-derived.** `ReceiveStockTransferUseCase` looks up the `TRANSFER_OUT` movement(s) created by `SendStockTransferUseCase` for the same `referenceId` and passes that exact `unitCostAtMovement` as the `TRANSFER_IN`'s cost basis — a transfer is not a purchase and must never fabricate a new cost.
- **Lot/Serial quantity is never stored** — only lot/serial *identity* and metadata are. Extends the "ledger is the only source of truth" principle down one level, on the same reasoning as `StockBalance` itself.
- **`Product.tracksLots`/`tracksSerialNumbers` were added to the Product table in this phase**, and Phase 2's product create/update zod schemas and use cases were extended (not rewritten) to accept them. This is a legitimate Phase 3 need (the Inventory Engine has to know whether a variant requires lot/serial data on a movement) implemented as a strictly additive schema change plus a minimal wiring change to existing Phase 2 code — not a rewrite of Phase 2's business logic, consistent with instruction #12.
- **Receive/Consume/Adjust are generic primitives exposed as real endpoints now, not deferred.** Phase 4/5 are expected to call the same use-case classes directly (not re-implement inventory logic) once Purchasing/Sales exist; exposing them via a permission-gated endpoint now (rather than only as internal methods with no caller) is what let this phase's tests exercise real concurrency and real cost math end-to-end through the actual HTTP stack instead of only at the unit level.

## Database Changes
8 new Prisma models: `StockMovement`, `StockBalance`, `InventoryLot`, `SerialNumber`, `StockCount`, `StockCountItem`, `StockTransfer`, `StockTransferItem`. New enums: `StockMovementType` (15 values matching Phase 0 §9 exactly), `StockCountStatus`, `StockTransferStatus`, `SerialNumberStatus`. Two new columns on the existing `Product` table: `tracksLots`, `tracksSerialNumbers` (both `Boolean @default(false)`, purely additive).

11 new global permission codes: `inventory.{view, opening_stock, receive, consume, adjust, allow_negative, transfer_create, transfer_send, transfer_receive, stock_count_create, stock_count_approve}` (61 permissions total now).

## Migrations
1. `20260828131355_inventory_schema` — the 8 tables/4 enums/2 Product columns above, plus hand-written `CHECK` constraints Prisma's schema DSL can't express: `quantity_base <> 0` and non-negative unit cost on `stock_movements`; non-negative average cost/reserved quantity on `stock_balances`; non-negative expected/actual quantity on `stock_count_items`; positive transfer quantity and non-negative received quantity on `stock_transfer_items`; source ≠ destination warehouse on `stock_transfers`.
2. `20260828131600_inventory_rls` — RLS on all 8 tables, same default-deny pattern as every prior phase: 6 tables scoped directly by `business_id`; `stock_count_items`/`stock_transfer_items` (pure child tables with no `business_id` of their own) scoped transitively via their parent's tenant.
3. `20260828131700_inventory_app_role_grants` — extends `erp_app`: **`stock_movements` gets SELECT+INSERT only — no UPDATE, no DELETE, ever** (the ledger is truly append-only, enforced at the database-privilege level exactly as instructed, not merely by application discipline). Every other Phase 3 table gets SELECT+INSERT+UPDATE, no DELETE (extending Phase 1/2's "nothing in a domain that will be heavily referenced gets hard-deleted" posture to the entire inventory domain).
4. `20260828131832_lot_fk_restrict` — a design correction made during this phase, before anything depended on the original behavior: `stock_movements.lot_id`'s foreign key was initially `ON DELETE SET NULL`; changed to `ON DELETE RESTRICT` so a lot referenced by a historical movement can never have that reference silently stripped by a lot deletion. (Moot in practice too, since `erp_app` has no DELETE grant on `inventory_lots` at all — this is defense in depth on top of that.)

Applied and verified against both `erp_dev` and `erp_test` (`prisma migrate status`: both "up to date", 10 migrations total across all three phases). RLS enabled+forced confirmed via direct `pg_class` query on all 8 new tables; `stock_movements` grants confirmed SELECT+INSERT only via `information_schema.role_table_grants`.

## API Endpoints
All new endpoints under `/api/v1/inventory`, same `{ data }` / `{ error }` envelope (list endpoints also return `pagination`).

| Method | Path | Permission |
|---|---|---|
| POST | `/inventory/opening-stock` | `inventory.opening_stock` |
| POST | `/inventory/receipts` | `inventory.receive` |
| POST | `/inventory/consumptions` | `inventory.consume` |
| POST | `/inventory/adjustments` | `inventory.adjust` |
| GET | `/inventory/balances` | `inventory.view` |
| GET | `/inventory/movements` | `inventory.view` |
| GET | `/inventory/reconciliation?warehouseId=` | `inventory.view` |
| GET | `/inventory/lots?variantId=` | `inventory.view` |
| GET | `/inventory/serials?variantId=&status=` | `inventory.view` |
| GET/POST | `/inventory/transfers` | `inventory.view` / `.transfer_create` |
| GET | `/inventory/transfers/:id` | `inventory.view` |
| POST | `/inventory/transfers/:id/send` | `inventory.transfer_send` |
| POST | `/inventory/transfers/:id/receive` | `inventory.transfer_receive` |
| POST | `/inventory/stock-counts` | `inventory.stock_count_create` |
| GET | `/inventory/stock-counts/:id` | `inventory.view` |
| PATCH | `/inventory/stock-counts/:id/items` | `inventory.stock_count_create` |
| POST | `/inventory/stock-counts/:id/submit` | `inventory.stock_count_create` |
| POST | `/inventory/stock-counts/:id/approve` | `inventory.stock_count_approve` |

All request bodies/queries validated against shared zod schemas in `packages/shared-validation/src/inventory.ts`.

## Screens
None (still backend-only — unchanged from Phase 1/2; still flagging this for your review).

## Tests and Results
- **Unit** (no DB): **11 new tests** in `engines/inventory/__tests__/inventory-engine.service.spec.ts`, exercising the WAC math and negative-stock guard against a hand-rolled fake `tx` backed by real `Prisma.Decimal` arithmetic — first-purchase cost-setting, correct weighted blend across two purchases, a decrease locking in COGS without changing the average, a later purchase never rewriting an earlier movement's recorded cost, rejection when going negative without permission, allowance with the flag set (and the movement flagged), cost-basis reset when crossing from a negative balance back to positive, rejection of a zero delta, and 3 cases specifically for `applyAbsoluteQuantity` (delta computed from the locked value not a stale peek; no-op when target already matches; correct negative-delta/COGS case). Combined with Phases 1-2: **28/28 pass.**

- **E2E** (real NestJS app + real PostgreSQL `erp_test`, no mocks): **34 new tests, 5 new files**, combined with Phases 1-2's 74: **108/108 pass.**
  - `inventory-stock-basics.e2e-spec.ts` (11) — opening stock once-only; WAC across multiple purchases at different costs; a sale's COGS locked to the current average without changing it; a later cost change never rewriting a past movement's recorded cost (read back from the DB); 404 on invalid warehouse/variant references; 422 on non-positive quantities and a reasonless adjustment; multi-UOM conversion on receipt; and a 3-part negative-inventory suite (rejected by default even for the Owner; still rejected with the setting on but the actor lacking the permission; allowed and flagged only with both) plus a reconciliation test that corrupts a balance directly via SQL and confirms detection.
  - `inventory-adjustments-and-counts.e2e-spec.ts` (6) — positive/found-stock adjustment using current average cost; all four decrease adjustment types individually distinguishable in the ledger; rejection below zero by default; full stock-count lifecycle generating the correct adjustment; **the mid-count concurrent-sale test** proving approval uses the live balance, not the creation-time snapshot; status-guard rejections (approve-before-submit, submit-with-nothing-counted, edit-after-submit, double-submit).
  - `inventory-transfers.e2e-spec.ts` (5) — full send/receive lifecycle with cost carryover verified numerically; shrinkage reporting (received < sent, not auto-corrected); status-guard rejections (double-send, receive-before-send); same-warehouse rejection and insufficient-stock-on-send rejection; all-items-together requirement on receive.
  - `inventory-bundles.e2e-spec.ts` (3) — single-component consumption never touches the bundle's own (nonexistent) balance; multi-component consumption decrements every component by its own ratio; **the atomicity test** — a bundle sale requiring more of a scarce component than exists is rejected, and the *other*, plentiful component is proven completely untouched (not partially consumed before the failure), demonstrating the whole bundle sale is one transaction.
  - `inventory-concurrency-and-isolation.e2e-spec.ts` (9) — see Concurrency Review and Inventory Integrity Review below for the three real-concurrency tests specifically; plus permission-violation coverage (a Cashier blocked from every inventory write) and the now-standard two-layer tenant-isolation proof (API + raw SQL against `stock_movements`/`stock_balances` as the same restricted `erp_app` role, including confirming zero UPDATE/DELETE privilege on the ledger table specifically).

- One real design flaw was caught and fixed **during development, before it shipped**: the initial `ApproveStockCountUseCase` design would have computed an adjustment delta from a balance value read *before* acquiring the row lock — a genuine race window. Fixed by adding `InventoryEngineService.applyAbsoluteQuantity`, which locks first and computes the delta from the locked value. Documented under Architecture Decisions; covered by unit tests specifically targeting this method and an e2e test that sells stock mid-count to prove the fix holds under a real (if serialized-by-the-test) concurrent scenario.

## Security Review
Everything from Phases 1-2 stands unchanged (argon2id, JWT access+refresh, RLS + restricted `erp_app` role, helmet/CORS, global rate limiting, audit trail, no secrets committed, field-level cost stripping). Phase 3 additions:
- Every inventory-mutating endpoint requires its own specific permission (11 new codes) rather than one blanket `inventory.manage` — a Cashier with `inventory.view` (granted by default, since checking availability at POS is a legitimate read) is verified by test to be rejected (403) from every write operation.
- `inventory.allow_negative` is deliberately **not** included in the `INVENTORY_MANAGER` role template's default grants, even though that template gets every other inventory permission — going negative is an elevated override an owner grants explicitly, never a default.
- `stock_movements` (the ledger) has no UPDATE or DELETE grant for the runtime role at all — verified by test that both operations fail with a Postgres permission-denied error even when attempted directly via the restricted role's own connection, bypassing the application entirely.
- The same RLS + non-superuser-role pattern from Phase 1 is proven again for the new tables via raw SQL: an unfiltered `SELECT * FROM stock_movements` as `erp_app` with no tenant context returns zero rows.

## Business Logic Review
- Opening stock, receive, consume, adjust, transfer send/receive, and stock-count approval all fully validate their references (warehouse/variant/product belong to the caller's tenant) before touching the ledger, returning 404 rather than silently creating cross-tenant or dangling data.
- Every quantity/cost value is a `Prisma.Decimal` throughout the engine and use cases — no floating-point arithmetic anywhere near money or stock quantities.
- The cross-table SKU/variant validation patterns from Phase 2 are reused as-is (Phase 3 never re-validates a Product/Variant's own identity rules — it only checks tenant ownership and reads catalog data).
- Bundle consumption, transfer cost carryover, and stock-count live-balance computation are the three places this phase does something meaningfully more sophisticated than "call the engine once," and all three are covered by tests that specifically target the sophistication (atomicity, cost non-fabrication, race-safety) rather than just the happy path.

## Inventory Integrity Review
Direct evidence for each of your 6 required invariants (§46 of the Phase 0 doc, restated for Phase 3):
1. **`StockMovement` is the only source of inventory truth** — no counter column exists anywhere else; every read of "how much is on hand" in application code goes through `StockBalance` (the cache) or, for verification, a live `SUM` over `stock_movements` (the reconciliation endpoint, and lot quantity resolution).
2. **`StockBalance` is a derived cache, independently recomputable and verified** — `GET /inventory/reconciliation` does exactly this recomputation and is tested against both a clean state (zero discrepancies) and a deliberately corrupted one (caught).
3. **`Available = On Hand - Reserved`** — computed at read time in `GetBalancesUseCase` (`quantityOnHand.minus(quantityReserved)`); `quantityReserved` is always 0 in Phase 3 (no writer exists yet), so this is schema-ready rather than fully exercised — honestly flagged, not hidden.
4. Every critical inventory operation is one atomic DB transaction: proven directly by the bundle atomicity test (a rejected multi-component sale leaves the successful component's balance completely untouched) and by the stock-transfer-send test (all items in one transaction).
5. Two concurrent requests can never oversell the same `(warehouse, variant)`: proven under real parallel HTTP load (see Concurrency Review), not asserted from code reading alone.
6. Negative inventory is impossible unless BOTH a tenant Setting and an actor permission explicitly allow it, and even then every such movement is flagged (`isNegativeStock`) for later reporting.

## Concurrency Review
Three e2e tests fire genuinely concurrent HTTP requests (`Promise.all` against the live, already-running NestJS app, real PostgreSQL round-trips for each) rather than simulating concurrency in a single thread:
1. **5 concurrent requests to sell the last unit of a 1-unit balance**: exactly 1 succeeds (201), exactly 4 are rejected (409 `INSUFFICIENT_STOCK`), the final balance is exactly `0` (never negative, never `-4`), and exactly one `SALE` movement was ever recorded.
2. **10 concurrent requests for 3 units each against a 20-unit balance** (30 requested, only 20 available): total consumed never exceeds 20, and the final balance exactly equals `20 - (successes × 3)` — proving partial contention (not just the "exactly one wins" trivial case) resolves correctly too.
3. **5 concurrent purchases at 5 different costs**: the final quantity and average cost exactly match the mathematically correct result computed independently in the test (no "lost update" from two transactions racing on the same row — every one of the 5 concurrent writes is reflected in the final state, serialized correctly by the row lock rather than one silently overwriting another).

This is the mechanism, concretely: `InventoryEngineService` takes `SELECT ... FOR UPDATE` on the `StockBalance` row for `(warehouse, variant)` before reading or computing anything. Postgres blocks any other transaction's `FOR UPDATE` on that same row until the first commits or rolls back, so the second transaction always computes its delta/average against the first one's already-applied result — never a stale read.

## Known Issues / Technical Debt
Phase 1-2's lists stand unchanged (no frontend yet, no dedicated login rate limit, no refresh-token-reuse cascade, `erp_app` dev-default password, no invite/reset/2FA, Redis/BullMQ unused, no hard-delete endpoints for reference catalog tables, `Product.defaultCost`/`defaultSellingPrice` not independently editable, no image upload, minor `createdBy`/`updatedBy` inconsistency on two Phase 2 tables). New from Phase 3:

12. **No Purchase/Sales Invoice workflow yet** — `/inventory/receipts` and `/inventory/consumptions` are real, tested, permission-gated primitives, but there is no document (invoice number, supplier/customer, line items, payment) wrapping them yet. That is explicitly Phase 4/5 scope; building it now would be exactly the "features outside this phase's scope" instruction #14 told me not to add.
13. **No reservation writer yet** — `StockBalance.quantityReserved` and the `Available = OnHand - Reserved` computation are schema/code-ready, but nothing sets a non-zero reservation (that's Phase 5 POS "hold invoice"). Honestly reflected in the Integrity Review above rather than glossed over.
14. **No partial/staged Stock Transfer receiving** — all items of a transfer must be received together in one call. A real warehouse might receive a truck in batches; extending this to per-item partial receiving is straightforward additive work if needed later, but wasn't required by the spec and would have added surface area without a corresponding test-able correctness requirement this phase.
15. **No FIFO-by-expiry consumption** — `InventoryLot.expiryDate` exists and is indexed for it, but `ConsumeStockUseCase` doesn't auto-select the soonest-expiring lot; the caller may pass `lotId` explicitly. Phase 0 itself describes this as a future capability the design should merely be *ready* for, not a Phase 3 deliverable.
16. **Serial number handling only covers `SALE` consumption**, not `PURCHASE_RETURN` — a genuine edge case (returning a serialized item to a supplier) deferred rather than speculatively built.
17. **No bundle depth limit beyond "exactly one level"** — a bundle cannot contain a bundle (enforced at creation, Phase 2), but there's no separate configurable depth concept; this is a hard rule, not a setting, and was judged sufficient.

## Files Created
Prisma migrations: `apps/api/prisma/migrations/20260828131355_inventory_schema/`, `.../20260828131600_inventory_rls/`, `.../20260828131700_inventory_app_role_grants/`, `.../20260828131832_lot_fk_restrict/`.

Shared validation: `packages/shared-validation/src/inventory.ts`.

Engine (`apps/api/src/engines/inventory/`): `inventory-engine.service.ts`, `inventory-engine.module.ts`, `__tests__/inventory-engine.service.spec.ts`.

Inventory module (`apps/api/src/modules/inventory/`): `inventory.module.ts`; `domain/{load-variant-context,lot-and-serial,resolve-allow-negative,uom-conversion}.ts`; `application/stock/{opening-stock,receive-stock,consume-stock,adjust-stock,get-balances,list-movements,reconcile-inventory,list-lots,list-serials}.use-case.ts`; `application/transfers/{create-stock-transfer,send-stock-transfer,receive-stock-transfer,list-stock-transfers,get-stock-transfer}.use-case.ts`; `application/counts/{create-stock-count,submit-stock-count-items,submit-stock-count,approve-stock-count,get-stock-count}.use-case.ts`; `presentation/{stock,transfers,stock-counts,lots-and-serials}.controller.ts`.

Tests: `apps/api/test/inventory-{stock-basics,adjustments-and-counts,transfers,bundles,concurrency-and-isolation}.e2e-spec.ts`, `apps/api/test/utils/inventory-fixtures.ts`.

## Files Modified
`apps/api/prisma/schema.prisma` (8 new models/4 enums + 2 Product columns + Business/Branch/Warehouse/Uom/ProductVariant relations), `apps/api/prisma/seed.ts` (11 new permission descriptions), `apps/api/src/app.module.ts` (wire `InventoryEngineModule`/`InventoryModule`), `apps/api/src/common/errors/domain-error.ts` (`InsufficientStockDomainError`), `apps/api/src/common/filters/all-exceptions.filter.ts` (map `INSUFFICIENT_STOCK` → 409), `apps/api/src/modules/catalog/application/products.service.ts` (wire the two new `tracksLots`/`tracksSerialNumbers` fields through create/update), `apps/api/test/db-reset.ts` (truncate the 8 new tables), `packages/shared-types/src/permissions.ts` (11 new codes + role-template grants), `packages/shared-validation/src/catalog.ts` (`tracksLots`/`tracksSerialNumbers` on create/update product schemas), `packages/shared-validation/src/index.ts` (re-export `inventory.ts`).

## Next Phase
**Phase 4 — Purchasing**: Suppliers, Purchases, Purchase Returns, Supplier Ledger, Payments — expected to call `ReceiveStockUseCase`/the Inventory Engine directly rather than reimplementing stock-in logic.
**Will not start until you explicitly approve this Phase 3 report.**
