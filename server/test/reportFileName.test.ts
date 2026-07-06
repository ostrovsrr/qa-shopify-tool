import { describe, expect, it } from 'vitest';
import { reportFileName } from '../src/utils/reportFileName';

describe('reportFileName', () => {
  it('combines prefix with the source name, stripping its extension', () => {
    expect(reportFileName('prevalidation', 'customers.csv', 'xlsx')).toBe(
      'prevalidation-customers.xlsx',
    );
  });

  it('sanitizes characters unsafe for Content-Disposition', () => {
    expect(
      reportFileName('shopify-import-validation', 'Q3 export (final) "v2".csv', 'xlsx'),
    ).toBe('shopify-import-validation-Q3-export-final-v2.xlsx');
  });

  it('falls back to "report" when nothing safe remains', () => {
    expect(reportFileName('prevalidation', 'привет.csv', 'xlsx')).toBe(
      'prevalidation-report.xlsx',
    );
  });
});
