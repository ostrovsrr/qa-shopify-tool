import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
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
  getCleanupRunHandler,
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
import { sweepOrphanUploads, uploadStorage } from './services/uploadFile';
import { errorHandler, requestId } from './middleware/errorHandler';
import { getActionLog } from './services/actionLog.service';
import { purgeExpiredPii } from './services/retention.service';
import { HttpError } from './errors';

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

// Tag every request, so a "it broke" from a colleague can be found in the log.
app.use(requestId);

// ── Liveness probe ──────────────────────────────────────────────────────────
//
// Deliberately does NOT touch Shopify. A platform health check that calls a
// third-party API means an outage at Shopify — or one expired token — makes the
// platform conclude OUR container is unhealthy and kill it, taking every in-flight
// import with it. The probe answers one question: is this process serving?
//
// It does check the database, because a server that cannot reach Postgres cannot do
// anything useful and should be restarted.
app.get('/api/health', (req, res) => {
  prisma
    .$queryRaw`SELECT 1`
    .then(() => res.json({ ok: true }))
    // Driver errors can contain the full connection string. Health probes are
    // commonly public to the platform, so expose only the readiness state.
    .catch(() =>
      res.status(503).json({
        ok: false,
        error: 'Database unavailable.',
        requestId: req.requestId,
      }),
    );
});

// ── File upload ─────────────────────────────────────────────────────────────

const upload = multer({
  // Disk, NOT memory. memoryStorage() held the whole CSV (up to the 100 MB limit
  // below) in the heap, and previewStore then held it for another 30 minutes — so
  // the real ceiling was every file anyone had previewed recently, not one per
  // request. On a shared 512 MB container that OOMs, and an OOM does not fail one
  // upload, it kills the process and every other colleague's in-flight import with
  // it. See services/uploadFile.ts.
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    if (isCsv) {
      cb(null, true);
    } else {
      cb(new HttpError(400, 'Only CSV files are accepted.'));
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

// GET /api/action-log — who destroyed what. Read-only; nothing in the app makes a
// decision from this table (see services/actionLog.service.ts).
app.get('/api/action-log', (_req, res, next) => {
  getActionLog()
    .then((entries) => res.json(entries))
    .catch(next);
});
app.get('/api/shopify/stores/:storeId/stats', shopifyStoreStatsHandler);
app.post('/api/shopify/stores/:storeId/cleanup-qa', cleanupQaCustomersHandler);
// Cleanup is async for both flows: the POST routes return 202 with a run, and this
// advances it one step per call. A bulk teardown can take minutes; the old code
// blocked the request for up to 300s, which no hosting proxy will tolerate.
app.get('/api/cleanup/:id', getCleanupRunHandler);
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

// ── Static client (production) ──────────────────────────────────────────────
//
// Hosted, the server serves the built React app as well as the API — one container,
// one origin, no CORS. In dev this block is skipped and Vite serves the client on
// 5173, proxying /api here.
//
// The SPA fallback deliberately runs AFTER every /api route: React Router owns
// /customers and /products, so any non-API path that is not a real file must return
// index.html rather than a 404. It must NOT swallow unmatched /api/* — those should
// still 404 as JSON, or a typo'd endpoint would return an HTML page and the client
// would report a bewildering parse error instead of "not found".
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

if (process.env.NODE_ENV === 'production' && fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));

  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ── Error handler ───────────────────────────────────────────────────────────
//
// Generic 500 + a correlation id. The old handler returned err.message straight to
// the browser, which in this app can carry the DATABASE_URL (password included), a
// Shopify token, file paths, or SQL. See middleware/errorHandler.ts.
app.use(errorHandler);

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

    // Uploads that the last process wrote to disk but never got to consume — a
    // crash between multer writing the file and the handler reading it. Nobody is
    // coming back for those, and they are raw merchant PII, so sweep them on boot
    // and then periodically for the ones this process leaks the same way.
    const sweep = (): void => {
      void sweepOrphanUploads().catch((err: Error) => {
        console.error('[upload] sweep failed:', err.message);
      });
    };
    sweep();
    setInterval(sweep, 30 * 60 * 1000).unref();

    // Retention (D13): the raw uploaded rows are merchant PII and nothing has ever
    // deleted them. Purge the rows of runs past the window — but never a run whose
    // import is still in flight, because those rows are what the reconcile rebuilds
    // the import dataset from. See services/retention.service.ts.
    const purge = (): void => {
      void purgeExpiredPii().catch((err: Error) => {
        console.error('[retention] purge failed:', err.message);
      });
    };
    purge();
    setInterval(purge, 24 * 60 * 60 * 1000).unref();
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
