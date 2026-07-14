import cors from 'cors';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import {
  deleteValidationHandler,
  getHistoryHandler,
  getReportHandler,
  getValidationHandler,
  previewHandler,
  updateMetadataHandler,
  uploadHandler,
  validateWithMappingHandler,
} from './controllers/customerValidation.controller';
import {
  cleanupQaCustomersHandler,
  cleanupQaProductsHandler,
  shopifyHealthHandler,
  shopifyStoreProductStatsHandler,
  shopifyStoreStatsHandler,
  shopifyStoresHandler,
} from './controllers/shopifyHealth.controller';
import {
  cleanupImportRunHandler,
  getImportHandler,
  getImportReportHandler,
  getLatestImportForValidationHandler,
  getValidatorFeedbackReportHandler,
  runBatchImportHandler,
  runImportHandler,
  ruleGapBacklogHandler,
} from './controllers/customerImport.controller';
import {
  deleteUploadHandler as deleteProductUploadHandler,
  getHistoryHandler as getProductHistoryHandler,
  getUploadHandler as getProductUploadHandler,
  updateMetadataHandler as updateProductMetadataHandler,
  uploadHandler as productUploadHandler,
} from './controllers/productUpload.controller';
import {
  cleanupImportRunHandler as cleanupProductImportRunHandler,
  getImportHandler as getProductImportHandler,
  getImportReportHandler as getProductImportReportHandler,
  getLatestImportForUploadHandler,
  runBatchImportHandler as runProductBatchImportHandler,
  runImportHandler as runProductImportHandler,
} from './controllers/productImport.controller';
import prisma from './db/prisma';
import { resumePendingImports } from './services/importResume.service';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }),
);
app.use(express.json());

// ── File upload ─────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    if (isCsv) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted.'));
    }
  },
});

// ── Routes ──────────────────────────────────────────────────────────────────

// Order matters: /history must come before /:validationId to avoid param capture
app.post('/api/customer-validation/preview', upload.single('file'), previewHandler);
app.post('/api/customer-validation/validate', validateWithMappingHandler);
app.post('/api/customer-validation/upload', upload.single('file'), uploadHandler);
app.get('/api/customer-validation/history', getHistoryHandler);
app.get('/api/customer-validation/report/:validationId', getReportHandler);
app.get('/api/customer-validation/:validationId', getValidationHandler);
app.patch('/api/customer-validation/:validationId/metadata', updateMetadataHandler);
app.delete('/api/customer-validation/:validationId', deleteValidationHandler);

// ── Shopify test-store import + feedback loop ────────────────────────────────
app.get('/api/shopify/health', shopifyHealthHandler);
app.get('/api/shopify/stores', shopifyStoresHandler);
app.get('/api/shopify/stores/:storeId/stats', shopifyStoreStatsHandler);
app.post('/api/shopify/stores/:storeId/cleanup-qa', cleanupQaCustomersHandler);
// Order matters: literal segments (/feedback, /by-validation) must precede /:id
// so they aren't captured as an id.
app.post('/api/customer-import/:validationId/run', runImportHandler);
app.post('/api/customer-import/:validationId/run-batch', runBatchImportHandler);
app.get('/api/customer-import/feedback', ruleGapBacklogHandler);
app.get('/api/customer-import/by-validation/:validationId', getLatestImportForValidationHandler);
app.get('/api/customer-import/:id/report', getImportReportHandler);
app.get('/api/customer-import/:id/feedback-report', getValidatorFeedbackReportHandler);
app.post('/api/customer-import/:id/cleanup', cleanupImportRunHandler);
app.get('/api/customer-import/:id', getImportHandler);

// ── Product stats + cleanup (distinct from the customer routes above) ────────
app.get('/api/shopify/stores/:storeId/product-stats', shopifyStoreProductStatsHandler);
app.post('/api/shopify/stores/:storeId/cleanup-qa-products', cleanupQaProductsHandler);

// ── Product upload (parse + persist; no mapping/validate) ────────────────────
// Order matters: /history must precede /:id so it isn't captured as an id.
app.post('/api/product-upload', upload.single('file'), productUploadHandler);
app.get('/api/product-upload/history', getProductHistoryHandler);
app.get('/api/product-upload/:id', getProductUploadHandler);
app.patch('/api/product-upload/:id/metadata', updateProductMetadataHandler);
app.delete('/api/product-upload/:id', deleteProductUploadHandler);

// ── Product import (async start → reconcile-on-poll, single + parallel batch) ─
// Order matters: literal segments (/by-upload) precede /:id.
app.post('/api/product-import/:uploadId/run', runProductImportHandler);
app.post('/api/product-import/:uploadId/run-batch', runProductBatchImportHandler);
app.get('/api/product-import/by-upload/:uploadId', getLatestImportForUploadHandler);
app.get('/api/product-import/:id/report', getProductImportReportHandler);
app.post('/api/product-import/:id/cleanup', cleanupProductImportRunHandler);
app.get('/api/product-import/:id', getProductImportHandler);

// ── Error handler ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File is too large. The maximum upload size is 100 MB.' });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err.message ?? 'Internal server error.' });
});

// ── Start ───────────────────────────────────────────────────────────────────

// Only bind the port when run directly (npm run dev/start). When the app is
// imported — e.g. by Supertest in integration tests — skip listen so no port
// is occupied and the process can exit cleanly.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);

    // Finish what the last process started. An import that was interrupted
    // mid-flight (a redeploy, a crash, an OOM) left PENDING rows behind: the row
    // is on disk but we have no bulk-operation id for it. resumePendingImports
    // resolves each one — adopting the operation if it actually reached Shopify,
    // relaunching it if it never did.
    //
    // Without this, the pre-persist fix would merely trade a wrong answer for a
    // permanent hang: the run stops lying, but it also never finishes.
    //
    // Deliberately not awaited — a slow or unreachable store must not stop the
    // server from serving. Failures are logged and the rows stay claimable.
    resumePendingImports().catch((err: Error) => {
      console.error('[resume] failed to resume pending imports:', err.message);
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  //
  // The platform sends SIGTERM and then kills the process a few seconds later.
  // Without a handler, an in-flight import is severed mid-write. We stop taking
  // new connections and let the current work drain; anything still unfinished is
  // already durable as a PENDING row and gets picked up by resume on the next
  // boot. That is the whole point of writing the row before the side effect.
  const shutdown = (signal: string): void => {
    console.log(`[shutdown] ${signal} received — draining in-flight requests`);
    server.close(() => {
      void prisma
        .$disconnect()
        .catch(() => undefined)
        .finally(() => {
          console.log('[shutdown] clean');
          process.exit(0);
        });
    });

    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => {
      console.error('[shutdown] drain timed out — exiting anyway');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
