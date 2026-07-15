# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

Internal tool for validating Shopify Customer CSV files before import. Upload a CSV, map columns, run 13 validation rules, store results in PostgreSQL, and download an Excel report.

## Commands

Two separate packages — run commands from their respective directories.

**Server** (`cd server`)
```bash
npm run dev              # ts-node-dev with hot reload on port 3001
npm run build            # tsc → dist/
npm run typecheck        # TypeScript check without emitting files
npm test                 # 160+ unit/regression tests (no database required)
npm run test:integration # API tests; requires TEST_DATABASE_URL for a throwaway DB
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

CI builds both packages and runs the unit and PostgreSQL integration suites. There
is currently no linter configuration.

## Architecture

### Data flow
1. Client uploads CSV → `POST /api/customer-validation/preview` (returns parsed headers for column mapping)
2. User maps CSV columns to Shopify fields on the `ColumnMappingScreen`
3. Client submits mapping → `POST /api/customer-validation/validate` → runs all 15 rules, persists `ValidationRun`, `ValidationIssue`, and `OriginalCustomerRow` records to Postgres
4. Client displays results; user can download `GET /api/customer-validation/report/:id` as Excel

### Backend (`server/src/`)
- `controllers/customerValidation.controller.ts` — Express route handlers
- `services/customerValidation.service.ts` — orchestrates parsing, validation, persistence
- `services/csvParser.service.ts` — CSV parsing and normalization
- `services/columnMapping.service.ts` — applies user-supplied column mapping
- `services/previewStore.ts` — in-memory temp store between preview and validate calls
- `reports/excelReport.ts` — generates multi-sheet Excel (Summary, Errors, Warnings, Info, Original Rows With Issues)
- `db/prisma.ts` — singleton Prisma client
- `validators/customer/` — one file per rule (see below)

### Frontend (`client/src/`)
- `api/validationApi.ts` — Axios API client
- `components/` — `UploadArea`, `ColumnMappingScreen`, `IssuesTable`, `SummaryCards`, `ValidationHistory`
- Vite proxies `/api` to `http://localhost:3001` (configured in `vite.config.ts`)

### Database (Prisma / PostgreSQL)
Three models: `ValidationRun` (metadata, column mapping, counts), `ValidationIssue` (per-issue records), `OriginalCustomerRow` (raw CSV rows for export).

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

`sample/shopify-customers-sample.csv` contains intentional errors covering all 13 rules — use it for manual testing.
