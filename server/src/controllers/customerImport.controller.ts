import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  getImportFeedback,
  getRuleGapBacklog,
} from '../services/importFeedback.service';
import { generateShopifyVerificationReport } from '../reports/shopifyVerificationReport';
import { generateValidatorFeedbackMarkdown } from '../reports/validatorFeedbackReport';
import {
  cleanupCustomersByTag,
  qaImportTagForRun,
} from '../services/shopifyCleanup.service';
import {
  reconcileImportRun,
  reconcileLatestImportForValidation,
  startCustomerImport,
} from '../services/shopifyImport.service';
import {
  ShopifyAuthError,
  ShopifyConfigError,
} from '../services/shopifyClient';

// Shopify config/auth failures map to dedicated status codes; everything else
// falls through to the generic error handler. Returns true if it handled `err`.
function handleShopifyError(err: unknown, res: Response): boolean {
  if (err instanceof ShopifyConfigError) {
    res.status(503).json({
      error: err.message,
      hint: 'Set SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN in server/.env, then restart the server.',
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
const runImportSchema = z.object({
  storeId: z.string().min(1).optional(),
});
const cleanupImportSchema = z.object({
  storeId: z.string().min(1).optional(),
});

// POST /api/customer-import/:validationId/run
// Per decision, runs with Errors are allowed (the feedback loop tests both
// directions); no zero-error guard. Concurrency is bounded by Shopify itself
// (one bulk op per shop) and surfaced as a 409.
export async function runImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.validationId);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const bodyParsed = runImportSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.errors[0].message });
      return;
    }

    const result = await startCustomerImport(parsed.data, bodyParsed.data.storeId);
    if ('notFound' in result) {
      res.status(404).json({ error: 'Validation run not found.' });
      return;
    }
    if (!result.ok) {
      const isBusy = /already running|in progress/i.test(result.error);
      res.status(isBusy ? 409 : 422).json({ error: result.error });
      return;
    }

    // 202: the bulk op is queued; the client polls GET /:id until it finalizes.
    const feedback = await getImportFeedback(result.importRunId);
    res.status(202).json(feedback);
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// GET /api/customer-import/feedback — cross-run rule-gap backlog.
// Declared before /:id so "feedback" isn't captured as an id param.
export async function ruleGapBacklogHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const backlog = await getRuleGapBacklog();
    res.json(backlog);
  } catch (err) {
    next(err);
  }
}

// GET /api/customer-import/by-validation/:validationId — latest import for a run.
// Lets History reopen a run's import (status, report, cleanup) and resume a
// still-RUNNING one. Declared before /:id so "by-validation" isn't an id param.
export async function getLatestImportForValidationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = uuidSchema.safeParse(req.params.validationId);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const feedback = await reconcileLatestImportForValidation(parsed.data);
    if (!feedback) {
      res.status(404).json({ error: 'No import found for this validation run.' });
      return;
    }
    res.json(feedback);
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// GET /api/customer-import/:id/report — Shopify verification workbook.
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

    const buffer = await generateShopifyVerificationReport(parsed.data);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shopify-verification-report-${parsed.data}.xlsx"`,
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

// GET /api/customer-import/:id/feedback-report — paste-ready Markdown for fixing
// validator logic from the Shopify-vs-validator discrepancy.
export async function getValidatorFeedbackReportHandler(
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

    const markdown = await generateValidatorFeedbackMarkdown(parsed.data);
    if (markdown === null) {
      res.status(404).json({ error: 'Import run not found.' });
      return;
    }
    res.type('text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="validator-feedback-${parsed.data}.md"`,
    );
    res.send(markdown);
  } catch (err) {
    if (handleShopifyError(err, res)) return;
    next(err);
  }
}

// POST /api/customer-import/:id/cleanup - delete customers from this import run.
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

    const result = await cleanupCustomersByTag(
      bodyParsed.data.storeId,
      qaImportTagForRun(idParsed.data),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// GET /api/customer-import/:id — one import run + four-bucket summary.
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
    // Reconcile-on-poll: pokes Shopify once and finalizes the run if the bulk op
    // is done; a no-op for already-terminal runs.
    const feedback = await reconcileImportRun(parsed.data);
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
