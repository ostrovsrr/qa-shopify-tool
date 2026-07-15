import { CsvParseError } from '../errors';

/**
 * Normalize and validate a CSV header row before csv-parse turns records into
 * objects. Once duplicate headers have been converted to object keys, one value
 * has already overwritten the other and the lost data cannot be recovered.
 */
export function normalizeCsvHeaders(rawHeaders: string[]): string[] {
  const headers = rawHeaders.map((header) => header.trim());
  if (headers.length === 0) {
    throw new CsvParseError('The file is empty or has no header row.');
  }

  const seen = new Map<string, string>();
  for (const header of headers) {
    if (header === '') {
      throw new CsvParseError('Every CSV column must have a non-empty header.');
    }

    const key = header.toLocaleLowerCase();
    const previous = seen.get(key);
    if (previous) {
      throw new CsvParseError(
        `Duplicate column name "${header}". Rename or remove one of the duplicate columns.`,
      );
    }
    seen.set(key, header);
  }

  return headers;
}
