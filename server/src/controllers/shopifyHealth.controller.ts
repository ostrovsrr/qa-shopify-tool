import { NextFunction, Request, Response } from 'express';
import { getSafeShopifyStores, getShopifyStoresConfig } from '../config/shopify';
import {
  getShopifyClient,
  ShopifyAuthError,
  ShopifyConfigError,
} from '../services/shopifyClient';
import {
  cleanupCustomersByTag,
  getStoreCustomerStats,
  QA_IMPORT_TAG,
} from '../services/shopifyCleanup.service';

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

// POST /api/shopify/stores/:storeId/cleanup-qa - delete all qa-import tagged customers.
export async function cleanupQaCustomersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await cleanupCustomersByTag(req.params.storeId, QA_IMPORT_TAG);
    res.json(result);
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
