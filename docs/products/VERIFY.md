# Manual end-to-end verification

The DB is already created + migrated (`shopify_products_qa`) and both packages'
deps are installed. This walks the full flow against a real Shopify test store.

> ⚠️ This creates real products in the selected `rodionteststore`, then deletes
> them via the teardown tag. Use the cleanup step (or "Clean this import").

## 1. Start both servers

Two terminals from the repo root:

```bash
cd server && npm run dev      # → http://localhost:3001
```
```bash
cd client && npm run dev      # → http://localhost:5173 (proxies /api → 3001)
```

If the server logs `EADDRINUSE: :::3001`, a stale process is holding the port.
From PowerShell:
```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }
```

Open **http://localhost:5173**.

## 2. Single-store import

1. **Import** tab → drop `examples/sample_products.csv` → **Upload**.
2. Review screen should show **Products (by Handle): 4** and **CSV rows: 5**
   (the trailing image-only row of `cool-tee` is not a separate product).
   → **Continue to import**.
3. Leave mode on **Single store import**, pick a store (e.g. RodionTestStore).
   The store card should show `connected`. → **Import to test store**.
4. It polls every ~3s. When it reaches **COMPLETED**, expect:
   - **Accepted: 3, Rejected: 1** of 4.
   - **Rejections by (field, code)** has one row for `bad-price` with a real
     Shopify code (e.g. a price/variants error). This is the key check: the code
     is Shopify's real `ProductSetUserError.code`, not synthesized.
5. **Download report** → open the .xlsx → Summary / Products With Shopify Result /
   Rejections / Full Uploaded File sheets are populated.
6. Confirm in Shopify admin (Products) that `cool-tee` + `plain-mug` exist with the
   right variants, tagged `qa-import` + `qa-import-<runId>`.

## 3. Parallel import (needs ≥2 stores)

1. **New Upload** → re-upload the CSV → Continue.
2. Switch to **Parallel import** → select 2 stores → **Confirm selection**.
3. Review: each store card shows a **Batch: N products** that **sums to 4**
   (e.g. 2 + 2). → **Import to 2 stores in parallel**.
4. On COMPLETED, the **Per-store results** table lists both stores and the
   products/accepted/rejected **sum to the totals**.

## 4. Cleanup

- **Clean this import** removes the products created by that run across every
  store it touched (by `qa-import-<runId>` tag), or
- each store card's **Clean QA** deletes all `qa-import` products from that store.
- Re-check Shopify admin: the QA products are gone.

## History

The **History** tab lists uploads (product-count badge). Click one to reopen its
latest import (resumes a still-running one), download its report, or clean it.
