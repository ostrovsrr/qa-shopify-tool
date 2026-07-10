# Build Plan — Shopify Products Migration QA Tool

Build roadmap for this repo. Background in `docs/CONTEXT.md`; what to copy in `MANIFEST.md`.
Because this is a separate, products-only repo, there is **no entity-adapter abstraction** —
copy the generic engine and wire it directly to products.

## Phase 0 — Scaffold from the customer tool
- Copy the COPY/ADAPT files per `MANIFEST.md`; delete DROP files.
- New `server/.env` with a fresh `DATABASE_URL` (new database); reuse `SHOPIFY_*`.
- `npm install` in both packages; confirm the skeleton boots.

## Phase 1 — Generic bulk engine (`services/shopifyBulk.ts`)
Extract from the copied `shopifyImport.service.ts`, unchanged in behavior:
- `stagedUpload`, `runBulkMutation`, `fetchBulkOperationState`, the `__lineNumber` JSONL
  result parser, `splitIntoBatches`.
- The async orchestration shapes: `startBulkImport(...)`, `reconcileRun(...)`,
  `startBatchImport(...)`, `reconcileBatchRun(...)`, guarded finalize, `pollAttempts` cap,
  per-job isolation. Keep these generic over: the mutation string, a `buildLines(records) ->
  {jsonl, lineRefs}` function, and a `parsePayload(line) -> outcome` function.

## Phase 2 — Product CSV + input building
- `services/productCsvParser.ts`: parse the CSV and **group rows by `Handle`** into product
  groups (first row = product fields; subsequent same-Handle rows = variants/images).
- `buildProductSetInput(group)`:
  - `title` (Title), `descriptionHtml` (Body HTML), `vendor` (Vendor), `productType` (Type),
    `tags` (Tags + teardown tag `qa-import` + `qa-import-<importRunId>`),
    `status` (Published true -> `ACTIVE` else `DRAFT`).
  - `productOptions`: from Option1/2/3 Name + the distinct values seen across the group's rows.
  - `variants`: one per variant row -> `optionValues` (Option1/2/3 Value), `sku` (Variant SKU),
    `price` (Variant Price), and other variant fields as needed.
  - Images deferred to Phase 2 (see below).
- Bulk line per product: `{"input": <ProductSetInput>}` against
  ```graphql
  mutation call($input: ProductSetInput!) {
    productSet(input: $input) { product { id } userErrors { code field message } }
  }
  ```
  Validate with the shopify-dev MCP `validate_graphql_codeblocks` before wiring.
- `parsePayload`: read `productSet.product.id` + `userErrors[0].{code, field, message}`.
  Unlike customers, **use the real `code`** — no synthesis.

## Phase 3 — Persistence + feedback
- Fresh Prisma schema: `ProductUploadRun`, `ProductImportRun`, `ProductImportJob`,
  `ProductImportResult` (see `MANIFEST.md` "Data model"). `migrate`.
- `services/productImport.service.ts`: wire the engine (Phase 1) with the product
  `buildLines`/`parsePayload` (Phase 2). One result row per product (keyed by `handle`).
- `services/productFeedback.service.ts` (adapted from `importFeedback`): summary = total /
  accepted / rejected; **rejections grouped by `(field, code)`** with sample messages and
  sample handles; **per-store breakdown** (store -> products/accepted/rejected) from each
  result's `storeId`.

## Phase 4 — Cleanup + report
- `services/productCleanup.service.ts`: `products(query: "tag:'qa-import-<id>'")` paginate +
  `productDelete`; batch-aware (delete across every store a parallel run touched).
- `reports/productImportReport.ts` (ExcelJS): Summary; "Products With Shopify Result" (Handle,
  Title, Accepted/Rejected, code, field, message); "Rejections" grouped by `(field, code)`.

## Phase 5 — API + client
- Controllers/routes under `/api/product-import/*` and `/api/product-upload/*`, mirroring the
  customer tool (run, run-batch, `:id`, `:id/report`, by-validation, cleanup) plus a thin
  upload route that parses + persists the run (no mapping, no validate).
- Client:
  - Product `UploadArea` -> on upload show file + **product count** (grouped by Handle) ->
    "Continue to import" (no mapping screen).
  - `StoreImportControls` (extracted from `ImportPanel`): single/parallel mode toggle, parallel
    lock-in (select -> confirm -> review), per-store cards (health, customer/product counts,
    **batch size in products**, per-store + clean-all cleanup).
  - `ProductResultsView`: total/accepted/rejected, rejections-by-`(field,code)` table,
    per-store breakdown, report download. No four buckets / rule gaps / Copy-for-Claude.
  - Run history reused.

## Verification (needs >=1 test store; >=2 for parallel)
1. Migrate; build server + client.
2. Upload a product CSV with multi-variant handles -> product count groups correctly by Handle.
3. Single-store import -> poll to terminal -> products appear in the store; accepted/rejected
   counts match; a deliberately bad row (e.g. negative price / missing title) appears grouped
   under its real Shopify `code`.
4. Parallel: select 2 stores -> confirm -> **batch sizes (in products) sum to the total** ->
   import -> per-store breakdown sums correctly.
5. "Clean this import" -> `productDelete` removes the created products across all stores.

## Phase 2 (later)
- Markdown "why products failed" report aimed at fixing the source file.
- Collections; inventory/locations.

### Done
- **Inventory, status & remaining template columns (2026-07-02).** "Status"
  (active/draft/archived) now wins over "Published" for product status; "Gift Card" →
  `giftCard`; "Variant Inventory Tracker" → `inventoryItem.tracked`; "Variant Inventory
  Policy" → `inventoryPolicy` (DENY/CONTINUE); "Cost per item" → `inventoryItem.cost`;
  "Variant Requires Shipping" → `inventoryItem.requiresShipping`; "Variant Grams" +
  "Variant Weight Unit" → `inventoryItem.measurement.weight` (grams converted into the
  display unit — the CSV's grams column is always grams); "Variant Inventory Qty" →
  `inventoryQuantities` `[{locationId, name: "available", quantity}]` using the store's
  first active location (fetched per store at import start; needs `read_locations` — if
  the scope is missing, quantities are skipped for the run instead of failing every line).
  Deliberately NOT mapped: "Variant Fulfillment Service" (legacy; `manual` is the only
  API-supported behavior and the default) and "Product Category" (needs a taxonomy-gid
  lookup from the text path; revisit if a source file ever populates it). SEO Title /
  SEO Description / Google Shopping columns: not present in source files so far, unmapped.
- **Images/media.** Product images via `ProductSetInput.files` (one `FileSetInput` per
  distinct "Image Src" URL in the Handle group, ordered by "Image Position", alt from
  "Image Alt Text"), variant images via `ProductVariantSetInput.file` from "Variant Image"
  (`buildProductFiles` / `buildVariantFields` in `productImport.service.ts`). No staged
  upload needed — `originalSource` takes the external URL and Shopify fetches it; media
  processing is async on Shopify's side, so images may appear a little after the import
  completes. Validated against the 2026-01 schema via the shopify-dev MCP.
- **Product metafields.** Columns headed `<label> (product.metafields.<namespace>.<key>)`
  are parsed (`extractMetafields` in `productCsvParser.ts`) and set via
  `ProductSetInput.metafields` (`{ namespace, key, value }`, no `type` — Shopify resolves
  it from the existing definition, so the definitions must be created first, e.g. with the
  `metafields-creator` CLI). Empty cells are skipped; both `custom.*` and `shopify.*` are
  passed through (a value Shopify rejects fails that product's line, surfacing in the report).
