import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { streamExcelReport } from '../reports/excelReport';
import { suggestMapping } from '../services/columnMapping.service';
import {
  deleteValidationRun,
  getValidationHistory,
  getValidationResult,
  updateValidationMetadata,
  validateCustomerCsv,
  validateFromPreview,
} from '../services/customerValidation.service';
import { parseCsvFile } from '../services/csvParser.service';
import { removeUploadFile } from '../services/uploadFile';
import { actorFrom, recordAction } from '../services/actionLog.service';
import { storePreview } from '../services/previewStore';
import { reportFileName } from '../utils/reportFileName';
import { CsvParseError } from '../errors';

const uuidSchema = z.string().uuid('Invalid validation ID format.');

const updateMetadataSchema = z.object({
  ticketNumber: z.string().max(100).nullable().optional(),
  ticketName: z.string().max(255).nullable().optional(),
  comments: z.string().max(2000).nullable().optional(),
});

const validateWithMappingSchema = z.object({
  uploadId: z.string().uuid('Invalid upload ID.'),
  columnMapping: z.record(z.string(), z.string()),
  heliosMigratedTag: z.boolean().default(true),
  moveDuplicatesToNotes: z.boolean().default(false),
  mergeMatchingDuplicates: z.boolean().default(false),
});

// POST /api/customer-validation/preview
export async function previewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Send a CSV as multipart/form-data field "file".' });
      return;
    }
    const { rows, headers } = await parseCsvFile(req.file.path);
    if (rows.length === 0) {
      throw new CsvParseError('The file contains a header row but no customer data rows.');
    }
    const sampleRows = rows.slice(0, 5).map((r) => r.original);
    const suggestedMapping = suggestMapping(headers);
    // The preview entry now OWNS the temp file — /validate reads it again later, so
    // it must outlive this request. deletePreview (or the TTL sweep) unlinks it.
    const uploadId = storePreview({
      fileName: req.file.originalname,
      filePath: req.file.path,
      headers,
      sampleRows,
    });
    res.json({ uploadId, fileName: req.file.originalname, headers, sampleRows, suggestedMapping });
  } catch (err) {
    // Nothing took ownership of the file, so this request must not leave it behind.
    removeUploadFile(req.file?.path);
    next(err);
  }
}

// POST /api/customer-validation/validate
export async function validateWithMappingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = validateWithMappingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const result = await validateFromPreview(
      parsed.data.uploadId,
      parsed.data.columnMapping,
      parsed.data.heliosMigratedTag,
      parsed.data.moveDuplicatesToNotes,
      parsed.data.mergeMatchingDuplicates,
      actorFrom(req),
    );
    if (!result) {
      res.status(404).json({ error: 'Upload not found or expired. Please re-upload the file.' });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/customer-validation/upload (kept for backward compatibility)
export async function uploadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Send a CSV as multipart/form-data field "file".' });
      return;
    }
    const result = await validateCustomerCsv(
      req.file.path,
      req.file.originalname,
      {},
      false,
      false,
      false,
      actorFrom(req),
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  } finally {
    // One-shot route: nobody comes back for the file, so it goes now — on the
    // success path and the failure path alike.
    removeUploadFile(req.file?.path);
  }
}

export async function getValidationHandler(
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
    const result = await getValidationResult(parsed.data);
    if (!result) {
      res.status(404).json({ error: 'Validation run not found.' });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getReportHandler(
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
    // Stream the workbook straight to the response. Headers are set in the
    // onReady callback, which fires after the DB read but before the first byte
    // is written, so Content-Disposition is in place before streaming starts.
    await streamExcelReport(parsed.data, res, (sourceFileName) => {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFileName('prevalidation-report', sourceFileName, 'xlsx')}"`,
      );
    });
  } catch (err) {
    // Once streaming has begun the headers are already flushed, so we can't send
    // a JSON error — just tear the connection down. Otherwise fall through to the
    // normal error handler (e.g. run-not-found → 500).
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(err);
  }
}

export async function getHistoryHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const history = await getValidationHistory();
    res.json(history);
  } catch (err) {
    next(err);
  }
}

export async function updateMetadataHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idParsed = uuidSchema.safeParse(req.params.validationId);
    if (!idParsed.success) {
      res.status(400).json({ error: idParsed.error.errors[0].message });
      return;
    }
    const bodyParsed = updateMetadataSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.errors[0].message });
      return;
    }
    const updated = await updateValidationMetadata(idParsed.data, bodyParsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Validation run not found.' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteValidationHandler(
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
    const deleted = await deleteValidationRun(parsed.data);
    if (!deleted) {
      res.status(404).json({ error: 'Validation run not found.' });
      return;
    }
    // Destructive, and in a shared workspace anyone can do it to anyone's run.
    await recordAction(req, { action: 'DELETE_VALIDATION_RUN', target: parsed.data });
    res.json({ message: 'Validation run deleted successfully.' });
  } catch (err) {
    next(err);
  }
}
