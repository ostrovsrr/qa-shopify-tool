# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.
`CLAUDE.md` is the fuller, authoritative version of the same guidance — read it when in doubt.

## Project

Internal QA tool for Shopify CSV migrations, with two sections served by one server, one client, and one PostgreSQL database:

- **Customers** (`/customers`): upload a Customer CSV, map columns, run the validation rules (on the template dataset the import would send), store results, download an Excel report. Optionally import into Shopify test stores and report what Shopify accepted and rejected.
- **Products** (`/products`): upload a Shopify product template CSV (no column mapping; the import unit is a product, one per `Handle`), run the file-level pre-check (`validators/product/`, pinned to Shopify's admin CSV import), and import into one or more test stores in parallel, reporting which products imported and which Shopify rejected.

Customers and products are twins: a fix or decision that applies to one applies to both, in the same change.

**What this tool is for.** One question: *will Shopify accept this file?* Everything it
shows answers that — what Shopify took, what it rejected, and Shopify's own reason. It
deliberately does NOT report on how the pre-check scored: no "false positive", no "rule
gap", no over-strict/missing-rule buckets. Whether a validator is too strict is a question
for whoever maintains the validators, not for the person running a migration, and the
apparatus for it was removed on 2026-09-07. Do not add it back to a user-facing surface.

## Commands

Two separate packages — run commands from their respective directories.

**Server** (`cd server`)
```bash
npm run dev              # ts-node-dev with hot reload on port 3001
npm run build            # tsc → dist/
npm run typecheck        # TypeScript check without emitting files
npm test                 # unit/regression tests (no database required)
npm run test:integration # API tests; requires TEST_DATABASE_URL for a throwaway DB
npm run start            # run compiled dist/
npm run prisma:generate  # regenerate Prisma client after schema changes
npm run prisma:migrate   # CREATE a migration (migrate dev --create-only): writes SQL, applies nothing — review it
npm run prisma:deploy    # APPLY pending migrations (migrate deploy)
npm run prisma:studio    # open Prisma Studio GUI
```

**Never run bare `prisma migrate dev`.** The live DB has intentional drift
(`validation_runs.crossReferenceData` exists in the DB but not in `schema.prisma`) and the
drift check may offer a destructive reset.

**Client** (`cd client`)
```bash
npm run dev     # Vite dev server on port 5173 (proxies /api → localhost:3001)
npm run build   # tsc + vite build
```

**First-time setup**
```bash
# server/.env required:
DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/shopify_csv_qa"
PORT=3001
CLIENT_URL=http://localhost:5173

cd server && npm install && npm run prisma:generate && npm run prisma:deploy
cd ../client && npm install
```

CI builds both packages and runs the unit and PostgreSQL integration suites. There
is currently no linter configuration.

## Architecture

### Data flow — Customers
1. Client uploads CSV → `POST /api/customer-validation/preview` (returns parsed headers for column mapping)
2. User maps CSV columns on the `ColumnMappingScreen` and sets cleanup options (`POST /api/customer-validation/preview-effects` previews their effect; read-only)
3. Client submits mapping → `POST /api/customer-validation/validate` → runs the rules in `validators/customer/`, persists `ValidationRun`, `ValidationIssue`, and `OriginalCustomerRow`
4. Client displays results; user can download `GET /api/customer-validation/report/:id` as Excel
5. Optional: import into test stores via `/api/customer-import/*`

### Data flow — Products
1. `POST /api/product-upload` — parse, run the pre-check, persist rows grouped by `Handle` plus `ProductValidationIssue` records; pre-check report at `GET /api/product-upload/:id/report`
2. `POST /api/product-import/:uploadId/run` (or `/run-batch`), then poll `GET /api/product-import/:id`
3. Excel report via `GET /api/product-import/:id/report`

### Bulk ops per store (imports and QA cleanup, both flows)
Shopify allows 5 concurrent bulk mutations per shop, and one op is slow on its own, so each store's share of an import and each store's QA cleanup is split across up to `BULK_OPS_PER_STORE` ops (default 5, clamped 1..5; **1 is the kill switch** — one bulk op per store, still the batch path). Measured 2026-10-08 on a test store, 10k customers per side: create 1 op 4m15s vs 5 ops 59s (4.3×); delete 1 op 5m36s vs 5 ops 1m33s (3.6×) — `server/scripts/bulkTiming/timeBulkOps.ts` re-measures it.
- **Import:** every new import, single-store included, goes through the batch path. Job `i` belongs to store `i mod stores` (round-robin, so each store's total matches the client's per-store plan), `batchIndex = i`, `batchCount = stores × k`. `k` is uniform across a run's stores — the minimum over stores of what the shop has room for (ops already running on it count) — and is capped so every selected store gets work. Per-store views are derived from the per-job rows.
- **Locks:** the store lock is owned by the store's *share* of the run (owner types `IMPORT_STORE_SHARE` / `PRODUCT_IMPORT_STORE_SHARE`, id `<parentRunId>:<storeId>`), not by one job. It is released only when all of that store's jobs are terminal and none is outcome-unknown (`releaseShareIfDone` in `services/storeLock.service.ts`) — freeing it earlier would let a second import race a bulk op that may still be running.
- **Cleanup:** a `CleanupRun` is still one row per store and still owns the lock; its Shopify ops are rows in `cleanup_ops` (one per bulk delete; its slice is `splitIntoBatches(submittedIds, opCount)[opIndex]`). 50 ids or fewer still delete serially with no bulk op.

### Backend (`server/src/`)
- `controllers/` — Express route handlers; `middleware/errorHandler.ts` — correlation ids, log scrub, error responses
- `services/customerValidation.service.ts`, `csvParser.service.ts`, `columnMapping.service.ts` — customer flow
- `services/productUpload.service.ts`, `productImport.service.ts`, `productCsvParser.ts` — product flow
- `services/uploadFile.ts` — uploads stream to a temp file and are deleted by their consumer; raw CSVs are merchant PII
- `services/shopifyBulk.ts`, `shopifyClient.ts`, `config/shopify.ts` — shared Shopify bulk-import engine and store config
- `reports/` — Excel reports
- `db/prisma.ts` — singleton Prisma client; `loadEnv.ts` — must stay the first import of `index.ts`
- `validators/customer/`, `validators/product/` — one file per rule

### Frontend (`client/src/`)
- `/customers` → `pages/CustomerDashboard.tsx`, `/products` → `pages/ProductDashboard.tsx`
- `api/validationApi.ts` (customers), `api/productApi.ts` (products)
- Vite proxies `/api` to `http://localhost:3001` (configured in `vite.config.ts`)

### Database (Prisma / PostgreSQL)
One database. Customer models: `ValidationRun`, `ValidationIssue`, `OriginalCustomerRow`, `ImportRun`, `ImportBatchJob`, `ImportRowResult`. Product models: `ProductUploadRun`, `ProductImportRun`, `ProductImportJob`, `ProductImportResult`, `ProductOriginalRow`, `ProductValidationIssue`. Plus shared `CleanupRun`, store locks and the action log.

## Adding a Validation Rule

1. Create `server/src/validators/customer/myRule.rule.ts` implementing `CustomerValidationRule`:
   ```typescript
   import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

   export class MyRule implements CustomerValidationRule {
     name = 'MyRule';
     validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
       // return issues
     }
   }
   ```
2. Import and add the class to the array in `server/src/validators/customer/index.ts`.

Product rules follow the same pattern in `validators/product/` (`ProductValidationRule` takes `ProductGroup[]`).

The only severity is `'Error'`. Warning and Info were removed on 2026-09-07 — a rule that
fires for something Shopify imports without complaint is noise, so if a check would not
predict a real import rejection, do not add it.

## Sample Data

- `sample/shopify-customers-sample.csv` contains intentional errors covering the original 11 customer rules — use it for manual customer-flow testing.
- `sample/sample_products.csv` is a Shopify product template CSV for manual product-flow testing.
