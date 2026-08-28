# Retail Operating System — Phase 0: Architecture & Analysis

> Status: **DRAFT FOR REVIEW** — لا يوجد كود بعد. هذا مستند تصميم فقط.
> النظام: Generic Retail ERP + POS، أول Vertical مستهدف: محلات الملابس (Clothing) لكن الـ Core عام (Generic Product Engine).

---

## 1. Architecture Proposal (نظرة عامة)

النظام مبني كـ **Modular Monolith** (وليس Microservices) في مرحلة الإطلاق، مقسّم داخلياً إلى Modules/Bounded Contexts صارمة الحدود، بحيث يسهل لاحقاً فصل أي Module (مثل Accounting أو Inventory) إلى خدمة مستقلة إن احتاج النمو لذلك. هذا القرار مبني على:

- فريق صغير في البداية → Microservices الآن = Overhead تشغيلي وتعقيد Distributed Transactions غير مبرر، خصوصاً أن أهم Invariant في النظام هو **Atomicity** (بيع = فاتورة + دفعة + حركة مخزون + COGS + قيد محاسبي، كلها معاً أو لا شيء) وهذا أسهل بكثير داخل Transaction واحدة على قاعدة بيانات واحدة.
- الفصل الداخلي الصارم (Domain Services + Repositories) يجعل الانتقال لـ Microservices لاحقاً (لو احتجنا) إعادة توزيع وليس إعادة كتابة.

### طبقات النظام (Layered Architecture)

```
┌─────────────────────────────────────────────────────────────┐
│  Presentation Layer                                          │
│  - ERP Web App (React, RTL, Desktop-first)                   │
│  - POS Web App (React PWA, Offline-First, منفصلة عن ERP UI) │
│  - Public REST API Clients (Mobile / Integrations مستقبلاً)  │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTPS / JSON (REST, versioned)
┌───────────────────────────▼───────────────────────────────────┐
│  API Layer (Controllers)                                     │
│  - Request validation (DTO + schema validation)               │
│  - AuthN/AuthZ enforcement (Guards)                            │
│  - Rate limiting / Idempotency handling                       │
│  - لا Business Logic هنا إطلاقاً                              │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│  Application Layer (Use Cases / Application Services)         │
│  - ينسّق بين Domain Services متعددة لتنفيذ Use Case كامل      │
│  - يدير Transaction Boundaries                                 │
│  - مثال: CreateSaleUseCase يستدعي InventoryEngine +            │
│    AccountingEngine + PaymentEngine + PromotionEngine          │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│  Domain Services / Business Engines (Core Business Logic)     │
│  - Inventory Engine   - Accounting Engine                      │
│  - Promotion Engine   - Payment Engine                          │
│  - Pricing Engine     - Tax Engine                               │
│  - Loyalty Engine     - Sync Engine (Offline POS)                │
│  - كل Engine Stateless قدر الإمكان، يعمل عبر Repositories       │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│  Repository Layer (Data Access Abstraction)                    │
│  - كل Aggregate له Repository (ProductRepository, SaleRepo...) │
│  - يخفي تفاصيل ORM/SQL عن باقي الطبقات                          │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│  Infrastructure Layer                                          │
│  - PostgreSQL (Primary DB)     - Redis (Cache/Queue/Locks)      │
│  - S3-Compatible Storage       - Job Queue (BullMQ)              │
│  - Email/SMS Providers          - Backup Providers                │
└─────────────────────────────────────────────────────────────┘
```

**القاعدة الصارمة**: الاتجاه دائماً من فوق لتحت. Controllers لا تكلّم Repositories مباشرة. Domain Services لا تعرف شيء عن HTTP. لا Business Logic في Controllers ولا في Repositories.

---

## 2. Recommended Tech Stack

### الاختيار: **Node.js + TypeScript + NestJS + React + PostgreSQL + Prisma**

| الطبقة | الاختيار |
|---|---|
| Backend Framework | NestJS (TypeScript) |
| ORM | Prisma (+ Raw SQL عند الحاجة للـ Reports المعقدة) |
| Database | PostgreSQL 16+ |
| Cache / Queue / Locks | Redis + BullMQ |
| ERP Frontend | React + TypeScript + Vite + TanStack Query + Zustand |
| POS Frontend | React + TypeScript PWA + IndexedDB (Dexie.js) |
| Auth | JWT (Access + Refresh) + Session Revocation via Redis |
| Realtime (اختياري لاحقاً) | WebSocket (Socket.IO) لتحديثات لحظية (المخزون، الإشعارات) |
| API Docs | OpenAPI/Swagger مولّد من NestJS Decorators |
| Testing | Vitest/Jest (Unit) + Supertest (Integration) + Playwright (E2E) |
| Deployment | Docker containers، Reverse Proxy (Nginx/Traefik) |

