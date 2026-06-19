import { NextFunction, Request, Response } from 'express';
import {
  getShopifyClient,
  ShopifyAuthError,
  ShopifyConfigError,
} from '../services/shopifyClient';

// GET /api/shopify/health — connection + scope smoke test.
export async function shopifyHealthHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const client = getShopifyClient();
    const report = await client.verifyConnection();
    res.status(report.ok ? 200 : 422).json(report);
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      res.status(503).json({
        ok: false,
        error: err.message,
        hint: 'Set SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN in server/.env, then restart the server.',
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
