import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { generateExcelReport } from '../reports/excelReport';
import { suggestMapping } from '../services/columnMapping.service';
import {
  deleteValidationRun,
  getValidationHistory,
  getValidationResult,
  updateValidationMetadata,
  validateCustomerCsv,
  validateFromPreview,
} from '../services/customerValidation.service';
import { parseCsvBuffer } from '../services/csvParser.service';
import { storePreview } from '../services/previewStore';

const uuidSchema = z.string().uuid('Invalid validation ID format.');

const updateMetadataSchema = z.object({
  ticketNumber: z.string().max(100).nullable().optional(),
  ticketName: z.string().max(255).nullable().optional(),
  comments: z.string().max(2000).nullable().optional(),
});

const validateWithMappingSchema = z.object({
  uploadId: z.string().uuid('Invalid upload ID.'),
  columnMapping: z.record(z.string(), z.string()),
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
    const { rows, headers } = await parseCsvBuffer(req.file.buffer);
    const sampleRows = rows.slice(0, 5).map((r) => r.original);
    const suggestedMapping = suggestMapping(headers);
    const uploadId = storePreview({
      fileName: req.file.originalname,
      buffer: req.file.buffer,
      headers,
      sampleRows,
    });
    res.json({ uploadId, fileName: req.file.originalname, headers, sampleRows, suggestedMapping });
  } catch (err) {
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
    const result = await validateFromPreview(parsed.data.uploadId, parsed.data.columnMapping);
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
    const result = await validateCustomerCsv(req.file.buffer, req.file.originalname);
    res.status(200).json(result);
  } catch (err) {
    next(err);
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
    const buffer = await generateExcelReport(parsed.data);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="validation-report-${parsed.data}.xlsx"`,
    );
    res.send(buffer);
  } catch (err) {
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
    res.json({ message: 'Validation run deleted successfully.' });
  } catch (err) {
    next(err);
  }
}
