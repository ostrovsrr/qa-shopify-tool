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
  shopifyHealthHandler,
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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
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

// ── Error handler ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: err.message ?? 'Internal server error.' });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

export default app;