### لماذا هذا الـ Stack؟

**لماذا Node.js + TypeScript موحّد على Backend و Frontend؟**
لأن الـ Offline-First POS يحتاج مشاركة نفس الـ Domain Types (Product, SaleItem, Payment...) وربما نفس منطق الـ Validation بين الـ Server والـ Client (IndexedDB). TypeScript Monorepo (npm/pnpm workspaces) يتيح مشاركة `packages/shared-types` و `packages/shared-validation` بين Backend و POS Frontend، فيقل خطر Drift بين ما يُحفظ محلياً وما يُقبل على السيرفر عند الـ Sync.

**لماذا يناسب ERP؟**
NestJS يفرض بنية Modular (Modules, Providers, Dependency Injection) قريبة جداً من Java/Spring أو Laravel من ناحية الانضباط المعماري، وهو مناسب لحجم Domain كبير مثل هذا (60+ Entity) لأنه يجبر فصل الـ Concerns (Controllers/Services/Repositories) بدل الانزلاق إلى Script كبير.

**لماذا يناسب POS؟**
React + Vite تعطي تحميل سريع جداً وTouch/Keyboard-friendly UI عالي الأداء، وهو ضروري لواجهة كاشير تُستخدم آلاف المرات يومياً.

**لماذا يناسب Offline-First؟**
PWA Service Worker + IndexedDB (عبر Dexie.js) بيئة ناضجة جداً في عالم JS/TS، ومشاركة الـ Types مع الباك إند (كما ذكرت) تقلل أخطاء الـ Sync. كذلك Node.js/TS يسمح بكتابة نفس منطق الـ Conflict Resolution وToken الـ Idempotency على الطرفين بسهولة.

**لماذا PostgreSQL؟**
- يدعم Transactions حقيقية + Row-Level Locking (`SELECT ... FOR UPDATE`) وهو أساس منع الـ Race Conditions في المخزون.
- Row Level Security (RLS) قوي جداً للـ Multi-Tenancy.
- Check Constraints, Partial Indexes, Numeric Types دقيقة (`NUMERIC` بدل `FLOAT`) لأي مبلغ مالي أو كمية — ضروري في محاسبة حقيقية.
- Extensions مفيدة: `pg_trgm` للبحث السريع (Global Search)، `uuid-ossp`/`pgcrypto`.

**Deployment**: Docker Compose للتطوير، ثم Containers خلف Nginx/Traefik في الإنتاج (Docker Swarm أو Kubernetes حسب الحجم). قاعدة البيانات على Managed PostgreSQL (RDS/Cloud SQL أو ما يعادله) مع Read Replica مستقبلاً للتقارير الثقيلة.

**Scaling**: 
- أفقياً: Backend Stateless (Session في Redis) → يمكن تشغيل نسخ متعددة خلف Load Balancer.
- Read Replica لـ PostgreSQL لفصل Reporting Queries عن Transactional Load.
- Redis للـ Caching + Distributed Locks (منع Race Conditions عبر أكثر من Instance).
- Job Queue (BullMQ) للعمليات الثقيلة (توليد تقارير كبيرة، Export، إرسال إشعارات) بعيداً عن الـ Request/Response cycle.

هذا الـ Stack **ثابت** ولن يتغير أثناء المشروع إلا بسبب قوي موثّق في PROJECT_STATE.md.

---

## 3. Module Architecture (خريطة الموديولات)

