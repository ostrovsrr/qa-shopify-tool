import fs from 'fs';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import { CsvParseError } from '../errors';
import { CustomerCsvRow } from '../types';
import { isRowFullyEmpty, normalizeRecord } from '../utils/normalize';
import { normalizeCsvHeaders } from './csvHeaders';

export interface ParsedCsv {
  rows: CustomerCsvRow[];
  headers: string[];
}

const PARSE_OPTIONS = {
  skip_empty_lines: false,
  // Missing trailing cells are common in spreadsheet exports and mean empty
  // values. Extra cells have no header and would otherwise be silently dropped,
  // so they remain a parse error.
  relax_column_count_less: true,
  cast: false,
  // Strip a leading UTF-8 BOM (Shopify/Excel exports include one). Without
  // this the first header parses as "﻿<name>", so its column won't match
  // mapping/validator lookups by exact header name.
  bom: true,
} as const;

function toRows(records: Record<string, string>[], headers: string[]): ParsedCsv {
  let lastNonEmpty = records.length - 1;
  while (lastNonEmpty >= 0 && isRowFullyEmpty(records[lastNonEmpty])) {
    lastNonEmpty--;
  }

  const rows: CustomerCsvRow[] = [];
  for (let i = 0; i <= lastNonEmpty; i++) {
    const record = records[i];
    const completeRecord = Object.fromEntries(
      headers.map((header) => [header, record[header] ?? '']),
    );
    const rowNumber = i + 2;

    rows.push({
      rowNumber,
      original: completeRecord,
      normalized: normalizeRecord(completeRecord),
    });
  }

  return { rows, headers };
}

async function parseCsvStream(input: Readable): Promise<ParsedCsv> {
  const records: Record<string, string>[] = [];
  let headers: string[] = [];
  const parser = input.pipe(
    parse({
      ...PARSE_OPTIONS,
      columns: (rawHeaders: string[]) => {
        headers = normalizeCsvHeaders(rawHeaders);
        return headers;
      },
    }),
  );

  try {
    for await (const record of parser) {
      records.push(record as Record<string, string>);
    }
  } catch (err) {
    // A malformed CSV is the USER's problem and they can fix it — but only if we
    // tell them what it is. csv-parse says things like "Quote Not Closed: ... at
    // line 2", which is about their file and nothing about our server, so it is
    // safe (and genuinely useful) to pass on. Without this it would fall through to
    // the generic 500 and they would be told nothing at all.
    if (err instanceof CsvParseError) throw err;
    throw new CsvParseError((err as Error).message);
  }

  if (headers.length === 0) {
    throw new CsvParseError('The file is empty or has no header row.');
  }
  return toRows(records, headers);
}

/**
 * Parse an uploaded CSV straight off disk.
 *
 * The raw bytes are never held in the heap — see uploadFile.ts for why that
 * matters on a shared container. (The parsed ROWS still are; that is the separate,
 * larger problem in TODOS.md #2.)
 */
export async function parseCsvFile(filePath: string): Promise<ParsedCsv> {
  return parseCsvStream(fs.createReadStream(filePath));
}

/** In-memory variant, for tests and any caller that already has the bytes. */
export async function parseCsvBuffer(buffer: Buffer): Promise<ParsedCsv> {
  return parseCsvStream(Readable.from(buffer));
}
