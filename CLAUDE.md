# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Internal QA tool for Shopify CSV migrations, with two sections served by one server, one client, and one PostgreSQL database:

- **Customers** (`/customers`): validate a Customer CSV before import — upload, map columns, run the validation rules, store results, download an Excel report. Optionally import into Shopify test stores and compare validator predictions against real import results.
- **Products** (`/products`): QA a Shopify product template CSV by importing it into one or more test stores (in parallel) and reporting which products imported and which Shopify rejected, grouped by `(field, code)`. **No validators/precheck and no column mapping** — the product CSV is already in Shopify template format, and the import unit is a **product** (one per CSV `Handle`, spanning multiple rows for variants/images), not a row. See `docs/products/` for the original design docs.

## Commands

Two separate packages — run commands from their respective directories.

**Server** (`cd server`)
```bash
npm run dev              # ts-node-dev with hot reload on port 3001
npm run build            # tsc → dist/
npm run start            # run compiled dist/
npm run prisma:generate  # regenerate Prisma client after schema changes
npm run prisma:migrate   # apply new migrations (prompts for migration name)
npm run prisma:studio    # open Prisma Studio GUI
```

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

cd server && npm install && npm run prisma:generate && npm run prisma:migrate
cd ../client && npm install
```

The server has vitest tests (`npm run test`, `npm run test:integration`, `npm run typecheck` from `server/`). There are no linter configs.

## Architecture

### Data flow — Customers
1. Client uploads CSV → `POST /api/customer-validation/preview` (returns parsed headers for column mapping)
2. User maps CSV columns to Shopify fields on the `ColumnMappingScreen`
3. Client submits mapping → `POST /api/customer-validation/validate` → runs all 13 rules, persists `ValidationRun`, `ValidationIssue`, and `OriginalCustomerRow` records to Postgres
4. Client displays results; user can download `GET /api/customer-validation/report/:id` as Excel
5. Optional: import into Shopify test stores via `/api/customer-import/*`

### Data flow — Products
1. Client uploads product CSV → `POST /api/product-upload` (parse + persist grouped by `Handle`; no mapping/validation)
2. Client starts an import → `POST /api/product-import/:uploadId/run` (single store) or `/run-batch` (parallel across stores), then polls `GET /api/product-import/:id` until terminal
3. Excel report via `GET /api/product-import/:id/report`; per-store product stats and QA cleanup via `/api/shopify/stores/:storeId/product-stats` and `/cleanup-qa-products` (the unsuffixed `/stats` and `/cleanup-qa` routes are the **customer** equivalents — don't mix them up: cleanup deletes qa-tagged customers vs products respectively)

### Backend (`server/src/`)
- `controllers/customerValidation.controller.ts` — Express route handlers
- `services/customerValidation.service.ts` — orchestrates parsing, validation, persistence
- `services/csvParser.service.ts` — CSV parsing and normalization
- `services/columnMapping.service.ts` — applies user-supplied column mapping
- `services/previewStore.ts` — in-memory temp store between preview and validate calls
- `reports/excelReport.ts` — generates multi-sheet Excel (Summary, Errors, Warnings, Info, Original Rows With Issues)
- `db/prisma.ts` — singleton Prisma client
- `validators/customer/` — one file per rule (see below)
- `services/shopifyBulk.ts`, `services/shopifyClient.ts`, `config/shopify.ts` — shared Shopify bulk-import engine used by both the customer and product flows (client requires customer + product scopes)
- `services/productUpload.service.ts`, `productImport.service.ts`, `productCsvParser.ts`, `productCleanup.service.ts`, `productFeedback.service.ts`, `reports/productImportReport.ts` — products flow

### Frontend (`client/src/`)
- React Router: `/customers` → `pages/CustomerDashboard.tsx`, `/products` → `pages/ProductDashboard.tsx` (switcher in each header)
- `api/validationApi.ts` (customers) and `api/productApi.ts` (products) — Axios API clients
- `components/` — customers: `UploadArea`, `ColumnMappingScreen`, `IssuesTable`, `SummaryCards`, `ValidationHistory`, `ImportPanel`; products: `ProductUploadArea`, `StoreImportControls`, `ProductResultsView`, `ProductHistory`
- Vite proxies `/api` to `http://localhost:3001` (configured in `vite.config.ts`)

### Database (Prisma / PostgreSQL)
One database (`shopify_csv_qa`). Customer models: `ValidationRun`, `ValidationIssue`, `OriginalCustomerRow`, `ImportRun`, `ImportBatchJob`, `ImportRowResult`. Product models: `ProductUploadRun`, `ProductImportRun`, `ProductImportJob`, `ProductImportResult`, `ProductOriginalRow`.

**Migration caveat:** the live DB has intentional drift (`validation_runs.crossReferenceData` exists in the DB but not in `schema.prisma`). Never run bare `prisma migrate dev` — its drift check may offer a destructive reset. Create migrations with `--create-only`, review the SQL, and apply with `prisma migrate deploy`.

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

## Sample Data

- `sample/shopify-customers-sample.csv` contains intentional errors covering all 13 rules — use it for manual customer-flow testing.
- `sample/sample_products.csv` is a Shopify product template CSV for manual product-flow testing.