```
apps/
 ├─ api/                     # NestJS Backend (Modular Monolith)
 │   modules/
 │    ├─ iam/                # Auth, Users, Roles, Permissions
 │    ├─ tenancy/             # Businesses, Branches, Warehouses, Settings
 │    ├─ catalog/             # Products, Variants, Attributes, UOM, Barcodes, Bundles, Prices
 │    ├─ inventory/           # Stock Ledger, Balances, Counts, Transfers, Lots, Serials
 │    ├─ purchasing/          # Suppliers, Purchases, Purchase Returns, Supplier Ledger
 │    ├─ sales/               # Sales, POS Orders, Returns, Exchanges
 │    ├─ pos-sync/            # Offline Sync Engine, Devices, Sync Queue
 │    ├─ finance/             # Financial Accounts, Cash Registers, Shifts, Expenses
 │    ├─ accounting/          # Chart of Accounts, Journal Entries, GL, Fiscal Periods
 │    ├─ pricing-promotions/  # Price Lists, Promotions Engine
 │    ├─ tax/                 # Tax Engine
 │    ├─ loyalty/             # Loyalty Points
 │    ├─ warranty/            # Warranties
 │    ├─ customers/           # Customers, Customer Ledger
 │    ├─ reporting/           # Dashboard, Reports, Exports
 │    ├─ notifications/       # Notification Center
 │    ├─ audit/               # Audit Logs (Immutable)
 │    ├─ import-export/       # Bulk Import/Export
 │    └─ platform/            # Backups, System Settings, Health
 ├─ erp-web/                 # ERP Frontend (React)
 └─ pos-web/                 # POS PWA Frontend (React + Offline)

packages/
 ├─ shared-types/            # Domain Types مشتركة (DTOs, Enums)
 ├─ shared-validation/       # Zod Schemas مشتركة (Backend + POS Offline)
 └─ ui-kit/                  # مكونات UI مشتركة بين ERP و POS (اختياري)
```

**Engines أفقية (Cross-Module)**: `InventoryEngine`, `AccountingEngine`, `PromotionEngine`, `TaxEngine`, `PaymentEngine`, `SyncEngine` — هذه ليست Modules خدماتية للـ HTTP، بل Domain Services يتم حقنها (DI) داخل الـ Application Layer لأي Module يحتاجها (مثلاً `sales` يحقن `InventoryEngine` و `AccountingEngine` و `PromotionEngine` لإتمام عملية بيع).

---

## 4. Database ERD (مجمّعة حسب النطاق)

> نظراً لحجم الـ Schema (60+ كيان)، الـ ERD مقسّم حسب الـ Domain بدل رسم واحد ضخم غير قابل للقراءة.

### 4.1 Tenancy & Identity
```
Business (Tenant) 1───* Branch 1───* Warehouse
Business 1───* User
User *───* Role (via UserRole)
Role *───* Permission (via RolePermission)
Branch 1───* CashRegister 1───* Shift
Branch 1───* FinancialAccount
```

### 4.2 Catalog
```
Category 1───* Category (self, Subcategory)
Brand 1───* Product
Category 1───* Product
Product 1───* ProductVariant
Product 1───* ProductAttribute *───* ProductAttributeValue (via VariantAttributeValue)
ProductVariant 1───* Barcode
ProductVariant *───1 UOM (Base) ; Product 1───* UOMConversion
PriceList 1───* ProductPrice ──> ProductVariant
ProductPrice 1───* ProductPriceHistory
Bundle 1───* BundleItem ──> ProductVariant
```

### 4.3 Inventory
```
ProductVariant 1───* StockMovement ──> Warehouse
StockMovement *───1 MovementType (enum)
ProductVariant + Warehouse ──(derived)──> StockBalance   [Materialized/derived, NEVER source of truth]
StockCount 1───* StockCountItem
StockTransfer 1───* StockTransferItem
ProductVariant 1───* InventoryLot (Batch/Expiry)
ProductVariant 1───* SerialNumber
```
**StockBalance جدول Cache/Snapshot مُشتق من StockMovement (يُعاد حسابه دورياً/Trigger)، وليس مصدر الحقيقة أبداً.**

### 4.4 Purchasing
```
Supplier 1───* Purchase 1───* PurchaseItem ──> ProductVariant
Purchase 1───* PurchasePayment ──> FinancialAccount
Purchase 1───* PurchaseReturn 1───* PurchaseReturnItem
Supplier 1───* SupplierTransaction (Ledger)
```

### 4.5 Sales / POS
```
Customer 1───* Sale 1───* SaleItem ──> ProductVariant
Sale 1───* SalePayment ──> FinancialAccount
Sale 1───* SaleReturn 1───* SaleReturnItem
Sale *───1 Shift ; Sale *───1 Branch ; Sale *───1 Warehouse
Customer 1───* CustomerTransaction (Ledger)
Customer 1───* CustomerPoints (Loyalty Ledger)
Device 1───* SyncQueueItem ──> Sale (offline-created)
```

### 4.6 Finance & Accounting
```
Account (ChartOfAccounts) 1───* Account (self, sub-accounts)
JournalEntry 1───* JournalEntryLine ──> Account
FiscalPeriod 1───* JournalEntry
Shift 1───* CashTransaction ──> FinancialAccount
Expense *───1 ExpenseCategory ; Expense *───1 FinancialAccount
RecurringExpense 1───* Expense (generated)
```

