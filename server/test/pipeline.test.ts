import { describe, expect, it } from 'vitest';
import { parseCsvBuffer } from '../src/services/csvParser.service';
import { customerValidationRules } from '../src/validators/customer';
import { CustomerValidationIssue } from '../src/types';
import { countByType } from './helpers';

/** Minimal CSV serializer: quotes any field containing a comma, quote, or newline. */
function toCsv(headers: string[], records: Record<string, string>[]): string {
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [headers.join(',')];
  for (const record of records) {
    lines.push(headers.map((h) => escape(record[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

const HEADERS = [
  'First Name', 'Last Name', 'Email', 'Phone',
  'Accepts Email Marketing', 'Accepts SMS Marketing', 'Tax Exempt',
  'Default Address Address1', 'Default Address City',
  'Default Address Province Code', 'Default Address Country Code', 'Default Address Zip',
  'Tags', 'Total Spent', 'Total Orders', 'Note',
];

// A deliberately messy dataset touching many rules at once. This is a
// characterization ("golden") test: the snapshot below locks in the current,
// reviewed behavior of the full pipeline. If a code change shifts these counts,
// the test fails so the change gets a deliberate look before the snapshot is updated.
const ROWS: Record<string, string>[] = [
  // valid baseline row — should produce no issues
  { 'First Name': 'John', 'Last Name': 'Doe', Email: 'john@example.com', Phone: '5551234567', 'Accepts Email Marketing': 'TRUE', 'Tax Exempt': 'FALSE', 'Default Address Address1': '1 King St', 'Default Address City': 'Toronto', 'Default Address Province Code': 'ON', 'Default Address Country Code': 'CA', 'Default Address Zip': 'M5V 3L9', Tags: 'vip, wholesale', 'Total Spent': '199.99', 'Total Orders': '3', Note: 'Loyal customer' },
  // invalid email + too-few-digit phone
  { 'First Name': 'Amy', Email: 'not-an-email', Phone: '123' },
  // duplicate email + phone with the next row
  { 'First Name': 'Bob', Email: 'dupe@x.com', Phone: '5550001111' },
  { 'First Name': 'Bo', Email: 'DUPE@x.com', Phone: '555-000-1111' },
  // invalid marketing consent + tax exempt values
  { 'First Name': 'Cara', 'Accepts Email Marketing': 'maybe', 'Tax Exempt': 'nah' },
  // invalid CA province + postal code
  { 'First Name': 'Dan', 'Default Address Address1': '9 Bay St', 'Default Address City': 'Ottawa', 'Default Address Province Code': 'XX', 'Default Address Country Code': 'CA', 'Default Address Zip': 'NOTZIP' },
  // messy tags + leading/trailing whitespace
  { 'First Name': ' Erin ', Email: 'erin@x.com', Tags: 'a,,b,' },
  // long note + non-numeric total spent + HTML injection
  { 'First Name': 'Fay', Email: 'fay@x.com', 'Total Spent': 'lots', Note: 'x'.repeat(600), 'Last Name': '<b>Hsu</b>' },
  // fully blank identity row
  { Note: 'placeholder so this row is not stripped as trailing-empty' },
];

describe('full validation pipeline (golden)', () => {
  it('parses the CSV into the expected number of rows', async () => {
    const { rows, headers } = await parseCsvBuffer(Buffer.from(toCsv(HEADERS, ROWS)));
    expect(headers).toEqual(HEADERS);
    expect(rows).toHaveLength(ROWS.length);
    // parser numbers data rows from 2 (row 1 is the header)
    expect(rows[0].rowNumber).toBe(2);
  });

  it('produces a stable breakdown of issues across all rules', async () => {
    const { rows } = await parseCsvBuffer(Buffer.from(toCsv(HEADERS, ROWS)));
    const issues: CustomerValidationIssue[] = customerValidationRules.flatMap((rule) =>
      rule.validate(rows),
    );

    // sanity: there are errors and warnings, and every issue points at a real data row
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.severity === 'Error')).toBe(true);
    expect(issues.some((i) => i.severity === 'Warning')).toBe(true);
    expect(issues.every((i) => i.rowNumber >= 2)).toBe(true);

    expect(countByType(issues)).toMatchInlineSnapshot(`
      {
        "DuplicateCommasInTags": 1,
        "DuplicateEmail": 2,
        "DuplicatePhone": 2,
        "EmptyTagValues": 1,
        "HtmlInjection": 1,
        "InvalidCanadianPostalCode": 1,
        "InvalidEmail": 1,
        "InvalidMarketingConsent": 1,
        "InvalidPhone": 1,
        "InvalidProvinceCode": 1,
        "InvalidTaxExempt": 1,
        "LongNote": 1,
        "MissingContact": 1,
        "NonNumericField": 1,
        "TagsStartsOrEndsWithComma": 1,
      }
    `);
  });
});
