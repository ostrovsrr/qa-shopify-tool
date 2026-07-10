# File Manifest — copy / adapt / drop

Source repo: `../qa-shopify-tool`. Paths below are relative to that repo.
Action legend: **COPY** (use as-is), **ADAPT** (copy then modify for products), **DROP** (do
not bring over), **NEW** (write fresh in this repo).

## Server

| Source file | Action | Notes |
| --- | --- | --- |
| `server/package.json`, `tsconfig.json` | ADAPT | Same deps/stack; rename, drop nothing major. |
| `server/.env` (structure only) | ADAPT | New `DATABASE_URL` (new DB); reuse `SHOPIFY_*`. Never copy secrets via git. |
| `server/src/db/prisma.ts` | COPY | Singleton client. |
| `server/src/config/shopify.ts` | COPY | Multi-store config. |
| `server/src/services/shopifyClient.ts` | COPY | Retry/backoff, auth, token cache, health. |
| `server/src/services/shopifyImport.service.ts` | ADAPT | Split: extract generic bulk helpers (`stagedUpload`, `runBulkMutation`, `fetchBulkOperationState`, JSONL parse, `splitIntoBatches`, start/reconcile/batch) into `services/shopifyBulk.ts`; rewrite the customer-specific input/mutation into `services/productImport.service.ts`. |
| `server/src/services/importFeedback.service.ts` | ADAPT | Keep per-store grouping + counts; DROP four-bucket/`VALIDATOR_COVERAGE`/rule-gap. Add rejection-by-`(field,code)` grouping. |
| `server/src/services/shopifyCleanup.service.ts` | ADAPT | `customerDelete` -> `productDelete`; `customers(query:)` -> `products(query:)`. |
| `server/src/services/csvParser.service.ts` | ADAPT | Base CSV parsing; NEW `productCsvParser.ts` adds Handle grouping. |
| `server/src/services/previewStore.ts` | COPY | Only if you keep an upload preview step; otherwise DROP. |
| `server/src/controllers/customerImport.controller.ts` | ADAPT | -> `productImport.controller.ts`; routes `/product-import/*`. Keep the shared Shopify-error mapper. |
| `server/src/controllers/shopifyHealth.controller.ts` | COPY | Health/stores/stats/cleanup endpoints (adjust cleanup to products). |
| `server/src/controllers/customerValidation.controller.ts` | DROP | Validation/preview/mapping. NEW thin `productUpload.controller.ts` (upload -> persist run, no mapping/validate). |
| `server/src/reports/shopifyVerificationReport.ts` | ADAPT | -> `productImportReport.ts`; drop validator columns; results keyed by Handle. |
| `server/src/reports/validatorFeedbackReport.ts`, `reports/autoFix.ts` | DROP | Validator-specific. |
| `server/src/validators/**` | DROP | All 14 rules. |
| `server/src/services/columnMapping.service.ts` | DROP | No mapping. |
| `server/src/index.ts` | ADAPT | Express/multer/cors/error-handler skeleton; swap routes to product endpoints. |
| `server/prisma/schema.prisma` | ADAPT | See "Data model" below. Start CLEAN (no `crossReferenceData`). |
| `server/prisma/migrations/**` | DROP | Generate fresh migrations against the new DB. |

## Client

| Source file | Action | Notes |
| --- | --- | --- |
| `client/package.json`, `vite.config.ts`, `tsconfig*` | COPY | Same setup + `/api` proxy. |
| `client/src/main.tsx`, `App.tsx`, `pages/Dashboard.tsx` | ADAPT | Keep shell; products upload -> import flow (no mapping screen). |
| `client/src/index.css` | COPY | Design tokens + component styles (incl. `.store-card`, `.mode-tab`). |
| `client/src/components/ImportPanel.tsx` | ADAPT | Extract store selection + single/parallel lock-in + per-store cards into `StoreImportControls`; build a simpler `ProductResultsView` (no four buckets / rule gaps / Copy-for-Claude). |
| `client/src/components/UploadArea.tsx` | ADAPT | Product upload; show product count (group by Handle). |
| `client/src/components/ValidationHistory.tsx` | COPY | Run history + metadata. |
| `client/src/components/ColumnMappingScreen.tsx` | DROP | No mapping. |
| `client/src/components/IssuesTable.tsx`, `SummaryCards.tsx` | DROP/ADAPT | Validator-shaped; reuse table styling only if helpful. |
| `client/src/api/validationApi.ts` | ADAPT | Keep axios client + import/poll/cleanup calls; drop validate/mapping calls. |
| `client/src/types/index.ts` | ADAPT | Keep import/feedback/store types; drop validation/issue/mapping types; product result is keyed by Handle. |

## Data model (fresh schema)
Reuse the customer tool's import tables, renamed generically and product-shaped:

- `ProductUploadRun` (was `ValidationRun` minus validation): `id`, `fileName`, `productCount`,
  `originalColumns Json`, `createdAt`, optional ticket metadata; `originalRows` relation.
- `ProductImportRun` (was `ImportRun`): `storeId?`, `shopDomain`, `bulkOperationId?`, `status`
  (`RUNNING`->terminal), `error?`, counts, `batchJobs`, `rowResults`.
- `ProductImportJob` (was `ImportBatchJob`): per-store bulk op in a parallel batch +
  `pollAttempts`.
- `ProductImportResult` (was `ImportRowResult`): one per product — `handle`, `accepted`,
  `shopifyProductId?`, `shopifyCode?`, `shopifyField?`, `message?`, `storeId?`.

## Order of operations
1. Copy COPY/ADAPT files; delete DROP files.
2. Extract `services/shopifyBulk.ts` from the copied import service; confirm it compiles
   standalone.
3. Write `productCsvParser.ts` (+ Handle grouping) and `productImport.service.ts`
   (`buildProductSetInput` + `productSet` bulk line).
4. Fresh Prisma schema + `migrate`; wire controllers/routes.
5. Client: `StoreImportControls` + `ProductResultsView` + product upload.
6. Verify per `docs/PRODUCTS_PLAN.md`.
