import { parse } from 'csv-parse';
import { CustomerCsvRow } from '../types';
import { isRowFullyEmpty, normalizeRecord } from '../utils/normalize';

export async function parseCsvBuffer(buffer: Buffer): Promise<CustomerCsvRow[]> {
  return new Promise((resolve, reject) => {
    parse(
      buffer,
      {
        columns: true,          // consume first row as column names
        skip_empty_lines: false, // handle ourselves to preserve line numbers
        relax_column_count: true,
        cast: false,             // keep all values as strings
      },
      (err, records: Record<string, string>[]) => {
        if (err) return reject(err);

        // Find the last non-empty record index to strip trailing empty rows
        let lastNonEmpty = records.length - 1;
        while (lastNonEmpty >= 0 && isRowFullyEmpty(records[lastNonEmpty])) {
          lastNonEmpty--;
        }

        const rows: CustomerCsvRow[] = [];

        for (let i = 0; i <= lastNonEmpty; i++) {
          const record = records[i];
          // CSV line number: header = 1, first data row = 2
          const rowNumber = i + 2;

          rows.push({
            rowNumber,
            original: { ...record },
            normalized: normalizeRecord(record),
          });
        }

        resolve(rows);
      },
    );
  });
}