### 4.7 Cross-Cutting
```
Every主要 Entity ──> AuditLog (polymorphic: entity_type, entity_id)
Every主要 Entity ──> Attachment (polymorphic)
Notification *───1 User
Tax 1───* TaxRate
Warranty ──> SerialNumber / SaleItem / Customer
```

كل جدول Transactional (Purchase, Sale, JournalEntry, StockMovement...) يحمل `tenant_id`, `branch_id` (عند الانطباق), `created_by`, `updated_by`, `created_at`, `updated_at`.

---

## 5. Database Design Strategy

### Multi-Tenancy: **Shared Database, Shared Schema + `tenant_id` + PostgreSQL Row-Level Security (RLS)**

القرار: **Tenant ID Isolation مع RLS مفروض على مستوى قاعدة البيانات نفسها**، وليس فقط `WHERE tenant_id = ?` في الكود.

**لماذا؟**
- بداية المشروع بعدد Tenants محدود (محلات ملابس) → Database-per-tenant Overkill تشغيلياً (Migrations على مئات القواعد).
- Schema-per-tenant يعقّد الـ Migrations والـ Connection Pooling بلا فائدة حقيقية في هذا الحجم.
- RLS تمنع تسرّب البيانات حتى لو نسي مطوّر شرط `WHERE tenant_id` في استعلام — الـ Database نفسها ترفض إرجاع صفوف من Tenant آخر. هذا يحقق **قاعدة "لا تسمح بتجاوز Tenant Isolation" على مستوى الـ Infrastructure وليس فقط الكود.**
- الجلسة (Connection) تُمرَّر عبر `SET app.current_tenant_id = '...'` في بداية كل Request (Middleware)، وكل Policy تستخدم هذه القيمة.
- الترقية لاحقاً إلى Database-per-tenant لعملاء Enterprise كبار ممكنة دون تغيير الـ Application Layer (فقط طبقة الاتصال).

### قواعد عامة
- `NUMERIC(18,4)` لكل قيم المال والكمية (لا `FLOAT` إطلاقاً).
- كل جدول مرجعي مهم: `UNIQUE (tenant_id, sku)`, `UNIQUE (tenant_id, barcode)` إلخ (الـ Uniqueness دائماً ضمن الـ Tenant).
- Soft-Delete/Status بدل Hard Delete للمستندات المالية (`status: draft/posted/cancelled/voided`).
- Migrations عبر Prisma Migrate، مُراجَعة يدوياً قبل أي Migration تمس بيانات موجودة.
- Indexes: كما هو مذكور في قسم 55 من الطلب (SKU, Barcode, Invoice Number, أرقام الهواتف, التواريخ, Foreign Keys, Status) + Composite Indexes مع `tenant_id` كأول عمود دائماً.

---

## 6. Accounting Architecture

**محرك Double-Entry حقيقي، منفصل تماماً عن باقي الموديولات، ولا يُستدعى إلا عبر واجهة واحدة: `AccountingEngine.postEntry(...)`.**

### القواعد الصارمة
1. لا يمكن إنشاء `JournalEntry` إلا متوازنة: `SUM(debit lines) === SUM(credit lines)` — يُتحقق منها **قبل** الـ Insert داخل نفس الـ DB Transaction، وأيضاً عبر `CHECK`/Trigger احتياطي على مستوى القاعدة كخط دفاع ثانٍ.
2. الحالات: `Draft → Posted → (Reversed)`. لا `Update` على قيد `Posted`. أي تصحيح = قيد عكسي (`Reversal Entry`) يشير لأصل القيد (`reversal_of_id`).
3. كل عملية تجارية مؤثرة مالياً تمر عبر **Mapping Table صريح** (Accounting Rules Configuration) يحدد أي حسابات تُخصم/تُضاف حسب نوع العملية (Sale Cash, Sale Credit, COGS, Purchase, Purchase Return, Supplier Payment, Customer Payment, Expense, Sales Return...) — هذه القواعد Configuration في جدول `AccountingMappingRule` وليست `if/else` متناثرة في الكود، بحيث يمكن لكل Tenant لاحقاً تخصيص الحسابات (مثلاً حساب "إيرادات مبيعات" مختلف حسب فئة المنتج).
4. `FiscalPeriod`: القيود تُربط بفترة مالية؛ إغلاق الفترة (`Period Closing`) يمنع أي قيد جديد بتاريخ داخل فترة مُغلقة إلا عبر صلاحية خاصة (`accounting.reopen_period`).
5. تقارير `Trial Balance`, `Income Statement`, `Balance Sheet`, `Cash Flow` كلها **مُشتقة** من `JournalEntryLine` مباشرة (لا جداول تجميع يدوية منفصلة عن الحقيقة) — تُحسب Live أو عبر Materialized View مُحدَّثة.

