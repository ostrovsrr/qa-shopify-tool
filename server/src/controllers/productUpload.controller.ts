import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createProductUpload,
  deleteUploadRun,
  getUploadHistory,
  getUploadRun,
  updateUploadMetadata,
} from '../services/productUpload.service';
import { removeUploadFile } from '../services/uploadFile';
import { actorFrom, recordAction } from '../services/actionLog.service';

const uuidSchema = z.string().uuid('Invalid upload ID format.');

const updateMetadataSchema = z.object({
  ticketNumber: z.string().max(100).nullable().optional(),
  ticketName: z.string().max(255).nullable().optional(),
  comments: z.string().max(2000).nullable().optional(),
});

// POST /api/product-upload — parse + persist a product CSV (no mapping/validate).
export async function uploadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({
        error: 'No file uploaded. Send a CSV as multipart/form-data field "file".',
      });
      return;
    }
    const summary = await createProductUpload(
      req.file.path,
      req.file.originalname,
      actorFrom(req),
    );
    res.status(201).json(summary);
  } catch (err) {
    next(err);
  } finally {
    // The rows are persisted to Postgres, so nobody comes back for the raw file.
    // It goes now, on the success path and the failure path alike.
    removeUploadFile(req.file?.path);
  }
}

// GET /api/product-upload/history — declared before /:id so it isn't an id param.
export async function getHistoryHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await getUploadHistory());
  } catch (err) {
    next(err);
  }
}

// GET /api/product-upload/:id
export async function getUploadHandler(
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
    const upload = await getUploadRun(parsed.data);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found.' });
      return;
    }
    res.json(upload);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/product-upload/:id/metadata
export async function updateMetadataHandler(
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
    const bodyParsed = updateMetadataSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.errors[0].message });
      return;
    }
    const updated = await updateUploadMetadata(idParsed.data, bodyParsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Upload not found.' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/product-upload/:id
export async function deleteUploadHandler(
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
    const deleted = await deleteUploadRun(parsed.data);
    if (!deleted) {
      res.status(404).json({ error: 'Upload not found.' });
      return;
    }
    // Destructive, and in a shared workspace anyone can do it to anyone's upload.
    await recordAction(req, { action: 'DELETE_PRODUCT_UPLOAD', target: parsed.data });
    res.json({ message: 'Upload deleted successfully.' });
  } catch (err) {
    next(err);
  }
}
