import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { generateExcelReport } from '../reports/excelReport';
import {
  deleteValidationRun,
  getValidationHistory,
  getValidationResult,
  validateCustomerCsv,
} from '../services/customerValidation.service';

const uuidSchema = z.string().uuid('Invalid validation ID format.');

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
