import { NextFunction, Request, Response } from 'express';
import { getSafeShopifyStores, getShopifyStoresConfig } from '../config/shopify';
import {
  getShopifyClient,
  ShopifyAuthError,
  ShopifyConfigError,
} from '../services/shopifyClient';
import { getStoreCustomerStats, QA_IMPORT_TAG } from '../services/shopifyCleanup.service';
import { getStoreProductStats } from '../services/productCleanup.service';
import { reconcileCleanupRun, startCleanupRun } from '../services/cleanupRun.service';
import { recordAction } from '../services/actionLog.service';

// GET /api/shopify/stores - safe store list for the UI.
export function shopifyStoresHandler(
  _req: Request,
  res: Response,
): void {
  const configured = getShopifyStoresConfig();
  if (!configured.ok) {
    res.status(503).json({
      stores: [],
      error: configured.error,
      hint: 'Set SHOPIFY_TEST_STORES or SHOPIFY_SHOP_1 / SHOPIFY_CLIENT_ID_1 / SHOPIFY_CLIENT_SECRET_1 in server/.env, then restart the server.',
    });
    return;
  }

  res.json({ stores: getSafeShopifyStores() });
}

// GET /api/shopify/health - connection + scope smoke test.
export async function shopifyHealthHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : undefined;
    const client = await getShopifyClient(storeId);
    const report = await client.verifyConnection();
    res.status(report.ok ? 200 : 422).json(report);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({
        ok: false,
        error: err.message,
        hint: 'Set Shopify test-store credentials in server/.env, then restart the server.',
      });
      return;
    }
    if (err instanceof ShopifyAuthError) {
      res.status(401).json({ ok: false, error: err.message });
      return;
    }
    next(err);
  }
}

// GET /api/shopify/stores/:storeId/stats - total + QA-tagged customer counts.
export async function shopifyStoreStatsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const stats = await getStoreCustomerStats(req.params.storeId);
    res.json(stats);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof ShopifyAuthError) {
      res.status(401).json({ error: err.message });
      return;
    }
    next(err);
  }
}

// GET /api/shopify/stores/:storeId/product-stats - total + QA-tagged product counts.
export async function shopifyStoreProductStatsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const stats = await getStoreProductStats(req.params.storeId);
    res.json(stats);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof ShopifyAuthError) {
      res.status(401).json({ error: err.message });
      return;
    }
    next(err);
  }
}

// POST /api/shopify/stores/:storeId/cleanup-qa-products - delete all qa-import
// tagged products. Returns 202 with a cleanup run to poll; a large teardown is a
// bulk operation that can take minutes, and blocking the request on it was what
// made these routes unusable behind a hosting proxy.
export async function cleanupQaProductsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const run = await startCleanupRun('PRODUCT', req.params.storeId, QA_IMPORT_TAG);
    // Deletes BY TAG across an ENTIRE store. The highest blast radius in the app.
    await recordAction(req, {
      action: 'CLEANUP_STORE_PRODUCTS',
      target: req.params.storeId,
      storeId: req.params.storeId,
      detail: { tag: QA_IMPORT_TAG, cleanupRunId: run.id, found: run.found },
    });
    res.status(202).json(run);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof ShopifyAuthError) {
      res.status(401).json({ error: err.message });
      return;
    }
    next(err);
  }
}

// POST /api/shopify/stores/:storeId/cleanup-qa - delete all qa-import tagged
// customers. Returns 202 with a cleanup run to poll. See above.
export async function cleanupQaCustomersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const run = await startCleanupRun('CUSTOMER', req.params.storeId, QA_IMPORT_TAG);
    // Deletes BY TAG across an ENTIRE store. The highest blast radius in the app.
    await recordAction(req, {
      action: 'CLEANUP_STORE_CUSTOMERS',
      target: req.params.storeId,
      storeId: req.params.storeId,
      detail: { tag: QA_IMPORT_TAG, cleanupRunId: run.id, found: run.found },
    });
    res.status(202).json(run);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof ShopifyAuthError) {
      res.status(401).json({ error: err.message });
      return;
    }
    next(err);
  }
}

// GET /api/cleanup/:id - advance a cleanup by one step and return its state.
// Reconcile-on-poll, exactly like an import run: a 300s bulk delete becomes a
// handful of cheap requests instead of one that outlives the proxy.
export async function getCleanupRunHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const run = await reconcileCleanupRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Cleanup run not found.' });
      return;
    }
    res.json(run);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof ShopifyAuthError) {
      res.status(401).json({ error: err.message });
      return;
    }
    next(err);
  }
}