### مثال تدفق Sale (Cash):
```
SaleUseCase (Application Layer, DB Transaction واحدة):
 1) Insert Sale + SaleItems
 2) InventoryEngine.consume(...)      → StockMovement (type=Sale) لكل بند
 3) حساب COGS = SUM(quantity × applied_cost عند لحظة الحركة)  [WAC وقتها]
 4) PaymentEngine.recordPayments(...) → SalePayment لكل طريقة دفع
 5) AccountingEngine.postEntry({
       Debit  Cash/Card/Wallet Account   = إجمالي المدفوع
       Debit  Accounts Receivable        = المتبقي (لو Credit Sale)
       Credit Sales Revenue              = صافي المبيعات
       Credit Tax Payable                = الضريبة (لو منفصلة)
       Debit  COGS                       = تكلفة البضاعة المباعة
       Credit Inventory                  = نفس القيمة
    })
 6) لو فيه عميل: CustomerLedger entry
 COMMIT كل شيء معاً، أو ROLLBACK الكل.
```

---

## 7. Inventory Architecture

**مصدر الحقيقة الوحيد: `StockMovement` (Append-Only Ledger). `StockBalance` مجرد Snapshot مُشتق (Cache) يُعاد بناؤه من الـ Ledger عند الحاجة للتحقق (Reconciliation Report).**

### التكلفة: Weighted Average Cost (WAC) كـ Default
- عند كل `Purchase`: `new_avg_cost = (old_qty × old_avg_cost + purchased_qty × purchase_cost) / (old_qty + purchased_qty)` — يُحفظ على مستوى `ProductVariant + Warehouse` (أو على مستوى المنتج حسب إعداد Tenant).
- عند كل `Sale`/خروج: `applied_cost` (المُطبَّق فعلياً على تلك الحركة) = الـ WAC **وقت الحركة**، ويُحفظ **داخل** الـ `StockMovement` نفسه (`unit_cost_at_movement`). هذا يضمن أن **تغيير التكلفة الحالية لاحقاً لا يغيّر COGS التاريخي إطلاقاً**، لأن كل حركة قديمة تحمل تكلفتها الخاصة وقت حدوثها.
- الهيكلة (Interface `CostingStrategy`) تسمح بإضافة `FIFOCostingStrategy` أو `SpecificCostStrategy` لاحقاً دون تغيير بقية النظام (Strategy Pattern).

### Concurrency & Race Conditions
- عند البيع: `SELECT ... FOR UPDATE` على صف `StockBalance` (أو Row Lock مكافئ) للـ Variant+Warehouse قبل التحقق من التوافر وإنشاء الحركة، داخل نفس الـ DB Transaction. لو كاشيران يحاولان بيع آخر وحدة لحظياً، الثاني يُرفض بخطأ "Insufficient Stock" فور فشل التحقق بعد الحصول على القفل.
- `Available = On Hand - Reserved` — الحجز (`Reserved`) يُستخدم في حالات الفواتير المعلّقة (Held Invoices في POS) أو الطلبات المؤكدة غير المُسلَّمة.
- Negative Inventory: **Disabled افتراضياً** (Setting `inventory.allow_negative_stock` على مستوى Tenant/Warehouse)، وإن فُعِّل يتطلب Permission خاص وتُعلَّم الحركة `is_negative_stock=true` لتظهر بوضوح في التقارير.

### Stock Movement Types
كما هو محدد في الطلب (Opening Balance, Purchase, Sale, Sales/Purchase Return, Transfer In/Out, Stock Count, Adjustment, Damage, Loss, Internal Consumption, Expiry, Bundle Consumption, Authorized Correction) — enum مُحكم، وكل حركة تحمل `reference_type` + `reference_id` (Polymorphic) للربط بالمستند الأصلي.

---

## 8. Offline-First POS Architecture

### البنية
```
POS PWA (React + Service Worker)
 ├─ Local DB: IndexedDB via Dexie.js
 │   Tables: products_cache, prices_cache, customers_cache,
 │            pending_sales (outbox), sync_log
 ├─ Sync Engine (يعمل في Background عبر Service Worker + navigator.onLine)
 └─ Server: /api/v1/pos-sync/*
```

