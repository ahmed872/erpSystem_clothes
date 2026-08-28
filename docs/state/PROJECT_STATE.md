# PROJECT STATE SUMMARY

## Current Phase
Phase 0 — Architecture & Analysis (**Complete, awaiting approval to start Phase 1**)

## Completed Features
- لا يوجد كود بعد. تم فقط توثيق التصميم المعماري الكامل.

## Pending Features
- كل الموديولات (Foundation → Production)، حسب خطة المراحل في `docs/architecture/PHASE-0-ARCHITECTURE.md` §15.

## Architecture Decisions
- **Style**: Modular Monolith (ليس Microservices) في الإطلاق، مقسّم داخلياً بحدود صارمة قابلة للفصل لاحقاً.
- **Stack**: Node.js + TypeScript + NestJS (backend) / React + Vite (ERP web) / React PWA + Dexie.js-IndexedDB (POS offline) / PostgreSQL 16+ + Prisma / Redis + BullMQ.
- **Multi-Tenancy**: Shared DB + Shared Schema + `tenant_id` + PostgreSQL Row-Level Security (RLS) مفروضة على مستوى الـ DB.
- **Inventory Source of Truth**: `StockMovement` (Append-Only Ledger). `StockBalance` = Cache/Snapshot مُشتق فقط.
- **Costing Method**: Weighted Average Cost (WAC) افتراضياً، مع `unit_cost_at_movement` محفوظ داخل كل حركة (تصميم يسمح بإضافة FIFO/Specific لاحقاً عبر Strategy Pattern).
- **Accounting Source of Truth**: `JournalEntryLine`. لا Update على قيود Posted؛ التصحيح فقط عبر Reversal Entry. Debits=Credits إلزامي (تحقق في الكود + Check/Trigger احتياطي في DB).
- **Offline POS**: PWA + IndexedDB، Idempotency Key = hash(device_id + offline_transaction_id)، حالات Sync: Pending/Syncing/Synced/Failed/Conflict، لا اختراع مخزون سالب تلقائياً عند التعارض.
- **Concurrency**: Row-Level Locking (`SELECT ... FOR UPDATE`) على أرصدة المخزون داخل Transaction ذرّية لكل عملية بيع/شراء/تحويل.
- **Permissions**: RBAC Granular (Resource×Action)، تحقق Server-Side إلزامي (NestJS Guards)، الواجهة لا تُعتبر مصدر حماية.

## Database Changes
- لم يتم إنشاء Schema فعلي بعد. الـ ERD النصي موثّق في `docs/architecture/PHASE-0-ARCHITECTURE.md` §4.

## Migrations
- لا يوجد بعد.

## API Endpoints
- لا يوجد بعد. القائمة المبدئية للمسارات في `docs/architecture/PHASE-0-ARCHITECTURE.md` §13.

## Files Created
- `docs/architecture/PHASE-0-ARCHITECTURE.md`
- `docs/state/PROJECT_STATE.md` (هذا الملف)

## Files Modified
- لا يوجد.

## Tests Added
- لا يوجد بعد (سيبدأ من Phase 1).

## Known Issues
- لا يوجد (لم يبدأ التنفيذ بعد).

## Important Business Rules (مرجع سريع)
1. StockMovement = مصدر حقيقة المخزون. JournalEntryLine = مصدر الحقيقة المالية.
2. كل عملية حرجة = DB Transaction ذرّية (الكل أو لا شيء).
3. COGS من `unit_cost_at_movement` وقت الحركة، أبداً من السعر/التكلفة الحاليين.
4. لا Hard Delete للمستندات المالية المعتمدة — فقط Cancel/Void/Reverse.
5. الأرصدة (عميل/مورد) مُشتقة من الـ Ledger دائماً.
6. Negative Inventory معطّلة افتراضياً، Configurable مع صلاحية خاصة.
7. Idempotency Key إلزامي لكل عملية POS.
8. لا JournalEntry غير متوازنة يمكن أن تُحفظ Posted.
9. كل Action حساس → AuditLog غير قابل للتعديل.

## Next Phase
**Phase 1 — Foundation**: Project Setup (Monorepo), Auth, Users, Roles, Permissions, Business, Settings, Branches, Warehouses.
**لن يبدأ إلا بعد موافقة صريحة من صاحب المشروع على تصميم Phase 0.**
