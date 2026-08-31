# PROJECT STATE SUMMARY

## Current Phase
Phase 12 — POS Web (**Returns milestone complete.** Exchanges, held sales, cash drawer, warranty NOT started. ERP Web NOT started, offline sync NOT started.)

The POS Web slice (login → shift → sell → quote → payment → receipt → blind close) is complete, and this milestone finishes the **Returns** workflow, which was exposed in the navigation and could not complete for two whole categories of sale.

**What was broken, and what fixed it**

| Was | Now |
|---|---|
| A serial-tracked product could not be returned at all — the request sent no `serials`, and the backend refuses without them | The cashier **chooses** the units coming back from the ones the sale actually delivered, read from the receipt payload |
| A walk-in refund had to equal the return credit exactly, and nothing ever showed that figure | `POST /sales/:id/returns/preview` states it; for a walk-in the field is the server's own number and is not editable |
| Return lines were labelled with raw variant UUIDs | Product name, Arabic alternative name and SKU, from `GET /sales/:id/receipt` |
| Three hard-coded English strings in an Arabic-first product | Fully localised; ar/en key parity verified (146 keys, no drift) |
| Only the current shift's sales were reachable | `GET /sales?saleNumber=` finds the receipt in the customer's hand, whichever shift produced it |

**`POST /sales/:id/returns/preview`** — read-only, `sales.return`, inside `withTenantReadOnly` so PostgreSQL refuses any write with SQLSTATE 25006. It is **not a second return engine**: the credit comes from `lineReturnCredit` (the single shared BD-1 definition) and `TaxEngineService.cumulativeLineTax` (BD-18's cumulative reversal) — the same functions `CreateSaleReturnUseCase` calls. Both are pure functions of values already stored on the sale line, which is why no extraction from that 684-line use-case was needed. The response states the exact walk-in refund, the maximum for an account customer, and what would stay on their ledger.

**`GET /sales?saleNumber=`** — the one contract widened, and minimally: exact, case-normalised equality against the existing `@@unique([businessId, saleNumber])` index. Not a `contains` scan, and no other filter added.

**No schema change, no migration, no new permission (117, unchanged), no new business rule.** Return eligibility, credit, tax reversal, serial rules, loyalty clawback, inventory and accounting are untouched and still revalidated by the return itself.

**Verification:** 720/720 backend e2e across 55 files (31 new) · 37/37 backend unit · 29/29 frontend unit (10 new) · build, `tsc --noEmit` and lint clean · 54 migrations, no drift on either database · `ops/verify-security.sh` PASS. Browser-verified against the real backend: two sales made in a **closed** shift, found from a new shift by typing the receipt number in lower case, one returned for an authoritative **342.00** and one serial-tracked unit returned for **570.00** — with `SW-1002` confirmed back `IN_STOCK` and `SW-1001` still `SOLD`, and both journal entries balancing.

---

## Phase 12 — Sale Quote (**Complete.**)

Phase 12 delivered the two blocking contracts (`GET /permissions/me`, `GET /sales/shifts/available-warehouses`), then the POS Web vertical slice — login through blind shift close, exercised against the real backend in a browser.

**This milestone closes the last contract limitation that slice exposed.** `POST /sales` requires the tender to equal the sale total *exactly*, and that total only exists after the server has resolved tax, promotions and loyalty from the tenant's own configuration. The till therefore could not tell a customer what to pay: it priced the cart itself, guessed, and the server rejected the sale whenever the guess was wrong.

**`POST /sales/quote`** answers the cart with the authoritative figure before any money moves.

- **It is not a second pricing engine.** It calls `CreateSaleUseCase.quotePricing`, which is the *same* private pipeline `executeInTx` runs before it writes a row — the same BD-18 tax resolution, BD-12 cap, BD-10/BD-11 promotion selection and BD-2/BD-3 redemption, in the same approved order. One implementation, two callers.
- **Side-effect freedom is enforced by PostgreSQL, not by review.** The handler runs inside `PrismaService.withTenantReadOnly`, which issues `SET TRANSACTION READ ONLY`, so any INSERT/UPDATE/DELETE or `SELECT … FOR UPDATE` reaching it — today or after some future edit to the shared pipeline — fails with SQLSTATE 25006. Proven by test, and by five live quotes leaving every counter identical.
- **A quote is not a reservation, and says so in its own payload.** `guarantees` reports `reservesStock: false`, `holdsPrices: false`, `holdsPromotions: false`, `holdsLoyaltyBalance: false`, `createsNothing: true`. `POST /sales` re-resolves everything under its existing locks and remains the only authority.
- **The exact-payment rule was kept, not relaxed.** The quote makes it satisfiable rather than removing it.

**No schema change, no migration, no new permission (117, unchanged), no new business rule.** Gated on `sales.create`.

**Frontend:** the existing checkout was integrated, not rebuilt. It quotes on open, tenders `amountDue`, and adds cash-received → change. The only arithmetic in the browser is `cashReceived − cashTendered`, isolated in `lib/tender.ts` and unit-tested; change is never sent anywhere, because the server records only what the sale was worth.

**Verification:** 689/689 backend e2e across 54 files (30 new) · 37/37 backend unit · 19/19 frontend unit (8 new) · build, `tsc --noEmit` and lint clean across api + ui-kit + pos-web · 54 migrations, no drift · `ops/verify-security.sh` PASS. Browser-verified end to end: a 2 × 100 cart with a 20% promotion and 14% default tax quoted **182.40**, took 200 cash, showed **17.60** change, and produced a sale and receipt reading 182.40 — the cart's own estimate was 200.00, which is exactly the sale the old build would have had rejected.

---

## Phase 11 — Security / Operations Hardening (**Complete.**)

Phase 11 added no product feature. It closed the gap between "the backend is correct" and "the backend is safe to run", which are different claims: every finding below is a real gap found in live code, and each was fixed, demonstrated, or recorded as an accepted limitation with the reasoning that made it acceptable.

**Verification:** 627/627 e2e across 51 files · 37/37 unit · build, `tsc --noEmit` and lint clean · 54 migrations, no drift, both `erp_dev` and `erp_test` up to date · 183 routes, of which exactly **3 are public** (login, refresh, register — all now rate-limited) and **2 are token-only with no extra permission** (logout, change-own-password), the other **178 permission-gated** · `ops/verify-security.sh` PASS on both databases · a backup **restored and verified row-for-row** against a real database.

---

## PHASE 11 — WHAT WAS DELIVERED

| # | Kind | Finding, from live code | Outcome |
|---|---|---|---|
| 1 | **Defect (severe, operational)** | `test/db-reset.ts` TRUNCATEs every table as the owner role, reading its target from `DATABASE_URL`, with nothing between it and a production connection string. | **Fixed.** Two independent conditions must both hold: `NODE_ENV` is exactly `test` **and** the database name identifies a test database. The error never prints the URL, because a connection string carries a password. |
| 2 | Security gap | JWT secrets were validated lazily at first use. A server missing one started cleanly, passed a health check, and failed on the first person who tried to sign in. | **Fixed.** `assertEnvironmentIsUsable()` runs before `NestFactory.create`. It reports *every* problem at once, and quotes no value. |
| 3 | Security gap | No refresh-token reuse detection. Rotation invalidated the spent token; the attacker's copy simply failed, and the session it was stolen from carried on. | **Fixed.** A genuine, unexpired, already-spent token revokes **every live session** for that user and writes an audit row. |
| 4 | Security gap | Rate limiting was global only (120/min/IP) — 172,800 password guesses a day against one account. | **Fixed.** Per-endpoint limits on login (10/min), registration (5/min) and credential handling (20/min), all environment-configurable. |
| 5 | Security gap | `audit.view` had existed since Phase 1 with **no endpoint serving it**: the record was kept and could not be read. | **Fixed.** `GET /audit-logs`, read-only, tenant-scoped, filterable, deterministically paged. |
| 6 | Security gap | `PERMISSION_DENIED` was a dead enum value. "Did anyone try to reach the accounting module?" had no answer. | **Fixed.** Written in `PermissionsGuard` — the single place every authorization decision is made — naming the endpoint, the caller and the missing permission. |
| 7 | Operational gap | No backup or restore, documented or demonstrated. | **Fixed and demonstrated** against a real database (see below). |
| 8 | Operational gap | No `.env.example`, so every required variable was folklore. | **Fixed**, including the `DATABASE_URL` vs `RUNTIME_DATABASE_URL` distinction and why it matters. |
| 9 | **Accepted limitation (reasoned)** | No token-based self-service password reset. | **Deliberately not built.** While delivery is deferred, the token would pass through the administrator anyway — zero benefit, in exchange for an unauthenticated redemption endpoint, a token store and a user-enumeration surface. The single-use/reuse-prevention requirement was instead applied to **refresh tokens**, where it genuinely applies and where a real gap existed (#3). |

**Two audit claims corrected as stale.** A global throttler has existed since Phase 1 (`ThrottlerModule.forRoot`), and Swagger was wired in Phase 10I. Phase 11 did not add either; it tightened the first and made the second **drift-proof** — each operation's stated authorization is now read from the same `@RequirePermissions` metadata the guard enforces, so documentation cannot disagree with enforcement.

### Backup and restore — actually demonstrated, not asserted

`ops/backup.sh` (`pg_dump --format=custom`) and `ops/restore.sh` were run end to end against a real database. The restored copy matched row for row — businesses 2 · users 3 · sales 47 · sale_items 47 · journal_entries 67 · journal_entry_lines 295 · stock_movements 122 · customer_points 3 · audit_logs 247 · cash_transactions 44 — with zero unbalanced entries, an exchange-clearing balance of 0.0000, and no balance-vs-movement drift. **Enforcement survived the restore**: as the restricted `erp_app` role, tenant A saw 46 of its own sales and 0 of tenant B's; `DELETE FROM journal_entry_lines`, `UPDATE audit_logs` and a cross-tenant `INSERT` were each refused by PostgreSQL, and the row counts were unchanged afterwards.

`restore.sh` refuses a non-empty target ("a restore is not a merge") and refuses a cluster lacking the `erp_app` role, because **roles are cluster-wide and are not in the dump**. `ops/BACKUP-RESTORE.md` states plainly what is still needed for production — off-host storage, a schedule, PITR, rehearsals, role provisioning — as **contracts**, naming no provider and inventing no credential.

### `ops/verify-security.sh` — asking PostgreSQL, not the application

A standing structural check that reads the system catalogues directly, so it holds even if the ORM, the use-cases and the whole test suite were wrong at once: RLS **and FORCE** on every table carrying `business_id`; no table with RLS and no policy; every policy carrying **both halves** *and actually consulting* `app.current_tenant_id` (a `USING (true)` policy has a USING half and isolates nothing); the documented `businesses` exception bounded to exactly its three per-command policies; `erp_app` neither superuser nor `BYPASSRLS`; nothing granted to `PUBLIC`; **no append-only table holding UPDATE or DELETE**, checked against an explicit list rather than derived from the grants themselves; and the ledger invariants — every entry balancing, no double-sided line, stock balances equal to their movements, exchange clearing at zero.

It was proved non-vacuous: on a scratch copy with `FORCE RLS` removed from `sales`, an `UPDATE` granted on `audit_logs`, and the `customers` policy dropped, it reported all three and exited non-zero. Both real databases report **PASS**.

### Files

**Created:** `apps/api/src/common/config/validate-environment.ts` · `apps/api/src/common/security/throttle-policy.ts` · `apps/api/src/modules/audit/application/list-audit-logs.use-case.ts` · `apps/api/src/modules/audit/presentation/audit-logs.controller.ts` · `.env.example` · `ops/backup.sh` · `ops/restore.sh` · `ops/verify-security.sh` · `ops/BACKUP-RESTORE.md` · `apps/api/test/security-hardening.e2e-spec.ts` (25) · `apps/api/test/rate-limiting.e2e-spec.ts` (5) · `apps/api/src/common/config/__tests__/validate-environment.spec.ts` (9).

**Modified:** `apps/api/test/db-reset.ts` (the reset guard) · `apps/api/src/main.ts` (validate before building anything) · `apps/api/src/app.module.ts` (configurable global limit) · `apps/api/src/common/guards/permissions.guard.ts` (`PERMISSION_DENIED` audit) · `apps/api/src/modules/iam/application/auth/refresh-token.use-case.ts` (reuse detection) · `apps/api/src/modules/iam/presentation/{auth,users}.controller.ts` and `apps/api/src/modules/tenancy/presentation/businesses.controller.ts` (throttle decorators) · `apps/api/src/modules/audit/audit.module.ts` · `apps/api/src/common/openapi/setup-swagger.ts` (drift-proof authorization annotations; `buildOpenApiDocument` split out so the contract can be asserted without mounting a route) · `packages/shared-validation/src/index.ts` (`auditLogListQuerySchema`) · `apps/api/.env.test` (relaxed limits, so the suite tests behaviour rather than throttling itself).

**No migration. No schema change. No new permission — 117, unchanged. No new business rule.**

### Security review — Phase 11

- **The reuse-detection write survives its own 401.** Throwing inside `withTenant` would roll back the family revocation *and* the record of it, leaving the attacker's session alive and no evidence anything happened. It returns a discriminated result and throws after the transaction commits — the pattern `LoginUseCase` already used for exactly this reason — and there is a test that fails if that regresses.
- **No per-account lockout, deliberately.** It is a denial-of-service weapon: anyone who knows a cashier's email could lock them out of the till mid-shift. The limit is on the source, not the target.
- **In-memory, per-process rate limiting is an accepted weakness.** Behind N instances the effective limit is N times the configured one. A shared Redis store would buy a correct count in exchange for an availability dependency this system does not otherwise have; when horizontal scaling arrives the fix is a storage adapter behind the same policy, and the decorators do not change.
- **A failed audit write never turns a 403 into a 500.** The `PERMISSION_DENIED` insert is wrapped and swallowed: failing to record must not tell the caller anything and must not let a denied request through.
- **The audit endpoint could not become a write path even by mistake** — `erp_app` holds SELECT and INSERT on `audit_logs` and nothing else. Ordering is `createdAt DESC, id DESC`: several rows share a timestamp inside one transaction, and paging on the timestamp alone would silently skip and repeat rows.
- **Append-only semantics were not touched.** No UPDATE or DELETE privilege was added to any ledger table.

### Known issues — Phase 11

- **Seven permission codes are enforced nowhere** — `branches.delete`, `brands.delete`, `categories.delete`, `products.delete`, `uoms.delete`, `warehouses.delete`, `users.manage_roles`. Each names a capability that has no endpoint. This is inert rather than dangerous (the hazardous direction is an endpoint with no permission, and there are none), and removing them would be a behaviour change outside a hardening phase. **Recorded, not fixed.** Four further codes — `products.view_cost`, `reports.view_profit`, `shifts.view_expected`, `inventory.allow_negative` — are correctly absent from any route because they gate **fields inside** a response, and are covered by existing tests.
- **`businesses` allows an open `SELECT` policy.** Sign-in must resolve a slug before any tenant is known. Pre-existing, deliberate, and now bounded by an automated check so the exception cannot quietly grow to INSERT or UPDATE.

---

Phase 10.1 was a decision gate that found the Phase 10 exchange refusal rested on a **wrong premise**, and Phase 10.2 implemented the correction. `SaleReturn.refundMethod`/`refundAmount` mean *the real tender handed back*; the exchange-credit portion is not a refund and already lives on the sale as an `EXCHANGE_CREDIT` payment. A downward exchange therefore needs ONE refund figure with ONE method — exactly what the row carries.

Upward, even and downward exchanges are now one path, differing only in two values:

    requiredRefund = max(0, returnCredit - replacementTotal)
    creditApplied  = returnCredit - requiredRefund

so both settlement identities hold in every direction, and are enforced:

    returnCredit     = creditApplied + refund
    replacementTotal = creditApplied + tender

**The refund amount is not trusted.** The client names the METHOD, because only the till knows how money physically went back; the AMOUNT is proved against the two totals by `CreateSaleUseCase` — the only place that knows the replacement's — and a wrong figure rolls the whole exchange back naming the one that would have worked.

**No schema change, no migration, no new business rule.** Every rule is inherited: BD-23 for the refund tender, BD-1 for the credit and the loyalty reversal, BD-18 for the tax, BD-3 for the earning; promotions, serials and idempotency untouched.

**Verification:** 597/597 e2e across 49 files · 28/28 unit · build, typecheck and lint clean · 54 migrations, no drift, both databases up to date. A SQL sweep across 20 exchange pairs (11 of them downward) confirms the clearing account at exactly 0.0000, zero unbalanced entries, and **zero violations of `C = creditApplied + R`** checked against the journal itself.

**Behavioural correction reported:** the Phase 10 test asserting a downward exchange was refused is directly contradicted by the approved 10.2 policy. It is replaced by a test that proves the refund is *not trusted* — a wrong, excessive or omitted amount is refused — and it keeps the atomicity assertion the old test carried, now against the refund-validation path. Nothing was weakened.

**Narrowing against 10.1 §17:** that section noted an account customer *may* leave the surplus on their ledger. The approved 10.2 spec (`C = creditApplied + refundAmount`, with no ledger term) supersedes it: an exchange settles completely, and a customer wanting store credit uses a plain return, which supports it. This keeps the Phase 10 guarantee that an exchange leaves nothing on the ledger, and its passing test, intact.

---

## Phase 10 — Release Gate (**Complete. PHASE 10 IS CLOSED.**)

Phase 10 turned the engine of Phases 1–8 into a shop that can actually open its doors: a till with a cash drawer, tax the business configures rather than the client asserts, serials that survive every path a physical unit takes, exchanges, parked baskets, receipts, expenses, and password management.

**Final verification, all green:** 582/582 e2e across 49 files · 28/28 unit · build, `tsc --noEmit` and lint clean · both `erp_dev` and `erp_test` report "Database schema is up to date" · `prisma migrate diff` reports **no drift** · **54 migrations**, **117 permissions**.

**Whole-database invariant sweep (all zero):** unbalanced journal entries · negative-side or double-sided journal lines · stock-balance-vs-movement drift · negative reservations · sale lines discounted beyond their gross · customers with a negative point balance · serials in two places at once · zero-amount cash transactions · a non-zero exchange-clearing balance.

**Engine authority verified by grep, not by assertion:** no write to `stock_movements`/`stock_balances` outside `engines/inventory` (the only non-engine hits are read-only SELECTs in reporting and reconciliation); no `journalEntry`/`journalEntryLine` create outside `engines/accounting`; `quantity_reserved` written only by the engine.

---

## PHASE 10 — WHAT WAS DELIVERED

| Sub-phase | Delivered |
|---|---|
| **10A** Cash & till | `CashRegister`, `CashTransaction` drawer ledger, shift open with register + opening float, **blind close** (expected cash DERIVED, never stored, and stripped server-side from anyone lacking `shifts.view_expected`), manager reconciliation, variance posting to a configurable `CASH_VARIANCE` account. A default register is created at onboarding (Phase 0 §11). |
| **10B** Tax Engine | `Tax` model, `TaxEngineService`, resolution precedence (line exemption > product exemption > product tax > business default > none), per-line `taxId`/`taxRateSnapshot`/`taxExempt` snapshots, tax-inclusive pricing as an ENTRY AND DISPLAY convention only (boundary conversion at the line, one pipeline), BD-1's cumulative method applied to the tax column on returns. **`taxAmount` is no longer accepted from a client.** |
| **10C** Refund tender | `SaleReturn.refundMethod/refundAmount/refundReference` recorded at source — closes Known Issue #32, which required a real operational fact rather than an inference. |
| **10D** Serial lifecycle | Serials on PO receiving (mandatory), on stock transfers (`IN_TRANSIT`, owned by no warehouse), and on purchase returns (`RETURNED_TO_SUPPLIER`, terminal). Three append-only link tables. |
| **10E** Return disposition | BD-22: a returned unit takes the disposition the return declared — `SELLABLE → IN_STOCK`, `DAMAGED → DAMAGED` — superseding BD-14's quarantine state. |
| **Exchanges** | `POST /sales/:id/exchanges`, one transaction, composing the unchanged return and sale use-cases; `EXCHANGE_CLEARING` nets to exactly zero. |
| **Hold / Resume** | `HeldSale`/`HeldSaleItem` as a SEPARATE entity — never a `Sale` with a HELD status. Soft: the advisory `quantityReserved` never blocks a sale. Resume re-prices through the unchanged pipeline. |
| **10F** Receipts | `GET /sales/:id/receipt` — one request, nothing recalculated, no cost or profit for anyone. Business profile fields, all free text. |
| **10G** Passwords | Change-own (current password required) and administrative reset; both revoke every live session. No value or hash ever reaches the audit trail. |
| **10H** Expenses | `ExpenseCategory` (business-chosen EXPENSE account) and append-only `Expense`. A cash expense enters the drawer ledger in the same transaction. |
| **10I** Contract | Purchase-receipt idempotency fingerprint (defect fix), idempotency transport frozen to the request body, OpenAPI at `/api/v1/docs`. |

### Defects found and fixed during Phase 10 (each with a regression test)

1. **PO receiving accepted serial-tracked goods with NO serials.** Stock went up, no unit was registered, and the goods were then unsellable — BD-13 requires a serial per unit at the till and there were none. Surfaced only at the point of sale, long after the receipt.
2. **Stock transfers ignored serials entirely.** The unit's row kept pointing at the warehouse it had physically left, so it could be sold at NEITHER end. The worst of the three because it failed silently: the transfer succeeded and only a later sale broke, in a different warehouse, on a different day.
3. **Purchase returns left returned serials sitting in stock** as though the units were still there.
4. **Returned serials went to a quarantine state the deferred inspection workflow never released.** A SELLABLE return posts a real `SALES_RETURN` increase, so the QUANTITY came back on the shelf while the SERIAL did not — a permanent contradiction in which nobody could ever sell the unit again. (BD-22.)
5. **`ReceivePurchaseUseCase` returned the stored receipt for a replayed idempotency key whatever the new request said** — the only idempotent path that did not compare fingerprints. A key reused with a different delivery was handed the first receipt and the second delivery was never recorded: stock the business had actually taken in simply did not exist.

### Behavioural corrections (previously-approved behaviour deliberately changed)

| # | Was | Now | Why |
|---|---|---|---|
| 1 | Client supplied `taxAmount` per sale line | Rejected; the server computes tax from stored configuration | BD-18 rule 5. **Breaking change.** |
| 2 | Tax was whatever the client said, unrelated to discounts | Tax follows the DISCOUNTED net, so a line discounted or redeemed to zero attracts no tax | BD-18 / BLOCKING-1. Three tests that asserted "the customer still owes the tax" on a fully-discounted line were updated with the reasoning recorded inline. |
| 3 | A return's customer credit was the merchandise value alone | Credit includes the tax reversal | Crediting only the merchandise stranded a permanent debit against goods the customer handed back. |
| 4 | A walk-in return never reversed Revenue (Known Issue #32) | It does, when a refund tender is recorded | BD-23. Two user-facing limitation notes that stated the opposite were factually wrong and are corrected. |
| 5 | Returned serial → `RETURNED` quarantine (BD-14) | → `IN_STOCK` or `DAMAGED` per the return's own condition | BD-22, superseding BD-14. Two Phase 8E tests updated; both now assert something strictly stronger. |
| 6 | Opening a shift needed only a warehouse | Needs a cash register and an opening float | BD-17 rule 2. **Breaking change.** |
| 7 | Phase 5's schema note proposed a future `HELD` SaleStatus | Held baskets are a separate entity | No reporting query filters on `Sale.status`, so a held basket stored as a Sale would have been counted as revenue from the moment it was parked. The note is corrected in place. |

### Deliberate boundaries (in scope, chosen, and NOT defects)

- ~~**A downward exchange is refused.**~~ **SUPERSEDED BY PHASE 10.2.** The stated reason — that it would need a two-part refund the append-only `sale_returns` row cannot carry — was **wrong**: the row carries one refund figure with one method, which is exactly what a downward exchange needs. Phase 10.1 found the error and Phase 10.2 implemented the correction; see the Phase 10.2 section above for the settlement identities now enforced.
- **`Tax` has no effective-dated child.** Per-line snapshotting is strictly stronger than rate versioning for the one thing that matters (a historical sale never moves), and the approved policy never asked for versioning. A deliberate deviation from the Phase 0 ERD.
- **Purchase tax stays caller-supplied.** It is a fact from the supplier's invoice, not a computation the business performs; BD-18's server-side rule is about the tax the business CHARGES.
- **Shift routes stay under `/sales/shifts`** rather than moving to `finance/`, to avoid breaking a path clients already use.
- **No self-service password reset by email or SMS.** Delivery is outside Phase 10's approved scope, and a reset link nobody can receive is worse than none.
- **OpenAPI does not restate request shapes as DTOs.** The Zod schemas are what a request is judged against; a second definition of every payload would be free to drift from the one that enforces anything.

---

## PHASE 8 — CONSOLIDATED VIEW (as delivered)

Phase 8 delivered four capabilities and one integration, across seven gated sub-phases. Each was reviewed before implementation, implemented against explicitly approved business decisions, and accepted at its own release gate.

| Sub-phase | Delivered | Gate |
|---|---|---|
| **8A** | **Warranty** — registration against a sold serial unit, business-default duration with per-registration override, snapshotted coverage, ACTIVE/EXPIRED/CLAIMED/VOID lifecycle, OPEN→RESOLVED\|REJECTED claims. Record-keeping only. | Accepted |
| **8B** | **Loyalty Ledger** — append-only `CustomerPoints`, balance always `SUM(points)`, BD-3 earning rule, manual adjustment. No stored balance, no GL liability, no expiry. | Accepted |
| **8C** | **Loyalty Redemption** — redemption at 4 dp HALF-UP into line discounts, earning after redemption, cumulative clawback and restoration on return, **and the BD-1 return-credit correction** it depends on. | Accepted |
| **8D** | **Promotions** — percentage, fixed-amount and Buy-X-Get-Y; product, variant and category targets; best-applicable only; business-timezone validity; immutable provenance. | Accepted |
| **8E** | **Sales Integration** — BD-12 discount cap, mandatory serial capture, `SaleItemSerial`/`SaleReturnItemSerial`, serial quarantine on return, warranty auto-void, **closing Known Issue #47**. | Accepted |
| **8F** | **Full Verification** — structural, architectural, query and behavioural audit of the whole surface. Zero product defects; four documentation errors corrected. | Accepted |
| **8G** | **Release Gate** — this final verification and consolidation. | — |

### The Phase 8 business rules, as approved and implemented

Every rule below was decided by explicit approval before any code was written. **None was inferred, and none was chosen for implementation convenience.**

- **BD-1** Return credit uses the historical effective unit price, apportioned by **cumulative** returned quantity — never a per-return proportion, which drifts. One definition serves the refund, the loyalty clawback and the redemption restoration.
- **BD-2** Loyalty redemption is allocated proportionally across eligible lines by largest-remainder with a per-line cap, preserving `Sale.discountAmount = SUM(SaleItem.discountAmount)`.
- **BD-3** Earning basis is net merchandise after **all** discounts and before tax; `floor`, never half-up.
- **BD-4** Warranty duration is a business default plus an optional override, snapshotted; no business maximum was invented.
- **BD-5** Warranty claims have exactly three states, one-way.
- **BD-6** Monetary rounding is **4 dp HALF-UP** — the codebase's first rounding policy, introduced at the scale the columns already store.
- **BD-7** Redemption is bounded by remaining merchandise value; no other cap, and it may reduce merchandise revenue to zero.
- **BD-8** Redeemed points are restored on return, cumulatively and exactly.
- **BD-9** 8C wires both redemption and earning into sale creation.
- **BD-10** Buy-X-Get-Y is evaluated **per line only** — never aggregated across lines.
- **BD-11** Manual discount and promotion are **additive, capped at line gross**.
- **BD-12** A manual discount is capped at line gross **universally**, so net merchandise value can never be negative.
- **BD-13** Serial identity is **mandatory** at sale creation for a serial-tracked variant.
- **BD-14** A returned serial transitions `SOLD → RETURNED` — quarantine, not straight back to sellable.
- **BD-15** A warranty covering a returned unit **auto-voids** atomically with the return.
- Zero-value redemption is **rejected**, never silently converted into a no-op.

### Architecture and security invariants, verified in 8F

Each was established by direct PostgreSQL introspection or exhaustive code search, not inferred from passing tests:

- **All 53 tenant-owned tables** carry RLS **and** FORCE RLS, exactly one policy each, every one with both `USING` and `WITH CHECK`; all 9 join tables without `business_id` carry transitive policies. Only the global `permissions` catalogue (`SELECT`-only) and `_prisma_migrations` (no grant) sit outside. **No unrestricted path exists.**
- **`InventoryEngine` is the sole inventory mutation authority** — zero writes to `stock_movements`/`stock_balances` anywhere else.
- **`AccountingEngine` is the sole journal-entry authority** — zero writes to `journal_entries`/`journal_entry_lines` anywhere else.
- **`CustomerPoints` is append-only** — all five call sites are inserts; `erp_app` holds no UPDATE or DELETE. The same holds for `sale_promotion_applications`, `sale_item_serials` and `sale_return_item_serials`.
- **Historical sales never recompute**: every live-configuration read occurs only at creation time; the return path reads none. `tx.sale.update` exists nowhere; `tx.saleItem.update` exists once, for `quantityReturned`.
- **Reports remain read-only** — zero write calls in the reporting module.
- **Canonical lock order** is `Customer → Sale → StockBalance → SerialNumber`, with no opposite ordering anywhere.

### Phase 8F (previously completed)
Phase 8F — Full Verification (**Complete, release-gate approved**)

Phase 8F was a verification and hardening audit only — **no feature was added and no architecture changed**. It verified the whole Phase 8 surface (8A Warranty, 8B Loyalty Ledger, 8C Redemption, 8D Promotions, 8E Sales Integration) as one integrated system, using four independent methods: direct PostgreSQL structural queries, code inspection, `EXPLAIN` plans, and new end-to-end tests.

**Structural results.** All 53 tenant-owned tables carry RLS **and** FORCE RLS with exactly one policy each, every one having both `USING` and `WITH CHECK`; every join table without a `business_id` carries a transitive policy. Only `permissions` (a global catalogue, `SELECT`-only) and `_prisma_migrations` (no grant at all) sit outside, both by design — **there is no unrestricted path**. No append-only table holds `UPDATE` or `DELETE`.

**Architecture results, proven by exhaustive grep rather than assertion.** Zero writes to `stock_movements`/`stock_balances` outside `InventoryEngine`; zero writes to `journal_entries`/`journal_entry_lines` outside `AccountingEngine`; `customer_points` has five call sites and all five are `create`; `sale_promotion_applications`, `sale_item_serials` and `sale_return_item_serials` have **no** update or delete call anywhere; the reporting module contains zero write calls; `tx.sale.update` does not exist anywhere, and `tx.saleItem.update` exists exactly once, for `quantityReturned`. Every live-configuration read (`resolveActivePromotions`, both loyalty rates, warranty duration) occurs **only at creation time** — the return path reads none, which is the structural proof that historical sales never recompute.

**Nine new verification tests** covered the gaps the per-phase suites left: a cross-tenant INSERT sweep over every Phase 8 table, trial-balance integrity after the fully integrated flow, calculation determinism under repetition, a consolidated atomicity sweep across every rejection path, and historical immunity to product price and cost changes.

**Four documentation errors were found and corrected** (details in Known Issues). **No product defect was found.**

### Phase 8E (previously completed)
Phase 8E — Sales Integration (**Complete, release-gate approved**)

Phase 8E closed the Phase 8 loop: the promotion, loyalty and sales paths were verified as an integrated whole, the BD-12 discount invariant was corrected, and **Known Issue #47 is CLOSED** — a sale now captures which physical serial it sold, and warranty registration verifies against that fact rather than a proxy.

Four decisions were locked as approved business policy before implementation: **BD-12** a manual discount is capped at line gross universally; **BD-13** serial identity is mandatory at sale creation for a serial-tracked variant; **BD-14** a returned serial transitions `SOLD → RETURNED` (quarantine, not straight back to sellable); **BD-15** a warranty on a returned unit auto-voids atomically with the return.

**Canonical lock order is now `Customer → Sale → StockBalance → SerialNumber`.** Serial consumption previously ran *before* the stock movement — the opposite order — and was corrected.

### Phase 8D (previously completed)
Phase 8D — Promotions (**Complete, release-gate approved**)

Phase 8D delivered the Promotion model, engine, eligibility, calculation, best-applicable selection, validity dates, permissions and the minimum `CreateSaleUseCase` integration that makes promotions real. **Three approved types** (Percentage, Fixed Amount, Buy-X-Get-Y), **three targets** (Product, Variant, Category), **best applicable only — never stacked**, validity in the business timezone, and historical sales that never change when a promotion is later edited or deactivated.

Two decisions were locked as **approved business policy** before any code was written: **BD-10 — BXGY is evaluated PER LINE ONLY**, with no aggregation or allocation across variants, products or category lines; and **BD-11 — a manual discount and a promotion are ADDITIVE, capped at line gross**, `finalDiscount = min(manualDiscount + promotionDiscount, lineGross)`.

**No threshold/basket-spend or basket-wide promotions, no stacking, no quotas or usage limits, no customer-specific pricing, no branch-scoped promotions, no bundle-promotion expansion, no Tax Engine, no Phase 6 accounting refactor, no Known Issue #47 or #29 work.** `CreateSaleReturnUseCase`, `InventoryEngine` and `AccountingEngine` were not modified at all.

### Phase 8C (previously completed)
Phase 8C — Loyalty Redemption (**Complete + RELEASE-GATE APPROVED**)

**Release-gate approval explicitly accepted the three pre-existing defects found and fixed during 8C** (#59 journal residual precision, #60 zero-value customer transaction, #61 timing-dependent concurrency assertion), and approved as implemented and tested: the loyalty lifecycle, redemption, earning, the BD-1 return correction, clawback, restoration, idempotency, concurrency, accounting interaction, and historical-integrity behaviour.

Phase 8C wired the complete loyalty sale lifecycle — **Sale → EARN / REDEEM → Return → CLAWBACK / RESTORATION** — into the existing transactional paths, and landed the mandated **BD-1 return-credit correction** it depends on. Redemption resolves server-side inside `CreateSaleUseCase`'s own transaction, becomes line discounts (never a payment tender), and participates in the Sale's idempotency. Nothing is committed without the sale: every rejection rolls back the whole transaction, proven by delta-count tests.

**No Promotions, no PromotionEngine, no Warranty change, no Tax Engine, no loyalty expiry, no GL liability, no Phase 6 accounting redesign, no workaround for Known Issue #47.**

**Three latent defects were found during 8C testing and fixed** (details in Known Issues #59–#61): two were reproduced on the pre-8C code and are therefore corrections, not regressions.

### Phase 8B (previously completed)
Phase 8B — Loyalty Ledger (**Complete, release-gate approved**)

Phase 8B delivered the loyalty **ledger foundation ONLY**, exactly as approved: an append-only `CustomerPoints` table, a balance that is always `SUM(points)` derived on read, the BD-3 earning rule, permissions, and a manual adjustment endpoint. **No Redemption (8C). No Promotions (8D). No Sales integration (8E).** `CreateSaleUseCase` and `CreateSaleReturnUseCase` were not touched. **No GL change** — `LoyaltyModule` imports neither `InventoryEngineModule` nor `AccountingEngineModule`, so points cannot reach the ledger even by mistake, matching the approved decision that loyalty points are **not** a General Ledger liability in Phase 8. **No expiry and no scheduler.** Phases 1-8A source is untouched apart from wiring the new module.

**There is no stored mutable balance anywhere** — asserted by a test that scans `information_schema` for any balance-shaped column and requires none. Append-only is a **database** guarantee: `erp_app` holds `SELECT, INSERT` and nothing else on `customer_points`, proven by a direct-connection UPDATE/DELETE rejection test.

### Phase 8A (previously completed)
Phase 8A — Warranty (**Complete, release-gate approved**)

Phase 8A delivered the Warranty module ONLY, exactly as approved: warranty registration against a sold serial-tracked unit, a business-default duration with a per-registration override, a **snapshotted** duration/coverage window, an ACTIVE/EXPIRED/CLAIMED/VOID lifecycle, and OPEN→RESOLVED|REJECTED claims. **Record-keeping only** — `WarrantyModule` imports neither `InventoryEngineModule` nor `AccountingEngineModule`, so no warranty action can move stock, replace a unit, or post to the ledger; that is structural, not a convention. **No Loyalty. No Promotions. No Sales integration. No Accounting change. No Inventory change.** Phases 1-7 source is untouched apart from wiring the new module.

One real gap in the existing system was found while implementing 8A and was recorded as **Known Issue #47** rather than worked around: Phase 5 sales recorded no `SaleItem → SerialNumber` link, so warranty registration could verify the variant but not that the supplied serial was the unit that actually left on that line. **Phase 8E closed this** — see the Phase 8E section.

### Phase 7 (previously completed)
Phase 7 — Reports & Dashboard (**Complete, release-gate approved**)

Phase 7 delivered a strictly **read-only** reporting layer (`modules/reporting/`) over the source-of-truth systems built in Phases 3-6: sales/purchasing/inventory/financial reports, a dashboard read model, and four reconciliation reports. No writes to any transactional table, no reporting tables, no new `erp_app` grants, no Phase 1-6 refactor.

**Implemented in sub-phases 7A→7G**, each verified before the next began. **A real defect in this document was found during 7F and is corrected below** (see Known Issue #37, restated): the stock-count accounting gap is NOT identifiable by `movementType = 'STOCK_COUNT'` — that enum value is dead and no code path writes it. Reconciliation reports would have silently excluded nothing while appearing correct.

### Phase 6 (previously completed) — release-gate approval note
Phase 6 is **COMPLETE + RELEASE-GATE APPROVED**.

**Release-gate approval carried three mandatory documented limitations** - all recorded in Known Issues below as `RELEASE-GATE LIMITATION` entries (#32 walk-in SaleReturn Revenue/AR reversal unsupported; #36 inherited Purchasing idempotency gap, explicitly NOT fixed by Phase 6; #37 `STOCK_COUNT` movements produce no GL entry and must be excluded from any inventory↔GL reconciliation). No scope was added or changed to accommodate them, and no Phase 1-5 refactor was performed.

Phase 6 delivered a real double-entry Accounting Engine (`AccountingEngineService.postEntry`/`.reverseEntry`), a Chart of Accounts, `JournalEntry`/`JournalEntryLine`, `FiscalPeriod`, and `AccountingMappingRule`, integrated into Sales/Purchasing/Inventory's existing atomic transactions per your explicit Phase 6 scope decisions (no `FinancialAccount`/`CashRegister`, no Expense-management module, no historical backfill, automatic postings go straight to `POSTED`, business-scoped-only COA, Accountant+Owner-only access). Full detail below; two real bugs were found and fixed during the test-writing phase itself (see Known Issues #34/#35 and the Compatibility/Testing sections).

### Phase 5 (previously completed) — release-gate review note
This document was verified against the live code, both databases, and a freshly-run test suite after the original Phase 5 report - not just re-read and trusted. The review found and fixed **four real gaps**, all within Phase 5's own scope:
1. **Idempotency-key reuse with a materially different payload was silently accepted** (returned the stale original record instead of rejecting the mismatch) in all three of `CreateSaleUseCase`, `CreateSaleReturnUseCase`, and `CreateSalePaymentUseCase`. Fixed with a shared `assertIdempotentReplayMatches` helper comparing a canonical fingerprint of the request; 3 new tests prove a same-key/different-payload retry is now rejected (409) rather than silently substituted.
2. **No dedicated atomicity/rollback test existed for `CreateSaleUseCase`** (unlike Purchasing's Phase 4 equivalent) - added one and it passed on the first run, but the gap in *proof* was real regardless.
3. **`paidAmount`/`remainingAmount`/`paymentStatus` were computed internally for validation but never actually surfaced on `GET /sales/:id`**, contradicting what the design already promised. Added a shared `computePaymentSummary` helper (now used by both `GetSaleUseCase` and `CreateSalePaymentUseCase`, replacing the latter's duplicated inline computation) and 3 tests covering all three payment-status values (`PAID`/`PARTIALLY_PAID`/`UNPAID`).
4. **No dedicated concurrent return-vs-return test existed for Sales** (unlike Purchasing's Phase 4 equivalent) - added one; it also passed on the first run.

All four were found by deliberately trying to break the implementation the review's own instructions demanded (mismatched idempotency payloads, deliberate rollback triggers, reading the actual `GetSaleUseCase` response shape, concurrent return contention) rather than re-asserting the original report. None were data-corruption defects in what had already shipped - the underlying data was always correct - but the missing payload-match check was a real, exploitable correctness gap (a client could receive a stale, unrelated Sale's data believing a different request had succeeded), so it is classified as **Blocking-severity found and fixed during review**, not deferred as debt. A comprehensive WAC/historical-cost reconciliation test spanning Inventory + Purchasing + Sales together (Opening → Purchase → Sale → Purchase → Sale → Return → Adjustment) was also added per the review's explicit request and passed on the first run, proving `unit_cost_at_movement` immutability end-to-end, not just per-module. All sections below reflect the post-review state.

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

### Phase 6 (new) — Finance/Accounting

**Scope decisions** (approved before implementation, verbatim intent):
- **`FinancialAccount`/`CashRegister`/`CashTransaction`: OUT.** `AccountingMappingRule` maps directly to a GL `Account` (e.g. `SalePaymentMethod.CASH` → Account "1010 Cash on Hand") - no intermediate operational "financial account" entity, no cash-count/reconciliation fields anywhere, `Shift` stays exactly as Phase 5 built it.
- **`Expense`/`ExpenseCategory`/`RecurringExpense`: OUT.** The COA supports `EXPENSE`-type accounts (seeded: COGS, Inventory Shrinkage, Internal Consumption Expense), but there is no expense-management module/documents in Phase 6 - that's a later phase.
- **No historical backfill.** Phase 6 posts only for events created from its own activation onward. **The Trial Balance does not represent a complete accounting history before that activation date** - Phases 1-5's pre-existing Sales/Purchases/Payments/Adjustments have no retroactive journal entries, by explicit instruction. A one-time, idempotent bootstrap (`seedAccountingDefaults`, run via `prisma/seed.ts` for every pre-existing business) creates the default COA + mapping rules + one open-ended `FiscalPeriod` so posting can begin immediately - this is infrastructure setup, not a reinterpretation of history.
- **Automatic postings go straight to `POSTED`.** No manual-review workflow for Sale/Purchase/Return/Payment/Adjustment postings. `JournalEntryStatus.DRAFT` exists in the enum (spec fidelity, Phase 0 §6.2) but is **never actually written by any Phase 6 code path** - there is no manual journal-entry-creation endpoint in this phase (deliberately, see Known Issues #33).
- **Chart of Accounts is business-scoped only.** `Account` has no `branchId`. `TRANSFER_IN`/`TRANSFER_OUT` stock movements between branches of the same business have **no GL posting at all** - the same business-scoped Inventory account nets to zero either way.
- **Accounting access is Accountant + Business Owner only.** No `accounting.*` permission was added to `BRANCH_MANAGER`, `INVENTORY_MANAGER`, `CASHIER`, or `SALES_EMPLOYEE`.

**`AccountingEngineService`** (`engines/accounting/accounting-engine.service.ts`) - the ONE interface (Phase 0 §6) through which every automatic journal entry is created:
- `postEntry(tx, params)`: normalizes/validates lines (each line is a debit XOR a credit, never both, never neither), validates `SUM(debit) === SUM(credit)` (throws `UnbalancedJournalEntryError` otherwise), validates every account belongs to the tenant and is active, locks the `FiscalPeriod` covering `entryDate` (`SELECT ... FOR UPDATE`, applying Phase 5's "grant UPDATE up front" lesson instead of discovering it live again) and requires it `OPEN`, then inserts the `JournalEntry` + `JournalEntryLine` rows. Always called with the SAME `tx` as the business event it represents - one transaction, all or nothing.
- `reverseEntry(tx, businessId, originalEntryId, actorId, reason)`: the sole correction mechanism (Phase 0 §6.2 - never an edit). Builds the exact debit/credit mirror of the original's lines and re-runs the same insert path with `reversalOfId` set. Duplicate-reversal is a DB-enforced unique constraint (`businessId, reversalOfId`), not just an app pre-check. **`JournalEntryStatus.REVERSED` is never actually written** - "has this entry been reversed" is always a DERIVED fact (does a row exist with `reversalOfId` pointing at it), keeping `journal_entries` truly append-only (no UPDATE grant at all, not even for this).

**Chart of Accounts** (`modules/accounting/domain/seed-accounting-defaults.ts`) - 21 system accounts per business (5 top-level groups + 16 leaves: Cash/Card/Wallet/Bank/Cheque/Other-tender clearing accounts, Accounts Receivable, Inventory, Accounts Payable, Tax Payable, Opening Balance Equity (unmapped, reserved), Sales Revenue, Inventory Gain, COGS, Inventory Shrinkage, Internal Consumption Expense) + a 15-key `AccountingMappingRule` set + one open-ended bootstrap `FiscalPeriod`, seeded idempotently at business onboarding (`RegisterBusinessUseCase`) and via a one-time `prisma/seed.ts` backfill for pre-existing businesses.

**Domain-specific journal-line builders** (`modules/accounting/domain/*-journal-lines.ts`) - one per source event, each resolving `AccountingMappingKey`s to real accounts and building already-balanced `PostEntryLineInput[]` from values the calling use-case ALREADY computed (never recomputed):
- `sale-journal-lines.ts` - Sale: Dr tender(s)/AR (per payment method + remaining credit) = Cr net revenue + tax; Dr COGS = Cr Inventory (from `computeSaleCost`, reusing Phase 5's own helper unchanged). Zero-value sub-lines (no tax, no cost, a fully-discounted line) are omitted, never posted as meaningless 0-amount lines - proven always still balanced by construction (see Architecture Decisions).
- `sale-return-journal-lines.ts` - SaleReturn: Dr Inventory (original sale cost, carried over) = Cr COGS; for DAMAGED lines, an additional Dr Inventory Shrinkage = Cr Inventory pair at the DAMAGE movement's own (current) cost - genuinely two separate Inventory legs that need not numerically cancel (a real, correct WAC-drift consequence, not a bug); for a customer-attached return only, Dr Revenue = Cr AR. **Walk-in (no-customer) returns post NO Revenue/AR reversal** - a documented limitation, not a silent gap (see Known Issues #32).
- `sale-payment-journal-lines.ts` / `purchase-journal-lines.ts` - later SalePayment (Dr tender / Cr AR), PurchaseReceipt (Dr Inventory / Cr AP, using the EXACT `totalReceivedValue` `SupplierTransaction` already posts), PurchaseReturn (Dr AP / Cr Inventory), PurchasePayment (Dr AP / Cr tender).
- `inventory-adjustment-journal-lines.ts` - `AdjustStockUseCase`'s five reachable movement types: `INTERNAL_CONSUMPTION` always debits the dedicated expense account; `ADJUSTMENT`/`DAMAGE`/`LOSS`/`EXPIRY` debit Inventory Shrinkage on a decrease or credit Inventory Gain on an increase, keyed off the movement's actual sign. `ApproveStockCountUseCase`'s `STOCK_COUNT` movements are **not wired to Accounting in v1** (Known Issue #31).

**Integration points, all inside the SAME transaction as the source event** (never a second inventory-valuation engine, never a recomputed business fact): `CreateSaleUseCase`, `CreateSaleReturnUseCase`, `CreateSalePaymentUseCase`, `ReceivePurchaseUseCase`, `CreatePurchaseReturnUseCase`, `CreatePurchasePaymentUseCase`, `AdjustStockUseCase`.

**Read/report endpoints** (`modules/accounting/presentation/`): `GET/POST /accounting/accounts`, `PATCH/DELETE /accounting/accounts/:id` (rename/deactivate, system accounts can be renamed but never deactivated), `GET /accounting/accounts/:id/balance` (live `SUM(debit)-SUM(credit)`, never stored); `GET /accounting/journal-entries` (filterable by `sourceType`/`accountId`/`fiscalPeriodId`), `GET /accounting/journal-entries/:id`, `POST /accounting/journal-entries/:id/reverse`, `GET /accounting/journal-entries/trial-balance` (every account's live balance + an explicit `balanced` boolean - Phase 6's own reconciliation proof, the same posture as Inventory's `/inventory/reconciliation`); `GET/POST /accounting/periods`, `POST /accounting/periods/:id/close`, `POST /accounting/periods/:id/reopen`. Income Statement/Balance Sheet/Cash Flow/exports/dashboards are explicitly deferred (Phase 0 §6.5 names them as derivable from `JournalEntryLine`, but building the report endpoints themselves was scoped out of Phase 6).

**Fiscal Periods**: entries are linked to whichever `FiscalPeriod` covers `entryDate`, resolved and row-locked server-side inside `postEntry` - never client-supplied. A CLOSED period rejects new postings. `accounting.reopen_period` is a permission deliberately separate from `accounting.periods.manage` (Phase 0 §6.4 names it specifically), granted to `BUSINESS_OWNER` only by default. Opening a new period only checks for overlap against OTHER **OPEN** periods (a closed one's date range never blocks a new period from being opened over it - see Known Issues #34, a real bug found and fixed during this phase's own testing).

### Phase 7 (new) — Reports & Dashboard

**Scope decisions** (approved before implementation):
- **Read-only, always.** No reporting use-case writes to `sales`, `purchases`, `stock_movements`, `stock_balances`, `customer_transactions`, `supplier_transactions`, `journal_entries` or `journal_entry_lines`. No reporting tables (no duplicate source of truth). No new `erp_app` grants — reporting reads what the runtime role already has SELECT on.
- **Deferred / excluded**: IAS-7 Cash Flow (Investing & Financing have no source data at all — no fixed assets, loans or capital transactions exist; a three-section statement cannot be produced correctly and was NOT approximated); PDF/Excel exports (no export infrastructure, and no `reports.export` permission was created for a non-existent feature); Low Stock (no reorder-point field exists); AR/AP aging (no due-date field exists); complete business expenses (no expense module); gross-revenue/returns split (would require a Phase 6 mapping change); Cash Register reconciliation (neither `CashRegister` nor `CashTransaction` exists).

**`modules/reporting/domain/`** — the four shared concerns every report resolves *before* reading a row, deliberately centralised so none can be forgotten:
- `branch-scope.ts` — **the first server-side branch authorization in the system.** `UserBranch` has existed since Phase 1 but was only used for user CRUD; no read endpoint enforced it. Rule: a caller holding `reports.financial.view` is unrestricted (the Chart of Accounts is business-scoped, so a per-branch Balance Sheet is meaningless); everyone else is restricted to their own `UserBranch` rows; **a restricted caller with no assignment sees nothing (fail closed, never everything)**; an unauthorized `branchId` is a **403, never a silent empty result** (a silent empty would let a client probe which branches exist).
- `date-range.ts` — half-open `[from, toExclusive)` windows resolved in the **business's own timezone** (`Business.timezone`), not raw UTC: a 22:00 Cairo sale is 20:00 UTC, and UTC-day boundaries would misattribute evening sales and quietly corrupt daily totals. An inclusive calendar `to` is converted to the exclusive start of the next day, so the final day is included exactly once with no gap or overlap.
- `report-visibility.ts` — cost/profit fields are **deleted** server-side, not nulled (an absent key cannot be misread as "genuinely zero", and omission is directly assertable in tests). Two independent gates: `products.view_cost` (existing) for cost fields, `reports.view_profit` (new) for profit/margin fields.
- `report-context.ts` — resolves branch scope + visibility + date range together, once, and hands them to each use-case as a single required object.

**Sales/Purchasing reports** — summary, by product/category/branch/user/payment-method, returns, purchasing summary. COGS always from the SALE/BUNDLE_CONSUMPTION movements' historical `unitCostAtMovement`, never a current cost (proven by a test that changes cost afterwards and confirms the reported COGS is unmoved). `Product.categoryId` and `Sale.createdBy` are both nullable, so both get explicit "Uncategorized"/"Unattributed" buckets rather than being dropped — dropped rows would make dimension totals silently disagree with the summary. The returns report surfaces `walkInReturnValue` and an explicit `glRevenueReversalNote` (Known Issue #32) so the operational-vs-GL divergence reads as the documented limitation it is.

**Inventory reports** — valuation, movements, damage/loss, slow-moving. Sourced from the Stock Ledger and its derived `StockBalance`, never `Product.defaultCost` (tested explicitly against a product whose `defaultCost` is 0). Slow-moving is defined purely by observed absence of SALE movements in a caller-supplied window — no invented threshold. **Low Stock has no endpoint at all**, because no reorder-point field exists to define "low".

**Financial reports** — General Ledger, P&L, Balance Sheet, receivables, payables. Source of truth is posted `JournalEntryLine` exclusively.
- **P&L**: `netRevenue` (account 4100), `costOfGoodsSold` (5100), `grossProfit`, `inventoryRelatedOperatingExpenses` (5200 shrinkage + 5300 internal consumption), `otherIncome` (4200), `netProfit`. Revenue is reported **NET** — Phase 6 posts a return's reversal as a debit to the same revenue account, so a gross/returns split isn't derivable from the GL, and deriving it from documents would re-derive an accounting fact from invoices. **Discounts are deliberately not a P&L line** (revenue is posted already net of discount, so no GL fact backs one). Every limitation is returned *on the response itself*, not just documented here.
- **Balance Sheet**: Assets / Liabilities / Equity, where Equity includes a computed **Current Period Earnings** (`SUM(REVENUE) − SUM(EXPENSE)`). This is not an approximation but the standard pre-closing derivation, and it balances **provably**: since every journal entry satisfies `SUM(debit)=SUM(credit)` (Phase 6 enforces this at both the application and DB layers), the identity `Assets = Liabilities + Equity + (Revenue − Expenses)` holds by construction. The response asserts it with an explicit `balanced` flag, tested both on a fixed dataset and again after further activity.

**Dashboard** — a pure live read model. **Zero dashboard tables** (asserted by a test that queries `information_schema` for any `%dashboard%`/`%report%`/`%kpi%` table and requires none). Honest labelling is enforced by test: the expense KPI is named `inventoryRelatedOperatingExpenses` and the response explicitly states it is **not** a total-expenses figure; `netProfit` carries the same caveat; `cashBalance`/`bankBalance` are declared GL-recorded-activity-only, not a complete treasury position; Low Stock is declared unavailable. No caching in Phase 7 — premature without measured load, and a stale financial KPI is worse than a slow one.

**Reconciliation** — four reports, zero tolerance, discrepancies always listed rather than summarised away: (1) Stock ledger vs `StockBalance`; (2) Customer subledger vs AR control account; (3) Supplier subledger vs AP control account; (4) Inventory ledger value vs the GL Inventory account, **excluding the two documented non-posting sources** (`referenceType='StockCount'` and `movementType='OPENING_BALANCE'`) with each excluded value reported **visibly and separately**, and an explicit note that these divergences are expected and are NOT accounting errors.

### Phase 8A — Warranty
**Registration** (`POST /warranties`) binds ONE physical serial unit to ONE sale line. Validation runs in order, every reference checked inside the caller's own tenant before anything is written: the `SaleItem` exists here → its product is **serial-tracked** (a non-serialized line is rejected 422, because a warranty must identify one physical unit and such a line cannot say which) → the `SerialNumber` exists here → the serial belongs to the **same variant** as the sale line → no warranty already exists for that (saleItem, serial) pair. Duplicate protection is the `(business_id, sale_item_id, serial_number_id)` unique index — a DB guarantee; the application pre-check exists only to return a friendlier 409.

**Duration** resolves as: explicit `durationDays` override, else `Setting['warranty.default_duration_days']` for the business. If neither is present or the stored default is not a valid positive integer, registration **fails 422 rather than guessing a duration** — no default is invented anywhere in the code. This reuses Phase 1's generic `Setting` store exactly as `resolveAllowNegative` does; no new configuration table was added. **No business maximum was invented** — the 36500-day ceiling on both the zod schema and the `warranties_duration_days_technical_bound` CHECK is a technical timestamp-overflow bound and is documented as such in both places.

**Coverage is snapshotted at registration and never recomputed.** `startDate` is always the **SALE's own `createdAt`** — never the registration time, never client-supplied. `durationDays` is stored on the row and `endDate` derived from it once. Changing the business default afterwards provably cannot widen or narrow an already-issued warranty (tested at both the DB row and the API read model). The interval is **half-open `[startDate, endDate)`**, the same convention Phase 7's date ranges use, so a boundary instant belongs to exactly one side.

**Lifecycle**: `status` is the stored, human-set value (`ACTIVE`/`CLAIMED`/`VOID`); `effectiveStatus` is derived **on read** from the row's own dates. Phase 8A adds **no job runner**, so nothing flips `ACTIVE` to `EXPIRED` in the background — an elapsed warranty still stores `ACTIVE` and reads `EXPIRED`, and both are returned so the distinction is never hidden. `VOID` has a real transition path (`POST /warranties/:id/void`) deliberately: a status the schema declares but no code can set would be a dead enum member masquerading as behaviour — the Phase 7 `STOCK_COUNT` lesson (Known Issue #37) applied up front.

**Claims** (`POST /warranties/:id/claims`) are **record-keeping only** (approved decision): registering or resolving a claim creates no `StockMovement`, no `JournalEntry`, no `SaleReturn`, no refund, and no replacement — any replacement workflow is explicitly deferred. Eligibility is checked against the warranty's own snapshotted dates: a `VOID` warranty and one outside `[startDate, endDate)` are both rejected 409. A warranty already `CLAIMED` **can** take another claim (a first claim may have been REJECTED, or a second unrelated fault may occur) — blocking that would invent a one-claim-per-warranty rule Phase 0 does not state. Claim statuses are exactly the three approved: **OPEN → RESOLVED | REJECTED**, one-way, with no path back to OPEN and no richer workflow. A resolution records `resolvedAt`/`resolvedBy` and never rewrites `claimedAt` or `description`; the `warranty_claims_resolution_audit_consistent` CHECK makes that pairing a database guarantee, proven by a test that tries to violate it via raw SQL.

### Phase 8B — Loyalty Ledger
**`CustomerPoints` is append-only, and the database is what enforces it.** `erp_app` is granted `SELECT, INSERT` only — no UPDATE, no DELETE — the same strictest-in-the-system posture as Phase 6's `journal_entries`/`journal_entry_lines`. A correction is therefore always a **new compensating row**; the original event survives byte-for-byte (tested). No locking-only UPDATE grant was needed either, because the concurrency boundary for a balance is the **Customer** row, not the ledger rows: locking existing ledger rows cannot block the INSERT of a new one, which is precisely the race that matters.

**Balance is `SUM(CustomerPoints.points)`, computed on every read.** There is no `balance` column on `Customer`, no cache, and nothing to invalidate — asserted by a test that queries `information_schema` for any balance-shaped column and requires zero. Every row is **signed** (EARN positive; REDEEM and RETURN_CLAWBACK negative; ADJUSTMENT either way), so a plain `SUM()` is the whole computation, and a CHECK constraint (`customer_points_sign_matches_type`) makes a sign that contradicts its own type unrepresentable — without it a `REDEEM` row with a positive value would silently *increase* a balance while reading as a spend.

**Negative balances are impossible** (approved policy: no negative balance, no debt/negative-points mechanism). A deduction larger than the current balance is rejected 409 with nothing written. The check runs while holding `SELECT … FOR UPDATE` on the **Customer** row with the balance re-read under that lock, so two concurrent deductions that are each individually affordable can never together overdraw — proven by a real concurrent-HTTP test, plus a global assertion that no customer anywhere in the database holds a negative derived balance.

**BD-3 earning rule**, implemented literally: `pointsEarned = floor(loyaltyEligibleAmount × pointsPerCurrencyUnit)`. **Floor, never half-up**; `Prisma.Decimal` throughout with no floating-point step anywhere. The rate comes from the existing Phase 1 `Setting` store (`loyalty.points_per_currency_unit`) — **no new configuration table**. An absent *or invalid* stored rate resolves to `null` meaning "this business runs no loyalty programme", never a guessed default. Computing `loyaltyEligibleAmount` itself is 8E's job; 8B owns only the deterministic conversion to points.

**Historical integrity is snapshotted onto the row**: `basisAmount` and `rateSnapshot` freeze the arithmetic that produced the points, so a later rate change can never alter, re-derive or invalidate points already earned — proven by a test that changes the rate to 99 afterwards and confirms the row still reproduces its own value from its own snapshot. A `customer_points_snapshot_complete` CHECK makes the pair all-or-nothing, since a row with a basis but no rate could not reproduce its own arithmetic.

**Manual adjustment** (`POST /sales/customers/:id/points/adjust`) is the one human-entered write and the only ledger writer that exists in 8B — EARN, REDEEM and RETURN_CLAWBACK rows come from a Sale or SaleReturn and are 8C/8E's approved scope. Its `idempotencyKey` and `reason` are both **required** (unlike Sales' optional keys): there is no source document behind a manual adjustment, so a double submission would otherwise be indistinguishable from two deliberate identical grants, and a point grant with no stated cause is an entry an audit cannot explain later. The DB-level `(business_id, idempotency_key)` unique index is the real guarantee; `assertIdempotentReplayMatches` rejects the same key reused with a **different** payload rather than returning a stale row.

### Phase 8C — Loyalty Redemption, Earning Integration, and the BD-1 Correction

**One definition of return credit, three consumers.** `sales/domain/return-credit.ts` is the single source for "what a returned unit is worth", used by the refund, the loyalty clawback and the redemption restoration alike. Phase 5 credited `quantity × unitPrice` and ignored `discountAmount` entirely, so a Buy-2-Get-1 line the customer paid 200 for refunded 300. The corrected form uses the line's **historical merchandise value** (`round4(unitPrice × quantity) − discountAmount`, tax excluded — the stored `lineTotal` *includes* tax and must never be used) apportioned by **cumulative** returned quantity:

```
cumulativeCredit(q) = round4(merchandiseValue × q / quantity)
thisReturnCredit    = cumulativeCredit(after) − cumulativeCredit(before)
```

Cumulative deltas rather than per-return proportions, because the naive form drifts: three single-unit returns of that same line would each refund `round4(200/3) = 66.6667`, totalling **200.0001**. The delta form yields `66.6667 + 66.6666 + 66.6667 = 200.0000` exactly, and the test asserts that exact sequence.

**Monetary rounding policy (BD-6), the first in the codebase.** `round4` — 4 dp HALF-UP — applied at exactly three points: the redemption value, each line's allocated share, and each line's cumulative return credit. Introduced at the scale the columns already store, so no pre-existing value changes. HALF-UP for money, never floor; floor remains the rule for *points* (BD-3), because a customer should never be credited a point they have not earned, but flooring a refund would shortchange them.

**Redemption.** `V = round4(K × ρ)` where `ρ` is **currency per point** (`Setting['loyalty.currency_per_point']`), deliberately not named as the mirror of the earning rate since the two are independent. Bounded by `V ≤ Σ eligible` (BD-7: no other cap, no minimum cash requirement, no cap Setting — redemption may take merchandise net revenue to **zero**). Allocated across lines by **largest-remainder with a per-line cap**, ordered by `variantId` (the same canonical order used for lock acquisition; `SaleItem.id` does not exist yet at allocation time). Sums exactly to `V` and never breaches a line's eligible value — both by construction, since `V ≤ T` makes each exact share at most its own cap and the remaining capacity always covers the outstanding shortfall. The result is folded into `SaleItem.discountAmount`, so **`Sale.discountAmount = SUM(SaleItem.discountAmount)` still holds** and Phase 6's `netRevenue` keeps working untouched.

**Earning is computed after redemption** (BD-3): `B = subtotal − discountAmount` (now including the redemption), `P = floor(B × r)`. Verified by test with tax present, proving tax is excluded and the redemption reduces the basis.

**Clawback (§6.2) and restoration (BD-8), both cumulative.** Driven by the *same* return credit `C`:

```
retained     = max(B − C, 0);  totalOwed = P − floor(retained × r)
cumRestored  = round4(K × C / B)        (points and value alike)
```

each return recording the delta from what is already recorded. On the worked example (3 units, 100 each, 100 discount, 5000 points redeemed at 0.01, earning rate 2), three single-unit returns produce clawbacks of **−167, −167, −166 = −500 exactly** and restorations of **1666.666, 1666.668, 1666.666 = 5000 exactly**. The naive per-return form would restore 5000.0001. Both sequences are asserted literally.

**Negative balances remain impossible.** The check runs on the balance the return actually *leaves behind* — after both the restoration and the clawback — because they are two effects of one atomic return; checking the clawback alone would reject returns that are in fact funded by their own restoration (tested both ways). A failure rejects the **entire** return: no refund, no movement, no journal entry, no ledger row.

**Historical integrity.** Every input is a snapshot — the EARN/REDEEM rows' own `points`/`basisAmount`/`rateSnapshot` plus the Sale's own `subtotal`/`discountAmount`. A test changes **both** business rates dramatically before returning and confirms the clawback and restoration still use the original 2 and 0.01. Original rows are re-read after the return and confirmed byte-for-byte unchanged.

**Canonical lock order is now Customer → Sale → StockBalance.** `CreateSaleReturnUseCase` takes the customer lock *before* `lockSale`, because `CreateSaleUseCase` locks the customer before its own stock locks — the opposite order would let a concurrent sale and return deadlock on customer-vs-stock. A `Promise.all` sale-vs-return race test exercises it.

### Phase 8D — Promotions

**Three calculators, each bounded above by the line gross by construction**, so a promotion alone can never drive a line negative:

```
PERCENTAGE   discount = round4(lineGross × percentageValue / 100)        (0 < pct <= 100)
FIXED_AMOUNT discount = min(round4(fixedAmount × quantity), lineGross)   (fixedAmount is PER UNIT)
BUY_X_GET_Y  freeUnits = floor(quantity / (X + Y)) × Y
             discount  = round4(freeUnits × unitPrice)
```

`Y` is **inside** the set — "Buy 2 Get 1" needs 3 units on the line. The rule **repeats** for every whole multiple (6 units of a 2+1 yield 2 free) and there is **no partial fulfilment** (5 units yield 1 free, not 1.67).

**BD-10 — per line only.** Quantities are never aggregated across lines, so a category "Buy 1 Get 1" spread over two separate one-unit lines yields **zero** free units, while the same promotion does apply to a line that completes a set on its own. Both are asserted by test. Because `SaleItem @@unique([saleId, variantId])` makes a line exactly one variant at one price, "which unit is free" is arithmetically vacuous and no cheapest-free or cross-line allocation rule is needed anywhere.

**BD-11 — additive, capped.** The promotion is computed on the line **gross**, never on the post-manual price; the combined discount is capped at the gross rather than rejected, so the net merchandise value can never go negative. Both approved examples are asserted: 30 manual + 20 promotion on a 100 line → **50**; 90 + 30 → **100**. The cap applies **only to a line a promotion actually reached** — where no promotion applies the client's manual discount is left exactly as supplied, so Phase 5 behaviour on over-discounted lines is untouched.

**Best applicable only, deterministically.** Evaluation is per line; the largest discount wins, ties breaking by **most specific target (VARIANT > PRODUCT > CATEGORY) → earliest `validFrom` → lowest promotion id**. Only the first criterion decides money; the rest merely decide which of two equally valuable promotions is recorded. Different lines of one sale may legitimately carry different promotions; a single line carries at most one, enforced by the tenant-scoped unique `(businessId, saleItemId, promotionId)`. A manual discount never enters the competition — it is not a promotion.

**Historical integrity.** `SalePromotionApplication` is append-only provenance carrying the promotion's name and type **at the time of sale** plus a `ruleSnapshot` with every parameter the calculation used, so the original arithmetic reproduces without reading the live rule. A test renames a promotion, moves its window into 2091 and deactivates it, then confirms the completed sale's `discountAmount`, line discount and snapshot are all unmoved. Type, target and parameters are **not editable** — a different rule is a different promotion — and promotions are deactivated, never deleted.

**Validity** is stored as half-open `[validFrom, validTo)` instants. Callers supply `YYYY-MM-DD` calendar dates, resolved in `Business.timezone` through the **same helper Phase 7 reporting uses** (extracted to `common/domain/business-timezone.ts` so there is one implementation, not two). An inclusive `validTo` of 31 March becomes the exclusive instant at the start of 1 April local time, so the final day is covered exactly once.

### Phase 8E — Sales Integration, BD-12, and the closure of Known Issue #47

**BD-12 — the manual discount is capped at line gross, universally.** `discountAmount` had no upper bound and the only database guard was `line_total >= 0`, so with tax on the line a discount could legitimately exceed the gross. After Phase 8C's BD-1 correction that turned harmful: `merchandiseValue = gross − discount` went negative, the cumulative return credit went negative, and the customer returning the goods was **silently credited nothing** while the stock came back, with clawback and restoration both clamping to zero. `capManualDiscount` now makes `finalDiscount ≤ lineGross` true on every line — the identity for any well-formed sale, and generalising the rule already approved for promoted lines in BD-11.

**BD-13 — serial capture is mandatory, and #47 is closed.** `CreateSaleUseCase` never passed `serials` to `consumeVariant`, so selling a serial-tracked variant marked no unit `SOLD` and stored no link. A sale line for a serial-tracked variant now **must** name its units, the count must equal the quantity, the units are consumed through `InventoryEngine` exactly as before, and the append-only **`SaleItemSerial`** records which physical unit left on which line. Whether serials are required is decided by the product's own tracking flag, never by the request — a client can neither opt out by omitting the field nor smuggle serials onto a line whose product does not track them.

`RegisterWarrantyUseCase` now verifies the serial was **actually sold on that sale line**. A genuine, in-tenant, same-variant serial that was never on the line is rejected — the case that previously passed every available check.

**BD-14 — returned serials go to quarantine.** A serial-tracked return must name the exact units coming back (a partial return of a multi-serial line is otherwise ambiguous), and they transition `SOLD → RETURNED`, never straight to `IN_STOCK`: a physical item coming back over the counter is not automatically known to be sellable. The intended lifecycle is `SOLD → RETURNED → (future inspection) → IN_STOCK or DAMAGED`; **no inspection workflow was built**. A unit cannot be returned twice, and cannot be returned against a line that never sold it. `SaleReturnItemSerial` records which return brought back which unit.

**BD-15 — warranties auto-void on return.** Any warranty still covering a returned unit transitions to `VOID` atomically with the return. The warranty row is never deleted and its snapshotted dates are never rewritten — only the approved status transition occurs — and a claim against it is rejected.

**Concurrency was genuinely holed and is now closed.** `consumeSerialsForSale` did a read-then-write with no lock, so two simultaneous sales could each see the same unit as `IN_STOCK` and both sell it. Serial rows are now taken with `SELECT … FOR UPDATE` in deterministic `id` order, and consumption runs **after** `applyMovement` so the lock sequence matches the canonical order. `serial_numbers` already carried the `UPDATE` privilege from Phase 3, so no grant change was needed.

## Pending Features
Everything from Phase 8F onward (Advanced/Promotions/Loyalty, Security & Reliability hardening, Production).

Deliberately out of Phase 8E scope (approved constraints, none of them worked around):
- **No inspection workflow** — `RETURNED` is the terminal state Phase 8E writes; releasing a unit back to `IN_STOCK` or `DAMAGED` is future work.
- **No replacement or refund workflow** on the warranty side; warranties remain record-keeping only.
- **No Accounting or Inventory redesign** — both engines remain the sole authorities and neither was modified.
- **No new promotion or loyalty rule**; the approved ordering is unchanged.
- **Known Issue #29 untouched** — the promotion base price is still the caller-supplied `unitPrice`.
- **No Phase 1-7 refactor** beyond the behaviour-preserving serial reorder required by the mandated lock order.

Deliberately out of Phase 8D scope (approved constraints, none of them worked around):
- **Threshold / basket-spend and basket-wide promotions** — no promotion in scope is triggered by the composition or total of the basket.
- **Promotion stacking** — best applicable only, one promotion per line.
- **Quotas, usage limits, first-N-customer quotas, per-customer limits, global counters** — with none of these, promotion resolution needs no counter and therefore no lock.
- **Customer-specific pricing, `Customer.priceListId`, pricing tiers, branch-scoped promotions** — promotions are tenant-wide.
- **Bundle-promotion expansion, Tax Engine, Phase 6 accounting refactor, Known Issue #47, Known Issue #29.**
- **No promotion-application endpoint** — resolution is server-side inside `CreateSaleUseCase` only, so a client can never supply promotional pricing.
- **`CreateSaleReturnUseCase` was not modified** — see Return Semantics below.

Deliberately out of Phase 8C scope (approved constraints, none of them worked around):
- **Promotions / PromotionEngine** (8D) — no `Promotion` model, no `SalePromotionApplication`.
- **Warranty, Tax Engine, loyalty expiry, GL loyalty liability, Phase 6 accounting redesign, bundle promotion behaviour** — all untouched.
- **Known Issue #47** — no serial capture on sale lines and no workaround; still an 8E dependency.
- No redemption **endpoint**: redemption is a `redeemPoints` field on `POST /sales`, so it is atomic with the sale and inside the sale's idempotency by construction.
- No new permission — redemption at the till is gated by the existing `sales.create`.

Deliberately out of Phase 8B scope (approved constraints, none of them worked around):
- **Redemption** (8C) — no redemption endpoint, no conversion rate, no proportional BD-2 allocation. `REDEEM` rows are unreachable in 8B.
- **Promotions** (8D) — no `Promotion` model, no `SalePromotionApplication`.
- **Sales integration** (8E) — `CreateSaleUseCase` and `CreateSaleReturnUseCase` were not modified; no sale earns or spends points yet, so `EARN` rows are likewise unreachable outside a direct test insert.
- **Return clawback** (8C) — the §6.2 clawback formula was deliberately **not** implemented in 8B even as an unwired helper. `RETURN_CLAWBACK` exists in the enum (it is part of the approved ledger data model) but has no writer until 8C. Three of the four event types being reachable only from later phases is the approved phase split working as intended, not an oversight.
- **Accounting** — no Loyalty Liability account, no GL mapping, no journal entry, no Phase 6 refactor. Asserted by test.
- **Expiry / scheduler** — none, per the approved decision.
- **Loyalty reporting** — Phase 7's `/reports/*` layer was not extended.

Deliberately out of Phase 8A scope (approved constraints, none of them worked around):
- **Loyalty** (`CustomerPoints`, earn/redeem/clawback) and **Promotions** — Phase 8B/8C onward, untouched.
- **Sales integration** — `CreateSaleUseCase` was not modified *by 8A*; no warranty is auto-created at sale time, and at that time no serial was captured on a sale line (Known Issue #47, **since closed by Phase 8E** — serial capture now exists; warranty auto-creation at sale time still does not).
- **Accounting** — no warranty provision/liability account, no posting of any kind. `AccountingEngineService` is not injected anywhere in the module.
- **Inventory** — no replacement unit, no automatic stock adjustment, no serial status change. `InventoryEngineService` is not injected anywhere in the module.
- No background job to expire warranties (expiry is derived on read instead).
- No warranty reporting endpoints under `/reports/*` (Phase 7's layer was not extended).
- No BD-1 sale-return effective-unit-price fix — that is an approved Phase 8B/8C item, deliberately not smuggled into 8A.

Deliberately out of Phase 6 scope (see Known Issues for the reasoning on each):
- `FinancialAccount`/`CashRegister`/`CashTransaction`, `Expense`/`ExpenseCategory`/`RecurringExpense` (explicit scope decisions above).
- Historical backfill of Phase 1-5's pre-existing transactions into the GL.
- Manual/adjusting journal entry creation (no HTTP endpoint - `DRAFT` status is unreachable in v1).
- Branch-level Chart of Accounts / GL hierarchy.
- Income Statement, Balance Sheet, Cash Flow, financial exports, dashboards (Phase 7 territory).
- `STOCK_COUNT`-movement accounting posting (only `AdjustStockUseCase`'s five types are wired).
- Tax rate configuration/computation (the existing `taxAmount` columns are posted as-is to Tax Payable; no tax engine).

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

### Phase 6 architecture decisions

- **`AccountingEngineService.postEntry`/`.reverseEntry` are the ONLY interface that ever creates a `JournalEntry`** - verified by grep: the only callers are the 7 Sales/Purchasing/Inventory use-cases listed above and `ReverseJournalEntryUseCase`. No use-case ever inserts into `journal_entries`/`journal_entry_lines` directly.
- **Zero-value sub-lines are always skipped in matched pairs, never posted or force-balanced with a fake line** - proven mathematically in `sale-journal-lines.ts`'s own doc comment: since `payments + remaining ≡ totalAmount ≡ netRevenue + tax` and `cost ≡ cost` by construction (both sides of each sub-group are literally the same underlying value, just resolved into different accounts), a zero on one side always implies zero on the matching side, so omitting a zero line never unbalances the entry. A fully-discounted, zero-cost sale posts nothing at all rather than an artificial 0/0 entry.
- **COGS is sourced exclusively from `computeSaleCost`/`StockMovement.unitCostAtMovement`/`applyMovement`'s own return value** - never recomputed, never a second valuation engine. `CreateSaleUseCase` calls `computeSaleCost` (Phase 5's own helper, unchanged) AFTER `consumeVariant` has already written the SALE/BUNDLE_CONSUMPTION movements in the same transaction - Postgres's own read-your-writes semantics within one transaction make this safe without any special-casing.
- **Purchase's accounting posting uses the exact `totalReceivedValue` `SupplierTransaction` already posts** (SUM(quantityReceived × unitCost), never `Purchase.totalAmount`, which includes tax/discount that the existing supplier ledger never accounted for either) - a deliberate consistency choice: Phase 6 mirrors whatever Purchasing's own ledger already does, rather than "fixing" a pre-existing Purchasing-scope question that isn't Phase 6's to resolve.
- **A walk-in `SaleReturn` posts an accurate Inventory/COGS correction but NO Revenue/AR reversal** - Phase 5's `CreateSaleReturnUseCase` posts zero `CustomerTransaction` rows for a walk-in return (no customer to credit) and records no cash-refund event at all. Accounting has no operational fact to build a Cash-credit line from without inventing one, so it deliberately doesn't - stated and tested explicitly (see Known Issues #32), not silently gapped.
- **`JournalEntryStatus.REVERSED` is never written** - reversal status is always a DERIVED fact (`EXISTS (SELECT 1 FROM journal_entries WHERE reversal_of_id = X)`), keeping `journal_entries` genuinely append-only (SELECT+INSERT only, no UPDATE grant at all - stricter than even `sales`, which needed a locking-only UPDATE grant in Phase 5). The duplicate-reversal guard is a DB-enforced `(business_id, reversal_of_id)` unique index, the same nullable-opt-in-unique pattern every `idempotencyKey` column in this schema already uses.
- **`FiscalPeriod` resolution and locking happens INSIDE `postEntry` itself** (`SELECT ... FOR UPDATE` on the period row covering `entryDate`), not by the caller - this is what makes the "period-close vs posting" concurrency guarantee real: `ClosePeriodUseCase`/`ReopenPeriodUseCase` lock the exact same row before flipping status, so the two operations always serialize correctly regardless of which one a client's request happens to reach first (proven by a real concurrent-request test, not just argued).
- **Open-period overlap-checking only considers OTHER OPEN periods** - a bug found and fixed during this phase's own test-writing (see Known Issues #34): checking against ANY period regardless of status would have permanently blocked opening a new period once the bootstrap period was ever closed, since its far-future end date would "occupy" every future date forever even after closing.

## Database Changes
**Phase 5**: 8 new Prisma models: `Customer`, `CustomerTransaction`, `Shift`, `Sale`, `SaleItem`, `SalePayment`, `SaleReturn`, `SaleReturnItem`. New enums: `SaleStatus` (single-value, `COMPLETED` - see Architecture Decisions), `CustomerTransactionType` (`SALE`/`SALE_RETURN`/`PAYMENT`/`OPENING_BALANCE`/`ADJUSTMENT`), `SalePaymentMethod` (`CASH`/`CARD`/`WALLET`/`OTHER`), `SaleReturnCondition` (`SELLABLE`/`DAMAGED`), `ShiftStatus` (`OPEN`/`CLOSED`). `StockMovementType.SALE`/`SALES_RETURN`/`DAMAGE`/`BUNDLE_CONSUMPTION` already existed from Phase 3 and are reused as-is - no new movement types needed. Every new table carries its own `businessId` for direct RLS scoping.

11 new global permission codes: `customers.{view,create,edit,delete}`, `sales.{view,create,return,pay}`, `shifts.{view,open,close}` (84 permissions total after Phase 5).

**Phase 6**: 5 new Prisma models: `Account`, `FiscalPeriod`, `AccountingMappingRule`, `JournalEntry`, `JournalEntryLine`. New enums: `AccountType` (`ASSET`/`LIABILITY`/`EQUITY`/`REVENUE`/`EXPENSE`), `NormalBalance` (`DEBIT`/`CREDIT`), `JournalEntryStatus` (`DRAFT`/`POSTED`/`REVERSED` - only `POSTED` is ever actually written, see Architecture Decisions), `FiscalPeriodStatus` (`OPEN`/`CLOSED`), `AccountingMappingKey` (15 members: `SALES_REVENUE`, `COGS`, `INVENTORY_ASSET`, `ACCOUNTS_RECEIVABLE`, `ACCOUNTS_PAYABLE`, `TAX_PAYABLE`, `INVENTORY_SHRINKAGE`, `INVENTORY_GAIN`, `INTERNAL_CONSUMPTION_EXPENSE`, `TENDER_CASH`/`CARD`/`WALLET`/`BANK_TRANSFER`/`CHEQUE`/`OTHER_TENDER`). Every new table carries its own `businessId` for direct RLS scoping.

8 new global permission codes: `accounting.accounts.{view,create,edit,delete}`, `accounting.journal.{view,reverse}`, `accounting.periods.manage`, `accounting.reopen_period` (92 permissions total now).

**Phase 7**: no new models and no new tables — 5 `@@index` entries only. 5 new permission codes (97 total).

**Phase 8A**: 2 new Prisma models: `Warranty`, `WarrantyClaim`. New enums: `WarrantyStatus` (`ACTIVE`/`EXPIRED`/`CLAIMED`/`VOID` — all four reachable, see Lifecycle above), `WarrantyClaimStatus` (`OPEN`/`RESOLVED`/`REJECTED` — exactly the three approved). Both tables carry their own `businessId` for direct RLS scoping. `Warranty` has a tenant-scoped unique constraint `(business_id, sale_item_id, serial_number_id)`. FK posture: `business_id` CASCADEs (a deleted business takes its own rows), every other FK is `RESTRICT` — a `SaleItem`, `SerialNumber` or `Customer` referenced by a warranty can never be silently deleted out from under its warranty history. **No new configuration table** — the default duration reuses Phase 1's `Setting`.

3 new global permission codes: `warranty.{view,register,claim}` (**100 permissions total now**).

**Phase 8B**: 1 new Prisma model: `CustomerPoints`. New enum: `CustomerPointsType` (`EARN`/`REDEEM`/`RETURN_CLAWBACK`/`ADJUSTMENT`). Carries its own `businessId` for direct RLS scoping, plus a tenant-scoped unique `(business_id, idempotency_key)`. FK posture: `business_id` CASCADEs, `customer_id` is `RESTRICT` — a customer with point history can never be deleted out from under it. **No new configuration table** (the earning rate reuses `Setting`) and **no new column on `Customer`** — there is deliberately no stored balance.

2 new global permission codes: `loyalty.view`, `loyalty.adjust` (**102 permissions total now**).

**Phase 8C**: no new model and no new table. One new `CustomerPointsType` value (`REDEMPTION_RESTORATION`), one extended CHECK, one partial unique index. **No column was added to `Sale`, `SaleItem` or `SaleReturn`** — restoration is driven off the sale-level ratio `C/B` precisely so no per-line loyalty split needs storing, and `redeemPoints` is recorded by the REDEEM ledger row rather than duplicated onto the Sale. No new permission code (102 total, unchanged).

**Phase 8D**: 2 new Prisma models: `Promotion` (mutable config) and `SalePromotionApplication` (append-only provenance). New enums: `PromotionType` (`PERCENTAGE`/`FIXED_AMOUNT`/`BUY_X_GET_Y` — exactly the three approved), `PromotionTargetType` (`PRODUCT`/`VARIANT`/`CATEGORY`). Both tables carry their own `businessId`. Tenant-scoped unique `(business_id, sale_item_id, promotion_id)`. **No column added to `Sale`, `SaleItem` or `SaleReturn`.**

`Promotion.targetId` is deliberately **not** a foreign key: one column cannot reference three different tables, and three nullable FKs would let a row target two things at once. Existence is validated in the application against the caller's own tenant before the row is written, and a cross-tenant target returns 404 (tested).

4 new global permission codes: `promotions.{view,create,edit,deactivate}` (**106 permissions total now**).

**Phase 8E**: 2 new Prisma models, both append-only link tables: **`SaleItemSerial`** (which physical unit left on which sale line) and **`SaleReturnItemSerial`** (which unit came back on which return line). No new enum, no new permission (106 unchanged), and **no column added to `Sale`, `SaleItem`, `SaleReturn` or `SerialNumber`**.

Link *tables* rather than a `saleItemId` column on `SerialNumber`, deliberately: a serial can be sold, returned and sold again, and a single column would overwrite that history on every resale. `SaleReturnItemSerial` exists for two reasons — traceability (`status = RETURNED` says a unit came back but not which return brought it) and idempotency (returned serials are client-supplied, so a replayed key carrying different units must be rejected, which needs the originals to compare against).

## Migrations
**Phase 5**:
1. `20260829112729_sales_schema` - the 8 tables/5 enums above, plus hand-written `CHECK` constraints: non-zero `amount` on `customer_transactions`; `closed_at >= opened_at` on `shifts`; non-negative subtotal/discount/tax/total on `sales`; positive quantity, non-negative price/discount/tax/line-total/quantity-returned, and **`quantity_returned <= quantity`** on `sale_items`; positive quantity + non-negative price on `sale_return_items`; positive `amount` on `sale_payments`. Plus a **partial unique index** `shifts_one_open_per_user (business_id, opened_by) WHERE status = 'OPEN'` - the database-level guarantee behind the "one open shift per user" invariant, not just an application pre-check.
2. `20260829112800_sales_rls` - RLS on all 8 tables, same default-deny pattern as every prior phase.
3. `20260829112900_sales_app_role_grants` - extends `erp_app`: `customers`/`shifts`/`sale_items` get SELECT+INSERT+UPDATE (genuine in-place mutation - contact details, OPEN→CLOSED transition, the `quantity_returned` running total); everything else (`customer_transactions`, `sales`, `sale_payments`, `sale_returns`, `sale_return_items`) gets SELECT+INSERT only - true event records. Notably, unlike Purchasing, **nothing in Sales needs a DELETE grant at all**, since there is no DRAFT-edit lifecycle for a Sale (it's created already-complete).
4. `20260829130000_sales_lock_update_grant` - a correction found **during e2e testing, not by re-reading the grants migration**: PostgreSQL requires the `UPDATE` privilege (not just `SELECT`) to execute `SELECT ... FOR UPDATE`, which `lockSale` (used by `CreateSaleReturnUseCase`/`CreateSalePaymentUseCase`) does against `sales`. The original grants migration withheld `UPDATE` reasoning "nothing content-updates a Sale row," which is still true and still the design intent - but too narrow, since Postgres treats row-locking itself as write-intent regardless of whether a write follows. Fixed via a small, explained follow-up migration (the exact same "narrow, explained follow-up" pattern as Phase 4's `purchase_items_delete_grant`), reverified live: the failing e2e test (a real `permission denied for table sales` Postgres error, not a guess) now passes.

**Phase 6**:
5. `20260829123435_accounting_schema` - the 5 tables/5 enums above, plus hand-written additions: `CHECK (parent_account_id IS NULL OR parent_account_id <> id)` on `accounts`; `CHECK (end_date > start_date)` on `fiscal_periods`; `CHECK (debit >= 0)`, `CHECK (credit >= 0)`, and **`CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))`** on `journal_entry_lines` (the row-level half of the double-entry invariant); three unique constraints on `journal_entries` - `(business_id, source_type, source_id)` (the duplicate-posting backstop), `(business_id, entry_number)`, `(business_id, reversal_of_id)` (the duplicate-reversal backstop, nullable-opt-in, same pattern as every `idempotencyKey`); and a hand-written **`DEFERRABLE INITIALLY DEFERRED` constraint trigger** (`check_journal_entry_balanced()`) re-verifying `SUM(debit) = SUM(credit)` per `journal_entry_id` at transaction-commit time - the aggregate half of the double-entry invariant, which a plain `CHECK` cannot express since Postgres `CHECK` constraints cannot reference other rows.
6. `20260829123500_accounting_rls` - RLS on all 5 tables, same default-deny pattern as every prior phase.
7. `20260829123600_accounting_app_role_grants` - extends `erp_app`: `accounts`/`fiscal_periods` get SELECT+INSERT+UPDATE (`accounts` for rename/deactivate; `fiscal_periods` for OPEN↔CLOSED transitions AND because `postEntry`/`ClosePeriodUseCase`/`ReopenPeriodUseCase` all take `SELECT ... FOR UPDATE` on it - the Phase 5 `sales`-table lesson applied UP FRONT this time, not discovered live again); `accounting_mapping_rules`/`journal_entries`/`journal_entry_lines` get SELECT+INSERT only - `journal_entries`/`journal_entry_lines` are genuinely append-only with **no locking-only UPDATE grant either**, since nothing ever locks them (the reversal race is closed by the unique index, not a row lock).

**Phase 7**:
8. `20260829140000_reporting_indexes` - five `@@index` entries only; no tables, views, materialized views or grants.

**Phase 8A**:
9. `20260829165055_warranty_schema` — the 2 tables/2 enums above, plus hand-written `CHECK` constraints: `duration_days > 0`; `duration_days <= 36500` (**technical timestamp-overflow bound, explicitly NOT a business maximum** — a comment in the migration says so, because Phase 0 defines no maximum and inventing one was forbidden); `end_date > start_date`; a non-empty trimmed claim `description`; and `warranty_claims_resolution_audit_consistent` — `(status = 'OPEN' AND resolved_at IS NULL AND resolved_by IS NULL) OR (status <> 'OPEN' AND resolved_at IS NOT NULL)`, so a resolved claim can never exist without its audit trail and an OPEN claim can never carry one.
10. `20260829165100_warranty_rls` — RLS **and FORCE RLS** on both tables with `<table>_tenant_isolation` policies (`USING` + `WITH CHECK` on `business_id = current_setting('app.current_tenant_id', true)`), identical default-deny pattern to every prior phase.
11. `20260829165200_warranty_app_role_grants` — `erp_app` gets `SELECT, INSERT, UPDATE` on both tables and **no DELETE**. `UPDATE` is for genuine status transitions only (ACTIVE→CLAIMED/VOID, OPEN→RESOLVED/REJECTED); the migration notes explicitly that neither table is row-locked, so this is not a `FOR UPDATE` support grant.

**Phase 8B**:
12. `20260829220846_loyalty_ledger_schema` — the `customer_points` table + `CustomerPointsType` enum, plus hand-written `CHECK` constraints: `customer_points_nonzero` (`points <> 0` — a zero-point event carries no information in a ledger whose whole purpose is `SUM(points)`); `customer_points_sign_matches_type` (EARN `> 0`, REDEEM `< 0`, RETURN_CLAWBACK `< 0`, ADJUSTMENT either — **not a new business rule**, but the database enforcing the meaning the approved policy already gives each type, so a positive REDEEM that would silently *raise* a balance is unrepresentable); `customer_points_snapshot_complete` (`basis_amount`/`rate_snapshot` all-or-nothing, since a row with one but not the other could not reproduce its own arithmetic); `customer_points_rate_positive`.
13. `20260829220900_loyalty_ledger_rls` — RLS **and FORCE RLS** with the `customer_points_tenant_isolation` policy (`USING` + `WITH CHECK`), identical default-deny pattern to every prior phase.
14. `20260829221000_loyalty_ledger_app_role_grants` — `erp_app` gets **`SELECT, INSERT` only**: no UPDATE, no DELETE, at all. This is the strictest grant in the system alongside Phase 6's `journal_entries`, and it is what makes append-only a **database** guarantee rather than an application convention. No locking-only UPDATE grant was needed either (the Phase 5 `sales` lesson applied up front for the third phase running): the serialization point for a balance is the **`customers`** row — which already carries the UPDATE grant from Phase 5 — because a row lock on existing ledger rows cannot block the INSERT of a new one, which is exactly the race that matters.

**Phase 8C**:
15. `20260829232515_loyalty_redemption_restoration` — adds the `REDEMPTION_RESTORATION` enum value.
16. `20260829232600_loyalty_redemption_constraints` — **deliberately a separate migration**: PostgreSQL forbids *using* a newly added enum value in the transaction that added it, and Prisma runs each migration file in its own transaction, so splitting them is what makes the CHECK below legal. Extends `customer_points_sign_matches_type` with `REDEMPTION_RESTORATION AND points > 0` (the new value would otherwise be the only type whose sign the database did not police), and adds the partial unique index **`customer_points_one_event_per_source`** on `(business_id, reference_type, reference_id, type) WHERE reference_type IS NOT NULL`. That index is the real duplicate-event backstop for machine-generated rows: `Sale.idempotencyKey` is OPTIONAL, so a sale created without one produces ledger rows with a NULL key, and PostgreSQL permits unlimited NULLs in a UNIQUE index. It guarantees **one Sale → at most one EARN and one REDEEM; one SaleReturn → at most one RETURN_CLAWBACK and one REDEMPTION_RESTORATION**, the same role `journal_entries (business_id, source_type, source_id)` plays for double-posting.

**Phase 8D**:
17. `20260830111403_promotions_schema` — the 2 tables/2 enums above, plus hand-written CHECKs: **`promotions_parameters_match_type`** (exactly one parameter set per type, everything else NULL — without it a row could carry a percentage AND a buy/get pair, and which one won would depend on code order rather than data); `0 < percentage_value <= 100`; `fixed_amount > 0`; `buy_quantity > 0` and `get_quantity > 0`; `valid_to > valid_from`; a non-empty trimmed name; and `discount_applied > 0` on applications, so a stored application always represents real money.
18. `20260830111500_promotions_rls` — RLS **and FORCE RLS** on both tables with `<table>_tenant_isolation` policies (`USING` + `WITH CHECK`).
19. `20260830111600_promotions_app_role_grants` — `promotions` gets `SELECT, INSERT, UPDATE` (config is genuinely edited and deactivated in place) and **no DELETE**; `sale_promotion_applications` gets **`SELECT, INSERT` only**, the same strictest grant as `customer_points` and `journal_entries`. Neither table is ever row-locked — promotion resolution is a pure read inside the sale's existing transaction, and with quotas deferred there is no counter to contend on — so neither needs a locking-only UPDATE grant (the Phase 5 `sales` lesson applied up front for the fourth phase running).

**Phase 8E**:
20. `20260830114626_sale_item_serials` — the `sale_item_serials` table with a tenant-scoped unique `(business_id, sale_item_id, serial_number_id)`; `serial_number_id` is `RESTRICT` so a unit with sale history can never be deleted.
21. `20260830114700_sale_item_serials_rls` — RLS **and FORCE RLS** with the tenant-isolation policy.
22. `20260830114800_sale_item_serials_grants` — **`SELECT, INSERT` only**. "This unit left on this sale line" is a permanent fact that stays true even after the unit is returned; the return is recorded by the serial's own status transition and the SaleReturn document, never by erasing the sale record.
23. `20260830115323_sale_return_item_serials` + `20260830121000_sale_return_item_serials_rls_grants` — the return-direction mirror, same append-only posture, same RLS.

No grant was added to `serial_numbers`: it has carried `SELECT, INSERT, UPDATE` since Phase 3, and PostgreSQL requires exactly `UPDATE` for `SELECT … FOR UPDATE`, so the new row locking needed nothing.

Applied and verified against both `erp_dev` and `erp_test` (`prisma migrate status`: both "up to date", **22 migrations total** across all six phases). Verified directly via SQL, not just assumed:
- `pg_class.relrowsecurity`/`relforcerowsecurity` = true on all 5 new Phase 6 tables.
- `information_schema.role_table_grants` for `erp_app` matches the design exactly: `accounts`/`fiscal_periods` → `INSERT,SELECT,UPDATE`; `accounting_mapping_rules`/`journal_entries`/`journal_entry_lines` → `INSERT,SELECT`.
- `SELECT ... FOR UPDATE` against `fiscal_periods` succeeds as `erp_app` (no permission-denied error).
- An unfiltered `SELECT * FROM accounts`/`journal_entries` as `erp_app` with no tenant context returns zero rows; a cross-tenant raw `INSERT` is rejected by RLS `WITH CHECK`.
- The deferred balance trigger verified firing correctly via a direct raw-SQL insert of unbalanced lines as `erp_app` (reproduced independently via plain `psql` outside the test harness too - see Known Issues #35 for a Prisma-client-specific quirk found while writing this test, unrelated to the trigger's own correctness).
- `erp_app` has no UPDATE/DELETE privilege on `journal_entries`/`journal_entry_lines` - verified via a direct-connection UPDATE/DELETE rejection test.

**Phase 8A migration verification** — run as direct SQL against **both** `erp_dev` and `erp_test`, not assumed (**26 migrations total** across all phases, `migrate deploy` reporting no pending migrations on either database):
- `pg_class.relrowsecurity` **and** `relforcerowsecurity` = `true` on `warranties` and `warranty_claims`.
- `pg_policies` shows `warranties_tenant_isolation` and `warranty_claims_tenant_isolation`.
- `information_schema.role_table_grants` for `erp_app` = `INSERT,SELECT,UPDATE` on both tables, **no DELETE**.
- All 5 hand-written CHECK constraints present in `pg_constraint` on both databases.
- Both databases re-seeded: **100 permissions** each, warranty codes backfilled onto existing `BUSINESS_OWNER` roles.

**Phase 8B migration verification** — run as direct SQL against **both** `erp_dev` and `erp_test`, not assumed (**29 migrations total**, `migrate deploy` reporting no pending migrations on either database):
- `pg_class.relrowsecurity` **and** `relforcerowsecurity` = `true` on `customer_points`.
- `pg_policies` shows `customer_points_tenant_isolation`.
- `information_schema.role_table_grants` for `erp_app` = exactly `INSERT, SELECT` — **no UPDATE, no DELETE** (also asserted by an e2e test, and by a direct-connection UPDATE/DELETE rejection test that confirms the row is unchanged afterwards).
- All 4 hand-written CHECK constraints present in `pg_constraint` on both databases.
- Both databases re-seeded: **102 permissions** each, loyalty codes backfilled onto existing `BUSINESS_OWNER` roles.

**Phase 8C migration verification** — direct SQL against **both** `erp_dev` and `erp_test` (**31 migrations total**, none pending on either):
- `pg_enum` lists all five `CustomerPointsType` values including `REDEMPTION_RESTORATION`.
- `customer_points_one_event_per_source` present in `pg_indexes`.
- All four CHECK constraints present, with the sign constraint covering the new value.
- Grants unchanged and still exactly `INSERT, SELECT` — **8C added no privilege**; RLS and FORCE RLS both still `true`.

**Phase 8D migration verification** — direct SQL against **both** `erp_dev` and `erp_test` (**34 migrations total**, none pending on either):
- `relrowsecurity` **and** `relforcerowsecurity` = `true` on `promotions` and `sale_promotion_applications`.
- Both `_tenant_isolation` policies present in `pg_policies`.
- `erp_app` grants read exactly `INSERT,SELECT,UPDATE` on `promotions` and `INSERT,SELECT` on `sale_promotion_applications`.
- All 7 hand-written CHECK constraints present, plus the tenant-scoped unique index.
- Both databases re-seeded: **106 permissions** each, promotion codes backfilled onto existing `BUSINESS_OWNER` roles.

**Phase 8E migration verification** — direct SQL against **both** `erp_dev` and `erp_test`, with `prisma migrate status` reporting "up to date" on each:
- `relrowsecurity` **and** `relforcerowsecurity` = `true` on `sale_item_serials` and `sale_return_item_serials`.
- Both `_tenant_isolation` policies present.
- `erp_app` grants read exactly `INSERT,SELECT` on both — asserted by an e2e test as well as by `information_schema`.
- Both tenant-scoped unique indexes present. Permission count unchanged at 106.

## API Endpoints
All Phase 5 endpoints under `/api/v1/sales`, same `{ data }` / `{ error }` envelope (list endpoints also return `pagination`).

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

All new Phase 6 endpoints under `/api/v1/accounting`, same envelope:

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/accounting/accounts` | `accounting.accounts.view` / `.create` |
| PATCH | `/accounting/accounts/:id` | `accounting.accounts.edit` (rename only) |
| DELETE | `/accounting/accounts/:id` | `accounting.accounts.delete` (deactivate; rejected for system accounts) |
| GET | `/accounting/accounts/:id/balance` | `accounting.journal.view` |
| GET | `/accounting/journal-entries` | `accounting.journal.view` |
| GET | `/accounting/journal-entries/trial-balance` | `accounting.journal.view` |
| GET | `/accounting/journal-entries/:id` | `accounting.journal.view` |
| POST | `/accounting/journal-entries/:id/reverse` | `accounting.journal.reverse` |
| GET/POST | `/accounting/periods` | `accounting.journal.view` / `accounting.periods.manage` |
| POST | `/accounting/periods/:id/close` | `accounting.periods.manage` |
| POST | `/accounting/periods/:id/reopen` | `accounting.reopen_period` |

All request bodies/queries validated against shared zod schemas in `packages/shared-validation/src/accounting.ts`. Role-template grants: `BUSINESS_OWNER` gets everything (as always, including `accounting.reopen_period`). `ACCOUNTANT` gets the full accounting set EXCEPT `accounting.reopen_period` (reserved to the Owner by default, grantable explicitly). No other role template (`BRANCH_MANAGER`, `INVENTORY_MANAGER`, `CASHIER`, `SALES_EMPLOYEE`) gets any `accounting.*` code, per your explicit scope decision.

All new Phase 7 endpoints under `/api/v1/reports`, same envelope. All are **GET only** — the reporting layer exposes no mutating verb at all:

| Method | Path | Permission |
|---|---|---|
| GET | `/reports/dashboard` | `reports.dashboard.view` |
| GET | `/reports/sales/summary` | `reports.sales.view` |
| GET | `/reports/sales/by-product` · `by-category` · `by-branch` · `by-user` · `by-payment-method` | `reports.sales.view` |
| GET | `/reports/sales/returns` | `reports.sales.view` |
| GET | `/reports/purchasing/summary` | `reports.sales.view` |
| GET | `/reports/inventory/valuation` · `movements` · `damage-loss` · `slow-moving` | `reports.inventory.view` |
| GET | `/reports/financial/general-ledger` · `profit-and-loss` · `balance-sheet` · `receivables` · `payables` | `reports.financial.view` |
| GET | `/reports/reconciliation/inventory-ledger` | `reports.inventory.view` |
| GET | `/reports/reconciliation/customer-ar` · `supplier-ap` · `inventory-gl` | `reports.financial.view` |

Shared query params: `from`/`to` (optional, server-defaulted to the current month, resolved in the business timezone, always bounded), `branchId?` (validated against the caller's permitted branches), `page`/`limit` (max 200, matching every other list endpoint). Role-template grants: `BUSINESS_OWNER` everything; `ACCOUNTANT` all five reporting codes including `reports.view_profit`; `BRANCH_MANAGER` gets `reports.{sales,inventory,dashboard}.view` only — **deliberately not `reports.financial.view` and not `reports.view_profit`**; `INVENTORY_MANAGER`, `CASHIER` and `SALES_EMPLOYEE` get **no reporting permission at all**. `reports.export` was deliberately **not created**, since exports are deferred and a permission for a non-existent feature is misleading.

All new Phase 8A endpoints under `/api/v1/warranties`, same `{ data }` / `{ error }` envelope (the list endpoint also returns `pagination`). **Every route carries an explicit `@RequirePermissions`** — no warranty route is reachable on authentication alone:

| Method | Path | Permission |
|---|---|---|
| GET | `/warranties` | `warranty.view` |
| GET | `/warranties/:id` | `warranty.view` |
| POST | `/warranties` | `warranty.register` |
| POST | `/warranties/:id/void` | `warranty.register` |
| GET | `/warranties/:id/claims` | `warranty.view` |
| POST | `/warranties/:id/claims` | `warranty.claim` |
| POST | `/warranties/:id/claims/:claimId/resolve` | `warranty.claim` |

Claim routes are nested under their warranty so the parent is always resolved inside the caller's tenant before a claim is touched. List filters: `status`, `customerId`, `serialNumberId`, `page`/`limit` (max 200, matching every other list endpoint). All request bodies/queries validated against shared zod schemas in `packages/shared-validation/src/warranty.ts`.

Role-template grants: `BUSINESS_OWNER` everything (as always). `BRANCH_MANAGER` all three. `ACCOUNTANT` **`warranty.view` only** — visibility without operational authority. `CASHIER` all three: registering a warranty at the till and taking a claim over the counter are POS-floor actions, and **this does not breach the no-cost-visibility rule**, since a warranty carries no cost or profit field at all. `SALES_EMPLOYEE` gets `warranty.view` + `warranty.register` but deliberately **not** `warranty.claim` — deciding a claim is a supervisory act. `INVENTORY_MANAGER` gets none.

All new Phase 8B endpoints are nested under the customer they belong to, same `{ data }` / `{ error }` envelope (the ledger endpoint also returns `pagination`). **Every route carries an explicit `@RequirePermissions`**:

| Method | Path | Permission |
|---|---|---|
| GET | `/sales/customers/:customerId/points` | `loyalty.view` |
| GET | `/sales/customers/:customerId/points/ledger` | `loyalty.view` |
| POST | `/sales/customers/:customerId/points/adjust` | `loyalty.adjust` |

The parent customer is always resolved inside the caller's tenant first, so another business's customer id returns 404 rather than a zero balance. The balance endpoint returns the derived figure plus an explicit `derivation` string on the response itself, so a consumer cannot mistake it for a stored value. The ledger endpoint returns the customer's **whole** balance alongside the page, never the filtered page's subtotal — so nobody can accidentally derive a balance from one page of a paginated list. Ledger filters: `type`, `page`/`limit` (max 200). All bodies/queries validated against `packages/shared-validation/src/loyalty.ts`.

Role-template grants: `BUSINESS_OWNER` both. `ACCOUNTANT` **both** — a point correction is a value decision of the same kind as the customer-ledger corrections that role already owns. `BRANCH_MANAGER`, `CASHIER` and `SALES_EMPLOYEE` get **`loyalty.view` only** — a cashier must be able to tell a customer their balance at the till but must not be able to hand out points by hand. `INVENTORY_MANAGER` gets neither.

**Phase 8C added no endpoint and no permission.** Redemption is a `redeemPoints` field on the existing `POST /sales`, which is what makes it atomic with sale creation and part of the sale's own idempotency — a separate redemption endpoint would have required a committed redemption before the sale existed, which the approved design forbids. Clawback and restoration are automatic consequences of the existing `POST /sales/:id/returns`. Redemption at the till is gated by the existing `sales.create`; no `loyalty.*` permission is required to redeem, and `loyalty.adjust` remains Owner/Accountant-only.

All new Phase 8D endpoints under `/api/v1/promotions`, same `{ data }` / `{ error }` envelope (the list endpoint also returns `pagination`). **Configuration only — there is deliberately no route that applies a promotion to a sale**, so a client can never supply promotional pricing:

| Method | Path | Permission |
|---|---|---|
| GET | `/promotions` | `promotions.view` |
| GET | `/promotions/:id` | `promotions.view` |
| POST | `/promotions` | `promotions.create` |
| PATCH | `/promotions/:id` | `promotions.edit` (name / window / active flag only) |
| DELETE | `/promotions/:id` | `promotions.deactivate` (deactivate, never delete) |

Validity is supplied as `YYYY-MM-DD` calendar dates, not instants: only the server knows the business timezone, so accepting an instant would let a caller in another zone silently shift when a promotion starts and ends. List filters: `type`, `targetType`, `isActive`, `page`/`limit` (max 200). Validated against `packages/shared-validation/src/promotions.ts`, whose discriminated union makes a wrong type/parameter combination unrepresentable at the boundary.

Role-template grants: `BUSINESS_OWNER` all four. `ACCOUNTANT`, `BRANCH_MANAGER`, `CASHIER`, `SALES_EMPLOYEE` get **`promotions.view` only** — a cashier must see why a price dropped but must not author the rule behind it. `INVENTORY_MANAGER` gets none. **Selling with a promotion applied requires no promotion permission at all** — resolution is server-side and gated by the existing `sales.create`.

**Phase 8E added no endpoint and no permission.** Two request fields were added, both client-supplied and both joining their document's idempotency fingerprint: `serials` on a sale item (**required** for a serial-tracked variant, rejected for others, count must equal quantity) and `serials` on a return item (same rules, for the units coming back). Serial capture is part of `sales.create`; serial return is part of `sales.return`.

## Screens
None (still backend-only - unchanged from Phases 1-5; still flagging this for your review).

## Tests and Results
**Phase 5**: E2E: 46 tests, 6 files (40 at initial implementation + 6 added during the release-gate review) - `sales-customers.e2e-spec.ts` (6), `sales-shifts.e2e-spec.ts` (5), `sales-lifecycle.e2e-spec.ts` (13), `sales-returns.e2e-spec.ts` (7), `sales-concurrency-and-isolation.e2e-spec.ts` (14, seven real-concurrency tests), `sales-wac-reconciliation.e2e-spec.ts` (1). See the prior revision of this file for the full per-test breakdown.

**Phase 6**: E2E: **26 new tests, 3 new files**, real NestJS app + real PostgreSQL `erp_test`, no mocks:
- `accounting-postings.e2e-spec.ts` (11) - exact Dr/Cr accounts and amounts for: a fully-paid walk-in sale (Cash/Revenue/Tax Payable/COGS/Inventory); a credit sale's Cash+AR split and a later payment's Tender/AR pair; a SELLABLE return's full Inventory/COGS/Revenue/AR reversal; a walk-in return's Inventory/COGS-only correction (no Revenue/AR line present at all); a DAMAGED return's two independent Inventory legs plus the Shrinkage write-off; a PurchaseReceipt's Inventory/AP pair matching `SupplierTransaction` exactly; **COGS ↔ `StockMovement.unit_cost_at_movement` reconciliation** (SUM of COGS journal lines for two sales of one variant equals SUM(quantity × unit_cost_at_movement) across its own SALE movements, delta-scoped to avoid cross-test pollution in the shared fixture); **Customer subledger ↔ AR reconciliation** and **Supplier subledger ↔ AP reconciliation** (both: `SUM(ledger.amount)` equals the GL account's own live balance); a DAMAGE inventory adjustment's Shrinkage/Inventory pair and a positive ADJUSTMENT's Inventory/Gain pair; the trial balance staying balanced after every posting above.
- `accounting-integrity.e2e-spec.ts` (12) - `AccountingEngineService.postEntry` rejecting an unbalanced set of lines and a malformed (both-or-neither debit/credit) line at the APPLICATION layer before any insert; the DEFERRED constraint trigger rejecting an unbalanced raw-SQL insert as `erp_app` at the DATABASE layer, bypassing the application entirely; `erp_app` having no UPDATE/DELETE privilege on `journal_entries`/`journal_entry_lines`; **reversal integrity** - a reversal's lines are the exact debit/credit mirror of the original, the original's own lines are re-read and confirmed byte-for-byte unchanged, and a second reversal of the same entry is rejected; RLS+FORCE RLS on all 5 tables verified live via `pg_class`; `erp_app` grants verified live via `information_schema.role_table_grants`; an unfiltered raw `SELECT` as `erp_app` with no tenant context returning zero rows; `SELECT ... FOR UPDATE` against `fiscal_periods` succeeding as `erp_app`; tenant isolation (API-layer 404 + DB-layer cross-tenant `INSERT` rejected by RLS `WITH CHECK`); a Cashier forbidden from every accounting route; an Accountant able to view/reverse but rejected from reopening a period (403, not granted `accounting.reopen_period`), with the Owner's own reopen succeeding.
- `accounting-concurrency.e2e-spec.ts` (3) - **DUPLICATE POSTING**: two truly simultaneous `POST /sales` with the same `idempotencyKey` (`Promise.all`, fired before either awaits) - exactly one succeeds, the DB unique constraint (not the app pre-check) resolves the race, and exactly one `JournalEntry` exists for that Sale; **CLOSED-PERIOD REJECTION + AUTHORIZED REOPEN** - closing the only open period blocks the next Sale (fully rolled back, zero trace, delta-verified), reopening (`accounting.reopen_period`) restores posting; **PERIOD-CLOSE vs POSTING CONCURRENCY** - a real concurrent Sale-creation and period-close (`Promise.all`) always leaves a consistent state (Sale count delta is exactly 0 or 1, never a partial result; if the Sale won, its `JournalEntry.fiscalPeriodId` correctly points at the period that was open at that instant), proven by `FiscalPeriod`-row locking inside both `postEntry` and `ClosePeriodUseCase`.
- **Unit**: no new unit tests needed - `AccountingEngineService`'s balance/line validation is exercised directly through the e2e suite (both success and failure paths, application AND database layers) rather than duplicated as isolated unit tests. Phase 1-5's 28 unit tests remain green.

**Phase 7**: E2E: **49 new tests, 5 new files**, real NestJS app + real PostgreSQL, no mocks:
- `reporting-isolation-and-permissions.e2e-spec.ts` (12) — written FIRST, before any report content existed, because a leaking or over-permissive reporting layer is a security defect: Cashier and Sales Employee forbidden from every reporting route; Accountant/Owner allowed; cost/profit keys **absent** (not null) for a Branch Manager; branch scoping (assigned sees own branch, **unassigned sees nothing**, unauthorized `branchId` → **403 not empty**, cross-tenant `branchId` → 404); tenant isolation (tenant B's report contains none of tenant A's sales); `from > to` rejected; empty period returns a valid zeroed report; the business timezone is used and echoed.
- `reporting-sales-purchasing.e2e-spec.ts` (9) — exact net-sales/COGS/gross-profit arithmetic cross-checked against an independent sum of movement rows; **historical COGS immutability** (a later cost change does not alter the already-reported period COGS); by-product/category/branch/user/payment-method all reconciling to the summary total; Uncategorized bucket present; returns report surfacing the walk-in GL divergence note; purchasing summary matching source documents with cost gated.
- `reporting-inventory.e2e-spec.ts` (7) — valuation equals `quantityOnHand × averageCost` and cross-checks against the balance table; **proven not to use `Product.defaultCost`** (which is 0 for the fixture); movements with historical cost, filterable; damage/loss valued at each movement's own cost; slow-moving includes the never-sold variant and excludes the just-sold one; full cost gating; **Low Stock endpoint asserted absent (404)**.
- `reporting-financial.e2e-spec.ts` (9) — GL lines one-sided per the double-entry invariant; P&L figures cross-checked against an independent journal-line sum; **all four P&L limitations asserted present on the response**; **Balance Sheet balances** and still balances after further activity; receivables/payables matching the append-only ledgers; **Cash Flow endpoint asserted absent (404)**; Branch Manager 403 on all five financial routes.
- `reporting-dashboard-reconciliation.e2e-spec.ts` (12) — KPIs cross-checked against source systems; expense/net-profit/cash/low-stock limitations asserted on the response and `totalExpenses`/`expenses` asserted **absent**; profit/cost KPI stripping; **zero dashboard tables asserted via `information_schema`**; all four reconciliations exact; **the STOCK_COUNT correction proven end-to-end** — a real approved stock count creates `ADJUSTMENT`/`referenceType='StockCount'` movements, `movementType='STOCK_COUNT'` rows are asserted to be **zero**, no journal entry exists for them, the exclusion is reported visibly, and the comparison still reconciles; permission boundaries; Cash Register reconciliation asserted absent (404).
- **Unit**: no new unit tests — reporting has no standalone algorithm worth isolating from the database; every calculation is verified end-to-end against real data, which is stronger. Phase 1-6's 28 unit tests remain green.
- Full regression: **271/271 e2e + 28/28 unit**, zero regressions from Phases 1-6, verified after every sub-phase (7A→7G) rather than only at the end.

**Phase 8A**: E2E: **35 new tests, 1 new file** (`warranty.e2e-spec.ts`), real NestJS app + real PostgreSQL `erp_test` with RLS/FORCE RLS active and the restricted `erp_app` runtime role. **No mocks** — tenant isolation, permission boundaries and record-keeping-only guarantees are security and integrity invariants, and a mock cannot prove them.
- **Registration / validation / serial-tracked enforcement (9)** — registers with the business default and snapshots it; coverage starts at the **SALE date** (compared against the `Sale.createdAt` row, not the response); a per-registration override wins over the default with `endDate` recomputed to match; a duplicate (saleItem, serial) is rejected 409; a **non serial-tracked** sale line is rejected 422; a serial belonging to a **different variant** is rejected 422; non-existent sale line and non-existent serial both 404; malformed input (bad uuid, `durationDays` of 0, -1 and 36501) all 422; and — the one that matters most — **with no override and no valid default configured, registration fails 422 rather than guessing**, while an explicit override still succeeds under the same missing-config conditions.
- **Duration snapshot / historical integrity (1)** — the business default is changed to `1` after a warranty was issued at `365`; the stored row's `durationDays`, `startDate` and `endDate` are all re-read and confirmed unmoved, and the API read model still reports `365`/`ACTIVE`. Coverage is provably not recomputed from current configuration.
- **Expiry and eligibility (2)** — an elapsed warranty reads `status: ACTIVE` (stored, untouched) but `effectiveStatus: EXPIRED` (derived), and a claim against it is rejected 409; the interval is proven **half-open** — `endDate` exactly now already reads EXPIRED.
- **Claim lifecycle (8)** — a claim registers OPEN with null `resolvedAt`/`resolvedBy` and flips the warranty to CLAIMED while changing **no** coverage fact; an empty/whitespace description is rejected 422; a **second claim in the same coverage period is allowed**; resolution records `resolvedAt` and the correct `resolvedBy`; re-transitioning a resolved claim is rejected 409 (**one-way**); `OPEN`/`CLOSED`/`PENDING` as a resolve status are all rejected 422; `claimedAt`/`description`/`createdBy` are re-read from the DB after resolution and confirmed unchanged; and **the database itself refuses** a resolved claim with a nulled audit trail — a raw `UPDATE` as the owner connection is rejected by `warranty_claims_resolution_audit_consistent`.
- **Void (1)** — voiding sets VOID, **preserves the snapshotted `durationDays`** (history is not erased), blocks any further claim (409), and a second void is rejected (409).
- **Record-keeping only (2)** — `StockMovement` count, `JournalEntry` count and every `StockBalance.quantityOnHand` for the sold variant are captured before and after registering, claiming, resolving and voiding, and asserted **identical**; plus an `information_schema` query proving no column on either warranty table references a journal, movement or account.
- **Tenant isolation (5)** — business B cannot read A's warranty by id (404), never sees A's rows in its own list, cannot claim/resolve/void/list-claims against A's warranty (404 on all four), and cannot register a warranty against A's sale line (404); finally **RLS is proven at the database layer**, not merely in application code: a raw query on the `erp_app` runtime connection with `app.current_tenant_id` set to B returns **zero rows** for A's warranty.
- **Permissions (4)** — an unauthenticated caller gets 401 on both read and write routes; an `ACCOUNTANT` may list but is 403 on register, claim and void; a `SALES_EMPLOYEE` may list but is **403 on claim**; a `CASHIER` performs a genuine write (registers a real claim, 201) proving the POS-floor grant works, not just that a read succeeds.
- **Listing (2)** — status/serial filters and pagination all reconcile, every row carries `effectiveStatus`, and an out-of-range `limit` is rejected 422.
- **Known Issue #47 (1)** — asserted the then-current behaviour explicitly (a sold serial-tracked variant's serials remained `IN_STOCK`) so the gap was **visible** and the later Sales integration had a regression anchor. **This test no longer exists: Phase 8E replaced it with closure assertions** proving serials are now marked `SOLD` and linked to the sale line.
- **Unit**: no new unit tests — the two domain helpers (`resolveWarrantyDurationDays`, `effectiveWarrantyStatus`/`isWarrantyCoverageActive`) are exercised end-to-end through both their success and failure paths, including the missing-configuration path, which is stronger than isolating them. Phase 1-7's 28 unit tests remain green.
- Full regression after 8A: **306/306 e2e (34 files) + 28/28 unit**, zero regressions from Phases 1-7. `npm run build`, `tsc --noEmit` and `npm run lint` all clean.

**Phase 8B**: E2E: **38 new tests, 1 new file** (`loyalty-ledger.e2e-spec.ts`), real NestJS app + real PostgreSQL `erp_test` with RLS/FORCE RLS active and the restricted `erp_app` runtime role. No mocks.
- **Derived balance (5)** — a fresh customer reads `0`; an `information_schema` scan proves **no balance-shaped column exists anywhere**; the API balance is compared against an independently computed `SUM(points)` from the raw table across positive, fractional and negative events; the ledger listing returns the whole balance rather than the filtered page subtotal; an out-of-range `limit` is rejected 422.
- **Append-only, proven at the database layer (5)** — `erp_app`'s grants read exactly `['INSERT','SELECT']` from `information_schema`; a raw UPDATE **and** a raw DELETE on the runtime connection *with the correct tenant set* both fail with `permission denied`, and the row is re-read and confirmed unchanged; a correction is shown to be a new row with the original event byte-for-byte intact; the DB rejects a zero-point row and a sign contradicting its type for all three machine types; the DB rejects a half-populated earning snapshot and a non-positive rate.
- **Negative balances impossible (4)** — an over-deduction is rejected 409 with the balance and row count unchanged; a deduction down to exactly zero succeeds and one point further is refused; **two truly concurrent deductions** (`Promise.all`, neither awaiting first) that are each individually affordable but jointly overdrawn resolve to exactly one 201 and one 409 with a correct final balance; and a global query asserts **no customer anywhere in the database** holds a negative derived balance.
- **Idempotency (4)** — a same-key/same-payload replay returns the original row and writes nothing new; a same-key/**different**-payload replay is rejected 409 rather than returning the stale row (both a changed amount and a changed reason); a missing key is rejected 422; two truly concurrent same-key requests produce **exactly one** ledger row.
- **Validation (2)** — zero points, blank reason and a non-numeric value all 422; an unknown customer 404s on both read and write.
- **BD-3 earning rule (5)** — floor proven against half-up (`99.99 × 1 → 99`, `99 × 0.5 → 49`); determinism and absence of floating-point drift (`1000.15 × 0.3 → 300`, not 300.045); non-positive eligible amounts earn nothing; the rate resolves from `Setting` and **absent, zero, negative, non-numeric and null all resolve to `null`** (no programme) rather than a guessed default; and **a snapshotted EARN row is unaffected by a later rate change** — the rate is moved to 99 afterwards and the row still reproduces its own value from its own `basisAmount`/`rateSnapshot`.
- **No accounting effect (2)** — adjusting points creates **no** `JournalEntry` and **no** `CustomerTransaction` (before/after counts); no loyalty-named `Account` exists and no journal/account column exists on `customer_points`.
- **Tenant isolation (4)** — business B cannot read the balance, read the ledger, or adjust business A's customer (404 on all three); B's own ledger is unaffected; **RLS is proven at the database layer** (a raw read on the runtime connection with B's tenant returns zero rows for A's event); and an unfiltered read with **no** tenant context returns nothing while a cross-tenant INSERT is refused by `WITH CHECK`.
- **Permissions (6)** — unauthenticated 401 on read and write; `CASHIER`, `SALES_EMPLOYEE` and `BRANCH_MANAGER` each read 200 but adjust **403**; `ACCOUNTANT` both reads and performs a genuine successful adjustment (201); `INVENTORY_MANAGER` 403 on read.
- **Audit trail (1)** — every manual adjustment records `createdBy`, its stated reason, and a matching `AuditLog` row.
- **Unit**: no new unit tests — `computePointsEarned` and `resolveLoyaltyEarnRate` are exercised directly inside the e2e suite against a real `Setting` row and a real ledger row, covering both the success and the no-programme paths, which is stronger than isolating them. Phase 1-8A's 28 unit tests remain green.
- Full regression after 8B: **344/344 e2e (35 files) + 28/28 unit**, zero regressions from Phases 1-8A. `npm run build`, `tsc --noEmit` and `npm run lint` all clean.

**Phase 8C**: E2E: **40 new tests, 2 new files**, real NestJS app + real PostgreSQL, no mocks.

`sales-return-credit.e2e-spec.ts` (11) — **all six mandated BD-1 regressions**: a manual discount, a percentage-style discount, a fixed discount and Buy-X-Get-Y each proven un-over-refundable (the BXGY case refunds exactly 200, never 300); sequential partial returns asserted to produce the exact `66.6667 / 66.6666 / 66.6667` sequence summing to exactly 200, with a fourth return still bounded 409; concurrent returns bounded by the historical line value. Plus: tax proven excluded (a line whose stored `lineTotal` is 180 credits 150); an undiscounted line unchanged from Phase 5 behaviour; integer-quantity subtotals bit-identical after the rounding alignment; a fractional-quantity line (2.5 × 3.3333) returning exactly its merchandise value across three partial returns; and the **GL revenue reversal proven to use the corrected 200, not the old gross 300**.

`loyalty-redemption.e2e-spec.ts` (29) —
- **Redemption calculation, rounding, snapshot (4)** — rate conversion folded into line discounts with `Sale.discountAmount = SUM(SaleItem.discountAmount)` asserted; 4 dp HALF-UP rounding; a three-line allocation summing to exactly 100.00 with every line inside its own cap; a later rate change proven not to alter an existing REDEEM row or its sale.
- **Earning after redemption (3)** — earns on the NET amount after redemption and excluding tax (`floor(250 × 2) = 500` on a 300-gross sale with 50 redeemed and 10 tax); floor proven against round-up (`99 × 0.5 → 49`) with **no row at all** when the result is zero; a business with no earning rate still sells, earning nothing.
- **Rejections, each with ZERO TRACE (6)** — zero-value redemption **422**; insufficient balance **409**; redemption with no configured rate **422**; redemption on a walk-in **422**; redemption exceeding merchandise value **422**. Each asserts sale, movement, payment, journal-entry, ledger-row and customer-transaction counts are all unchanged. Plus 100% redemption to zero merchandise posting a **balanced** entry.
- **Concurrency and idempotency (4)** — two concurrent redemptions resolve to exactly one 201 and one 409 with one REDEEM row and a non-negative balance; an idempotent replay returns the same sale with **no second REDEEM or EARN row**; the same key with a different `redeemPoints` is rejected 409; the partial unique index proven to reject a second EARN for one sale at the database layer.
- **Clawback and restoration (7)** — a full return claws back exactly −500 and restores exactly 5000; **sequential partial returns asserted to the literal sequences `[-167, -167, -166]` and `[1666.666, 1666.668, 1666.666]`**, summing to exactly −500 and 5000; original EARN/REDEEM rows re-read and confirmed unchanged; **both business rates changed dramatically before the return** and the original snapshots still used; a clawback that would go negative rejecting the **entire** return with every count unchanged; a return whose own restoration funds its clawback allowed; a `Promise.all` sale-vs-return race completing with no deadlock.
- **Accounting untouched (2)** — no loyalty account, mapping or journal line exists anywhere; a redeemed sale posts revenue **net** of the redemption (250 on a 300 sale) and balances.
- **Tenant isolation and permissions (3)** — business B cannot redeem business A's customer's points (404, balance untouched); a CASHIER can redeem at the till through `sales.create` alone yet still cannot adjust points by hand (403); no customer anywhere holds a negative derived balance.
- Full regression after 8C: **384/384 e2e (37 files) + 28/28 unit**, zero regressions from Phases 1-8B. `npm run build`, `tsc --noEmit` and `npm run lint` all clean.

**Phase 8D**: E2E: **35 new tests, 1 new file** (`promotions.e2e-spec.ts`), real NestJS app + real PostgreSQL, no mocks.
- **CRUD, validation, targets (6)** — each of the three approved types created and anything else rejected 422 (including a `BASKET` target, which is deferred); percentage at 0 and 101, zero fixed amount, zero X or Y, blank name and an inverted window all rejected; **a hybrid rule proven impossible** two ways (a stray `buyQuantity` on a PERCENTAGE is stripped and stored NULL, and a raw-SQL hybrid insert is rejected by `promotions_parameters_match_type`); a cross-tenant or non-existent target 404s; edit limited to name/window/active with type and parameters unchanged; deactivate-not-delete with a second deactivate rejected 409 and the row still present; list filters and an out-of-range limit.
- **Calculation on real sales (3)** — percentage landing in `SaleItem.discountAmount` with the sale total following; **fixed amount proven PER UNIT** (5 × 4 units = 20, not a flat 5) and capped at the gross with a 500-per-unit rule on a 100 line yielding exactly 100; BXGY across qty 3 → 100, 6 → 200, 5 → 100 and 2 → nothing, with the application row present or absent to match.
- **BD-10, per line only (2)** — a category "Buy 1 Get 1" over two one-unit lines yields **zero** discount and **zero** application rows; the same promotion applied to a sale where one line carries 2 units discounts **only that line**.
- **BD-11, additive and capped (4)** — both approved examples (30+20 → 50; 90+30 → 100) with the sale total, the line discount and non-negative merchandise all asserted; the promotion proven computed on the **gross** (20% of 100 = 20, not 20% of the post-manual 70); the capped case recording `discountApplied = 10` with `ruleSnapshot.computedDiscount = 30` and `cappedAtLineGross = true`; a manual discount already covering the whole line writing **no** application row; and a line with no promotion keeping its manual discount **uncapped**, proving Phase 5 behaviour is untouched.
- **Best applicable and determinism (4)** — the larger of two competing promotions wins with exactly one application row; an exact tie broken by target specificity (VARIANT over CATEGORY); different lines of one sale carrying different promotions with `Sale.discountAmount = SUM(SaleItem.discountAmount)` preserved; the unique index rejecting a second application of one promotion to one line.
- **Validity (3)** — an expired and a not-yet-started promotion both ignored; a deactivated promotion ignored; the stored window proven half-open **and resolved in the business timezone** (an inclusive 31 March stored as the exclusive instant at the start of 1 April local time).
- **Historical integrity (3)** — a promotion renamed, re-dated into 2091 and deactivated after the sale, with the sale's discount, line discount, snapshot `percentageValue` and frozen `promotionName` all confirmed unmoved; provenance proven append-only by a direct-connection UPDATE and DELETE rejection with the row re-read unchanged; a promotion referenced by a sale proven undeletable.
- **Loyalty interaction (3)** — redemption eligibility proven to **exclude** the promoted amount and earning to be net of both (gross 300 − 60 promotion − 50 redemption → basis 190, earning 380); redemption rejected when it would exceed the merchandise left after the promotion, with the whole sale rolled back; **and the 8C fingerprint correction proven by replaying a promoted sale**, with a genuinely different manual discount still rejected 409.
- **Returns, accounting, inventory (3)** — a promoted BXGY line returned one unit at a time producing exactly the BD-1 cumulative sequence `66.6667 / 66.6666 / 66.6667 = 200`, never 300, **with no change to the return code**; the GL posting revenue net of the promotion and balancing, with no promotion-named account anywhere; a promotion proven to move **no** stock — all three units including the free one leave the shelf.
- **Tenant isolation and permissions (4)** — business B cannot read, edit, deactivate or list business A's promotions (404 on each); A's promotion never discounts B's sale; RLS proven at the database layer with both a cross-tenant read and an unfiltered no-context read returning zero rows; and the **full six-role matrix** — four roles read 200 but are 403 on create, edit and deactivate, Inventory Manager is 403 on read, unauthenticated is 401.
- **Unit**: no new unit tests — the three calculators and the selection order are exercised end-to-end against real sales, including every boundary case, which is stronger than isolating them. Phase 1-8C's 28 unit tests remain green.
- Full regression after 8D: **419/419 e2e (38 files) + 28/28 unit**, zero regressions from Phases 1-8C. `npm run build`, `tsc --noEmit` and `npm run lint` all clean.

**Phase 8E**: E2E: **24 new tests across 1 new file plus additions to two existing suites**, real PostgreSQL, no mocks. Total suite is now **444 e2e across 39 files**.

`sales-integration-8e.e2e-spec.ts` (18) —
- **Full stack on one sale (3)** — promotion + manual + redemption composed in the approved order with the promotion computed on the gross (400 gross, 40 manual, 40 promotion, 50 redemption → 130 discount, 270 total) and earning on the final net (540 points); four sequential partial returns telescoping to **exactly** 270 credit, −540 clawback and 5000 restoration, leaving the customer's balance back at the original grant; and **all four configuration values changed afterwards** (both loyalty rates, promotion renamed, promotion deactivated) proving the stored sale, its promotion application and its ledger rows are all unmoved.
- **Serial capture and the six traceability questions (5)** — a single test answers all six: which serials a line sold, which line sold a serial, whether a serial was returned and on which document, its current status, whether a warranty exists, and whether that warranty was auto-voided — with the *unreturned* sibling unit confirmed still `SOLD` and unlinked to any return. Plus rejection of a foreign-variant serial, a non-existent serial, a count mismatch, a duplicate on one line, and re-selling an already-sold unit; serials rejected on a non-tracked line; a unit returned twice or against a line that never sold it; and a serial-tracked return that omits or miscounts its serials.
- **Concurrency, real `Promise.all` (4)** — two sales for the **same serial** resolve to exactly one winner with exactly one `SaleItemSerial` row; two returns of the same serial likewise; a sale and a return on the same customer and serials complete with **no deadlock** and a non-negative balance; two concurrent warranty registrations for one serial produce exactly one warranty.
- **Idempotency across the stack (3)** — replaying a promotion + manual + redemption + serial sale creates no second link, application, REDEEM or EARN row; the same key with a **different serial** is rejected 409; a return replay with different serials is rejected while an identical replay is safe.
- **Append-only and isolation (2)** — `information_schema` grants read exactly `INSERT, SELECT` on both link tables, a direct-connection DELETE is refused, RLS returns nothing for another tenant, and a global query proves no serial is linked to two different sale lines while `SOLD`.

`sales-return-credit.e2e-spec.ts` (+5, BD-12) — an over-discounted line capped with merchandise value at zero and never negative, `line_total` and the customer transaction both correct, and its return crediting exactly zero rather than a negative amount; the GL balanced with no negative reversal on both the sale and the return; loyalty earning, clawback and restoration all correct and non-negative on a capped line; every valid discount unchanged (the cap is the identity); and a global query proving **no sale line in the database has a discount exceeding its own gross**.

`warranty.e2e-spec.ts` (+1, #47 closure) — a warranty cannot be registered for a serial the sale line did not sell.

- Full regression after 8E: **444/444 e2e (39 files) + 28/28 unit**, zero regressions. Build, `tsc --noEmit` and lint clean.

**Phase 8F**: E2E: **9 new verification tests, 1 new file** (`phase8-verification.e2e-spec.ts`) — a cross-tenant INSERT sweep proving `WITH CHECK` rejects a forged row on every Phase 8 table (plus an explicit test that a cross-tenant `INSERT…SELECT` inserts *nothing*, because RLS filters the source rows too — a different but equally safe outcome, verified rather than assumed); a zero-row read sweep over ten tables both cross-tenant and with no tenant context; trial balance balanced after a promotion + loyalty + serial sale and its return, cross-checked by a query asserting every journal entry balances individually; determinism proven by computing the same promoted, discounted sale three times and by resolving overlapping promotions three times to the same winner; a consolidated atomicity sweep asserting **ten** table counts unchanged across seven rejection paths plus zero-value redemption; and historical immunity to `defaultCost`/`defaultSellingPrice` changes covering the sale, its COGS movements and its later return credit.
- Full regression after 8F: **453/453 e2e (40 files) + 28/28 unit**, zero regressions. Build, `tsc --noEmit`, lint clean; both databases report "up to date" and `prisma migrate diff --exit-code` reports **no schema drift**.

**Phase 11**: E2E: **30 new tests, 2 new files**; Unit: **9 new tests, 1 new file**. Every one covers a gap that was actually found — nothing restates an invariant an earlier phase already proves, and the RLS/append-only/tenant-isolation suites are touched only where Phase 11 opened a new path to them.
- `security-hardening.e2e-spec.ts` (25) — **the reset guard (5)**: the real test database accepted; a production database name refused *even under* `NODE_ENV=test`; the test database refused when `NODE_ENV` is not `test`; unset and unparseable targets refused; and the error proven to contain neither the password nor the URL while still naming the database. **Refresh-token reuse (5)**: normal rotation leaving other sessions alone; a spent token presented twice revoking **every** live session including an unrelated second device, with `revokedAt IS NULL` count driven to 0; the audit row naming how many sessions it killed; the revocation *and* the record proven to survive the request's own 401 (the rollback trap); a forged token rejected **without** revoking anything, so reuse detection cannot be triggered by anyone who can send a bad string. **Suspension (1)**: a live, unexpired access token stops working immediately, along with the refresh token and any new login. **Audit trail (8)**: served to `audit.view`; 403 for a Cashier; 401 unauthenticated; **no cross-tenant row on any page**, with the tenant's `meta.total` proven to be its own count and not the table's; filters on action/user/entity; **deterministic paging across rows sharing a `createdAt`**, walking every page and asserting the ids equal the single-page read exactly (the regression that would catch losing the `id` tiebreak); malformed queries rejected rather than ignored; and the endpoint proven to expose **only** `get`, with a direct-connection `UPDATE`/`DELETE` refused by PostgreSQL. **`PERMISSION_DENIED` (4)**: a row naming the endpoint, caller and missing permission; one row per attempt with the denial still standing and nothing created; the denial filed under the **caller's** tenant and invisible to the other; and **no row at all** when the request was allowed. **The published contract (2)**: every documented operation's stated authorization matched against the `@RequirePermissions` and `@Public` metadata the guards actually read, across 80+ handlers, so the document cannot drift from enforcement.
- `rate-limiting.e2e-spec.ts` (5) — builds its **own** application with small limits set before the module graph loads, because `.env.test` relaxes them for the rest of the suite and a relaxed limit proves nothing. Sign-in refused on a burst of **wrong** passwords (what an attack actually sends) and then refused for the **correct** ones too, with the structured `TOO_MANY_REQUESTS` envelope intact; bulk tenant creation refused; a stolen refresh token refused when exercised in a loop; a password-change loop grinding `currentPassword` refused; and the ordinary API proven **not** tightened — thirty authenticated calls, all served, because throttling a cashier who scans quickly is an operational cost for no security gain.
- `validate-environment.spec.ts` (9, unit) — a correct production environment passing silently; the owner connection refused as the runtime connection in production and tolerated in development; missing, short and well-known-placeholder secrets; one key signing both token types; **every** problem reported at once rather than the first; warnings not fatal outside production; and no message — thrown or returned — quoting a secret, a value or a connection string.
- Full regression: **627/627 e2e across 51 files + 37/37 unit**, zero regressions from Phases 1–10.2.

## Security Review
Everything from Phases 1-4 stands unchanged. Phase 5 additions:
- Every sales-mutating endpoint requires its own specific permission (11 new codes) rather than one blanket `sales.manage` - verified by test at two privilege levels: a Cashier (the intended POS-floor role) allowed to open a shift, sell, and return, but rejected from an out-of-template action; a role with zero sales permissions rejected from every sales route entirely.
- **Cost/margin visibility is server-side gated on Sales, directly satisfying the Phase 0 spec's explicit requirement for this domain** (unlike Purchasing, where it was left as a judgment call - Known Issue #25): `GetSaleUseCase` only attaches `totalCost`/`grossProfit` for a caller holding `products.view_cost`, verified through the actual API with two different tokens against the same sale, not merely asserted from code reading.
- `customer_transactions`, `sales`, `sale_payments`, `sale_returns`, `sale_return_items` all have no DELETE grant for the runtime role (and no UPDATE either, except `sales`' Postgres-required lock-support grant - see Migrations item 4, which does not enable any code path to actually mutate content) - verified by test that UPDATE/DELETE against `customer_transactions` fails with a real Postgres permission-denied error via a direct connection as the restricted role.
- The same RLS + non-superuser-role pattern is proven again for the new tables via raw SQL: an unfiltered `SELECT * FROM sales`/`SELECT * FROM customers` as `erp_app` with no tenant context returns zero rows, and an attempted cross-tenant `INSERT` is rejected by the `WITH CHECK` clause.

Phase 6 additions:
- Every accounting-mutating endpoint requires its own specific permission (8 new codes) - verified by test: a Cashier forbidden from every accounting route; an Accountant allowed to view/reverse but explicitly rejected (403) from `accounting.reopen_period`, which only the Owner has by default.
- `journal_entries`/`journal_entry_lines` have no UPDATE **or** DELETE grant at all for `erp_app` - stricter than every prior phase's "append-only" tables (which at most needed a narrow, explained UPDATE for row-locking support) - verified by a direct-connection UPDATE/DELETE rejection test against both tables.
- The same RLS + non-superuser-role pattern proven again via raw SQL for all 5 new tables: unfiltered `SELECT`s return zero rows with no tenant context; a cross-tenant raw `INSERT` is rejected by `WITH CHECK`.

Phase 8A additions:
- Every warranty route carries its own explicit `@RequirePermissions` (3 new codes) — there is no route reachable on authentication alone, verified by test at three privilege levels: `ACCOUNTANT` (view-only, 403 on register/claim/void), `SALES_EMPLOYEE` (403 specifically on `warranty.claim`), and `CASHIER` (a genuine successful write, so the grant is proven working rather than merely present).
- `warranties`/`warranty_claims` have **no DELETE grant** for `erp_app`. The `UPDATE` grant is for genuine status transitions only and is documented as such in the grants migration; neither table is row-locked, so no `FOR UPDATE` support grant was needed (the Phase 5 `sales` lesson, applied up front for the second phase running).
- RLS **and FORCE RLS** are active on both new tables and proven at the database layer, not merely in application code: a raw query on the restricted `erp_app` connection with another tenant's `app.current_tenant_id` returns zero rows for a warranty that demonstrably exists.
- Every claim route resolves its parent warranty **inside the caller's tenant first**, so a claim belonging to another business cannot be reached by guessing a warranty id — tested against all four claim/void/list/resolve paths.
- The Cashier's `warranty.claim` grant does **not** breach Phase 0 §9's no-cost/profit-visibility rule for that template: neither warranty table has a cost, price or profit column, and the module exposes none.

Phase 8B additions:
- Both new codes are route-enforced server-side and the **full six-role matrix is tested**, not sampled: Cashier / Sales Employee / Branch Manager each read but are 403 on adjust; Accountant performs a genuine successful adjustment; Inventory Manager is 403 on read. Read and write are separate permissions because telling a customer their balance and creating points from nothing are very different acts.
- `customer_points` has **no UPDATE and no DELETE** grant for `erp_app` — the strictest grant in the system alongside `journal_entries` — verified both by reading `information_schema` and by a direct-connection UPDATE/DELETE rejection test that re-reads the row afterwards to confirm it is unchanged.
- RLS **and FORCE RLS** proven at the database layer: a raw read on the restricted connection with another tenant's `app.current_tenant_id` returns zero rows, an unfiltered read with no tenant context returns nothing, and a cross-tenant INSERT is refused by `WITH CHECK`.
- The manual adjustment endpoint requires **both** an idempotency key and a stated reason, so the one write with no source document behind it cannot be silently double-submitted and cannot produce an entry an audit is unable to explain.

Phase 8C additions:
- **Redemption adds no attack surface and no permission**: it is a field on an endpoint the caller already needs `sales.create` for, and every value that matters is resolved server-side. The client supplies only how many points to spend; the rate, the monetary value, the per-line allocation and the resulting discounts are all computed inside the transaction and can never be supplied or influenced by the request.
- The **idempotency fingerprint hashes the client request only** — never the server-resolved redemption value or the allocated line discounts. A stored sale's line `discountAmount` now includes the server's own allocation, so the fingerprint compares the client's discount at sale level (exactly reconstructible as `Sale.discountAmount − REDEEM.basisAmount`) rather than per line.
- **8C added no database privilege at all.** `customer_points` grants remain exactly `INSERT, SELECT`; RLS and FORCE RLS unchanged. Cross-tenant redemption is refused at the customer lookup (404) and would be refused by RLS regardless.
- Points remain outside the GL entirely — asserted by a test that finds no loyalty-named account and no loyalty-described journal line anywhere.

Phase 8D additions:
- **A client can never supply promotional pricing.** There is no endpoint that applies a promotion; resolution happens server-side inside `CreateSaleUseCase`'s own transaction. The client supplies only its own manual `discountAmount`, and every promotional amount is computed from rules stored in that tenant.
- Authoring a discount rule is a pricing decision, so `create`/`edit`/`deactivate` are **Owner-only** by default while every POS-facing role gets `view` — verified across the full six-role matrix, not sampled.
- `sale_promotion_applications` has **no UPDATE and no DELETE** grant for `erp_app`, verified from `information_schema` and by a direct-connection rejection test; `promotions` has no DELETE, and a RESTRICT foreign key means a rule referenced by a historical sale could not be removed even if one existed.
- RLS **and FORCE RLS** proven at the database layer on both tables, including an unfiltered read with no tenant context returning nothing.
- `Promotion.targetId` is not a foreign key by necessity, so target existence is validated against the caller's own tenant in the application — a promotion can never be created pointing at another business's product, category or variant (404, tested).

Phase 8E additions:
- **A client cannot control serial requirements.** Whether a line needs serials is decided by the product's own `tracksSerialNumbers` flag, so a caller can neither omit the field to skip capture nor attach serials to a line whose product does not track them.
- **A previously unguarded race is closed.** `consumeSerialsForSale` read a serial's status and then updated it with no lock, so two simultaneous sales could sell one physical unit twice. Rows are now locked `FOR UPDATE` in deterministic `id` order, proven by a real concurrent-HTTP test.
- Both new link tables have **no UPDATE and no DELETE** grant for `erp_app`, verified from `information_schema` and by a direct-connection rejection test, with RLS + FORCE RLS proven at the database layer.
- **A warranty can no longer be attached to a unit the sale did not deliver** — the check is against a stored fact rather than the variant-match proxy it replaced.

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
- **The four distinct scenarios, stated exactly, verified by test in `sales-lifecycle.e2e-spec.ts`**:
  1. **Walk-in sale** (`Sale.customerId IS NULL`): no `Customer` row is ever touched, so **zero** `CustomerTransaction` rows are posted. `SUM(initial SalePayment.amount)` MUST equal `totalAmount` exactly at creation - there is no account to extend credit to, so partial payment is rejected outright (`CONFLICT`).
  2. **Named-customer, fully-paid-cash sale** (`customerId` set, initial payment == total): posts `CustomerTransaction(SALE, +total)` AND `CustomerTransaction(PAYMENT, -total)` in the same transaction - two real, distinct ledger events (gross sale value, and cash received) that net to a zero balance change, not one one collapsed into the other. `paymentStatus: PAID`.
  3. **Credit sale** (`customerId` set, initial payment < total, including exactly 0): posts `CustomerTransaction(SALE, +total)` and, only if something was tendered now, `CustomerTransaction(PAYMENT, -initialPayment)`. The customer's derived balance rises by the unpaid remainder. `paymentStatus` is `PARTIALLY_PAID` or `UNPAID`.
  4. **Customer payment** (`POST /sales/:id/payments`, any time after creation, against an existing `customerId`-attached Sale only - a walk-in Sale has no customer to post a ledger entry against and cannot receive this call meaningfully since it was already required to be paid in full): posts one more `CustomerTransaction(PAYMENT, -amount)`, bounded by the Sale-row lock so it can never push `remainingAmount` below zero even under concurrent late payments.

## Concurrency Review
**Seven** e2e tests fire genuinely concurrent HTTP requests (`Promise.all` against the live, already-running NestJS app, real PostgreSQL round-trips for each) - covering every scenario your rules required, including the return-vs-return case added during the release-gate review:
1. **LAST UNIT** — *initial state*: a 1-unit `StockBalance`. *Concurrent ops*: 5 simultaneous `POST /sales` for 1 unit each. *Locks*: each request's transaction takes `SELECT ... FOR UPDATE` on the same `StockBalance` row inside `InventoryEngineService.applyMovement`; only one acquires it first, the other four block, then each re-checks availability against the now-decremented balance once unblocked. *Transaction boundary*: the whole `CreateSaleUseCase.execute` body per request. *Impossible outcome ruled out*: two sales both decrementing the same last unit (double-sell) or the balance going negative. *Actual result*: exactly 1 succeeds (201), 4 rejected (409 `INSUFFICIENT_STOCK`), final balance exactly `0`, exactly 1 `SALE` movement.
2. **MULTI-UNIT** — *initial*: 20-unit balance. *Concurrent*: 10 requests for 3 units each (30 requested). *Locks/boundary*: same as above, ten independent transactions serializing on the one `StockBalance` row. *Impossible outcome*: total consumed exceeding 20, or a final balance not equal to `20 - (successes × 3)`. *Actual*: total never exceeds 20, final balance exactly matches the formula.
3. **SHARED-VARIANT ORDERING** — *initial*: two variants X and Y, 20 units each. *Concurrent*: Sale A requests `[X, Y]` in that order, Sale B requests `[Y, X]` (the classic lock-order-inversion shape) - each well within available stock. *Locks*: `CreateSaleUseCase` sorts both requests' lines by `variantId` before consuming, so despite the opposite CLIENT-supplied order, both transactions actually acquire the `StockBalance` locks in the SAME (`variantId`-sorted) order internally. *Boundary*: one transaction per sale. *Impossible outcome*: a Postgres deadlock (55P03) aborting one request, or a lost update on either variant's balance. *Actual*: both succeed (201), both balances exactly reflect both sales' consumption - direct EXECUTED proof the canonical sort works, not just an inspection-based argument.
4. **BUNDLE CONTENTION** — *initial*: a Bundle needing 3 of a component with only 5 units in stock. *Concurrent*: two `POST /sales` for 1 bundle each (6 component units requested total). *Locks*: `consumeVariant`'s bundle-expansion branch locks the component's `StockBalance` row via the same engine call. *Impossible outcome*: both succeeding (would need 6 of 5). *Actual*: exactly 1 succeeds, final component balance exactly `2`.
5. **SALE + RETURN** — *initial*: balance 16 after an earlier, already-completed 4-unit sale (from a 20-unit opening). *Concurrent*: a NEW 5-unit sale (decrease) racing a RETURN of 2 units from the EARLIER sale (increase) - both touching the same `StockBalance` row. *Locks*: both go through `InventoryEngineService.applyMovement`'s same row lock; whichever acquires it first is applied first, the second recomputes from the just-committed value. *Impossible outcome*: a lost update (final balance reflecting only one of the two operations). *Actual*: both succeed, final balance exactly `16 - 5 + 2 = 13` regardless of serialization order, 4 total movements (opening + earlier sale + new sale + return).
6. **RETURN + RETURN** (added during review) — *initial*: a completed 10-unit sale. *Concurrent*: two `POST /sales/:id/returns` for 6 units each against the SAME `SaleItem` (12 total, only 10 sold). *Locks*: both transactions call `lockSale` (`SELECT ... FOR UPDATE` on the `sales` row) before touching `SaleItem.quantityReturned` - the second blocks until the first commits, then recomputes `quantity - quantityReturned` from the just-updated value. *Boundary*: one transaction per return request. *Impossible outcome*: `quantityReturned` exceeding 10, or two `SALES_RETURN` movements both landing. *Actual*: exactly 1 succeeds (201), 1 rejected (409 `CONFLICT`), `quantityReturned` ends at exactly `6`, exactly 1 `SALES_RETURN` movement.
7. **DUPLICATE IDEMPOTENCY** — *initial*: 20-unit balance, no prior Sale with the test's `idempotencyKey`. *Concurrent*: two `POST /sales` with byte-identical payloads and the SAME `idempotencyKey`, fired via `Promise.all` before either awaits. *Locks*: the actual guarantee is the DB-level unique index on `(business_id, idempotency_key)`, not a row lock - the second `INSERT` blocks on that index until the first commits, then fails with a real unique-violation (mapped to a non-201 response), since the application-level pre-check (`findFirst`) cannot see the other transaction's still-uncommitted row. *Impossible outcome*: two `Sale` rows or two `StockMovement` rows for the same key. *Actual*: exactly 1 succeeds, exactly 1 `StockMovement`, exactly 1 `Sale` row for that key.

Mechanism, summarized: identical locking primitives to Phase 3/4 - `InventoryEngineService`'s `StockBalance` row lock for every inventory-affecting concurrency scenario (1-6), the DB unique constraint for idempotency (7), and `lockSale`'s `Sale`-row lock for document-level invariants that aren't inventory at all (6). Canonical lock ordering (test #3) is now EXECUTED proof, not just an inspection-based argument - this was the one area Phase 4's review had to leave as analysis-only; Phase 5 closes it with a real, passing, deliberately-adversarial test.

## Historical Integrity Review
- Once completed, a `Sale` is never mutated by application code (no `sale.update()` call exists anywhere) - the only path that touches an existing Sale's children is `SaleItem.quantityReturned` (a running total, exactly like `PurchaseItem.quantityReturned`) and `SalePayment` inserts (new rows, never edits).
- `StockMovement` rows produced by a Sale or a SaleReturn are never modified or deleted - proven by re-reading the original `SALE` movement after a return and confirming it is byte-for-byte unchanged.
- COGS is never recalculated from current Product/Variant cost - every movement's `unit_cost_at_movement` is fixed at write time (the engine's own rule, untouched), and a SELLABLE return explicitly carries over the ORIGINAL sale's cost rather than re-deriving it, proven under a deliberately drifted average-cost scenario.
- Corrections always use a proper workflow: an over-quantity or wrong-price sale is corrected via `SaleReturn` (a new document, new movements), never by editing the original `Sale`/`SaleItem`/`StockMovement` rows.
- Soft-deactivating a Customer (`isActive = false`) does not touch or hide their historical Sales - `erp_app` has no DELETE grant on `customers`, and no read path filters sales by the customer's current `isActive` status.
- **Void semantics, stated exactly (verified against the actual schema, not assumed)**: `sales.status` is `SaleStatus`, a deliberate single-value enum (`COMPLETED` only - see Migrations item 1 / Architecture Decisions) - there is no `VOID`/`CANCELLED` value and no `voidedAt`/`voidedBy` column anywhere on `Sale`, and no application code path ever transitions a Sale's status. **Void is intentionally unsupported after completion.** `SaleReturn` is the one and only correction mechanism for a completed Sale, and it is a bounded, additive correction (new rows, `SaleItem.quantityReturned` capped at `SaleItem.quantity`), never a full reversal of the original document. This mirrors Purchasing's own posture (a `RECEIVED` Purchase is corrected via `PurchaseReturn`, never edited or voided) and was a deliberate, not accidental, design choice: a POS environment needs every completed sale to remain a permanent, auditable fact once inventory and payment have moved, exactly like Phase 3's `StockMovement` immutability principle.

Phase 8A additions:
- **Coverage is a snapshot, never a recomputation.** `durationDays` is stored on the `Warranty` row and `endDate` derived from it exactly once, at registration. `isWarrantyCoverageActive`/`effectiveWarrantyStatus` read only the row's own dates and never consult `Setting`, so changing `warranty.default_duration_days` cannot widen or narrow an already-issued warranty — proven by a test that changes the default from 365 to 1 and re-reads both the DB row and the API response.
- **`startDate` is the Sale's own `createdAt`**, never the registration time and never client-supplied: there is no code path by which a user can choose when their own warranty started.
- **Claims are never edited.** Resolution writes only `status`/`resolution`/`resolvedAt`/`resolvedBy`; `claimedAt`, `description` and `createdBy` are re-read after resolution and confirmed unchanged. The transition is **one-way** — a resolved or rejected claim can never be re-transitioned, so a decision is never silently overwritten. A correction is a **new claim**, the same never-edit-history posture as `SaleReturn` correcting a `Sale`.
- **The audit trail is a database guarantee, not an application convention**: `warranty_claims_resolution_audit_consistent` makes a resolved-claim-without-`resolvedAt` unrepresentable, proven by a raw-SQL attempt that the constraint rejects.
- **Voiding preserves history**: the snapshotted dates, `durationDays` and every existing claim survive a void untouched; only `status` moves. `erp_app` has no DELETE on either table, so a warranty or claim can never be erased.
- **Concurrency**: both status transitions use a single conditional `updateMany` (`WHERE status = 'OPEN'` / `WHERE status <> 'VOID'`) rather than read-then-write, so two simultaneous resolutions or voids can never both report success — the `CloseShiftUseCase` pattern from Phase 5.

Phase 8B additions:
- **The ledger cannot be rewritten.** `erp_app` holds `SELECT, INSERT` only on `customer_points`; a correction is a new compensating row and the original event survives byte-for-byte (proven by re-reading `points`, `description` and `createdAt` after a later correction). This is the same never-edit-history posture as `SaleReturn` towards `Sale` and `reverseEntry` towards `JournalEntry`, but enforced one level stricter — those tables at least permit a locking UPDATE; this one permits none.
- **A balance can never drift from its own history**, because there is no second copy of it: no stored balance column exists (asserted against `information_schema`), so `SUM(points)` is not a cache that could go stale but the only representation there is.
- **Earned points are immune to configuration change.** `basisAmount` and `rateSnapshot` freeze the BD-3 arithmetic onto the row, so a later rate change cannot alter, re-derive or invalidate points already earned — proven by moving the business rate to 99 after the fact and confirming the row still reproduces its own value from its own snapshot with no current configuration consulted. `customer_points_snapshot_complete` makes that pair all-or-nothing at the database layer.
- **Sign integrity is structural**: `customer_points_sign_matches_type` makes a REDEEM that raises a balance, or an EARN that lowers one, unrepresentable — so a future code path cannot corrupt the meaning of the ledger even if its application logic is wrong.
- **Concurrency**: the balance is re-read under a `SELECT … FOR UPDATE` lock on the **Customer** row before any deduction, so the overdraw race is closed at the serialization point that actually governs new inserts — proven by a real concurrent-HTTP test, not asserted from code reading.

Phase 8C additions:
- **One definition of return credit**, shared by the refund, the clawback and the restoration, so no two can disagree about how much of a sale came back. The old `quantity × unitPrice` form is gone.
- **Every loyalty figure is a cumulative delta**, never a per-return proportion, so any sequence of partial returns telescopes to exactly the original amount. Asserted on the literal sequences, not merely on the totals.
- **Snapshots are the only inputs.** Clawback and restoration read the EARN/REDEEM rows' own `points`/`basisAmount`/`rateSnapshot` and the Sale's own immutable `subtotal`/`discountAmount`; current loyalty settings are never consulted. Proven by changing both rates dramatically before returning.
- **Nothing historical is mutated.** Restoration and clawback are new compensating INSERTs; the original rows are re-read after the return and confirmed byte-for-byte unchanged. `erp_app` still has no UPDATE or DELETE on `customer_points`, so no other outcome is even possible.
- **Sale immutability is preserved**: `CreateSaleUseCase` still only ever inserts, and the BD-1 correction changes only how a return's credit is *computed* — no existing `Sale`, `SaleItem`, `StockMovement` or `JournalEntry` row is rewritten, and no posted accounting entry is amended.
- **The redemption is recorded once and only once.** `customer_points_one_event_per_source` makes one EARN and one REDEEM per Sale a database guarantee, independent of the Sale's optional idempotency key.

Phase 8D additions:
- **Historical sales never recompute from live promotion configuration.** What a completed sale received is frozen in its own `SaleItem.discountAmount`, and `SalePromotionApplication` freezes the promotion's name, type and every rule parameter at the time of sale. Renaming, re-dating or deactivating the rule afterwards provably changes nothing.
- **Provenance is append-only at the database layer**, not by convention: `SELECT, INSERT` only, so a historical application can never be rewritten to agree with a rule that has since changed.
- **Type, target and parameters are immutable on a promotion.** Repurposing a rule in place would make historical applications point at something that no longer resembles what happened, so only name, window and active flag are editable — a different rule is a different promotion.
- **Return semantics needed no change at all.** `return-credit.ts` computes `merchandiseValue = round4(unitPrice × quantity) − discountAmount`, and a promotion discount lands in `discountAmount`, so the §6.1 locked BXGY return policy was **already implemented** by the Phase 8C BD-1 correction. A promoted BXGY line returns at exactly its historical proportional value; `CreateSaleReturnUseCase` was not modified.
- **Accounting and inventory are untouched.** A promotion raises `discountAmount`, lowering `netRevenue` and `totalAmount` identically, so the entry balances by construction — no account, no mapping key, no engine change. Free units are physically shipped, so stock consumption and COGS are unchanged and gross profit correctly falls.

Phase 8E additions:
- **Net merchandise value can never be negative on any line.** BD-12 makes `finalDiscount ≤ lineGross` universal, which in turn guarantees the BD-1 return credit, the loyalty clawback and the restoration are all non-negative. A global query asserts no stored sale line violates it.
- **Serial history survives everything.** `SaleItemSerial` is never deleted, not even when the unit is returned: the return is recorded by the serial's own status transition and by `SaleReturnItemSerial`, so a unit that is sold, returned and sold again keeps every leg of its history — which a `saleItemId` column on `SerialNumber` could not have done.
- **A voided warranty is still a complete record.** BD-15 changes only `status`; the snapshotted `startDate`/`endDate`/`durationDays` and every existing claim survive untouched, so a voided warranty remains a full account of what was once promised.
- **Accounting and Inventory were not modified.** Every serial transition rides the existing `consumeVariant`/`applyMovement` path, and no journal-entry logic changed; the entries for capped and fully-discounted lines were re-verified as balanced.

## Accounting Engine & Integration Review (Phase 6)

**Double-entry integrity**: `AccountingEngineService.postEntry` validates balance in application code before any insert (throws `UnbalancedJournalEntryError`); a DEFERRED constraint trigger re-verifies `SUM(debit)=SUM(credit)` per entry at the DB layer as the second line of defense, proven firing correctly via a direct raw-SQL insert as `erp_app` bypassing the application entirely (see Known Issues #35 for a Prisma-client quirk found while testing this, not a defect in the trigger itself, which was independently reproduced via plain `psql`).

**Integration boundaries, verified by grep**: the only callers of `postEntry`/`reverseEntry` are the 7 Sales/Purchasing/Inventory use-cases and `ReverseJournalEntryUseCase` - no controller, no other engine, calls it directly. Every journal line's amount is sourced from a value the calling use-case already computed for its OWN business purpose (Sale's own monetary model, `computeSaleCost`, `SupplierTransaction`'s own `totalReceivedValue`/`totalCredit`, `applyMovement`'s own returned `unitCostAtMovement`) - Accounting never recomputes a business fact or runs a second inventory-valuation pass.

**Reconciliations, proven by test, not asserted**:
- COGS ↔ `StockMovement.unit_cost_at_movement`: `SUM(COGS journal lines)` for a variant's sales equals `SUM(quantity × unit_cost_at_movement)` across its own SALE movements, independently computed and compared.
- Customer subledger ↔ Accounts Receivable: `SUM(CustomerTransaction.amount)` equals the AR account's own live derived balance.
- Supplier subledger ↔ Accounts Payable: `SUM(SupplierTransaction.amount)` equals the AP account's own live derived balance.
- Trial balance: `SUM(debit)` equals `SUM(credit)` across every account, exposed as an explicit `balanced` boolean on `GET /accounting/journal-entries/trial-balance`, re-verified after the full battery of postings in `accounting-postings.e2e-spec.ts`.

**Historical integrity**: `journal_entries`/`journal_entry_lines` have SELECT+INSERT only for `erp_app` (no UPDATE, no DELETE, at all) - stricter than any prior phase's append-only tables. Corrections are reversal entries only (`reverseEntry`), never edits; the original entry's own lines are re-read and confirmed byte-for-byte unchanged after a reversal. `JournalEntryStatus.REVERSED` is never actually written (reversed-ness is a derived fact via the `reversalOf`/`reversedBy` relation), so the table's append-only DB grant is never in tension with the reversal feature.

**Idempotency/duplicate-posting**: proven under TRUE concurrent duplicate `POST /sales` requests (not just sequential retries) - exactly one succeeds, exactly one `JournalEntry` exists for that Sale's `sourceId`. `(business_id, source_type, source_id)` is the DB-level backstop; `(business_id, reversal_of_id)` is the equivalent backstop for reversals.

**Precisely what that backstop does and does not cover** (see Known Issues #36): `JournalEntry (source_type, source_id)` prevents duplicate posting **for the same source document** - a given document can never reach the GL twice. It **cannot, alone, prevent duplicate logical requests**: where the source use-case itself lacks idempotency (`CreatePurchaseReturnUseCase`, `CreatePurchasePaymentUseCase`, and `AdjustStockUseCase` - pre-existing Phase 3/4 gaps, carried-forward Known Issue #23), a retried request creates a genuinely new source document with a new id, and Accounting then correctly posts a second entry for that genuinely-new document. **Phase 6 did not fix, and does not claim to have fixed, duplicate-request prevention in Purchasing or Inventory** - that remains those modules' own scope.

**Period controls**: `postEntry` resolves and row-locks the covering `FiscalPeriod` before inserting; a CLOSED period rejects the posting (and the whole source-event transaction rolls back with it, proven by a delta-count test showing zero Sale/JournalEntry trace left behind). `ClosePeriodUseCase`/`ReopenPeriodUseCase` lock the same row, proven race-safe by a real concurrent Sale-vs-close test.

## Known Issues / Technical Debt

### Scope of the Phase 8 final register (approved decision BD-16, Option A)

The register below is the **Phase 8 final register and covers entries #26–#82 only** — 57 contiguous entries, verified during Phase 8G to contain no gaps and no duplicates.

**Entries #1–#25 belong to earlier phases (Phases 1–4).** They are preserved in git history and in prior revisions of this file. **They were NOT re-verified as part of the Phase 8 release gate**, and they are therefore intentionally outside the Phase 8 final register. Their current status is deliberately **not** asserted here — not open, not closed, not accepted and not deferred — because no such status is independently established by an approved record, and inferring one would be a guess. Anyone needing them should read them from git history and verify each against the current code.

The one exception is the three carried-forward entries **#23/#24/#25**, whose interaction with Phase 5 is described under Completed Features by an approved record; that description stands as written and is not extended here.

### Status classification for the Phase 8 register (#26–#82)

Every entry carries exactly one status. These are descriptive classifications of records already approved at their own gates — no status below is newly decided.

| Status | Meaning | Entries |
|---|---|---|
| **CLOSED** | Resolved by implementation; the entry is retained for history | **#47** (closed in 8E) |
| **FIXED — RELEASE-GATE ACCEPTED** | A real defect found and fixed within Phase 8, accepted at a gate | **#59, #60, #61** |
| **DOCUMENTATION — CORRECTED** | A documentation error found and corrected in 8F, accepted at the 8F gate | **#77, #78, #79, #80** |
| **ACCEPTED LIMITATION** | Intentional consequence of an approved decision; no action planned | **#26, #27, #28, #30, #38, #39, #40, #45, #46, #48, #49, #50, #51, #52, #53, #55, #57, #58, #62, #63, #64, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #81, #82** |
| **DEFERRED FEATURE** | Approved as out of Phase 8 scope; belongs to Phase 9+ | **#29, #31, #32, #33, #41, #42, #43, #44, #54, #56, #76** |
| **PRE-EXISTING, CARRIED FORWARD** | Inherited from an earlier phase, explicitly not addressed by Phase 8 | **#34, #35, #36, #37** |

**No entry in the Phase 8 register is an open, unclassified defect.** Every one is either closed, fixed-and-accepted, an accepted limitation, a deferred feature, or an explicitly carried-forward pre-existing item.

### PHASE 10 CLOSURES against the register above

The entries below are CLOSED BY PHASE 10. The original text of each is left standing rather than rewritten — history is not edited to match a later decision — and this block is the record of what changed.

| Entry | Was | Closed by |
|---|---|---|
| **#28** Shift has no cash count or reconciliation | An explicit Phase 5 scope decision | **10A.** Blind close, counted cash, manager reconciliation, and a variance posting. The note even predicted the shape ("an `expectedCash`/`countedCash` pair on close") — except that expected cash is DERIVED and never stored, which is what makes blind close real. |
| **#32** Walk-in return posts no Revenue/AR reversal | An absence of data, not an oversight: Sales recorded no refund fact, and Accounting is forbidden to invent one | **10C + BD-23.** `SaleReturn.refundMethod/refundAmount` records the tender at source, which is exactly the "real operational business fact newly recorded at the source" the entry named as the precondition for any fix. The two user-facing notes that told users walk-in returns never reverse revenue were factually wrong once BD-23 landed and are corrected. |
| **#36** Purchasing idempotency gap | Inherited, explicitly not fixed by Phase 6 | **10I.** `ReceivePurchaseUseCase` now compares a canonical fingerprint; a key reused with a different delivery is 409. |
| **#72** A returned serial is quarantined and cannot be resold | BD-14's disposition, awaiting an inspection workflow | **10E + BD-22.** The serial follows the return line's own condition. The inspection workflow remains deferred and is no longer a precondition for reselling returned goods. |

**Still open and unchanged:** #55 (outstanding loyalty points are not a GL liability), #56 (points never expire), #73 (BD-13 is a breaking change for clients selling serial-tracked products without naming serials — Phase 10 widened this to receiving and transfers), #76 (reporting cannot split a discount into manual, promotional and loyalty components). Phase 10 addressed none of these and did not claim to.

**New accepted limitations from Phase 10**, each a consequence of an approved decision rather than a gap:

- **A downward exchange is refused.** Recorded as a deliberate boundary above, with the reason and the alternative.
- **A short transfer receipt leaves the missing units `IN_TRANSIT` forever** until someone adjusts them. They are in neither warehouse, which is the truth; absorbing them at either end would hide a real discrepancy. There is no write-off workflow for them yet.
- **The advisory `quantityReserved` is never reconciled or expired.** A basket parked and forgotten holds its reservation until it is resumed or voided. Nothing depends on the number, so nothing breaks — but `availableQuantity` will drift optimistic-low until someone tidies up. A hold-expiry policy was not in scope.
- **Pre-Phase-10 sale lines carry no tax snapshot.** They were sold under a contract where the client asserted the tax, and their `taxRateSnapshot` is null. Historical receipts for them show a tax figure with no rate beside it. They are NOT rewritten.
- **Pre-Phase-10 shifts have no cash register.** `Shift.cashRegisterId` is nullable precisely so those shifts keep their history truthfully rather than being back-filled with a register they were never opened against.

The most operationally significant accepted limitations, restated so they are not overlooked at release: **#55** outstanding loyalty points are not a GL liability and appear nowhere on the Balance Sheet; **#56** points never expire, so the float only grows until redeemed; **#72** a returned serial is quarantined as `RETURNED` and cannot be resold until a future inspection workflow exists; **#73** BD-13 is a breaking change for any client selling a serial-tracked product without naming its serials; **#76** reporting cannot break a discount into manual, promotional and loyalty components.

### The register

Phase 1-4's lists stand unchanged (including the carried-forward #23/#24/#25 - see the note under Completed Features for exactly which of those Phase 5 did and didn't address). New from Phase 5:

26. **No Bundle-type `SaleReturn`** - a bundle sale can be completed, but returning it is rejected explicitly (`VALIDATION_FAILED`) rather than attempting a partial component-level return. The correct semantics (which components come back, in what condition, individually) were judged too complex to build without an explicit spec requirement; flagged rather than guessed at.
27. **No landed-cost/multi-warehouse-per-sale** - a Sale targets exactly one `warehouseId` (matching its Shift's warehouse), no allocation of extra costs. Consistent with the same scope boundary Purchasing drew in Phase 4.
28. **Shift has no cash-count/reconciliation** - by deliberate scope decision (approved: "do NOT turn this into a full cash-management/accounting module"). If ever needed, the natural extension is an `expectedCash`/`countedCash` pair on close, without touching the core open/close/active-shift-required mechanics built now.
29. **No price-list/promotion auto-application** - `unitPrice` is caller-supplied per line (mirrors `PurchaseItem.unitCost`'s established pattern); Phase 2's `ProductPrice`/`PriceList` exist and could pre-fill a default client-side, but the server does not cross-check or auto-populate it. Promotions/Loyalty are explicitly Phase 8 territory.
30. **`sales` needed a Postgres-mechanical `UPDATE` grant purely to support `SELECT ... FOR UPDATE`** (Migrations item 4) - a real, minor design-time miss (not caught until a live e2e test hit a genuine permission-denied error), now fixed and documented as a general lesson: any table a future phase needs to lock via `FOR UPDATE` needs the `UPDATE` grant regardless of whether a real content update ever happens.
31. **No offline sync transport** - deliberately out of v1 scope; `CreateSaleUseCase`'s idempotency design is built to be reusable unchanged by a future sync layer (see Scope Decisions), but the transport itself (`/pos-sync/*`, `Device`, `SyncQueueItem`, conflict-review UI) does not exist yet.

New from Phase 6:

32. **RELEASE-GATE LIMITATION — Revenue/AR reversal for a walk-in `SaleReturn` is NOT SUPPORTED.** A walk-in (no-customer) return posts an accurate Inventory/COGS correction and nothing else: **no Sales Revenue reversal, no Accounts Receivable credit, no Cash credit.** The reason is not an oversight but an absence of data: Phase 5's `CreateSaleReturnUseCase` records **no operational fact** for a walk-in refund - zero `CustomerTransaction` rows (there is no customer ledger to credit) and no cash-refund/tender-out event of any kind. Accounting therefore has nothing real to post a revenue-reversal or cash-credit line *from*. Posting one anyway would require Accounting to **invent** a business fact (guess that cash left the drawer, and how much, and by what tender) - explicitly forbidden, and not done. Tested explicitly rather than merely asserted: `accounting-postings.e2e-spec.ts` contains a dedicated test proving zero Revenue and zero AR lines exist for this exact case.
    **Constraint on any future fix**: it MUST be driven by a real operational business fact newly recorded at the source (i.e. Sales starts recording an explicit walk-in refund/tender-out event, a Phase-5-scope change), and must NOT be implemented by re-deriving, inferring, or reconstructing the refund from the Sale/SaleReturn documents after the fact. Until such a fact exists, this limitation stands as-is.
33. **No manual/adjusting journal entry creation endpoint** - `JournalEntryStatus.DRAFT` exists in the schema (spec fidelity, Phase 0 §6.2) but is unreachable: every Phase 6 code path posts straight to `POSTED` (your explicit scope decision) and there is no HTTP surface for an Accountant to create a manual entry from scratch. `POST /accounting/journal-entries/:id/reverse` covers corrections to AUTOMATIC postings; a from-scratch manual entry (e.g. recording owner's capital injection, or a non-operational adjustment) is not yet possible. Deferred rather than built speculatively, since nothing in your explicit requirements demanded it.
34. **Found and fixed during this phase's own test-writing**: `OpenPeriodUseCase`'s overlap check originally considered periods of ANY status, not just `OPEN` ones - since every business starts with one open-ended bootstrap period (covering "now" through 9999-12-31), closing it would have permanently blocked opening any new period ever again (its far-future date range would "occupy" every future date forever, even after closing). Fixed to check only against other OPEN periods; a CLOSED period's date range no longer blocks a new one. Caught by the Accountant-permission e2e test attempting exactly this close→open-next sequence, not by inspection.
35. **A Prisma client-library quirk found while writing the DB-level unbalanced-entry test**: `PrismaClient.$transaction(async tx => {...})`'s implicit COMMIT does not reliably surface a DEFERRED constraint trigger's failure as a rejected JS promise in this stack (verified: the exact same raw SQL, run via plain `psql`, correctly throws and rolls back every time; run via Prisma with an explicit `SET CONSTRAINTS ALL IMMEDIATE` added before the implicit commit, also correctly throws). The DATA is never at risk either way - Postgres always rolls back the whole transaction regardless of what the JS caller observes - but a hypothetical future bug that let `postEntry` reach an unbalanced insert via Prisma's own transaction path might present as a confusing "no error, but nothing was saved" response rather than a clean thrown exception. Purely a defense-in-depth backstop concern (the application-layer check makes this path unreachable today), documented rather than hidden.
36. **RELEASE-GATE LIMITATION — inherited Purchasing idempotency gap (Phase 4 scope, NOT fixed by Phase 6).** `PurchaseReturn` and `PurchasePayment` have no request-level idempotency key (the latter not even a column). The exact scope of what Phase 6's own guarantee does and does not cover, stated precisely:
    - **What `JournalEntry (business_id, source_type, source_id)` DOES guarantee**: a given source document can never be posted to the GL more than once. Re-posting for an already-known document id is impossible, DB-enforced.
    - **What it CANNOT guarantee, alone**: deduplication of duplicate *logical requests*. If the source use-case itself lacks idempotency - as `CreatePurchaseReturnUseCase` and `CreatePurchasePaymentUseCase` both do - then a retried request creates a **genuinely new source document with a new id**, and Phase 6 then correctly posts a second, independently-balanced `JournalEntry` for that new document. From Accounting's perspective this is correct behavior (a real second document exists); the duplication originates upstream, in the source module.
    **Phase 6 did not fix, and does not claim to have fixed, duplicate-request prevention at the Purchase level.** This is an inherited Phase 4 limitation (same root cause as carried-forward Known Issue #23), now additionally visible in the ledger. The fix belongs in Purchasing's own scope (adding `idempotencyKey` to both use-cases); **no Phase 1-5 refactor was performed for it during Phase 6**, per explicit instruction.
37. **RELEASE-GATE LIMITATION — stock-count approval produces NO GL entry (intentional scope limitation).** **⚠️ RESTATED IN PHASE 7 — the original wording of this issue was factually wrong in a way that would have caused a silently-broken reconciliation.**
    **What the Phase 6 text said**: "any reconciliation must exclude `movementType = 'STOCK_COUNT'`".
    **What is actually true** (established in Phase 7 by grepping the code, not by re-reading this document): **`StockMovementType.STOCK_COUNT` is a dead enum value — no code path in the entire system ever writes it.** `ApproveStockCountUseCase` writes its reconciliation movements with **`movementType = 'ADJUSTMENT'` and `referenceType = 'StockCount'`**, and does not post to the General Ledger. A reconciliation excluding by movement type would therefore have excluded **nothing at all** while appearing to work correctly, and could not have distinguished a stock-count `ADJUSTMENT` (no GL entry) from an `AdjustStockUseCase` `ADJUSTMENT` (which *does* post). **`referenceType = 'StockCount'` is the only reliable discriminator.**
    **A second, separate non-posting source was also identified**: `OPENING_BALANCE` movements (opening stock) are likewise never posted — an explicit Phase 6 decision (Opening Balance Equity is seeded in the Chart of Accounts but deliberately carries no mapping key).
    **Direct consequence for reconciliation, stated correctly**: any comparison between `stock_movements` value and the GL Inventory account **MUST exclude both (a) `referenceType = 'StockCount'` and (b) `movementType = 'OPENING_BALANCE'`**, and must report each excluded value **visibly and separately**, because both divergences are EXPECTED and are NOT accounting errors. `TRANSFER_IN`/`TRANSFER_OUT` need no exclusion: they are equal-and-opposite at carried-over cost and correctly sum to zero. Phase 7's `/reports/reconciliation/inventory-gl` implements exactly this and is tested against a real approved stock count. **No Phase 1-6 code was changed** to address this (per the Phase 7 approval conditions) — only this document's wording was corrected and Phase 7's own reconciliation built against the real behaviour.
38. **Period non-overlap is an application-level check only, not a DB exclusion constraint** - periods are created rarely by an Accountant (not a hot concurrency path), so a Postgres `EXCLUDE` constraint (requiring the `btree_gist` extension) was judged unnecessary rigor for this specific invariant; a genuinely concurrent double-open-period race is theoretically possible but has no realistic trigger in normal usage.

New from Phase 7:

39. **`StockMovementType.STOCK_COUNT` is a dead enum value** — no code path writes it (see the restated #37 above). It remains in the schema because removing an enum value is a breaking migration with no benefit, but any future code reasoning about stock counts must key off `referenceType = 'StockCount'`, never the movement type.
40. **Stock-count approval and opening stock produce no GL entry** — `ApproveStockCountUseCase` and `OpeningStockUseCase` are the two inventory paths that change stock value without posting (only `AdjustStockUseCase` posts, wired in Phase 6). Both are deliberate Phase 6 scope decisions; Phase 7's inventory-vs-GL reconciliation excludes and reports both explicitly. Wiring either into the Accounting Engine is a future-phase decision, not a Phase 7 change.
41. **No Low Stock report** — no reorder-point/minimum-stock field exists anywhere in the schema, so "low" has no source of truth. Adding one is a schema change belonging to Catalog/Inventory scope, not Reporting.
42. **No AR/AP aging** — no due-date or payment-terms field exists on sales, purchases, customers or suppliers. Only outright balances are reported.
43. **No IAS-7 Cash Flow Statement** — Operating is derivable, but Investing and Financing have **no source data at all** (no fixed assets, loans, or capital transactions can be recorded). A three-section statement was deliberately not produced, and not approximated. A factual GL-derived "Cash Movement Report" was offered as an alternative and deferred pending a separate decision.
44. **No report exports (PDF/Excel)** — deferred; no export infrastructure and no `reports.export` permission exist.
45. **No caching on reports or the dashboard** — every figure is computed live. Deliberate: premature without measured load, and a stale financial KPI is worse than a slow one. Indexing is the performance lever instead; revisit only with real numbers.
46. **Branch scoping applies to reporting only** — Phase 7 introduced the first server-side `UserBranch` enforcement, but only within `/reports/*`. Pre-existing Phase 1-6 read endpoints remain tenant-scoped-but-not-branch-scoped, unchanged. Extending branch restriction to those is a separate, deliberate decision.

New from Phase 8A:

47. **[CLOSED IN PHASE 8E]** **Phase 5 sales record no `SaleItem → SerialNumber` link — so a warranty cannot be proven to cover the unit that was actually sold.** *(Historical entry, describing the state from 8A until 8E closed it; see the closure note below and the Phase 8E section.)* Found while implementing 8A, deliberately **not** worked around. `CreateSaleUseCase` calls `consumeVariant` **without** serials, so `consumeSerialsForSale` returns early: selling a serial-tracked variant marks no `SerialNumber` as `SOLD` and stores no link anywhere saying which physical unit left on which sale line. `RegisterWarrantyUseCase` therefore validates the strongest thing the current data model supports — the serial exists in the tenant and belongs to the **same variant** as the sale line — but cannot verify it is the unit that was sold. Requiring `status = 'SOLD'` was considered and **rejected**: no sale ever sets it, so that check would reject every legitimate registration in the system while appearing correct (the same failure shape as Known Issue #37's dead `STOCK_COUNT` value). Current behaviour is asserted by a test so the gap is visible and Phase 8B has a regression anchor. **Closing this requires the Sales integration explicitly deferred to Phase 8B** — capturing serials on a sale line — and was not invented here.
48. **No background expiry job** — nothing flips a stored `ACTIVE` warranty to `EXPIRED` when its period elapses. Expiry is derived on read as `effectiveStatus`, and both the stored and derived values are returned so the distinction is never hidden. Approved 8A scope adds no job runner. A consequence worth stating: a query filtering on the stored `status = 'ACTIVE'` will include elapsed warranties; callers must use `effectiveStatus`, which every read path returns.
- **Consequence for reporting**: no `/reports/*` endpoint surfaces warranty data at all — Phase 7's layer was not extended, so there is no report where this stored-vs-derived distinction could be misread.
49. **`durationDays` has no business maximum** — only the technical 36500-day (100-year) timestamp-overflow bound, enforced identically in the zod schema and the `warranties_duration_days_technical_bound` CHECK, and documented as technical in both. Phase 0 defines no maximum warranty length and inventing one was explicitly forbidden. If a business maximum is ever specified, it belongs as a `Setting`, not as a change to this bound.
50. **Multiple claims per warranty are allowed by design** — a first claim may be REJECTED, or a second unrelated fault may occur within one coverage period. If a one-claim-per-warranty rule is ever wanted, it is a business decision that must be stated, not derived.
51. **Claim resolution has no replacement, refund, or credit path** — approved 8A scope is record-keeping only. `WarrantyModule` imports neither `InventoryEngineModule` nor `AccountingEngineModule`, so this is structural: no warranty action can move stock or post to the ledger even by mistake. A future replacement workflow would go through `InventoryEngineService` and `AccountingEngineService` like every other module, never around them.
52. **A warranty is not auto-created at sale time** — registration is an explicit, separate call. Wiring it into the POS sale flow is Phase 8B's Sales integration, deliberately not started.

New from Phase 8B:

53. **Three of the four `CustomerPointsType` values have no writer yet** — `EARN`, `REDEEM` and `RETURN_CLAWBACK` are all produced by a Sale or SaleReturn, which is 8C/8E's approved scope. `ADJUSTMENT` is the only type reachable in 8B. This is the approved phase split working as intended, not a dead-enum defect of the Known Issue #37 kind: each value has a named phase that will write it, and pulling those writers forward would be exactly the scope creep the phase split exists to prevent. The clawback formula was deliberately **not** implemented in 8B even as an unwired helper.
54. **No loyalty reporting** — Phase 7's `/reports/*` layer was not extended, so a point balance is visible only per-customer through the loyalty endpoints. There is no business-wide outstanding-points figure anywhere.
55. **Points are not a GL liability** (approved decision, restated as a limitation because it has a real accounting consequence): outstanding points represent a future obligation that appears **nowhere** on the Balance Sheet. A business with a large point float carries an unrecorded obligation. This is the approved Phase 8 treatment; if it is ever revisited, it is a Phase 6 accounting change with a new mapping key, not a loyalty change.
56. **No expiry** — points never lapse, and there is no scheduler (approved decision). Combined with #55, the point float only ever grows until redeemed.
57. **A manual `ADJUSTMENT` has no `basisAmount`/`rateSnapshot`** — deliberately: a human correction is not derived from a merchandise amount at a rate, and populating those fields would make the row look like a computed `EARN` it is not. The all-or-nothing CHECK accepts both-null.
58. **The earning rate is business-wide** — there is no per-customer tier, per-branch rate, or category-specific multiplier. Customer-specific pricing/tiers are explicitly deferred by the approved decisions.

New from Phase 8C — **three latent defects found by 8C's own tests and FIXED**, all three verified as pre-existing rather than introduced:

59. **[RELEASE-GATE ACCEPTED]** **A sub-scale residual amount produced a journal line that stored as `0.0000` and crashed the sale (FIXED).** `buildSaleJournalLines` tested `.greaterThan(0)` at full Decimal precision but writes to `Decimal(18,4)`. A remainder below half a ten-thousandth — a POS client tendering a float-computed total, say `7 × 13.37` — passed the test, stored as zero, violated `journal_entry_lines_debit_xor_credit`, and failed the whole sale with a 500. **Reproduced identically on the pre-8C code**, so this is a correction, not a regression. Fixed by rounding every journal-line amount to the monetary scale and deriving `remaining` from the ROUNDED tenders, so `SUM(tenders) + remaining = totalAmount` still holds exactly at the stored scale and the entry stays balanced by construction. The same fix was applied to `buildSaleReturnJournalLines`, where `returnInCost = quantity × unitCostAtMovement` multiplies two 4-dp values and can carry 8 dp.
60. **[RELEASE-GATE ACCEPTED]** **A customer sale totalling exactly zero crashed on the `customer_transactions` non-zero CHECK (FIXED).** Reachable before 8C via a 100% manual discount; BD-7's approval of full redemption makes it routine. Fixed by skipping the zero-amount `CustomerTransaction` — the customer owes nothing and the ledger correctly records nothing — mirroring the guard `CreateSaleReturnUseCase` already had.
61. **[RELEASE-GATE ACCEPTED]** **`accounting-concurrency.e2e-spec.ts` asserted a timing-dependent HTTP status split (FIXED).** It required exactly one 201 and one failure from two concurrent same-key sales, but **both interleavings are correct**: a true race resolved by the unique constraint, or a second request whose idempotency pre-check runs after the first commits and correctly replays. Measured failing roughly **one run in three on the pre-8C baseline**. Rewritten to assert the invariant it exists for — exactly one Sale carries the key, every 201 refers to that same Sale (a second 201 with a different id would be a real duplicate-creation bug), exactly one JournalEntry — which is strictly stronger than the old assertion, then verified stable over six consecutive runs.

Also new from Phase 8C:

62. **The idempotency fingerprint compares the client's discount at SALE level, not per line.** A stored line's `discountAmount` now includes the server's redemption allocation, and the allocation is one-way, so the per-line client split is not reconstructible while the total is (`Sale.discountAmount − REDEEM.basisAmount`). A replay changing any line's variant, quantity, price or tax, the redeemed points, or the total discount is still rejected; the one thing that would pass is redistributing an identical total discount across identical lines, which changes no monetary outcome of the sale.
63. **A bundle line's loyalty discount can never be clawed back or restored**, because bundle lines cannot be returned at all (Known Issue #26). Pre-existing consequence, now with a loyalty dimension.
64. **`REDEMPTION_RESTORATION` rows carry a `basisAmount` that is itself a cumulative delta**, so the values across a sale's returns sum exactly to the original redemption value. The points are the authoritative quantity; the monetary field is descriptive.
65. **Redemption is not available on walk-in sales** — points belong to a customer, and `CustomerPoints.customerId` is non-nullable. Rejected 422 rather than silently ignored.

New from Phase 8D:

66. **A promotion CAN apply to a bundle line, and that discount can never be returned.** A Bundle is a `Product`, so the approved PRODUCT and CATEGORY targets reach it, and applying a line-level discount is not "bundle expansion". But bundle lines cannot be returned at all (Known Issue #26), so a promotion discount on one can never be returned, clawed back or restored — the same shape as #63 for loyalty. Pre-existing consequence, now with a promotion dimension.
67. **Category targeting does not walk child categories.** `Category` is self-referencing, but the approved policy names "Category" as a target without defining descendant inheritance, so a promotion targets exactly the category assigned to the product. Walking the tree would have been inventing scope.
68. **A category BXGY spread thinly across lines yields nothing** — the direct and deliberate consequence of BD-10. A "Buy 1 Get 1" over two separate one-unit lines is not a mistake in the engine; it is the approved per-line semantics, asserted by test so the behaviour is visible rather than surprising.
69. **A stray parameter on a promotion request is stripped, not rejected.** No schema in this codebase uses `.strict()`, so unknown keys are ignored on every endpoint and promotions follow that convention. The guarantee that matters — that a hybrid rule cannot exist — is enforced by the use-case writing only type-appropriate parameters and independently by `promotions_parameters_match_type`, both asserted.
70. **The promotion base price is the caller-supplied `unitPrice`** (Known Issue #29 remains deferred, and no second pricing engine was created). This is safe because no in-scope promotion is triggered by a price threshold — basket-spend promotions are deferred — so there is no price a client could enter to unlock a promotion it should not get.
71. **Promotions are tenant-wide.** No branch scoping, no per-customer targeting, no quotas or usage limits — all explicitly deferred, which is also why promotion resolution needs no counter and therefore introduces no new lock.

**Known Issue #47 is CLOSED (Phase 8E).** Sales capture serial identity at creation, `SaleItemSerial` records it durably, and warranty registration verifies against it. The entry is retained here for history rather than deleted.

New from Phase 8E:

72. **No inspection workflow exists.** `RETURNED` is the terminal state Phase 8E writes; a returned unit is quarantined and cannot be resold until a future workflow releases it to `IN_STOCK` or `DAMAGED`. `RESERVED` remains a dead enum value with no writer.
73. **BD-13 is a breaking change for existing callers.** Any client selling a serial-tracked product without naming its serials now receives 422. This was approved deliberately, to close #47 genuinely rather than leave a partial fallback. The Phase 8A warranty fixture was updated accordingly and the change is reported in the release gate.
74. **A serial-tracked line cannot be sold in a UOM other than the base unit with fractional quantity** — the serial count must equal the quantity, which implies whole units. Not a new restriction (serials were always whole units) but now enforced at sale time rather than being silently skippable.
75. **Warranties registered before Phase 8E have no `SaleItemSerial` link.** The verification is therefore effective for sales made from 8E onward; a historical sale's warranty is unaffected and is neither retro-validated nor invalidated.
76. **Reporting still cannot break a discount down** into manual, promotional and loyalty components — `Sale.discountAmount` is a single figure and Phase 7 is read-only. Carried forward from 8D, unchanged.

Found and corrected during the Phase 8F audit — **all four were DOCUMENTATION ERRORS in this file, not product defects**:

77. **Known Issue #47's own entry read in the present tense** with no closure marker, while the "CLOSED" banner sat forty lines further down. A reader reaching the entry first would have concluded serial linkage was still missing. Marked `[CLOSED IN PHASE 8E]` on the entry itself.
78. **The Phase 8A test list described a test that no longer exists** — the `#47` test that asserted a sold serial-tracked variant's serials remain `IN_STOCK`. Phase 8E replaced it with closure assertions. The entry now says so explicitly.
79. **The Phase 8A narrative described the serial gap in the present tense**, without noting the later closure. Corrected to past tense with a pointer to Phase 8E.
80. **The Phase 8A scope list stated "no serial is captured on a sale line"** as a standing fact rather than as 8A's own boundary. Corrected to scope it to 8A and note that serial capture now exists while warranty auto-creation at sale time still does not.

Also verified during 8F and recorded as an **accepted scaling characteristic, not a defect**:

81. **`resolveActivePromotions` reads all active promotions for the tenant on every sale**, bounded by the tenant's promotion count rather than by the sale's lines. It is an indexed, tenant-scoped read of a configuration table (not a ledger), and the engine needs all candidates to select the best-applicable one, so it is deliberately not paginated. `EXPLAIN` confirms an index scan with the tenant predicate leading. Narrowing it by the sale's target ids would be a speculative optimisation and was not made.
82. **The derived loyalty balance is a `SUM` over the customer's whole ledger**, which grows with their event count. This is inherent to the approved append-only, no-stored-balance design; the `(business_id, customer_id)` index covers it and `EXPLAIN` confirms an index scan.

## Files Created
Prisma migrations: `apps/api/prisma/migrations/20260829112729_sales_schema/`, `.../20260829112800_sales_rls/`, `.../20260829112900_sales_app_role_grants/`, `.../20260829130000_sales_lock_update_grant/`.

Shared validation: `packages/shared-validation/src/sales.ts`.

Shared common: `apps/api/src/common/domain/document-number.ts` (relocated from `modules/purchasing/domain/`); `apps/api/src/common/domain/idempotency.ts` (added during release-gate review - `assertIdempotentReplayMatches`, shared by all three idempotent Sales use-cases).

Inventory (Phase 3, extended): `apps/api/src/modules/inventory/domain/consume-variant.ts`.

Sales module (`apps/api/src/modules/sales/`): `sales.module.ts`; `domain/{customer-balance,lock-sale,find-active-shift,sale-cost}.ts`; `domain/payment-summary.ts` (added during release-gate review - `computePaymentSummary`, shared by `GetSaleUseCase` and `CreateSalePaymentUseCase`); `application/customers/{create-customer,update-customer,deactivate-customer,list-customers,get-customer}.use-case.ts`; `application/shifts/{open-shift,close-shift,get-active-shift,list-shifts}.use-case.ts`; `application/sales/{create-sale,get-sale,list-sales}.use-case.ts`; `application/returns/create-sale-return.use-case.ts`; `application/payments/create-sale-payment.use-case.ts`; `presentation/{customers,shifts,sales}.controller.ts`.

Tests: `apps/api/test/sales-{customers,shifts,lifecycle,returns,concurrency-and-isolation}.e2e-spec.ts`, `apps/api/test/utils/sales-fixtures.ts`; `apps/api/test/sales-wac-reconciliation.e2e-spec.ts` (added during release-gate review - the Opening→Purchase→Sale→Purchase→Sale→Return→Adjustment reconciliation proof).

## Files Modified
`apps/api/prisma/schema.prisma` (8 new models/5 enums + Business/Branch/Warehouse/ProductVariant relations), `apps/api/prisma/seed.ts` (11 new permission descriptions), `apps/api/src/app.module.ts` (wire `SalesModule`), `apps/api/test/db-reset.ts` (truncate the 8 new tables), `packages/shared-types/src/permissions.ts` (11 new codes + role-template grants for `BRANCH_MANAGER`/`ACCOUNTANT`/`CASHIER`/`SALES_EMPLOYEE`), `packages/shared-validation/src/index.ts` (re-export `sales.ts`), `apps/api/src/modules/inventory/application/stock/consume-stock.use-case.ts` (rewritten as a thin wrapper over `consumeVariant`, unchanged external behavior), `apps/api/src/modules/purchasing/application/{purchases/create-purchase,receiving/receive-purchase,returns/create-purchase-return}.use-case.ts` (import path updated for the relocated `documentNumberFromId`).

**Modified during the release-gate review** (all behavior-additive, no prior external behavior changed): `apps/api/src/modules/sales/application/sales/create-sale.use-case.ts` (added `saleFingerprint()` + idempotency-mismatch guard); `apps/api/src/modules/sales/application/returns/create-sale-return.use-case.ts` (added `saleReturnFingerprint()` + guard); `apps/api/src/modules/sales/application/payments/create-sale-payment.use-case.ts` (added `salePaymentFingerprint()` + guard; refactored to call the new shared `computePaymentSummary` instead of its own inline aggregate); `apps/api/src/modules/sales/application/sales/get-sale.use-case.ts` (now calls `computePaymentSummary` and includes `paidAmount`/`remainingAmount`/`paymentStatus` in its response); `apps/api/test/sales-lifecycle.e2e-spec.ts` (added the atomicity test, 2 idempotency-mismatch tests, and payment-summary assertions on 3 existing tests); `apps/api/test/sales-returns.e2e-spec.ts` (added an idempotency-mismatch test); `apps/api/test/sales-concurrency-and-isolation.e2e-spec.ts` (added the RETURN + RETURN concurrent test).

### Phase 6 Files Created
Prisma migrations: `apps/api/prisma/migrations/20260829123435_accounting_schema/`, `.../20260829123500_accounting_rls/`, `.../20260829123600_accounting_app_role_grants/`.

Shared validation: `packages/shared-validation/src/accounting.ts`.

Accounting engine (`apps/api/src/engines/accounting/`): `accounting-engine.module.ts`, `accounting-engine.service.ts`.

Accounting module (`apps/api/src/modules/accounting/`): `accounting.module.ts`; `domain/{lock-fiscal-period,resolve-mapped-account,seed-accounting-defaults,sale-journal-lines,sale-return-journal-lines,sale-payment-journal-lines,purchase-journal-lines,inventory-adjustment-journal-lines}.ts`; `application/accounts/{list-accounts,create-account,update-account,deactivate-account}.use-case.ts`; `application/journal/{list-journal-entries,get-journal-entry,reverse-journal-entry,get-account-balance,get-trial-balance}.use-case.ts`; `application/periods/{open-period,close-period,reopen-period,list-periods}.use-case.ts`; `presentation/{accounts,journal,periods}.controller.ts`.

Tests: `apps/api/test/accounting-{postings,integrity,concurrency}.e2e-spec.ts`.

### Phase 6 Files Modified
`apps/api/prisma/schema.prisma` (5 new models/5 enums + `Business` back-relations), `apps/api/prisma/seed.ts` (8 new permission descriptions + the one-time `seedAccountingDefaults` bootstrap loop for pre-existing businesses), `apps/api/src/app.module.ts` (wire `AccountingEngineModule`/`AccountingModule`), `apps/api/test/db-reset.ts` (truncate the 5 new tables), `packages/shared-types/src/permissions.ts` (8 new codes + `ACCOUNTANT` role-template grants), `packages/shared-validation/src/index.ts` (re-export `accounting.ts`), `apps/api/src/common/errors/domain-error.ts` (new `UnbalancedJournalEntryError`), `apps/api/src/common/filters/all-exceptions.filter.ts` (maps it to 422), `apps/api/src/modules/tenancy/application/register-business.use-case.ts` (calls `seedAccountingDefaults` at onboarding), `apps/api/src/modules/sales/application/sales/create-sale.use-case.ts` / `application/returns/create-sale-return.use-case.ts` / `application/payments/create-sale-payment.use-case.ts` (each now calls `postEntry` inside its own transaction), `apps/api/src/modules/purchasing/application/receiving/receive-purchase.use-case.ts` / `application/returns/create-purchase-return.use-case.ts` / `application/payments/create-purchase-payment.use-case.ts` (same), `apps/api/src/modules/inventory/application/stock/adjust-stock.use-case.ts` (same).

All 7 integration touches are additive only - each existing use-case's own external behavior (validation, atomicity, idempotency, response shape) is unchanged; verified by re-running each module's FULL existing e2e suite after every single integration, not just once at the end.

### Phase 7 Files Created
Prisma migration: `apps/api/prisma/migrations/20260829140000_reporting_indexes/` (indexes only — no tables, views, or materialized views).

Shared validation: `packages/shared-validation/src/reporting.ts`.

Reporting module (`apps/api/src/modules/reporting/`): `reporting.module.ts`; `domain/{branch-scope,date-range,report-visibility,report-context}.ts`; `application/sales/{sales-summary,sales-by-dimension,sales-returns-report,purchasing-report}.use-case.ts`; `application/inventory/inventory-reports.use-case.ts`; `application/financial/financial-reports.use-case.ts`; `application/dashboard/dashboard.use-case.ts`; `application/reconciliation/reconciliation.use-case.ts`; `presentation/{sales-reports,inventory-reports,financial-reports,dashboard}.controller.ts`.

Tests: `apps/api/test/reporting-{isolation-and-permissions,sales-purchasing,inventory,financial,dashboard-reconciliation}.e2e-spec.ts`.

### Phase 7 Files Modified
`apps/api/prisma/schema.prisma` (5 `@@index` entries matching the migration — no model/field changes), `apps/api/prisma/seed.ts` (5 new permission descriptions), `apps/api/src/app.module.ts` (wire `ReportingModule`), `packages/shared-types/src/permissions.ts` (5 new codes + `ACCOUNTANT`/`BRANCH_MANAGER` role-template grants), `packages/shared-validation/src/index.ts` (re-export `reporting.ts`), `docs/state/PROJECT_STATE.md`.

**No Phase 1-6 source file was modified.** Reporting reads existing tables through existing privileges; the only schema change is five indexes, each backing a specific audited query.

### Phase 8A Files Created
Prisma migrations: `apps/api/prisma/migrations/20260829165055_warranty_schema/`, `.../20260829165100_warranty_rls/`, `.../20260829165200_warranty_app_role_grants/`.

Shared validation: `packages/shared-validation/src/warranty.ts`.

Warranty module (`apps/api/src/modules/warranty/`): `warranty.module.ts`; `domain/{resolve-warranty-duration,warranty-eligibility}.ts`; `application/{register-warranty,list-warranties,get-warranty,void-warranty,register-warranty-claim,list-warranty-claims,resolve-warranty-claim}.use-case.ts`; `presentation/warranty.controller.ts`.

Tests: `apps/api/test/warranty.e2e-spec.ts`.

### Phase 8A Files Modified
`apps/api/prisma/schema.prisma` (2 new models/2 enums + `Business`/`SaleItem`/`SerialNumber`/`Customer` back-relations), `apps/api/prisma/seed.ts` (3 new permission descriptions), `apps/api/src/app.module.ts` (wire `WarrantyModule`), `apps/api/test/db-reset.ts` (truncate the 2 new tables), `packages/shared-types/src/permissions.ts` (3 new codes + `BRANCH_MANAGER`/`ACCOUNTANT`/`CASHIER`/`SALES_EMPLOYEE` role-template grants), `packages/shared-validation/src/index.ts` (re-export `warranty.ts`), `docs/state/PROJECT_STATE.md`.

**No Phase 1-7 business logic was modified.** The only changes outside the new module are the four wiring/registration touches above — no Sales, Inventory, Accounting or Reporting use-case was edited, and `WarrantyModule`'s dependency graph structurally excludes both engines.

### Phase 8B Files Created
Prisma migrations: `apps/api/prisma/migrations/20260829220846_loyalty_ledger_schema/`, `.../20260829220900_loyalty_ledger_rls/`, `.../20260829221000_loyalty_ledger_app_role_grants/`.

Shared validation: `packages/shared-validation/src/loyalty.ts`.

Loyalty module (`apps/api/src/modules/loyalty/`): `loyalty.module.ts`; `domain/{customer-points-balance,lock-customer,loyalty-earning}.ts`; `application/{get-customer-points,list-customer-points,adjust-customer-points}.use-case.ts`; `presentation/loyalty.controller.ts`.

Tests: `apps/api/test/loyalty-ledger.e2e-spec.ts`.

### Phase 8B Files Modified
`apps/api/prisma/schema.prisma` (1 new model/1 enum + `Business`/`Customer` back-relations), `apps/api/prisma/seed.ts` (2 new permission descriptions), `apps/api/src/app.module.ts` (wire `LoyaltyModule`), `apps/api/test/db-reset.ts` (truncate `customer_points`), `packages/shared-types/src/permissions.ts` (2 new codes + `BRANCH_MANAGER`/`ACCOUNTANT`/`CASHIER`/`SALES_EMPLOYEE` role-template grants), `packages/shared-validation/src/index.ts` (re-export `loyalty.ts`), `docs/state/PROJECT_STATE.md`.

**No Phase 1-8A business logic was modified.** The only changes outside the new module are those four wiring/registration touches — no Sales, Inventory, Accounting, Reporting or Warranty use-case was edited, and `LoyaltyModule`'s dependency graph structurally excludes both engines.

### Phase 8C Files Created
Prisma migrations: `apps/api/prisma/migrations/20260829232515_loyalty_redemption_restoration/`, `.../20260829232600_loyalty_redemption_constraints/`.

Shared common: `apps/api/src/common/domain/money.ts` (`round4` HALF-UP, `floor4`, `MONEY_SCALE`, `MONEY_STEP` — the codebase's first rounding policy).

Sales domain: `apps/api/src/modules/sales/domain/return-credit.ts` (the single BD-1 definition).

Loyalty domain: `apps/api/src/modules/loyalty/domain/loyalty-redemption.ts` (rate, value, capped largest-remainder allocation), `.../loyalty-returns.ts` (cumulative clawback and restoration).

Tests: `apps/api/test/sales-return-credit.e2e-spec.ts`, `apps/api/test/loyalty-redemption.e2e-spec.ts`.

### Phase 8C Files Modified
`apps/api/prisma/schema.prisma` (one enum value), `packages/shared-validation/src/sales.ts` (`redeemPoints`), `apps/api/src/modules/sales/application/sales/create-sale.use-case.ts` (customer lock, subtotal alignment, redemption resolution/allocation, REDEEM + EARN rows, fingerprint, zero-total guard), `apps/api/src/modules/sales/application/returns/create-sale-return.use-case.ts` (lock order, BD-1 credit, restoration, clawback, net balance assertion), `apps/api/src/modules/accounting/domain/sale-journal-lines.ts` and `.../sale-return-journal-lines.ts` (monetary-scale rounding — Known Issue #59), `apps/api/test/accounting-concurrency.e2e-spec.ts` (Known Issue #61), `docs/state/PROJECT_STATE.md`.

**No new table, no new column, no new permission, no new database privilege.** The two accounting-domain files were touched only to make them respect the scale of the columns they write to — not a Phase 6 redesign, and required by the defect in #59.

### Phase 8D Files Created
Prisma migrations: `apps/api/prisma/migrations/20260830111403_promotions_schema/`, `.../20260830111500_promotions_rls/`, `.../20260830111600_promotions_app_role_grants/`.

Shared common: `apps/api/src/common/domain/business-timezone.ts` (extracted from Phase 7's `reporting/domain/date-range.ts` so promotions and reports resolve calendar dates through **one** implementation, plus a new `calendarDateToInstant`).

Shared validation: `packages/shared-validation/src/promotions.ts`.

Promotions module (`apps/api/src/modules/promotions/`): `promotions.module.ts`; `domain/{promotion-calculation,select-best-promotion,resolve-promotions,resolve-promotion-window}.ts`; `application/{create-promotion,update-promotion,deactivate-promotion,list-promotions,get-promotion}.use-case.ts`; `presentation/promotions.controller.ts`.

Tests: `apps/api/test/promotions.e2e-spec.ts`.

### Phase 8D Files Modified
`apps/api/prisma/schema.prisma` (2 new models/2 enums + `Business`/`Sale`/`SaleItem` back-relations), `apps/api/prisma/seed.ts` (4 new permission descriptions), `apps/api/src/app.module.ts` (wire `PromotionsModule`), `apps/api/test/db-reset.ts` (truncate the 2 new tables), `packages/shared-types/src/permissions.ts` (4 new codes + role-template grants), `packages/shared-validation/src/index.ts` (re-export `promotions.ts`), `apps/api/src/modules/reporting/domain/date-range.ts` (now imports the extracted timezone helpers instead of defining its own — behaviour identical, still covered by Phase 7's own tests), `apps/api/src/modules/sales/application/sales/create-sale.use-case.ts` (promotion resolution, BD-11 combination, provenance rows, and the 8C fingerprint correction), `docs/state/PROJECT_STATE.md`.

**`CreateSaleReturnUseCase`, `InventoryEngine`, `AccountingEngine` and every accounting domain file were NOT modified.** The only Phase 1-8C source touched outside wiring is `create-sale.use-case.ts` (the approved integration point) and the behaviour-preserving timezone extraction.

### Phase 8E Files Created
Prisma migrations: `apps/api/prisma/migrations/20260830114626_sale_item_serials/`, `.../20260830114700_sale_item_serials_rls/`, `.../20260830114800_sale_item_serials_grants/`, `.../20260830115323_sale_return_item_serials/`, `.../20260830121000_sale_return_item_serials_rls_grants/`.

Sales domain: `apps/api/src/modules/sales/domain/line-discount.ts` (the BD-12 cap).

Inventory domain: `apps/api/src/modules/inventory/domain/return-serials.ts` (the BD-14 quarantine transition, row-locked).

Tests: `apps/api/test/sales-integration-8e.e2e-spec.ts`.

### Phase 8E Files Modified
`apps/api/prisma/schema.prisma` (2 new models + `Business`/`Sale`/`SaleItem`/`SaleReturn`/`SaleReturnItem`/`SerialNumber` back-relations), `packages/shared-validation/src/sales.ts` (`serials` on sale and return items), `apps/api/src/modules/sales/application/sales/create-sale.use-case.ts` (BD-12 cap, BD-13 enforcement, serial pass-through, link rows, fingerprint), `apps/api/src/modules/sales/application/returns/create-sale-return.use-case.ts` (serial validation, quarantine, warranty auto-void, return-serial links, fingerprint), `apps/api/src/modules/inventory/domain/lot-and-serial.ts` (row locking, returns consumed ids), `apps/api/src/modules/inventory/domain/consume-variant.ts` (serial consumption moved after `applyMovement` for the canonical lock order, propagates consumed ids), `apps/api/src/modules/warranty/application/register-warranty.use-case.ts` (#47 closure), `apps/api/test/db-reset.ts`, `apps/api/test/warranty.e2e-spec.ts` (BD-13 fixture + #47 closure tests), `apps/api/test/promotions.e2e-spec.ts` (BD-12 correction), `apps/api/test/sales-return-credit.e2e-spec.ts` (BD-12 regression), `docs/state/PROJECT_STATE.md`.

**`InventoryEngineService` and `AccountingEngineService` were not modified.** Every serial transition rides the existing `consumeVariant`/`applyMovement` path.

### Phase 8F Files Created
Tests: `apps/api/test/phase8-verification.e2e-spec.ts`.

### Phase 8F Files Modified
`docs/state/PROJECT_STATE.md` only — four stale entries corrected (see Known Issues). **No source file, schema, migration, permission or configuration was changed**: 8F was verification and documentation correction, nothing else.

### Phase 8G Files Created
None.

### Phase 8G Files Modified
`docs/state/PROJECT_STATE.md` only. **No source file, schema, migration, seed, permission, validation schema or test was changed** — 8G was documentation and final verification, nothing else, and the only repository modification was verified to be this file before any edit was made.

## Next Phase
**PHASE 11 IS CLOSED.** The backend is hardened: authentication and session handling, rate limiting on the endpoints that are actually attacked, a readable audit trail, recorded authorization failures, startup configuration validation, a demonstrated backup and restore, and a standing structural security check. No product feature was added and no approved behaviour was changed.

**Phase 12 has NOT been started, scoped or designed.** No frontend decision, POS UI decision or ERP UI decision has been made, and none will be made without explicit instruction.

**PHASE 10.2 IS CLOSED**, and with it the last material contract ambiguity Phase 10 left open. The exchange endpoint now covers every direction.

**PHASE 10 IS CLOSED.** 10A Cash/Till, 10B Tax, 10C Refund Tender, 10D Serial Lifecycle, 10E Return Disposition, Exchanges, Hold/Resume, 10F Receipts, 10G Passwords, 10H Expenses and 10I Contract Freeze are all complete and verified.

Phase 8 is closed (8A–8G). Phase 9 was a contract-and-roadmap gate, not an implementation phase, and produced the approved decisions BD-17 … BD-25 plus the resolutions of BLOCKING-1 (tax-inclusive pricing) and BLOCKING-2 (soft hold) that Phase 10 implements.

The explicitly deferred register is unchanged by Phase 11, and nothing in it is approved or planned:

- `FinancialAccount` (SCOPE-2 — was deferred *to* Phase 11, and Phase 11's approved scope explicitly excluded it; still deferred, now unassigned)
- Hard inventory reservation
- Offline sync
- E-invoicing / jurisdiction-aware tax documents
- Email / SMS delivery
- Multi-tax stacking
- Returned-goods inspection workflow
- Legacy serial migration
- Card / wallet settlement
- Self-service password reset **delivery** (Phase 11 recorded the reasoning: while delivery is deferred, a reset token would pass through the administrator anyway, so building the redemption flow now would reduce security rather than add it)
- Shared-store (Redis) rate limiting, needed only once the API runs on more than one instance
- New promotion types · loyalty expiry · multi-tax stacking (Phase 11 scope exclusions, unchanged)

**No further phase will start without explicit instruction.**