### آلية العمل
1. **عند الاتصال متاح**: تحميل/تحديث Cache دوري (منتجات، أسعار، عملاء نشطين، إعدادات الفرع) في IndexedDB.
2. **عند انقطاع الاتصال**: البيع يُسجَّل محلياً في `pending_sales` بحالة `Pending`، مع:
   - `device_id` (ثابت لكل جهاز POS، يُنشأ عند أول تفعيل)
   - `offline_transaction_id` (UUID يُنشأ Client-side)
   - `idempotency_key` = `hash(device_id + offline_transaction_id)` — **هذا هو المفتاح الذي يمنع الـ Duplicate عند إعادة المحاولة**
   - `local_timestamp`
   - `sync_status: pending`
3. **عودة الاتصال**: Sync Engine يرسل الطابور دفعة بدفعة (Batch) إلى `POST /api/v1/pos-sync/transactions`.
4. **الخادم عند الاستلام**:
   - يبحث عن `idempotency_key` في جدول `SyncQueue`/`Sale` — لو موجود مسبقاً (نجح سابقاً لكن الـ ACK ضاع) → يُرجع نفس النتيجة المحفوظة (Idempotent Response) **دون** إعادة تنفيذ العملية.
   - لو جديد: يُنفَّذ نفس `CreateSaleUseCase` تماماً (نفس المسار المُستخدم للبيع Online)، ضمن Transaction، مع فحص المخزون **وقت الوصول للسيرفر** (وليس وقت الالتقاط Offline، لأن المخزون قد يتغيّر).
   - **Conflict**: لو نتج عن التحقق نقص مخزون (بيع أوفلاين لكمية لم تعد متوفرة) → الحالة تصبح `Conflict` وليس فشل صامت؛ تُنشأ Notification للمدير لمراجعتها يدوياً (قبول جزئي/رفض/تسوية) — لا يُسمح للسيرفر بأن "يخترع" مخزون سالب تلقائياً إلا لو `allow_negative_stock` مفعّل صراحة.
5. **Sync Status لكل معاملة**: `Pending → Syncing → Synced | Failed | Conflict`, مع `retry_count` و`last_error` و Exponential Backoff للمحاولات.
6. **Sync Logs**: كل محاولة مزامنة تُسجَّل (نجاح/فشل/سبب) لأغراض الـ Audit والدعم الفني.

### Hardware Integration (من داخل الـ POS PWA)
- Barcode Scanner: يعمل كـ Keyboard Input (HID) → Listener على مستوى الصفحة يميّز الإدخال السريع المتتابع كمسح باركود.
- ESC/POS Thermal Printer + Cash Drawer: عبر WebUSB/WebSerial أو من خلال Local Print Agent صغير (خدمة محلية اختيارية) للتوافق مع طابعات لا تدعم WebUSB.
- Barcode Label Printer: توليد Labels (PDF/ZPL) من السيرفر أو محلياً.

---

## 9. Roles & Permissions Matrix (مبدئي)

نظام صلاحيات **Granular** (Resource × Action)، مُخزَّن كـ `Permission(code)` مثل `sales.create`, `inventory.adjust`, `reports.view_financial`, `products.change_cost`. الأدوار (`Role`) مجموعات قابلة للتخصيص لكل Tenant (ليست Hardcoded بالكامل)، مع أدوار افتراضية جاهزة:

| Role | أمثلة صلاحيات افتراضية |
|---|---|
| Super Admin | كل شيء، عبر كل الـ Tenants (فريق المنصة فقط) |
| Business Owner | كل شيء داخل Tenant الخاص به |
| Branch Manager | إدارة فرعه: مبيعات، مخزون، مصاريف، تقارير الفرع، اعتماد الجرد |
| Accountant | القيود المحاسبية، التقارير المالية، لا صلاحية بيع/POS |
| Inventory Manager | المنتجات، المخزون، الجرد، التحويلات، الشراء (بدون اعتماد دفعات) |
| Cashier | POS فقط: بيع، إرجاع محدود، فتح/إغلاق وردية، بدون رؤية التكلفة/الربح |
| Sales Employee | مبيعات + عملاء، بدون تعديل أسعار/تكلفة |

كل Permission لها تصنيف: `view / create / edit / delete / cancel / approve / export / print / refund / change_price / change_cost / view_cost / view_profit / view_financial_reports / manage_users / manage_settings / manage_backups`.

**القاعدة الحرجة: كل تحقق صلاحية يتم Server-Side (NestJS Guards + Decorators على مستوى كل Endpoint/Use Case)، الواجهة (Frontend) تُخفي فقط الأزرار للـ UX — لا تُعتبر مصدر حماية أبداً.**

