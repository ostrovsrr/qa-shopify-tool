/**
 * Build a download filename like "prevalidation-customers-export.xlsx" from a
 * report prefix and the uploaded source file's name. Strips the source file's
 * extension and sanitizes the rest to characters that are safe inside a
 * Content-Disposition filename.
 */
export function reportFileName(prefix: string, sourceFileName: string, ext: string): string {
  const base = sourceFileName.replace(/\.[^.]+$/, '');
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${prefix}-${safe || 'report'}.${ext}`;
}
