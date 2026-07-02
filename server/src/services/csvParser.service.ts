import { parse } from 'csv-parse';
import { CustomerCsvRow } from '../types';
import { isRowFullyEmpty, normalizeRecord } from '../utils/normalize';

export interface ParsedCsv {
  rows: CustomerCsvRow[];
  headers: string[];
}

export async function parseCsvBuffer(buffer: Buffer): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    parse(
      buffer,
      {
        columns: true,
        skip_empty_lines: false,
        relax_column_count: true,
        cast: false,
        // Strip a leading UTF-8 BOM (Shopify/Excel exports include one). Without
        // this the first header parses as "﻿<name>", so its column won't match
        // mapping/validator lookups by exact header name.
        bom: true,
      },
      (err, records: Record<string, string>[]) => {
        if (err) return reject(err);

        const headers = records.length > 0 ? Object.keys(records[0]) : [];

        let lastNonEmpty = records.length - 1;
        while (lastNonEmpty >= 0 && isRowFullyEmpty(records[lastNonEmpty])) {
          lastNonEmpty--;
        }

        const rows: CustomerCsvRow[] = [];

        for (let i = 0; i <= lastNonEmpty; i++) {
          const record = records[i];
          const rowNumber = i + 2;

          rows.push({
            rowNumber,
            original: { ...record },
            normalized: normalizeRecord(record),
          });
        }

        resolve({ rows, headers });
      },
    );
  });
}