---

## 10. Main Business Rules (ملخص القواعد الحاكمة)

1. `StockMovement` = مصدر الحقيقة للمخزون. `JournalEntryLine` = مصدر الحقيقة المالية. لا تعديل رصيد مباشر بدون حركة/قيد.
2. كل عملية حرجة (بيع، شراء، إرجاع، تحويل، جرد معتمد) = DB Transaction ذرّية واحدة: تنجح كلياً أو تتراجع كلياً.
3. COGS يُحسب من `unit_cost_at_movement` المحفوظ وقت الحركة، أبداً من `current_cost - current_price`.
4. لا `JournalEntry` غير متوازنة يمكن أن تُحفظ بحالة `Posted`.
5. لا حذف فعلي (`Hard Delete`) للفواتير/القيود/المدفوعات المعتمدة — فقط `Cancel/Void/Reverse` مع مستخدم وسبب وتاريخ.
6. الأرصدة (عميل/مورد) مُشتقة من الـ Ledger (`SUM` للحركات)، وليست حقلاً يُعدَّل مباشرة.
7. Negative Inventory ممنوعة افتراضياً، Configurable per Tenant/Warehouse مع صلاحية خاصة.
8. Idempotency Key إلزامي لكل عملية POS (أونلاين وأوفلاين) لمنع التكرار.
9. تغيير الأسعار لا يؤثر رجعياً على الفواتير القديمة (كل بند فاتورة يحمل سعره وقت البيع).
10. كل عملية حساسة (تغيير سعر/تكلفة، إلغاء فاتورة، إرجاع، تعديل مخزون، اعتماد شراء/جرد، صلاحيات، نسخ احتياطي) تُسجَّل في `AuditLog` غير قابل للتعديل.

---

## 11. Main User Flows (مختصر)

- **Onboarding**: تسجيل Business → إنشاء Branch/Warehouse/Register افتراضي → دعوة مستخدمين → إعداد Chart of Accounts افتراضي → إعداد الضرائب/العملة.
- **إعداد كتالوج**: إنشاء Category/Brand → إنشاء Product → إضافة Attributes (لون/مقاس) → توليد Variants → تسعير → باركود → مخزون افتتاحي.
- **دورة الشراء**: إنشاء Purchase (Draft) → اعتماد → زيادة مخزون + تحديث تكلفة WAC + Payable → دفعة (كاملة/جزئية) → قيد محاسبي تلقائي.
- **دورة البيع (POS)**: فتح وردية → مسح باركود/بحث → إضافة للسلة → خصم/عرض → دفع (نقدي/بطاقة/محفظة/مختلط) → طباعة إيصال → خصم مخزون + COGS + إيراد + قيد محاسبي.
- **إرجاع/استبدال**: ربط بالفاتورة الأصلية → تحديد الحالة (صالح/تالف) → تعديل مخزون حسب الحالة → عكس الإيراد/COGS → تسوية الفرق نقداً أو استرداد.
- **إغلاق الوردية**: Blind Close (إدخال المبلغ الفعلي دون رؤية المتوقع) → Reconciliation من المدير (مقارنة المتوقع بالفعلي) → تسجيل الفرق محاسبياً.
- **الجرد**: Draft → عد → رفع → مراجعة واعتماد → توليد Stock Adjustment تلقائياً.
- **التقارير الشهرية/الإغلاق**: اختيار الفترة → توليد التقرير (مبيعات، مصاريف، أرباح، مقارنة بالشهر/العام السابق) → تصدير PDF/Excel.

---

## 12. Folder Structure (مبدئي - Monorepo)

```
/ (repo root)
 ├─ apps/
 │   ├─ api/                       # NestJS backend
 │   │   ├─ src/
 │   │   │   ├─ modules/<module>/
 │   │   │   │   ├─ presentation/  # controllers, dto
 │   │   │   │   ├─ application/   # use-cases
 │   │   │   │   ├─ domain/        # entities, services, interfaces
 │   │   │   │   ├─ infrastructure/# repositories (prisma impl)
 │   │   │   │   └─ <module>.module.ts
 │   │   │   ├─ engines/           # InventoryEngine, AccountingEngine, ...
 │   │   │   ├─ common/            # guards, interceptors, filters, decorators
 │   │   │   └─ main.ts
 │   │   ├─ prisma/schema.prisma
 │   │   └─ test/
 │   ├─ erp-web/                   # React ERP app
 │   └─ pos-web/                   # React POS PWA
 ├─ packages/
 │   ├─ shared-types/
 │   ├─ shared-validation/
 │   └─ ui-kit/
 ├─ docs/
 │   ├─ architecture/              # هذا الملف وما يليه
 │   └─ state/                     # PROJECT_STATE.md لكل Phase
 ├─ docker-compose.yml
 └─ package.json (workspaces)
```

