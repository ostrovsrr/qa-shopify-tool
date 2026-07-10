# Context / Handoff Brief

## Why this project exists
The customer tool (`qa-shopify-tool`) validates and imports Shopify **customer** CSVs into
test stores and reports results. This project does the same for **product** CSVs, minus the
customer tool's two heaviest customer-specific subsystems: the 14 validators ("precheck") and
the column-mapping step. A product CSV is already in Shopify template format, so we import it
directly and report what Shopify accepted/rejected.

This is a **separate repo on purpose** — the goal is a clean products tool, not customer code
carrying products as an afterthought. Because it's separate, there is **no entity-adapter
abstraction**: just copy the generic engine and wire it directly to products.

## What is reused (the engine — already hardened in the customer tool)
The customer tool's async + parallel bulk-import engine is entity-agnostic and is the main
thing being carried over. Its design (worth preserving):

- **Async import:** `start*` queues a Shopify bulk operation, persists a run as `RUNNING`,
  returns immediately (HTTP 202). A `reconcile*` function, driven by the client polling
  `GET /:id` every ~3s, pokes Shopify once and finalizes when the bulk op completes. The DB is
  the source of truth, so a run survives a server restart. Finalization is guarded by an
  `updateMany(where status:RUNNING)` transition so concurrent polls never double-write.
- **Parallel batch:** `splitIntoBatches` slices the rows contiguously and deterministically
  across N stores; a **parent run** holds the merged results and **child jobs** track each
  store's bulk op. Each job is finalized into the parent's results (recomputing its slice from
  `batchIndex/batchCount`). Per-job try/catch isolates one bad store; a `pollAttempts` cap
  fails stuck jobs (~15 min). Per-store results are tracked via a `storeId` on each result row.
- **Resilient Shopify client:** retries transient 429/5xx + non-JSON-5xx with exponential
  backoff (4 attempts); never retries auth (401/403). Multi-store config via
  `SHOPIFY_TEST_STORES` / `SHOPIFY_SHOP_n`; token cache; `verifyConnection` health/scope check.
- **Cleanup:** every created resource is tagged `qa-import` + `qa-import-<importRunId>`;
  cleanup deletes by tag, across every store a batch touched.
- **UI patterns:** upload area, store selection with a single/parallel mode toggle, a parallel
  **lock-in** flow (select -> confirm -> review), per-store cards (health, counts, batch size,
  per-store clean button), a post-run per-store breakdown table, and run history with metadata.

## What changes for products
- **Mutation:** `productSet` instead of `customerCreate`. Build one `ProductSetInput` per
  product. In a bulk op it runs synchronously per line; `userErrors` carry a real `code`.
- **Import unit = product (Handle).** The Shopify product CSV groups rows by `Handle`: the
  first row carries product-level fields (Title, Body HTML, Vendor, Type, Tags, Published,
  Option1/2/3 Name), and rows sharing the Handle add variants (Option values, SKU, Price) and
  images. Parse + group before building input. Results and batch sizes are counted in
  **products**, not CSV rows.
- **No four-bucket report.** Without a validator there's nothing to compare against. The
  summary is: total products, accepted, rejected, and rejections grouped by `(field, code)`
  with sample messages; plus the per-store breakdown for parallel runs.
- **Cleanup:** `productDelete` (by tag) instead of `customerDelete`.

## What is intentionally excluded (do NOT port)
- `validators/` (all 14 rules) and `services/columnMapping.service.ts`.
- The `ColumnMappingScreen` and the validate step / preview-then-validate two-phase flow.
- The four-bucket logic, `VALIDATOR_COVERAGE`, rule-gap backlog, and the "Copy for Claude"
  validator-feedback markdown report.
- The `crossReferenceData` DB drift (specific to the customer tool's existing database; this
  project starts from a clean Prisma schema, so it simply won't exist).

## Conventions (carried from the customer tool)
- TypeScript everywhere; Express + Prisma (PostgreSQL) server; React + Vite + axios client.
- Controllers validate input with zod and map known Shopify errors (config -> 503, auth -> 401)
  via a shared helper; everything else -> 500 through the central error handler.
- Prisma migrations are applied with `migrate deploy` after hand-writing the SQL when needed
  (the customer tool did this to avoid an unrelated destructive drop — not a concern here).
- Reports use ExcelJS.

## Phasing
- **MVP:** single + parallel import of core product + options + variants + price/sku/tags;
  accepted/rejected + grouped rejections + per-store breakdown; cleanup by tag.
- **Phase 2:** images/media (`files` on `ProductSetInput` from the CSV "Image Src" column),
  a markdown "why products failed" report aimed at fixing the source file, metafields.
