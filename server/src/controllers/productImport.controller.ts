import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getProductImportFeedback } from '../services/productFeedback.service';
import { streamProductImportReport } from '../reports/productImportReport';
import {
  cleanupImportRunStores,
  reconcileLatestImportForUpload,
  reconcileProductImportRun,
  startBatchProductImport,
  startProductImport,
} from '../services/productImport.service';
import { ShopifyAuthError, ShopifyConfigError } from '../services/shopifyClient';

// Shopify config/auth failures map to dedicated status codes; everything else
// falls through to the generic error handler. Returns true if it handled `err`.
function handleShopifyError(err: unknown, res: Response): boolean {
  if (err instanceof ShopifyConfigError) {
    res.status(503).json({
      error: err.message,
      hint: 'Set SHOPIFY_TEST_STORES (or SHOPIFY_SHOP_1 …) in server/.env, then restart the server.',
    });
    return true;
  }
  if (err instanceof ShopifyAuthError) {
    res.status(401).json({ error: err.message });
    return true;
  }
  return false;
}

const uuidSchema = z.string().uuid('Invalid id format.');
const runImportSchema = z.object({ storeId: z.string().min(1).optional() });
const runBatchSchema = z.object({
  storeIds: z.array(z.string().min(1)).min(1, 'Select at least one store.'),
});
const cleanupImportSchema = z.object({ storeId: z.string().min(1).optional() });

// POST /api/product-import/:uploadId/run — single-store import. Concurrency is
// bounded by Shopify (one bulk op per shop) and surfaced as a 409.
export async function runImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.uploadId);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const bodyParsed = runImportSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.errors[0].message });
      return;
    }

    const result = await startProductImport(parsed.data, bodyParsed.data.storeId);
    if ('notFound' in result) {
      res.status(404).json({ error: 'Upload not found.' });
      return;
    }
    if (!result.ok) {
      const isBusy = /already running|in progress/i.test(result.error);
      res.status(isBusy ? 409 : 422).json({ error: result.error });
      return;
    }

    // 202: the bulk op is queued; the client polls GET /:id until it finalizes.
    res.status(202).json(await getProductImportFeedback(result.importRunId));
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// POST /api/product-import/:uploadId/run-batch — parallel import across stores,
// merged into one parent run the same reports read.
export async function runBatchImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.uploadId);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const bodyParsed = runBatchSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.errors[0].message });
      return;
    }

    const result = await startBatchProductImport(parsed.data, bodyParsed.data.storeIds);
    if ('notFound' in result) {
      res.status(404).json({ error: 'Upload not found.' });
      return;
    }
    if (!result.ok) {
      const isBusy = /already running|in progress/i.test(result.error);
      res.status(isBusy ? 409 : 422).json({ error: result.error });
      return;
    }

    res.status(202).json(await getProductImportFeedback(result.importRunId));
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// GET /api/product-import/by-upload/:uploadId — latest import for an upload, so
// History can reopen a run and resume a still-RUNNING one. Declared before /:id.
export async function getLatestImportForUploadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.uploadId);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const feedback = await reconcileLatestImportForUpload(parsed.data);
    if (!feedback) {
      res.status(404).json({ error: 'No import found for this upload.' });
      return;
    }
    res.json(feedback);
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// GET /api/product-import/:id/report — product import workbook.
export async function getImportReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    // Stream the workbook straight to the response. Headers are set in the
    // onReady callback, which fires after the DB read but before the first byte,
    // so Content-Disposition is in place before streaming starts.
    await streamProductImportReport(parsed.data, res, () => {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="product-import-report-${parsed.data}.xlsx"`,
      );
    });
  } catch (err) {
    // Once streaming has begun the headers are flushed, so we can't send a JSON
    // error — just tear the connection down. Otherwise fall through to the
    // normal error handler (e.g. run-not-found).
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(err);
  }
}

// POST /api/product-import/:id/cleanup — delete the products from this import run
// (batch-aware: across every store the import touched).
export async function cleanupImportRunHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idParsed = uuidSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: idParsed.error.errors[0].message });
      return;
    }
    const bodyParsed = cleanupImportSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.errors[0].message });
      return;
    }
    // 202 + cleanup runs to poll — a real teardown is a bulk delete that can take
    // minutes, and blocking the request on it cannot survive a hosting proxy.
    const runs = await cleanupImportRunStores(idParsed.data, bodyParsed.data.storeId);
    res.status(202).json(runs);
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// GET /api/product-import/:id — one import run + feedback (reconcile-on-poll).
export async function getImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const feedback = await reconcileProductImportRun(parsed.data);
    if (!feedback) {
      res.status(404).json({ error: 'Import run not found.' });
      return;
    }
    res.json(feedback);
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}