---

## 13. API Architecture

- **REST, API-First, Versioned**: `/api/v1/...` — لا Breaking Changes بدون نسخة جديدة (`/api/v2`).
- **Endpoints رئيسية** (أمثلة، ستتوسع تدريجياً): `/api/v1/{auth, users, roles, businesses, branches, warehouses, products, product-variants, categories, brands, uom, price-lists, promotions, inventory/movements, inventory/balances, stock-counts, stock-transfers, suppliers, purchases, purchase-returns, customers, sales, sale-returns, pos-sync, cash-registers, shifts, financial-accounts, expenses, accounting/accounts, accounting/journal-entries, reports/*, notifications, audit-logs, settings}`.
- **قواعد موحدة**: Pagination (`?page&limit`), Filtering (`?filter[field]=`), Sorting (`?sort=-created_at`), Idempotency (`Idempotency-Key` header لكل POST حسّاس)، Standard Error Shape (`{ error: { code, message, details, requestId } }`)، Rate Limiting per Tenant/User.
- **Auth**: JWT Access Token قصير العمر + Refresh Token، مع `tenant_id` و`branch_scope` داخل الـ Claims، يُستخدم لضبط RLS Session Variable.
- **Docs**: Swagger/OpenAPI تلقائي من الكود، يبقى مصدر الحقيقة لعقد الـ API.

---

## 14. Security Architecture

- **AuthN**: Password Hashing (argon2id)، JWT + Refresh Rotation، Session Revocation عبر Redis Blacklist، دعم 2FA لاحقاً.
- **AuthZ**: Guards على مستوى كل Endpoint (RBAC + Permission-based)، تحقق إضافي داخل Use Cases الحساسة (Defense in Depth).
- **Tenant Isolation**: PostgreSQL RLS + `tenant_id` إلزامي على كل استعلام + Middleware يضبط الـ Session قبل أي Query.
- **Input Validation**: DTO Validation صارم (class-validator/Zod) على كل Endpoint، رفض أي حقل غير متوقع.
- **Protection**: Parameterized Queries عبر Prisma (Immune لـ SQL Injection)، CSRF Protection للـ ERP Web (SameSite Cookies + CSRF Token)، XSS Protection (Sanitization + CSP Headers)، Rate Limiting (per IP + per User + per Tenant)، Secure File Upload (Type/Size Validation + Virus Scan لاحقاً + تخزين خارج الـ Web Root).
- **Audit**: كل Action حساس → `AuditLog` غير قابل للتعديل (Append-Only، بدون UPDATE/DELETE Permission حتى لـ Super Admin على مستوى الـ DB Role).
- **Backups**: تلقائي دوري + يدوي، مُشفّر، تخزين خارجي (S3-Compatible)، اختبار Restore دوري، صلاحية Restore لـ Super Admin/Business Owner فقط.

---

## 15. Development Phases

سيتم تنفيذ المشروع حسب المراحل المتفق عليها في الطلب الأصلي (Phase 0 → Phase 10)، بدون الانتقال لمرحلة جديدة إلا بعد:
1. اجتياز Acceptance Criteria الخاصة بالمرحلة.
2. عدم وجود أخطاء أساسية في الـ Business Logic/Database Integrity/Security.
3. موافقتك الصريحة.

في نهاية كل Phase سيتم إنشاء/تحديث `docs/state/PROJECT_STATE.md` يحتوي: Current Phase, Completed/Pending Features, Architecture Decisions, DB Changes, Migrations, API Endpoints, Files Created/Modified, Tests Added, Known Issues, Business Rules المهمة, Next Phase — بحيث لا تُفقد القرارات بين الجلسات الطويلة.

الترتيب: **Phase 0 (هذا المستند) → Phase 1 Foundation → Phase 2 Catalog → Phase 3 Inventory Engine → Phase 4 Purchasing → Phase 5 POS → Phase 6 Finance/Accounting → Phase 7 Reports → Phase 8 Advanced (Promotions/Loyalty/Warranty) → Phase 9 Security & Reliability → Phase 10 Production.**

---

## PHASE 0 STATUS
**READY FOR REVIEW**
